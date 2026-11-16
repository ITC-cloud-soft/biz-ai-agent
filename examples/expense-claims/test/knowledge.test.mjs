// The knowledge capability of expense-claims: a role never retrieves a chunk it may not see — on the web, and through a
// delegation (the AI acting as the employee) — and the answer never hints that something was withheld.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgeIndex, canSee, createKnowledgeService, KnowledgeBuildError, readKnowledgeDir } from '@dsh-bridge/knowledge'
import { runKnowledgeChecks } from '@dsh-bridge/knowledge/conformance'
import { KNOWLEDGE_DIR, KNOWLEDGE_OPTIONS, ROLES } from '../src/app.mjs'
import { S, SERVICE, manifestWithKnowledgeRoles, startWithPeople } from './helpers.mjs'

let env
const search = (headers, q, limit = 5) => env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers })
const DOCS = ['audit-procedure', 'expense-policy', 'kansa-tejun', 'keihi-seisan-kitei']
const MANAGER_ONLY = ['expense-policy:8:0', 'expense-policy:9:0', 'keihi-seisan-kitei:8:0', 'keihi-seisan-kitei:9:0']
const isAudit = (id) => id.startsWith('audit-procedure:') || id.startsWith('kansa-tejun:')

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

/** Every question we can think of from the documents themselves: titles, headings, keywords, and some phrasings. */
async function questions() {
  const docs = await readKnowledgeDir(KNOWLEDGE_DIR)
  const out = new Set([
    'Up to what amount can a manager approve?', 'split claims', 'how to check a claim before approving', 'audit sample', 'how long are audit records kept',
    'repay an overpaid claim', 'taxi', 'hotel per night', 'lost receipt', 'deadline for March', '上長の承認上限', '分割された申請', '監査のサンプル',
    '監査記録の保存期間', '領収書をなくした', '30,000 yen', '30,000円', 'manager', 'administrator', 'expense',
  ])
  for (const d of docs) {
    out.add(d.title)
    for (const k of d.keywords) out.add(k)
    for (const s of d.sections) if (s.heading) out.add(s.heading)
  }
  return [...out]
}

test('the index: 4 fictional documents (en, ja); the restricted sections and documents keep only their roles', () => {
  const index = env.srv.app.knowledge.index()
  assert.deepEqual(index.documents.map((d) => d.id).sort(), DOCS)
  const roles = (id) => [...index.chunks.find((c) => c.id === id).visibility.roles].sort()
  for (const id of MANAGER_ONLY) assert.deepEqual(roles(id), ['admin', 'manager'], id)
  for (const c of index.chunks.filter((x) => isAudit(x.id))) assert.deepEqual(roles(c.id), ['admin'], c.id)
  assert.deepEqual(roles('expense-policy:3:0'), ['admin', 'manager', 'staff'], 'Receipts')
  assert.deepEqual(roles('keihi-seisan-kitei:3:0'), ['admin', 'manager', 'staff'], '領収書')
  assert.deepEqual(index.rejected, [])
})

test('EVERY answer, to every employee, on the web and through their delegation, holds only chunks that employee may read', async () => {
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))
  const qs = await questions()
  let checked = 0
  const seen = {}
  for (const [name, person] of Object.entries(env.people)) {
    seen[name] = new Set()
    const asker = { id: person.id, role: person.role }
    for (const [channel, headers] of [['web', person.web], ['ai', await env.delegated(person)]]) {
      for (const q of qs) {
        const r = await search(headers, q)
        assert.equal(r.status, 200, `${name}/${channel} "${q}": ${r.status}`)
        for (const x of r.body.results) {
          const chunk = byId.get(x.id)
          assert.ok(chunk, `${x.id} is a chunk of the index`)
          assert.ok(canSee(chunk.visibility, asker), `${name} (${person.role}, ${channel}) got ${x.id}, visible to ${chunk.visibility.roles}`)
          seen[name].add(x.id)
          checked += 1
        }
      }
    }
  }
  assert.ok(checked > 300, `${checked} results checked`)
  // and the search is useful: each role reaches its own restricted material, in both languages
  for (const id of MANAGER_ONLY) assert.ok(seen.manager.has(id), `the manager finds ${id}`)
  assert.ok([...seen.admin].some((id) => id.startsWith('audit-procedure:')) && [...seen.admin].some((id) => id.startsWith('kansa-tejun:')))
  for (const s of ['staff1', 'staff2', 'staff3']) {
    assert.ok(![...seen[s]].some((id) => MANAGER_ONLY.includes(id) || isAudit(id)), `${s} gets nothing restricted`)
    assert.ok(seen[s].has('expense-policy:3:0') && seen[s].has('keihi-seisan-kitei:3:0'), 'staff find the receipt rule in both languages')
  }
  for (const m of ['manager', 'manager2']) assert.ok(![...seen[m]].some(isAudit), 'the audit procedure is not for managers')
})

test('no side channel: a staff member and a manager get exactly the same results and scores as if the hidden chunks did not exist', async () => {
  const full = createKnowledgeService(env.srv.app.knowledge.index(), KNOWLEDGE_OPTIONS)
  for (const [person, role] of [[env.people.staff1, 'staff'], [env.people.manager, 'manager']]) {
    const asker = { id: person.id, role }
    // the same documents with everything this role may not read removed
    const docs = (await readKnowledgeDir(KNOWLEDGE_DIR))
      .filter((d) => d.visibility.roles.includes(role))
      .map((d) => ({ ...d, sections: d.sections.map((s) => (s.roles && !s.roles.includes(role) ? { ...s, text: '', heading: null, roles: undefined } : s)) }))
    const visibleOnly = createKnowledgeService(await buildKnowledgeIndex(docs, { roles: [...ROLES] }), KNOWLEDGE_OPTIONS)
    const strip = (r) => r.results.map((x) => ({ id: x.id.replace(/:\d+:/, ':_:'), text: x.text, score: x.score }))
    for (const q of await questions()) {
      assert.deepEqual(strip(await full.search(q, { asker, limit: 5 })), strip(await visibleOnly.search(q, { asker, limit: 5 })), `${role} "${q}"`)
    }
  }
})

test('sources are business screens: the handbook screen shows a role only its own sections, and 404 alike for hidden and unknown', async () => {
  const r = await search(env.people.manager.web, 'split claims approval limit')
  const top = r.body.results[0]
  assert.equal(top.id, 'expense-policy:8:0')
  assert.equal(top.source.url, '/handbook/expense-policy#approval-limits')
  assert.equal(top.source.title, 'Expense policy › Approval limits for managers')
  const page = await env.call('GET', '/handbook/expense-policy', { headers: env.people.manager.web })
  assert.equal(page.status, 200)
  assert.match(page.body, /id="approval-limits"/)
  const staffPage = await env.call('GET', '/handbook/keihi-seisan-kitei', { headers: env.people.staff1.web })
  assert.equal(staffPage.status, 200)
  assert.match(staffPage.body, /id="ryoshusho"/)
  assert.doesNotMatch(staffPage.body, /shonin-jogen|kakunin|分割/, 'the restricted sections are not on the staff screen')
  for (const p of [env.people.staff1, env.people.manager]) {
    const hidden = await env.call('GET', '/handbook/audit-procedure', { headers: p.web })
    const unknown = await env.call('GET', '/handbook/no-such-document', { headers: p.web })
    assert.equal(hidden.status, 404)
    assert.deepEqual(hidden.body, unknown.body)
  }
  assert.equal((await env.call('GET', '/handbook/kansa-tejun', { headers: env.people.admin.web })).status, 200)
  assert.equal((await env.call('GET', '/handbook/expense-policy', { headers: await env.delegated(env.people.manager) })).status, 403, 'screens are for people')
})

test('scope "own": a document for one employee only — the other staff, the managers and their delegations never get it', async () => {
  const staff1 = env.people.staff1
  await env.srv.app.rebuildKnowledge([{
    id: 'travel-plan-a', title: 'Travel plan', link: '/handbook/travel-plan-a', visibility: { users: [staff1.id] },
    sections: [{ heading: 'Trade fair trip', anchor: 'trip', text: 'Your trade fair trip: book the hotel within the lodging cap and keep every receipt.' }],
  }])
  try {
    const q = 'trade fair trip travel plan'
    for (const headers of [staff1.web, await env.delegated(staff1)]) {
      assert.equal((await search(headers, q)).body.results[0]?.documentId, 'travel-plan-a')
    }
    for (const p of [env.people.staff2, env.people.manager, env.people.admin]) {
      for (const headers of [p.web, await env.delegated(p)]) {
        assert.ok(!(await search(headers, q)).body.results.some((x) => x.documentId === 'travel-plan-a'), `${p.role} must not get it`)
      }
    }
    assert.equal((await env.call('GET', '/handbook/travel-plan-a', { headers: env.people.staff2.web })).status, 404)
    assert.equal((await env.call('GET', '/handbook/travel-plan-a', { headers: staff1.web })).status, 200)
  } finally {
    await env.srv.app.rebuildKnowledge([])
  }
})

test('a delegation ends with its employee: deactivated → the AI gets 401, nothing is searched', async () => {
  const e = await startWithPeople()
  try {
    const d = await e.delegated(e.people.staff2)
    assert.equal((await e.call('GET', '/bridge/v1/knowledge/search?q=receipt', { headers: d })).status, 200)
    assert.equal((await e.call('PATCH', `/api/admin/users/${e.people.staff2.id}`, { headers: e.people.admin.web, body: { active: false } })).status, 200)
    assert.equal((await e.call('GET', '/bridge/v1/knowledge/search?q=receipt', { headers: d })).status, 401)
  } finally {
    await e.srv.stop()
  }
})

test('personal data never enters the index: e-mail / phone shapes and names of the roster (hooks.piiScan)', async () => {
  const docs = [
    { id: 'contacts', title: 'Contacts', link: '/handbook/contacts', visibility: { roles: ['admin'] }, sections: [{ heading: 'Accounting', text: 'Write to accounting-desk@example.com or call 03-1234-5678.' }] },
    { id: 'team-notes', title: 'Team notes', link: '/handbook/team-notes', visibility: { roles: ['manager'] }, sections: [{ heading: 'Audit', text: 'Test staff1 had two split claims in October.' }] },
    { id: 'clean', title: 'Clean', link: '/handbook/clean', visibility: { roles: ['manager'] }, sections: [{ heading: 'Rule', text: 'Decide claims within three days.' }] },
  ]
  await assert.rejects(env.srv.app.rebuildKnowledge(docs), (e) => e instanceof KnowledgeBuildError && /contacts:0:0: personal data \(email, phone\)/.test(e.message) && /team-notes:0:0: personal data \(staff_name\)/.test(e.message) && !/accounting-desk|Test staff1/.test(e.message))
  const index = await env.srv.app.rebuildKnowledge(docs, { onPersonalData: 'skip' })
  try {
    assert.deepEqual(index.rejected.map((r) => [r.chunkId, r.kinds.join(',')]), [['contacts:0:0', 'email,phone'], ['team-notes:0:0', 'staff_name']])
    assert.ok(!index.chunks.some((c) => ['contacts', 'team-notes'].includes(c.documentId)))
    assert.ok(index.chunks.some((c) => c.documentId === 'clean'))
  } finally {
    await env.srv.app.rebuildKnowledge([])
  }
})

test('the build fails closed: unknown role, a section wider than its document, a link that is not a screen, no visibility', async () => {
  const base = { title: 'X', sections: [{ heading: 'A', text: 'text' }] }
  const fails = async (doc, re) => assert.rejects(env.srv.app.rebuildKnowledge([doc]), (e) => e instanceof KnowledgeBuildError && re.test(e.message))
  await fails({ ...base, id: 'x1', link: '/handbook/x1', visibility: { roles: ['manger'] } }, /unknown role\(s\) manger/)
  await fails({ ...base, id: 'x2', link: '/handbook/x2', visibility: { roles: ['manager'] }, sections: [{ heading: 'A', text: 't', roles: ['staff'] }] }, /can only narrow/)
  await fails({ ...base, id: 'x3', link: '/admin/secret', visibility: { roles: ['manager'] } }, /not a screen of the business web/)
  await fails({ ...base, id: 'x4', link: '/handbook/x4', visibility: {} }, /never visible to everyone by default/)
  await fails({ ...base, id: 'x5', link: 'https://evil.example/x', visibility: { roles: ['manager'] } }, /link must be a screen path/)
  assert.equal(env.srv.app.knowledge.index().documents.length, 4, 'a failed build leaves the index as it was')
})

test('the route: 401 without credentials, 403 for the service alone, 400 for a bad question; no hint of hidden chunks', async () => {
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=receipt')).status, 401)
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=receipt', { headers: S })).body.error, 'human_required')
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search', { headers: env.people.staff1.web })).body.error, 'q_required')
  const r = await search(env.people.staff1.web, 'monthly audit sample retention')
  assert.deepEqual(r.body, { ok: true, query: 'monthly audit sample retention', found: false, results: [] }, 'the same answer as for a question nobody can answer')
})

test('knowledge conformance (K-01…K-08) on the fully restricted audit procedure; delegation × role with the tool for managers only', async () => {
  // the probe is a document the denied askers may not read AT ALL (a document with public sections would never fail)
  const fixtures = async (e, { notPermitted = [] } = {}) => ({
    probe: { query: 'monthly audit sample of approved claims', documentId: 'audit-procedure' },
    allowed: [{ label: 'admin web', headers: e.people.admin.web }, { label: 'admin ai', headers: await e.delegated(e.people.admin) }, { label: 'admin2 ai', headers: await e.delegated(e.people.admin2) }],
    denied: [
      { label: 'manager web', headers: e.people.manager.web }, { label: 'staff1 web', headers: e.people.staff1.web },
      ...(notPermitted.length ? [] : [{ label: 'manager ai', headers: await e.delegated(e.people.manager) }, { label: 'staff1 ai', headers: await e.delegated(e.people.staff1) }]),
    ],
    notPermitted,
  })
  const all = await runKnowledgeChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await fixtures(env) })
  assert.deepEqual(all.filter((c) => c.state === 'fail').map((c) => `${c.id}: ${c.note}`), [])
  assert.deepEqual(all.filter((c) => c.state === 'skip').map((c) => c.id), ['K-08'], 'every role has the tool here')

  // the manifest gives the AI's knowledge tool to administrators and managers only: staff search on the web, their AI may not
  const managersOnly = await startWithPeople({ manifest: manifestWithKnowledgeRoles(['admin', 'manager']) })
  try {
    const staffAi = await managersOnly.delegated(managersOnly.people.staff1)
    const checks = await runKnowledgeChecks({
      baseUrl: managersOnly.srv.base, serviceToken: SERVICE,
      fixtures: await fixtures(managersOnly, { notPermitted: [{ label: 'staff1 ai', headers: staffAi }] }),
    })
    assert.deepEqual(checks.map((c) => `${c.id} ${c.state}`), ['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08'].map((id) => `${id} pass`))
    const web = await managersOnly.call('GET', '/bridge/v1/knowledge/search?q=lost%20receipt', { headers: managersOnly.people.staff1.web })
    assert.equal(web.status, 200, 'the employee themself still searches on the web')
    assert.ok(web.body.found)
  } finally {
    await managersOnly.srv.stop()
  }
})
