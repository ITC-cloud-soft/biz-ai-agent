// Error fingerprint: the same cause → the same 16-hex id, across requests and restarts, so it can be counted, linked to a
// bug number and checked after a fix (care-ai-native docs/design/LOGGING_MONITORING_RSI.md §10). Built from the service,
// the error class, the database code / constraint, the route template and the top 3 own stack frames (no line numbers,
// no absolute paths). Messages are masked; pg's `detail` / `where` / `hint` / parameters carry values and are never copied.
import { createHash } from 'node:crypto'
import { maskMessage } from './mask.mjs'

const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(?:file:\/\/\/?)?(.+?)(?::\d+){1,2}\)?\s*$/

export function stackFrames(stack, n = 3) {
  const out = []
  for (const line of String(stack ?? '').split('\n').slice(1)) {
    const m = FRAME.exec(line)
    if (!m) continue
    const file = m[2].replace(/\\/g, '/').split('/').slice(-2).join('/')
    if (m[2].startsWith('node:') || m[2].includes('node_modules/')) continue
    out.push(`${(m[1] ?? '<anon>').replace(/^async\s+/, '')}@${file}`)
    if (out.length >= n) break
  }
  return out
}

export function fingerprintOf(parts) {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16)
}

/** The safe description of an error for a log line: kind, code, constraint, table, masked message, own frames, fingerprint. */
export function errorFields(error, { service = '', route = '' } = {}) {
  if (!error || typeof error !== 'object') {
    return { kind: typeof error, message: maskMessage(String(error)).value, fingerprint: fingerprintOf([service, typeof error, route]) }
  }
  const ctor = error.constructor?.name
  const kind = ctor && ctor !== 'Object' ? ctor : (typeof error.name === 'string' ? error.name : 'Error')
  const code = error.code != null ? String(error.code).slice(0, 40) : undefined
  const constraint = typeof error.constraint === 'string' ? error.constraint.slice(0, 80) : undefined
  const table = typeof error.table === 'string' ? error.table.slice(0, 80) : undefined
  const frames = stackFrames(error.stack)
  const fields = {
    kind,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
    ...(table ? { table } : {}),
    message: maskMessage(error.message ?? '').value,
    frames,
    fingerprint: fingerprintOf([service, kind, code ?? '', constraint ?? '', route, ...frames]),
  }
  if (error.cause && typeof error.cause === 'object') {
    fields.cause = { kind: error.cause.constructor?.name ?? 'Error', ...(error.cause.code != null ? { code: String(error.cause.code).slice(0, 40) } : {}) }
  }
  return fields
}
