// Scanned documents read by the AI model (optional capability, docs/DOCUMENT_READS.md). Always registered, so the service-only gate
// answers the same way everywhere (401 / 403); without hooks.documentReads the authenticated caller gets 404 not_found.
//   GET  /bridge/v1/document-reads?limit=1..5          the service principal: claim page images (hooks.documentReads.claim)
//   POST /bridge/v1/document-reads/:readId/result      the service principal: the text (or an error code) for a claimed read
// The business system keeps the reads (its own table), re-renders the pages from the stored file, decides which documents are offered,
// turns the text into its own fields and has a person confirm every value. The kit checks the shapes only and logs nothing of the content.
//   hooks.documentReads = { claim({ limit }, ctx) -> { reads: [{ id, purpose?, language?, hint?, pages: [{ page, mediaType, data }] }] },
//                           answer(readId, { pages } | { error }, ctx) }   (answer throws fail(404, 'read_not_found') / fail(409, 'read_not_claimed'))
import { fail, strictKeys } from '../http.mjs'
import { POLICY } from '../gate.mjs'

export const DOCUMENT_READ_LIMITS = Object.freeze({ maxClaim: 5, maxPages: 10, maxTextChars: 20_000 })
export const DOCUMENT_READ_ERRORS = Object.freeze(['images_not_supported', 'model_failed', 'too_large'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png'])

/** The result body, checked: { pages: [{ page, text }] } or { error }. Throws 400. */
export function checkDocumentReadResult(body) {
  const b = body ?? {}
  if (typeof b !== 'object' || Array.isArray(b)) fail(400, 'invalid_body')
  if ('error' in b) {
    strictKeys(b, ['error'])
    if (!DOCUMENT_READ_ERRORS.includes(b.error)) fail(400, 'invalid_error')
    return { error: b.error }
  }
  strictKeys(b, ['pages'])
  if (!Array.isArray(b.pages) || !b.pages.length || b.pages.length > DOCUMENT_READ_LIMITS.maxPages) fail(400, 'invalid_pages')
  const seen = new Set()
  const pages = b.pages.map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail(400, 'invalid_pages')
    strictKeys(p, ['page', 'text'])
    if (!Number.isInteger(p.page) || p.page < 1 || seen.has(p.page)) fail(400, 'invalid_pages')
    if (typeof p.text !== 'string' || p.text.length > DOCUMENT_READ_LIMITS.maxTextChars) fail(400, 'invalid_text')
    seen.add(p.page)
    return { page: p.page, text: p.text }
  })
  return { pages }
}

function cleanClaimed(reads) {
  const out = []
  for (const r of Array.isArray(reads) ? reads : []) {
    if (!r || typeof r.id !== 'string' || !UUID_RE.test(r.id)) throw new Error('documentReads.claim returned a read without a uuid id')
    const pages = Array.isArray(r.pages) ? r.pages : []
    if (!pages.length || pages.length > DOCUMENT_READ_LIMITS.maxPages) throw new Error('documentReads.claim returned a read with 0 or more than 10 pages')
    for (const p of pages) {
      if (!Number.isInteger(p?.page) || p.page < 1 || !MEDIA_TYPES.has(p.mediaType) || typeof p.data !== 'string' || !p.data) {
        throw new Error('documentReads.claim returned a malformed page')
      }
    }
    out.push({
      id: r.id, ...(typeof r.purpose === 'string' ? { purpose: r.purpose } : {}), ...(typeof r.language === 'string' ? { language: r.language } : {}),
      ...(typeof r.hint === 'string' ? { hint: r.hint.slice(0, 200) } : {}),
      pages: pages.map(({ page, mediaType, data }) => ({ page, mediaType, data })),
    })
  }
  return out
}

export function registerDocumentReads(router, kit) {
  const hooks = () => kit.hooks.documentReads ?? null
  router.add('GET', '/bridge/v1/document-reads', POLICY.SERVICE, async ({ query }) => {
    const h = hooks()
    if (!h || typeof h.claim !== 'function') fail(404, 'not_found')
    const raw = query?.get?.('limit') ?? query?.limit
    const limit = raw === undefined || raw === null || raw === '' ? 2 : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_READ_LIMITS.maxClaim) fail(400, 'invalid_limit')
    const r = await h.claim({ limit }, kit.ctx())
    return { status: 200, body: { ok: true, reads: cleanClaimed(r?.reads).slice(0, limit) } }
  })
  router.add('POST', '/bridge/v1/document-reads/:readId/result', POLICY.SERVICE, async ({ params, body }) => {
    const h = hooks()
    if (!h || typeof h.answer !== 'function') fail(404, 'not_found')
    if (!UUID_RE.test(String(params.readId))) fail(404, 'read_not_found')
    const result = checkDocumentReadResult(body)
    await h.answer(String(params.readId).toLowerCase(), result, kit.ctx())
    return { status: 200, body: { ok: true } }
  })
}
