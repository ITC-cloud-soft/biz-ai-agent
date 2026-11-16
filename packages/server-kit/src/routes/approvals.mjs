// IM approval cards and decisions. A card token / reply code is bound to ONE employee and ONE approval; only that person
// decides, as themselves, with the same rule as the web UI (hooks.approvals.mayDecide); wrong reply codes lock the card.
// The approval itself belongs to the business (hooks.approvals); the kit keeps the card deliveries.
import { randomUUID } from 'node:crypto'
import { cardReplyCode, cardToken, safeEqual, sha256 } from '../crypto.mjs'
import { POLICY } from '../gate.mjs'
import { fail, HttpError, iso, parseSource, PLATFORM_RE, strictKeys } from '../http.mjs'
import { identityOf } from './identity.mjs'

export const MAX_WRONG_REPLY_CODES = 5

export function registerApprovals(router, kit) {
  const { store } = kit
  const hooks = kit.hooks.approvals
  if (!hooks) return
  const stateOf = (a) => (hooks.state ? hooks.state(a) : a.status)
  const idOk = (id) => (kit.config.approvalIdPattern ?? /^[A-Za-z0-9_-]{1,64}$/).test(id)

  const deliveryJson = (d, identity, card, reused) => ({
    deliveryId: d.id,
    user: { id: d.userId, displayName: null },
    identity: { platform: identity.platform, ...(identity.teamId ? { teamId: identity.teamId } : {}), externalId: identity.externalId, ...(identity.botId ? { botId: identity.botId } : {}) },
    token: cardToken(kit.serverKey, d.id),
    replyCode: cardReplyCode(kit.serverKey, d.id),
    expiresAt: iso(d.expiresAt),
    reused,
    card,
  })

  router.add('POST', '/bridge/v1/approvals/:approvalId/deliveries', POLICY.SERVICE, async ({ params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['platforms', 'platform'])
    if (b.platforms === undefined && b.platform === undefined) fail(400, 'platforms_required')
    if (b.platforms !== undefined && (!Array.isArray(b.platforms) || !b.platforms.length || b.platforms.length > 10
      || new Set(b.platforms).size !== b.platforms.length || b.platforms.some((p) => typeof p !== 'string' || !PLATFORM_RE.test(p)))) fail(400, 'invalid_platforms')
    if (b.platform !== undefined && (typeof b.platform !== 'string' || !PLATFORM_RE.test(b.platform))) fail(400, 'invalid_platform')
    const platforms = b.platforms ?? [b.platform]
    if (!idOk(params.approvalId)) fail(404, 'approval_not_found')

    return store.tx(async (t) => {
      const ctx = kit.ctx(t, { lock: true })
      const approval = await hooks.get(params.approvalId, ctx)
      if (!approval) fail(404, 'approval_not_found')
      if (stateOf(approval) !== 'pending') fail(409, `already_${stateOf(approval)}`)
      if (new Date(approval.expiresAt) <= kit.now()) fail(410, 'expired')
      const card = await hooks.card(approval, ctx)
      const approvers = await hooks.approvers(approval, ctx)
      const deliveries = []
      for (const u of approvers) {
        const userId = String(u.id)
        if (userId === String(approval.requestedBy)) continue // never the requester (segregation of duties)
        const existing = await t.findLiveApprovalDelivery(approval.id, userId)
        if (existing) {
          // idempotent: the same token / code again. A locked card is never re-issued (no fresh guesses).
          const identity = await t.getIdentity(existing.identityId)
          if (existing.status === 'issued' && identity && platforms.includes(identity.platform)) deliveries.push(deliveryJson(existing, identity, card, true))
          continue
        }
        const ids = await t.listIdentities(userId, { platforms })
        const identity = platforms.map((p) => ids.find((r) => r.platform === p)).find(Boolean)
        if (!identity) continue
        const id = randomUUID()
        const row = await t.insertApprovalDelivery({ id, approvalId: approval.id, userId, identityId: identity.id, tokenHash: sha256(cardToken(kit.serverKey, id)), expiresAt: approval.expiresAt })
        deliveries.push(deliveryJson(row, identity, card, false))
      }
      return { status: 200, body: { ok: true, deliveries } }
    })
  })

  router.add('POST', '/bridge/v1/approvals/:approvalId/deliveries/:deliveryId/sent', POLICY.SERVICE, async ({ params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['messageRef'])
    if (typeof b.messageRef !== 'string' || !b.messageRef.length || b.messageRef.length > 300) fail(400, 'invalid_message_ref')
    if (!idOk(params.approvalId) || !/^[0-9a-f-]{36}$/i.test(params.deliveryId)) fail(404, 'delivery_not_found')
    const row = await store.markApprovalDeliverySent(params.deliveryId, params.approvalId, b.messageRef)
    if (!row) fail(404, 'delivery_not_found')
    return { status: 200, body: { ok: true, delivery: { id: row.id, status: row.status, sentAt: iso(row.sentAt) } } }
  })

  /** Validates an IM decision body. byReplyCodeOnly: the approval is found from the reply code (token not accepted). */
  function parseDecision(body, { byReplyCodeOnly }) {
    const b = body ?? {}
    strictKeys(b, ['token', 'replyCode', 'action', 'comment', 'source', 'channelMessageId'])
    if (!['approve', 'reject'].includes(b.action)) fail(400, 'invalid_action')
    const source = parseSource(b.source)
    if (byReplyCodeOnly && b.token !== undefined) fail(400, 'token_not_accepted')
    if ((b.token === undefined) === (b.replyCode === undefined)) fail(400, 'token_or_reply_code_required')
    if (b.token !== undefined && (typeof b.token !== 'string' || !b.token.length || b.token.length > 200)) fail(400, 'invalid_token')
    if (b.replyCode !== undefined && (typeof b.replyCode !== 'string' || !/^\d{6}$/.test(b.replyCode))) fail(400, 'invalid_reply_code_format')
    if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 1000)) fail(400, 'invalid_comment')
    if (b.channelMessageId !== undefined && (typeof b.channelMessageId !== 'string' || b.channelMessageId.length > 200)) fail(400, 'invalid_channel_message_id')
    if (b.action === 'reject' && !b.comment?.trim()) fail(400, 'comment_required')
    return { ...b, source }
  }

  /**
   * Shared decision path: the employee behind the source IS the card's employee. Returns { result } or { error } (errors
   * whose side effects - counted wrong codes, a lock - must be committed with the transaction).
   */
  async function decideWithDelivery(t, { approval, delivery, who, input }) {
    if (delivery.userId !== who.id) return { error: new HttpError(403, 'identity_mismatch') }
    if (delivery.status === 'locked') return { error: new HttpError(429, 'delivery_locked') }
    if (delivery.status === 'used') return { error: new HttpError(409, 'delivery_used') }
    if (delivery.status === 'revoked') return { error: new HttpError(409, 'delivery_revoked') }
    if (input.replyCode !== undefined && !safeEqual(input.replyCode, cardReplyCode(kit.serverKey, delivery.id))) {
      const locked = (await t.countWrongReplyCode(delivery.id, MAX_WRONG_REPLY_CODES)) === 'locked'
      await t.addHit('reply_code_failure', who.id)
      return { error: locked ? new HttpError(429, 'delivery_locked') : new HttpError(403, 'invalid_reply_code') }
    }
    if (stateOf(approval) !== 'pending') return { error: new HttpError(409, `already_${stateOf(approval)}`) }
    if (new Date(approval.expiresAt) <= kit.now()) return { error: new HttpError(410, 'expired') }
    const ctx = kit.ctx(t, { lock: true })
    const user = await kit.employees.get(who.id, ctx)
    if (!user || user.active === false || !(await hooks.mayDecide(approval, { ...user, id: String(user.id) }, ctx))) return { error: new HttpError(403, 'role_not_permitted') } // same rule as the web UI
    await t.setApprovalDeliveryStatus(delivery.id, 'used')
    const decided = await hooks.decide(approval, { action: input.action, actor: { ...user, id: String(user.id) }, channel: 'im', comment: input.comment ?? null, deliveryId: delivery.id }, ctx)
    await t.revokeApprovalDeliveries({ approvalId: approval.id, exceptId: delivery.id }) // every other card of the approval
    return { result: { ok: true, approval: decided, deliveryId: delivery.id } }
  }

  const finish = (out) => {
    if (out.error) throw out.error
    return { status: 200, body: out.result }
  }

  router.add('POST', '/bridge/v1/approvals/:approvalId/im-decision', POLICY.SERVICE, async ({ params, body }) => {
    const input = parseDecision(body, { byReplyCodeOnly: false })
    if (!idOk(params.approvalId)) fail(404, 'approval_not_found')
    const who = await identityOf(kit, input.source)
    if (!who) fail(404, 'identity_not_linked')
    return finish(await store.tx(async (t) => {
      const approval = await hooks.get(params.approvalId, kit.ctx(t, { lock: true }))
      if (!approval) return { error: new HttpError(404, 'approval_not_found') }
      const delivery = input.token !== undefined
        ? await t.findApprovalDeliveryByToken(approval.id, sha256(input.token))
        : await t.latestApprovalDeliveryFor(approval.id, who.id)
      if (!delivery) return { error: new HttpError(404, 'delivery_not_found') }
      return decideWithDelivery(t, { approval, delivery, who, input })
    }))
  })

  router.add('POST', '/bridge/v1/approvals/im-decisions', POLICY.SERVICE, async ({ body }) => {
    const input = parseDecision(body, { byReplyCodeOnly: true })
    const who = await identityOf(kit, input.source)
    if (!who) fail(404, 'identity_not_linked')
    return finish(await store.tx(async (t) => {
      // the employee's own live cards whose approval is still pending (lock order everywhere: approval, then delivery)
      const issued = await t.listIssuedApprovalDeliveriesOfUser(who.id)
      const live = []
      for (const d of issued) {
        const a = await hooks.get(d.approvalId, kit.ctx(t))
        if (a && stateOf(a) === 'pending' && new Date(a.expiresAt) > kit.now()) live.push(d)
      }
      if (!live.length) return { error: new HttpError(404, 'delivery_not_found') }
      const match = live.filter((d) => safeEqual(input.replyCode, cardReplyCode(kit.serverKey, d.id)))
      if (match.length > 1) return { error: new HttpError(409, 'ambiguous_reply_code') } // decide with the card button instead
      if (!match.length) {
        // a wrong code counts against every live card of this employee
        const statuses = []
        for (const d of live) statuses.push(await t.countWrongReplyCode(d.id, MAX_WRONG_REPLY_CODES))
        await t.addHit('reply_code_failure', who.id)
        return { error: statuses.every((st) => st === 'locked') ? new HttpError(429, 'delivery_locked') : new HttpError(403, 'invalid_reply_code') }
      }
      const approval = await hooks.get(match[0].approvalId, kit.ctx(t, { lock: true }))
      const delivery = await t.getApprovalDelivery(match[0].id)
      return decideWithDelivery(t, { approval, delivery, who, input })
    }))
  })
}
