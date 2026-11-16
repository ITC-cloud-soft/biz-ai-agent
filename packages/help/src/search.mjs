// Search of the manual for one asker. Pure: no DB, no I/O.
//
//  - normalize: NFKC, lower case, katakana → hiragana, no spaces / punctuation / symbols
//  - terms: character bigrams (a one-character text is its own term) — works for Japanese / Chinese without a tokenizer
//  - score: BM25F over the fields title ×3, keywords ×3, the questions of the FAQ ×2, the rest of the section ×1;
//    a question that is exactly a section's title (without its bracketed note) ×1.5
//  - the question is first stripped of the words every question has (どこ・どうやって・教えて… / where, how) and expanded with
//    the synonym groups (the group's first word is added)
//  - found = score ≥ minScore AND the matched terms cover ≥ minCoverage of the question's own terms. minScore is given for a manual of
//    REFERENCE_SECTIONS sections and scaled by the size of this one (idf grows with the number of sections)
//  - the asker's role orders the results: a screen the asker cannot open is demoted (still returned, with whom to ask instead);
//    `prefer` puts chapters first for a role (e.g. the mobile-app chapter for field staff)
// URLs are never made from free text: only the index's paths (the app's routes) on the web base the business system configures.
import { listPath } from './routes.mjs'

export const QUERY_MAX_CHARS = 200
export const DEFAULT_LIMIT = 3
export const MAX_LIMIT = 5
export const DEFAULT_MIN_SCORE = 8
/** The manual size DEFAULT_MIN_SCORE was tuned on (163 sections); a smaller manual has smaller scores. */
export const REFERENCE_SECTIONS = 163
const maxIdf = (n) => Math.log(1 + (Math.max(1, n) - 0.5) / 1.5)
export const DEFAULT_MIN_COVERAGE = 0.5
export const DEFAULT_MANUAL_PAGE = '/help/{chapter}#{id}'
const FIELD_WEIGHTS = Object.freeze({ title: 3, keywords: 3, questions: 2, body: 1 })
const TITLE_BONUS = 1.5
const K1 = 1.2
const B = 0.75

/** Words of the question itself, not of the subject (longest first so 「どうやって」 goes before 「どう」). */
export const DEFAULT_FILLERS = Object.freeze([
  'どうすればいいですか', 'どうすればいい', 'どうしたらいいですか', 'どうしたらいい', 'どうやって', 'どうすれば', 'どうしたら', 'どこでできますか',
  'どこですか', 'どこで', 'どこから', 'どこに', 'どこ', 'おしえてください', 'おしえて', 'したいのですが', 'したいです', 'したい', 'できますか', 'できない',
  'ありますか', 'ほうほう', 'やりかた', 'てじゅん', 'ですか', 'ますか', 'について', 'のしかた', 'しかた', 'ください', 'わからない', 'みたい', 'ひらきたい', 'みれますか',
  'どうやるの', 'やるの', 'するの', 'のやりかた', 'ってどこ', 'はどこ', 'what', 'where', 'how', 'can', 'the',
])

/** NFKC, lower case, katakana → hiragana, only letters / digits / kana / kanji. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[^\p{L}\p{N}ー]+/gu, '')
}

/** Character bigrams of a normalized text (a one-character text is its own term). */
export function terms(norm) {
  if (norm.length < 2) return norm ? [norm] : []
  const out = []
  for (let i = 0; i < norm.length - 1; i++) out.push(norm.slice(i, i + 2))
  return out
}

const counts = (list) => {
  const m = new Map()
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/** The question without the filler words, plus the head word of every synonym group one of its words appears in. */
export function expandQuery(question, synonyms = [], fillers = DEFAULT_FILLERS) {
  let norm = normalize(question)
  for (const f of fillers) norm = norm.split(normalize(f)).join(' ')
  const parts = norm.split(' ').filter(Boolean)
  const joined = parts.join('')
  const extra = []
  for (const group of synonyms) {
    const words = group.map(normalize).filter(Boolean)
    if (words.some((w) => w.length >= 2 && joined.includes(w))) extra.push(words[0])
  }
  return { parts, extra }
}

function fieldsOf(s) {
  return {
    title: normalize(s.title),
    keywords: normalize(s.keywords.join(' ')),
    questions: normalize(s.qa.map((x) => x.q).join(' ')),
    body: normalize([s.menu, s.summary, ...s.can, ...s.steps, ...s.notes, ...s.qa.map((x) => x.a), s.app?.screen ?? '', s.app?.location ?? ''].join(' ')),
  }
}

/** The searcher of an index (buildHelpIndex). { rank(question), section(id), sections(), chapters() }. */
export function createSearcher(index, { fillers = DEFAULT_FILLERS } = {}) {
  const docs = index.sections.map((s) => {
    const f = fieldsOf(s)
    const tf = {}
    let len = 0
    for (const [name, text] of Object.entries(f)) {
      tf[name] = counts(terms(text))
      len += FIELD_WEIGHTS[name] * Math.max(0, text.length - 1)
    }
    return { section: s, tf, len, shortTitle: normalize(s.title.replace(/[（(].*$/, '')) }
  })
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length)
  const df = new Map()
  for (const d of docs) {
    for (const t of new Set(Object.values(d.tf).flatMap((m) => [...m.keys()]))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = (t) => {
    const n = df.get(t) ?? 0
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
  }
  const byId = new Map(index.sections.map((s) => [s.id, s]))

  /** [{ section, score, coverage }] best first (score > 0 only). */
  function rank(question) {
    const { parts, extra } = expandQuery(question, index.synonyms, fillers)
    const own = new Set(parts.flatMap(terms))
    const q = new Set([...own, ...extra.flatMap(terms)])
    if (!q.size) return []
    const ownIdf = [...own].reduce((a, t) => a + idf(t), 0) || 1
    const out = []
    for (const d of docs) {
      let score = 0
      let matched = 0
      for (const t of q) {
        let w = 0
        for (const name of Object.keys(FIELD_WEIGHTS)) w += FIELD_WEIGHTS[name] * (d.tf[name].get(t) ?? 0)
        if (!w) continue
        matched += idf(t)
        score += idf(t) * (w * (K1 + 1)) / (w + K1 * (1 - B + B * (d.len / avgLen)))
      }
      if (score > 0 && parts.some((p) => p === d.shortTitle)) score *= TITLE_BONUS
      if (score > 0) out.push({ section: d.section, score, coverage: Math.min(1, matched / ownIdf) })
    }
    return out.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
  }

  // the score threshold scale of this manual (1 for a manual of REFERENCE_SECTIONS sections)
  const scale = maxIdf(docs.length) / maxIdf(REFERENCE_SECTIONS)
  return { rank, scale, section: (id) => byId.get(id) ?? null, sections: () => index.sections, chapters: () => index.chapters }
}

/* ------------------------------------------------------------------ answers */

const joinUrl = (base, path) => `${String(base ?? '').replace(/\/+$/, '')}${path}`

/** Can this role open the section's screen (public sections: everyone, also a sender that is not linked). */
export const canUse = (section, role) => Boolean(section.public) || (Boolean(role) && section.roles.includes(role))

/** The default 「whom to ask」 text (Japanese; pass altText for other languages). */
export const defaultAltText = (labels) => `この画面は ${labels.join('・')} が使います。${labels.join('・')}にご依頼ください。`

/**
 * The answer form of one section for the asker.
 * @param {object} o
 * @param {string|null} o.role
 * @param {string} [o.webBase]       the business web's URL ('' → paths only)
 * @param {object} [o.roleLabels]    role → display name (for `alt`)
 * @param {string} [o.manualPage]    the manual page template: {chapter} / {id}
 * @param {(labels: string[]) => string} [o.altText]
 */
export function answerOf(section, { role, webBase = '', qaHits = [], roleLabels = {}, manualPage = DEFAULT_MANUAL_PAGE, altText = defaultAltText } = {}) {
  const canOpen = canUse(section, role)
  const path = [...section.paths, ...section.screens].map(listPath).find(Boolean) ?? null
  const labels = section.roles.map((r) => roleLabels[r] ?? r).filter(Boolean)
  return {
    id: section.id,
    title: section.title,
    chapter: section.chapter,
    menu: section.menu,
    summary: section.summary,
    steps: section.steps.slice(0, 6),
    qa: (qaHits.length ? qaHits : section.qa).slice(0, 2),
    notes: section.notes.slice(0, 3),
    app: section.app,
    canOpen,
    url: canOpen && path ? joinUrl(webBase, path) : null,
    manualUrl: manualPage ? joinUrl(webBase, manualPage.replace('{chapter}', section.chapter).replace('{id}', section.id)) : null,
    alt: canOpen || !labels.length ? null : altText(labels),
    unconfirmed: section.unconfirmed,
  }
}

/**
 * Search for one asker.
 * @param {object} searcher           createSearcher(index)
 * @param {string} question           cut to QUERY_MAX_CHARS
 * @param {object} o
 * @param {string|null} o.role        the asker's role; null = not linked → the public sections only
 * @param {boolean} [o.publicOnly]
 * @param {object} [o.prefer]         role → chapter id prefixes put first (×1.5), e.g. { staff: ['06-'] }
 * @param {number|object} [o.demote]  factor for a screen the asker cannot open (0.7), or { default, <role>: factor }
 * @returns {{ found: boolean, results: object[] }}
 */
export function searchManual(searcher, question, {
  role = null, webBase = '', limit = DEFAULT_LIMIT, publicOnly = false, roleLabels = {}, manualPage = DEFAULT_MANUAL_PAGE, altText = defaultAltText,
  prefer = {}, demote = 0.7, minScore = DEFAULT_MIN_SCORE, minCoverage = DEFAULT_MIN_COVERAGE,
} = {}) {
  const text = String(question ?? '').slice(0, QUERY_MAX_CHARS)
  const n = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT))
  const onlyPublic = publicOnly || !role
  const preferred = (role && prefer[role]) || []
  const demoteBy = typeof demote === 'number' ? demote : (demote[role] ?? demote.default ?? 0.7)
  const ranked = searcher.rank(text)
    .filter(({ section }) => !onlyPublic || section.public)
    .map(({ section, score, coverage }) => {
      let s = score
      if (!onlyPublic) {
        if (preferred.some((p) => section.chapter.startsWith(p))) s *= 1.5
        if (!canUse(section, role)) s *= demoteBy
      }
      return { section, score: s, coverage }
    })
    .sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
  const qn = terms(normalize(text))
  const threshold = minScore * (searcher.scale ?? 1)
  const results = ranked.filter((r) => r.score >= threshold && r.coverage >= minCoverage).slice(0, n).map(({ section, score }) => {
    const qaHits = section.qa.filter((x) => {
      const qt = new Set(terms(normalize(x.q)))
      return qn.filter((t) => qt.has(t)).length >= Math.min(3, qt.size)
    })
    return { ...answerOf(section, { role, webBase, qaHits, roleLabels, manualPage, altText }), score: Math.round(score * 10) / 10 }
  })
  return { found: results.length > 0, results }
}
