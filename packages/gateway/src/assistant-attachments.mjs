// Files attached in the AI assistant panel, on the BFF (docs/ASSISTANT_ATTACHMENTS.md §2). A pure part: no store, no network
// of its own. The BFF receives `attachments: [{ name, mediaType, data (base64) }]` with the message, and this part
//   1. checks them early (count, decoded sizes, extension + leading bytes, the business system's settings, the model),
//   2. asks the business system to check its settings and convert the documents (`callPrepare`, i.e.
//      POST /bridge/v1/assistant/attachments/prepare with the employee's own session; images go without data),
//   3. builds the `attachments` of the DSH management RPC `message.send` (images as base64, documents as text).
// The business system checks everything again; this part only stops a bad upload before it travels further.
// Nothing here logs a file name or contents. Node built-ins only (Buffer).

const MB = 1024 * 1024
/** The hard limits (D6): 5 files, 10 MB each, 20 MB together (decoded). */
export const ASSISTANT_ATTACHMENT_LIMITS = Object.freeze({ maxFiles: 5, maxFileBytes: 10 * MB, maxTotalBytes: 20 * MB, maxNameLength: 200 })
/** The text sent when only files are attached. */
export const DEFAULT_ATTACHMENT_PROMPT = '添付した資料について説明してください。'

const GENERIC = ['', 'application/octet-stream', 'binary/octet-stream']
const FORMATS = {
  png: ['image', 'image/png', []],
  jpg: ['image', 'image/jpeg', ['image/jpg', 'image/pjpeg']],
  jpeg: ['image', 'image/jpeg', ['image/jpg', 'image/pjpeg']],
  webp: ['image', 'image/webp', []],
  gif: ['image', 'image/gif', []],
  pdf: ['pdf', 'application/pdf', ['application/x-pdf']],
  docx: ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', []],
  xlsx: ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', []],
  csv: ['csv', 'text/csv', ['application/vnd.ms-excel', 'application/csv', 'text/x-csv', 'text/comma-separated-values', 'text/plain']],
  md: ['markdown', 'text/markdown', ['text/x-markdown', 'text/plain']],
  markdown: ['markdown', 'text/markdown', ['text/x-markdown', 'text/plain']],
  txt: ['text', 'text/plain', []],
}

/** HTTP status for an attachment error code. */
export function attachmentErrorStatus(code) {
  if (code === 'attachments_not_allowed') return 403
  if (code === 'attachment_prepare_failed') return 502
  return 422
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
function base64Size(data) {
  if (typeof data !== 'string' || data.length % 4 !== 0 || !B64_RE.test(data)) return null
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

function leadingBytesMatch(type, mediaType, b) {
  const head = (n) => b.subarray(0, n).toString('latin1')
  switch (type) {
    case 'image':
      if (mediaType === 'image/png') return b.length >= 8 && b[0] === 0x89 && head(4).slice(1) === 'PNG'
      if (mediaType === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      if (mediaType === 'image/gif') return /^GIF8[79]a$/.test(head(6))
      if (mediaType === 'image/webp') return head(4) === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
      return false
    case 'pdf': return head(1024).includes('%PDF-')
    case 'docx': case 'xlsx': return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
    default: {
      if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return true
      const n = Math.min(b.length, 8192)
      for (let i = 0; i < n; i += 1) if (b[i] === 0) return false
      return !(head(4) === 'PK\u0003\u0004' || head(5) === '%PDF-')
    }
  }
}

const failure = (error, details) => ({ ok: false, error, status: attachmentErrorStatus(error), ...(details ? { details } : {}) })

/**
 * The early check of the files a browser sent. Returns { ok: true, files: [{ index, name, mediaType (canonical), type,
 * category, size, data }], totalBytes } or { ok: false, error, status, details }.
 * settings (optional, the business system's GET /bridge/v1/assistant/attachment-settings): { enabled, types }.
 * imagesSupported: false refuses images (images_not_supported); true / null / undefined lets them through.
 */
export function checkAssistantAttachments(files, { limits = {}, settings, imagesSupported } = {}) {
  const L = { ...ASSISTANT_ATTACHMENT_LIMITS }
  for (const k of Object.keys(L)) if (Number.isFinite(Number(limits[k])) && Number(limits[k]) > 0) L[k] = Math.min(L[k], Math.floor(Number(limits[k])))
  if (files === undefined || files === null) return { ok: true, files: [], totalBytes: 0 }
  if (!Array.isArray(files)) return failure('invalid_attachment', { reason: 'files' })
  if (!files.length) return { ok: true, files: [], totalBytes: 0 }
  if (settings && settings.enabled === false) return failure('attachments_not_allowed')
  if (files.length > L.maxFiles) return failure('too_many_files')
  const allowed = Array.isArray(settings?.types) ? settings.types : null
  const out = []
  let total = 0
  for (let index = 0; index < files.length; index += 1) {
    const f = files[index]
    if (!f || typeof f !== 'object' || Array.isArray(f)) return failure('invalid_attachment', { index, reason: 'shape' })
    const name = typeof f.name === 'string' ? f.name.trim() : ''
    if (!name || name.length > L.maxNameLength || /[\u0000-\u001f\u007f/\\]/.test(name)) return failure('invalid_attachment', { index, reason: 'name' })
    const size = base64Size(f.data)
    if (size === null || size === 0) return failure('invalid_attachment', { index, name, reason: 'data' })
    if (size > L.maxFileBytes) return failure('file_too_large', { index, name })
    const m = /\.([A-Za-z0-9]{1,10})$/.exec(name)
    const fmt = FORMATS[m ? m[1].toLowerCase() : '']
    if (!fmt) return failure('unsupported_type', { index, name })
    const [type, canonical, aliases] = fmt
    const declared = String(f.mediaType ?? '').split(';')[0].trim().toLowerCase()
    if (!GENERIC.includes(declared) && declared !== canonical && !aliases.includes(declared)) return failure('type_mismatch', { index, name })
    if (!leadingBytesMatch(type, canonical, Buffer.from(f.data.slice(0, 1368), 'base64'))) return failure('type_mismatch', { index, name })
    if (allowed && !allowed.includes(type)) return failure('unsupported_type', { index, name, reason: 'disabled' })
    if (type === 'image' && imagesSupported === false) return failure('images_not_supported', { index, name })
    total += size
    out.push({ index, name, mediaType: canonical, type, category: type === 'image' ? 'image' : 'document', size, data: f.data })
  }
  if (total > L.maxTotalBytes) return failure('total_too_large')
  return { ok: true, files: out, totalBytes: total }
}

/**
 * The whole BFF step. files: the browser's [{ name, mediaType, data }]; callPrepare(body) -> the business system's JSON
 * answer to POST /bridge/v1/assistant/attachments/prepare ({ ok, documents, images } or { ok:false, error, details }),
 * called with the employee's own session by the BFF (it may also throw). Not called when there is no file.
 * Returns { ok: true, attachments (message.send), summary: { count, types, totalBytes }, labels: [{ name, kind }] } or
 * { ok: false, error, status, details }.
 */
export async function prepareAssistantAttachments({ files, callPrepare, limits, settings, imagesSupported } = {}) {
  const checked = checkAssistantAttachments(files, { limits, settings, imagesSupported })
  if (!checked.ok) return checked
  const summary = { count: checked.files.length, types: {}, totalBytes: checked.totalBytes }
  for (const f of checked.files) summary.types[f.type] = (summary.types[f.type] ?? 0) + 1
  if (!checked.files.length) return { ok: true, attachments: [], summary, labels: [] }
  if (typeof callPrepare !== 'function') throw new TypeError('prepareAssistantAttachments: callPrepare is required')
  const body = {
    files: checked.files.map((f) => (f.category === 'image'
      ? { name: f.name, mediaType: f.mediaType, size: f.size }
      : { name: f.name, mediaType: f.mediaType, size: f.size, data: f.data })),
  }
  let answer
  try {
    answer = await callPrepare(body)
  } catch {
    return failure('attachment_prepare_failed')
  }
  if (!answer || typeof answer !== 'object') return failure('attachment_prepare_failed')
  if (answer.ok !== true) {
    const error = typeof answer.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(answer.error) ? answer.error : 'attachment_prepare_failed'
    return failure(error, answer.details && typeof answer.details === 'object' ? answer.details : undefined)
  }
  const documents = Array.isArray(answer.documents) ? answer.documents : []
  const attachments = []
  const labels = []
  let d = 0
  for (const f of checked.files) {
    if (f.category === 'image') {
      attachments.push({ kind: 'image', mediaType: f.mediaType, data: f.data, name: f.name })
      labels.push({ name: f.name, kind: 'image' })
      continue
    }
    // documents come back in the order they were sent
    const doc = documents[d] && documents[d].name === f.name ? documents[d] : documents.find((x) => x?.name === f.name)
    d += 1
    if (!doc || typeof doc.text !== 'string') return failure('attachment_prepare_failed', { index: f.index, name: f.name })
    const pageImages = scannedPages(doc.pageImages)
    // scanned pages are read by the model from images: a model that cannot read images cannot read them
    if (pageImages.length && imagesSupported === false) return failure('images_not_supported', { index: f.index, name: f.name, reason: 'scanned_pdf' })
    attachments.push({
      kind: 'document', name: f.name, kind2: typeof doc.kind === 'string' ? doc.kind : f.type, text: doc.text, truncated: doc.truncated === true,
      ...(pageImages.length ? { pageImages } : {}),
    })
    labels.push({ name: f.name, kind: typeof doc.kind === 'string' ? doc.kind : f.type, ...(pageImages.length ? { scannedPages: pageImages.length } : {}) })
  }
  return { ok: true, attachments, summary, labels }
}

/** The scanned pages of a prepared PDF (OCR by the model): [{ page, mediaType: 'image/jpeg', data (base64) }], at most MAX_SCANNED_PAGES. */
export const MAX_SCANNED_PAGES = 10
function scannedPages(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((p) => Number.isInteger(p?.page) && p.page >= 1 && p.mediaType === 'image/jpeg' && typeof p.data === 'string' && p.data && B64_RE.test(p.data))
    .slice(0, MAX_SCANNED_PAGES)
    .map((p) => ({ page: p.page, mediaType: p.mediaType, data: p.data }))
}
