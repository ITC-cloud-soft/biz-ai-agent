// The connector runner (docs/AI_EMPLOYEE_PROFILE.md §3.1–§3.4, D6): the business system calls an external API for an operation.
// The AI and DSH never see the URL's secrets or the raw response; they get the allow-listed fields only.
//
//   const runner = createConnectorRunner({ fetch, allowLocalhost })
//   const r = await runner.run({ connector, operation, input, secret })   // → { ok, code?, status, durationMs, attempts, data? }
//
// Guards: input checked against the operation's schema; https to an allowed host only (http to localhost when allowLocalhost:
// development); redirects are refused (never followed to another host); timeout (connector.timeoutMs, ≤ 10 s); per-connector
// calls per minute (connector.ratePerMinute); response size cap (connector.maxResponseBytes); one retry for an idempotent
// operation on a network error, a timeout or 502 / 503 / 504. Errors carry codes only — never the request or response body.
import {
  buildOperationRequest, checkOperationInput, connectorHostOf, pickResponseFields,
} from '@dsh-bridge/protocol'

export const RUN_CODES = Object.freeze([
  'connector_disabled', 'operation_not_found', 'invalid_input', 'rate_limited', 'host_not_allowed', 'secret_missing', 'auth_failed',
  'timeout', 'network_error', 'redirect_refused', 'response_too_large', 'upstream_error', 'invalid_response',
])
const RETRY_STATUSES = new Set([502, 503, 504])
const USER_AGENT = 'dsh-bridge-connector/1'

async function readCapped(res, max) {
  if (!res.body) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > max) {
      try { await res.body.cancel?.() } catch { /* ignore */ }
      return null
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * createConnectorRunner({ fetch?, now?, allowLocalhost?, sleep? }) → { run, test, reset }
 * Rate limits are per runner instance (one per business process); the window is the last 60 seconds.
 */
export function createConnectorRunner({ fetch = globalThis.fetch, now = () => Date.now(), allowLocalhost = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const calls = new Map() // connectorId -> timestamps (ms)
  const tokens = new Map() // connectorId -> { token, until }

  function allowCall(connector) {
    const t = now()
    const list = (calls.get(connector.id) ?? []).filter((x) => x > t - 60_000)
    if (list.length >= connector.ratePerMinute) { calls.set(connector.id, list); return false }
    list.push(t)
    calls.set(connector.id, list)
    return true
  }

  function hostAllowed(connector, url) {
    const r = connectorHostOf(url, { allowLocalhost })
    return !r.error && connector.allowedHosts.includes(r.host)
  }

  async function timed(url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function oauthToken(connector, secret) {
    const cached = tokens.get(connector.id)
    if (cached && cached.until > now()) return { token: cached.token }
    const url = connector.auth.tokenUrl
    if (!hostAllowed(connector, url)) return { code: 'host_not_allowed' }
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: connector.auth.clientId, client_secret: secret.clientSecret })
    if (connector.auth.scope) form.set('scope', connector.auth.scope)
    let res
    try {
      res = await timed(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT }, body: form }, connector.timeoutMs)
    } catch (error) {
      return { code: error?.name === 'AbortError' ? 'timeout' : 'network_error' }
    }
    if (res.status >= 300 && res.status < 400) return { code: 'redirect_refused' }
    const body = await readCapped(res, 64 * 1024)
    if (!res.ok || !body) return { code: 'auth_failed', status: res.status }
    let json
    try { json = JSON.parse(body.toString('utf8')) } catch { return { code: 'auth_failed', status: res.status } }
    if (typeof json?.access_token !== 'string' || !json.access_token) return { code: 'auth_failed', status: res.status }
    const ttl = Number.isFinite(json.expires_in) ? Math.max(30, json.expires_in - 30) : 300
    tokens.set(connector.id, { token: json.access_token, until: now() + ttl * 1000 })
    return { token: json.access_token }
  }

  async function authHeaders(connector, secret) {
    const a = connector.auth ?? { type: 'none' }
    if (a.type === 'none') return { headers: {} }
    if (!secret) return { code: 'secret_missing' }
    if (a.type === 'api_key') return secret.token ? { headers: { [a.headerName ?? 'x-api-key']: secret.token } } : { code: 'secret_missing' }
    if (a.type === 'bearer') return secret.token ? { headers: { authorization: `Bearer ${secret.token}` } } : { code: 'secret_missing' }
    if (a.type === 'basic') {
      if (!secret.password) return { code: 'secret_missing' }
      return { headers: { authorization: `Basic ${Buffer.from(`${a.username}:${secret.password}`).toString('base64')}` } }
    }
    if (a.type === 'oauth2_client') {
      if (!secret.clientSecret) return { code: 'secret_missing' }
      const t = await oauthToken(connector, secret)
      return t.token ? { headers: { authorization: `Bearer ${t.token}` } } : { code: t.code, status: t.status }
    }
    return { code: 'secret_missing' }
  }

  /**
   * One call of an operation. → { ok, code?, status (HTTP, 0 when none), durationMs, attempts, data? (allow-listed fields), errors? (input) }
   * `checkInput: false` when the caller already checked the input.
   */
  async function run({ connector, operation, input = {}, secret = null, checkInput = true }) {
    const started = now()
    const done = (out) => ({ status: 0, attempts: 0, ...out, durationMs: Math.max(0, now() - started) })
    if (!connector?.enabled) return done({ ok: false, code: 'connector_disabled' })
    if (!operation) return done({ ok: false, code: 'operation_not_found' })
    if (checkInput) {
      const c = checkOperationInput(operation, input)
      if (!c.ok) return done({ ok: false, code: 'invalid_input', errors: c.errors })
    }
    const req = buildOperationRequest(operation, input)
    const url = new URL(`${connector.baseUrl}${req.path}`)
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v))
    if (!hostAllowed(connector, url.href)) return done({ ok: false, code: 'host_not_allowed' })
    if (!allowCall(connector)) return done({ ok: false, code: 'rate_limited' })
    const auth = await authHeaders(connector, secret)
    if (!auth.headers) return done({ ok: false, code: auth.code, status: auth.status ?? 0 })
    const headers = { accept: 'application/json', 'user-agent': USER_AGENT, ...auth.headers }
    if (req.body) headers['content-type'] = 'application/json'
    const init = { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined }
    const maxAttempts = operation.idempotent ? 2 : 1
    let last = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res
      try {
        res = await timed(url.href, init, connector.timeoutMs)
      } catch (error) {
        last = { ok: false, code: error?.name === 'AbortError' ? 'timeout' : 'network_error', attempts: attempt }
        if (attempt < maxAttempts) { await sleep(300); continue }
        return done(last)
      }
      if (res.status >= 300 && res.status < 400) {
        try { await res.body?.cancel?.() } catch { /* ignore */ }
        return done({ ok: false, code: 'redirect_refused', status: res.status, attempts: attempt })
      }
      if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
        try { await res.body?.cancel?.() } catch { /* ignore */ }
        await sleep(300)
        continue
      }
      if (res.status === 401 || res.status === 403) tokens.delete(connector.id)
      const body = await readCapped(res, connector.maxResponseBytes)
      if (body === null) return done({ ok: false, code: 'response_too_large', status: res.status, attempts: attempt })
      if (!res.ok) return done({ ok: false, code: 'upstream_error', status: res.status, attempts: attempt })
      let json = null
      if (body.length) {
        try { json = JSON.parse(body.toString('utf8')) } catch { return done({ ok: false, code: 'invalid_response', status: res.status, attempts: attempt }) }
      }
      return done({ ok: true, status: res.status, attempts: attempt, data: pickResponseFields(json, operation.responseFields) })
    }
    return done(last ?? { ok: false, code: 'network_error' })
  }

  /**
   * The connection test of the screen: a read operation (the given one, or the first read whose input needs nothing).
   * → run()'s result without data: { ok, code?, status, durationMs, fields: names of the allow-listed top-level fields received }
   */
  async function test({ connector, operationId = null, input = {}, secret = null }) {
    const op = operationId
      ? connector.operations.find((o) => o.id === operationId)
      : connector.operations.find((o) => o.effect === 'read' && !o.input.required.length)
    if (!op) return { ok: false, code: 'operation_not_found', status: 0, durationMs: 0, attempts: 0, fields: [] }
    if (op.effect !== 'read') return { ok: false, code: 'write_not_testable', status: 0, durationMs: 0, attempts: 0, fields: [] }
    const r = await run({ connector: { ...connector, enabled: true }, operation: op, input, secret })
    const { data, ...rest } = r
    return { ...rest, operationId: op.id, fields: data ? Object.keys(data) : [] }
  }

  return { run, test, reset: () => { calls.clear(); tokens.clear() } }
}
