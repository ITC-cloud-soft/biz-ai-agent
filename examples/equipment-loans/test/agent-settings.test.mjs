// The settings plugin (@dsh-bridge/agent-settings) on equipment-loans: the same plugin as on the pilot, on another business.
// One administrator here — so the approver roles matter: with approvers = admin only, the admin's own upload has no approver
// until the admin lets managers approve (an SNS setting).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S, startWithPeople } from './helpers.mjs'

let env
let dir
const admin = () => env.people.admin.web
const search = async (who, q) => (await env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=5`, { headers: env.people[who].web })).body

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loans-agent-test-'))
  env = await startWithPeople({ dataDir: dir, agentEnv: {} })
})
after(async () => {
  await env?.srv.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('administrators only; the AI acting as one gets nothing', async () => {
  assert.equal((await env.call('GET', '/agent-settings', { headers: admin() })).status, 200)
  for (const who of ['manager', 'staff1']) assert.equal((await env.call('GET', '/api/agent/settings', { headers: env.people[who].web })).status, 403, who)
  assert.ok([401, 403].includes((await env.call('GET', '/api/agent/settings', { headers: await env.delegated(env.people.admin) })).status))
  const s = (await env.call('GET', '/api/agent/settings', { headers: admin() })).body.settings
  assert.deepEqual([s.knowledge.mode, s.knowledge.vectorStore, s.vectorDb.available], ['bm25f', 'file', false])
})

test('the sign-in page in the screen look; a browser without a session goes there and comes back', async () => {
  const page = await env.call('GET', '/login?lang=en')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>Sign in — Equipment Loans<\/title>/)
  const r = await fetch(`${env.srv.base}/me/sns`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/login?next=%2Fme%2Fsns')
})

test('upload by the only admin → no approver until managers may approve → a manager approves → found by its roles only → report', async () => {
  const text = '## Borrowing a tablet {#tablet}\nTablets are lent for at most 3 days from the equipment desk.\n\n## Tablet stock {#stock roles=admin,manager}\nKeep two tablets in reserve for urgent requests.'
  const up = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Tablet lending', roles: ['admin', 'manager', 'staff'], keywords: ['tablet'], text } })
  assert.equal(up.status, 201)
  const doc = up.body.document
  const requested = (await env.call('GET', '/bridge/v1/events?after=0', { headers: S })).body.events.find((e) => e.type === 'approval.requested' && e.payload.subjectId === doc.id)
  const hooks = env.srv.app.kit.hooks
  const a = await hooks.approvals.get(requested.payload.approvalId)
  assert.deepEqual(await hooks.approvals.approvers(a), [], 'approvers = admin only, and the admin uploaded it')
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 403)

  const set = await env.call('PUT', '/api/agent/settings', { headers: admin(), body: { sns: { approverRoles: ['admin', 'manager'] } } })
  assert.deepEqual(set.body.settings.sns.approverRoles, ['admin', 'manager'])
  assert.deepEqual((await hooks.approvals.approvers(a)).map((u) => u.role).sort(), ['manager', 'manager'], 'now the two managers get the approval card')
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 200)
  await env.srv.app.agent.idle()

  assert.ok((await search('staff1', 'how long can I borrow a tablet')).results.some((r) => r.id.startsWith(`${doc.id}:`)))
  assert.ok(!(await search('staff1', 'tablets in reserve stock')).results.some((r) => r.text.includes('reserve')), 'the stock section: managers only')
  assert.ok((await search('manager2', 'tablets in reserve stock')).results.some((r) => r.text.includes('reserve')))
  const report = (await env.call('GET', '/bridge/v1/events?after=0', { headers: S })).body.events.filter((e) => e.type === 'knowledge.updated').at(-1)
  const to = await hooks.recipientsFor({ type: 'knowledge.updated', payload: report.payload })
  assert.deepEqual(to.users.map((u) => u.role), ['admin'], 'reports: admin (the default)')
  assert.notEqual(await hooks.recipientsFor({ type: 'loan.overdue', payload: { loanId: 'x' } }), undefined, 'loan.overdue still goes to the system\'s own rule')
})
