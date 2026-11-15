// The knowledge capability of the pilot: a role never retrieves a chunk it may not see — on the web, and through a delegation
// (the AI acting as the employee) — and the answer never hints that something was withheld.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgeIndex, canSee, createKnowledgeService, KnowledgeBuildError, readKnowledgeDir } from '@dsh-bridge/knowledge'
import { runKnowledgeChecks } from '@dsh-bridge/knowledge/conformance'
import { KNOWLEDGE_DIR } from '../src/app.mjs'
import { S, SERVICE, manifestWithKnowledgeRoles, startWithPeople } from './helpers.mjs'

let env
const search = (headers, q, limit = 5) => env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers })

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

/** Every question we can think of from the documents themselves: titles, headings, keywords, and some phrasings. */
async function questions() {
  const docs = await readKnowledgeDir(KNOWLEDGE_DIR)
  const out = new Set([
    'How many days of annual leave do I get?', 'Can I carry over unused leave?', 'year-end blackout', 'how many consecutive days can a manager approve',
    'approval rules for managers', 'team coverage', 'overlapping requests at year end', 'deactivate an account', 'audit export', 'sick leave certificate',
    '有給休暇の繰り越しは何日まで', '管理職が承認できる上限', '年末の繁忙期に休めるのは何人', '休暇申請の締め切り', 'manager', 'administrator', 'leave',
  ])
  for (const d of docs) {
    out.add(d.title)
    for (const k of d.keywords) out.add(k)
    for (const s of d.sections) if (s.heading) out.add(s.heading)
  }
  return [...out]
}

test('the index: 6 fictional documents (en, ja, zh); the restricted sections keep only their roles', () => {
  const index = env.srv.app.knowledge.index()
  assert.deepEqual(index.documents.map((d) => d.id).sort(), ['admin-runbook', 'kyuka-faq', 'leave-policy', 'manager-handbook', 'qingjia-zhinan', 'tokubetsu-kyuka'])
  const roles = (id) => [...index.chunks.find((c) => c.id === id).visibility.roles].sort()
  assert.deepEqual(roles('leave-policy:5:0'), ['admin', 'manager'], 'Approval rules for managers')
  assert.deepEqual(roles('kyuka-faq:3:0'), ['admin', 'manager'], '管理職の承認上限')
  assert.deepEqual(roles('admin-runbook:1:0'), ['admin'])
  assert.deepEqual(roles('qingjia-zhinan:6:0'), ['admin', 'manager'], '经理的审批规则')
  assert.deepEqual(roles('tokubetsu-kyuka:4:0'), ['admin', 'manager'], '特別休暇の承認')
  assert.deepEqual(roles('qingjia-zhinan:1:0'), ['admin', 'manager', 'staff'])
  assert.deepEqual(index.rejected, [])
})

test('EVERY answer, to every employee, on the web and through their delegation, holds only chunks that employee may read', async () => {
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))
  const qs = await questions()
  let checked = 0
  const seen = { admin: new Set(), manager: new Set(), staff1: new Set(), staff2: new Set() }
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
  assert.ok(checked > 100, `${checked} results checked`)
  // and the search is useful: each role reaches its own restricted material
  assert.ok(seen.manager.has('leave-policy:5:0') && seen.manager.has('kyuka-faq:3:0') && [...seen.manager].some((id) => id.startsWith('manager-handbook')))
  assert.ok([...seen.admin].some((id) => id.startsWith('admin-runbook')))
  for (const s of ['staff1', 'staff2']) {
    assert.ok(![...seen[s]].some((id) => ['leave-policy:5:0', 'kyuka-faq:3:0'].includes(id) || id.startsWith('manager-handbook') || id.startsWith('admin-runbook')))
    assert.ok(seen[s].has('leave-policy:2:0') && seen[s].has('kyuka-faq:1:0'), 'staff find the carry-over rule in both languages')
  }
  assert.ok(![...seen.manager].some((id) => id.startsWith('admin-runbook')), 'the admin runbook is not for managers')
})

test('no side channel: a staff member gets exactly the same results and scores as if the hidden chunks did not exist', async () => {
  const full = env.srv.app.knowledge.index()
  const asker = { id: env.people.staff1.id, role: 'staff' }
  // the same documents with everything staff may not read removed
  const docs = (await readKnowledgeDir(KNOWLEDGE_DIR))
    .filter((d) => d.visibility.roles.includes('staff'))
    .map((d) => ({ ...d, sections: d.sections.map((s) => (s.roles && !s.roles.includes('staff') ? { ...s, text: '', heading: null, roles: undefined } : s)) }))
  const visibleOnly = createKnowledgeService(await buildKnowledgeIndex(docs, { roles: ['admin', 'manager', 'staff'] }))
  const fullService = createKnowledgeService(full)
  const strip = (r) => r.results.map((x) => ({ id: x.id.replace(/:\d+:/, ':_:'), text: x.text, score: x.score }))
  for (const q of await questions()) {
    const a = await fullService.search(q, { asker, limit: 5 })
    const b = await visibleOnly.search(q, { asker, limit: 5 })
    assert.deepEqual(strip(a), strip(b), `"${q}"`)
  }
})

test('sources are business screens: the handbook screen shows a role only its own sections, and 404 alike for hidden and unknown', async () => {
  const r = await search(env.people.manager.web, 'year-end blackout approval limit')
  const top = r.body.results[0]
  assert.equal(top.id, 'leave-policy:5:0')
  assert.equal(top.source.url, '/handbook/leave-policy#approval-rules')
  assert.equal(top.source.title, 'Leave policy › Approval rules for managers')
  const page = await env.call('GET', '/handbook/leave-policy', { headers: env.people.manager.web })
  assert.equal(page.status, 200)
  assert.match(page.body, /id="approval-rules"/)
  const staffPage = await env.call('GET', '/handbook/leave-policy', { headers: env.people.staff1.web })
  assert.equal(staffPage.status, 200)
  assert.match(staffPage.body, /id="carry-over"/)
  assert.doesNotMatch(staffPage.body, /approval-rules|blackout/, 'the restricted section is not on the staff screen')
  const hidden = await env.call('GET', '/handbook/admin-runbook', { headers: env.people.staff1.web })
  const unknown = await env.call('GET', '/handbook/no-such-document', { headers: env.people.staff1.web })
  assert.equal(hidden.status, 404)
  assert.deepEqual(hidden.body, unknown.body)
  assert.equal((await env.call('GET', '/handbook/leave-policy', { headers: await env.delegated(env.people.manager) })).status, 403, 'screens are for people')
})

test('scope "own": a document for one employee only — the other staff, the managers and their delegations never get it', async () => {
  const staff1 = env.people.staff1
  await env.srv.app.rebuildKnowledge([{
    id: 'onboarding-checklist-a', title: 'Onboarding checklist', link: '/handbook/onboarding-checklist-a', visibility: { users: [staff1.id] },
    sections: [{ heading: 'First week', anchor: 'first-week', text: 'Finish the security training and request your first annual leave plan with your manager.' }],
  }])
  try {
    const q = 'onboarding checklist security training'
    for (const headers of [staff1.web, await env.delegated(staff1)]) {
      const r = await search(headers, q)
      assert.equal(r.body.results[0]?.documentId, 'onboarding-checklist-a')
    }
    for (const p of [env.people.staff2, env.people.manager, env.people.admin]) {
      for (const headers of [p.web, await env.delegated(p)]) {
        const r = await search(headers, q)
        assert.ok(!r.body.results.some((x) => x.documentId === 'onboarding-checklist-a'), `${p.role} must not get it`)
      }
    }
    assert.equal((await env.call('GET', '/handbook/onboarding-checklist-a', { headers: env.people.staff2.web })).status, 404)
    assert.equal((await env.call('GET', '/handbook/onboarding-checklist-a', { headers: staff1.web })).status, 200)
  } finally {
    await env.srv.app.rebuildKnowledge([])
  }
})

test('a delegation ends with its employee: deactivated → the AI gets 401, nothing is searched', async () => {
  const srv2 = await startWithPeople()
  try {
    const d = await srv2.delegated(srv2.people.staff2)
    assert.equal((await srv2.call('GET', '/bridge/v1/knowledge/search?q=leave', { headers: d })).status, 200)
    assert.equal((await srv2.call('PATCH', `/api/admin/users/${srv2.people.staff2.id}`, { headers: srv2.people.admin.web, body: { active: false } })).status, 200)
    assert.equal((await srv2.call('GET', '/bridge/v1/knowledge/search?q=leave', { headers: d })).status, 401)
  } finally {
    await srv2.srv.stop()
  }
})

test('personal data never enters the index: e-mail / phone shapes and names of the roster (hooks.piiScan)', async () => {
  const docs = [
    { id: 'contacts', title: 'Contacts', link: '/handbook/contacts', visibility: { roles: ['admin'] }, sections: [{ heading: 'HR', text: 'Write to hr-desk@example.com or call 03-1234-5678.' }] },
    { id: 'team-notes', title: 'Team notes', link: '/handbook/team-notes', visibility: { roles: ['manager'] }, sections: [{ heading: 'Cover', text: 'Test staff1 covers the front desk in December.' }] },
    { id: 'clean', title: 'Clean', link: '/handbook/clean', visibility: { roles: ['manager'] }, sections: [{ heading: 'Rule', text: 'Plan cover one month ahead.' }] },
  ]
  await assert.rejects(env.srv.app.rebuildKnowledge(docs), (e) => e instanceof KnowledgeBuildError && /contacts:0:0: personal data \(email, phone\)/.test(e.message) && /team-notes:0:0: personal data \(staff_name\)/.test(e.message) && !/hr-desk|Test staff1/.test(e.message))
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
  assert.equal(env.srv.app.knowledge.index().documents.length, 6, 'a failed build leaves the index as it was')
})

test('the route: 401 without credentials, 403 for the service alone, 400 for a bad question; no hint of hidden chunks', async () => {
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=leave')).status, 401)
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search?q=leave', { headers: S })).body.error, 'human_required')
  assert.equal((await env.call('GET', '/bridge/v1/knowledge/search', { headers: env.people.staff1.web })).body.error, 'q_required')
  const r = await search(env.people.staff1.web, 'year-end blackout')
  assert.deepEqual(r.body, { ok: true, query: 'year-end blackout', found: false, results: [] }, 'the same answer as for a question nobody can answer')
})

test('knowledge conformance (K-01…K-08): every role may search; delegation × role with the manifest tool for managers only', async () => {
  const fixtures = async (e, { notPermitted = [] } = {}) => ({
    probe: { query: 'team coverage overlapping requests', documentId: 'manager-handbook' },
    allowed: [
      { label: 'manager web', headers: e.people.manager.web }, { label: 'manager ai', headers: await e.delegated(e.people.manager) },
      { label: 'admin ai', headers: await e.delegated(e.people.admin) },
    ],
    denied: [{ label: 'staff1 web', headers: e.people.staff1.web }, ...(notPermitted.length ? [] : [{ label: 'staff1 ai', headers: await e.delegated(e.people.staff1) }])],
    notPermitted,
  })
  const all = await runKnowledgeChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await fixtures(env) })
  assert.deepEqual(all.filter((c) => c.state === 'fail').map((c) => `${c.id}: ${c.note}`), [])
  assert.deepEqual(all.filter((c) => c.state === 'skip').map((c) => c.id), ['K-08'], 'every role has the tool here')

  // the manifest gives the AI's knowledge tool to managers only: staff search on the web, their AI may not
  const managersOnly = await startWithPeople({ manifest: manifestWithKnowledgeRoles(['admin', 'manager']) })
  try {
    const staffAi = await managersOnly.delegated(managersOnly.people.staff1)
    const checks = await runKnowledgeChecks({
      baseUrl: managersOnly.srv.base, serviceToken: SERVICE,
      fixtures: await fixtures(managersOnly, { notPermitted: [{ label: 'staff1 ai', headers: staffAi }] }),
    })
    assert.deepEqual(checks.map((c) => `${c.id} ${c.state}`), ['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08'].map((id) => `${id} pass`))
    const web = await managersOnly.call('GET', '/bridge/v1/knowledge/search?q=carry%20over', { headers: managersOnly.people.staff1.web })
    assert.equal(web.status, 200, 'the employee themself still searches on the web')
    assert.ok(web.body.found)
  } finally {
    await managersOnly.srv.stop()
  }
})
