// The knowledge capability of equipment-loans: a role never retrieves a chunk it may not see — on the web, and through a
// delegation (the AI acting as the employee) — and the answer never hints that something was withheld.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgeIndex, canSee, createKnowledgeService, KnowledgeBuildError, readKnowledgeDir } from '@dsh-bridge/knowledge'
import { runKnowledgeChecks } from '@dsh-bridge/knowledge/conformance'
import { KNOWLEDGE_DIR, KNOWLEDGE_SYNONYMS } from '../src/app.mjs'
import { S, SERVICE, manifestWithKnowledgeRoles, startWithPeople } from './helpers.mjs'

let env
const search = (headers, q, limit = 5) => env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers })
/** The restricted chunks: manager-only sections in each language, and the administrator runbook. */
const MANAGER_ONLY = ['lending-rules:9:0', 'lending-rules:10:0', 'kashidashi-kitei:9:0', 'kashidashi-kitei:10:0', 'jieyong-zhinan:9:0', 'jieyong-zhinan:10:0']
const isAdminOnly = (id) => id.startsWith('equipment-admin-runbook:')

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

/** Every question we can think of from the documents themselves: titles, headings, keywords, and some phrasings. */
async function questions() {
  const docs = await readKnowledgeDir(KNOWLEDGE_DIR)
  const out = new Set([
    'Who approves a camera loan?', 'how long can I borrow a laptop', 'approval guidance for managers', 'overdue loans 3 days', 'high-value items at a time',
    'event season camera loans 14 days', 'retire old equipment', 'quarterly stock check', 'catalog high value 300,000 yen', 'return the projector late',
    '承認の判断基準', '延滞が 3 日になったら', '高額品は何点まで', '経理の審批標準', '经理的审批标准', '逾期 3 天', '高价值设备 同时 几件', '10 月 相机 14 天',
    'manager', 'administrator', 'loan', '貸出', '借用',
  ])
  for (const d of docs) {
    out.add(d.title)
    for (const k of d.keywords) out.add(k)
    for (const s of d.sections) if (s.heading) out.add(s.heading)
  }
  return [...out]
}

test('the index: 4 fictional documents (en, ja, zh); the restricted sections keep only their roles', () => {
  const index = env.srv.app.knowledge.index()
  assert.deepEqual(index.documents.map((d) => d.id).sort(), ['equipment-admin-runbook', 'jieyong-zhinan', 'kashidashi-kitei', 'lending-rules'])
  const roles = (id) => [...index.chunks.find((c) => c.id === id).visibility.roles].sort()
  for (const id of MANAGER_ONLY) assert.deepEqual(roles(id), ['admin', 'manager'], id)
  assert.equal(index.chunks.find((c) => c.id === 'lending-rules:9:0').heading, 'Approval guidance for managers')
  assert.equal(index.chunks.find((c) => c.id === 'kashidashi-kitei:9:0').heading, '承認の判断基準（管理職向け）')
  assert.equal(index.chunks.find((c) => c.id === 'jieyong-zhinan:9:0').heading, '经理的审批标准')
  assert.deepEqual(roles('equipment-admin-runbook:1:0'), ['admin'])
  for (const id of ['lending-rules:3:0', 'kashidashi-kitei:3:0', 'jieyong-zhinan:3:0']) assert.deepEqual(roles(id), ['admin', 'manager', 'staff'], `${id}: when a loan needs approval is for everyone`)
  assert.deepEqual(index.rejected, [])
})

test('EVERY answer, to every employee, on the web and through their delegation, holds only chunks that employee may read', async () => {
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))
  const qs = await questions()
  let checked = 0
  const seen = Object.fromEntries(Object.keys(env.people).map((k) => [k, new Set()]))
  for (const [name, person] of Object.entries(env.people)) {
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
  assert.ok(checked > 500, `${checked} results checked`)
  // and the search is useful: each role reaches its own restricted material, in every language
  for (const m of ['manager', 'manager2']) {
    for (const id of MANAGER_ONLY) assert.ok(seen[m].has(id), `${m} finds ${id}`)
    assert.ok(![...seen[m]].some(isAdminOnly), 'the administrator runbook is not for managers')
  }
  assert.ok([...seen.admin].some(isAdminOnly))
  for (const s of ['staff1', 'staff2']) {
    assert.ok(![...seen[s]].some((id) => MANAGER_ONLY.includes(id) || isAdminOnly(id)), `${s} never gets a restricted chunk`)
    for (const id of ['lending-rules:3:0', 'kashidashi-kitei:3:0', 'jieyong-zhinan:3:0']) assert.ok(seen[s].has(id), `${s} finds the approval rule (${id})`)
  }
})

test('no side channel: a staff member gets exactly the same results and scores as if the hidden chunks did not exist', async () => {
  const full = env.srv.app.knowledge.index()
  const asker = { id: env.people.staff1.id, role: 'staff' }
  // the same documents with everything staff may not read removed
  const docs = (await readKnowledgeDir(KNOWLEDGE_DIR))
    .filter((d) => d.visibility.roles.includes('staff'))
    .map((d) => ({ ...d, sections: d.sections.map((s) => (s.roles && !s.roles.includes('staff') ? { ...s, text: '', heading: null, roles: undefined } : s)) }))
  const visibleOnly = createKnowledgeService(await buildKnowledgeIndex(docs, { roles: ['admin', 'manager', 'staff'] }), { synonyms: KNOWLEDGE_SYNONYMS })
  const fullService = createKnowledgeService(full, { synonyms: KNOWLEDGE_SYNONYMS })
  const strip = (r) => r.results.map((x) => ({ id: x.id.replace(/:\d+:/, ':_:'), text: x.text, score: x.score }))
  let compared = 0
  for (const q of await questions()) {
    const a = await fullService.search(q, { asker, limit: 5 })
    const b = await visibleOnly.search(q, { asker, limit: 5 })
    assert.deepEqual(strip(a), strip(b), `"${q}"`)
    compared += a.results.length
  }
  assert.ok(compared > 50, `${compared} results compared`)
})

test('sources are business screens: the handbook screen shows a role only its own sections, and 404 alike for hidden and unknown', async () => {
  const r = await search(env.people.manager.web, 'how many high-value items can one employee hold at a time')
  const top = r.body.results[0]
  assert.equal(top.id, 'lending-rules:9:0')
  assert.equal(top.source.url, '/handbook/lending-rules#approval-guidance')
  assert.equal(top.source.title, 'Equipment lending rules › Approval guidance for managers')
  const page = await env.call('GET', '/handbook/lending-rules', { headers: env.people.manager.web })
  assert.equal(page.status, 200)
  assert.match(page.body, /id="approval-guidance"/)
  const staffPage = await env.call('GET', '/handbook/jieyong-zhinan', { headers: env.people.staff1.web })
  assert.equal(staffPage.status, 200)
  assert.match(staffPage.body, /id="shenpi"/)
  assert.doesNotMatch(staffPage.body, /shenpi-biaozhun|yuqi-chuli|14 天/, 'the restricted sections are not on the staff screen')
  const hidden = await env.call('GET', '/handbook/equipment-admin-runbook', { headers: env.people.manager.web })
  const unknown = await env.call('GET', '/handbook/no-such-document', { headers: env.people.manager.web })
  assert.equal(hidden.status, 404)
  assert.deepEqual(hidden.body, unknown.body)
  assert.equal((await env.call('GET', '/handbook/lending-rules', { headers: await env.delegated(env.people.manager) })).status, 403, 'screens are for people')
})

test('scope "own": a document for one employee only — the other staff, the managers and their delegations never get it', async () => {
  const staff1 = env.people.staff1
  await env.srv.app.rebuildKnowledge([{
    id: 'loan-handover-a', title: 'Loan handover note', link: '/handbook/loan-handover-a', visibility: { users: [staff1.id] },
    sections: [{ heading: 'Your tripod', anchor: 'tripod', text: 'Your tripod booking comes with a spare quick-release plate; return both together.' }],
  }])
  try {
    const q = 'tripod quick-release plate'
    for (const headers of [staff1.web, await env.delegated(staff1)]) {
      const r = await search(headers, q)
      assert.equal(r.body.results[0]?.documentId, 'loan-handover-a')
    }
    for (const p of [env.people.staff2, env.people.manager, env.people.admin]) {
      for (const headers of [p.web, await env.delegated(p)]) {
        const r = await search(headers, q)
        assert.ok(!r.body.results.some((x) => x.documentId === 'loan-handover-a'), `${p.role} must not get it`)
      }
    }
    assert.equal((await env.call('GET', '/handbook/loan-handover-a', { headers: env.people.staff2.web })).status, 404)
    assert.equal((await env.call('GET', '/handbook/loan-handover-a', { headers: staff1.web })).status, 200)
  } finally {
    await env.srv.app.rebuildKnowledge([])
  }
})

test('a delegation ends with its employee: deactivated → the AI gets 401, nothing is searched', async () => {
  const srv2 = await startWithPeople()
  try {
    const d = await srv2.delegated(srv2.people.staff2)
    assert.equal((await srv2.call('GET', '/bridge/v1/knowledge/search?q=loan', { headers: d })).status, 200)
    assert.equal((await srv2.call('PATCH', `/api/admin/users/${srv2.people.staff2.id}`, { headers: srv2.people.admin.web, body: { active: false } })).status, 200)
    assert.equal((await srv2.call('GET', '/bridge/v1/knowledge/search?q=loan', { headers: d })).status, 401)
  } finally {
    await srv2.srv.stop()
  }
})

test('personal data never enters the index: e-mail / phone shapes and names of the roster (hooks.piiScan)', async () => {
  const docs = [
    { id: 'desk-contacts', title: 'Desk contacts', link: '/handbook/desk-contacts', visibility: { roles: ['admin'] }, sections: [{ heading: 'Desk', text: 'Write to desk@example.com or call 000-0000-0000.' }] },
    { id: 'desk-rota', title: 'Desk rota', link: '/handbook/desk-rota', visibility: { roles: ['manager'] }, sections: [{ heading: 'Rota', text: 'Test staff2 covers the equipment desk on Fridays.' }] },
    { id: 'clean', title: 'Clean', link: '/handbook/clean', visibility: { roles: ['manager'] }, sections: [{ heading: 'Rule', text: 'Plan the desk rota one month ahead.' }] },
  ]
  await assert.rejects(env.srv.app.rebuildKnowledge(docs), (e) => e instanceof KnowledgeBuildError && /desk-contacts:0:0: personal data \(email, phone\)/.test(e.message) && /desk-rota:0:0: personal data \(staff_name\)/.test(e.message) && !/desk@|Test staff2/.test(e.message))
  const index = await env.srv.app.rebuildKnowledge(docs, { onPersonalData: 'skip' })
  try {
    assert.deepEqual(index.rejected.map((r) => [r.chunkId, r.kinds.join(',')]), [['desk-contacts:0:0', 'email,phone'], ['desk-rota:0:0', 'staff_name']])
    assert.ok(!index.chunks.some((c) => ['desk-contacts', 'desk-rota'].includes(c.documentId)))
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
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=loan')).status, 401)
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=loan', { headers: S })).body.error, 'human_required')
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search', { headers: env.people.staff1.web })).body.error, 'q_required')
  const r = await search(env.people.staff1.web, 'event season October November')
  assert.deepEqual(r.body, { ok: true, query: 'event season October November', found: false, results: [] }, 'the same answer as for a question nobody can answer')
  const m = await search(env.people.manager.web, 'event season October November')
  assert.equal(m.body.results[0]?.id, 'lending-rules:9:0', 'a manager finds it')
})

test('knowledge conformance (K-01…K-08): every role may search; delegation × role with the manifest tool for managers only', async () => {
  // the probe is a DOCUMENT the denied askers may not read at all: the administrator runbook (staff and managers never get a
  // chunk of it). lending-rules cannot be the probe: staff read most of it, only two sections are for managers.
  const runbook = async (e, notPermitted = []) => ({
    probe: { query: 'quarterly stock check retire old equipment catalog', documentId: 'equipment-admin-runbook' },
    allowed: [{ label: 'admin web', headers: e.people.admin.web }, { label: 'admin ai', headers: await e.delegated(e.people.admin) }],
    denied: [
      { label: 'manager web', headers: e.people.manager.web }, { label: 'manager ai', headers: await e.delegated(e.people.manager) },
      { label: 'staff1 web', headers: e.people.staff1.web }, ...(notPermitted.length ? [] : [{ label: 'staff1 ai', headers: await e.delegated(e.people.staff1) }]),
    ],
    notPermitted,
  })
  const all = await runKnowledgeChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await runbook(env) })
  assert.deepEqual(all.filter((c) => c.state === 'fail').map((c) => `${c.id}: ${c.note}`), [])
  assert.deepEqual(all.filter((c) => c.state === 'skip').map((c) => c.id), ['K-08'], 'every role has the tool here')

  // the manifest gives the AI's knowledge tool to managers only: staff search on the web, their AI may not
  const managersOnly = await startWithPeople({ manifest: manifestWithKnowledgeRoles(['admin', 'manager']) })
  try {
    const staffAi = await managersOnly.delegated(managersOnly.people.staff1)
    const checks = await runKnowledgeChecks({
      baseUrl: managersOnly.srv.base, serviceToken: SERVICE, fixtures: await runbook(managersOnly, [{ label: 'staff1 ai', headers: staffAi }]),
    })
    assert.deepEqual(checks.map((c) => `${c.id} ${c.state}`), ['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08'].map((id) => `${id} pass`))
    const web = await managersOnly.call('GET', '/bridge/v1/knowledge/search?q=return%20the%20laptop', { headers: managersOnly.people.staff1.web })
    assert.equal(web.status, 200, 'the employee themself still searches on the web')
    assert.ok(web.body.found)
  } finally {
    await managersOnly.srv.stop()
  }
})
