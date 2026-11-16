// Child process that reads the text layer of a PDF with pdf.js (pdfjs-dist): no script evaluation, no font loading.
// Pages without a text layer (scans) can be rendered to JPEG for OCR (ocrPages > 0): pdf.js draws them with the canvas module
// it finds next to itself (@napi-rs/canvas, an optional dependency of pdfjs-dist); without it the scans stay unread.
// The parent kills it on timeout. A child process, not a worker thread: pdfjs-dist 5 loads a native canvas module at import,
// and a worker thread that loaded it can take the whole process down when it ends.
// In: one IPC message { moduleUrl, root, bytes, maxPages, maxChars, ocrPages, ocrMaxEdge, ocrMinChars, ocrMaxBytes }
// (serialization 'advanced').
// Out: one message { ok, numPages, pages: [string], images: [{ page, mediaType, data: Uint8Array }], renderUnavailable }
// or { error: 'pdf_encrypted' | 'pdf_unreadable' }.
import { join } from 'node:path'

const JPEG_QUALITIES = [82, 70, 55]

function encodeJpeg(canvas, quality) {
  if (typeof canvas.encodeSync === 'function') return canvas.encodeSync('jpeg', quality)
  return canvas.toBuffer('image/jpeg', quality)
}

/** True when (a sample of) the page has almost no dark pixel: fewer than 1 in 2,000 samples darker than light grey. */
function isBlank(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height)
  const step = Math.max(1, Math.floor((width * height) / 200_000)) * 4
  let samples = 0
  let dark = 0
  for (let i = 0; i < data.length; i += step) {
    samples += 1
    if (data[i] + data[i + 1] + data[i + 2] < 600) dark += 1
  }
  return dark * 2000 < samples
}

async function renderPage(doc, page, { ocrMaxEdge, ocrMaxBytes }) {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4, ocrMaxEdge / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const factory = doc.canvasFactory
  const { canvas, context } = factory.create(width, height)
  try {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    await page.render({ canvasContext: context, canvas, viewport }).promise
    if (isBlank(context, width, height)) return null // an empty page: nothing to read
    for (const q of JPEG_QUALITIES) {
      const data = encodeJpeg(canvas, q)
      if (data.length <= ocrMaxBytes) return new Uint8Array(data)
    }
    return null
  } finally {
    factory.destroy?.({ canvas, context })
  }
}

async function run({ moduleUrl, root, bytes, maxPages, maxChars, ocrPages = 0, ocrMaxEdge = 1600, ocrMinChars = 20, ocrMaxBytes = 1_500_000 }) {
  const pdfjs = await import(moduleUrl)
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false,
    ...(root ? { cMapUrl: `${join(root, 'cmaps')}/`, cMapPacked: true, standardFontDataUrl: `${join(root, 'standard_fonts')}/` } : {}),
  })
  let doc
  try {
    doc = await task.promise
  } catch (error) {
    return { error: error?.name === 'PasswordException' ? 'pdf_encrypted' : 'pdf_unreadable' }
  }
  try {
    const pages = []
    const images = []
    let renderUnavailable = false
    let chars = 0
    const last = Math.min(doc.numPages, maxPages)
    for (let p = 1; p <= last && chars <= maxChars; p += 1) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      let text = ''
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue
        text += it.str
        if (it.hasEOL) text += '\n'
      }
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      // a page with (almost) no text layer is a scan: render it for OCR while the budget lasts
      if (text.replace(/\s/g, '').length < ocrMinChars && images.length < ocrPages && !renderUnavailable) {
        try {
          const data = await renderPage(doc, page, { ocrMaxEdge, ocrMaxBytes })
          if (data) images.push({ page: p, mediaType: 'image/jpeg', data })
        } catch {
          renderUnavailable = true // no canvas module (or it cannot draw this page): the scans stay unread
        }
      }
      chars += text.length
      pages.push(text)
      page.cleanup()
    }
    return { ok: true, numPages: doc.numPages, pages, images, renderUnavailable }
  } finally {
    await doc.destroy().catch(() => {})
  }
}

process.once('message', (data) => {
  run(data ?? {})
    .catch(() => ({ error: 'pdf_unreadable' }))
    .then((m) => process.send(m, () => process.exit(0)))
})
