// Delegations (the AI acting as one employee, at most 5 minutes) and the web AI assistant (tickets bound to the web session).
import { newToken, sha256, TOKEN_PREFIX } from '../crypto.mjs'
import { POLICY, userRef } from '../gate.mjs'
import { fail, HttpError, iso, isObject, parseSource, strictKeys } from '../http.mjs'
import { identityOf } from './identity.mjs'

export const DELEGATION_TTL_MS = 5 * 60_000
export const TICKET_TTL_MS = 30 * 60_000
/** How long a triggering event stays fresh for its per-event delegation, unless the rule says otherwise (maxAgeHours). */
export const EVENT_DELEGATION_MAX_AGE_HOURS = 12

/**
 * Per-event delegations (playbooks whose delegation is `<class>=each`; POST /delegations { event: { id } }): the AI acts as
 * the person the business system's OWN event names — never a person the caller chooses. Opt-in per event type:
 *   hooks.eventDelegations = { '<event type>': { eligible(event, user, ctx) -> boolean, personOf?(event) -> employee id,
 *                                                maxAgeHours? } }
 * personOf defaults to event.payload.userId. The rule is checked when the token is issued AND on every use (findDelegation):
 * the event must still be of a delegable type and fresh, the person active and `eligible` (the person's own opt-in, e.g. a
 * setting "let the AI draft my monitoring"). Without the hook the kit answers 400 to the `event` key.
 *
 * createEventDelegationRules(rules, { store, employees, now, ctx }) -> { enabled, check(event, t) -> { user } | { error } }
 */
export function createEventDelegationRules(rules, { employees, now, ctx }) {
  const enabled = Boolean(rules && Object.keys(rules).length)
  async function check(event, t) {
    if (!event) return { error: new HttpError(404, 'event_not_found') }
    const rule = enabled && Object.hasOwn(rules, event.type) ? rules[event.type] : null
    if (!rule) return { error: new HttpError(422, 'event_not_delegable') }
    const maxAgeMs = (Number(rule.maxAgeHours) > 0 ? Number(rule.maxAgeHours) : EVENT_DELEGATION_MAX_AGE_HOURS) * 3_600_000
    if (!(new Date(event.createdAt).getTime() > now().getTime() - maxAgeMs)) return { error: new HttpError(409, 'event_stale') }
    const personId = rule.personOf ? rule.personOf(event) : event.payload?.userId
    // who it would have been is not told: only that this event grants no delegation now (not eligible, inactive, no person)
    const refused = { error: new HttpError(403, 'event_delegation_refused') }
    if ((typeof personId !== 'string' && typeof personId !== 'number') || String(personId) === '') return refused
    const c = ctx(t)
    const user = await employees.get(String(personId), c)
    if (!user || user.active === false) return refused
    if ((await rule.eligible(event, { ...user, id: String(user.id) }, c)) !== true) return refused
    return { user: { ...user, id: String(user.id) } }
  }
  return { enabled, check }
}

/** { id } of a per-event delegation request -> the positive integer id (400 otherwise). */
function eventIdOf(raw) {
  if (!isObject(raw)) fail(400, 'invalid_event')
  strictKeys(raw, ['id'])
  const id = typeof raw.id === 'string' && /^[1-9][0-9]{0,15}$/.test(raw.id) ? Number(raw.id) : raw.id
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'invalid_event')
  return id
}

export function registerDelegation(router, kit) {
  const { store } = kit

  async function mint({ userId, identityId = null, sessionId = null, ticketId = null, sourceEventId = null, notAfter = null }) {
    const token = newToken(TOKEN_PREFIX.delegation)
    const expiresAt = new Date(Math.min(kit.now().getTime() + DELEGATION_TTL_MS, notAfter ? new Date(notAfter).getTime() : Infinity))
    await store.insertDelegation({ tokenHash: sha256(token), userId, identityId, sessionId, ticketId, sourceEventId, expiresAt })
    return { token, expiresAt: iso(expiresAt) }
  }

  router.add('POST', '/bridge/v1/delegations', POLICY.SERVICE, async ({ body }) => {
    const b = body ?? {}
    // a userId / employee in the body is never trusted; { event } only when the business system declared event delegations
    strictKeys(b, kit.eventDelegations.enabled ? ['source', 'event'] : ['source'])
    if (b.event !== undefined) {
      if (b.source !== undefined) fail(400, 'source_or_event') // exactly one of them
      const id = eventIdOf(b.event)
      const event = await store.getEvent(id)
      const out = await kit.eventDelegations.check(event, store)
      if (out.error) {
        await store.audit({ actor: 'ai', action: 'delegation.refused', target: String(id), detail: { via: 'event', code: out.error.code } })
        throw out.error
      }
      const d = await mint({ userId: out.user.id, sourceEventId: event.id })
      await store.audit({ actor: 'ai', action: 'delegation.issued', target: out.user.id, detail: { via: 'event', eventId: event.id, eventType: event.type } })
      return { status: 201, body: { ok: true, token: d.token, user: userRef(out.user), expiresAt: d.expiresAt } }
    }
    const source = parseSource(b.source)
    const who = await identityOf(kit, source)
    if (!who) fail(404, 'identity_not_linked') // no token, no business data for an unlinked sender
    const d = await mint({ userId: who.id, identityId: who.identityId })
    await store.audit({ actor: 'ai', action: 'delegation.issued', target: who.id, detail: { via: 'im', platform: source.platform } })
    return { status: 201, body: { ok: true, token: d.token, user: userRef(who), expiresAt: d.expiresAt } }
  })

  router.add('POST', '/bridge/v1/assistant/tickets', POLICY.BFF, async ({ principal }) => {
    const me = principal.user
    if (!principal.sessionId) fail(403, 'session_required') // a ticket is bound to a web session
    const ticket = newToken(TOKEN_PREFIX.ticket)
    const expiresAt = new Date(kit.now().getTime() + TICKET_TTL_MS)
    await store.insertTicket({ tokenHash: sha256(ticket), userId: me.id, sessionId: principal.sessionId, expiresAt })
    return { status: 201, body: { ok: true, ticket, expiresAt: iso(expiresAt), user: userRef(me) } }
  })

  router.add('POST', '/bridge/v1/assistant/delegations', POLICY.SERVICE, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['ticket']) // there is no way to name another employee
    if (typeof b.ticket !== 'string' || b.ticket.length < 10 || b.ticket.length > 200) fail(400, 'invalid_ticket')
    const t = await store.findLiveTicket(sha256(b.ticket))
    if (!t) fail(401, 'invalid_assistant_ticket')
    const user = await kit.employees.get(t.userId, kit.ctx(store))
    if (!user || user.active === false) fail(401, 'invalid_assistant_ticket')
    if (kit.hooks.isSessionLive && !(await kit.hooks.isSessionLive(t.sessionId, kit.ctx(store)))) fail(401, 'invalid_assistant_ticket')
    const d = await mint({ userId: t.userId, sessionId: t.sessionId, ticketId: t.id, notAfter: t.expiresAt })
    await store.audit({ actor: 'ai', action: 'delegation.issued', target: t.userId, detail: { via: 'assistant' } })
    return { status: 201, body: { ok: true, token: d.token, user: userRef(user), expiresAt: d.expiresAt } }
  })
}
