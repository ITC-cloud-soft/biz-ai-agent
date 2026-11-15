// Week 3: the retrieval evals of the pilot (evals/knowledge.evals.json: 20 questions each in English, Japanese and Chinese,
// with the asker and the expected source) as a regression floor, and the permission property again with the optional
// vector side switched on (a deterministic stand-in for an embedding model: no model is chosen yet).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { canSee, formatEvalReport, runKnowledgeEvals, termsOf } from '@dsh-bridge/knowledge'
import { evalSetup } from '../evals/run.mjs'
import { startWithPeople } from './helpers.mjs'

/** The numbers measured when the suite was written (docs/STATUS.md). A change that lowers them fails here. */
const FLOOR = Object.freeze({ en: 16, ja: 18, zh: 16, leaks: 0 })

function fakeEmbedder() {
  return {
    id: 'fake-hashed-terms-128',
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(128).fill(0)
        for (const term of termsOf(t)) {
          let h = 2166136261
          for (const ch of term) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0
          v[h % 128] += 1
        }
        return v
      })
    },
  }
}

test('evals: 60 questions (en / ja / zh), hit@3 at least the measured floor, no leaks', async () => {
  const { service, suite } = await evalSetup()
  assert.equal(suite.cases.length, 60)
  for (const lang of ['en', 'ja', 'zh']) assert.equal(suite.cases.filter((c) => c.lang === lang).length, 20, lang)
  const report = await runKnowledgeEvals(service, suite)
  const md = formatEvalReport(report)
  for (const lang of ['en', 'ja', 'zh']) assert.ok(report.byLang[lang].passed >= FLOOR[lang], `${lang}: ${report.byLang[lang].passed} < ${FLOOR[lang]}\n${md}`)
  assert.equal(report.total.leaks, FLOOR.leaks, md)
})

test('evals with the vector side on: still no leaks (the numbers of a stand-in embedder mean nothing)', async () => {
  const { service, suite } = await evalSetup({ embedder: fakeEmbedder(), minSimilarity: 0.5 })
  await service.ready()
  assert.equal(service.mode(), 'hybrid')
  const report = await runKnowledgeEvals(service, suite)
  assert.equal(report.total.leaks, 0, formatEvalReport(report))
})

let env
before(async () => { env = await startWithPeople({ knowledgeOptions: { embedder: fakeEmbedder(), minSimilarity: 0.3 } }) })
after(() => env?.srv.stop())

test('hybrid on the running pilot: every answer to every employee, web and delegation, holds only chunks they may read', async () => {
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))
  const { suite } = await evalSetup()
  const qs = [...new Set([...suite.cases.map((c) => c.q), ...index.chunks.map((c) => c.heading).filter(Boolean)])]
  let checked = 0
  for (const person of Object.values(env.people)) {
    const asker = { id: person.id, role: person.role }
    for (const headers of [person.web, await env.delegated(person)]) {
      for (const q of qs) {
        const r = await env.call('GET', `/bridge/v1/knowledge/search?q=${encodeURIComponent(q)}&limit=5`, { headers })
        assert.equal(r.status, 200)
        for (const x of r.body.results) {
          assert.ok(canSee(byId.get(x.id).visibility, asker), `${person.role} got ${x.id} for "${q}"`)
          checked += 1
        }
      }
    }
  }
  assert.ok(checked > 500, `checked ${checked} results`)
})
