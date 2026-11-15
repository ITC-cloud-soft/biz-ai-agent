// Retrieval evals: fixed questions, the asker who asks them, and the sources a correct answer must cite.
//
//   runKnowledgeEvals(service, suite, { k? }) -> report;  formatEvalReport(report) -> Markdown
//
// suite = {
//   askers: { <name>: { id, role } },                    fictional employees
//   cases: [{ id, lang, asker, q, expect: [source…], forbid?: [source…] }]
//          source = '<documentId>#<anchor>' or '<documentId>' (any section)
// }
// A case PASSES when one of its expected sources is among the first k results and no forbidden source is. With expect: []:
//  - and no forbid: it passes when NOTHING is found (a question the documents do not answer at all)
//  - with forbid: it passes when none of the forbidden sources is returned — the form for "an asker who may not read the
//    answer" when public sections on the same topic may rightly be found
// A forbidden source should be one the asker may not read anyway (the leak check covers that too); forbid makes the intent
// explicit and also catches a WRONG public section. Every result is also checked
// against the chunk's visibility: a result the asker may not read is a LEAK and fails the case, whatever else it returned.
// What counts as a correct source is a business decision: the suite is written (and reviewed) by the people who own the documents.
import { canSee } from './visibility.mjs'

const keyOf = (chunk) => (chunk.anchor ? `${chunk.documentId}#${chunk.anchor}` : chunk.documentId)
const matches = (chunk, want) => (want.includes('#') ? keyOf(chunk) === want : chunk.documentId === want)

export function checkSuite(suite) {
  const problems = []
  const askers = suite?.askers ?? {}
  const ids = new Set()
  for (const [i, c] of (Array.isArray(suite?.cases) ? suite.cases : []).entries()) {
    const where = c?.id ?? `#${i + 1}`
    if (typeof c?.id !== 'string' || ids.has(c.id)) problems.push(`${where}: a unique id is required`)
    ids.add(c?.id)
    if (typeof c?.q !== 'string' || !c.q.trim()) problems.push(`${where}: q is required`)
    if (!askers[c?.asker]) problems.push(`${where}: unknown asker ${c?.asker}`)
    if (!Array.isArray(c?.expect)) problems.push(`${where}: expect must be a list (empty = nothing may be found)`)
    if (c?.forbid !== undefined && !Array.isArray(c.forbid)) problems.push(`${where}: forbid must be a list`)
  }
  if (!ids.size) problems.push('no cases')
  if (problems.length) throw new Error(`knowledge evals: ${problems.length} problem(s):\n- ${problems.join('\n- ')}`)
}

export async function runKnowledgeEvals(service, suite, { k = 3 } = {}) {
  checkSuite(suite)
  const chunks = new Map(service.index().chunks.map((c) => [c.id, c]))
  const cases = []
  for (const c of suite.cases) {
    const asker = suite.askers[c.asker]
    const r = await service.search(c.q, { asker, limit: k })
    const got = r.results.map((x) => chunks.get(x.id))
    const leaks = got.filter((ch) => !ch || !canSee(ch.visibility, asker)).map((ch) => ch?.id ?? '?')
    const forbid = c.forbid ?? []
    const forbidden = got.filter((ch) => ch && forbid.some((w) => matches(ch, w))).map(keyOf)
    const none = forbid.length ? !forbidden.length : !r.found
    const hit = c.expect.length ? got.some((ch) => ch && c.expect.some((w) => matches(ch, w))) : none
    const top1 = c.expect.length ? Boolean(got[0] && c.expect.some((w) => matches(got[0], w))) : none
    const ok = !leaks.length && !forbidden.length
    cases.push({ id: c.id, lang: c.lang ?? '-', asker: c.asker, q: c.q, expect: c.expect, forbid, got: got.map((ch) => (ch ? keyOf(ch) : '?')), pass: hit && ok, top1: top1 && ok, leaks, forbidden })
  }
  const summarize = (list) => ({
    cases: list.length,
    passed: list.filter((x) => x.pass).length,
    top1: list.filter((x) => x.top1).length,
    answerable: list.filter((x) => x.expect.length).length,
    unanswerable: list.filter((x) => !x.expect.length).length,
    unanswerablePassed: list.filter((x) => !x.expect.length && x.pass).length,
    leaks: list.reduce((a, x) => a + x.leaks.length, 0),
    passRate: list.length ? list.filter((x) => x.pass).length / list.length : 0,
  })
  const byLang = {}
  for (const lang of [...new Set(cases.map((x) => x.lang))].sort()) byLang[lang] = summarize(cases.filter((x) => x.lang === lang))
  return { k, mode: typeof service.mode === 'function' ? service.mode() : 'lexical', total: summarize(cases), byLang, failures: cases.filter((x) => !x.pass), cases }
}

const pct = (x) => `${Math.round(x * 100)}%`

/** The report as Markdown (a table per language, then the failed cases). */
export function formatEvalReport(report) {
  const rows = [...Object.entries(report.byLang), ['all', report.total]].map(([lang, s]) => (
    `| ${lang} | ${s.cases} | ${s.passed} (${pct(s.passRate)}) | ${s.top1} | ${s.unanswerablePassed} / ${s.unanswerable} | ${s.leaks} |`
  ))
  const lines = [
    `Retrieval evals (${report.mode}, top ${report.k})`,
    '',
    `| lang | cases | passed (hit@${report.k}) | top 1 correct | "nothing found" correct | leaks |`,
    '|---|---|---|---|---|---|',
    ...rows,
  ]
  if (report.failures.length) {
    lines.push('', 'Failed:', '')
    for (const f of report.failures) lines.push(`- ${f.id} (${f.asker}) "${f.q}" — expected ${f.expect.length ? f.expect.join(' | ') : f.forbid.length ? `not ${f.forbid.join(' | ')}` : 'nothing'}, got ${f.got.length ? f.got.join(', ') : 'nothing'}${f.leaks.length ? ` — LEAK ${f.leaks.join(', ')}` : ''}${f.forbidden.length ? ` — FORBIDDEN ${f.forbidden.join(', ')}` : ''}`)
  }
  return lines.join('\n')
}
