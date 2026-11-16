// node:http instrumentation: trace in, x-request-id out, one access line per request (kind access), security events with
// the request's trace. The handler sets ctx.route (the route TEMPLATE, never the raw path), ctx.tenantId and ctx.actor
// once it knows them; the access line is written when the response finishes (or the client goes away).
//
//   const t = instrumentRequest(req, res, { logger, trustForwarded: true })
//   t.route = '/api/residents/:id'; t.actor = { type: 'user', id: user.id, role: user.role }
//   t.log.error('http.unhandled_error', { err })        // carries trace / tenant / actor
//   t.security('auth.login.failed', { attrs: { method: 'password', reason: 'invalid_credentials' } })
//   fetch(next, { headers: { ...t.outgoingHeaders() } })
import { createHash } from 'node:crypto'
import { maskPath } from './mask.mjs'
import { childTrace, outgoingHeaders, traceFromHeaders } from './trace.mjs'

/** The client address: the first X-Forwarded-For entry when the edge proxy is trusted to set it (Caddy replaces an untrusted one), else the socket. */
export function clientIp(req, { trustForwarded = false } = {}) {
  if (trustForwarded) {
    const xff = req.headers?.['x-forwarded-for']
    const first = String(Array.isArray(xff) ? xff[0] : xff ?? '').split(',')[0].trim()
    if (first) return first.replace(/^::ffff:/, '')
  }
  return String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
}

/** IPv4 → a.b.c.0/24, IPv6 → first 3 groups ::/48 (the access log keeps only this and a hash: design D2). */
export function ipPrefix(ip) {
  const s = String(ip ?? '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(s)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::/48`
  return ''
}

export const ipHash = (ip, salt = '') => (ip ? createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 12) : '')

/** Per-process counters of requests (route × method × status class). Lines for skipped requests (404, health) are only counted. */
export function createHttpStats() {
  const counts = new Map()
  return {
    add(route, method, status) {
      const key = `${method} ${route} ${Math.floor(status / 100)}xx`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    },
    snapshot: () => Object.fromEntries(counts),
  }
}

const DEFAULT_SKIP = ({ status, path }) => status === 404 || path === '/health' || path === '/healthz' || path.startsWith('/health/')

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} o
 * @param {ReturnType<import('./logger.mjs').createLogger>} o.logger
 * @param {boolean} [o.trustForwarded]  true behind a proxy that sets X-Forwarded-For (BFF behind Caddy, care-api behind the BFF)
 * @param {string} [o.ipSalt]
 * @param {(x: {status: number, path: string, route: string, templated: boolean}) => boolean} [o.skip]  requests that get no access line
 * @param {ReturnType<typeof createHttpStats>} [o.stats]
 */
export function instrumentRequest(req, res, { logger, trustForwarded = false, ipSalt = '', skip = DEFAULT_SKIP, stats } = {}) {
  const started = process.hrtime.bigint()
  const trace = traceFromHeaders(req.headers)
  let path = '/'
  try { path = new URL(req.url ?? '/', 'http://x').pathname } catch { /* keep '/' */ }
  const ip = clientIp(req, { trustForwarded })
  const ctx = {
    trace,
    requestId: trace.requestId,
    route: null,
    tenantId: null,
    actor: null,
    ip,
    attrs: {},
    log: null,
    security: (event, fields = {}) => ctx.log.security(event, { ...fields, ip }),
    outgoingHeaders: () => outgoingHeaders(childTrace(trace)),
  }
  ctx.log = logger.child(() => ({ trace, tenantId: ctx.tenantId, actor: ctx.actor ?? undefined }))
  try { if (!res.headersSent) res.setHeader('x-request-id', trace.requestId) } catch { /* headers already sent */ }
  let done = false
  const finish = (aborted) => {
    if (done) return
    done = true
    const status = aborted && !res.writableEnded ? 499 : res.statusCode
    const route = ctx.route ?? maskPath(path)
    const method = String(req.method ?? 'GET').toUpperCase()
    stats?.add(route, method, status)
    if (skip({ status, path, route, templated: ctx.route !== null })) return
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const len = Number(res.getHeader?.('content-length'))
    ctx.log.log(status >= 500 ? 'warn' : 'info', 'http.request', {
      kind: 'access',
      http: {
        method, route, status, ms: Math.round(ms * 10) / 10,
        ...(Number.isFinite(len) ? { bytes: len } : {}),
        ip_hash: ipHash(ip, ipSalt), ip_prefix: ipPrefix(ip),
        ...(aborted && status === 499 ? { aborted: true } : {}),
      },
      attrs: ctx.attrs,
    })
  }
  res.once('finish', () => finish(false))
  res.once('close', () => finish(true))
  return ctx
}
