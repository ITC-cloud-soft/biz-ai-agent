// Search of the knowledge index for ONE asker. Pure: no DB, no I/O.
//
//  - terms: the character bigrams of @dsh-bridge/help (NFKC, lower case, katakana → hiragana, no tokenizer for Japanese /
//    Chinese) for the non-Latin runs, whole words for Latin-script text (`w:leave`, light stemming) and numbers (`n:20`) —
//    English text adds no cross-word bigram noise
//  - score: BM25F over the fields title ×3, keywords ×3, heading ×2, body ×1 (the same formula and constants as help)
//  - PERMISSIONS FIRST: the chunks the asker may not read (canSee) are removed BEFORE any statistic is computed — document
//    frequencies, the average length and the number of chunks come from the asker's own visible chunks only. A hidden chunk
//    therefore changes neither the results nor their scores (no side channel), and is never returned
//  - found = coverage of the question's CONTENT terms ≥ minCoverage (idf-weighted; queryTerms) and score ≥ minScore
//  - at most perDocument chunks of one document; the source of a result is its document's screen link (+ #anchor)
import { DEFAULT_FILLERS, expandQuery, normalize, terms } from '@dsh-bridge/help/search'
import { canSee } from './visibility.mjs'
import { DEFAULT_MIN_SIMILARITY, cosine, rrf } from './hybrid.mjs'

export const QUERY_MAX_CHARS = 200
export const DEFAULT_LIMIT = 3
export const MAX_LIMIT = 5
export const DEFAULT_MIN_COVERAGE = 0.25
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
  'will', 'with', 'you', 'your', 'about', 'please', 'any', 'many', 'much', 'need', 'know', 'want', 'way', 'than', 'into',
  'was', 'were', 'has', 'had', 'been', 'being', 'would', 'did', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'won', 'whether', 'still', 'also',
  'just', 'some', 'they', 'them', 'their', 'its', 'very', 'too', 'more', 'most', 'then', 'here', 'these', 'those', 'such', 'happen', 'happens',
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

/**
 * Chinese question words (query side only). Kept to words and particles that never carry the subject of a question; single
 * characters that also start content words (有, 是, 在, 会, 要, 能) are NOT here. Tune with the evals.
 */
export const ZH_FILLERS = Object.freeze([
  '什么时候', '可不可以', '怎么知道', '能不能', '有没有', '怎么办', '怎么样', '为什么', '什么', '怎么', '怎样', '如何', '哪里', '哪儿', '哪些', '多少', '多久',
  '是否', '可以', '能否', '需要', '应该',
  '请问', '我的', '我们', '一下', '吗', '呢', '吧', '了', '的', '么', '谁', '也', '还',
].sort((a, b) => b.length - a.length))

/**
 * The content runs of a question: Japanese / Chinese text with the fillers removed and split at HIRAGANA runs (particles,
 * okurigana: the original script, before help's katakana folding), runs of one character dropped (verb stems like 休 / 取).
 * Katakana words and kanji / hanzi runs stay. Latin letters and digits are left to the word / number terms.
 */
export function contentRuns(question, fillers = [...KNOWLEDGE_FILLERS, ...ZH_FILLERS]) {
  let s = String(question ?? '').normalize('NFKC').toLowerCase().replace(/[a-z0-9]+/g, ' ')
  for (const f of fillers) s = s.split(String(f).normalize('NFKC').toLowerCase()).join(' ')
  return s.split(/[\p{Script=Hiragana}\s]+/u).map(normalize).filter((run) => run.length >= 2)
}

/**
 * The terms of a question:
 *  - own: its own terms (fillers removed) — they score
 *  - content: the terms that must be matched for "found" (coverage): content-run bigrams, words without stop words, numbers.
 *    A word of a synonym group found in the question counts as the group's FIRST word (the documents' word): its own terms
 *    leave the content and the first word's come in. Falls back to own when a question has no content (all hiragana, …)
 *  - all: own plus the synonym terms
 * Options (also on createKnowledgeSearcher / createKnowledgeService): synonyms [[documentWord, other…]…], fillers (Japanese /
 * general question words, added to ZH_FILLERS), stopWords (a Set of English words left out of the content).
 */
export function queryTerms(question, { synonyms = [], fillers = KNOWLEDGE_FILLERS, stopWords = STOP_WORDS } = {}) {
  const { parts, extra } = expandQuery(question, synonyms, fillers)
  const words = wordTerms(question, { stop: stopWords })
  const numbers = numberTerms(question)
  const own = new Set([...parts.flatMap(scriptBigrams), ...words, ...numbers])
  const content = new Set([...contentRuns(question, [...fillers, ...ZH_FILLERS]).flatMap(scriptBigrams), ...words, ...numbers])
  const joined = normalize(question)
  for (const group of synonyms) {
    const [first, ...others] = group.map(String)
    const hit = others.find((w) => normalize(w).length >= 2 && joined.includes(normalize(w)))
    if (!hit || joined.includes(normalize(first))) continue
    for (const t of termsOf(hit)) content.delete(t)
    for (const t of termsOf(first)) content.add(t)
  }
  const all = new Set([...own, ...content, ...extra.flatMap(termsOf)])
  return { own, content: content.size ? content : own, all }
}

/**
 * The searcher of an index (buildKnowledgeIndex).
 * @returns {{ rank(question, asker) -> [{ chunk, score, coverage }], chunk(id), visibleCount(asker) }}
 */
export function createKnowledgeSearcher(index, { synonyms = [], fillers = KNOWLEDGE_FILLERS, stopWords = STOP_WORDS } = {}) {
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
    const { content, all } = queryTerms(question, { synonyms, fillers, stopWords })
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
    const contentIdf = [...content].reduce((a, t) => a + idf(t), 0) || 1
    const out = []
    for (const d of visible) {
      let score = 0
      let matched = 0
      for (const t of all) {
        let w = 0
        for (const name of Object.keys(FIELD_WEIGHTS)) w += FIELD_WEIGHTS[name] * (d.tf[name].get(t) ?? 0)
        if (!w) continue
        if (content.has(t)) matched += idf(t)
        score += idf(t) * (w * (K1 + 1)) / (w + K1 * (1 - B + B * (d.len / avgLen)))
      }
      if (score > 0) out.push({ chunk: d.chunk, score, coverage: Math.min(1, matched / contentIdf) })
    }
    return out.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
  }

  return {
    rank,
    chunk: (id) => byId.get(id) ?? null,
    visible: (asker) => docs.filter((d) => canSee(d.chunk.visibility, asker)).map((d) => d.chunk),
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
 * The chunks that answer a question for one asker, best first: [{ chunk, score }]. Permission-filtered (the searcher ranks only
 * the asker's visible chunks), thresholds applied, not yet cut to a limit.
 *  - lexical (default): BM25F, kept when score ≥ minScore and coverage ≥ minCoverage
 *  - hybrid (o.vector = { query, vectors, minSimilarity? }): the lexical list and the visible chunks with cosine ≥ minSimilarity,
 *    fused with RRF (score = RRF × 100). Only the asker's visible chunks are ever compared.
 */
export function candidatesFor(searcher, question, {
  asker = null, minCoverage = DEFAULT_MIN_COVERAGE, minScore = DEFAULT_MIN_SCORE, vector = null,
} = {}) {
  const text = String(question ?? '').slice(0, QUERY_MAX_CHARS)
  const lexical = searcher.rank(text, asker).filter((r) => r.score >= minScore && r.coverage >= minCoverage)
  if (!vector?.query || !vector?.vectors) return lexical.map((r) => ({ chunk: r.chunk, score: r.score }))
  const minSimilarity = vector.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const semantic = searcher.visible(asker)
    .map((chunk) => ({ chunk, sim: cosine(vector.query, vector.vectors.get(chunk.id)) }))
    .filter((x) => x.sim !== null && x.sim >= minSimilarity)
    .sort((a, b) => b.sim - a.sim || a.chunk.id.localeCompare(b.chunk.id))
  const chunkOf = new Map([...lexical, ...semantic].map((x) => [x.chunk.id, x.chunk]))
  return rrf([lexical.map((r) => r.chunk.id), semantic.map((x) => x.chunk.id)]).map(({ id, score }) => ({ chunk: chunkOf.get(id), score: score * 100 }))
}

/** Candidates → the answer's results: at most limit (1–5), at most perDocument per document, with snippet and source. */
export function resultsOf(candidates, { limit = DEFAULT_LIMIT, webBase = '', perDocument = DEFAULT_PER_DOCUMENT } = {}) {
  const n = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT))
  const perDoc = new Map()
  const results = []
  for (const r of candidates) {
    if (results.length >= n) break
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

/**
 * Search for one asker (lexical; the service adds the optional vector side and reranker).
 * @param {object} searcher        createKnowledgeSearcher(index)
 * @param {string} question        cut to QUERY_MAX_CHARS
 * @param {object} o
 * @param {{id, role}|null} o.asker   the employee asking (their own role and id; a delegation's employee)
 * @returns {{ found: boolean, results: object[] }}
 */
export function searchKnowledge(searcher, question, {
  asker = null, limit = DEFAULT_LIMIT, webBase = '', minCoverage = DEFAULT_MIN_COVERAGE, minScore = DEFAULT_MIN_SCORE, perDocument = DEFAULT_PER_DOCUMENT, vector = null,
} = {}) {
  return resultsOf(candidatesFor(searcher, question, { asker, minCoverage, minScore, vector }), { limit, webBase, perDocument })
}
