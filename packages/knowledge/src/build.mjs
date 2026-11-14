// The knowledge index: documents → chunks with their visibility. No I/O except the personal-data screen you pass.
//
//   buildKnowledgeIndex(documents, { roles, routes?, maxChunkChars?, screen?, onPersonalData? }) -> index
//
//  - every document: id, title, link (a business screen path; with `routes`, it must be one of them — manifest web.routes),
//    visibility (documentVisibility), sections [{ heading, anchor?, roles?, users?, text }] or a Markdown `body`
//  - sections are cut into chunks of at most maxChunkChars at paragraph (then sentence) boundaries
//  - every chunk is screened for personal data BEFORE it enters the index: the local shape check (e-mail, phone numbers,
//    long numbers) plus `screen(text)` (the business system's own check, e.g. hooks.piiScan: names in its roster).
//    onPersonalData 'fail' (default): the build throws, listing chunk ids and kinds (never the text). 'skip': the chunk is
//    left out and listed in index.rejected
import { routeOf } from '@dsh-bridge/help/routes'
import { splitSections } from './markdown.mjs'
import { KnowledgeBuildError, documentVisibility, sectionVisibility } from './visibility.mjs'

export const KNOWLEDGE_INDEX_VERSION = 1
export const DEFAULT_MAX_CHUNK_CHARS = 800
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const ANCHOR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const LINK_RE = /^\/(?!\/)[A-Za-z0-9_./-]*$/

/** Shapes of personal data a document should never carry (the business system's screen adds names etc.). */
const LOCAL_PATTERNS = Object.freeze([
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['phone', /(?:^|[^\d])(?:0\d{1,4}-\d{1,4}-\d{3,4}|\+\d{1,3}[ -]?\d{1,4}[ -]?\d{2,4}[ -]?\d{3,4})(?!\d)/],
  ['long_number', /\d{10,}/],
])
export function localKinds(text) {
  const s = String(text ?? '').normalize('NFKC')
  return LOCAL_PATTERNS.filter(([, re]) => re.test(s)).map(([k]) => k)
}

/** Paragraphs packed into chunks of at most max characters; a longer paragraph is cut at sentence ends (or hard). */
export function chunkText(text, max = DEFAULT_MAX_CHUNK_CHARS) {
  const pieces = []
  for (const para of String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= max) { pieces.push(para); continue }
    let rest = para
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const cut = Math.max(...['。', '. ', '! ', '? ', '！', '？', '\n'].map((m) => window.lastIndexOf(m)))
      const at = cut >= max * 0.4 ? cut + 1 : max
      pieces.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) pieces.push(rest)
  }
  const chunks = []
  for (const p of pieces) {
    const last = chunks.at(-1)
    if (last !== undefined && last.length + 2 + p.length <= max) chunks[chunks.length - 1] = `${last}\n\n${p}`
    else chunks.push(p)
  }
  return chunks
}

/**
 * @param {object[]} documents
 * @param {object} o
 * @param {string[]} o.roles                the manifest's roles (manifestRoles(manifest) / kit.declaredRoles)
 * @param {Array<string|{path}>} [o.routes] the business web's screen routes (manifest web.routes): every link must be one
 * @param {(text: string) => Promise<{kinds: string[]}>|{kinds: string[]}} [o.screen]   the business system's personal-data check
 * @param {'fail'|'skip'} [o.onPersonalData]
 */
export async function buildKnowledgeIndex(documents, { roles, routes = null, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS, screen = null, onPersonalData = 'fail' } = {}) {
  if (!Array.isArray(roles) || !roles.length) throw new TypeError('buildKnowledgeIndex: roles (the manifest roles) are required')
  if (!['fail', 'skip'].includes(onPersonalData)) throw new TypeError('buildKnowledgeIndex: onPersonalData must be fail or skip')
  const errors = []
  const seen = new Set()
  const docs = []
  const chunks = []
  const rejected = []
  for (const [i, d] of (Array.isArray(documents) ? documents : []).entries()) {
    const where = `document ${d?.id ?? `#${i + 1}`}`
    try {
      if (typeof d?.id !== 'string' || !DOC_ID_RE.test(d.id)) throw new KnowledgeBuildError(`${where}: id must match ${DOC_ID_RE}`)
      if (seen.has(d.id)) throw new KnowledgeBuildError(`${where}: duplicate id`)
      seen.add(d.id)
      if (typeof d.title !== 'string' || !d.title.trim() || d.title.length > 120) throw new KnowledgeBuildError(`${where}: title (1–120 characters) is required`)
      if (typeof d.link !== 'string' || !LINK_RE.test(d.link)) throw new KnowledgeBuildError(`${where}: link must be a screen path like /handbook/${d.id}`)
      if (routes && !routeOf(d.link, routes)) throw new KnowledgeBuildError(`${where}: link ${d.link} is not a screen of the business web (web.routes)`)
      const visibility = documentVisibility(d.visibility, { declaredRoles: roles, where })
      const keywords = (Array.isArray(d.keywords) ? d.keywords : []).map(String).filter(Boolean).slice(0, 30)
      const sections = Array.isArray(d.sections) ? d.sections : splitSections(d.body)
      docs.push(Object.freeze({ id: d.id, title: d.title.trim(), link: d.link, visibility }))
      for (const [si, s] of sections.entries()) {
        const swhere = `${where} section ${s.heading ?? '(introduction)'}`
        if (s.anchor !== undefined && !ANCHOR_RE.test(String(s.anchor))) throw new KnowledgeBuildError(`${swhere}: anchor must match ${ANCHOR_RE}`)
        const vis = sectionVisibility(visibility, s, { where: swhere })
        for (const [ci, text] of chunkText(s.text, maxChunkChars).entries()) {
          const id = `${d.id}:${si}:${ci}`
          const kinds = new Set(localKinds(`${s.heading ?? ''}\n${text}`))
          if (screen) for (const k of (await screen(`${s.heading ?? ''}\n${text}`))?.kinds ?? []) kinds.add(String(k))
          if (kinds.size) { rejected.push(Object.freeze({ chunkId: id, documentId: d.id, kinds: Object.freeze([...kinds].sort()) })); continue }
          chunks.push(Object.freeze({
            id, documentId: d.id, title: d.title.trim(), heading: s.heading ?? null, anchor: s.anchor ?? null, link: d.link, keywords, text, visibility: vis,
          }))
        }
      }
    } catch (error) {
      if (!(error instanceof KnowledgeBuildError)) throw error
      errors.push(error.message)
    }
  }
  if (rejected.length && onPersonalData === 'fail') {
    errors.push(...rejected.map((r) => `chunk ${r.chunkId}: personal data (${r.kinds.join(', ')}) — remove it from the document, or build with onPersonalData: 'skip'`))
  }
  if (errors.length) throw new KnowledgeBuildError(`knowledge index: ${errors.length} problem(s):\n- ${errors.join('\n- ')}`, errors)
  return Object.freeze({ version: KNOWLEDGE_INDEX_VERSION, documents: Object.freeze(docs), chunks: Object.freeze(chunks), rejected: Object.freeze(rejected) })
}
