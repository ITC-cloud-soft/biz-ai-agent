// End-to-end tests of createBridgeApp over HTTP: a fictional business ("toy tasks", test/toy.mjs) on the memory store.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { cardReplyCode, fail } from '../src/index.mjs'
import { BFF_SECRET, client, createToy, SERVICE_TOKEN } from './toy.mjs'

let toy
let call
const S = { 'x-service-token': SERVICE_TOKEN }
const D = (token) => ({ ...S, 'x-delegation-token': token })
let seq = 0
const uid = () => `U${process.pid}-${(seq += 1)}`

async function link(emp, platform = 'slack', extra = {}) {
  const code = await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })
  assert.equal(code.status, 201, code.text)
  const source = { platform, teamId: 'T1', userId: uid(), ...extra }
  const r = await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: code.body.code, source } })
  assert.equal(r.status, 200, r.text)
  return source
}
async function delegation(source) {
  const r = await call('POST', '/bridge/v1/delegations', { headers: S, body: { source } })
  assert.equal(r.status, 201, r.text)
  return r.body.token
}

before(async () => {
  toy = await (await createToy()).start()
  call = client(toy.base)
})
after(async () => { await toy?.stop() })

describe('protocol basics', () => {
  test('health is public; every response (errors, 404, 405) carries bridge-protocol: 1 and the error envelope', async () => {
    const h = await call('GET', '/bridge/v1/health')
    assert.deepEqual(h.body, { ok: true, protocol: 1, service: 'toy-tasks', version: '1.0.0' })
    const nf = await call('GET', '/bridge/v1/nope', { headers: S })
    assert.deepEqual([nf.status, nf.body, nf.headers.get('bridge-protocol')], [404, { ok: false, error: 'not_found' }, '1'])
    const na = await call('DELETE', '/bridge/v1/health')
    assert.equal(na.status, 405)
    assert.match(na.headers.get('allow'), /GET/)
    assert.equal((await call('GET', '/bridge/v1/events')).body.error, 'authentication_required')
    assert.equal((await call('GET', '/bridge/v1/events', { headers: { 'x-service-token': 'wrong' } })).body.error, 'invalid_service_token')
    const bad = await call('POST', '/bridge/v1/identities/link', { headers: S, raw: '[1]' })
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_json'])
  })

  test('manifest: service only, strong etag, If-None-Match (weak too) -> 304 with the header', async () => {
    const r = await call('GET', '/bridge/v1/manifest', { headers: S })
    assert.equal(r.status, 200)
    assert.equal(r.body.system.id, 'toy-tasks')
    const etag = r.headers.get('etag')
    assert.match(etag, /^"[0-9a-f]{32}"$/)
    const again = await call('GET', '/bridge/v1/manifest', { headers: { ...S, 'if-none-match': `W/${etag}` } })
    assert.deepEqual([again.status, again.headers.get('bridge-protocol')], [304, '1'])
    const u = toy.addUser('admin')
    assert.equal((await call('GET', '/bridge/v1/manifest', { headers: u.headers })).body.error, 'insufficient_role', 'a person is not the service')
  })

  test('pii-scan returns categories only', async () => {
    const r = await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text: '連絡先 090-1234-5678 / test@example.com' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.containsPersonalData, true)
    assert.ok(!JSON.stringify(r.body).includes('5678'))
    assert.equal((await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text: 'TASK-001 overdue 3 days' } })).body.containsPersonalData, false)
    // plain sentences are not personal data by themselves (bridge-memory saves preferences like these)
    for (const text of ['結論を先に3行で書いてほしい', 'Prefer short answers']) {
      const p = await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text } })
      assert.deepEqual([p.status, p.body.containsPersonalData, p.body.kinds], [200, false, []], text)
    }
  })
})

describe('identity and link codes', () => {
  test('issue -> link -> lookup -> my links -> unlink (delegations end, sns_identity.unlinked emitted)', async () => {
    const emp = toy.addUser('staff')
    const source = await link(emp)
    const who = await call('GET', '/bridge/v1/identity', { headers: S, query: { platform: 'slack', teamId: 'T1', userId: source.userId } })
    assert.deepEqual(who.body, { ok: true, linked: true, orgId: 'toy-org', user: { id: emp.id, role: 'staff', displayName: null } })
    const unknown = await call('GET', '/bridge/v1/identity', { headers: S, query: { platform: 'slack', userId: 'nobody' } })
    assert.deepEqual(unknown.body, { ok: true, linked: false, orgId: 'toy-org' })
    const token = await delegation(source)
    assert.equal((await call('GET', '/api/tasks', { headers: D(token) })).status, 200)

    const mine = await call('GET', '/bridge/v1/me/identities', { headers: emp.headers })
    assert.equal(mine.body.identities.length, 1)
    const row = mine.body.identities[0]
    assert.equal(row.externalId, source.userId)
    const other = toy.addUser('admin')
    assert.equal((await call('DELETE', `/bridge/v1/me/identities/${row.id}`, { headers: other.headers })).status, 404, 'someone else (admin too): not found')
    const before = await toy.store.latestEventId()
    const del = await call('DELETE', `/bridge/v1/me/identities/${row.id}`, { headers: emp.headers })
    assert.equal(del.status, 200)
    const events = await toy.store.listEvents(before, 10)
    assert.deepEqual(events.map((e) => e.type), ['sns_identity.unlinked'])
    assert.equal((await call('GET', '/api/tasks', { headers: D(token) })).body.error, 'invalid_delegation_token', 'the delegation died with the link')
  })

  test('a code is single use, a new code revokes the old one, an expired code is burnt, 5 failures per source -> 429', async () => {
    const emp = toy.addUser('staff')
    const first = (await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })).body.code
    const second = (await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })).body.code
    const src = { platform: 'line', userId: uid() }
    if (first !== second) assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: first, source: src } })).body.error, 'link_code_invalid')
    assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: second, source: src } })).status, 200)
    assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: second, source: { platform: 'line', userId: uid() } } })).body.error, 'link_code_invalid')

    const emp2 = toy.addUser('staff')
    const third = (await call('POST', '/bridge/v1/me/link-codes', { headers: emp2.headers })).body.code
    await toy.store.expireLinkCodes(emp2.id)
    assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: third, source: { platform: 'line', userId: uid() } } })).body.error, 'link_code_expired')

    const attacker = { platform: 'line', userId: uid() }
    for (let i = 0; i < 5; i += 1) await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: '000000', source: attacker } })
    assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: '000000', source: attacker } })).body.error, 'too_many_attempts')
    assert.equal((await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: '123456', source: attacker, userId: 'x' } })).body.error, 'unknown_field')
  })

  test('stats are counts only; a deactivated employee is not linked any more', async () => {
    const emp = toy.addUser('staff')
    const source = await link(emp, 'teams')
    const stats = await call('GET', '/bridge/v1/identities/stats', { headers: S })
    assert.ok(stats.body.byPlatform.teams >= 1)
    toy.users.get(emp.id).active = false
    assert.equal((await call('GET', '/bridge/v1/identity', { headers: S, query: { platform: 'teams', teamId: 'T1', userId: source.userId } })).body.linked, false)
    assert.equal((await call('POST', '/bridge/v1/delegations', { headers: S, body: { source } })).body.error, 'identity_not_linked')
  })

  test('personal bots: registration is BFF only (refusal audited); the owner rule protects the bot', async () => {
    const owner = toy.addUser('staff')
    const other = toy.addUser('staff')
    const body = { platform: 'weixin', botId: `wx-${uid()}@im.bot` }
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: owner.headers, body })).body.error, 'bff_only')
    assert.ok((await toy.store.listAudit({ action: 'bff_only.refused' })).length >= 1)
    const bff = { ...owner.headers, 'x-bff-secret': BFF_SECRET }
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: bff, body })).status, 201)
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: bff, body })).status, 200, 'idempotent for the owner')
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: { ...other.headers, 'x-bff-secret': BFF_SECRET }, body })).body.error, 'bot_already_registered')
    // someone else's code through my personal bot is burnt
    const code = (await call('POST', '/bridge/v1/me/link-codes', { headers: other.headers })).body.code
    const r = await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code, source: { platform: 'weixin', userId: uid(), botId: body.botId } } })
    assert.equal(r.body.error, 'personal_bot_owner_mismatch')
    const own = await link(owner, 'weixin', { botId: body.botId })
    const mine = await call('GET', '/bridge/v1/me/identities', { headers: owner.headers })
    const row = mine.body.identities.find((i) => i.externalId === own.userId)
    assert.equal(row.method, 'personal_bot')
    const del = await call('DELETE', `/bridge/v1/me/identities/${row.id}`, { headers: owner.headers })
    assert.equal(del.body.personalBotRevoked, true)
    assert.deepEqual((await call('GET', '/bridge/v1/me/personal-bots', { headers: owner.headers })).body.bots, [])
  })
})

describe('delegations and the web assistant', () => {
  test('delegation = manifest read tools ∩ role; writes refused; a ticket dies with the web session', async () => {
    const staff = toy.addUser('staff')
    const manager = toy.addUser('manager')
    const dStaff = await delegation(await link(staff))
    const dMgr = await delegation(await link(manager))
    assert.equal((await call('GET', '/api/tasks', { headers: D(dStaff) })).status, 200)
    assert.equal((await call('GET', '/api/tasks/overdue', { headers: D(dStaff) })).body.error, 'delegation_not_permitted')
    assert.equal((await call('GET', '/api/tasks/overdue', { headers: D(dMgr) })).status, 200)
    assert.equal((await call('POST', '/api/tasks', { headers: D(dMgr), body: {} })).body.error, 'delegation_not_permitted')
    assert.equal((await call('GET', '/api/tasks', { headers: { 'x-delegation-token': dMgr } })).body.error, 'service_token_required')
    await toy.store.expireDelegation((await import('../src/crypto.mjs')).sha256(dMgr))
    assert.equal((await call('GET', '/api/tasks', { headers: D(dMgr) })).body.error, 'invalid_delegation_token')

    assert.equal((await call('POST', '/bridge/v1/assistant/tickets', { headers: staff.headers })).body.error, 'bff_only')
    const ticket = await call('POST', '/bridge/v1/assistant/tickets', { headers: { ...staff.headers, 'x-bff-secret': BFF_SECRET } })
    assert.equal(ticket.status, 201)
    const d = await call('POST', '/bridge/v1/assistant/delegations', { headers: S, body: { ticket: ticket.body.ticket } })
    assert.equal(d.status, 201, d.text)
    assert.ok(new Date(d.body.expiresAt) <= new Date(ticket.body.expiresAt))
    assert.equal((await call('GET', '/api/tasks', { headers: D(d.body.token) })).status, 200)
    for (const s of toy.sessions.values()) if (s.sessionId === staff.sessionId) s.revoked = true
    assert.equal((await call('GET', '/api/tasks', { headers: D(d.body.token) })).body.error, 'invalid_delegation_token')
    assert.equal((await call('POST', '/bridge/v1/assistant/delegations', { headers: S, body: { ticket: ticket.body.ticket } })).body.error, 'invalid_assistant_ticket')
  })
})

describe('events and notifications', () => {
  test('cursor paging; recipients resolved by the hook; own preference; terminal deliveries; stale', async () => {
    const staff = toy.addUser('staff')
    const manager = toy.addUser('manager')
    const sSrc = await link(staff, 'slack')
    await link(manager, 'line')
    const task = await toy.addTask({ ownerUserId: staff.id, dueInDays: -2 })
    const start = await toy.store.latestEventId()
    const eventId = await toy.markOverdue(task)
    const page = await call('GET', '/bridge/v1/events', { headers: S, query: { after: start, limit: 1 } })
    assert.deepEqual(page.body.events.map((e) => e.id), [eventId])
    assert.equal(page.body.nextAfter, eventId)
    assert.equal((await call('GET', '/bridge/v1/events', { headers: S, query: { limit: 501 } })).body.error, 'invalid_limit')

    const r = await call('GET', `/bridge/v1/notifications/for-event/${eventId}`, { headers: S, query: { platforms: 'slack,line' } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.dedupeKey, `task.overdue:${task.id}:${task.dueOn}`)
    const forStaff = r.body.recipients.find((x) => x.userId === staff.id)
    assert.deepEqual(forStaff.identity, { platform: 'slack', teamId: 'T1', externalId: sSrc.userId })
    assert.equal(forStaff.template, 'task.overdue')
    assert.ok(r.body.recipients.some((x) => x.userId === manager.id && x.identity.platform === 'line'))

    const sent = await call('POST', '/bridge/v1/notifications/deliveries', { headers: S, body: { userId: staff.id, eventIds: [eventId, 999999], status: 'sent', messageRef: 'm1' } })
    assert.deepEqual(sent.body, { ok: true, updated: 1, unchanged: 0, unknown: [999999] })
    const again = await call('POST', '/bridge/v1/notifications/deliveries', { headers: S, body: { userId: staff.id, eventIds: [eventId], status: 'failed' } })
    assert.equal(again.body.unchanged, 1, 'sent is terminal')
    const second = await call('GET', `/bridge/v1/notifications/for-event/${eventId}`, { headers: S })
    assert.ok(second.body.alreadyNotified >= 1)
    assert.ok(!second.body.recipients.some((x) => x.userId === staff.id))

    // the manager switches the type off: not a recipient any more
    const put = await call('PUT', '/bridge/v1/me/notification-preferences', { headers: manager.headers, body: { types: { 'task.overdue': { im: false } }, quietHours: { enabled: true, start: '21:00' } } })
    assert.equal(put.status, 200, put.text)
    assert.equal(put.body.preferences.quietHours.start, '21:00')
    const third = await call('GET', `/bridge/v1/notifications/for-event/${eventId}`, { headers: S })
    assert.ok(!third.body.recipients.some((x) => x.userId === manager.id))
    assert.equal((await call('PUT', '/bridge/v1/me/notification-preferences', { headers: manager.headers, body: { userId: staff.id, types: {} } })).body.error, 'unknown_field')
    assert.equal((await call('PUT', '/bridge/v1/me/notification-preferences', { headers: manager.headers, body: { types: { 'task.done': { im: true } } } })).body.error, 'invalid_types')

    task.done = true
    const stale = await call('GET', `/bridge/v1/notifications/for-event/${eventId}`, { headers: S })
    assert.deepEqual([stale.body.stale, stale.body.recipients], ['done', []])
    const internal = await toy.kit.tx((t) => toy.kit.emitEvent(t, { type: 'task.done', aggregateType: 'task', aggregateId: task.id, payload: { taskId: task.id, doneOn: '2026-10-27' } }))
    assert.equal((await call('GET', `/bridge/v1/notifications/for-event/${internal}`, { headers: S })).body.supported, false)
    assert.equal((await call('GET', '/bridge/v1/notifications/for-event/99999999', { headers: S })).body.error, 'event_not_found')
  })

  test('quiet hours travel to the IM side with the manifest time zone', async () => {
    const staff = toy.addUser('staff')
    await link(staff)
    await call('PUT', '/bridge/v1/me/notification-preferences', { headers: staff.headers, body: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } })
    const task = await toy.addTask({ ownerUserId: staff.id, dueInDays: -1 })
    const r = await call('GET', `/bridge/v1/notifications/for-event/${await toy.markOverdue(task)}`, { headers: S })
    assert.deepEqual(r.body.recipients.find((x) => x.userId === staff.id).quietHours, { start: '22:00', end: '07:00', timeZone: 'Asia/Tokyo' })
  })
})

describe('approvals', () => {
  test('cards for eligible approvers only; idempotent; reply code decides; other cards revoked; locked after 5 wrong codes', async () => {
    const requester = toy.addUser('staff')
    const m1 = toy.addUser('manager')
    const m2 = toy.addUser('manager')
    await link(requester, 'slack')
    const s1 = await link(m1, 'slack')
    const s2 = await link(m2, 'slack')
    const a = await toy.requestApproval(requester)
    const cards = await call('POST', `/bridge/v1/approvals/${a.id}/deliveries`, { headers: S, body: { platforms: ['slack'] } })
    assert.equal(cards.status, 200, cards.text)
    assert.ok(!cards.body.deliveries.some((d) => d.user.id === requester.id), 'never the requester')
    const c1 = cards.body.deliveries.find((d) => d.user.id === m1.id)
    const c2 = cards.body.deliveries.find((d) => d.user.id === m2.id)
    assert.ok(c1 && c2)
    assert.equal(c1.replyCode, cardReplyCode(toy.kit.serverKey, c1.deliveryId))
    const repeat = await call('POST', `/bridge/v1/approvals/${a.id}/deliveries`, { headers: S, body: { platform: 'slack' } })
    assert.deepEqual(repeat.body.deliveries.find((d) => d.user.id === m1.id).token, c1.token, 'same token again')
    assert.ok(repeat.body.deliveries.every((d) => d.reused))
    assert.equal((await call('POST', `/bridge/v1/approvals/${a.id}/deliveries/${c1.deliveryId}/sent`, { headers: S, body: { messageRef: 'ts-1' } })).status, 200)

    // m2's token used by m1: identity mismatch
    const mismatch = await call('POST', `/bridge/v1/approvals/${a.id}/im-decision`, { headers: S, body: { token: c2.token, action: 'approve', source: s1 } })
    assert.equal(mismatch.body.error, 'identity_mismatch')
    assert.equal((await call('POST', `/bridge/v1/approvals/${a.id}/im-decision`, { headers: S, body: { token: c1.token, action: 'reject', source: s1 } })).body.error, 'comment_required')
    const wrong = c1.replyCode === '000000' ? '000001' : '000000'
    assert.equal((await call('POST', '/bridge/v1/approvals/im-decisions', { headers: S, body: { replyCode: wrong, action: 'approve', source: s1 } })).body.error, 'invalid_reply_code')
    const ok = await call('POST', '/bridge/v1/approvals/im-decisions', { headers: S, body: { replyCode: c1.replyCode, action: 'approve', source: s1 } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.body.approval.status, 'approved')
    assert.equal(toy.approvals.get(a.id).status, 'approved')
    const late = await call('POST', `/bridge/v1/approvals/${a.id}/im-decision`, { headers: S, body: { token: c2.token, action: 'approve', source: s2 } })
    assert.equal(late.body.error, 'delivery_revoked')
    assert.equal((await call('POST', `/bridge/v1/approvals/${a.id}/deliveries`, { headers: S, body: { platforms: ['slack'] } })).body.error, 'already_approved')

    // lock
    const b = await toy.requestApproval(requester)
    const cardsB = await call('POST', `/bridge/v1/approvals/${b.id}/deliveries`, { headers: S, body: { platforms: ['slack'] } })
    const mine = cardsB.body.deliveries.find((d) => d.user.id === m2.id)
    const bad = mine.replyCode === '111111' ? '222222' : '111111'
    let last
    for (let i = 0; i < 5; i += 1) last = await call('POST', `/bridge/v1/approvals/${b.id}/im-decision`, { headers: S, body: { replyCode: bad, action: 'approve', source: s2 } })
    assert.deepEqual([last.status, last.body.error], [429, 'delivery_locked'])
    assert.equal((await call('POST', `/bridge/v1/approvals/${b.id}/im-decision`, { headers: S, body: { replyCode: mine.replyCode, action: 'approve', source: s2 } })).body.error, 'delivery_locked')
    const reissue = await call('POST', `/bridge/v1/approvals/${b.id}/deliveries`, { headers: S, body: { platforms: ['slack'] } })
    assert.ok(!reissue.body.deliveries.some((d) => d.user.id === m2.id), 'a locked card is never re-issued')
    assert.equal((await call('POST', '/bridge/v1/approvals/x/deliveries', { headers: S, body: { platforms: ['slack'] } })).body.error, 'approval_not_found')
  })
})

describe('proposals and reports', () => {
  test('a delegation proposes within its role; a reviewer accepts; apply runs only then', async () => {
    const staff = toy.addUser('staff')
    const manager = toy.addUser('manager')
    const task = await toy.addTask({ ownerUserId: staff.id })
    const token = await delegation(await link(staff))
    const p = await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'task_reschedule', payload: { taskId: task.id, dueOn: '2030-01-01' }, confidence: 0.7 } })
    assert.equal(p.status, 201, p.text)
    assert.equal(p.body.proposal.forUserId, staff.id)
    assert.equal((await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'task_delete', payload: { taskId: task.id } } })).body.error, 'role_not_permitted')
    assert.equal((await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'nope', payload: {} } })).body.error, 'unknown_kind')
    assert.equal((await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'task_reschedule', payload: { taskId: 'missing', dueOn: 'x' } } })).body.error, 'task_not_found')
    const own = await call('GET', '/bridge/v1/proposals', { headers: D(token) })
    assert.deepEqual(own.body.proposals.map((x) => x.id), [p.body.proposal.id])
    assert.equal((await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: staff.headers })).body.error, 'insufficient_role')
    assert.notEqual(task.dueOn, '2030-01-01')
    const ok = await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: manager.headers })
    assert.equal(ok.body.proposal.status, 'accepted')
    assert.equal(task.dueOn, '2030-01-01')
    assert.equal((await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/reject`, { headers: manager.headers, body: { comment: 'x' } })).body.error, 'already_accepted')
  })

  test('reports: a delegation gets a live snapshot scoped to its role; an admin run is stored; scheduled slots are unique', async () => {
    const staff = toy.addUser('staff')
    const admin = toy.addUser('admin')
    await toy.addTask({ ownerUserId: staff.id, dueInDays: -3 })
    const token = await delegation(await link(staff))
    const live = await call('GET', '/bridge/v1/reports/latest', { headers: D(token) })
    assert.equal(live.status, 200, live.text)
    assert.deepEqual(Object.keys(live.body.report.sections), ['overdue'])
    assert.equal(live.body.report.sections.overdue.count, 1)
    assert.equal((await call('GET', '/bridge/v1/reports/latest', { headers: staff.headers })).body.error, 'insufficient_role')
    const run = await call('POST', '/bridge/v1/reports/run', { headers: admin.headers, body: { to: 'me' } })
    assert.equal(run.status, 201, run.text)
    assert.deepEqual(Object.keys(run.body.report.sections).sort(), ['overdue', 'tasks'])
    assert.equal((await call('GET', '/bridge/v1/reports/latest', { headers: admin.headers })).body.report.id, run.body.report.id)
    assert.ok(await toy.kit.reports.generate({ slot: '09:00' }))
    assert.equal(await toy.kit.reports.generate({ slot: '09:00' }), null)
  })
})

describe('mounting', () => {
  test('middleware: unknown paths go to next(); handler: 404', async () => {
    const { bridge } = toy
    let nexted = false
    const res = { headersSent: false, writeHead() {}, end() {} }
    await new Promise((resolve) => { bridge.middleware({ method: 'GET', url: '/elsewhere', headers: {} }, res, () => { nexted = true; resolve() }) })
    assert.equal(nexted, true)
    assert.equal((await call('GET', '/api/public')).body.public, true)
  })
})

describe('pii-scan hook', () => {
  test('hooks.piiScan adds the roster check (names); a failing hook is 503 so callers keep nothing', async () => {
    const roster = ['青柳', 'Aoyagi']
    const t = await (await createToy({ piiScan: () => async (text) => ({ kinds: roster.some((n) => text.includes(n)) ? ['staff_name', 'BAD KIND'] : [] }) })).start()
    try {
      const scan = (text) => client(t.base)('POST', '/bridge/v1/pii-scan', { headers: { 'x-service-token': SERVICE_TOKEN }, body: { text } })
      const hit = await scan('青柳さんは朝が早い')
      assert.deepEqual([hit.status, hit.body.containsPersonalData, hit.body.kinds], [200, true, ['staff_name']])
      assert.equal((await scan('朝の訪問を先に確認する')).body.containsPersonalData, false)
    } finally { await t.stop() }
    const broken = await (await createToy({ piiScan: () => async () => { throw new Error('roster down') } })).start()
    try {
      const r = await client(broken.base)('POST', '/bridge/v1/pii-scan', { headers: { 'x-service-token': SERVICE_TOKEN }, body: { text: 'ok' } })
      assert.deepEqual([r.status, r.body.error], [503, 'pii_scan_failed'])
    } finally { await broken.stop() }
  })
})

describe('document reads (hooks.documentReads)', () => {
  const S2 = { 'x-service-token': SERVICE_TOKEN }
  const ID = '11111111-2222-4333-8444-555555555555'
  test('claim hands out reads (shape checked, limit 1..5); answer passes { pages } or { error }; 404 without the hook (after the gate)', async () => {
    const answers = []
    const hook = {
      async claim({ limit }) { return { reads: [{ id: ID, purpose: 'inbox', hint: '様式', pages: [{ page: 1, mediaType: 'image/png', data: 'AAAA' }] }].slice(0, limit) } },
      async answer(readId, body) { if (readId !== ID) fail(404, 'read_not_found'); answers.push(body) },
    }
    const t = await (await createToy({ documentReads: hook })).start()
    try {
      const call2 = client(t.base)
      const r = await call2('GET', '/bridge/v1/document-reads', { headers: S2, query: { limit: 1 } })
      assert.deepEqual([r.status, r.body.reads.length, r.body.reads[0].pages[0].mediaType], [200, 1, 'image/png'])
      assert.equal((await call2('GET', '/bridge/v1/document-reads', { headers: S2, query: { limit: 9 } })).body.error, 'invalid_limit')
      assert.equal((await call2('POST', `/bridge/v1/document-reads/${ID}/result`, { headers: S2, body: { pages: [{ page: 1, text: '書き写し' }] } })).status, 200)
      assert.equal((await call2('POST', `/bridge/v1/document-reads/${ID}/result`, { headers: S2, body: { error: 'model_failed' } })).status, 200)
      assert.deepEqual(answers, [{ pages: [{ page: 1, text: '書き写し' }] }, { error: 'model_failed' }])
      assert.equal((await call2('POST', `/bridge/v1/document-reads/${ID}/result`, { headers: S2, body: { error: 'nope' } })).body.error, 'invalid_error')
      assert.equal((await call2('POST', `/bridge/v1/document-reads/${ID}/result`, { headers: S2, body: { pages: [{ page: 1, text: 'x', extra: 1 }] } })).status, 400)
      assert.equal((await call2('POST', '/bridge/v1/document-reads/22222222-2222-4333-8444-555555555555/result', { headers: S2, body: { error: 'too_large' } })).body.error, 'read_not_found')
      assert.equal((await call2('GET', '/bridge/v1/document-reads')).status, 401, 'service only')
    } finally { await t.stop() }
    // the shared toy has no hook: the gate first, then 404
    assert.equal((await call('GET', '/bridge/v1/document-reads')).status, 401)
    assert.deepEqual([(await call('GET', '/bridge/v1/document-reads', { headers: S })).status], [404])
  })
})
