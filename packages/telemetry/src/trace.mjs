// W3C Trace Context (https://www.w3.org/TR/trace-context/): traceparent = 00-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>.
// The request id shown to people (「お問い合わせ番号」) is the x-request-id the edge (Caddy) set, or the head of the trace id.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/
const ZERO_TRACE = '0'.repeat(32)
const ZERO_SPAN = '0'.repeat(16)

export const newTraceId = () => randomBytes(16).toString('hex')
export const newSpanId = () => randomBytes(8).toString('hex')

export function parseTraceparent(value) {
  const m = TRACEPARENT.exec(String(value ?? '').trim().toLowerCase())
  if (!m || m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return null
  return { traceId: m[1], parentSpanId: m[2], flags: m[3] }
}

export const formatTraceparent = ({ traceId, spanId, flags = '01' }) => `00-${traceId}-${spanId}-${flags}`

function header(headers, name) {
  const v = headers?.[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * The trace of an incoming request: continue the caller's traceparent, else derive the trace id from an x-request-id that
 * is a UUID (Caddy's {http.request.uuid}), else start a new one. Always a fresh span id for this hop.
 */
export function traceFromHeaders(headers) {
  const parent = parseTraceparent(header(headers, 'traceparent'))
  const rid = String(header(headers, 'x-request-id') ?? '').trim()
  const validRid = REQUEST_ID.test(rid) ? rid : null
  let traceId = parent?.traceId
  if (!traceId && validRid) {
    const hex = validRid.replace(/-/g, '').toLowerCase()
    if (/^[0-9a-f]{32}$/.test(hex) && hex !== ZERO_TRACE) traceId = hex
  }
  traceId ??= newTraceId()
  return {
    traceId,
    spanId: newSpanId(),
    parentSpanId: parent?.parentSpanId ?? null,
    flags: parent?.flags ?? '01',
    requestId: validRid ?? traceId.slice(0, 16),
  }
}

/** A child span in the same trace (an outgoing call, a queued job). */
export const childTrace = (trace) => ({ ...trace, parentSpanId: trace.spanId, spanId: newSpanId() })

/** Headers to send on an outgoing call so the next hop continues this trace. */
export function outgoingHeaders(trace) {
  if (!trace?.traceId) return {}
  return {
    traceparent: formatTraceparent({ traceId: trace.traceId, spanId: trace.spanId ?? newSpanId(), flags: trace.flags }),
    'x-request-id': trace.requestId ?? trace.traceId.slice(0, 16),
  }
}

/** The traceparent to store with queued work (an outbox row, an ai_event), or null. */
export const storedTraceparent = (trace) => (trace?.traceId ? formatTraceparent({ traceId: trace.traceId, spanId: trace.spanId ?? newSpanId(), flags: trace.flags }) : null)

const traceStore = new AsyncLocalStorage()
/** Run fn with `trace` as the current trace: code deep in a request (an outbox insert, an audit row) reads it with currentTrace(). */
export const runWithTrace = (trace, fn) => traceStore.run(trace, fn)
/** The trace of the request (or job) being handled, or null. */
export const currentTrace = () => traceStore.getStore() ?? null
/** The current trace as a traceparent to store with queued work, or null outside a request. */
export const currentTraceparent = () => storedTraceparent(currentTrace())

/** The trace of queued work from its stored traceparent (a new span in that trace), or a new trace when none was stored. */
export function traceFromStored(traceparent) {
  const p = parseTraceparent(traceparent)
  if (!p) return { traceId: newTraceId(), spanId: newSpanId(), parentSpanId: null, flags: '01', requestId: null }
  return { traceId: p.traceId, spanId: newSpanId(), parentSpanId: p.parentSpanId, flags: p.flags, requestId: p.traceId.slice(0, 16) }
}
