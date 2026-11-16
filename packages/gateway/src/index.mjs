// DSH 設定画面を業務 Web（BFF）配下 `/dsh/*` に安全に埋め込む認証ゲートウェイ。
//
// - 認可は BFF 側（業務 Web のセッション）で行う：getSessionUser が null → 401、isAllowed が false → 403。
// - DSH の launch token → cookie 交換はゲートウェイがサーバ側で行い、cookie はメモリ内 jar に保持する。
//   DSH の cookie はブラウザに一切渡さない（Set-Cookie は吸収）。ブラウザの cookie（業務 Web のセッション等）は
//   DSH に転送しない。
// - DSH の browser-trust fence（Host / Origin 検査）は、上流へ送る Host を DSH 自身の loopback authority
//   （target の host:port）に書き換えて満たす。cookie の audience も同じ authority に結び付けられるので、
//   `--trusted-host` は不要。代わりにゲートウェイ自身がブラウザ側で同じ検査（Origin が BFF と同一か、
//   sec-fetch-site が cross-site でないか）を行う。
// - マウント接頭辞の除去、`/dsh` → `/dsh/` リダイレクト、Location の書き換え、WebSocket upgrade の中継。
// - 応答には X-Frame-Options: SAMEORIGIN と CSP frame-ancestors 'self' を付ける（上流のフレーム埋め込みポリシーは上書き）。
//
// Node の組み込みモジュールのみ。

import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'

export { fromEnv, fromFile, fromValue, supervise, parseLaunchToken, redactToken, resolveDshBin } from './launch-token.mjs'
export {
  ENV_ALIASES, DEFAULT_DSH_URL, DEFAULT_PUBLIC_ORIGIN, DEFAULT_PROFILE, WECOM_APP_CALLBACK_PREFIX, WECOM_APP_CALLBACK_PORT,
  readEnv, splitPublicHooks, launchTokenFromEnv, mountPathFromEnv, gatewayOptionsFromEnv,
} from './config.mjs'
export {
  prepareAssistantAttachments, checkAssistantAttachments, attachmentErrorStatus, ASSISTANT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_PROMPT, MAX_SCANNED_PAGES,
} from './assistant-attachments.mjs'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
])
// Browser → DSH: never forwarded. x-bridge-actor is the BFF → business API actor header; x-care-actor is its legacy name
// (ケアビリング). More names: options.stripRequestHeaders.
export const DEFAULT_STRIP_REQUEST_HEADERS = Object.freeze(['cookie', 'authorization', 'x-bridge-actor', 'x-care-actor', 'x-service-token',
  'x-bff-secret', 'x-delegation-token', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])

const FRAME_ANCESTORS = "frame-ancestors 'self'"

/**
 * Absolute (mount-unaware) URLs used by whitelisted plugins' browser code. Without these the
 * Proactive settings page and the auto-tasks panel fail under a sub-path deployment.
 * An entry matches the exact path or anything below it.
 */
export const DEFAULT_ROOT_PATHS = Object.freeze([
  '/api/dsh-proactive', // dsh-proactive 0.3.1: state / events / action
  '/api/session/list', // dsh-proactive 0.3.1: session picker
  '/auto-tasks/api', // dsh-auto-tasks 0.2.0
])

/** Parse Set-Cookie header values into name/value/deleted. */
function parseSetCookie(value) {
  const [pair, ...attrs] = String(value).split(';')
  const at = pair.indexOf('=')
  if (at <= 0) return undefined
  const name = pair.slice(0, at).trim()
  const val = pair.slice(at + 1).trim()
  let deleted = val === ''
  for (const attr of attrs) {
    const [k, v = ''] = attr.split('=')
    const key = k.trim().toLowerCase()
    if (key === 'max-age' && Number(v.trim()) <= 0) deleted = true
    if (key === 'expires' && Date.parse(v.trim()) <= Date.now()) deleted = true
  }
  return { name, value: val, deleted }
}

/** Merge or replace the frame-ancestors directive of a CSP value. */
export function withFrameAncestors(csp) {
  if (!csp) return FRAME_ANCESTORS
  const directives = String(csp).split(';').map((d) => d.trim()).filter(Boolean)
    .filter((d) => !/^frame-ancestors(\s|$)/i.test(d))
  directives.push(FRAME_ANCESTORS)
  return directives.join('; ')
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

/**
 * @param {object} options
 * @param {string} options.target           DSH listener origin, e.g. 'http://127.0.0.1:3180'
 * @param {string} [options.mountPath]      default '/dsh'
 * @param {(req: import('node:http').IncomingMessage) => Promise<{id?:string,email?:string,role?:string}|null>} options.getSessionUser
 * @param {(user: any) => boolean} [options.isAllowed]  default: role === 'admin'
 * @param {() => Promise<string>} options.launchToken   see fromFile / fromEnv / supervise
 * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
 * @param {number} [options.exchangeTimeoutMs] default 10000
 * @param {string[]} [options.rootPaths]  origin-root paths that some DSH plugins request with absolute
 *   URLs (ignoring the mount). They are proxied to DSH unchanged, behind the same auth. Default
 *   DEFAULT_ROOT_PATHS (dsh-proactive 0.3.1 / dsh-auto-tasks 0.2.0). Pass [] to disable.
 * @param {string[]} [options.publicPaths]  origin-root webhook paths (e.g. '/dsh-hooks/line') whose
 *   POST requests are forwarded to DSH WITHOUT BFF authentication: exact pathname match only, other
 *   methods get 405, browser cookies are removed and the DSH session cookie is NOT injected. The DSH
 *   route must authenticate the request itself (dsh-im verifies LINE signatures / Bot Framework JWTs).
 *   Default [] (nothing public).
 * @param {{prefix: string, target: string, methods?: string[]}[]} [options.publicPrefixes]  origin-root
 *   webhook PREFIXES forwarded to a separate listener WITHOUT BFF authentication (the WeCom self-built
 *   app callback `/wecom-app-callback/<botId>/<secret>` served by dsh-im's own listener, port 30987):
 *   the pathname below the prefix must be 1-4 plain segments ([A-Za-z0-9._~-], no '..'), the path and
 *   query are kept as is (WeCom signs msg_signature / timestamp / nonce / echostr), methods default to
 *   GET (URL verification) + POST; cookies and the DSH session never go upstream. The listener verifies
 *   the platform signature itself. Default [].
 * @param {{plugin?: string, channel: string, methods: string[]}[]} [options.rpcAllowlist]  the only
 *   management RPC plugin/channel/method triples gateway.rpc() may call server-side. plugin defaults to
 *   'dsh-im' (POST /api/dsh-im/<channel>); another plugin uses the same envelope at /api/<plugin><channel>
 *   (e.g. the assistant plugin). Default [] (rpc() always refuses).
 * @param {string[]} [options.stripRequestHeaders]  extra browser request headers that must never reach DSH (added to
 *   DEFAULT_STRIP_REQUEST_HEADERS, e.g. an application's own actor or tenant header).
 */
export function createDshGateway({
  target,
  mountPath = '/dsh',
  getSessionUser,
  isAllowed = (u) => u?.role === 'admin',
  launchToken,
  logger = console,
  exchangeTimeoutMs = 10000,
  rootPaths = DEFAULT_ROOT_PATHS,
  publicPaths = [],
  publicPrefixes = [],
  rpcAllowlist = [],
  stripRequestHeaders = [],
} = {}) {
  const STRIP_REQUEST = new Set([...DEFAULT_STRIP_REQUEST_HEADERS, ...stripRequestHeaders.map((h) => String(h).toLowerCase())])
  if (!target) throw new Error('dsh-gateway: target is required')
  if (typeof getSessionUser !== 'function') throw new Error('dsh-gateway: getSessionUser is required')
  if (typeof launchToken !== 'function') throw new Error('dsh-gateway: launchToken is required')
  const upstream = new URL(target)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('dsh-gateway: target must be http(s)')
  }
  const mount = ('/' + String(mountPath).replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '')
  if (!mount) throw new Error('dsh-gateway: mountPath must not be "/"')
  const transport = upstream.protocol === 'https:' ? https : http
  const upstreamAuthority = upstream.host // host:port as DSH sees it (loopback → trusted by the fence)

  /** @type {Map<string,string>} in-memory DSH cookie jar */
  const jar = new Map()
  let exchanging = null
  let generation = 0

  function cookieHeader() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  function absorbSetCookie(headers) {
    const values = headers['set-cookie']
    if (!values) return
    for (const value of [].concat(values)) {
      const parsed = parseSetCookie(value)
      if (!parsed) continue
      if (parsed.deleted) jar.delete(parsed.name)
      else jar.set(parsed.name, parsed.value)
    }
  }

  // Pooled sockets for ordinary requests; exchanges and upgrades use a fresh socket each
  // so a connection the upstream closed after a refusal is never reused.
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 64 })

  function upstreamRequest({ method, path, headers, pooled = true }) {
    return transport.request({
      agent: pooled ? agent : false,
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method,
      path,
      headers,
      // DSH serves a loopback-only listener; a self-signed TLS listener is acceptable only if configured so.
    })
  }

  /** One token → cookie exchange (`GET /?token=` → 303 + Set-Cookie). Single-flight. */
  function exchange(reason) {
    if (exchanging) return exchanging
    const started = generation
    exchanging = (async () => {
      const token = await launchToken()
      const status = await new Promise((resolve, reject) => {
        const req = upstreamRequest({
          method: 'GET',
          path: `/?token=${encodeURIComponent(token)}`,
          pooled: false,
          headers: { host: upstreamAuthority, accept: 'text/html' },
        })
        req.setTimeout(exchangeTimeoutMs, () => req.destroy(new Error('exchange timed out')))
        req.on('response', (res) => {
          if (generation === started) {
            jar.clear()
            absorbSetCookie(res.headers)
          }
          res.resume()
          resolve(res.statusCode)
        })
        req.on('error', reject)
        req.end()
      })
      if (status !== 303 || jar.size === 0) {
        jar.clear()
        throw new Error(`dsh-gateway: launch-token exchange failed (HTTP ${status})`)
      }
      generation += 1
      logger.info?.(`[dsh-gateway] DSH session established (${reason})`)
    })().finally(() => { exchanging = null })
    return exchanging
  }

  async function ensureSession() {
    if (jar.size === 0) await exchange('initial')
  }

  function invalidate(seenGeneration) {
    if (seenGeneration === generation) jar.clear()
  }

  const roots = rootPaths.map((p) => '/' + String(p).replace(/^\/+|\/+$/g, ''))

  // Public webhook paths: exact pathnames, no normalisation beyond what validation enforces.
  const publics = new Set()
  for (const p of Array.isArray(publicPaths) ? publicPaths : []) {
    const path = String(p).trim()
    if (!/^\/[A-Za-z0-9._~\-/]*[A-Za-z0-9._~-]$/.test(path) || path.includes('//') || path.split('/').includes('..')) {
      throw new Error(`dsh-gateway: invalid public path ${JSON.stringify(p)}`)
    }
    if (path === mount || path.startsWith(mount + '/')) throw new Error(`dsh-gateway: public path ${path} must be outside the mount`)
    publics.add(path)
  }

  // Public webhook prefixes with their own upstream (e.g. the dsh-im wecom-app callback listener).
  const prefixes = []
  for (const entry of Array.isArray(publicPrefixes) ? publicPrefixes : []) {
    const prefix = String(entry?.prefix ?? '').trim()
    if (!/^\/[A-Za-z0-9._~\-/]*\/$/.test(prefix) || prefix.includes('//') || prefix.split('/').includes('..') || prefix === '/') {
      throw new Error(`dsh-gateway: invalid public prefix ${JSON.stringify(entry?.prefix)} (must look like '/name/')`)
    }
    if (prefix === mount + '/' || prefix.startsWith(mount + '/')) throw new Error(`dsh-gateway: public prefix ${prefix} must be outside the mount`)
    let prefixTarget
    try { prefixTarget = new URL(String(entry?.target ?? '')) } catch { prefixTarget = null }
    if (!prefixTarget || (prefixTarget.protocol !== 'http:' && prefixTarget.protocol !== 'https:') || (prefixTarget.pathname !== '/' && prefixTarget.pathname !== '')) {
      throw new Error(`dsh-gateway: public prefix ${prefix} needs an http(s) origin target`)
    }
    const methods = (Array.isArray(entry?.methods) && entry.methods.length ? entry.methods : ['GET', 'POST']).map((m) => String(m).toUpperCase())
    if (methods.some((m) => !['GET', 'POST', 'HEAD'].includes(m))) throw new Error(`dsh-gateway: public prefix ${prefix} methods must be GET / POST / HEAD`)
    prefixes.push(Object.freeze({ prefix, target: prefixTarget, methods: Object.freeze([...new Set(methods)]) }))
  }
  const PREFIX_REST_RE = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+){0,3}$/
  function matchPrefix(pathname) {
    for (const entry of prefixes) {
      if (!pathname.startsWith(entry.prefix)) continue
      const rest = pathname.slice(entry.prefix.length)
      if (!PREFIX_REST_RE.test(rest) || rest.split('/').some((seg) => seg === '.' || seg === '..')) return null
      return entry
    }
    return null
  }

  // Server-side RPC allowlist: "<plugin><channel>" → Set(method). plugin defaults to dsh-im.
  const allowedRpc = new Map()
  for (const entry of Array.isArray(rpcAllowlist) ? rpcAllowlist : []) {
    const channel = String(entry?.channel ?? '')
    const plugin = entry?.plugin === undefined ? 'dsh-im' : String(entry.plugin)
    if (!/^\/[A-Za-z0-9._~-]+$/.test(channel) || !/^[a-z][a-z0-9-]{0,63}$/.test(plugin) || !Array.isArray(entry.methods)) {
      throw new Error(`dsh-gateway: invalid rpcAllowlist entry ${JSON.stringify(entry)}`)
    }
    const key = `${plugin}${channel}`
    const methods = allowedRpc.get(key) ?? new Set()
    for (const method of entry.methods) {
      if (typeof method !== 'string' || !/^[A-Za-z0-9._-]+$/.test(method)) throw new Error(`dsh-gateway: invalid rpc method ${JSON.stringify(method)}`)
      methods.add(method)
    }
    allowedRpc.set(key, methods)
  }

  function matchMount(rawUrl) {
    const url = new URL(rawUrl || '/', 'http://gateway.invalid')
    if (url.pathname === mount || url.pathname.startsWith(mount + '/')) return url
    if (roots.some((r) => url.pathname === r || url.pathname.startsWith(r + '/'))) {
      url.rootPath = true
      return url
    }
    return undefined
  }

  function upstreamPath(url, rawUrl) {
    const path = url.rootPath ? url.pathname : (url.pathname.slice(mount.length) || '/')
    // Keep the raw query byte-for-byte (DSH's combo loader uses `/plugins/??a.js,b.js&rev=`),
    // only removing `token` parameters: the browser never supplies a DSH credential.
    const q = String(rawUrl).indexOf('?')
    if (q === -1) return path
    const query = String(rawUrl).slice(q + 1).split('&')
      .filter((part) => !/^token(=|$)/i.test(part))
      .join('&')
    return path + (query ? `?${query}` : '')
  }

  /** Browser-side fence: same-origin only. Returns an error string or undefined. */
  function checkBrowserOrigin(req) {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'cross-site request'
    const origin = firstHeader(req.headers.origin)
    if (origin && origin !== 'null') {
      let originHost
      try { originHost = new URL(origin).host } catch { return 'malformed origin' }
      if (originHost !== req.headers.host) return 'origin mismatch'
    } else if (origin === 'null') {
      return 'opaque origin'
    }
    return undefined
  }

  async function authorize(req) {
    let user
    try {
      user = await getSessionUser(req)
    } catch (error) {
      logger.error?.(`[dsh-gateway] getSessionUser failed: ${error?.message ?? error}`)
      return { status: 503, error: 'session_lookup_failed' }
    }
    if (!user) return { status: 401, error: 'authentication_required' }
    let allowed = false
    try { allowed = Boolean(await isAllowed(user)) } catch { allowed = false }
    if (!allowed) return { status: 403, error: 'forbidden' }
    const fence = checkBrowserOrigin(req)
    if (fence) return { status: 403, error: 'forbidden_origin', detail: fence }
    return { user }
  }

  function frameHeaders(headers) {
    headers['x-frame-options'] = 'SAMEORIGIN'
    headers['content-security-policy'] = withFrameAncestors(firstHeader(headers['content-security-policy']))
    return headers
  }

  function sendJson(res, status, body, extra = {}) {
    res.writeHead(status, frameHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    }))
    res.end(JSON.stringify(body))
  }

  function buildUpstreamHeaders(req) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase()
      if (HOP_BY_HOP.has(k) || STRIP_REQUEST.has(k) || k === 'host' || k === 'origin' || k === 'referer') continue
      if (k.startsWith('sec-websocket-') ) continue
      headers[k] = value
    }
    headers.host = upstreamAuthority
    if (req.headers.origin) headers.origin = upstream.origin
    const cookie = cookieHeader()
    if (cookie) headers.cookie = cookie
    return headers
  }

  function rewriteLocation(location) {
    if (!location) return location
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(location)) {
        const abs = new URL(location)
        if (abs.origin !== upstream.origin) return location
        return mount + abs.pathname + abs.search + abs.hash
      }
    } catch {
      return location
    }
    if (location.startsWith('//')) return location
    if (location.startsWith('/')) return mount + location
    return location // relative: resolves under the mount on the browser side
  }

  function responseHeaders(upstreamHeaders) {
    const headers = {}
    for (const [key, value] of Object.entries(upstreamHeaders)) {
      const k = key.toLowerCase()
      if (HOP_BY_HOP.has(k) || k === 'set-cookie' || k === 'x-frame-options') continue
      headers[k] = value
    }
    if (headers.location) headers.location = rewriteLocation(firstHeader(headers.location))
    return frameHeaders(headers)
  }

  /** Forward one public webhook POST: no BFF auth, no browser cookie, no DSH cookie. */
  function forwardPublic(req, res, url) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase()
      // Authorization stays: Bot Framework signs Teams activities with a bearer JWT.
      if (HOP_BY_HOP.has(k) || k === 'host' || k === 'origin' || k === 'referer' || k === 'cookie') continue
      if (STRIP_REQUEST.has(k) && k !== 'authorization') continue
      headers[k] = value
    }
    headers.host = upstreamAuthority
    const q = String(req.url).indexOf('?')
    const path = url.pathname + (q === -1 ? '' : String(req.url).slice(q))
    const proxyReq = upstreamRequest({ method: 'POST', path, headers, pooled: false })
    proxyReq.on('response', (proxyRes) => {
      const out = {}
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const k = key.toLowerCase()
        if (HOP_BY_HOP.has(k) || k === 'set-cookie') continue
        out[k] = value
      }
      out['cache-control'] = 'no-store'
      res.writeHead(proxyRes.statusCode, out)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (error) => {
      logger.error?.(`[dsh-gateway] public webhook upstream error: ${error.message}`)
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'dsh_unavailable' })
      else res.destroy(error)
    })
    res.on('close', () => { if (!res.writableFinished) proxyReq.destroy() })
    req.pipe(proxyReq)
  }

  /** Forward one public webhook request under a prefix to its own listener (no BFF auth, no cookies either way). */
  function forwardPrefix(req, res, entry, pathname) {
    if (!entry.methods.includes(req.method)) {
      res.writeHead(405, { allow: entry.methods.join(', '), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }
    const target = entry.target
    const authority = target.host
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const k = key.toLowerCase()
      if (HOP_BY_HOP.has(k) || STRIP_REQUEST.has(k) || k === 'host' || k === 'origin' || k === 'referer' || k === 'cookie') continue
      headers[k] = value
    }
    headers.host = authority
    const q = String(req.url).indexOf('?')
    const path = pathname + (q === -1 ? '' : String(req.url).slice(q))
    const proxyReq = (target.protocol === 'https:' ? https : http).request({
      agent: false, protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method, path, headers,
    })
    proxyReq.on('response', (proxyRes) => {
      const out = {}
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const k = key.toLowerCase()
        if (HOP_BY_HOP.has(k) || k === 'set-cookie') continue
        out[k] = value
      }
      out['cache-control'] = 'no-store'
      res.writeHead(proxyRes.statusCode, out)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (error) => {
      logger.error?.(`[dsh-gateway] public webhook (${entry.prefix}) upstream error: ${error.message}`)
      if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'webhook_listener_unavailable' })
      else res.destroy(error)
    })
    res.on('close', () => { if (!res.writableFinished) proxyReq.destroy() })
    req.pipe(proxyReq)
  }

  /**
   * Call one allow-listed management RPC on the server side (owner cookie injected by the
   * gateway, never returned). Rejects with code 'rpc_not_allowed' outside rpcAllowlist.
   * @param {string} channelPath  e.g. '/weixin'
   * @param {string} method       e.g. 'provision.begin'
   * @param {object} [payload]
   * @param {{signal?: AbortSignal, timeoutMs?: number, plugin?: string}} [options]  plugin defaults to 'dsh-im'
   * @returns {Promise<{ok: boolean, value?: any, error?: {code: string, message: string}}>} the RPC result
   */
  async function rpc(channelPath, method, payload = {}, { signal, timeoutMs = 30000, plugin = 'dsh-im' } = {}) {
    const endpoint = typeof channelPath === 'string' && typeof plugin === 'string' ? `${plugin}${channelPath}` : null
    const methods = endpoint ? allowedRpc.get(endpoint) : undefined
    if (!methods || typeof method !== 'string' || !methods.has(method)) {
      throw Object.assign(new Error(`dsh-gateway: rpc ${plugin} ${channelPath} ${method} is not allowed`), { code: 'rpc_not_allowed' })
    }
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { method, payload } })
    const call = (retry) => ensureSession().then(() => new Promise((resolve, reject) => {
      const seen = generation
      const cookie = cookieHeader()
      const req = upstreamRequest({
        method: 'POST',
        path: `/api/${endpoint}`,
        headers: {
          host: upstreamAuthority,
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...(cookie ? { cookie } : {}),
        },
      })
      const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('rpc timed out'), { code: 'dsh_rpc_timeout' })))
      req.on('response', (res) => {
        absorbSetCookie(res.headers)
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort)
          if (res.statusCode === 401 && retry) {
            invalidate(seen)
            resolve(call(false))
            return
          }
          if (res.statusCode === 401) invalidate(seen)
          if (res.statusCode !== 200) {
            reject(Object.assign(new Error(`dsh-gateway: rpc failed (HTTP ${res.statusCode})`), { code: 'dsh_rpc_failed', status: res.statusCode }))
            return
          }
          let message
          try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { message = null }
          if (message?.type !== 'server-response' || message.rpcId !== rpcId || !message.result || typeof message.result.ok !== 'boolean') {
            reject(Object.assign(new Error('dsh-gateway: malformed rpc response'), { code: 'dsh_rpc_failed', status: 502 }))
            return
          }
          resolve(message.result)
        })
      })
      req.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error.name === 'AbortError' || error.code === 'dsh_rpc_timeout'
          ? error : Object.assign(new Error(`dsh-gateway: rpc upstream error: ${error.message}`), { code: 'dsh_rpc_failed', status: 502 }))
      })
      req.end(body)
    }))
    return call(true)
  }

  /**
   * Handle an HTTP request. Resolves true when the request belonged to the mount.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handleRequest(req, res) {
    if (publics.size || prefixes.length) {
      const pathname = new URL(req.url || '/', 'http://gateway.invalid').pathname
      if (publics.has(pathname)) {
        forwardPublic(req, res, { pathname })
        return true
      }
      const entry = prefixes.length ? matchPrefix(pathname) : null
      if (entry) {
        forwardPrefix(req, res, entry, pathname)
        return true
      }
    }
    const url = matchMount(req.url)
    if (!url) return false

    const auth = await authorize(req)
    if (!auth.user) {
      sendJson(res, auth.status, { ok: false, error: auth.error })
      return true
    }
    if (url.pathname === mount) {
      res.writeHead(308, frameHeaders({ location: mount + '/' + url.search, 'cache-control': 'no-store' }))
      res.end()
      return true
    }

    const path = upstreamPath(url, req.url)
    const replayable = req.method === 'GET' || req.method === 'HEAD'

    const attempt = async (retry) => {
      try {
        await ensureSession()
      } catch (error) {
        logger.error?.(`[dsh-gateway] ${error.message}`)
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'dsh_unavailable' })
        return
      }
      const seen = generation
      const proxyReq = upstreamRequest({ method: req.method, path, headers: buildUpstreamHeaders(req) })
      let answered = false
      proxyReq.on('response', (proxyRes) => {
        answered = true
        absorbSetCookie(proxyRes.headers)
        if (proxyRes.statusCode === 401 && retry) {
          // DSH restarted (new signing secret) or cookie expired: re-exchange and replay once.
          proxyRes.resume()
          invalidate(seen)
          attempt(false)
          return
        }
        if (proxyRes.statusCode === 401) invalidate(seen)
        res.writeHead(proxyRes.statusCode, responseHeaders(proxyRes.headers))
        proxyRes.pipe(res)
      })
      proxyReq.on('error', (error) => {
        if (answered && !res.headersSent) return // superseded by the retry
        logger.error?.(`[dsh-gateway] upstream error: ${error.message}`)
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'dsh_unavailable' })
        else res.destroy(error)
      })
      res.on('close', () => { if (!res.writableFinished) proxyReq.destroy() })
      if (replayable) proxyReq.end()
      else req.pipe(proxyReq)
    }
    await attempt(replayable)
    return true
  }

  function rejectUpgrade(socket, status, text) {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\nX-Frame-Options: SAMEORIGIN\r\n\r\n`)
    }
    socket.destroy()
  }

  /**
   * Handle an HTTP upgrade (WebSocket). Resolves true when it belonged to the mount.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  async function handleUpgrade(req, socket, head) {
    const url = matchMount(req.url)
    if (!url) return false
    socket.on('error', () => {})

    const auth = await authorize(req)
    if (!auth.user) {
      rejectUpgrade(socket, auth.status, auth.status === 401 ? 'Unauthorized' : auth.status === 403 ? 'Forbidden' : 'Service Unavailable')
      return true
    }
    const path = upstreamPath(url, req.url)

    const attempt = async (retry) => {
      try {
        await ensureSession()
      } catch (error) {
        logger.error?.(`[dsh-gateway] ${error.message}`)
        return rejectUpgrade(socket, 502, 'Bad Gateway')
      }
      const seen = generation
      const headers = buildUpstreamHeaders(req)
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase().startsWith('sec-websocket-')) headers[key.toLowerCase()] = value
      }
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade || 'websocket'
      const proxyReq = upstreamRequest({ method: req.method || 'GET', path, headers, pooled: false })
      let answered = false
      proxyReq.on('upgrade', (proxyRes, upSocket, upHead) => {
        answered = true
        absorbSetCookie(proxyRes.headers)
        const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || 'Switching Protocols'}`]
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          const k = proxyRes.rawHeaders[i]
          if (k.toLowerCase() === 'set-cookie') continue
          lines.push(`${k}: ${proxyRes.rawHeaders[i + 1]}`)
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead?.length) socket.write(upHead)
        if (head?.length) upSocket.write(head)
        upSocket.on('error', () => socket.destroy())
        socket.on('error', () => upSocket.destroy())
        upSocket.on('close', () => socket.destroy())
        socket.on('close', () => upSocket.destroy())
        upSocket.pipe(socket)
        socket.pipe(upSocket)
      })
      proxyReq.on('response', (proxyRes) => {
        answered = true
        absorbSetCookie(proxyRes.headers)
        proxyRes.resume()
        if (proxyRes.statusCode === 401 && retry) {
          invalidate(seen)
          attempt(false)
          return
        }
        if (proxyRes.statusCode === 401) invalidate(seen)
        rejectUpgrade(socket, proxyRes.statusCode, proxyRes.statusMessage || 'Error')
      })
      proxyReq.on('error', (error) => {
        if (answered) return // e.g. the upstream closed after a 401 we are already retrying
        logger.error?.(`[dsh-gateway] upstream upgrade error: ${error.message}`)
        rejectUpgrade(socket, 502, 'Bad Gateway')
      })
      proxyReq.end()
    }
    await attempt(true)
    return true
  }

  return {
    handleRequest,
    handleUpgrade,
    rpc,
    /** Public webhook paths in effect (for diagnostics). */
    publicPaths: Object.freeze([...publics]),
    publicPrefixes: Object.freeze(prefixes.map((p) => p.prefix)),
    /** Drop the DSH cookie (next request re-exchanges). */
    reset() { jar.clear() },
    /** Release pooled upstream sockets (call on BFF shutdown). */
    close() { agent.destroy() },
    /** True when a DSH session cookie is held (for health checks; never exposes the value). */
    get hasSession() { return jar.size > 0 },
    mountPath: mount,
  }
}
