// @dsh-bridge/server-kit/extract — files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md):
// the type check (extension AND leading bytes), the limits, and the conversion of documents to Markdown text in memory
// (txt / md / csv / docx / xlsx with node:zlib, pdf through pdf.js in a child process when pdfjs-dist is available).
// OCR of scanned PDF pages (pages without a text layer): rendered to JPEG in the same child process, then either read by an OCR
// engine the business system passes (`ocr(bytes, { mediaType, page }) -> text`, nothing leaves the business system), or returned
// as `pageImages` for a model that reads images (the panel's notice: attachments go to the model provider).
// Pure functions: no store, no network, nothing written to disk. Nothing here logs a file name or contents.
import { AttachmentError, ATTACHMENT_ERRORS } from './errors.mjs'
import { readZip, isZip } from './zip.mjs'
import { looksBinary, decodeText, parseCsv, csvDelimiter, markdownTable, docxToMarkdown, xlsxToMarkdown } from './formats.mjs'
import { isPdf, pdfPagesToMarkdown, defaultPdfText, createPdfTextExtractor, findPdfjs, PDF_DEFAULTS, SCANNED_PAGE_NOTE } from './pdf.mjs'

export { AttachmentError, ATTACHMENT_ERRORS, createPdfTextExtractor, findPdfjs, PDF_DEFAULTS, SCANNED_PAGE_NOTE }
export { decodeText, parseCsv, csvDelimiter, markdownTable, readZip }

const MB = 1024 * 1024

/** The hard limits (docs/ASSISTANT_ATTACHMENTS.md §3.1, D6). A business system may lower them, never raise them. */
export const ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 10 * MB,
  maxTotalBytes: 20 * MB,
  maxCharsPerFile: 30_000,
  maxCharsTotal: 60_000,
  maxNameLength: 200,
  maxSheetRows: 2_000,
  maxPdfPages: 200,
  // scanned PDF pages read by OCR in one prepare (all documents together)
  maxOcrPages: 10,
})

/** The setting values of `types` (the image formats are one type). */
export const ATTACHMENT_TYPES = Object.freeze(['image', 'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'text'])
export const DOCUMENT_TYPES = Object.freeze(ATTACHMENT_TYPES.filter((t) => t !== 'image'))
/** The default roles that may attach files (D3); the business maps them to its own role names. */
export const DEFAULT_ATTACHMENT_ROLES = Object.freeze(['admin', 'manager', 'billing'])

const GENERIC = ['', 'application/octet-stream', 'binary/octet-stream']
// ext -> { type, mediaType (canonical), accepts (other media types a browser / OS may report for it) }
const FORMATS = {
  png: { type: 'image', mediaType: 'image/png', accepts: [] },
  jpg: { type: 'image', mediaType: 'image/jpeg', accepts: ['image/jpg', 'image/pjpeg'] },
  jpeg: { type: 'image', mediaType: 'image/jpeg', accepts: ['image/jpg', 'image/pjpeg'] },
  webp: { type: 'image', mediaType: 'image/webp', accepts: [] },
  gif: { type: 'image', mediaType: 'image/gif', accepts: [] },
  pdf: { type: 'pdf', mediaType: 'application/pdf', accepts: ['application/x-pdf'] },
  docx: { type: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', accepts: [] },
  xlsx: { type: 'xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', accepts: [] },
  csv: { type: 'csv', mediaType: 'text/csv', accepts: ['application/vnd.ms-excel', 'application/csv', 'text/x-csv', 'text/comma-separated-values', 'text/plain'] },
  md: { type: 'markdown', mediaType: 'text/markdown', accepts: ['text/x-markdown', 'text/plain'] },
  markdown: { type: 'markdown', mediaType: 'text/markdown', accepts: ['text/x-markdown', 'text/plain'] },
  txt: { type: 'text', mediaType: 'text/plain', accepts: [] },
}
/** Accepted extensions (lower case, without the dot) and the canonical media type of each. */
export const ATTACHMENT_EXTENSIONS = Object.freeze(Object.fromEntries(Object.entries(FORMATS).map(([ext, f]) => [ext, f.mediaType])))
/** The browser `accept` attribute for the given types. */
export function acceptAttribute(types = ATTACHMENT_TYPES) {
  const out = []
  for (const [ext, f] of Object.entries(FORMATS)) if (types.includes(f.type)) out.push(`.${ext}`)
  return out.join(',')
}

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ''))
  return m ? m[1].toLowerCase() : ''
}
const normalizeType = (t) => String(t ?? '').split(';')[0].trim().toLowerCase()

function imageFormat(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(b.subarray(0, 6)).toString('latin1'))) return 'image/gif'
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** An OOXML package: 'docx' | 'xlsx' | 'macro' (a macro-enabled one) | 'other' | null (not readable). */
function ooxmlKind(b) {
  let entries
  try { entries = readZip(b) } catch { return null }
  const names = [...entries.keys()]
  if (names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) return 'macro'
  let types = ''
  try { types = entries.has('[Content_Types].xml') ? entries.get('[Content_Types].xml')().toString('utf8') : '' } catch { return null }
  if (/macroEnabled/i.test(types)) return 'macro'
  if (entries.has('word/document.xml')) return 'docx'
  if (entries.has('xl/workbook.xml')) return 'xlsx'
  return 'other'
}

/**
 * The type of one attachment from its name, its media type and (when given) its bytes. Both the extension and the leading
 * bytes must agree with the media type.
 * Returns { ok: true, type, category: 'image' | 'document', mediaType (canonical), ext } or { ok: false, error }
 * (`unsupported_type`: an extension / format that is not accepted, macro-enabled Office files included; `type_mismatch`:
 * the extension, the media type and the contents disagree).
 */
export function detectAttachmentType(name, mediaType, bytes) {
  const declared = normalizeType(mediaType)
  let ext = extOf(name)
  if (!ext) {
    // a pasted image has no file name: the declared type alone decides
    const byType = Object.entries(FORMATS).find(([, f]) => f.mediaType === declared)
    if (!byType) return { ok: false, error: 'unsupported_type' }
    ext = byType[0]
  }
  const f = FORMATS[ext]
  if (!f) return { ok: false, error: 'unsupported_type' }
  if (!GENERIC.includes(declared) && declared !== f.mediaType && !f.accepts.includes(declared)) return { ok: false, error: 'type_mismatch' }
  const base = { ok: true, type: f.type, category: f.type === 'image' ? 'image' : 'document', mediaType: f.mediaType, ext }
  if (bytes === undefined || bytes === null) return base
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (f.type === 'image') return imageFormat(b) === f.mediaType ? base : { ok: false, error: 'type_mismatch' }
  if (f.type === 'pdf') return isPdf(b) ? base : { ok: false, error: 'type_mismatch' }
  if (f.type === 'docx' || f.type === 'xlsx') {
    if (!isZip(b)) return { ok: false, error: 'type_mismatch' }
    const kind = ooxmlKind(b)
    if (kind === 'macro') return { ok: false, error: 'unsupported_type' }
    return kind === f.type ? base : { ok: false, error: 'type_mismatch' }
  }
  // text kinds: not binary, and not a known binary format renamed to .txt
  if (looksBinary(b) || isZip(b) || isPdf(b) || imageFormat(b)) return { ok: false, error: 'type_mismatch' }
  return base
}

/** Effective limits: the given ones, each clamped to the hard limit. */
export function resolveLimits(limits = {}) {
  const out = {}
  for (const [k, hard] of Object.entries(ATTACHMENT_LIMITS)) {
    const v = Number(limits?.[k])
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), hard) : hard
  }
  return out
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
/** Decoded size of a base64 text without decoding it (null when it is not base64). */
export function base64Size(data) {
  if (typeof data !== 'string') return null
  const s = data.replace(/\s+/g, '')
  if (s.length % 4 !== 0 || !B64_RE.test(s)) return null
  return (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)
}

/** Strict base64 -> Buffer (null when it is not base64). */
export function decodeBase64(data) {
  if (base64Size(data) === null) return null
  return Buffer.from(data.replace(/\s+/g, ''), 'base64')
}

const fail = (error, index, name, reason) => {
  const details = {}
  if (index !== undefined) details.index = index
  if (name !== undefined) details.name = name
  if (reason !== undefined) details.reason = reason
  return { ok: false, error, details }
}

/**
 * Checks a list of attachments before anything is converted or sent.
 * files: [{ name, mediaType, size?, data? (base64), bytes? (Buffer / Uint8Array) }].
 * settings: { enabled?: boolean, types?: ATTACHMENT_TYPES[], images?: true | false | null } — `enabled: false` refuses
 * (attachments_not_allowed), a type not in `types` is unsupported_type, an image when `images === false` is images_not_supported.
 * options.requireDocumentData (default true): a document without data / bytes is invalid_attachment.
 * Returns { ok: true, files: [{ index, name, mediaType, type, category, size, bytes }], totalBytes } or
 * { ok: false, error, details: { index?, name?, reason? } }. The order of the checks is stable: count, then per file
 * (shape, size, type, setting, model), then the total.
 */
export function checkAttachments(files, limits = {}, settings = {}, { requireDocumentData = true } = {}) {
  const L = resolveLimits(limits)
  if (settings?.enabled === false) return fail('attachments_not_allowed')
  if (!Array.isArray(files)) return fail('invalid_attachment', undefined, undefined, 'files')
  if (files.length > L.maxFiles) return fail('too_many_files')
  const allowed = Array.isArray(settings?.types) ? settings.types : ATTACHMENT_TYPES
  const out = []
  let total = 0
  for (let index = 0; index < files.length; index += 1) {
    const f = files[index]
    if (!f || typeof f !== 'object' || Array.isArray(f)) return fail('invalid_attachment', index, undefined, 'shape')
    const name = typeof f.name === 'string' ? f.name.trim() : ''
    if (!name || name.length > L.maxNameLength || /[\u0000-\u001f\u007f/\\]/.test(name)) return fail('invalid_attachment', index, undefined, 'name')
    if (f.mediaType !== undefined && typeof f.mediaType !== 'string') return fail('invalid_attachment', index, name, 'mediaType')
    let bytes = null
    if (f.bytes !== undefined && f.bytes !== null) {
      if (!(f.bytes instanceof Uint8Array)) return fail('invalid_attachment', index, name, 'bytes')
      bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)
    } else if (f.data !== undefined && f.data !== null) {
      const size = base64Size(f.data)
      if (size === null) return fail('invalid_attachment', index, name, 'data')
      if (size > L.maxFileBytes) return fail('file_too_large', index, name)
      bytes = decodeBase64(f.data)
    }
    const size = bytes ? bytes.length : Number(f.size)
    if (!Number.isInteger(size) || size < 0) return fail('invalid_attachment', index, name, 'size')
    if (size === 0) return fail('invalid_attachment', index, name, 'empty')
    if (bytes && f.size !== undefined && Number(f.size) !== size) return fail('invalid_attachment', index, name, 'size')
    if (size > L.maxFileBytes) return fail('file_too_large', index, name)
    const t = detectAttachmentType(name, f.mediaType, bytes)
    if (!t.ok) return fail(t.error, index, name)
    if (!allowed.includes(t.type)) return fail('unsupported_type', index, name, 'disabled')
    if (t.category === 'image' && settings?.images === false) return fail('images_not_supported', index, name)
    if (t.category === 'document' && requireDocumentData && !bytes) return fail('invalid_attachment', index, name, 'data')
    total += size
    out.push({ index, name, mediaType: t.mediaType, type: t.type, category: t.category, size, bytes })
  }
  if (total > L.maxTotalBytes) return fail('total_too_large')
  return { ok: true, files: out, totalBytes: total }
}

/** Cut a text to n UTF-16 units without splitting a surrogate pair. */
function cut(text, n) {
  if (text.length <= n) return text
  let end = n
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * One document -> { name, kind, text (Markdown), chars, truncated, pages?, sheets?, ocr?, ocrPages?, pageImages? }.
 * limits: maxCharsPerFile (default 30,000), maxSheetRows (2,000), maxPdfPages (200), maxOcrPages (10).
 * options.pdfText(bytes, { maxPages, maxChars, ocrPages }) -> { pages: string[], numPages, images?, renderUnavailable? } replaces
 * the default pdf.js child process; without either, a PDF is unsupported_type.
 * OCR of scanned pages (options.ocrPages, default maxOcrPages; 0 = off): with options.ocr(bytes, { mediaType, page }) -> text the
 * page becomes text (`ocr: 'engine'`); otherwise the rendered pages come back as `pageImages: [{ page, mediaType, data (base64) }]`
 * and the page text says so (`ocr: 'model'`: a model that reads images reads them). A PDF with neither text nor a rendered page is
 * no_text (details.reason ocr_unavailable when pdf.js could not draw, ocr_off when OCR is off).
 * Throws AttachmentError (unsupported_type, type_mismatch, no_text, invalid_attachment with details.reason).
 */
export async function extractDocument({ name, mediaType, bytes }, limits = {}, options = {}) {
  const L = resolveLimits(limits)
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  const t = detectAttachmentType(name, mediaType, b)
  if (!t.ok) throw new AttachmentError(t.error)
  if (t.category !== 'document') throw new AttachmentError('unsupported_type', { reason: 'not_document' })
  let text
  let truncated = false
  const extra = {}
  switch (t.type) {
    case 'text':
    case 'markdown':
      text = decodeText(b).text.replace(/^﻿/, '').trim()
      break
    case 'csv': {
      const decoded = decodeText(b).text.replace(/^﻿/, '')
      const rows = parseCsv(decoded, { maxRows: L.maxSheetRows })
      if (rows.length > L.maxSheetRows) { rows.length = L.maxSheetRows; truncated = true }
      text = markdownTable(rows)
      if (truncated) text += `\n\n（以下省略：${L.maxSheetRows} 行まで）`
      break
    }
    case 'docx':
      text = docxToMarkdown(b)
      break
    case 'xlsx': {
      const x = xlsxToMarkdown(b, { maxRows: L.maxSheetRows })
      text = x.text
      truncated = x.truncated
      extra.sheets = x.sheets
      break
    }
    case 'pdf': {
      const pdfText = options.pdfText === undefined ? defaultPdfText() : options.pdfText
      if (typeof pdfText !== 'function') throw new AttachmentError('unsupported_type', { reason: 'pdf_reader_unavailable' })
      const ocrPages = options.ocrPages === undefined ? L.maxOcrPages : Math.max(0, Math.min(L.maxOcrPages, Math.floor(Number(options.ocrPages) || 0)))
      const r = await pdfText(b, { maxPages: L.maxPdfPages, maxChars: L.maxCharsPerFile, ocrPages })
      const pages = (Array.isArray(r?.pages) ? r.pages : []).map((p) => String(p ?? ''))
      let scans = (Array.isArray(r?.images) ? r.images : [])
        .filter((i) => Number.isInteger(i?.page) && i.page >= 1 && i.page <= pages.length && i.mediaType === 'image/jpeg' && i.data?.length)
        .slice(0, ocrPages)
      if (scans.length) extra.ocrPages = scans.length
      if (scans.length && typeof options.ocr === 'function') {
        // a local OCR engine: the page images become text and never leave the business system
        for (const s of scans) {
          let read = ''
          try { read = String((await options.ocr(Buffer.from(s.data), { mediaType: s.mediaType, page: s.page })) ?? '').trim() } catch { read = '' }
          if (read) pages[s.page - 1] = [pages[s.page - 1].trim(), read].filter(Boolean).join('\n')
        }
        extra.ocr = 'engine'
        scans = []
      }
      const scanned = new Set(scans.map((s) => s.page))
      text = pdfPagesToMarkdown(pages, { scanned, noTextReason: r?.renderUnavailable ? 'ocr_unavailable' : (ocrPages ? undefined : 'ocr_off') })
      if (scans.length) {
        extra.ocr = 'model'
        extra.pageImages = scans.map((s) => ({ page: s.page, mediaType: s.mediaType, data: Buffer.from(s.data).toString('base64') }))
      }
      extra.pages = Number.isInteger(r?.numPages) ? r.numPages : pages.length
      if (extra.pages > pages.length) truncated = true
      break
    }
    default:
      throw new AttachmentError('unsupported_type')
  }
  text = String(text ?? '').trim()
  if (!text.replace(/\s/g, '')) throw new AttachmentError('no_text')
  if (text.length > L.maxCharsPerFile) { text = cut(text, L.maxCharsPerFile); truncated = true }
  return { name, kind: t.type, text, chars: text.length, truncated, ...extra }
}

/**
 * The whole prepare step (POST /bridge/v1/assistant/attachments/prepare): check every file, convert the documents (in order),
 * apply the total character limit (later documents are cut, `truncated: true`).
 * Returns { ok: true, documents: [extractDocument result], images: [{ name, mediaType, size }], summary } or
 * { ok: false, error, details }. `summary` (attachmentSummary) is what an audit row may keep (+ `ocrPages` when pages were read by OCR).
 * OCR: settings.ocr === false turns it off; maxOcrPages counts the scanned pages of all documents together; `ocr` is the optional
 * local OCR engine (extractDocument).
 */
export async function prepareAttachments(files, { limits = {}, settings = {}, pdfText, ocr } = {}) {
  const L = resolveLimits(limits)
  const checked = checkAttachments(files, L, settings, { requireDocumentData: true })
  if (!checked.ok) return checked
  const documents = []
  const images = []
  let remaining = L.maxCharsTotal
  let ocrLeft = settings?.ocr === false ? 0 : L.maxOcrPages
  let ocrPages = 0
  for (const f of checked.files) {
    if (f.category === 'image') { images.push({ name: f.name, mediaType: f.mediaType, size: f.size }); continue }
    let doc
    try {
      const options = { ocrPages: ocrLeft, ...(pdfText === undefined ? {} : { pdfText }), ...(typeof ocr === 'function' ? { ocr } : {}) }
      doc = await extractDocument({ name: f.name, mediaType: f.mediaType, bytes: f.bytes }, L, options)
      const used = doc.ocrPages ?? 0
      ocrLeft -= used
      ocrPages += used
    } catch (error) {
      if (error instanceof AttachmentError) return fail(error.code, f.index, f.name, error.details?.reason)
      return fail('invalid_attachment', f.index, f.name, 'unreadable')
    }
    if (doc.text.length > remaining) {
      doc.text = cut(doc.text, remaining)
      doc.chars = doc.text.length
      doc.truncated = true
    }
    remaining -= doc.text.length
    documents.push(doc)
  }
  const summary = attachmentSummary(checked.files)
  if (ocrPages) summary.ocrPages = ocrPages
  return { ok: true, documents, images, summary }
}

/** What an audit row may keep: { count, types: { image: 2, pdf: 1 }, totalBytes } — never names or contents. */
export function attachmentSummary(files) {
  const types = {}
  let totalBytes = 0
  for (const f of files ?? []) {
    types[f.type] = (types[f.type] ?? 0) + 1
    totalBytes += Number(f.size) || 0
  }
  return { count: (files ?? []).length, types, totalBytes }
}
