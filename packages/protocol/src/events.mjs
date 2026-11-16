// Event validation: envelope schema + the manifest payload whitelist (invariant 4: events carry no personal data).
import { validateSchema } from './jsonschema.mjs'
import { loadEventEnvelopeSchema } from './manifest.mjs'
import { isPiiLikeKey, scanJson } from './pii.mjs'

/**
 * checkPayloadWhitelist(type, payload, source) -> { ok, unknownKeys, piiLikeKeys, findings, undeclaredType }
 * `source` is a manifest (events.<type>.payload) or an explicit array of allowed keys.
 * Every payload key must be whitelisted; no key may look like personal data; no string value may look like personal
 * data (heuristics in pii.mjs, plus optional exact `probes` such as the names of seeded test persons).
 */
export function checkPayloadWhitelist(type, payload, source, { probes = [], allow = [] } = {}) {
  const keys = Array.isArray(source) ? source : (source?.events?.[type]?.payload ?? null)
  const out = { ok: true, undeclaredType: keys === null, unknownKeys: [], piiLikeKeys: [], findings: [] }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ...out, ok: false, findings: [{ path: '/', kind: 'payload_not_object' }] }
  if (keys === null) out.ok = false
  const allowed = new Set(keys ?? [])
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) out.unknownKeys.push(k)
    if (isPiiLikeKey(k)) out.piiLikeKeys.push(k)
  }
  out.findings = scanJson(payload, { probes, allow })
  out.ok = out.ok && !out.unknownKeys.length && !out.piiLikeKeys.length && !out.findings.length
  return out
}

/**
 * validateEvent(event, { manifest, probes }) -> { valid, errors }
 * Envelope schema; with a manifest also: the type is declared and the payload passes checkPayloadWhitelist.
 */
export function validateEvent(event, { manifest = null, probes = [], allow = [] } = {}) {
  const errors = []
  const r = validateSchema(loadEventEnvelopeSchema(), event)
  for (const e of r.errors) errors.push({ path: e.path || '/', message: e.message, code: `schema.${e.keyword}` })
  if (manifest && event && typeof event === 'object' && typeof event.type === 'string') {
    if (!manifest.events?.[event.type]) errors.push({ path: '/type', message: `event type "${event.type}" is not declared in the manifest`, code: 'manifest.undeclared_type' })
    else {
      const w = checkPayloadWhitelist(event.type, event.payload, manifest, { probes, allow })
      for (const k of w.unknownKeys) errors.push({ path: `/payload/${k}`, message: `payload key "${k}" is not whitelisted for ${event.type}`, code: 'payload.unknown_key' })
      for (const k of w.piiLikeKeys) errors.push({ path: `/payload/${k}`, message: `payload key "${k}" looks like personal data`, code: 'payload.pii_key' })
      for (const f of w.findings) errors.push({ path: `/payload${f.path === '/' ? '' : f.path}`, message: `payload value looks like personal data (${f.kind})`, code: `payload.pii_value.${f.kind}` })
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * validateEventPage(body, { manifest, probes }) -> { valid, errors }
 * Checks the GET /bridge/v1/events response: ok, events[], nextAfter, ordering and the cursor rule.
 */
export function validateEventPage(body, { after = 0, manifest = null, probes = [], allow = [] } = {}) {
  const errors = []
  const bad = (path, message, code) => errors.push({ path, message, code })
  if (!body || typeof body !== 'object') return { valid: false, errors: [{ path: '/', message: 'response is not an object', code: 'page.shape' }] }
  if (body.ok !== true) bad('/ok', 'must be true', 'page.ok')
  if (!Array.isArray(body.events)) { bad('/events', 'must be an array', 'page.events'); return { valid: false, errors } }
  if (!Number.isInteger(body.nextAfter)) bad('/nextAfter', 'must be an integer', 'page.next_after')
  let prev = after
  body.events.forEach((ev, i) => {
    const r = validateEvent(ev, { manifest, probes, allow })
    for (const e of r.errors) errors.push({ ...e, path: `/events/${i}${e.path === '/' ? '' : e.path}` })
    if (Number.isInteger(ev?.id)) {
      if (ev.id <= prev) bad(`/events/${i}/id`, `ids must be strictly increasing and greater than after (${ev.id} <= ${prev})`, 'page.order')
      prev = ev.id
    }
  })
  if (Number.isInteger(body.nextAfter)) {
    const expected = body.events.length ? body.events[body.events.length - 1].id : after
    if (body.nextAfter !== expected) bad('/nextAfter', `must equal the last event id (or the request cursor when empty): expected ${expected}`, 'page.next_after')
  }
  return { valid: errors.length === 0, errors }
}
