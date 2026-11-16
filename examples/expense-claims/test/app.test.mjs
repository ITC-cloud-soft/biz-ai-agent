// The business rules of expense-claims through its own API and the Bridge (no database: the memory store). Conformance does
// not prove these: a system that let the claimant approve their own claim would still pass 52 / 52.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_LIMIT_YEN } from '../src/app.mjs'
import { S, day, startWithPeople } from './helpers.mjs'

let env
const decide = (person, approvalId, action = 'approve') => env.call('POST', `/api/approvals/${approvalId}/decision`, { headers: person.web, body: { action } })
const propose = async (person, payload, kind = 'expense_correct_claim') => env.call('POST', '/bridge/v1/proposals', { headers: await env.delegated(person), body: { kind, payload } })
const decideCorrection = (person, claimId, proposalId, action, headers = person.web) => env.call('POST', `/api/expense-claims/${claimId}/corrections/${proposalId}/decision`, { headers, body: { action } })
const events = async (type) => (await env.call('GET', '/bridge/v1/events?after=0&limit=500', { headers: S })).body.events.filter((e) => e.type === type)

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

test('a claim up to 30,000 yen: one approval for the claimant\'s OWN manager — not the claimant, not another manager, not an administrator', async () => {
  const { people } = env
  const r = await env.claim(people.staff1, { amountYen: APPROVAL_LIMIT_YEN }) // exactly the limit: still the manager
  assert.equal(r.approval.status, 'pending')
  assert.deepEqual([r.approval.requiredRole, r.approval.assignedTo], ['manager', people.manager.id])
  assert.ok((await events('approval.requested')).some((e) => e.payload.approvalId === r.approval.id && e.payload.requiredRole === 'manager'))
  assert.equal((await decide(people.staff1, r.approval.id)).status, 403, 'the claimant')
  assert.equal((await decide(people.manager2, r.approval.id)).status, 403, 'another team\'s manager')
  assert.equal((await decide(people.admin, r.approval.id)).status, 403, 'an administrator: the claim is the manager\'s to decide')
  const approvers = await env.srv.app.kit.hooks.approvals.approvers(await env.srv.app.kit.hooks.approvals.get(r.approval.id))
  assert.deepEqual(approvers.map((u) => u.id), [people.manager.id], 'the chat card goes to the same person the web lets decide')
  const ok = await decide(people.manager, r.approval.id)
  assert.equal(ok.body.approval.status, 'approved')
  assert.equal((await decide(people.manager, r.approval.id, 'reject')).status, 409, 'once')
  assert.equal(env.srv.app.data.claims.get(r.claim.id).status, 'approved')
})

test('a claim over 30,000 yen: an administrator decides, the manager cannot', async () => {
  const { people } = env
  const r = await env.claim(people.staff1, { amountYen: APPROVAL_LIMIT_YEN + 1, category: 'lodging' })
  assert.deepEqual([r.approval.requiredRole, r.approval.assignedTo], ['admin', null])
  assert.equal((await decide(people.manager, r.approval.id)).status, 403)
  const approvers = await env.srv.app.kit.hooks.approvals.approvers(await env.srv.app.kit.hooks.approvals.get(r.approval.id))
  assert.deepEqual(approvers.map((u) => u.id).sort(), [people.admin.id, people.admin2.id].sort())
  assert.equal((await decide(people.admin2, r.approval.id, 'reject')).body.approval.status, 'rejected')
})

test('nobody decides their own claim: an administrator\'s large claim goes to the OTHER administrator; a manager\'s small claim to their manager', async () => {
  const { people } = env
  const big = await env.claim(people.admin, { amountYen: 50_000, category: 'lodging' })
  assert.equal((await decide(people.admin, big.approval.id)).status, 403)
  assert.equal((await decide(people.admin2, big.approval.id)).status, 200)
  const small = await env.claim(people.manager, { amountYen: 3_000 })
  assert.equal(small.approval.assignedTo, people.admin.id, 'the manager\'s own manager')
  assert.equal((await decide(people.manager, small.approval.id)).status, 403)
  assert.equal((await decide(people.admin, small.approval.id)).status, 200)
})

test('an assigned manager who is deactivated: an administrator decides instead (to confirm)', async () => {
  const e = await startWithPeople()
  try {
    const r = await e.claim(e.people.staff3, { amountYen: 2_000 })
    assert.equal(r.approval.assignedTo, e.people.manager2.id)
    assert.equal((await e.call('PATCH', `/api/admin/users/${e.people.manager2.id}`, { headers: e.people.admin.web, body: { active: false } })).status, 200)
    assert.equal((await e.call('POST', `/api/approvals/${r.approval.id}/decision`, { headers: e.people.admin.web, body: { action: 'approve' } })).status, 200)
  } finally {
    await e.srv.stop()
  }
})

test('who sees what: staff their own, a manager their own and their team\'s, administrators all — on the web and through the AI', async () => {
  const { people } = env
  const mine = await env.claim(people.staff2)
  const other = await env.claim(people.staff3)
  const ids = async (headers) => (await env.call('GET', '/api/expense-claims', { headers })).body.claims.map((c) => c.id)
  for (const headers of [people.staff2.web, await env.delegated(people.staff2)]) {
    const seen = await ids(headers)
    assert.ok(seen.includes(mine.claim.id) && !seen.includes(other.claim.id))
    assert.ok((await env.call('GET', '/api/expense-claims', { headers })).body.claims.every((c) => c.claimantUserId === people.staff2.id))
  }
  for (const headers of [people.manager.web, await env.delegated(people.manager)]) {
    const seen = await ids(headers)
    assert.ok(seen.includes(mine.claim.id) && !seen.includes(other.claim.id), 'manager: staff2 is in the team, staff3 is not')
  }
  assert.ok((await ids(people.manager2.web)).includes(other.claim.id))
  const all = await ids(await env.delegated(people.admin))
  assert.ok(all.includes(mine.claim.id) && all.includes(other.claim.id))
  assert.equal((await env.call('GET', '/api/expense-claims/waiting', { headers: await env.delegated(people.staff1) })).status, 403, 'the waiting list is a managers\' tool')
})

test('a claim is checked: no future date, within 30 days, a known category, a whole amount of yen, a short note', async () => {
  const { people } = env
  const post = (body) => env.call('POST', '/api/expense-claims', { headers: people.staff1.web, body: { spentOn: day(-1), category: 'transport', amountYen: 1000, note: 'x', ...body } })
  assert.equal((await post({ spentOn: day(1) })).body.error, 'invalid_date')
  assert.equal((await post({ spentOn: day(-31) })).body.error, 'claim_too_late')
  assert.equal((await post({ spentOn: day(-30) })).status, 201, 'the 30th day is still in time')
  assert.equal((await post({ category: 'gifts' })).body.error, 'invalid_category')
  for (const amountYen of [0, -5, 12.5, '4800', 1_000_001]) assert.equal((await post({ amountYen })).body.error, 'invalid_amount', String(amountYen))
  assert.equal((await post({ note: 'x'.repeat(201) })).body.error, 'invalid_note')
  assert.equal((await post({ approvedBy: people.staff1.id })).status, 400, 'no unknown keys')
  assert.equal((await env.call('POST', '/api/expense-claims', { headers: await env.delegated(people.staff1), body: { spentOn: day(-1), category: 'transport', amountYen: 1000 } })).status, 403, 'the AI never submits')
})

test('the waiting reminder: only after MORE than 3 days, once per claim, to the approver only (never the claimant), numbers and dates only', async () => {
  const { people } = env
  const small = await env.claim(people.staff1, { amountYen: 6_000 })
  const large = await env.claim(people.staff2, { amountYen: 40_000, category: 'lodging' })
  const young = await env.claim(people.staff1, { amountYen: 7_000 })
  env.age(small.claim.id, 4)
  env.age(large.claim.id, 3.5)
  env.age(young.claim.id, 2.9)
  const scan = await env.call('POST', '/api/admin/waiting-scan', { headers: people.admin.web, body: {} })
  const created = scan.body.created.map((x) => x.claimId)
  assert.ok(created.includes(small.claim.id) && created.includes(large.claim.id))
  assert.ok(!created.includes(young.claim.id), '2.9 days is not more than 3')
  assert.deepEqual((await env.call('POST', '/api/admin/waiting-scan', { headers: people.admin.web, body: {} })).body.created, [], 'once per claim')
  assert.equal((await env.call('POST', '/api/admin/waiting-scan', { headers: people.manager.web, body: {} })).status, 403, 'administrators run the scan')

  const all = await events('expense.claim_waiting')
  const ev = (claimId) => all.find((e) => e.payload.claimId === claimId)
  assert.deepEqual(Object.keys(ev(small.claim.id).payload).sort(), ['approvalId', 'claimId', 'claimantUserId', 'daysWaiting', 'requiredRole', 'submittedOn'])
  const hooks = env.srv.app.kit.hooks
  const toSmall = await hooks.recipientsFor(ev(small.claim.id))
  assert.deepEqual(toSmall.users.map((u) => u.id), [people.manager.id], 'the claimant\'s manager only')
  const toLarge = await hooks.recipientsFor(ev(large.claim.id))
  assert.deepEqual(toLarge.users.map((u) => u.id).sort(), [people.admin.id, people.admin2.id].sort(), 'the administrators only')
  for (const who of [toSmall, toLarge]) {
    assert.ok(!who.users.some((u) => [people.staff1.id, people.staff2.id].includes(u.id)), 'never the claimant')
    for (const u of who.users) {
      const p = who.paramsFor(u)
      assert.deepEqual(Object.keys(p).sort(), ['count', 'daysWaiting', 'submittedOn'])
      assert.ok(Number.isInteger(p.count) && p.count >= 1)
    }
  }
  // decided in the meantime: the reminder is stale
  await decide(people.manager, small.approval.id)
  assert.deepEqual(await hooks.recipientsFor(ev(small.claim.id)), { stale: 'decided' })
})

test('AI corrections: date / category / note of a claim the asker may see, never the amount; ONLY the claimant accepts', async () => {
  const { people } = env
  const { claim } = await env.claim(people.staff1, { category: 'other', amountYen: 2_500 })
  // the claimant's own AI, and the manager's AI for a team member, may propose; others may not see the claim
  const own = await propose(people.staff1, { claimId: claim.id, category: 'supplies', reasonCode: 'category_mismatch' })
  assert.equal(own.status, 201)
  assert.equal(own.body.proposal.status, 'pending_review')
  const mgr = await propose(people.manager, { claimId: claim.id, note: 'Printer paper for the office (test)', reasonCode: 'note_unclear' })
  assert.equal(mgr.status, 201)
  for (const p of [people.staff2, people.manager2]) {
    assert.equal((await propose(p, { claimId: claim.id, category: 'supplies', reasonCode: 'category_mismatch' })).body.error, 'claim_not_found', p.role)
  }
  // the amount is never proposed
  assert.equal((await propose(people.staff1, { claimId: claim.id, category: 'supplies', amountYen: 2_000, reasonCode: 'category_mismatch' })).body.error, 'invalid_payload', 'an amount is refused even next to a valid correction')
  assert.equal((await propose(people.staff1, { claimId: claim.id, reasonCode: 'date_mismatch' })).status, 400, 'nothing to correct')
  assert.equal((await propose(people.staff1, { claimId: claim.id, spentOn: day(2), reasonCode: 'date_mismatch' })).body.error, 'invalid_date')

  // the claimant sees it on the claim's screen; nobody else decides it
  const list = await env.call('GET', `/api/expense-claims/${claim.id}/corrections`, { headers: people.staff1.web })
  assert.deepEqual(list.body.corrections.map((c) => c.id).sort(), [own.body.proposal.id, mgr.body.proposal.id].sort())
  assert.equal((await decideCorrection(people.manager, claim.id, own.body.proposal.id, 'accept')).status, 403, 'the manager is not the claimant')
  assert.equal((await env.call('POST', `/bridge/v1/proposals/${own.body.proposal.id}/accept`, { headers: people.admin.web, body: {} })).status, 403, 'an administrator (the kit\'s reviewer) cannot accept it either')
  assert.equal((await env.call('POST', `/bridge/v1/proposals/${own.body.proposal.id}/accept`, { headers: people.manager.web, body: {} })).status, 403)
  assert.equal((await decideCorrection(people.staff1, claim.id, own.body.proposal.id, 'accept', await env.delegated(people.staff1))).status, 403, 'not the AI')
  assert.equal((await decideCorrection(people.staff2, claim.id, own.body.proposal.id, 'accept')).status, 404, 'another employee does not even see the claim')

  const ok = await decideCorrection(people.staff1, claim.id, own.body.proposal.id, 'accept')
  assert.equal(ok.status, 200)
  assert.deepEqual([ok.body.claim.category, ok.body.claim.amountYen, ok.body.claim.status], ['supplies', 2_500, 'pending'], 'corrected; the amount and the approval unchanged')
  assert.equal((await decideCorrection(people.staff1, claim.id, own.body.proposal.id, 'reject')).status, 409, 'once')
  const no = await decideCorrection(people.staff1, claim.id, mgr.body.proposal.id, 'reject')
  assert.equal(no.status, 200)
  assert.equal(env.srv.app.data.claims.get(claim.id).note, 'Train to a client (test)', 'a rejected correction changes nothing')
})

test('the audit sample: administrators\' AI only, approved claims only; an administrator accepts', async () => {
  const { people } = env
  const r = await env.claim(people.staff3, { amountYen: 29_000 })
  assert.equal((await propose(people.admin, { claimId: r.claim.id, reasonCode: 'near_limit' }, 'expense_audit_sample')).body.error, 'claim_not_approved')
  await decide(people.manager2, r.approval.id)
  assert.equal((await propose(people.manager2, { claimId: r.claim.id, reasonCode: 'near_limit' }, 'expense_audit_sample')).status, 403)
  const p = await propose(people.admin, { claimId: r.claim.id, reasonCode: 'near_limit' }, 'expense_audit_sample')
  assert.equal(p.status, 201)
  assert.equal((await env.call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: people.admin2.web, body: {} })).status, 200)
  assert.equal(env.srv.app.data.claims.get(r.claim.id).auditSample, true)
})

test('the daily report counts by what each viewer may see; attention = the claims waiting for THEIR decision', async () => {
  const { people } = env
  const compute = (p) => env.srv.app.kit.hooks.reports.compute({ id: p.id, role: p.role })
  const [staff, manager, manager2, admin] = await Promise.all([compute(people.staff1), compute(people.manager), compute(people.manager2), compute(people.admin)])
  assert.ok(staff.sections.pending.count < manager.sections.pending.count)
  assert.ok(manager.sections.pending.count <= admin.sections.pending.count)
  assert.equal(staff.attention, 0, 'staff decide nothing')
  const waitingForManager = [...env.srv.app.data.claims.values()].filter((c) => c.status === 'pending' && env.srv.app.data.approvals.get(c.approvalId).assignedTo === people.manager.id).length
  assert.equal(manager.attention, waitingForManager)
  assert.ok(manager2.sections.pending.count < admin.sections.pending.count)
})
