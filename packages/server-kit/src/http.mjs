// Minimal HTTP layer (node:http, no framework): a router with 404 / 405, JSON bodies, the error envelope and the
// `bridge-protocol: 1` header on EVERY response (errors, 304 and static files included).
// Generalized from examples/bridge-demo/src/http.mjs of care-ai-native.
export const MAX_BODY_BYTES = 64 * 1024
export const PLATFORM_RE = /^[a-z][a-z0-9_-]{1,31}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
export const PROTOCOL_HEADER = 'bridge-protocol'

/**
 * An error that becomes { ok:false, error:<code> } with `status`. Codes are lower snake case and stable.
 * `details` (optional, machine-readable: { field } of a validation error, { errors } of invalid_profile) goes into the envelope.
 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** Throws an HttpError (use as an expression: `cond || fail(400, 'x')`). */
export const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details) }

export function baseHeaders(extra = {}) {
  return { [PROTOCOL_HEADER]: '1', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers }))
  res.end(text)
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal_error'
  const body = error instanceof HttpError && error.details !== undefined ? { ok: false, error: code, details: error.details } : { ok: false, error: code }
  sendJson(res, status, body, status === 405 && error.allow ? { allow: error.allow } : {})
}

/** Reads a JSON object body (or nothing). Arrays / scalars / invalid JSON: 400 invalid_json; too large: 413. */
export async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    // already parsed by a host framework (express.json() etc.): apply the same shape rule
    if (Array.isArray(req.body)) throw new HttpError(400, 'invalid_json')
    return Object.keys(req.body).length ? req.body : null
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk)
  }
  if (!size) return null
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\b/i.test(type)) throw new HttpError(400, 'invalid_json', 'content-type must be application/json')
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'invalid_json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json')
  return value
}

/** '/bridge/v1/me/identities/:identityId' -> { regex, names }. `patterns` overrides the segment pattern per name. */
export function compilePath(pattern, patterns = {}) {
  const names = []
  const source = pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/:([A-Za-z0-9_]+)/g, (_, n) => { names.push(n); return `(${patterns[n] ?? '[^/]+'})` })
  return { regex: new RegExp(`^${source}$`), names }
}

/**
 * A tiny router. add(method, pattern, policy, handler, { patterns?, maxBodyBytes? }) — the policy is read by the gate (gate.mjs)
 * before the handler runs; maxBodyBytes raises the JSON body limit of that route (default MAX_BODY_BYTES).
 * match(method, path) -> { route, params } | { error } (405 / 400) | null (404)
 */
export function createRouter() {
  const routes = []
  return {
    routes,
    add(method, pattern, policy, handler, { patterns, maxBodyBytes } = {}) {
      if (!policy || typeof policy !== 'object') throw new TypeError(`route ${method} ${pattern}: a policy object is required`)
      if (typeof handler !== 'function') throw new TypeError(`route ${method} ${pattern}: handler must be a function`)
      routes.push({ method: method.toUpperCase(), pattern, policy, handler, ...(maxBodyBytes ? { maxBodyBytes } : {}), ...compilePath(pattern, patterns) })
    },
    match(method, path) {
      const allowed = []
      for (const r of routes) {
        const m = r.regex.exec(path)
        if (!m) continue
        if (r.method !== method) { allowed.push(r.method); continue }
        let params
        try { params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) } catch { return { error: new HttpError(400, 'invalid_path') } }
        return { route: r, params }
      }
      if (allowed.length) return { error: Object.assign(new HttpError(405, 'method_not_allowed'), { allow: [...new Set(allowed)].join(', ') }) }
      return null
    },
  }
}

// ------------------------------------------------------------------ input validation helpers
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Only the listed keys may be present (strict bodies: a `userId` in a body is refused, never trusted). */
export function strictKeys(body, allowed, code = 'unknown_field') {
  for (const k of Object.keys(body ?? {})) if (!allowed.includes(k)) fail(400, code)
}

export const optString = (v, max, code) => {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length > max) fail(400, code)
  return v
}

/** A trusted IM source (from the platform event, never from message text): { platform, teamId, userId, botId }. */
export function parseSource(source) {
  if (!isObject(source)) fail(400, 'invalid_source')
  const { platform, teamId, userId, botId } = source
  if (typeof platform !== 'string' || !PLATFORM_RE.test(platform)) fail(400, 'invalid_source')
  if (typeof userId !== 'string' || !userId.length || userId.length > 128) fail(400, 'invalid_source')
  if (teamId !== undefined && teamId !== null && (typeof teamId !== 'string' || teamId.length > 128)) fail(400, 'invalid_source')
  if (botId !== undefined && botId !== null && (typeof botId !== 'string' || botId.length > 128)) fail(400, 'invalid_source')
  return { platform, teamId: teamId ?? '', userId, botId: botId || null }
}

/** First value of a (possibly repeated) request header. */
export const header = (req, name) => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** ISO string of a Date / timestamp / string, or null. */
export const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString())
