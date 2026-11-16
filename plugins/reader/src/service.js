// bridge-reader の本体（ctx に依存しない。テストから直接使う）。docs/DOCUMENT_READS.md
//
//  - 業務システムが自分で読めなかった文書（画像・文字の層の無い PDF）は、ページの画像として GET /bridge/v1/document-reads に並ぶ。
//    ここで数件ずつ受け取り（受け取ると claim：10 分で業務システムがまた出せる）、画像を読めるモデルに 1 ページ 1 回ずつ書き写させ、
//    POST /bridge/v1/document-reads/{readId}/result に { pages: [{ page, text }] } か { error } で返す。
//  - 読んだ文字の扱い（項目への割り当て・人の確認）は業務システムが決める。ここは書き写すだけで、業務の判断をしない。
//  - 会話は作らない（DSH の会話のログにページも文字も残らない）。ログに出すのは件数と ID の数だけ。中身は出さない。
//  - 業務システムが機能を持たない（paths.documentReads が無い・404）アプリケーションは、しばらく聞きに行かない。
import { appPath, registryGetter } from '@dsh-bridge/dsh-core'

export const READER_DEFAULTS = Object.freeze({ intervalSeconds: 30, claimLimit: 2, maxPages: 10, maxTextChars: 20_000, retryUnsupportedMs: 10 * 60_000 })
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png'])
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const ERROR_CODES = new Set(['images_not_supported', 'model_failed', 'too_large'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A read error with one of the protocol's codes. */
export class ReadError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'ReadError'
    this.code = ERROR_CODES.has(code) ? code : 'model_failed'
  }
}

/** One claimed read, checked: { id, hint, language, pages: [{ page, mediaType, data }] } or null (malformed: skipped). */
export function cleanRead(raw, { maxPages = READER_DEFAULTS.maxPages } = {}) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return null
  const pages = Array.isArray(raw.pages) ? raw.pages : []
  if (!pages.length || pages.length > maxPages) return null
  const out = []
  for (const p of pages) {
    if (!p || !Number.isInteger(p.page) || p.page < 1 || !MEDIA_TYPES.has(p.mediaType)) return null
    if (typeof p.data !== 'string' || !p.data || p.data.length % 4 !== 0 || !B64_RE.test(p.data)) return null
    out.push({ page: p.page, mediaType: p.mediaType, data: p.data })
  }
  const short = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '')
  return { id: raw.id.toLowerCase(), hint: short(raw.hint, 200), language: short(raw.language, 20) || 'ja', pages: out }
}

/**
 * @param {object} deps
 * @param {object|(() => object)} deps.registry  the application registry (@dsh-bridge/dsh-core)
 * @param {(read) => Promise<{ page, text }[]>} deps.read   the model: one read's pages -> their text (throws ReadError)
 * @param {() => boolean} [deps.enabled]
 */
export function createReaderService({ registry, read, enabled = () => true, now = Date.now, logger = console, limits = {} } = {}) {
  const getRegistry = registryGetter(registry)
  const L = { ...READER_DEFAULTS, ...limits }
  const unsupported = new Map() // applicationId -> until
  const stats = { ticks: 0, reads: 0, pages: 0, failed: 0, skipped: 0, lastError: null }
  let running = null

  async function answer(app, id, body) {
    await app.api.post(appPath(app, 'documentReadResult', { readId: id }), body)
  }

  async function forApp(app) {
    if (!app?.paths?.documentReads || !app.paths.documentReadResult) return
    const until = unsupported.get(app.id)
    if (until && until > now()) return
    let claimed
    try {
      claimed = await app.api.get(appPath(app, 'documentReads'), { query: { limit: L.claimLimit } })
    } catch (error) {
      if (error?.status === 404 || error?.code === 'path_unsupported') unsupported.set(app.id, now() + L.retryUnsupportedMs)
      else logger.warn?.('bridge-reader: claim failed for %s: %s', app.id, error?.code ?? error?.name ?? 'error')
      return
    }
    for (const raw of Array.isArray(claimed?.reads) ? claimed.reads : []) {
      const r = cleanRead(raw, { maxPages: L.maxPages })
      if (!r) { stats.skipped += 1; logger.warn?.('bridge-reader: a malformed read was skipped (%s)', app.id); continue }
      let body
      try {
        const pages = await read(r)
        body = { pages: r.pages.map(({ page }) => ({ page, text: String(pages.find((x) => x.page === page)?.text ?? '').slice(0, L.maxTextChars) })) }
        stats.reads += 1
        stats.pages += r.pages.length
      } catch (error) {
        const code = error instanceof ReadError ? error.code : 'model_failed'
        body = { error: code }
        stats.failed += 1
        stats.lastError = code
        logger.warn?.('bridge-reader: a read failed (%s): %s', app.id, code)
      }
      try {
        await answer(app, r.id, body)
      } catch (error) {
        // 409 = the claim expired and the business system handed it out again: the newer answer wins, nothing to do
        if (error?.status !== 409) logger.warn?.('bridge-reader: answering a read failed (%s): %s', app.id, error?.code ?? error?.name ?? 'error')
      }
    }
  }

  /** One pass over every application; one at a time, never throws. */
  function tick() {
    if (running || !enabled()) return running ?? Promise.resolve()
    running = (async () => {
      stats.ticks += 1
      for (const app of getRegistry()?.list?.() ?? []) {
        try { await forApp(app) } catch (error) { logger.warn?.('bridge-reader: %s', error?.message ?? 'error') }
      }
    })().finally(() => { running = null })
    return running
  }

  return { tick, stats: () => ({ ...stats }), _internals: { unsupported } }
}
