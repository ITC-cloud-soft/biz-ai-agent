// The store contract: the same tests run against the memory store and the PostgreSQL store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { STORE_METHODS, StoreConflict } from '../src/index.mjs'

const soon = () => new Date(Date.now() + 60_000)
const past = () => new Date(Date.now() - 60_000)

export function storeContract(name, getStore) {
  const s = () => getStore()

  test(`${name}: implements every method of the interface`, () => {
    for (const m of STORE_METHODS) assert.equal(typeof s()[m], 'function', m)
    assert.equal(typeof s().tx, 'function')
  })

  test(`${name}: server key is stable`, async () => {
    const a = await s().getServerKey()
    assert.equal(a.length, 32)
    assert.deepEqual(await s().getServerKey(), a)
  })

  test(`${name}: throttles and audit`, async () => {
    const bucket = `b-${randomUUID()}`
    await s().addHit(bucket, 'k1')
    await s().addHit(bucket, 'k1')
    await s().addHit(bucket, 'k2')
    assert.equal(await s().countHits(bucket, 'k1', 10), 2)
    assert.equal(await s().countBucket(bucket, 10), 3)
    await s().pruneHits(24 * 60)
    assert.equal(await s().countBucket(bucket, 10), 3, 'recent hits are kept')
    const action = `a-${randomUUID()}`
    await s().audit({ actor: 'u', action, target: 't', detail: { n: 1 } })
    const rows = await s().listAudit({ action })
    assert.deepEqual([rows.length, rows[0].detail], [1, { n: 1 }])
  })

  test(`${name}: identities — one active link per account; unlink frees it`, async () => {
    const ext = `E-${randomUUID()}`
    const user = `u-${randomUUID()}`
    const a = await s().insertIdentity({ userId: user, platform: 'slack', teamId: 'T', externalId: ext })
    await assert.rejects(s().insertIdentity({ userId: 'other', platform: 'slack', teamId: 'T', externalId: ext }), StoreConflict)
    assert.equal((await s().findActiveIdentity({ platform: 'slack', teamId: 'T', externalId: ext })).id, a.id)
    assert.equal(await s().findActiveIdentity({ platform: 'slack', teamId: '', externalId: ext }), null)
    await s().insertIdentity({ userId: user, platform: 'line', externalId: `L-${ext}` })
    assert.deepEqual((await s().listIdentities(user)).map((i) => i.platform), ['slack', 'line'])
    assert.deepEqual((await s().listIdentities(user, { platforms: ['line'] })).map((i) => i.platform), ['line'])
    assert.ok((await s().listActiveIdentities()).some((i) => i.id === a.id))
    assert.equal(await s().unlinkIdentity(a.id), true)
    assert.equal(await s().unlinkIdentity(a.id), false)
    assert.ok((await s().getIdentity(a.id)).unlinkedAt)
    await s().insertIdentity({ userId: 'other', platform: 'slack', teamId: 'T', externalId: ext })
  })

  test(`${name}: link codes — live hash unique, used / revoked / expired`, async () => {
    const user = `u-${randomUUID()}`
    const hash = `h-${randomUUID()}`
    const c = await s().insertLinkCode({ userId: user, codeHash: hash, expiresAt: soon() })
    await assert.rejects(s().insertLinkCode({ userId: 'x', codeHash: hash, expiresAt: soon() }), StoreConflict)
    assert.equal((await s().findLiveLinkCode(hash)).id, c.id)
    await s().expireLinkCodes(user)
    assert.ok(new Date((await s().findLiveLinkCode(hash)).expiresAt) <= new Date())
    await s().markLinkCodeUsed(c.id)
    assert.equal(await s().findLiveLinkCode(hash), null)
    await s().insertLinkCode({ userId: user, codeHash: hash, expiresAt: soon() }) // the digits are free again
    await s().revokeLiveLinkCodes(user)
    assert.equal(await s().findLiveLinkCode(hash), null)
    const d = await s().insertLinkCode({ userId: user, codeHash: `${hash}-2`, expiresAt: soon() })
    await s().revokeLinkCode(d.id)
    assert.equal(await s().findLiveLinkCode(`${hash}-2`), null)
  })

  test(`${name}: personal bots, tickets, delegations`, async () => {
    const user = `u-${randomUUID()}`
    const bot = `bot-${randomUUID()}`
    await s().insertPersonalBot({ userId: user, platform: 'weixin', botId: bot })
    await assert.rejects(s().insertPersonalBot({ userId: 'x', platform: 'weixin', botId: bot }), StoreConflict)
    assert.equal((await s().listPersonalBots(user)).length, 1)
    assert.equal(await s().revokePersonalBot({ platform: 'weixin', botId: bot, userId: 'x' }), false, 'only the owner')
    assert.equal(await s().revokePersonalBot({ platform: 'weixin', botId: bot, userId: user }), true)
    assert.ok((await s().getPersonalBot('weixin', bot)).revokedAt)

    const tk = await s().insertTicket({ tokenHash: `t-${randomUUID()}`, userId: user, sessionId: 'sess-1', expiresAt: soon() })
    assert.equal((await s().findLiveTicket(tk.tokenHash)).id, tk.id)
    await s().revokeTicketsBySession('sess-1')
    assert.equal(await s().findLiveTicket(tk.tokenHash), null)
    assert.ok((await s().getTicket(tk.id)).revokedAt)
    const old = await s().insertTicket({ tokenHash: `t-${randomUUID()}`, userId: user, sessionId: 's2', expiresAt: past() })
    assert.equal(await s().findLiveTicket(old.tokenHash), null)

    const identity = await s().insertIdentity({ userId: user, platform: 'slack', externalId: `D-${randomUUID()}` })
    const d1 = await s().insertDelegation({ tokenHash: `d-${randomUUID()}`, userId: user, identityId: identity.id, expiresAt: soon() })
    const d2 = await s().insertDelegation({ tokenHash: `d-${randomUUID()}`, userId: user, sessionId: 'sess-9', expiresAt: soon() })
    assert.equal((await s().findLiveDelegation(d1.tokenHash)).identityId, identity.id)
    assert.equal((await s().findLiveDelegation(d2.tokenHash)).sessionId, 'sess-9')
    await s().expireDelegation(d2.tokenHash)
    assert.equal(await s().findLiveDelegation(d2.tokenHash), null)
    await s().revokeDelegationsByIdentity(identity.id)
    assert.equal(await s().findLiveDelegation(d1.tokenHash), null)
    const d3 = await s().insertDelegation({ tokenHash: `d-${randomUUID()}`, userId: user, expiresAt: soon() })
    // a per-event delegation records the event it was issued for
    const eventId = await s().tx((t) => t.insertEvent({ type: 'x.each', aggregateType: 'x', aggregateId: 1, payload: {} }))
    const d4 = await s().insertDelegation({ tokenHash: `d-${randomUUID()}`, userId: user, sourceEventId: eventId, expiresAt: soon() })
    assert.equal((await s().findLiveDelegation(d4.tokenHash)).sourceEventId, Number(eventId))
    assert.equal((await s().findLiveDelegation(d3.tokenHash)).sourceEventId, null)
    await s().revokeDelegationsByUser(user)
    assert.equal(await s().findLiveDelegation(d3.tokenHash), null)
    assert.equal(await s().findLiveDelegation(d4.tokenHash), null)
  })

  test(`${name}: events — increasing ids, cursor, rollback leaves nothing`, async () => {
    const start = await s().latestEventId()
    const a = await s().tx((t) => t.insertEvent({ type: 'x.y', aggregateType: 'x', aggregateId: 1, payload: { a: 1 } }))
    const b = await s().tx((t) => t.insertEvent({ type: 'x.z', aggregateType: 'x', aggregateId: '2', payload: {} }))
    assert.ok(b > a && a > start)
    await assert.rejects(s().tx(async (t) => { await t.insertEvent({ type: 'x.y', aggregateType: 'x', aggregateId: '3', payload: {} }); throw new Error('rollback') }), /rollback/)
    assert.equal(await s().latestEventId(), b)
    const page = await s().listEvents(start, 10)
    assert.deepEqual(page.map((e) => [e.id, e.type, e.aggregateId]), [[a, 'x.y', '1'], [b, 'x.z', '2']])
    assert.deepEqual((await s().getEvent(a)).payload, { a: 1 })
    assert.ok((await s().getEvent(a)).createdAt instanceof Date)
    assert.equal(await s().getEvent(999999999), null)
  })

  test(`${name}: preferences and notification deliveries`, async () => {
    const user = `u-${randomUUID()}`
    assert.equal(await s().getPrefs(user), null)
    await s().putPrefs(user, { types: { 'a.b': { im: false } }, quietHours: { enabled: true, start: '22:00', end: '07:00' } })
    await s().putPrefs(user, { types: { 'a.b': { im: true } }, quietHours: { enabled: false, start: '22:00', end: '07:00' } })
    const p = await s().getPrefs(user)
    assert.deepEqual([p.types, p.quietHours.enabled], [{ 'a.b': { im: true } }, false])
    const ev = await s().tx((t) => t.insertEvent({ type: 'a.b', aggregateType: 'a', aggregateId: '1', payload: {} }))
    assert.equal(await s().insertDeliveryIfAbsent({ eventId: ev, userId: user, channel: 'slack' }), true)
    assert.equal(await s().insertDeliveryIfAbsent({ eventId: ev, userId: user, channel: 'line' }), false)
    assert.equal((await s().getDelivery(ev, user)).status, 'pending')
    assert.equal(await s().updateDelivery(ev, user, { status: 'sent', messageRef: 'm' }), true)
    const d = await s().getDelivery(ev, user)
    assert.deepEqual([d.status, d.messageRef, d.channel], ['sent', 'm', 'slack'])
    assert.equal(await s().updateDelivery(ev, 'nobody', { status: 'sent' }), false)
  })

  test(`${name}: approval card deliveries — one live card per approver, wrong codes lock, revoke`, async () => {
    const approvalId = randomUUID()
    const user = `u-${randomUUID()}`
    const identity = await s().insertIdentity({ userId: user, platform: 'slack', externalId: `A-${randomUUID()}` })
    const id = randomUUID()
    const card = await s().insertApprovalDelivery({ id, approvalId, userId: user, identityId: identity.id, tokenHash: `c-${id}`, expiresAt: soon() })
    assert.equal(card.status, 'issued')
    await assert.rejects(s().insertApprovalDelivery({ id: randomUUID(), approvalId, userId: user, identityId: identity.id, tokenHash: `c-${randomUUID()}`, expiresAt: soon() }), StoreConflict)
    assert.equal((await s().findLiveApprovalDelivery(approvalId, user)).id, id)
    assert.equal((await s().findApprovalDeliveryByToken(approvalId, `c-${id}`)).id, id)
    assert.equal((await s().latestApprovalDeliveryFor(approvalId, user)).id, id)
    assert.equal((await s().markApprovalDeliverySent(id, approvalId, 'msg')).messageRef, 'msg')
    assert.equal(await s().markApprovalDeliverySent(id, randomUUID(), 'msg'), null)
    assert.deepEqual((await s().listIssuedApprovalDeliveriesOfUser(user)).map((d) => d.id), [id])
    for (let i = 1; i < 3; i += 1) assert.equal(await s().countWrongReplyCode(id, 3), 'issued')
    assert.equal(await s().countWrongReplyCode(id, 3), 'locked')
    assert.equal((await s().getApprovalDelivery(id)).wrongAttempts, 3)
    assert.equal(await s().countWrongReplyCode(id, 3), 'locked', 'stays locked')
    await s().revokeApprovalDeliveries({ approvalId })
    assert.equal((await s().getApprovalDelivery(id)).status, 'revoked')
    const id2 = randomUUID()
    await s().insertApprovalDelivery({ id: id2, approvalId, userId: user, identityId: identity.id, tokenHash: `c-${id2}`, expiresAt: soon() })
    await s().revokeApprovalDeliveries({ approvalId, exceptId: id2 })
    assert.equal((await s().getApprovalDelivery(id2)).status, 'issued')
    await s().setApprovalDeliveryStatus(id2, 'used')
    assert.equal(await s().findLiveApprovalDelivery(approvalId, user), null)
    const id3 = randomUUID()
    await s().insertApprovalDelivery({ id: id3, approvalId: randomUUID(), userId: user, identityId: identity.id, tokenHash: `c-${id3}`, expiresAt: soon() })
    await s().revokeApprovalDeliveriesByIdentity(identity.id)
    assert.equal((await s().getApprovalDelivery(id3)).status, 'revoked')
  })

  test(`${name}: reports — scheduled slots unique, test runs always stored`, async () => {
    const kind = `k_${randomUUID().slice(0, 8)}`
    const r = await s().insertReport({ kind, date: '2026-10-27', slot: '08:30', sections: { a: { n: 1 } }, attention: 2 })
    assert.deepEqual([r.date, r.slot, r.sections, r.attention, r.test], ['2026-10-27', '08:30', { a: { n: 1 } }, 2, false])
    assert.equal(await s().insertReport({ kind, date: '2026-10-27', slot: '08:30', sections: {} }), null)
    const t1 = await s().insertReport({ kind, date: '2026-10-27', slot: 'test', sections: {}, test: true, createdBy: 'u' })
    const t2 = await s().insertReport({ kind, date: '2026-10-27', slot: 'test', sections: {}, test: true, createdBy: 'u' })
    assert.ok(t1 && t2)
    assert.equal((await s().latestReport(kind)).id, t2.id)
    assert.equal(await s().latestReport('none'), null)
  })

  test(`${name}: proposals`, async () => {
    const user = `u-${randomUUID()}`
    const kind = `k_${randomUUID().slice(0, 8)}`
    const p = await s().insertProposal({ kind, payload: { a: 1 }, confidence: 0.5, forUserId: user, createdVia: 'delegation' })
    await s().insertProposal({ kind, payload: { a: 2 }, createdVia: 'service' })
    assert.deepEqual([p.status, p.confidence, p.forUserId], ['pending_review', 0.5, user])
    assert.equal((await s().listProposals({ kind })).length, 2)
    assert.deepEqual((await s().listProposals({ kind, forUserId: user })).map((x) => x.id), [p.id])
    const d = await s().decideProposal(p.id, { status: 'accepted', decidedBy: 'r', comment: null })
    assert.deepEqual([d.status, d.decidedBy], ['accepted', 'r'])
    assert.equal((await s().listProposals({ kind, status: 'accepted' })).length, 1)
    assert.equal((await s().getProposal(p.id)).status, 'accepted')
  })

  test(`${name}: the AI employee's profile — versions in order, current = the highest, list without the text`, async () => {
    const before = (await s().latestAiProfile())?.version ?? 0
    const a = await s().insertAiProfileVersion({ profile: { nickname: 'さくら' }, updatedBy: 'u1', reason: '初版' })
    const b = await s().insertAiProfileVersion({ profile: { nickname: 'はると', agents: { x: { nickname: 'あおい' } } }, updatedBy: 'u2' })
    assert.deepEqual([a.version, b.version], [before + 1, before + 2])
    assert.ok(b.createdAt instanceof Date)
    assert.deepEqual((await s().latestAiProfile()).profile, { nickname: 'はると', agents: { x: { nickname: 'あおい' } } })
    assert.deepEqual((await s().getAiProfileVersion(a.version)).profile, { nickname: 'さくら' })
    assert.equal(await s().getAiProfileVersion(before + 99), null)
    const list = await s().listAiProfileVersions({ limit: 2 })
    assert.deepEqual(list.map((v) => [v.version, v.updatedBy, v.reason]), [[b.version, 'u2', null], [a.version, 'u1', '初版']])
    assert.ok(list.every((v) => !('profile' in v)), 'the list carries no text')
  })

  test(`${name}: attachment settings of the AI assistant panel — one row, replaced on put`, async () => {
    const a = await s().putAttachmentSettings({ roles: ['admin'], types: ['image', 'pdf'], updatedBy: 'u1' })
    assert.deepEqual([a.roles, a.types, a.updatedBy], [['admin'], ['image', 'pdf'], 'u1'])
    assert.ok(a.updatedAt)
    await s().putAttachmentSettings({ roles: ['admin', 'billing'], types: [], updatedBy: 'u2' })
    const got = await s().getAttachmentSettings()
    assert.deepEqual([got.roles, got.types, got.updatedBy], [['admin', 'billing'], [], 'u2'])
  })

  test(`${name}: external connectors — definitions, the sealed secret kept on update, rules, runs newest first, state`, async () => {
    const id = `c-${randomUUID().slice(0, 8)}`
    const def = { id, name: '架空の接続先', operations: [{ id: 'op' }] }
    const a = await s().putConnector({ connector: def, updatedBy: 'u1' })
    assert.deepEqual([a.id, a.hasSecret, a.secretHint, a.updatedBy], [id, false, null, 'u1'])
    assert.equal(await s().setConnectorSecret(id, { sealed: 'v1.x.y.z', hint: '…abcd', updatedBy: 'u1' }), true)
    assert.equal(await s().setConnectorSecret('nope-x', { sealed: 'v1', hint: '…' }), false)
    await s().putConnector({ connector: { ...def, name: '変更' }, updatedBy: 'u2' })
    const got = await s().getConnector(id)
    assert.deepEqual([got.connector.name, got.hasSecret, got.secretHint, got.updatedBy], ['変更', true, '…abcd', 'u2'], 'the secret survives an update')
    assert.deepEqual(await s().getConnectorSecret(id), { sealed: 'v1.x.y.z', hint: '…abcd' })
    assert.ok((await s().listConnectors()).some((c) => c.id === id && !('sealed' in c)), 'the list carries no sealed value')
    await s().setConnectorSecret(id, { sealed: null, updatedBy: 'u2' })
    assert.equal(await s().getConnectorSecret(id), null)

    const rule = { id: `r-${id}`, name: '規則', action: { connector: id, operation: 'op' } }
    await s().putConnectorRule({ rule, updatedBy: 'u1' })
    await s().putConnectorRule({ rule: { ...rule, name: '規則 2' }, updatedBy: 'u2' })
    assert.equal((await s().getConnectorRule(rule.id)).rule.name, '規則 2')
    assert.equal((await s().listConnectorRules()).filter((r) => r.id === rule.id).length, 1)

    const r1 = await s().insertConnectorRun({ ruleId: rule.id, connectorId: id, operationId: 'op', trigger: { kind: 'event', eventId: 7 }, status: 'succeeded', httpStatus: 200, durationMs: 12 })
    const r2 = await s().insertConnectorRun({ connectorId: id, operationId: 'op', trigger: { kind: 'ai' }, actor: 'u1', status: 'failed', code: 'timeout' })
    const runs = await s().listConnectorRuns({ connectorId: id })
    assert.deepEqual(runs.map((r) => [r.id, r.status, r.triggerKind, r.triggerRef, r.code]), [[r2.id, 'failed', 'ai', null, 'timeout'], [r1.id, 'succeeded', 'event', '7', null]])
    assert.equal((await s().listConnectorRuns({ ruleId: rule.id })).length, 1)

    const st0 = await s().getConnectorState()
    assert.equal(typeof st0.stopped, 'boolean')
    const st = await s().putConnectorState({ stopped: true, stoppedBy: 'u1', stoppedAt: new Date(), eventCursor: 12 })
    assert.deepEqual([st.stopped, st.stoppedBy, st.eventCursor], [true, 'u1', 12])
    await s().putConnectorState({ stopped: false, cronMinute: '2026-10-30T09:00' })
    const st2 = await s().getConnectorState()
    assert.deepEqual([st2.stopped, st2.eventCursor, st2.cronMinute], [false, 12, '2026-10-30T09:00'])
    await s().putConnectorState({ eventCursor: st0.eventCursor })

    assert.equal(await s().deleteConnectorRule(rule.id), true)
    assert.equal(await s().deleteConnector(id), true)
    assert.equal(await s().deleteConnector(id), false)
    assert.equal(await s().getConnector(id), null)
  })

  test(`${name}: a transaction rolls back every write`, async () => {
    const user = `u-${randomUUID()}`
    await assert.rejects(s().tx(async (t) => {
      await t.insertIdentity({ userId: user, platform: 'slack', externalId: `R-${user}` })
      await t.putPrefs(user, { types: {}, quietHours: {} })
      throw new Error('boom')
    }), /boom/)
    assert.deepEqual(await s().listIdentities(user), [])
    assert.equal(await s().getPrefs(user), null)
  })
}
