// The business rules of equipment-loans through its own API and the Bridge (no database: the memory store).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { loanDays } from '../src/app.mjs'
import { S, day, startWithPeople } from './helpers.mjs'

let env
const call = (...a) => env.call(...a)
const borrow = (person, itemTag, startsOn, dueOn) => call('POST', '/api/loans', { headers: person.web, body: { itemId: env.items[itemTag].id, startsOn, dueOn } })
const events = async () => (await call('GET', '/bridge/v1/events?after=0', { headers: S })).body.events
/** Making time pass: the loan's days moved into the past (the only thing no API does on purpose). */
const backdate = (loanId, startsAgo, dueAgo) => Object.assign(env.srv.app.data.loans.get(loanId), { startsOn: day(-startsAgo), dueOn: day(-dueAgo) })

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

test('a short loan of a standard item is booked at once: no approval, no approval event', async () => {
  const before = (await events()).length
  const r = await borrow(env.people.staff1, 'LAP-001', day(1), day(3))
  assert.equal(r.status, 201)
  assert.equal(r.body.loan.status, 'approved')
  assert.deepEqual(r.body.loan.approvalReasons, [])
  assert.equal(r.body.approval, null)
  assert.equal((await events()).length, before, 'nothing to tell anyone')
})

test('a high-value item needs a manager: approval.requested; the borrower cannot approve, a manager can, once', async () => {
  const r = await borrow(env.people.staff1, 'CAM-001', day(2), day(3))
  assert.equal(r.status, 201)
  assert.equal(r.body.loan.status, 'pending')
  assert.deepEqual(r.body.loan.approvalReasons, ['high_value'])
  const a = r.body.approval.id
  assert.ok((await events()).some((e) => e.type === 'approval.requested' && e.payload.approvalId === a && e.payload.requiredRole === 'manager'))
  assert.equal((await call('POST', `/api/approvals/${a}/decision`, { headers: env.people.staff1.web, body: { action: 'approve' } })).status, 403, 'staff never decide')
  const ok = await call('POST', `/api/approvals/${a}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.approval.status, 'approved')
  assert.equal((await call('POST', `/api/approvals/${a}/decision`, { headers: env.people.admin.web, body: { action: 'reject' } })).status, 409, 'once')
  assert.equal(env.srv.app.data.loans.get(r.body.loan.id).status, 'approved')
  const decided = (await events()).find((e) => e.type === 'approval.decided' && e.payload.approvalId === a)
  assert.equal(decided.payload.decidedByUserId, env.people.manager.id)
})

test('longer than 7 days (first day to due date, both counted) needs approval; exactly 7 days does not', async () => {
  assert.equal(loanDays(day(1), day(7)), 7)
  const seven = await borrow(env.people.staff2, 'LAP-002', day(1), day(7))
  assert.equal(seven.body.loan.status, 'approved')
  const eight = await borrow(env.people.staff2, 'PRJ-001', day(10), day(17))
  assert.equal(eight.status, 201)
  assert.deepEqual(eight.body.loan.approvalReasons, ['longer_than_7_days'])
  assert.equal(eight.body.loan.status, 'pending')
  const both = await borrow(env.people.staff2, 'LAP-900', day(20), day(29))
  assert.deepEqual(both.body.loan.approvalReasons, ['high_value', 'longer_than_7_days'])
  const rejected = await call('POST', `/api/approvals/${eight.body.approval.id}/decision`, { headers: env.people.admin.web, body: { action: 'reject' } })
  assert.equal(rejected.body.approval.status, 'rejected')
  assert.equal(env.srv.app.data.loans.get(eight.body.loan.id).status, 'rejected')
})

test('never the borrower\'s own approval: a manager who borrows is decided by another manager or an administrator', async () => {
  const r = await borrow(env.people.manager, 'LAP-900', day(40), day(41))
  const a = env.srv.app.data.approvals.get(r.body.approval.id)
  const approvers = (await env.srv.app.kit.hooks.approvals.approvers(a)).map((u) => u.id).sort()
  assert.deepEqual(approvers, [env.people.admin.id, env.people.manager2.id].sort(), 'admin and the other manager, not the borrower, not staff')
  assert.equal(await env.srv.app.kit.hooks.approvals.mayDecide(a, { id: env.people.manager.id, role: 'manager', active: true }), false, 'the chat card uses the same rule')
  assert.equal((await call('POST', `/api/approvals/${a.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 403)
  assert.equal((await call('POST', `/api/approvals/${a.id}/decision`, { headers: env.people.manager2.web, body: { action: 'approve' } })).status, 200)
  const card = await env.srv.app.kit.hooks.approvals.card(a)
  assert.doesNotMatch(JSON.stringify(card), /Test manager|password|displayName/, 'the card carries IDs, kinds and dates only')
})

test('one booking per item and day; dates in the past, too long or unknown items are refused; staff see their own loans only', async () => {
  const first = await borrow(env.people.staff1, 'LAP-002', day(50), day(52))
  assert.equal(first.status, 201)
  assert.equal((await borrow(env.people.staff2, 'LAP-002', day(52), day(53))).body.error, 'item_unavailable')
  assert.equal((await borrow(env.people.staff2, 'LAP-002', day(-1), day(1))).body.error, 'invalid_dates')
  assert.equal((await borrow(env.people.staff2, 'LAP-002', day(60), day(90))).body.error, 'loan_too_long')
  assert.equal((await call('POST', '/api/loans', { headers: env.people.staff2.web, body: { itemId: '00000000-0000-4000-8000-000000000000', startsOn: day(1), dueOn: day(1) } })).status, 404)
  const mine = await call('GET', '/api/loans', { headers: env.people.staff2.web })
  assert.ok(mine.body.loans.length >= 1)
  assert.ok(mine.body.loans.every((l) => l.borrowerUserId === env.people.staff2.id))
  const all = await call('GET', '/api/loans', { headers: env.people.manager.web })
  assert.ok(all.body.loans.some((l) => l.borrowerUserId === env.people.staff1.id) && all.body.loans.some((l) => l.borrowerUserId === env.people.staff2.id))
  assert.equal((await call('POST', '/api/admin/equipment', { headers: env.people.staff1.web, body: { assetTag: 'CAM-002', kind: 'camera', highValue: true } })).status, 403)
  const catalog = await call('GET', '/api/equipment?kind=camera', { headers: env.people.staff1.web })
  assert.deepEqual(catalog.body.items.map((i) => [i.assetTag, i.highValue]), [['CAM-001', true]])
})

test('an overdue loan is followed up once: the borrower and the managers are told, with numbers and dates only', async () => {
  const r = await borrow(env.people.staff1, 'PRJ-001', day(70), day(71))
  backdate(r.body.loan.id, 5, 2)
  const scan = await call('POST', '/api/admin/overdue-scan', { headers: env.people.manager.web, body: {} })
  const hit = scan.body.created.find((x) => x.loanId === r.body.loan.id)
  assert.ok(hit)
  assert.equal((await call('POST', '/api/admin/overdue-scan', { headers: env.people.manager.web, body: {} })).body.created.length, 0, 'once per loan')
  const event = (await events()).find((e) => String(e.id) === String(hit.eventId))
  assert.deepEqual(Object.keys(event.payload).sort(), ['borrowerUserId', 'daysOverdue', 'dueOn', 'itemId', 'loanId'])
  assert.equal(event.payload.daysOverdue, 2)
  const who = await env.srv.app.kit.hooks.recipientsFor(event)
  assert.deepEqual(who.users.map((u) => u.id).sort(), [env.people.admin.id, env.people.manager.id, env.people.manager2.id, env.people.staff1.id].sort(), 'borrower + managers, not the other staff')
  for (const u of who.users) assert.deepEqual(Object.keys(who.paramsFor(u)).sort(), ['count', 'daysOverdue', 'dueOn'])
  assert.equal(who.link, `/loans/${r.body.loan.id}`)
  const overdue = await call('GET', '/api/loans/overdue', { headers: env.people.manager.web })
  assert.ok(overdue.body.loans.some((l) => l.id === r.body.loan.id && l.daysOverdue === 2))
  assert.equal((await call('GET', '/api/loans/overdue', { headers: env.people.staff1.web })).status, 403, 'the overdue list is for managers')
  assert.equal((await call('POST', '/api/admin/overdue-scan', { headers: env.people.staff1.web, body: {} })).status, 403, 'staff cannot run the scan')

  // returned since: the notification is stale; another staff member cannot return it; the item is free again
  assert.equal((await call('POST', `/api/loans/${r.body.loan.id}/return`, { headers: env.people.staff2.web, body: {} })).status, 404)
  const back = await call('POST', `/api/loans/${r.body.loan.id}/return`, { headers: env.people.staff1.web, body: {} })
  assert.equal(back.body.loan.status, 'returned')
  assert.deepEqual(await env.srv.app.kit.hooks.recipientsFor(event), { stale: 'returned' })
  assert.equal((await call('POST', `/api/loans/${r.body.loan.id}/return`, { headers: env.people.staff1.web, body: {} })).status, 409)
})

test('proposals: the AI proposes new dates for a waiting loan (staff: their own only); cancelling is for managers', async () => {
  const pending = await borrow(env.people.staff1, 'CAM-001', day(80), day(81))
  const other = await borrow(env.people.staff2, 'LAP-900', day(80), day(81))
  const propose = async (person, kind, payload) => call('POST', '/bridge/v1/proposals', { headers: await env.delegated(person), body: { kind, payload } })
  const ok = await propose(env.people.staff1, 'loan_new_dates', { loanId: pending.body.loan.id, startsOn: day(82), dueOn: day(83) })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.proposal.status, 'pending_review')
  assert.equal((await propose(env.people.staff1, 'loan_new_dates', { loanId: other.body.loan.id, startsOn: day(82), dueOn: day(83) })).status, 422, 'not someone else\'s loan')
  assert.equal((await propose(env.people.staff1, 'loan_cancel', { loanId: pending.body.loan.id })).status, 403)
  // a person accepts: only then the dates change, and the loan still waits for its approval
  const accepted = await call('POST', `/bridge/v1/proposals/${ok.body.proposal.id}/accept`, { headers: env.people.manager.web, body: {} })
  assert.equal(accepted.status, 200)
  const l = env.srv.app.data.loans.get(pending.body.loan.id)
  assert.deepEqual([l.startsOn, l.dueOn, l.status], [day(82), day(83), 'pending'])
  // every write is people only: a delegation never reaches a business write endpoint
  assert.equal((await call('POST', '/api/loans', { headers: await env.delegated(env.people.manager), body: { itemId: env.items['LAP-001'].id, startsOn: day(85), dueOn: day(85) } })).status, 403)
})

test('the daily report counts by role: staff see their own loans only', async () => {
  const staff = await env.srv.app.kit.hooks.reports.compute({ id: env.people.staff2.id, role: 'staff' })
  const all = await env.srv.app.kit.hooks.reports.compute({ id: env.people.manager.id, role: 'manager' })
  assert.deepEqual(Object.keys(all.sections).sort(), ['due_soon', 'overdue', 'pending_approval'])
  assert.ok(staff.sections.pending_approval.count < all.sections.pending_approval.count)
})
