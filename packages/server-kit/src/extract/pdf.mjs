// The text layer of a PDF through pdf.js in a child process (pdf-worker.mjs), when `pdfjs-dist` can be found. server-kit does not
// depend on pdfjs-dist: the default extractor looks for it next to server-kit and next to the current directory's package; a
// business system that has its own copy passes `createPdfTextExtractor({ resolveFrom: import.meta.url })` (or any
// `pdfText(bytes, { maxPages, maxChars }) -> { pages: string[], numPages }` of its own) as option `pdfText`.
// OCR (scans): with `ocrPages` > 0 the child also renders up to that many pages without a text layer to JPEG
// (`images: [{ page, mediaType, data }]`); `renderUnavailable` when pdf.js could not draw (no canvas module).
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AttachmentError } from './errors.mjs'

const WORKER = fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url))

export const PDF_DEFAULTS = Object.freeze({ timeoutMs: 60_000, maxPages: 200, maxOldSpaceMb: 512, ocrMaxEdge: 1600, ocrMinChars: 20, ocrMaxBytes: 1_500_000 })

/** The pdf.js module (legacy build) reachable from `from` (a file URL or path), or null. */
export function findPdfjs(from) {
  try {
    const require = createRequire(from)
    const root = dirname(require.resolve('pdfjs-dist/package.json'))
    const file = join(root, 'legacy', 'build', 'pdf.mjs')
    if (!existsSync(file)) return null
    return { moduleUrl: pathToFileURL(file).href, root }
  } catch {
    return null
  }
}

/**
 * A pdfText function backed by pdf.js in a child process, or null when pdfjs-dist cannot be found from any of `resolveFrom`
 * (default: server-kit's own location, then the current directory).
 */
export function createPdfTextExtractor({
  resolveFrom = [import.meta.url, pathToFileURL(join(process.cwd(), 'package.json')).href],
  timeoutMs = PDF_DEFAULTS.timeoutMs, maxOldSpaceMb = PDF_DEFAULTS.maxOldSpaceMb,
} = {}) {
  const found = [].concat(resolveFrom).map((f) => findPdfjs(f)).find(Boolean)
  if (!found) return null
  return (bytes, {
    maxPages = PDF_DEFAULTS.maxPages, maxChars = 1_000_000, ocrPages = 0,
    ocrMaxEdge = PDF_DEFAULTS.ocrMaxEdge, ocrMinChars = PDF_DEFAULTS.ocrMinChars, ocrMaxBytes = PDF_DEFAULTS.ocrMaxBytes,
  } = {}) => new Promise((resolve, reject) => {
    let settled = false
    let child = null
    let timer = null
    const done = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child && child.exitCode === null) child.kill()
      fn(v)
    }
    const fail = (reason) => done(reject, new AttachmentError('invalid_attachment', { reason }))
    // no secrets in the child: only what Windows needs to start a process
    const env = { NODE_ENV: process.env.NODE_ENV ?? 'production' }
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k]
    try {
      child = fork(WORKER, [], { execArgv: [`--max-old-space-size=${maxOldSpaceMb}`], env, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    } catch {
      return fail('pdf_unreadable')
    }
    timer = setTimeout(() => fail('pdf_timeout'), timeoutMs)
    child.once('error', () => fail('pdf_unreadable'))
    // 'close' (after the IPC channel is drained), so a result sent just before the child ends is not lost
    child.once('close', () => fail('pdf_unreadable'))
    child.once('message', (m) => {
      if (m?.ok) {
        const images = (Array.isArray(m.images) ? m.images : []).map((i) => ({ page: i.page, mediaType: i.mediaType, data: Buffer.from(i.data) }))
        return done(resolve, { pages: m.pages, numPages: m.numPages, images, renderUnavailable: m.renderUnavailable === true })
      }
      fail(m?.error ?? 'pdf_unreadable')
    })
    try {
      child.send({ ...found, bytes: new Uint8Array(bytes), maxPages, maxChars, ocrPages, ocrMaxEdge, ocrMinChars, ocrMaxBytes })
    } catch {
      fail('pdf_unreadable')
    }
  })
}

let defaultExtractor
/** The default pdfText (looked up once), or null. */
export function defaultPdfText() {
  if (defaultExtractor === undefined) defaultExtractor = createPdfTextExtractor()
  return defaultExtractor
}

/** True when the bytes carry a PDF header in the first 1 KiB. */
export function isPdf(b) {
  const head = Buffer.from(b.subarray(0, 1024)).toString('latin1')
  return head.indexOf('%PDF-') >= 0
}

export const SCANNED_PAGE_NOTE = '（スキャンのページ：この質問に画像として付いています。画像の文字を読み取ってください）'

/**
 * Pages of text -> `--- p.N ---` sections; a page in `scanned` (page numbers sent as images for OCR) gets SCANNED_PAGE_NOTE.
 * Throws no_text when no page has text and none is scanned (details.reason: `noTextReason`, when given).
 */
export function pdfPagesToMarkdown(pages, { scanned = new Set(), noTextReason } = {}) {
  const parts = []
  let chars = 0
  pages.forEach((t, i) => {
    const text = String(t ?? '').trim()
    chars += text.replace(/\s/g, '').length
    const note = scanned.has(i + 1) ? (text ? `\n${SCANNED_PAGE_NOTE}` : SCANNED_PAGE_NOTE) : ''
    parts.push(`--- p.${i + 1} ---\n${text}${note}`)
  })
  if (!chars && !scanned.size) throw new AttachmentError('no_text', noTextReason ? { reason: noTextReason } : undefined)
  return parts.join('\n\n')
}
