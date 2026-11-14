// Citations: an answer built from the knowledge search must cite its sources as [n] with the source's URL as returned.
// Pure. checkCitations judges an answer (evals, tests, a reply guard); ensureCitations repairs one that cites nothing.

const CITE_RE = /\[(\d{1,2})\]/g

/**
 * @param {string} answer
 * @param {Array<{n: number, source: {title, url}}>} sources   what the knowledge tool returned in this turn
 * @returns {{ ok: boolean, cited: number[], unknown: number[], missingUrls: number[], reason: string|null }}
 */
export function checkCitations(answer, sources) {
  const text = String(answer ?? '')
  const byN = new Map((Array.isArray(sources) ? sources : []).map((s) => [Number(s.n), s]))
  const cited = [...new Set([...text.matchAll(CITE_RE)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  const unknown = cited.filter((n) => !byN.has(n))
  const missingUrls = cited.filter((n) => byN.has(n) && byN.get(n).source?.url && !text.includes(byN.get(n).source.url))
  let reason = null
  if (!byN.size) reason = null
  else if (!cited.length) reason = 'no_citation'
  else if (unknown.length) reason = 'unknown_citation'
  else if (missingUrls.length) reason = 'source_url_missing'
  return { ok: !byN.size || reason === null, cited, unknown, missingUrls, reason }
}

/** The "Sources:" block of an answer: one line per source, the URL exactly as the business system returned it. */
export function sourcesBlock(sources, { heading = 'Sources:' } = {}) {
  return [heading, ...sources.map((s) => `[${s.n}] ${s.source.title} — ${s.source.url}`)].join('\n')
}

/**
 * An answer that passes checkCitations, unchanged; otherwise the answer with the sources appended (every returned source,
 * so the reader can check), and with citations of sources that were never returned marked as such.
 */
export function ensureCitations(answer, sources, { heading = 'Sources:' } = {}) {
  const verdict = checkCitations(answer, sources)
  if (verdict.ok) return String(answer ?? '')
  let text = String(answer ?? '')
  for (const n of verdict.unknown) text = text.replaceAll(`[${n}]`, '[?]')
  const used = verdict.cited.filter((n) => !verdict.unknown.includes(n))
  const list = (Array.isArray(sources) ? sources : []).filter((s) => !used.length || used.includes(Number(s.n)))
  return `${text.trimEnd()}\n\n${sourcesBlock(list, { heading })}`
}
