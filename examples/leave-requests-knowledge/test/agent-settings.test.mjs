// The settings plugin (@dsh-bridge/agent-settings) on the running pilot, over HTTP, with a mock OpenAI-compatible model server
// (chat for the knowledge-graph extraction and the connection test, embeddings for RAG). No real model, no real key.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canSee, termsOf } from '@dsh-bridge/knowledge'
import { S, startWithPeople } from './helpers.mjs'

const MASTER = 'cd'.repeat(32)
const LLM_KEY = 'test-llm-key-not-real'
const RESTRICTED = '## Remote work {#remote roles=admin,manager}\nManagers may allow remote work on two days a week. The facilities team lends the laptops.'
const DOC = `Rules for working from home (fictional).\n\n## Equipment {#equipment}\nThe facilities team lends a laptop and a headset.\n\n${RESTRICTED}\n`

// ── the mock model server ───────────────────────────────────────────────────────────────────────────────────────────────
const calls = { chat: 0, embeddings: 0, embeddedTexts: 0, auth: new Set() }
let down = false
function vector(text) {
  const v = new Array(64).fill(0)
  for (const t of termsOf(text)) {
    let h = 2166136261
    for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0
    v[h % 64] += 1
  }
  return v
}
function extraction(text) {
  const entities = []
  const relations = []
  const add = (name, type) => { if (text.toLowerCase().includes(name.toLowerCase())) entities.push({ name, type }) }
  for (const [n, t] of [['annual leave', 'rule'], ['carry-over', 'rule'], ['manager', 'role'], ['remote work', 'rule'], ['facilities team', 'team'], ['laptop', 'thing'], ['有給休暇', 'rule'], ['年假', 'rule']]) add(n, t)
  if (entities.some((e) => e.name === 'facilities team') && entities.some((e) => e.name === 'laptop')) relations.push({ from: 'facilities team', to: 'laptop', type: 'lends' })
  return { entities, relations }
}
const model = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    calls.auth.add(req.headers.authorization ?? '')
    if (down) { res.writeHead(503); return res.end('down') }
    const body = JSON.parse(raw || '{}')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.endsWith('/embeddings')) {
      calls.embeddings += 1
      calls.embeddedTexts += body.input.length
      return res.end(JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: vector(t) })) }))
    }
    calls.chat += 1
    const user = body.messages.at(-1).content
    const content = /connection test/.test(user) ? { ok: true } : extraction(user)
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
  })
})

let env
let dir
let modelUrl
const admin = () => env.people.admin.web
const put = (body, headers = admin()) => env.call('PUT', '/api/agent/settings', { headers, body })
async function search(person, q) {
  const r = await env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=5`, { headers: person.web })
  assert.equal(r.status, 200)
  return r.body
}
async function events(type) {
  return (await env.call('GET', '/bridge/v1/events?after=0', { headers: S })).body.events.filter((e) => e.type === type)
}
/** Every answer to every employee holds only chunks they may read (the eval questions + every heading). */
async function permissionProperty() {
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))
  const qs = [...new Set([...index.chunks.map((c) => c.heading).filter(Boolean), 'remote work', 'facilities team laptop', 'year-end blackout', '有給休暇', '年假'])]
  let n = 0
  for (const person of Object.values(env.people)) {
    for (const q of qs) {
      for (const r of (await search(person, q)).results) {
        assert.ok(canSee(byId.get(r.id).visibility, { id: person.id, role: person.role }), `${person.role} got ${r.id} for "${q}"`)
        n += 1
      }
    }
  }
  return n
}

before(async () => {
  await new Promise((r) => model.listen(0, '127.0.0.1', r))
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`
  dir = mkdtempSync(join(tmpdir(), 'leave-agent-test-'))
  env = await startWithPeople({ dataDir: dir, agentEnv: { AGENT_SETTINGS_KEY: MASTER, TEST_LLM_KEY: LLM_KEY } })
  const u = await env.srv.app.createUser({ loginId: 'admin2', password: 'password-1234', role: 'admin', displayName: 'Test admin2' })
  const r = await env.call('POST', '/api/auth/login', { body: { loginId: 'admin2', password: 'password-1234' } })
  env.people.admin2 = { id: u.id, role: 'admin', web: { cookie: r.headers.get('set-cookie').split(';')[0] } }
})
after(async () => {
  await env?.srv.stop()
  model.close()
  rmSync(dir, { recursive: true, force: true })
})

test('only administrators reach the settings; no delegation does; the screen is the plugin\'s', async () => {
  for (const who of ['manager', 'staff1']) {
    assert.equal((await env.call('GET', '/agent-settings', { headers: env.people[who].web })).status, 403, who)
    assert.equal((await env.call('GET', '/api/agent/settings', { headers: env.people[who].web })).status, 403, who)
  }
  const ai = await env.delegated(env.people.admin)
  assert.ok([401, 403].includes((await env.call('GET', '/api/agent/settings', { headers: ai })).status), 'the AI acting as the admin gets nothing')
  assert.ok([401, 403].includes((await env.call('POST', '/api/agent/documents', { headers: ai, body: { title: 'x', roles: ['staff'], text: 'x' } })).status))
  const screen = await env.call('GET', '/agent-settings?lang=zh', { headers: admin() })
  assert.equal(screen.status, 200)
  assert.match(screen.body, /<html lang="zh">[\s\S]*AI 代理设置/)
  assert.equal((await env.call('GET', '/api/agent/settings', { headers: admin() })).body.settings.knowledge.mode, 'bm25f')
})

test('models: keys as variable names or sealed, never shown; connection test; the DSH overlay names the variable', async () => {
  const r = await put({ llm: { base: { baseUrl: modelUrl, model: 'mock-chat', apiKeyEnv: 'TEST_LLM_KEY' }, embedding: { enabled: true, baseUrl: modelUrl, model: 'mock-emb', apiKey: 'sk-stored-test-7777' } } })
  assert.equal(r.status, 200)
  const text = JSON.stringify(r.body)
  assert.ok(!text.includes('sk-stored-test') && !text.includes(LLM_KEY))
  assert.deepEqual(r.body.settings.llm.base.key, { set: true, source: 'env', hint: null })
  assert.deepEqual(r.body.settings.llm.embedding.key, { set: true, source: 'stored', hint: '…7777' })
  assert.ok(!readFileSync(join(dir, 'agent-settings.json'), 'utf8').includes('sk-stored-test'), 'sealed on disk too')
  const t = await env.call('POST', '/api/agent/settings/test', { headers: admin(), body: { target: 'base' } })
  assert.equal(t.body.result.ok, true)
  assert.equal((await env.call('POST', '/api/agent/settings/test', { headers: admin(), body: { target: 'embedding' } })).body.result.dimensions, 64)
  assert.ok(calls.auth.has(`Bearer ${LLM_KEY}`) && calls.auth.has('Bearer sk-stored-test-7777'))
  const overlay = await env.call('GET', '/api/agent/settings/dsh-overlay', { headers: admin() })
  assert.match(overlay.body, /apiKeyEnv: TEST_LLM_KEY/)
  assert.ok(!overlay.body.includes(LLM_KEY))
  assert.equal((await put({ llm: { base: { baseUrl: 'ftp://x' } } })).body.error, 'invalid_url')
  assert.equal((await put({ knowledge: { mode: 'vectors' } })).body.error, 'invalid_mode')
})

let doc
test('a document: upload → approval card for the OTHER administrators (framework approvals) → published → found by its roles only → report', async () => {
  const up = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Remote work rules', roles: ['admin', 'manager', 'staff'], keywords: ['remote work', 'home office'], text: DOC } })
  assert.equal(up.status, 201)
  doc = up.body.document
  assert.equal(doc.status, 'pending')
  const requested = (await events('approval.requested')).find((e) => e.payload.subjectId === doc.id)
  assert.equal(requested.payload.subjectType, 'knowledge_document')
  const a = await env.srv.app.kit.hooks.approvals.get(requested.payload.approvalId)
  assert.deepEqual((await env.srv.app.kit.hooks.approvals.approvers(a)).map((u) => u.id), [env.people.admin2.id], 'the uploader never approves their own')
  assert.match(JSON.stringify(await env.srv.app.kit.hooks.approvals.card(a)), /Knowledge document/)
  assert.ok(!(await search(env.people.manager, 'remote work two days')).results.some((r) => r.documentId === doc.id), 'not searchable before the approval')
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: admin(), body: { action: 'approve' } })).status, 403)
  assert.equal((await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 403)
  const ok = await env.call('POST', `/api/agent/documents/${doc.id}/decision`, { headers: env.people.admin2.web, body: { action: 'approve' } })
  assert.equal(ok.status, 200)
  await env.srv.app.agent.idle()
  const m = await search(env.people.manager, 'remote work two days a week')
  assert.equal(m.results[0].id.startsWith(`${doc.id}:`), true)
  assert.match(m.results[0].source.url, new RegExp(`^/handbook/${doc.id}#remote$`))
  assert.ok(!(await search(env.people.staff1, 'remote work two days a week')).results.some((r) => r.text.includes('two days')), 'the restricted section: managers only')
  const handbook = await env.call('GET', `/handbook/${doc.id}`, { headers: env.people.staff1.web })
  assert.equal(handbook.status, 200)
  assert.ok(handbook.body.includes('headset') && !handbook.body.includes('two days'))
  const report = (await events('knowledge.updated')).at(-1)
  assert.deepEqual(Object.keys(report.payload).sort(), ['buildId', 'chunks', 'documents', 'failed', 'rejected'])
  const to = await env.srv.app.kit.hooks.recipientsFor({ type: 'knowledge.updated', payload: report.payload })
  assert.deepEqual(to.users.map((u) => u.role).sort(), ['admin', 'admin'], 'the report roles (admin by default)')
  assert.deepEqual(to.paramsFor(to.users[0]), { documents: report.payload.documents, chunks: report.payload.chunks, rejected: 0, failed: 0 })
  assert.equal((await env.srv.app.kit.hooks.recipientsFor({ type: 'leave.unanswered', payload: { leaveRequestId: 'x' } })).stale, 'deleted', 'other events still go to the system\'s own rule')
})

test('a document with personal data is refused and its text is not kept; a bad section is a 400', async () => {
  const r = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Desk contacts', roles: ['admin'], text: 'Write to desk@example.com or call 03-1234-5678.' } })
  assert.equal(r.body.document.status, 'personal_data')
  assert.deepEqual(r.body.document.kinds, ['email', 'phone'])
  assert.ok(!readdirSync(join(dir, 'documents')).some((f) => f === `${r.body.document.id}.md`))
  const bad = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Wide', roles: ['manager'], text: '## Open {#open roles=staff}\ntext' } })
  assert.equal(bad.status, 400)
  assert.equal((await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'x', roles: ['boss'], text: 'x' } })).body.error, 'invalid_roles')
})

test('RAG: vectors in the file vector store, never re-embedded; still permissions first', async () => {
  const r = await put({ knowledge: { mode: 'rag' } })
  assert.equal(r.body.knowledge.service, 'hybrid')
  assert.deepEqual(r.body.knowledge.failed, [])
  assert.ok(existsSync(join(dir, 'vectors.json')))
  assert.ok(!readFileSync(join(dir, 'vectors.json'), 'utf8').includes('facilities team'), 'hashes, not text')
  const before = calls.embeddedTexts
  const again = await env.call('POST', '/api/agent/knowledge/rebuild', { headers: admin() })
  assert.equal(again.body.knowledge.stats.embedded, 0)
  assert.equal(calls.embeddedTexts, before, 'unchanged chunks are not sent again')
  assert.ok(await permissionProperty() > 50)
})

test('knowledge graph: a JSON file of names, types and chunk IDs; graph + BM25F; still permissions first', async () => {
  const r = await put({ knowledge: { mode: 'graph' } })
  assert.equal(r.body.knowledge.service, 'lexical+graph')
  assert.ok(r.body.knowledge.stats.entities > 0)
  const kg = JSON.parse(readFileSync(join(dir, 'knowledge-graph.json'), 'utf8'))
  assert.ok(kg.entities.some((e) => e.name === 'facilities team') && kg.relations.some((x) => x.type === 'lends'))
  assert.ok(!JSON.stringify(kg).includes('headset'), 'no chunk text in the graph file')
  const chatBefore = calls.chat
  await env.call('POST', '/api/agent/knowledge/rebuild', { headers: admin() })
  assert.equal(calls.chat, chatBefore, 'unchanged chunks are not sent to the model again')
  const m = await search(env.people.manager, 'facilities team')
  assert.ok(m.results.some((x) => x.id.startsWith(`${doc.id}:`)))
  assert.ok(await permissionProperty() > 50)
})

test('a model that fails: BM25F keeps answering, the failure is in the status and in the report', async () => {
  await put({ knowledge: { mode: 'rag' } })
  down = true
  try {
    await env.call('POST', `/api/agent/documents`, { headers: admin(), body: { title: 'Parking', roles: ['staff', 'manager', 'admin'], text: 'Bicycles park behind the building.' } })
    await put({ sns: { requireApproval: false } })
    const fresh = await env.call('POST', '/api/agent/documents', { headers: admin(), body: { title: 'Lockers', roles: ['staff', 'manager', 'admin'], text: 'Lockers are on the second floor.' } })
    assert.equal(fresh.body.document.status, 'published', 'no approval needed now')
    await env.srv.app.agent.idle()
    const st = (await env.call('GET', '/api/agent/knowledge/status', { headers: admin() })).body.knowledge
    assert.equal(st.service, 'lexical')
    assert.ok(st.failed.some((f) => f.startsWith('embed')))
    assert.equal((await search(env.people.staff1, 'lockers second floor')).found, true, 'BM25F still answers')
    assert.ok((await events('knowledge.updated')).at(-1).payload.failed >= 1)
  } finally {
    down = false
  }
})
