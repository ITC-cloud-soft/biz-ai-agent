// The retrieval evals of equipment-loans (evals/knowledge.evals.json: 26 English, 23 Japanese and 23 Chinese questions, with
// the asker and the expected source) as a regression floor, and the permission property again with the optional vector side
// switched on (a deterministic stand-in for an embedding model: no model is chosen).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { canSee, formatEvalReport, runKnowledgeEvals, termsOf } from '@dsh-bridge/knowledge'
import { evalSetup } from '../evals/run.mjs'
import { startWithPeople } from './helpers.mjs'

/**
 * The numbers measured after tuning (README). First run, before any tuning: en 20 / 26, ja 18 / 23, zh 16 / 23, 0 leaks.
 * A change that lowers them fails here.
 */
const FLOOR = Object.freeze({ en: 22, ja: 20, zh: 21, leaks: 0 }) // zh 19 → 21 after ZH_FILLERS gained 哪些 / 有没有 / 怎么知道 / 怎么办 (a package change)
const SIZES = Object.freeze({ en: 26, ja: 23, zh: 23 })

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

test('evals: 72 questions (en / ja / zh, at least 20 each), hit@3 at least the measured floor and 80 %, no leaks', async () => {
  const { service, suite } = await evalSetup()
  assert.equal(suite.cases.length, 72)
  for (const lang of ['en', 'ja', 'zh']) assert.equal(suite.cases.filter((c) => c.lang === lang).length, SIZES[lang], lang)
  const report = await runKnowledgeEvals(service, suite)
  const md = formatEvalReport(report)
  for (const lang of ['en', 'ja', 'zh']) {
    assert.ok(report.byLang[lang].passed >= FLOOR[lang], `${lang}: ${report.byLang[lang].passed} < ${FLOOR[lang]}\n${md}`)
    assert.ok(report.byLang[lang].passRate >= 0.8, `${lang}: below 80 %\n${md}`)
  }
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

test('hybrid on the running system: every answer to every employee, web and delegation, holds only chunks they may read', async () => {
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
