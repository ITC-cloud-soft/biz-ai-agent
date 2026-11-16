// Business events (transactional outbox). The writer refuses an undeclared type and any payload key that is not
// whitelisted FOR THAT TYPE in the manifest, using the protocol's own checkPayloadWhitelist.
import { checkPayloadWhitelist } from '@dsh-bridge/protocol'

export class EventRejected extends Error {
  constructor(reason) {
    super(`event rejected: ${reason}`)
    this.name = 'EventRejected'
    this.reason = reason
  }
}

/**
 * Checks an event against the manifest without writing it. -> the cleaned payload (undefined values dropped).
 * Throws EventRejected('undeclared_type' | 'invalid_aggregate' | 'payload (...)'); never echoes payload values.
 */
export function checkEvent(manifest, { type, aggregateType, aggregateId, payload = {} }) {
  const decl = manifest.events?.[type]
  if (!decl || decl.deprecated) throw new EventRejected('undeclared_type')
  if (!/^[a-z][a-z0-9_]*$/.test(String(aggregateType)) || !aggregateId || String(aggregateId).length > 128) throw new EventRejected('invalid_aggregate')
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new EventRejected('payload (not an object)')
  const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined))
  const check = checkPayloadWhitelist(type, clean, manifest)
  if (!check.ok) {
    const reasons = [
      ...(check.unknownKeys ?? []).map((k) => `unknown key ${k}`),
      ...(check.piiLikeKeys ?? []).map((k) => `pii-like key ${k}`),
      ...(check.findings ?? []).map((f) => `${f.kind} at ${f.path}`),
    ]
    throw new EventRejected(`payload (${reasons.join(', ')})`)
  }
  return clean
}

/**
 * createEventWriter(manifest) -> emitEvent(t, { type, aggregateType, aggregateId, payload }) -> event id
 * `t` is a store transaction (store.tx): the event commits with the business change or not at all.
 */
export function createEventWriter(manifest) {
  return async function emitEvent(t, event) {
    if (!t || typeof t.insertEvent !== 'function') throw new TypeError('emitEvent(t, event): t must be a store transaction (store.tx)')
    const payload = checkEvent(manifest, event)
    return t.insertEvent({ type: event.type, aggregateType: event.aggregateType, aggregateId: String(event.aggregateId), payload })
  }
}

/** The v1 wire form of a stored event. */
export const eventJson = (e) => ({
  id: e.id, type: e.type, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload, at: new Date(e.createdAt).toISOString(),
})
