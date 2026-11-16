// A: IM approval (invariants 3, 4, 5): cards carry no personal data, tokens are bound to one employee and one approval,
// only a person decides (as themselves), a decision revokes every other card, wrong reply codes lock the card.
import assert from 'node:assert/strict'
import { scanJson } from '../../src/pii.mjs'

const REQ = { requires: ['hook:createPendingApproval', 'capability:approvals'] }

export function register(s) {
  /** A pending approval, an eligible approver linked on a fresh source, and the cards issued to the approvers. */
  async function setup(c) {
    const pending = await c.fx.hooks.createPendingApproval()
    const approver = await c.fx.newEmployee(pending.approverRole)
    const { source } = await c.linkEmployee(approver)
    const res = await c.api.post(c.v1(`/approvals/${pending.approvalId}/deliveries`), c.as.service(), { platforms: [c.fx.platform] })
    c.ok(res, 200, 'create deliveries')
    const mine = res.body.deliveries.find((d) => d.user.id === approver.id)
    assert.ok(mine, 'the eligible approver gets a card')
    return { pending, approver, source, res, mine }
  }
  const decide = (c, approvalId, body) => c.api.post(c.v1(`/approvals/${approvalId}/im-decision`), c.as.service(), body)

  s.check('A1', 'approval cards: service-only, one card per eligible approver, tokens and codes shaped, no personal data in the card, idempotent', async (c) => {
    const { pending, approver, res, mine } = await setup(c)
    c.shape('createApprovalDeliveries', 200, res)
    const path = c.v1(`/approvals/${pending.approvalId}/deliveries`)
    c.err(await c.api.post(path, c.as.anon(), { platforms: [c.fx.platform] }), 401, null, 'anonymous')
    c.err(await c.api.post(path, c.as.user(approver), { platforms: [c.fx.platform] }), 403, null, 'the approver themselves')
    const probes = await c.fx.probes()
    for (const d of res.body.deliveries) {
      assert.match(d.replyCode, /^\d{6}$/)
      assert.ok(d.token.length >= 10)
      assert.equal(d.identity.platform, c.fx.platform, 'only the requested platform')
      const found = scanJson(d.card, { probes, allow: ['cjk_text', 'free_text'] })
      assert.deepEqual(found, [], `the card must not contain personal data: ${JSON.stringify(found)}`)
      assert.ok(!JSON.stringify(d.card).includes(d.token), 'the one-time token must not be written into the card text')
    }
    const again = await c.api.post(path, c.as.service(), { platforms: [c.fx.platform] })
    c.ok(again, 200)
    const same = again.body.deliveries.find((d) => d.user.id === approver.id)
    assert.equal(same.token, mine.token, 'repeating the call returns the same token (idempotent for sendCard)')
    assert.equal(same.replyCode, mine.replyCode)
    c.err(await c.api.post(c.v1(`/approvals/${c.uuid()}/deliveries`), c.as.service(), { platforms: [c.fx.platform] }), 404, ['approval_not_found'], 'unknown approval')
    c.err(await c.api.post(path, c.as.service(), {}), 400, null, 'platforms are required')
    // secrets never travel in events
    const cursor = await c.latestEventCursor()
    const page = await c.api.get(c.v1('/events'), c.as.service(), { after: Math.max(0, cursor - 400), limit: 500 })
    assert.ok(!page.text.includes(mine.token) && !page.text.includes(`"${mine.replyCode}"`), 'card tokens / reply codes must not appear in events')
  }, REQ)

  s.check('A2', 'IM decisions: unlinked source, wrong employee, delegation and employee sessions are refused; the right person decides once; every other card dies', async (c) => {
    const { pending, approver, source, res, mine } = await setup(c)
    const id = pending.approvalId
    const body = { token: mine.token, action: 'approve', source }
    c.err(await decide(c, id, { ...body, source: c.newSource() }), 404, ['identity_not_linked'], 'unlinked source')
    const stranger = await c.fx.newEmployee('staff')
    const strangerLink = await c.linkEmployee(stranger)
    c.err(await decide(c, id, { ...body, source: strangerLink.source }), [403, 404], ['identity_mismatch', 'delivery_not_found'], 'another employee\'s source with the approver\'s token')
    const d = await c.linkedDelegation('manager')
    c.err(await c.api.post(c.v1(`/approvals/${id}/im-decision`), c.as.delegated(d.token), body), 403, ['delegation_not_permitted'], 'delegation token')
    c.err(await c.api.post(c.v1(`/approvals/${id}/im-decision`), c.as.user(approver), body), 403, null, 'employee session')
    c.err(await c.api.post(c.v1(`/approvals/${id}/im-decision`), c.as.anon(), body), 401, null, 'anonymous')
    c.err(await decide(c, id, { ...body, replyCode: mine.replyCode }), 400, ['token_or_reply_code_required'], 'token and reply code together')
    c.err(await decide(c, id, { action: 'approve', source }), 400, null, 'neither token nor reply code')
    c.err(await decide(c, id, { ...body, action: 'maybe' }), 400, null, 'unknown action')
    c.err(await decide(c, id, { ...body, userId: c.fx.employees.admin.id }), 400, null, 'a userId in the body is never trusted')

    const ok = await decide(c, id, body)
    c.ok(ok, 200, 'the approver decides')
    c.shape('imDecision', 200, ok)
    assert.equal(ok.body.deliveryId, mine.deliveryId)
    const second = await decide(c, id, body)
    c.err(second, [409, 410], null, 'the same token again')
    // every other card of the approval is dead as well
    for (const other of res.body.deliveries.filter((x) => x.deliveryId !== mine.deliveryId)) {
      const otherSource = { platform: other.identity.platform, teamId: other.identity.teamId, userId: other.identity.externalId }
      c.err(await decide(c, id, { token: other.token, action: 'approve', source: otherSource }), [409, 410], null, 'a card of the same approval after the decision')
    }
  }, REQ)

  s.check('A3', 'wrong reply codes are counted and lock the card (429); a locked card is never re-issued and the right code no longer works', async (c) => {
    const { pending, approver, source, mine } = await setup(c)
    const id = pending.approvalId
    const wrong = mine.replyCode === '000000' ? '111111' : '000000'
    let lockedAt = -1
    for (let i = 0; i < 8; i += 1) {
      const r = await decide(c, id, { replyCode: wrong, action: 'approve', source })
      if (r.status === 429) { c.err(r, 429, ['delivery_locked', 'too_many_attempts']); lockedAt = i; break }
      c.err(r, 403, ['invalid_reply_code'], `wrong code #${i + 1}`)
    }
    assert.ok(lockedAt >= 0, 'no lock-out after 8 wrong reply codes')
    c.err(await decide(c, id, { replyCode: mine.replyCode, action: 'approve', source }), 429, ['delivery_locked', 'too_many_attempts'], 'the right code after the lock')
    const re = await c.api.post(c.v1(`/approvals/${id}/deliveries`), c.as.service(), { platforms: [c.fx.platform] })
    c.ok(re, 200)
    assert.ok(!re.body.deliveries.some((d) => d.user.id === approver.id), 'a locked approver gets no fresh card (no fresh guesses)')
  }, REQ)

  s.check('A4', 'a person can decide by reply code alone (no approval id): the approval is found among their own cards', async (c) => {
    const { pending, source, mine } = await setup(c)
    const r = await c.api.post(c.v1('/approvals/im-decisions'), c.as.service(), { replyCode: mine.replyCode, action: 'approve', source })
    c.ok(r, 200, 'decision by reply code')
    c.shape('imDecisionByReplyCode', 200, r)
    assert.equal(r.body.deliveryId, mine.deliveryId)
    c.err(await c.api.post(c.v1('/approvals/im-decisions'), c.as.service(), { token: mine.token, action: 'approve', source }), 400, null, 'token is not accepted without an approval id')
    void pending
  }, REQ)
}
