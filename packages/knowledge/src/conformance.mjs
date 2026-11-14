// Conformance checks of the optional Bridge v1 capability `knowledge` (GET /bridge/v1/knowledge/search), over HTTP.
// Meant to move into @dsh-bridge/protocol's suite once the capability is part of Bridge v1 (see docs/KNOWLEDGE_API.md).
//
//   const results = await runKnowledgeChecks({ baseUrl, serviceToken, fixtures })
//   fixtures = {
//     probe: { query, documentId }       a question that hits a document only the `allowed` askers may read
//     allowed: [{ label, headers }]      askers who may read it: web sessions and delegations (x-service-token + x-delegation-token)
//     denied:  [{ label, headers }]      askers who may NOT read it (other roles, other employees, their delegations)
//     notPermitted?: [{ label, headers }] delegations of a role the manifest's knowledge tool does not list (expect 403)
//   }
//   -> [{ id, title, state: 'pass' | 'fail' | 'skip', note }]
// The rule every check serves: a search never returns a chunk its asker may not read — and never tells that one exists.
import { KNOWLEDGE_SEARCH_PATH } from './routes.mjs'

const RESULT_KEYS = ['documentId', 'heading', 'id', 'score', 'source', 'text', 'title']
const BODY_KEYS = ['found', 'ok', 'query', 'results']

export const KNOWLEDGE_CHECKS = Object.freeze([
  { id: 'K-01', title: 'no credentials → 401' },
  { id: 'K-02', title: 'the service principal alone (no employee) → 403' },
  { id: 'K-03', title: 'q missing → 400 q_required; limit out of 1–5 → 400 invalid_limit' },
  { id: 'K-04', title: 'an asker who may read the probe document finds it (web session and delegation)' },
  { id: 'K-05', title: 'an asker who may not read it never gets a chunk of it (web session and delegation)' },
  { id: 'K-06', title: 'the answer has only the documented fields; sources are screen paths / URLs, not free text' },
  { id: 'K-07', title: 'the answer to a denied asker has the same shape as a "nothing found" answer (no hint that something is hidden)' },
  { id: 'K-08', title: 'a delegation of a role the manifest\'s knowledge tool does not list → 403 delegation_not_permitted' },
])

export async function runKnowledgeChecks({ baseUrl, serviceToken, fixtures, path = KNOWLEDGE_SEARCH_PATH, fetchImpl = fetch }) {
  const get = async (headers, params) => {
    const url = new URL(path, baseUrl)
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
    const res = await fetchImpl(url, { headers })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, body }
  }
  const out = []
  const run = async (id, fn) => {
    const title = KNOWLEDGE_CHECKS.find((c) => c.id === id)?.title ?? id
    try {
      const note = await fn()
      out.push({ id, title, state: note === 'skip' ? 'skip' : 'pass', note: note === 'skip' ? 'no fixture' : (note ?? '') })
    } catch (error) {
      out.push({ id, title, state: 'fail', note: error.message })
    }
  }
  const must = (cond, msg) => { if (!cond) throw new Error(msg) }
  const { probe, allowed = [], denied = [], notPermitted = [] } = fixtures
  const q = { q: probe.query }

  await run('K-01', async () => {
    const r = await get({}, q)
    must(r.status === 401, `expected 401, got ${r.status}`)
  })
  await run('K-02', async () => {
    const r = await get({ 'x-service-token': serviceToken }, q)
    must(r.status === 403, `expected 403, got ${r.status}`)
  })
  await run('K-03', async () => {
    const who = allowed[0]?.headers
    must(who, 'needs an allowed asker')
    const a = await get(who, {})
    must(a.status === 400 && a.body?.error === 'q_required', `q missing: expected 400 q_required, got ${a.status} ${a.body?.error}`)
    for (const limit of ['0', '6', 'x']) {
      const b = await get(who, { ...q, limit })
      must(b.status === 400 && b.body?.error === 'invalid_limit', `limit=${limit}: expected 400 invalid_limit, got ${b.status} ${b.body?.error}`)
    }
  })
  const answers = new Map()
  await run('K-04', async () => {
    must(allowed.length, 'needs allowed askers')
    for (const a of allowed) {
      const r = await get(a.headers, q)
      must(r.status === 200, `${a.label}: expected 200, got ${r.status}`)
      must(r.body.results.some((x) => x.documentId === probe.documentId), `${a.label}: the probe document was not found`)
      answers.set(a.label, r.body)
    }
    return `${allowed.length} asker(s)`
  })
  await run('K-05', async () => {
    must(denied.length, 'needs denied askers')
    for (const d of denied) {
      for (const params of [q, { ...q, limit: '5' }]) {
        const r = await get(d.headers, params)
        must(r.status === 200, `${d.label}: expected 200 (an empty or other answer, not an error), got ${r.status}`)
        const leaked = r.body.results.filter((x) => x.documentId === probe.documentId)
        must(!leaked.length, `${d.label}: got chunk(s) ${leaked.map((x) => x.id).join(', ')} of the probe document`)
        answers.set(d.label, r.body)
      }
    }
    return `${denied.length} asker(s)`
  })
  await run('K-06', async () => {
    must(answers.size, 'no answers to inspect')
    for (const [label, body] of answers) {
      must(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(BODY_KEYS), `${label}: body keys ${Object.keys(body).sort()}`)
      for (const r of body.results) {
        must(JSON.stringify(Object.keys(r).sort()) === JSON.stringify(RESULT_KEYS), `${label}: result keys ${Object.keys(r).sort()}`)
        must(r.source && typeof r.source.title === 'string' && typeof r.source.url === 'string', `${label}: source must be { title, url }`)
        must(/^(?:https?:\/\/[^\s/]+)?\/(?!\/)[^\s]*$/.test(r.source.url), `${label}: source url ${r.source.url} is not a screen path / URL`)
      }
    }
  })
  await run('K-07', async () => {
    must(denied.length, 'needs denied askers')
    const nothing = await get(denied[0].headers, { q: 'zzqx qqzx xqzz' })
    must(nothing.status === 200 && nothing.body.found === false && nothing.body.results.length === 0, 'a nonsense question must answer found=false with no results')
    for (const d of denied) {
      const r = answers.get(d.label)
      must(JSON.stringify(Object.keys(r).sort()) === JSON.stringify(Object.keys(nothing.body).sort()), `${d.label}: shape differs from a "nothing found" answer`)
      for (const k of ['hidden', 'total', 'withheld', 'denied']) must(!(k in r), `${d.label}: answer carries "${k}"`)
    }
  })
  await run('K-08', async () => {
    if (!notPermitted.length) return 'skip'
    for (const p of notPermitted) {
      const r = await get(p.headers, q)
      must(r.status === 403 && r.body?.error === 'delegation_not_permitted', `${p.label}: expected 403 delegation_not_permitted, got ${r.status} ${r.body?.error}`)
    }
    return `${notPermitted.length} delegation(s)`
  })
  return out
}
