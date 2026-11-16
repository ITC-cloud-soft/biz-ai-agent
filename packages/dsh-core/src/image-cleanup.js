// 添付の画像の後片付け（docs/ASSISTANT_ATTACHMENTS.md §3.4・D4）。
//
// DSH 0.2.2-rc.1 の添付の保存先（@deepseek-ai/dsh-attachment-local、`<DSH_HOME>/attachments/v1/objects/<2>/<sha256>`）は
// 同じ中身を 1 つにまとめ、消す口を持たない。会話のログ（`<DSH_HOME>/sessions/**/session.v4.jsonl(.zstd)`）は画像を
// `{"type":"image","attachment":{"attachmentId":"sha256:…"}}` として参照する。ここでは参照を自分で数える：
//  - 対象は「このプラグインが画像を送った会話」（台帳 `<DSH_HOME>/storages/bridge-assistant/image-sessions.json`）のうち、
//    やり直した・使われなくなった（idleMs）会話だけ。台帳に無い会話（DSH の画面・IM・自動タスク・この機能の前の会話）の画像は消さない。
//  - 消すのは、終わった会話だけが参照する画像。ほかの会話のログ（終わっていない会話・台帳に無い会話）が 1 つでも参照していれば残す。
//  - ログを読み切れない（壊れている・書きかけのフレーム）ときは、その回は何も消さない（fail closed）。
//  - 消す直前に、数え始めてから書かれたログをもう一度読む（その間に同じ画像を参照した会話があれば残す）。消している間は
//    このプラグインからの画像の送信を待たせる（gate）。
//  - 画像のほか、DSH がモデルへの要求用に作った縮小版（`<DSH_HOME>/cache/attachments/request-images/<2>/<sha256>`）のうち、
//    llm-deepseek のアップロードの台帳（`llm-deepseek/files-v3.json`、読むだけ）で元の画像が分かるものも消す。
//    DeepSeek の file API に上げた写しは、その台帳の expiresAt（7 日）で提供元が消す。
// 終わった会話のログの本文は残る（画像の参照だけが読めなくなる。DSH の画面でその古い会話を開くと画像は表示されない）。
// 会話を作らずに 1 回だけモデルへ渡した画像（bridge-reader の読み取り）は orphan(id) で台帳に入れる：どの会話・ファイルも参照して
// いなければ次の回で消す（参照があれば残して台帳から外す）。台帳はプラグインごと（owner：既定 bridge-assistant）。
import { promises as fsp } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const IMAGE_CLEANUP_DEFAULTS = Object.freeze({ intervalMs: 60 * 60_000, firstRunMs: 5 * 60_000, idleMs: 12 * 3600_000 })
const LEDGER_VERSION = 1
const ID_RE = /sha256:([0-9a-f]{64})/g
const SESSION_DIR_RE = /^session-[0-9A-Za-z-]{8,80}$/
const ZSTD_MAGIC = 0xfd2fb528
// 台帳に無い会話の参照を探すのは sessions のほか、DSH_HOME の直下の各ディレクトリ（自動タスク・storages など）。
// 次は数えない：画像そのもの・縮小版・プロファイル・ログ・アップロードの台帳（画像を参照するが、会話ではない）
const SKIP_TOP = new Set(['attachments', 'cache', 'profiles', 'logs', 'llm-deepseek', 'node_modules', 'sessions'])
const PLAIN_MAX_BYTES = 64 * 1024 * 1024

/** The DSH home: config dshHome, else DSH_HOME, else ~/.dsh (the same rule as DSH). */
export function resolveDshHome(configured, env = process.env) {
  const v = String(configured ?? '').trim() || String(env?.DSH_HOME ?? '').trim()
  return v || join(homedir(), '.dsh')
}

/**
 * The complete Zstandard frames of a session log, without decompressing (the same structural scan as DSH's JSONL persistence).
 * Returns { frames: [{start, end}], torn: boolean }; throws on an invalid structure.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5) return { frames, torn: true }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const header = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < header) return { frames, torn: true }
    offset += header
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true }
      const block = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (block & 1) !== 0
      const type = (block >>> 1) & 3
      if (type === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payload = type === 1 ? 1 : block >>> 3
      if (buffer.length - offset < payload) return { frames, torn: true }
      offset += payload
      if (last) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: true }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, torn: false }
}

/** The text of a session log file (.zstd: every frame; otherwise as is). Throws when it cannot be read completely. */
export function sessionLogText(buffer, { compressed }) {
  if (!compressed) return buffer.toString('utf8')
  const { frames, torn } = scanZstdFrames(buffer)
  if (torn) throw new Error('the session log ends inside a frame (being written)')
  return frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')).join('')
}

/** Every attachment id (64 hex) named in a text. */
export function attachmentIdsIn(text, into = new Set()) {
  for (const m of String(text).matchAll(ID_RE)) into.add(m[1])
  return into
}

async function* walk(dir, fs) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, fs)
    else if (e.isFile()) yield p
  }
}

/** The session id a file under `<home>/sessions` belongs to: the nearest `session-…` directory, or null. */
function sessionOfPath(path, sessionsRoot) {
  const parts = path.slice(sessionsRoot.length).split(/[\\/]+/).filter(Boolean)
  for (let i = parts.length - 2; i >= 0; i -= 1) if (SESSION_DIR_RE.test(parts[i])) return parts[i]
  return null
}

/**
 * @param {object} o
 * @param {string} o.dshHome          the DSH home of this DSH (resolveDshHome)
 * @param {number} [o.idleMs]          a tracked conversation not used for this long (and not live) is over (default 12 h, the assistant's own)
 * @param {() => number} [o.now]
 * @param {object} [o.fs]              node:fs/promises (tests)
 */
export function createImageCleanup({ dshHome, owner = 'bridge-assistant', idleMs = IMAGE_CLEANUP_DEFAULTS.idleMs, now = Date.now, logger = console, fs = fsp } = {}) {
  if (!dshHome) throw new TypeError('image cleanup: dshHome is required')
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(owner)) throw new TypeError('image cleanup: invalid owner')
  const ledgerDir = join(dshHome, 'storages', owner)
  const ledgerPath = join(ledgerDir, 'image-sessions.json')
  const objectsRoot = join(dshHome, 'attachments', 'v1', 'objects')
  const requestImagesRoot = join(dshHome, 'cache', 'attachments', 'request-images')
  const uploadIndex = join(dshHome, 'llm-deepseek', 'files-v3.json')
  const sessionsRoot = join(dshHome, 'sessions')
  let ledger = null // { version, sessions: { [id]: { createdAt, lastUsedAt, retiredAt } } }
  let writing = Promise.resolve()
  let deleting = null // promise while objects are being removed (gate)
  let running = null
  const stats = { runs: 0, deleted: 0, deletedBytes: 0, kept: 0, skipped: 0, lastRunAt: null, lastError: null }

  async function load() {
    if (ledger) return ledger
    try {
      const raw = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
      ledger = raw?.version === LEDGER_VERSION && raw.sessions && typeof raw.sessions === 'object' ? raw : { version: LEDGER_VERSION, sessions: {} }
      if (!ledger.orphans || typeof ledger.orphans !== 'object') ledger.orphans = {}
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('bridge-assistant: image ledger unreadable, starting a new one: %s', error?.code ?? error?.name ?? 'error')
      ledger = { version: LEDGER_VERSION, sessions: {}, orphans: {} }
    }
    return ledger
  }

  function save() {
    const body = JSON.stringify(ledger)
    writing = writing.then(async () => {
      await fs.mkdir(ledgerDir, { recursive: true })
      const tmp = `${ledgerPath}.${process.pid}.${now()}.tmp`
      await fs.writeFile(tmp, body, { mode: 0o600 })
      await fs.rename(tmp, ledgerPath)
    }).catch((error) => logger.warn?.('bridge-assistant: image ledger write failed: %s', error?.code ?? error?.name ?? 'error'))
    return writing
  }

  /** A conversation of this plugin got images (call before the prompt). */
  async function track(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_DIR_RE.test(sessionId)) return
    await load()
    const t = now()
    const entry = ledger.sessions[sessionId]
    ledger.sessions[sessionId] = { createdAt: entry?.createdAt ?? t, lastUsedAt: t, retiredAt: null }
    await save()
  }

  /** Any send in a tracked conversation keeps it alive. */
  async function touch(sessionId) {
    await load()
    const entry = ledger.sessions[sessionId]
    if (!entry || entry.retiredAt) return
    entry.lastUsedAt = now()
    await save()
  }

  /** The conversation is over (reset, or idle): its images may go once nothing else refers to them. */
  async function retire(sessionId) {
    await load()
    const entry = ledger.sessions[sessionId]
    if (!entry || entry.retiredAt) return
    entry.retiredAt = now()
    await save()
  }

  /** An image given to the model once, outside any conversation (sha256 hex of the stored object, or "sha256:<hex>"). */
  async function orphan(attachmentId) {
    const id = /^(?:sha256:)?([0-9a-f]{64})$/.exec(String(attachmentId ?? ''))?.[1]
    if (!id) return
    await load()
    ledger.orphans[id] ??= now()
    await save()
  }

  /** Resolves when no removal is in progress (send() waits on it before a prompt with images). */
  function gate() {
    return deleting ?? Promise.resolve()
  }

  /** attachment ids per session (`session-…` dirs under sessions/) and in every other file; throws on an unreadable log. */
  async function collect({ since = 0 } = {}) {
    const bySession = new Map()
    const other = new Set()
    for await (const file of walk(sessionsRoot, fs)) {
      const st = await fs.stat(file)
      if (since && st.mtimeMs < since) continue
      const compressed = file.endsWith('.zstd')
      if (!compressed && st.size > PLAIN_MAX_BYTES) throw new Error('a session file is too large to check')
      const text = sessionLogText(await fs.readFile(file), { compressed })
      const sid = sessionOfPath(file, sessionsRoot)
      if (sid) attachmentIdsIn(text, bySession.get(sid) ?? bySession.set(sid, new Set()).get(sid))
      else attachmentIdsIn(text, other)
    }
    let tops = []
    try { tops = await fs.readdir(dshHome, { withFileTypes: true }) } catch { /* no home */ }
    for (const top of tops) {
      if (SKIP_TOP.has(top.name)) continue
      const p = join(dshHome, top.name)
      const files = top.isDirectory() ? walk(p, fs) : (async function* one() { if (top.isFile()) yield p })()
      for await (const file of files) {
        if (file === ledgerPath || file.startsWith(`${ledgerPath}.`)) continue
        const st = await fs.stat(file)
        if (since && st.mtimeMs < since) continue
        if (st.size > PLAIN_MAX_BYTES) throw new Error('a file of the DSH home is too large to check')
        attachmentIdsIn((await fs.readFile(file)).toString('latin1'), other)
      }
    }
    return { bySession, other }
  }

  async function variantsOf(ids) {
    const out = new Map()
    try {
      const index = JSON.parse(await fs.readFile(uploadIndex, 'utf8'))
      for (const r of Array.isArray(index?.records) ? index.records : []) {
        const id = /^sha256:([0-9a-f]{64})$/.exec(String(r?.attachmentId ?? ''))?.[1]
        const variant = /^sha256:([0-9a-f]{64})$/.exec(String(r?.variantId ?? ''))?.[1]
        if (id && variant && ids.has(id)) out.set(id, [...(out.get(id) ?? []), variant])
      }
    } catch { /* no upload index */ }
    return out
  }

  async function unlinkQuiet(path) {
    try {
      const st = await fs.stat(path)
      await fs.chmod(path, 0o600).catch(() => {}) // DSH publishes objects read-only; Windows refuses to unlink those
      await fs.unlink(path)
      return st.size
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
  }

  /**
   * One pass. live: the session ids this plugin is using now (never retired by idleness).
   * Returns { retired, deleted, kept, bytes } or { skipped: reason }.
   */
  async function runOnce({ live = new Set() } = {}) {
    await load()
    const t = now()
    let changed = false
    for (const [id, entry] of Object.entries(ledger.sessions)) {
      if (!entry.retiredAt && !live.has(id) && t - (entry.lastUsedAt ?? 0) > idleMs) { entry.retiredAt = t; changed = true }
    }
    if (changed) await save()
    const retired = Object.entries(ledger.sessions).filter(([id, e]) => e.retiredAt && !live.has(id)).map(([id]) => id)
    const orphans = Object.keys(ledger.orphans ?? {})
    if (!retired.length && !orphans.length) return { retired: 0, deleted: 0, kept: 0, bytes: 0 }
    const startedAt = now()
    let found
    try {
      found = await collect()
    } catch (error) {
      stats.skipped += 1
      logger.warn?.('bridge-assistant: image cleanup skipped (a log could not be read): %s', error?.message ?? 'error')
      return { skipped: 'unreadable' }
    }
    const retiredSet = new Set(retired)
    const candidates = new Set()
    const liveIds = new Set(found.other)
    for (const [sid, ids] of found.bySession) {
      for (const id of ids) (retiredSet.has(sid) ? candidates : liveIds).add(id)
    }
    for (const id of orphans) candidates.add(id)
    for (const id of liveIds) candidates.delete(id)
    const kept = [...retiredSet].reduce((n, sid) => n + [...(found.bySession.get(sid) ?? [])].filter((id) => liveIds.has(id)).length, 0)
    let deleted = 0
    let bytes = 0
    let release
    deleting = new Promise((r) => { release = r })
    try {
      if (candidates.size) {
        let recent
        try {
          recent = await collect({ since: startedAt - 1000 })
        } catch (error) {
          stats.skipped += 1
          logger.warn?.('bridge-assistant: image cleanup skipped (a log could not be re-read): %s', error?.message ?? 'error')
          return { skipped: 'unreadable' }
        }
        for (const [sid, ids] of recent.bySession) if (!retiredSet.has(sid)) for (const id of ids) candidates.delete(id)
        for (const id of recent.other) candidates.delete(id)
        const variants = await variantsOf(candidates)
        for (const id of candidates) {
          const size = await unlinkQuiet(join(objectsRoot, id.slice(0, 2), id))
          if (size) { deleted += 1; bytes += size }
          for (const v of variants.get(id) ?? []) await unlinkQuiet(join(requestImagesRoot, v.slice(0, 2), v)).catch(() => 0)
        }
      }
      for (const sid of retired) delete ledger.sessions[sid]
      for (const id of orphans) delete ledger.orphans[id]
      await save()
    } finally {
      deleting = null
      release()
    }
    stats.runs += 1
    stats.deleted += deleted
    stats.deletedBytes += bytes
    stats.kept += kept
    stats.lastRunAt = new Date(now()).toISOString()
    return { retired: retired.length, deleted, kept, bytes }
  }

  /** runOnce, one at a time; never throws (the error is logged and kept in stats). */
  function run(options) {
    if (running) return running
    running = runOnce(options)
      .catch((error) => {
        stats.lastError = error?.code ?? error?.name ?? 'error'
        logger.warn?.('bridge-assistant: image cleanup failed: %s', stats.lastError)
        return { skipped: 'error' }
      })
      .finally(() => { running = null })
    return running
  }

  return { track, touch, retire, orphan, gate, run, runOnce, stats: () => ({ ...stats }), _paths: { ledgerPath, objectsRoot, requestImagesRoot, sessionsRoot } }
}
