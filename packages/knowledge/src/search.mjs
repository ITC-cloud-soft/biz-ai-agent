// Search of the knowledge index for ONE asker. Pure: no DB, no I/O.
//
//  - terms: the character bigrams of @dsh-bridge/help (NFKC, lower case, katakana → hiragana, no tokenizer for Japanese /
//    Chinese) for the non-Latin runs, whole words for Latin-script text (`w:leave`, light stemming) and numbers (`n:20`) —
//    English text adds no cross-word bigram noise
//  - score: BM25F over the fields title ×3, keywords ×3, heading ×2, body ×1 (the same formula and constants as help)
//  - PERMISSIONS FIRST: the chunks the asker may not read (canSee) are removed BEFORE any statistic is computed — document
//    frequencies, the average length and the number of chunks come from the asker's own visible chunks only. A hidden chunk
//    therefore changes neither the results nor their scores (no side channel), and is never returned
//  - found = coverage of the question's own terms ≥ minCoverage (idf-weighted) and score ≥ minScore
//  - at most perDocument chunks of one document; the source of a result is its document's screen link (+ #anchor)
import { DEFAULT_FILLERS, expandQuery, normalize, terms } from '@dsh-bridge/help/search'
import { canSee } from './visibility.mjs'

export const QUERY_MAX_CHARS = 200
export const DEFAULT_LIMIT = 3
export const MAX_LIMIT = 5
export const DEFAULT_MIN_COVERAGE = 0.5
export const DEFAULT_MIN_SCORE = 1
export const DEFAULT_PER_DOCUMENT = 2
export const SNIPPET_MAX_CHARS = 600
const FIELD_WEIGHTS = Object.freeze({ title: 3, keywords: 3, heading: 2, body: 1 })
const K1 = 1.2
const B = 0.75

/** help's question words plus the ones of questions about rules (when / how long / how many people …). Tune with the week-3 evals. */
export const KNOWLEDGE_FILLERS = Object.freeze([
  ...DEFAULT_FILLERS, 'いつまでに', 'いつまで', 'いつから', 'いつ', 'どのくらい', 'どれくらい', 'なんにちまで', 'なんにん', 'なにを', 'ですか', 'でしょうか', 'のは',
].sort((a, b) => b.length - a.length))

/** English words a question has whatever its subject (dropped from the question's word terms). */
export const STOP_WORDS = Object.freeze(new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'get', 'have', 'how', 'i', 'if', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'or', 'our', 'should', 'tell', 'the', 'there', 'this', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'you', 'your', 'about', 'please', 'any', 'many', 'much', 'need', 'know', 'want', 'way', 'there', 'than', 'into',
]))

/** Whole words of Latin-script text (3+ letters, lower case, a light plural / -ing / -ed stem), as `w:<word>` terms. */
export function wordTerms(text, { stop = null } = {}) {
  const out = []
  // hyphens and apostrophes split words: "carry-over" = carry + over, "manager's" = manager
  for (const w of String(text ?? '').normalize('NFKC').toLowerCase().replace(/'s\b/g, '').match(/[a-z][a-z0-9]*/g) ?? []) {
    if (w.length < 3 || (stop && stop.has(w))) continue
    out.push(`w:${stem(w)}`)
  }
  return out
}
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ied')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Numbers of a text (`n:20`), so "20 days" / 「5 日」 match on the number. */
export const numberTerms = (text) => (String(text ?? '').normalize('NFKC').match(/\d+/g) ?? []).map((d) => `n:${Number(d)}`)

/**
 * Character bigrams of the non-Latin runs only (Japanese / Chinese / Korean …): @dsh-bridge/help's normalize + terms per run.
 * Latin letters and digits are cut out first (they become word / number terms), so English text adds no cross-word bigrams.
 */
export const scriptBigrams = (norm) => norm.split(/[a-z0-9]+/).flatMap((run) => terms(run))

/** All terms of a text (script bigrams + words + numbers). */
export const termsOf = (text) => [...scriptBigrams(normalize(text)), ...wordTerms(text), ...numberTerms(text)]

const counts = (list) => {
  const m = new Map()
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/** The terms of a question: its own (fillers removed), and the extra ones from synonym groups. */
export function queryTerms(question, { synonyms = [], fillers = KNOWLEDGE_FILLERS } = {}) {
  const { parts, extra } = expandQuery(question, synonyms, fillers)
  const own = new Set([...parts.flatMap(scriptBigrams), ...wordTerms(question, { stop: STOP_WORDS }), ...numberTerms(question)])
  const all = new Set([...own, ...extra.flatMap(termsOf)])
  return { own, all }
}

/**
 * The searcher of an index (buildKnowledgeIndex).
 * @returns {{ rank(question, asker) -> [{ chunk, score, coverage }], chunk(id), visibleCount(asker) }}
 */
export function createKnowledgeSearcher(index, { synonyms = [], fillers = KNOWLEDGE_FILLERS } = {}) {
  const docs = index.chunks.map((c) => {
    const fields = { title: c.title, keywords: c.keywords.join(' '), heading: c.heading ?? '', body: c.text }
    const tf = {}
    let len = 0
    for (const [name, text] of Object.entries(fields)) {
      const list = termsOf(text)
      tf[name] = counts(list)
      len += FIELD_WEIGHTS[name] * list.length
    }
    return { chunk: c, tf, len }
  })
  const byId = new Map(index.chunks.map((c) => [c.id, c]))

  function rank(question, asker) {
    // permissions first: everything below sees only what this asker may read
    const visible = docs.filter((d) => canSee(d.chunk.visibility, asker))
    if (!visible.length) return []
    const { own, all } = queryTerms(question, { synonyms, fillers })
    if (!all.size) return []
    const n = visible.length
    const avgLen = visible.reduce((a, d) => a + d.len, 0) / n || 1
    const df = new Map()
    for (const t of all) {
      let k = 0
      for (const d of visible) if (Object.values(d.tf).some((m) => m.has(t))) k += 1
      df.set(t, k)
    }
    const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
    const ownIdf = [...own].reduce((a, t) => a + idf(t), 0) || 1
    const out = []
    for (const d of visible) {
      let score = 0
      let matched = 0
      for (const t of all) {
        let w = 0
        for (const name of Object.keys(FIELD_WEIGHTS)) w += FIELD_WEIGHTS[name] * (d.tf[name].get(t) ?? 0)
        if (!w) continue
        if (own.has(t)) matched += idf(t)
        score += idf(t) * (w * (K1 + 1)) / (w + K1 * (1 - B + B * (d.len / avgLen)))
      }
      if (score > 0) out.push({ chunk: d.chunk, score, coverage: Math.min(1, matched / ownIdf) })
    }
    return out.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  }

  return {
    rank,
    chunk: (id) => byId.get(id) ?? null,
    visibleCount: (asker) => docs.filter((d) => canSee(d.chunk.visibility, asker)).length,
  }
}

const joinUrl = (base, path) => `${String(base ?? '').replace(/\/+$/, '')}${path}`

/** A chunk's text cut for an answer (at a sentence end when it can). */
export function snippet(text, max = SNIPPET_MAX_CHARS) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const window = s.slice(0, max)
  const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf('\n'))
  return `${window.slice(0, cut >= max * 0.5 ? cut + 1 : max).trim()}…`
}

/** The source of a chunk: its document's screen on the business web (+ the section's anchor). */
export function sourceOf(chunk, webBase = '') {
  return {
    title: chunk.heading ? `${chunk.title} › ${chunk.heading}` : chunk.title,
    url: joinUrl(webBase, `${chunk.link}${chunk.anchor ? `#${chunk.anchor}` : ''}`),
  }
}

/**
 * Search for one asker.
 * @param {object} searcher        createKnowledgeSearcher(index)
 * @param {string} question        cut to QUERY_MAX_CHARS
 * @param {object} o
 * @param {{id, role}|null} o.asker   the employee asking (their own role and id; a delegation's employee)
 * @returns {{ found: boolean, results: object[] }}
 */
export function searchKnowledge(searcher, question, {
  asker = null, limit = DEFAULT_LIMIT, webBase = '', minCoverage = DEFAULT_MIN_COVERAGE, minScore = DEFAULT_MIN_SCORE, perDocument = DEFAULT_PER_DOCUMENT,
} = {}) {
  const text = String(question ?? '').slice(0, QUERY_MAX_CHARS)
  const n = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT))
  const perDoc = new Map()
  const results = []
  for (const r of searcher.rank(text, asker)) {
    if (results.length >= n) break
    if (r.score < minScore || r.coverage < minCoverage) continue
    const k = perDoc.get(r.chunk.documentId) ?? 0
    if (k >= perDocument) continue
    perDoc.set(r.chunk.documentId, k + 1)
    results.push({
      id: r.chunk.id,
      documentId: r.chunk.documentId,
      title: r.chunk.title,
      heading: r.chunk.heading,
      text: snippet(r.chunk.text),
      source: sourceOf(r.chunk, webBase),
      score: Math.round(r.score * 10) / 10,
    })
  }
  return { found: results.length > 0, results }
}
