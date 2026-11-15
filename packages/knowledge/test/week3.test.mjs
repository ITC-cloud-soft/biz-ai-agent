// Week 3: the /pii-scan screen, the optional embedder with RRF, the reranker hook, the evals runner. No model anywhere: a
// deterministic fake embedder (hashed terms) stands in for one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  bridgePiiScreen, buildKnowledgeIndex, canSee, cosine, createKnowledgeService, formatEvalReport, httpEmbedder, parseKnowledgeMarkdown, rrf,
  runKnowledgeEvals, termsOf,
} from '../src/index.mjs'

const ROLES = ['admin', 'manager', 'staff']
const MD = `---
id: travel-policy
title: Travel policy
link: /handbook/travel-policy
roles: [admin, manager, staff]
keywords: [business trip, expenses]
---
Rules for business trips (fictional).

## Booking {#booking}
Book trains and hotels through the travel desk at least 3 days ahead.

## Expense limits {#limits roles=admin,manager}
Hotel up to 15000 yen per night. Managers approve expense claims within 5 working days.

## 出張の精算 {#seisan}
出張の精算は帰ってから 10 日以内に申請してください。
`
const staff = { id: 's1', role: 'staff' }
const manager = { id: 'm1', role: 'manager' }

/** A stand-in for an embedding model: terms hashed into 64 buckets (similar wording → similar vectors). */
function fakeEmbedder({ calls = [] } = {}) {
  return {
    id: 'fake-64',
    async embed(texts) {
      calls.push(texts.length)
      return texts.map((t) => {
        const v = new Array(64).fill(0)
        for (const term of termsOf(t)) {
          let h = 0
          for (const ch of term) h = (h * 31 + ch.codePointAt(0)) >>> 0
          v[h % 64] += 1
        }
        return v
      })
    },
  }
}

test('pii screen = POST /bridge/v1/pii-scan: protocol shapes (prose skipped) + hooks.piiScan; a failing hook fails the build', async () => {
  const screen = bridgePiiScreen({ hooks: { piiScan: async (t) => ({ kinds: /Hanako/.test(t) ? ['staff_name', 'Bad Kind!'] : [] }) } })
  assert.deepEqual((await screen('年假 15 天，12 月 15 日至 31 日。Hotel up to 15000 yen.')).kinds, [], 'prose, dates and amounts are fine')
  assert.deepEqual((await screen('mail desk@example.co.jp')).kinds, ['email'])
  assert.deepEqual((await screen('〒100-0001')).kinds, ['postal_code'])
  assert.deepEqual((await screen('ask Hanako')).kinds, ['staff_name'], 'hook kinds kept, malformed ones dropped')
  const doc = parseKnowledgeMarkdown(MD)
  const broken = bridgePiiScreen({ hooks: { piiScan: async () => { throw new Error('roster down') } } })
  await assert.rejects(buildKnowledgeIndex([doc], { roles: ROLES, screen: broken }), /personal-data check \(hooks\.piiScan\) failed — nothing is indexed/)
})

test('rrf and cosine', () => {
  assert.deepEqual(rrf([['a', 'b'], ['b', 'c']]).map((x) => x.id), ['b', 'a', 'c'])
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1, 0, 0]), null)
  assert.equal(cosine(null, [1]), null)
})

test('hybrid: the vector side ranks visible chunks only — the same answers as an index without the hidden chunk', async () => {
  const calls = []
  const full = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const cut = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD.replace(/## Expense limits[\s\S]*?(?=## 出張)/, '## Expense limits {#limits roles=admin,manager}\n\n'))], { roles: ROLES })
  const a = createKnowledgeService(full, { embedder: fakeEmbedder({ calls }), minSimilarity: 0.3 })
  const b = createKnowledgeService(cut, { embedder: fakeEmbedder(), minSimilarity: 0.3 })
  await a.ready()
  assert.equal(a.mode(), 'hybrid')
  assert.deepEqual(calls, [4], 'chunks embedded in one batch at start')
  for (const q of ['hotel expense per night', 'book trains', 'business trip', '出張の精算', 'managers approve claims']) {
    const ra = await a.search(q, { asker: staff, limit: 5 })
    assert.deepEqual(ra, await b.search(q, { asker: staff, limit: 5 }), q)
    for (const r of ra.results) assert.ok(canSee(full.chunks.find((c) => c.id === r.id).visibility, staff), `${q}: ${r.id}`)
  }
  const m = await a.search('hotel expense per night', { asker: manager })
  assert.equal(m.results[0].id, 'travel-policy:2:0', 'the manager gets the restricted section')
  // the cache: a rebuild with the same chunks embeds nothing again
  await a.setIndex(full)
  assert.deepEqual(calls, [4, 1, 1, 1, 1, 1, 1], 'only the questions were embedded since')
})

test('hybrid: an embedder that fails falls back to BM25F (same shape, onError told)', async () => {
  const errors = []
  const index = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const bad = { id: 'down', embed: async () => { throw new Error('503') } }
  const svc = createKnowledgeService(index, { embedder: bad, onError: (e, x) => errors.push(x.stage) })
  const lexical = createKnowledgeService(index)
  assert.deepEqual(await svc.search('book trains hotels', { asker: staff }), await lexical.search('book trains hotels', { asker: staff }))
  assert.deepEqual(errors, ['embed_index'])
})

test('rerank: reorders and drops the permitted candidates, can never add one', async () => {
  const index = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const seen = []
  const svc = createKnowledgeService(index, {
    minCoverage: 0, minScore: 0, // every chunk that shares a term is a candidate here
    rerank: async (_q, pool) => {
      seen.push(...pool.map((x) => x.chunk.id))
      return [{ id: 'travel-policy:2:0' }, ...[...pool].reverse()] // tries to inject the hidden chunk
    },
  })
  const r = await svc.search('business trip expenses', { asker: staff, limit: 5 })
  assert.ok(!seen.includes('travel-policy:2:0'), 'the reranker only sees what the asker may read')
  assert.ok(!r.results.some((x) => x.id === 'travel-policy:2:0'))
  assert.ok(r.results.length >= 2)
})

test('httpEmbedder: OpenAI-compatible request and answer; errors never echo the body', async () => {
  const got = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => {
      got.push({ headers: req.headers, body: JSON.parse(b) })
      if (req.url === '/fail') { res.writeHead(500); return res.end('secret echo of the input') }
      const { input } = JSON.parse(b)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: [t.length, 1] })).reverse() }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const e = httpEmbedder({ url: `${base}/embeddings`, model: 'any-model', headers: { 'api-key': 'test-key' } })
    assert.deepEqual(await e.embed(['ab', 'abcd']), [[2, 1], [4, 1]], 'sorted by index')
    assert.deepEqual(got[0].body, { input: ['ab', 'abcd'], model: 'any-model' })
    assert.equal(got[0].headers['api-key'], 'test-key')
    await assert.rejects(httpEmbedder({ url: `${base}/fail` }).embed(['x']), (err) => /answered 500/.test(err.message) && !/secret/.test(err.message))
    assert.throws(() => httpEmbedder({ url: 'file:///x' }), /url \(http\/https\) is required/)
  } finally {
    server.close()
  }
})

test('evals: hit@k, "nothing found" cases, leaks, the report', async () => {
  const index = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const svc = createKnowledgeService(index)
  const suite = {
    askers: { staff, manager },
    cases: [
      { id: 'en-1', lang: 'en', asker: 'staff', q: 'book trains ahead', expect: ['travel-policy#booking'] },
      { id: 'en-2', lang: 'en', asker: 'manager', q: 'hotel limit per night', expect: ['travel-policy#limits'] },
      { id: 'en-3', lang: 'en', asker: 'staff', q: 'hotel limit per night', expect: [] },
      { id: 'en-4', lang: 'en', asker: 'staff', q: 'parking permits for the office garage', expect: [] },
      { id: 'ja-1', lang: 'ja', asker: 'staff', q: '出張の精算はいつまで', expect: ['travel-policy#seisan'] },
      { id: 'ja-2', lang: 'ja', asker: 'staff', q: '出張の精算', expect: ['travel-policy#limits'] },
    ],
  }
  const report = await runKnowledgeEvals(svc, suite)
  assert.equal(report.total.cases, 6)
  assert.equal(report.total.leaks, 0)
  assert.deepEqual(report.failures.map((f) => f.id), ['ja-2'])
  assert.equal(report.byLang.en.passRate, 1)
  assert.equal(report.byLang.ja.unanswerable, 0)
  const md = formatEvalReport(report)
  assert.match(md, /\| en \| 4 \| 4 \(100%\) \|/)
  assert.match(md, /- ja-2 \(staff\) "出張の精算" — expected travel-policy#limits, got travel-policy#seisan/)
  await assert.rejects(runKnowledgeEvals(svc, { askers: {}, cases: [{ id: 'x', q: 'y', asker: 'nobody', expect: [] }] }), /unknown asker nobody/)
})
