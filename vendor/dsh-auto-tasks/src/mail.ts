/**
 * dsh-auto-tasks — 邮件模块（IMAP 轮询 / SMTP 发信 / 垃圾邮件移动）。
 *
 * 设计要点：
 *   - 凭据只从 $DSH_HOME/auto-tasks/mail.json 读取（用户本机，ACL 限制）。
 *   - 不 import 第三方包：通过 createRequire 从 web profile 的 node_modules 取
 *     imapflow / mailparser / nodemailer（本机已随 dsh-im 安装）。
 *   - 增量轮询：首次只记录最新 UID，不处理历史积压；之后只取新邮件。
 *   - 垃圾邮件默认「移动」到配置的文件夹（可恢复），绝不永久删除。
 *   - 新邮件以 .json 候选写入 $DSH_HOME/auto-tasks/inbox/，交给自动任务处理。
 *
 * @module dsh-auto-tasks/mail
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { MailConfig, MailState, MailCandidate } from './types.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

interface ImapFlowLike {
  connect(): Promise<void>
  getMailboxLock(mailbox: string): Promise<{ release(): void }>
  fetchOne(seq: string, query: Record<string, unknown>, opts: Record<string, unknown>): Promise<{ source?: Buffer; uid?: number } | null>
  fetch(range: string, query: Record<string, unknown>, opts: Record<string, unknown>): AsyncIterable<{ uid?: number }>
  messageMove(uid: string, folder: string, opts: Record<string, unknown>): Promise<unknown>
  logout(): Promise<void>
}

interface ParsedMail {
  from?: { text?: string }
  subject?: string
  date?: Date | null
  text?: string
  messageId?: string
  headers?: unknown
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
function rootDir() { return join(dshHome(), 'auto-tasks') }
function inboxDir() { return join(rootDir(), 'inbox') }
function mailConfigFile() { return join(rootDir(), 'mail.json') }
function mailStateFile() { return join(rootDir(), 'mail-state.json') }
function mailLogFile() { return join(rootDir(), 'mail-log.jsonl') }

function ensureDir(dir: any) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJson(file: any, fallback: any) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file: any, value: any) {
  ensureDir(rootDir())
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function appendLog(entry: any) {
  ensureDir(rootDir())
  appendFileSync(mailLogFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

/** 从 web profile 的 node_modules 取邮件依赖（零声明依赖）。 */
function mailLibs() {
  const base = join(dshHome(), 'profiles', 'web', 'noop.js')
  const req = createRequire(base)
  const imap = req('imapflow')
  const parser = req('mailparser')
  const nodemailer = req('nodemailer')
  return { ImapFlow: imap.ImapFlow, simpleParser: parser.simpleParser, nodemailer }
}

export function loadMailConfig(): MailConfig {
  return readJson(mailConfigFile(), null)
}

export function saveMailConfig(patch: Partial<MailConfig>): MailConfig {
  const current = loadMailConfig() ?? {}
  const next = { ...current, ...(patch ?? {}) }
  writeJson(mailConfigFile(), next)
  return next
}

export function loadMailState(): MailState {
  return readJson(mailStateFile(), {
    lastUid: null,
    initializedAt: null,
    lastPollAt: null,
    lastError: null,
    lastWakeAt: null,
  })
}

export function saveMailState(state: MailState) {
  writeJson(mailStateFile(), state)
}

const SPAM_KEYWORDS = [
  '当選', '当せん', '副業', '出会い', 'アダルト', 'カジノ', '儲かる', '億万長者', '無料相談',
  'urgent business proposal', 'lottery', 'casino', 'viagra', 'bitcoin giveaway',
  'unsubscribe', '配信停止', 'special offer', 'limited time offer', 'クレジットカード情報',
]

function headerValue(headers: any, name: any) {
  try {
    const v = headers?.get?.(name)
    return v == null ? '' : String(v)
  } catch {
    return ''
  }
}

/** 规则只拦「高置信度垃圾」，其余一律交给模型判断。 */
function likelySpam(mail: MailCandidate, cfg: MailConfig) {
  const from = String(mail.from ?? '').toLowerCase()
  const subject = String(mail.subject ?? '').toLowerCase()
  const allow = (cfg.allowlist ?? []).map((d: any) => String(d).toLowerCase())
  if (allow.some((d: any) => from.includes(d))) return null

  const block = (cfg.spam?.blocklist ?? []).map((d: any) => String(d).toLowerCase())
  if (block.some((d: any) => from.includes(d))) return 'blocklist'

  const xSpam = headerValue(mail.headers, 'x-spam-status') || headerValue(mail.headers, 'x-spam-flag')
  if (/yes|true/i.test(xSpam)) return 'x-spam-header'

  const text = `${subject} ${String(mail.text ?? '').slice(0, 2000)}`.toLowerCase()
  if (SPAM_KEYWORDS.some((k: any) => text.includes(k.toLowerCase()))) return 'keyword'
  return null
}

function safeSlug(text: any, fallback: any = 'mail') {
  const s = String(text ?? '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return s || fallback
}

function writeCandidate(mail: MailCandidate) {
  ensureDir(inboxDir())
  const file = `${Date.now()}-${mail.uid}-${safeSlug(mail.subject)}.json`
  const body = {
    from: mail.from ?? '',
    subject: mail.subject ?? '(无主题)',
    text: mail.text ?? '',
    receivedAt: mail.date ? new Date(mail.date).toISOString() : new Date().toISOString(),
    uid: mail.uid,
    messageId: mail.messageId ?? null,
    source: 'mail',
  }
  writeJson(join(inboxDir(), file), body)
  return file
}

let polling = false

function candidateExists(uid: any) {
  try {
    const dir = inboxDir()
    if (!existsSync(dir)) return false
    return readdirSync(dir).some((f: any) => f.endsWith('.json') && f.includes(`-${uid}-`))
  } catch {
    return false
  }
}

/** 增量取信一次。首次只对齐游标（uidNext-1），不处理历史；单轮批量默认 20。 */
export async function pollMailOnce({ logger = null }: { logger?: any } = {}) {
  if (polling) return { ok: false, skipped: 'busy' }
  polling = true
  const cfg = loadMailConfig()
  if (!cfg || cfg.enabled === false) { polling = false; return { ok: false, skipped: 'disabled' } }
  if (!cfg.imap?.host || !cfg.imap?.user || !cfg.imap?.pass) { polling = false; return { ok: false, skipped: 'incomplete' } }

  const state: any = loadMailState()
  let client: ImapFlowLike | null = null
  const result: any = { ok: false, added: 0, moved: 0, firstRun: false, error: null }
  try {
    const { ImapFlow, simpleParser } = mailLibs()
    client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port ?? 993,
      secure: cfg.imap.secure !== false,
      auth: { user: cfg.imap.user, pass: cfg.imap.pass },
      logger: false,
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 60000,
    })
    if (!client) throw new Error('imap client init failed')
    await client.connect()
    const lock = await client.getMailboxLock(cfg.imap.mailbox || 'INBOX')
    try {
      // 最大 UID 必须用 UID 模式取 `*`；mailbox.exists 是消息条数，UID 会因删除而不连续。
      const newest = await client.fetchOne('*', { uid: true }, { uid: true })
      const maxUid = newest?.uid ?? 0
      if (state.lastUid == null) {
        state.lastUid = maxUid
        state.initializedAt = new Date().toISOString()
        state.lastPollAt = state.initializedAt
        state.lastError = null
        saveMailState(state)
        result.ok = true
        result.firstRun = true
        appendLog({ event: 'baseline', lastUid: maxUid })
        return result
      }
      if (state.lastUid >= maxUid) {
        state.lastPollAt = new Date().toISOString()
        state.lastError = null
        saveMailState(state)
        result.ok = true
        return result
      }

      // 先取 UID 列表（快），再按批取单封，避免大邮箱整批 source 拖死请求。
      const uids: number[] = []
      for await (const msg of client.fetch(`${state.lastUid + 1}:*`, { uid: true }, { uid: true })) {
        if (typeof msg.uid === 'number') uids.push(msg.uid)
      }
      uids.sort((a: any, b: any) => a - b)
      const batchSize = Math.max(1, Math.min(100, Number(cfg.batchSize ?? 20)))
      const batch = uids.slice(0, batchSize)

      for (const uid of batch) {
        if (candidateExists(uid)) {
          state.lastUid = uid
          saveMailState(state)
          continue
        }
        let parsed: ParsedMail | null = null
        let raw: { source?: Buffer; uid?: number } | null = null
        try {
          raw = await client.fetchOne(String(uid), { uid: true, source: true, headers: true }, { uid: true })
          if (!raw?.source) {
            state.lastUid = uid
            saveMailState(state)
            continue
          }
          parsed = await simpleParser(raw.source)
        } catch (error: any) {
          appendLog({ event: 'parse-error', uid, error: String(error?.message ?? error) })
          state.lastUid = uid
          saveMailState(state)
          continue
        }
        if (!parsed) {
          state.lastUid = uid
          saveMailState(state)
          continue
        }
        const item: any = {
          uid,
          from: parsed.from?.text ?? '',
          subject: parsed.subject ?? '',
          date: parsed.date ?? null,
          text: parsed.text ?? '',
          messageId: parsed.messageId ?? null,
          headers: parsed.headers,
        }
        const spamReason = likelySpam(item, cfg)
        if (spamReason && cfg.spam?.mode !== 'keep') {
          try {
            await client.messageMove(String(uid), cfg.spam?.folder || 'INBOX.spam', { uid: true })
            appendLog({ event: 'spam-moved', uid, reason: spamReason, from: item.from, subject: item.subject })
            result.moved += 1
          } catch (error: any) {
            appendLog({ event: 'spam-move-failed', uid, error: String(error?.message ?? error) })
            writeCandidate(item)
            result.added += 1
          }
        } else {
          const file = writeCandidate(item)
          appendLog({ event: 'candidate', uid, file, from: item.from, subject: item.subject })
          result.added += 1
        }
        state.lastUid = uid
        saveMailState(state)
      }
      state.lastPollAt = new Date().toISOString()
      state.lastError = null
      saveMailState(state)
      result.ok = true
      return result
    } finally {
      lock.release()
    }
  } catch (error: any) {
    result.error = String(error?.message ?? error)
    state.lastError = result.error
    state.lastPollAt = new Date().toISOString()
    saveMailState(state)
    appendLog({ event: 'poll-error', error: result.error })
    logger?.warn?.(`auto-tasks: mail poll failed (${result.error})`)
    return result
  } finally {
    polling = false
    try { if (client) await client.logout() } catch { /* ignore */ }
  }
}

export function mailStatus() {
  const cfg = loadMailConfig()
  const state = loadMailState()
  let candidates = 0
  try {
    const dir = inboxDir()
    if (existsSync(dir)) {
      candidates = readdirSync(dir).filter((f: any) => f.endsWith('.json')).length
    }
  } catch { /* ignore */ }
  return {
    enabled: cfg?.enabled !== false,
    account: cfg?.smtp?.user ?? cfg?.imap?.user ?? null,
    imapHost: cfg?.imap?.host ?? null,
    smtpHost: cfg?.smtp?.host ?? null,
    spamFolder: cfg?.spam?.folder ?? null,
    pollMinutes: cfg?.pollMinutes ?? null,
    candidates,
    lastUid: state.lastUid,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
  }
}

export function readMailCandidate(file: string): MailCandidate | null {
  const full = join(inboxDir(), file)
  if (!existsSync(full)) throw new Error('candidate not found')
  return JSON.parse(readFileSync(full, 'utf8'))
}

export function listMailCandidates(limit: number = 100): MailCandidate[] {
  const dir = inboxDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f: any) => f.endsWith('.json'))
    .slice(0, limit)
    .map((f: any): MailCandidate | null => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return { file: f, from: j.from, subject: j.subject, preview: String(j.text ?? '').replace(/\s+/g, ' ').slice(0, 200), receivedAt: j.receivedAt, uid: j.uid }
      } catch {
        return null
      }
    })
    .filter((x: MailCandidate | null): x is MailCandidate => x !== null)
}

/** 把候选对应的邮件移到垃圾文件夹（可恢复）。 */
export async function moveCandidateToSpam(file: string, { logger = null }: { logger?: any } = {}) {
  const cfg = loadMailConfig()
  if (!cfg) throw new Error('mail.json missing')
  if (!cfg.imap) throw new Error('imap config missing')
  const candidate = readMailCandidate(file)
  if (!candidate || !candidate.uid) throw new Error('candidate has no uid')
  const { ImapFlow } = mailLibs()
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port ?? 993,
    secure: cfg.imap.secure !== false,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  })
  await client.connect()
  try {
    await client.messageMove(String(candidate.uid), cfg.spam?.folder || 'INBOX.spam', { uid: true })
    appendLog({ event: 'spam-moved', uid: candidate.uid, file, from: candidate.from, subject: candidate.subject, source: 'agent' })
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }
  ensureDir(join(inboxDir(), 'junked'))
  try { renameSync(join(inboxDir(), file), join(inboxDir(), 'junked', `${Date.now()}-${file}`)) } catch { /* ignore */ }
  return { ok: true, uid: candidate.uid }
}

/** SMTP 发信（调用方负责展示与确认）。 */
export async function sendMail({ to, subject, text, inReplyTo = null, references = null }: {
  to: string
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string | null
}) {
  const cfg = loadMailConfig()
  if (!cfg?.smtp?.host) throw new Error('smtp config missing')
  const { nodemailer } = mailLibs()
  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port ?? 587,
    secure: cfg.smtp.secure === true,
    requireTLS: cfg.smtp.requireTLS !== false,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  })
  const info = await transporter.sendMail({
    from: cfg.smtp.from || cfg.smtp.user,
    to,
    subject,
    text,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  })
  appendLog({ event: 'sent', to, subject, messageId: info.messageId, response: info.response })
  return { ok: true, messageId: info.messageId, response: info.response }
}

/** 删除候选文件（不碰邮件本身）。 */
export function discardCandidate(file: string) {
  try { unlinkSync(join(inboxDir(), file)) } catch { /* ignore */ }
}

/** 把已处理过的候选移入 inbox/processed/，避免下一轮重复推送。 */
export function archiveCandidates() {
  const dir = inboxDir()
  if (!existsSync(dir)) return 0
  ensureDir(join(dir, 'processed'))
  let moved = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      renameSync(join(dir, f), join(dir, 'processed', `${Date.now()}-${f}`))
      moved += 1
    } catch { /* ignore */ }
  }
  return moved
}

