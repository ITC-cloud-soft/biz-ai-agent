// The settings plugin (@dsh-bridge/agent-settings) on expense-claims, over HTTP. Two administrators here, so the default
// approver roles (admin) work: the uploader never approves their own document, the other administrator does. No model, no key.
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
const events = async (type) => (await env.call('GET', '/bridge/v1/events?after=0&limit=500', { headers: S })).body.events.filter((e) => e.type === type)

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'expense-agent-test-'))
  env = await startWithPeople({ dataDir: dir, agentEnv: {} })
})
after(async () => {
  await env?.srv.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('administrators only; the AI acting as one gets nothing; /me/sns for every employee', async () => {
  assert.equal((await env.call('GET', '/agent-settings', { headers: admin() })).status, 200)
  for (const who of ['manager', 'staff1']) {
    assert.equal((await env.call('GET', '/agent-settings', { headers: env.people[who].web })).status, 403, who)
    assert.equal((await env.call('GET', '/api/agent/settings', { headers: env.people[who].web })).status, 403, who)
  }
  const ai = await env.delegated(env.people.admin)
  assert.ok([401, 403].includes((await env.call('GET', '/api/agent/settings', { headers: ai })).status))
  assert.ok([401, 403].includes((await env.call('POST', '/api/agent/documents', { headers: ai, body: { title: 'x', roles: ['staff'], text: 'x' } })).status))
  const s = (await env.call('GET', '/api/agent/settings', { headers: admin() })).body.settings
  assert.deepEqual([s.knowledge.mode, s.sns.approverRoles], ['bm25f', ['admin']])
  assert.match((await env.call('GET', '/agent-settings?lang=ja', { headers: admin() })).body, /"gateway":null/, 'no DSH here: the SNS page says so')
  for (const who of ['staff1', 'manager']) {
    const me = await env.call('GET', '/me/sns?lang=en', { headers: env.people[who].web })
    assert.equal(me.status, 200, who)
    assert.match(me.body, /"mode":"me","isAdmin":false/)
  }
})

test('the sign-in page in the screen look; a browser without a session goes there and comes back', async () => {
  const page = await env.call('GET', '/login?lang=ja&next=%2Fme%2Fsns')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>サインイン — Expense Claims<\/title>/)
  const r = await fetch(`${env.srv.base}/me/sns`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), '/login?next=%2Fme%2Fsns')
  // redirectToSignIn knows only its own screens (exact paths): the handbook screen the AI's sources link to answers 401
  const hb = await fetch(`${env.srv.base}/handbook/expense-policy`, { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(hb.status, 401)
  assert.equal((await env.call('GET', '/agent-settings')).status, 401, 'not a browser: still a 401')
})

test('a document: upload → approval card for the OTHER administrator only → published → found by its roles only → knowledge.updated to the report roles', async () => {
  const text = '## Business cards {#cards}\nBusiness cards are ordered by the office team; do not claim them as supplies.\n\n## Card budget {#budget roles=admin,manager}\nEach team may order at most 200 cards a quarter.'
  const up = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Business cards', roles: ['admin', 'manager', 'staff'], keywords: ['business cards'], text } })
  assert.equal(up.status, 201)
  const doc = up.body.document
  assert.equal(doc.status, 'pending')
  const requested = (await events('approval.requested')).find((e) => e.payload.subjectId === doc.id)
  assert.equal(requested.payload.subjectType, 'knowledge_document')
  const hooks = env.srv.app.kit.hooks
  const a = await hooks.approvals.get(requested.payload.approvalId)
  assert.deepEqual((await hooks.approvals.approvers(a)).map((u) => u.id), [env.people.admin2.id], 'the uploader never approves their own')
  assert.ok(!(await search('manager', 'business cards ordered')).results.some((r) => r.documentId === doc.id), 'not searchable before the approval')
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: admin(), body: { action: 'approve' } })).status, 403)
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 403)
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.admin2.web, body: { action: 'approve' } })).status, 200)
  await env.srv.app.agent.idle()

  assert.ok((await search('staff1', 'who orders business cards')).results.some((r) => r.id.startsWith(`${doc.id}:`)))
  assert.ok(!(await search('staff1', 'how many business cards a quarter budget')).results.some((r) => r.text.includes('200 cards')), 'the budget section: managers only')
  assert.ok((await search('manager', 'how many business cards a quarter budget')).results.some((r) => r.text.includes('200 cards')))
  const handbook = await env.call('GET', `/handbook/${doc.id}`, { headers: env.people.staff1.web })
  assert.equal(handbook.status, 200)
  assert.ok(handbook.body.includes('office team') && !handbook.body.includes('200 cards'))

  const report = (await events('knowledge.updated')).at(-1)
  assert.deepEqual(Object.keys(report.payload).sort(), ['buildId', 'chunks', 'documents', 'failed', 'rejected'])
  const to = await hooks.recipientsFor({ type: 'knowledge.updated', payload: report.payload })
  assert.deepEqual(to.users.map((u) => u.role).sort(), ['admin', 'admin'], 'the report roles (admin by default)')
  assert.deepEqual(to.paramsFor(to.users[0]), { documents: report.payload.documents, chunks: report.payload.chunks, rejected: 0, failed: 0 })
})

test('the system\'s own events still reach its own recipientsFor (the plugin only takes its own)', async () => {
  const hooks = env.srv.app.kit.hooks
  assert.deepEqual(await hooks.recipientsFor({ type: 'expense.claim_waiting', payload: { claimId: 'x' } }), { stale: 'deleted' })
  const r = await env.claim(env.people.staff1, { amountYen: 9_000 })
  env.age(r.claim.id, 4)
  const scan = await env.call('POST', '/api/admin/waiting-scan', { headers: admin(), body: {} })
  const event = (await events('expense.claim_waiting')).find((e) => String(e.id) === String(scan.body.created[0].eventId))
  assert.deepEqual((await hooks.recipientsFor(event)).users.map((u) => u.id), [env.people.manager.id])
  // a claim's approval still goes to this system's own approval hooks
  const a = await hooks.approvals.get(r.approval.id)
  assert.deepEqual((await hooks.approvals.approvers(a)).map((u) => u.id), [env.people.manager.id])
})

test('a document with personal data is refused and its text is not kept', async () => {
  const r = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Accounting contacts', roles: ['admin'], text: 'Write to accounting-desk@example.com or call 03-1234-5678.' } })
  assert.equal(r.body.document.status, 'personal_data')
  assert.deepEqual(r.body.document.kinds, ['email', 'phone'])
  assert.equal((await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'x', roles: ['boss'], text: 'x' } })).body.error, 'invalid_roles')
})
