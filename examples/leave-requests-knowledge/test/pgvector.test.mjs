// RAG with the pgvector store on the running pilot: the vectors in PostgreSQL + pgvector (a real server with AGENT_TEST_PG_URL,
// otherwise PGlite — the same SQL), the vector search in SQL among the asker's visible chunks only, nothing re-embedded after a restart.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DB_KIND, testDb } from '../../../packages/agent-settings/test/db.mjs'
import { canSee, termsOf } from '@dsh-bridge/knowledge'
import { startWithPeople } from './helpers.mjs'

const calls = { embeddedTexts: 0 }
function vectorOf(text) {
  const v = new Array(64).fill(0)
  for (const t of termsOf(text)) {
    let h = 2166136261
    for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0
    v[h % 64] += 1
  }
  return v
}
const model = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    const { input } = JSON.parse(raw)
    calls.embeddedTexts += input.length
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }))
  })
})

let db
let closeDb
let modelUrl
const dirs = []
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'leave-pgvector-'))
  dirs.push(dir)
  const e = await startWithPeople({ dataDir: dir, vectorDb: db, agentEnv: { TEST_EMB_KEY: 'test-emb-key-not-real' } })
  const put = (body) => e.call('PUT', '/api/agent/settings', { headers: e.people.admin.web, body })
  await put({ llm: { embedding: { enabled: true, baseUrl: modelUrl, model: 'mock-emb', apiKeyEnv: 'TEST_EMB_KEY' } } })
  return { e, r: await put({ knowledge: { mode: 'rag', vectorStore: 'pgvector' } }) }
}

before(async () => {
  await new Promise((r) => model.listen(0, '127.0.0.1', r))
  modelUrl = `http://127.0.0.1:${model.address().port}/v1`
  ;({ db, close: closeDb } = await testDb({ tables: ['agent_vectors'] }))
})
after(async () => {
  model.close()
  await closeDb()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test(`with a database (${DB_KIND}) the default store is pgvector; RAG puts every chunk vector there (hashes, no text)`, async () => {
  const { e, r } = await start()
  try {
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.settings.vectorDb, { available: true, source: 'injected', table: 'agent_vectors' })
    assert.equal(r.body.knowledge.service, 'hybrid')
    assert.equal(r.body.knowledge.stats.store, 'pgvector')
    const chunks = e.srv.app.knowledge.index().chunks.length
    assert.equal(r.body.knowledge.stats.vectors, chunks)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM agent_vectors')).rows[0].n, chunks)
    assert.ok(!JSON.stringify((await db.query('SELECT digest, embedder FROM agent_vectors')).rows).includes('leave'), 'no text, only hashes')

    // permissions first: every answer to every employee on the web holds only chunks they may read
    const byId = new Map(e.srv.app.knowledge.index().chunks.map((c) => [c.id, c]))
    const restricted = [...byId.values()].filter((c) => !c.visibility.roles.includes('staff'))
    let n = 0
    for (const person of Object.values(e.people)) {
      for (const q of [...restricted.map((c) => c.text.slice(0, 120)), 'year-end blackout', 'carry over', '有給休暇の繰り越し', '经理的审批规则']) {
        const s = await e.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=5`, { headers: person.web })
        for (const x of s.body.results) {
          assert.ok(canSee(byId.get(x.id).visibility, { id: person.id, role: person.role }), `${person.role} got ${x.id}`)
          n += 1
        }
      }
    }
    assert.ok(n > 30, `checked ${n}`)
    const forManagers = restricted.find((c) => c.visibility.roles.includes('manager'))
    const m = await e.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(forManagers.text.slice(0, 120))}`, { headers: e.people.manager.web })
    assert.equal(m.body.results[0].id, forManagers.id, 'a manager gets a managers-only section by its own words')
  } finally {
    await e.srv.stop()
  }
})

test('a restart (new process state, same database) embeds nothing again', async () => {
  const before = calls.embeddedTexts
  const { e, r } = await start()
  try {
    assert.equal(r.body.knowledge.stats.store, 'pgvector')
    assert.equal(r.body.knowledge.stats.embedded, 0)
    assert.equal(calls.embeddedTexts, before, 'no chunk was sent to the embedding model again')
  } finally {
    await e.srv.stop()
  }
})

test('without a database pgvector cannot be chosen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leave-nodb-'))
  dirs.push(dir)
  const e = await startWithPeople({ dataDir: dir, agentEnv: {} })
  try {
    const r = await e.call('PUT', '/api/agent/settings', { headers: e.people.admin.web, body: { knowledge: { vectorStore: 'pgvector' } } })
    assert.equal(r.body.error, 'vector_db_unavailable')
    assert.equal((await e.call('GET', '/api/agent/settings', { headers: e.people.admin.web })).body.settings.knowledge.vectorStore, 'file')
  } finally {
    await e.srv.stop()
  }
})

test('AGENT_VECTOR_DB_URL: the plugin opens its own pg pool (the URL stays in the environment, never in the settings)', { skip: DB_KIND !== 'postgresql' && 'needs AGENT_TEST_PG_URL (a real server)' }, async () => {
  const url = process.env.AGENT_TEST_PG_URL
  const dir = mkdtempSync(join(tmpdir(), 'leave-pgenv-'))
  dirs.push(dir)
  const e = await startWithPeople({ dataDir: dir, agentEnv: { AGENT_VECTOR_DB_URL: url, TEST_EMB_KEY: 'test-emb-key-not-real' } })
  try {
    const put = (body) => e.call('PUT', '/api/agent/settings', { headers: e.people.admin.web, body })
    await put({ llm: { embedding: { enabled: true, baseUrl: modelUrl, model: 'mock-emb-env', apiKeyEnv: 'TEST_EMB_KEY' } } })
    const r = await put({ knowledge: { mode: 'rag' } })
    assert.deepEqual(r.body.settings.vectorDb, { available: true, source: 'env', table: 'agent_vectors' })
    assert.equal(r.body.settings.knowledge.vectorStore, 'pgvector', 'the default with a database')
    assert.equal(r.body.knowledge.stats.store, 'pgvector')
    assert.ok(!JSON.stringify(r.body).includes(new URL(url).password), 'the password never appears')
    assert.ok(!readFileSync(join(dir, 'agent-settings.json'), 'utf8').includes('postgres://'), 'nor in the settings file')
  } finally {
    await e.srv.stop()
  }
})
