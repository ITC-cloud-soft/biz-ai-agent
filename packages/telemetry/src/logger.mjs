// createLogger: one JSON line per event, the same fields in every service (RSI_SELF_IMPROVING_SYSTEM.md §5.1;
// care-ai-native docs/design/LOGGING_MONITORING_RSI.md §4). Masks by default, never throws, writes nothing but `write(line)`.
//
//   const log = createLogger({ app: 'carebilling', service: 'care-api', version: 'f612d0d', env: 'staging' })
//   log.info('worker.batch.done', { msg: 'batch done', attrs: { processed: 12, failed: 0 } })
//   log.error('http.unhandled_error', { err: error, http: { method, route, status: 500 } })
//   const rlog = log.child(() => ({ trace, tenantId, actor }))   // bindings may be a function (read at write time)
import { errorFields } from './fingerprint.mjs'
import { maskAttrs, maskMessage, maskString } from './mask.mjs'

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: 100 })
export const KINDS = Object.freeze(['app', 'access', 'security', 'job', 'delivery', 'client', 'interaction', 'infra'])
export const LOG_SCHEMA_VERSION = 1
const EVENT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const HTTP_KEYS = ['method', 'route', 'status', 'ms', 'bytes', 'ip_hash', 'ip_prefix', 'aborted']
const ACTOR_TYPES = new Set(['human', 'user', 'staff', 'service', 'ai', 'system', 'portal', 'anonymous'])

const defaultWrite = (line) => { process.stdout.write(`${line}\n`) }

function levelOf(name, fallback = 'info') {
  const n = String(name ?? '').toLowerCase()
  return Object.hasOwn(LEVELS, n) ? n : fallback
}

function cleanHttp(http) {
  if (!http || typeof http !== 'object') return undefined
  const out = {}
  for (const k of HTTP_KEYS) {
    const v = http[k]
    if (v === undefined || v === null) continue
    if (k === 'route') out.route = maskString(v, { max: 160 }).value
    else if (k === 'method') out.method = String(v).toUpperCase().slice(0, 10)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else out[k] = String(v).slice(0, 64)
  }
  return Object.keys(out).length ? out : undefined
}

function cleanActor(actor) {
  if (!actor || typeof actor !== 'object') return undefined
  const type = ACTOR_TYPES.has(actor.type) ? actor.type : 'unknown'
  const out = { type }
  if (actor.id != null) out.id = maskString(actor.id, { max: 64 }).value // an e-mail used as an id becomes [email]
  if (actor.role) out.role = String(actor.role).slice(0, 40)
  if (actor.onBehalfOf != null) out.on_behalf_of = maskString(actor.onBehalfOf, { max: 64 }).value
  return out
}

/**
 * @param {object} o
 * @param {string} [o.app]      system name (carebilling)
 * @param {string} o.service    care-api / care-web / care-worker / dsh …
 * @param {string} [o.version]  image tag / git short hash
 * @param {string} [o.env]      staging / prod / dev / test
 * @param {string} [o.level]    minimum level (debug|info|warn|error|fatal|silent)
 * @param {(line: string) => void} [o.write]
 */
export function createLogger({ app = '', service, version = 'dev', env = 'dev', level = 'info', write = defaultWrite, now = () => new Date() } = {}) {
  const base = { app, service: service ?? 'unknown', version: String(version), env: String(env) }
  let min = LEVELS[levelOf(level)]

  function emit(levelName, event, fields = {}, bindings = []) {
    try {
      const lv = levelOf(levelName)
      if (LEVELS[lv] < min || lv === 'silent') return
      // bindings: objects or functions returning objects (latest wins); fields win over bindings
      const b = {}
      for (const x of bindings) Object.assign(b, typeof x === 'function' ? x() : x)
      const f = { ...b, ...fields, attrs: { ...(b.attrs ?? {}), ...(fields.attrs ?? {}) } }
      let masked = false
      const trace = f.trace ?? {}
      const http = cleanHttp(f.http)
      const line = {
        ts: now().toISOString(),
        level: lv,
        ...base,
        kind: KINDS.includes(f.kind) ? f.kind : 'app',
        trace_id: trace.traceId ?? null,
        span_id: trace.spanId ?? null,
        ...(trace.requestId ? { request_id: trace.requestId } : {}),
        ...(f.tenantId ? { tenant_id: String(f.tenantId).slice(0, 64) } : {}),
      }
      const actor = cleanActor(f.actor)
      if (actor) line.actor = actor
      const ev = String(event ?? '')
      line.event = EVENT.test(ev) ? ev : 'log.invalid_event'
      const msg = maskMessage(f.msg ?? '', { max: 300 })
      if (msg.masked) masked = true
      line.msg = msg.value
      if (http) line.http = http
      if (f.err !== undefined && f.err !== null) {
        line.err = typeof f.err === 'object' && typeof f.err.fingerprint === 'string' && !(f.err instanceof Error)
          ? f.err
          : errorFields(f.err, { service: base.service, route: http?.route ?? '' })
      }
      const attrs = maskAttrs(f.attrs)
      if (attrs.masked) masked = true
      if (Object.keys(attrs.value).length) line.attrs = attrs.value
      if (f.ip) line.ip = String(f.ip).slice(0, 64) // security events only (pii: restricted)
      if (ev !== line.event) line.attrs = { ...(line.attrs ?? {}), event_raw: maskString(ev, { max: 80 }).value }
      line.pii = f.ip ? 'restricted' : masked ? 'masked' : 'none'
      write(JSON.stringify(line))
    } catch (error) {
      try { write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...base, kind: 'app', event: 'log.write_failed', msg: String(error?.message ?? error).slice(0, 120), pii: 'none' })) } catch { /* never throw */ }
    }
  }

  function make(bindings) {
    const api = {
      debug: (event, fields) => emit('debug', event, fields, bindings),
      info: (event, fields) => emit('info', event, fields, bindings),
      warn: (event, fields) => emit('warn', event, fields, bindings),
      error: (event, fields) => emit('error', event, fields, bindings),
      fatal: (event, fields) => emit('fatal', event, fields, bindings),
      log: (levelName, event, fields) => emit(levelName, event, fields, bindings),
      /** A security event (kind security). `ip` is kept raw and makes the line pii: restricted. */
      security: (event, fields = {}) => emit(fields.level ?? 'warn', event, { ...fields, kind: 'security' }, bindings),
      child: (more) => make([...bindings, more]),
      enabled: (levelName) => LEVELS[levelOf(levelName)] >= min,
      setLevel: (levelName) => { min = LEVELS[levelOf(levelName)] },
      get level() { return Object.keys(LEVELS).find((k) => LEVELS[k] === min) },
      service: base.service,
      /**
       * A console-shaped adapter for code that still calls log.error('[x] text', error): the text becomes a masked msg,
       * Errors become err (fingerprinted, no raw object), plain objects become masked attrs.args. Event: log.console.
       */
      console: () => {
        const write = (lv) => (...args) => {
          const texts = []
          let err
          const objs = []
          for (const a of args) {
            if (a instanceof Error || (a && typeof a === 'object' && typeof a.stack === 'string')) err ??= a
            else if (a && typeof a === 'object') objs.push(a)
            else texts.push(String(a))
          }
          const text = texts.join(' ').replace(/^\[[\w-]+\]\s*/, '')
          emit(lv, 'log.console', { msg: text, err, attrs: objs.length ? { args: objs.slice(0, 3) } : {} }, bindings)
        }
        return { debug: write('debug'), log: write('info'), info: write('info'), warn: write('warn'), error: write('error') }
      },
    }
    return api
  }
  return make([])
}

/** A logger that writes nothing (tests, libraries without a host logger). */
export const silentLogger = () => createLogger({ service: 'silent', level: 'silent', write: () => {} })
