// Principals and the access gate.
//
//   service    x-service-token (DSH, the AI plane). Never a person.
//   delegated  x-service-token + x-delegation-token: the AI acting as ONE employee (allow-list intersected with the role).
//   user       the employee's own web / device session — authenticated by the business system (hooks.authenticate).
//   anon       nothing valid.
//
// Each route declares a policy { allow: [...kinds], roles?, delegatedRoles?, bff?, public? }. The gate runs BEFORE any
// resource lookup, so a refusal never discloses whether the resource exists.
import { safeEqual, sha256 } from './crypto.mjs'
import { fail, header } from './http.mjs'

export const POLICY = Object.freeze({
  PUBLIC: Object.freeze({ public: true }),
  SERVICE: Object.freeze({ allow: ['service'] }),
  USER: Object.freeze({ allow: ['user'] }),
  BFF: Object.freeze({ allow: ['user'], bff: true }),
})

/** A business read endpoint the AI may call through a delegation iff `delegatedRoles` (from the manifest tools) has the role. */
export const readToolPolicy = (allowlist, endpoint, roles) => ({ allow: ['user', 'delegated'], roles, delegatedRoles: allowlist[endpoint] ?? [] })

/** The employee reference that travels to the AI plane: never a name. */
export const userRef = (u) => ({ id: String(u.id), role: u.role, displayName: null })

/**
 * createPrincipalResolver({ store, serviceToken, employees, authenticate, isSessionLive, eventDelegationHolds })
 *   employees.get(id, ctx) -> { id, role, active } | null
 *   authenticate(req) -> { user: { id, role }, sessionId } | null      (the business system's own sessions)
 *   isSessionLive(sessionId, ctx) -> boolean                           (delegations of the web assistant die with the session)
 *   eventDelegationHolds(eventId, user, t) -> boolean                  (a per-event delegation lives only while its event's rule holds;
 *                                                                       absent = per-event delegations are never valid)
 */
export function createPrincipalResolver({ store, serviceToken, employees, authenticate, isSessionLive, eventDelegationHolds }) {
  if (!serviceToken) throw new TypeError('serviceToken is required')

  /** A delegation is valid only while its employee is active and its link / web session / ticket / triggering event are still live. */
  async function findDelegation(token, db = store) {
    const d = await db.findLiveDelegation(sha256(token))
    if (!d) return null
    const user = await employees.get(d.userId, { db: db.db ?? null, t: db })
    if (!user || user.active === false) return null
    if (d.identityId) {
      const identity = await db.getIdentity(d.identityId)
      if (!identity || identity.unlinkedAt) return null
    }
    if (d.ticketId) {
      const ticket = await db.getTicket(d.ticketId)
      if (!ticket || ticket.revokedAt) return null
    }
    if (d.sessionId && isSessionLive && !(await isSessionLive(d.sessionId, { db: db.db ?? null, t: db }))) return null
    if (d.sourceEventId && !(eventDelegationHolds && (await eventDelegationHolds(d.sourceEventId, user, db)))) return null
    return { ...d, user: { id: String(user.id), role: user.role, active: true } }
  }

  async function resolvePrincipal(req) {
    const service = header(req, 'x-service-token')
    const delegation = header(req, 'x-delegation-token')
    if (delegation !== undefined) {
      if (service === undefined) fail(401, 'service_token_required')
      if (!safeEqual(service, serviceToken)) fail(401, 'invalid_service_token')
      const d = await findDelegation(delegation)
      if (!d) fail(401, 'invalid_delegation_token')
      return { kind: 'delegated', user: d.user, delegation: d }
    }
    if (service !== undefined) {
      if (!safeEqual(service, serviceToken)) fail(401, 'invalid_service_token')
      return { kind: 'service' }
    }
    const session = authenticate ? await authenticate(req) : null
    if (session?.user) {
      return { kind: 'user', user: { ...session.user, id: String(session.user.id), active: true }, sessionId: session.sessionId === undefined ? null : String(session.sessionId) }
    }
    return { kind: 'anon' }
  }

  return { resolvePrincipal, findDelegation }
}

/** The access gate (see the header comment). bffSecret: the business web BFF's x-bff-secret. */
export function gate(principal, policy, req, { bffSecret } = {}) {
  if (policy.public) return
  if (principal.kind === 'anon') fail(401, 'authentication_required')
  if (!policy.allow?.includes(principal.kind)) {
    if (principal.kind === 'delegated') fail(403, 'delegation_not_permitted')
    if (principal.kind === 'service') fail(403, 'human_required')
    fail(403, 'insufficient_role')
  }
  if (principal.kind === 'user' && policy.roles && !policy.roles.includes(principal.user.role)) fail(403, 'insufficient_role')
  if (principal.kind === 'delegated' && policy.delegatedRoles && !policy.delegatedRoles.includes(principal.user.role)) fail(403, 'delegation_not_permitted')
  if (policy.bff && principal.kind === 'user') {
    if (!bffSecret) fail(503, 'bff_secret_not_configured')
    if (!safeEqual(header(req, 'x-bff-secret') ?? '', bffSecret)) fail(403, 'bff_only')
  }
}
