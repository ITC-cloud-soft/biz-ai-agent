// The business rules of leave-requests through its own API and the Bridge (no database: the memory store).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, todayIn } from '@dsh-bridge/server-kit'
import { startServer } from '../src/app.mjs'

const SERVICE = 'leave-test-service-token-0000000000'
const S = { 'x-service-token': SERVICE }
let srv, base
const people = {}

const call = async (method, path, { headers = {}, body } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}
const day = (n) => addDays(todayIn('UTC'), n)

before(async () => {
  srv = await startServer({ serviceToken: SERVICE, bffSecret: 'leave-test-bff-secret-00000000000000' })
  base = srv.base
  for (const [loginId, role] of [['admin', 'admin'], ['manager', 'manager'], ['staff1', 'staff'], ['staff2', 'staff']]) {
    const u = await srv.app.createUser({ loginId, password: 'password-1234', role, displayName: `Test ${loginId}` })
    const r = await call('POST', '/api/auth/login', { body: { loginId, password: 'password-1234' } })
    people[loginId] = { id: u.id, headers: { cookie: r.headers.get('set-cookie').split(';')[0] } }
  }
})
after(() => srv?.stop())

test('a request creates one approval (approval.requested); the requester cannot approve it, a manager can, once', async () => {
  const r = await call('POST', '/api/leave-requests', { headers: people.staff1.headers, body: { startsOn: day(5), endsOn: day(6) } })
  assert.equal(r.status, 201)
  assert.equal(r.body.approval.status, 'pending')
  const events = await call('GET', '/bridge/v1/events?after=0', { headers: S })
  assert.ok(events.body.events.some((e) => e.type === 'approval.requested' && e.payload.approvalId === r.body.approval.id))
  assert.equal((await call('POST', `/api/approvals/${r.body.approval.id}/decision`, { headers: people.staff1.headers, body: { action: 'approve' } })).status, 403)
  const ok = await call('POST', `/api/approvals/${r.body.approval.id}/decision`, { headers: people.manager.headers, body: { action: 'approve' } })
  assert.equal(ok.body.approval.status, 'approved')
  assert.equal((await call('POST', `/api/approvals/${r.body.approval.id}/decision`, { headers: people.admin.headers, body: { action: 'reject' } })).status, 409)
  assert.equal(srv.app.data.leave.get(r.body.leaveRequest.id).status, 'approved')
})

test('staff see their own requests only; dates in the past are refused', async () => {
  await call('POST', '/api/leave-requests', { headers: people.staff2.headers, body: { startsOn: day(8), endsOn: day(8) } })
  const mine = await call('GET', '/api/leave-requests', { headers: people.staff2.headers })
  assert.ok(mine.body.leaveRequests.length >= 1)
  assert.ok(mine.body.leaveRequests.every((l) => l.requesterUserId === people.staff2.id))
  assert.equal((await call('POST', '/api/leave-requests', { headers: people.staff2.headers, body: { startsOn: day(-1), endsOn: day(1) } })).status, 400)
})

test('the unanswered scan tells the requester and the managers, once, with numbers and dates only', async () => {
  const r = await call('POST', '/api/leave-requests', { headers: people.staff1.headers, body: { startsOn: day(15), endsOn: day(16) } })
  srv.app.data.leave.get(r.body.leaveRequest.id).createdAt = new Date(Date.now() - 3 * 86_400_000)
  const scan = await call('POST', '/api/admin/unanswered-scan', { headers: people.manager.headers, body: {} })
  const hit = scan.body.created.find((x) => x.leaveRequestId === r.body.leaveRequest.id)
  assert.ok(hit)
  assert.equal((await call('POST', '/api/admin/unanswered-scan', { headers: people.manager.headers, body: {} })).body.created.length, 0, 'once per request')
  // the business system's answer (the kit then keeps only linked employees, their preferences and quiet hours)
  const events = await call('GET', '/bridge/v1/events?after=0', { headers: S })
  const event = events.body.events.find((e) => String(e.id) === String(hit.eventId))
  assert.deepEqual(Object.keys(event.payload).sort(), ['daysWaiting', 'leaveRequestId', 'requesterUserId', 'startsOn'])
  const who = await srv.app.kit.hooks.recipientsFor(event)
  assert.deepEqual(who.users.map((u) => u.id).sort(), [people.admin.id, people.manager.id, people.staff1.id].sort(), 'requester + managers, not the other staff')
  for (const u of who.users) assert.deepEqual(Object.keys(who.paramsFor(u)).sort(), ['count', 'daysWaiting', 'startsOn'])
  assert.equal((await call('POST', '/api/admin/unanswered-scan', { headers: people.staff1.headers, body: {} })).status, 403, 'staff cannot run the scan')
})

test('the daily report counts by role: staff see their own pending requests only', async () => {
  const report = await srv.app.kit.hooks.reports.compute({ id: people.staff2.id, role: 'staff' })
  const all = await srv.app.kit.hooks.reports.compute({ id: people.manager.id, role: 'manager' })
  assert.ok(report.sections.pending.count < all.sections.pending.count)
})
