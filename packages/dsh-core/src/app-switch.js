// app-switch.js — 共用ボット（個人 WeChat：1 つの WeChat アカウントに 1 ボット）の「同じ窓口内のアプリケーション切り替え」。
// BRIDGE_ARCHITECTURE §15.2・BRIDGE_STAGE2_PLAN B2-wechat。
//
// 1 つのボットが複数のアプリケーションを載せる（レジストリで multiApp: true のボットだけ）。会話ごとに「いまのアプリ」を持ち、
// dsh-im はその会話の発言をアプリケーションごとの DSH セッションに振り分ける（文脈・メモリ・ツールが混ざらない）。
//
//   #一覧          使えるアプリケーションの一覧（いまのアプリに印）
//   #<アプリ名>    切り替え（name・id・namespace・aliases のどれか。例 #点検 #設備点検）
//   #いま          いまのアプリ
//   #ヘルプ        使い方
//
// 返信は【アプリ名】で始まる。アプリケーションからの通知も【アプリ名】付きで送り、記録しておく：
//   - 通知（または【アプリ名】で始まるメッセージ）を引用した返信 → そのアプリケーション（quoteRetentionMs の間）
//   - 引用なしでも、通知の後に最初に送られた発言で replyWindowMs 以内 → その通知のアプリケーション
// どちらも「いまのアプリ」をそのアプリケーションに切り替える（以後の返信の【アプリ名】で利用者に見える）。
//
// 決めるのは信頼できる値だけ：ボット（platform / botId）と会話は dsh-im の ImSource、載せるアプリケーションはレジストリ、
// 選択は本人がその会話で送ったコマンドかボット自身が送った通知の記録。本文で「別のボットのアプリケーション」には行けない。
// アプリケーションを選んでも権限は増えない（各アプリケーションで本人の連携が別に要る。委託はアプリケーションごと）。
import { conversationKeyOf } from './session.js'
import { normalizeText } from './runtime.js'
import { SECRETARY_LABEL_RE } from './secretary.js'

export const SWITCH_LIST_WORDS = Object.freeze(['一覧', 'いちらん', 'アプリ', 'apps', 'list'])
export const SWITCH_CURRENT_WORDS = Object.freeze(['いま', '今', '現在', 'now', 'current'])
export const SWITCH_HELP_WORDS = Object.freeze(['ヘルプ', '使い方', 'つかいかた', 'help', '?'])
export const DEFAULT_REPLY_WINDOW_MS = 10 * 60_000
export const DEFAULT_QUOTE_RETENTION_MS = 7 * 24 * 60 * 60_000
const MIN_QUOTE_MATCH = 4
const PREFIX_RE = /^【([^】\n]{1,40})】/u

const fold = (value) => normalizeText(value).toLowerCase()
const squash = (value) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '')

/**
 * 「#一覧」「#いま」「#ヘルプ」「#<アプリ名>」。全角の ＃ ？ も可（NFKC）。1 行・空白なし・32 文字以内だけ。
 * @returns {{kind: 'list'|'current'|'help'} | {kind: 'switch', query: string} | null}
 */
export function parseSwitchCommand(text) {
  const body = normalizeText(text)
  const match = /^#\s*([^\s#]{1,32})$/u.exec(body)
  if (!match) return null
  const word = match[1]
  const lower = word.toLowerCase()
  if (SWITCH_LIST_WORDS.includes(lower)) return { kind: 'list' }
  if (SWITCH_CURRENT_WORDS.includes(lower)) return { kind: 'current' }
  if (SWITCH_HELP_WORDS.includes(lower)) return { kind: 'help' }
  return { kind: 'switch', query: word }
}

/** 【アプリ名】 */
export function appPrefix(app) {
  const name = app?.name ?? app?.id ?? ''
  return name ? `【${name}】` : ''
}

/**
 * 返信・通知の先頭に【アプリ名】を付ける（既に【…】で始まる文はそのまま）。ただし AI 秘書のラベル
 * （【ご報告】【対応のお願い】【至急】【承認のお願い】【定時のご報告】）で始まる文はアプリ名ではないので前に付ける。
 */
export function withAppPrefix(app, text) {
  const body = typeof text === 'string' ? text : String(text ?? '')
  if (!app || !body.trim()) return body
  const lead = body.trimStart()
  if (lead.startsWith(appPrefix(app)) || (lead.startsWith('【') && !SECRETARY_LABEL_RE.test(lead))) return body
  return `${appPrefix(app)}${body}`
}

/** 送信先（{ userId } / { conversationId }）から、受信側の ImSource と同じ会話のキーを作るための疑似 source。 */
function outboundSource({ platform, botId, teamId, to } = {}) {
  const conversationId = to?.conversationId ?? to?.userId
  return { platform, botId, ...(teamId ? { teamId } : {}), conversationId, userId: to?.userId ?? conversationId }
}

/**
 * @param {object} options
 * @param {object|(() => object)} options.registry  @dsh-bridge/dsh-core のレジストリ（applicationsForBot / isMultiAppBot / sharedDefaultApplication）
 * @param {number} [options.replyWindowMs]     引用なしの返信を通知に結び付ける時間（0 で無効）
 * @param {number} [options.quoteRetentionMs]  引用で通知に結び付けられる期間
 * @param {() => void} [options.onChange]      状態が変わった（保存の合図）
 */
export function createAppSwitch({
  registry, now = Date.now, replyWindowMs = DEFAULT_REPLY_WINDOW_MS, quoteRetentionMs = DEFAULT_QUOTE_RETENTION_MS,
  maxConversations = 10_000, maxNotifications = 2_000, onChange = () => {},
} = {}) {
  const reg = () => (typeof registry === 'function' ? registry() : registry)
  const currents = new Map() // conversation key -> applicationId
  const lastInbound = new Map() // conversation key -> ms
  const notices = new Map() // conversation key -> { applicationId, reason }（次の返信で 1 回だけ知らせる）
  let notifications = [] // { key, applicationId, text, messageId, at }

  const keyOf = (source) => [source?.platform ?? '', source?.botId ?? '', conversationKeyOf(source)].join('\u0000')
  const changed = () => { try { onChange() } catch { /* ignore */ } }

  function isShared(source) {
    return reg()?.isMultiAppBot?.(source) === true
  }

  /** そのボットで選べるアプリケーション（共用ボットでなければ []）。 */
  function applications(source) {
    if (!isShared(source)) return []
    return (reg().applicationsForBot(source) ?? []).filter(Boolean)
  }

  function permitted(source, applicationId) {
    return applications(source).find((app) => app.id === String(applicationId ?? '')) ?? null
  }

  function bounded(map) {
    while (map.size > maxConversations) map.delete(map.keys().next().value)
  }

  /** いまのアプリ（選択が無いか、もう載っていなければ共用ボットの既定）。共用ボットでなければ null。 */
  function current(source) {
    if (!isShared(source)) return null
    const chosen = permitted(source, currents.get(keyOf(source)))
    return chosen ?? reg().sharedDefaultApplication?.(source) ?? applications(source)[0] ?? null
  }

  function select(source, applicationId) {
    const app = permitted(source, applicationId)
    if (!app) return null
    const key = keyOf(source)
    currents.delete(key)
    currents.set(key, app.id)
    notices.delete(key)
    bounded(currents)
    changed()
    return app
  }

  /** 「#<アプリ名>」の名前 → アプリケーション（id・name・namespace・aliases。大文字小文字・全角半角は区別しない）。 */
  function find(source, query) {
    const q = fold(query)
    if (!q) return null
    return applications(source).find((app) => [app.id, app.name, app.namespace, ...(app.aliases ?? [])]
      .filter(Boolean).some((name) => fold(name) === q)) ?? null
  }

  function list(source) {
    const cur = current(source)
    return applications(source).map((app) => ({ app, current: app.id === cur?.id }))
  }

  function prune() {
    const cutoff = now() - Math.max(quoteRetentionMs, replyWindowMs)
    if (notifications.length > 0 && notifications[0].at < cutoff) notifications = notifications.filter((n) => n.at >= cutoff)
    if (notifications.length > maxNotifications) notifications = notifications.slice(-maxNotifications)
  }

  /**
   * アプリケーションからの通知を共用ボットで送る前に呼ぶ。【アプリ名】を付けた本文を返し、返信の結び付けのために記録する。
   * 共用ボットでなければ本文をそのまま返す（記録しない）。applicationId が無いか、そのボットに載っていなければ共用ボットの既定。
   * @returns {{ text: string, applicationId: string|null, shared: boolean }}
   */
  function noteNotification({ applicationId, platform, botId, teamId, to, text, messageId, at } = {}) {
    const source = outboundSource({ platform, botId, teamId, to })
    if (!isShared(source)) return { text, applicationId: applicationId ?? null, shared: false }
    const app = permitted(source, applicationId) ?? reg().sharedDefaultApplication?.(source) ?? null
    if (!app) return { text, applicationId: null, shared: true }
    const decorated = withAppPrefix(app, text)
    if (source.conversationId) {
      notifications.push({
        key: keyOf(source), applicationId: app.id, text: squash(decorated).slice(0, 2000),
        messageId: messageId ? String(messageId) : null, at: Number.isFinite(at) ? at : now(),
      })
      prune()
      changed()
    }
    return { text: decorated, applicationId: app.id, shared: true }
  }

  /** 送った通知のメッセージ ID が後から分かったとき（引用の照合に使う）。 */
  function noteNotificationMessageId({ platform, botId, teamId, to, text, messageId } = {}) {
    if (!messageId) return false
    const key = keyOf(outboundSource({ platform, botId, teamId, to }))
    const body = squash(text)
    for (let i = notifications.length - 1; i >= 0; i -= 1) {
      const n = notifications[i]
      if (n.key === key && !n.messageId && (!body || n.text === body)) {
        n.messageId = String(messageId)
        changed()
        return true
      }
    }
    return false
  }

  /** 引用（replyTo: { messageId?, content? }）→ アプリケーション。 */
  function quoted(source, replyTo) {
    if (!replyTo || typeof replyTo !== 'object') return null
    const content = squash(replyTo.content)
    const prefix = PREFIX_RE.exec(content)?.[1]
    if (prefix) {
      const named = applications(source).find((app) => fold(app.name) === fold(prefix))
      if (named) return named
    }
    const key = keyOf(source)
    const messageId = replyTo.messageId ? String(replyTo.messageId) : null
    const cutoff = now() - quoteRetentionMs
    for (let i = notifications.length - 1; i >= 0; i -= 1) {
      const n = notifications[i]
      if (n.key !== key || n.at < cutoff) continue
      const hit = (messageId && n.messageId === messageId)
        || (content.length >= MIN_QUOTE_MATCH && n.text.includes(content))
      if (hit) {
        const app = permitted(source, n.applicationId)
        if (app) return app
      }
    }
    return null
  }

  /** 引用なし：最後の通知の後に最初に届いた発言で、時間内ならその通知のアプリケーション。 */
  function answering(source, at) {
    if (!(replyWindowMs > 0)) return null
    const key = keyOf(source)
    const since = lastInbound.get(key) ?? -Infinity
    for (let i = notifications.length - 1; i >= 0; i -= 1) {
      const n = notifications[i]
      if (n.key !== key) continue
      if (n.at <= since || at - n.at > replyWindowMs || n.at > at) return null
      return permitted(source, n.applicationId)
    }
    return null
  }

  /**
   * 受信した発言 1 件のアプリケーションを決める（dsh-im の会話ルーター）。共用ボットでなければ null。
   * 切り替えコマンドの発言は通知に結び付けない（明示の操作を優先）。
   * @returns {{ applicationId: string, reason: 'command'|'quote'|'reply-window'|'current', switched: boolean } | null}
   */
  function route({ source, text, replyTo } = {}) {
    if (!isShared(source)) return null
    const key = keyOf(source)
    const at = now()
    const command = parseSwitchCommand(text)
    let chosen = null
    let reason = command ? 'command' : 'current'
    if (!command) {
      chosen = quoted(source, replyTo)
      if (chosen) reason = 'quote'
      else {
        chosen = answering(source, at)
        if (chosen) reason = 'reply-window'
      }
    }
    lastInbound.delete(key)
    lastInbound.set(key, at)
    bounded(lastInbound)
    const before = current(source)
    let switched = false
    if (chosen && chosen.id !== before?.id) {
      currents.delete(key)
      currents.set(key, chosen.id)
      bounded(currents)
      notices.set(key, { applicationId: chosen.id, reason })
      switched = true
    }
    changed()
    const app = chosen ?? before
    return app ? { applicationId: app.id, reason, switched } : null
  }

  /** route が通知への返信で切り替えたとき、次の返信で 1 回だけ知らせる内容（無ければ null）。 */
  function takeNotice(source, applicationId) {
    const key = keyOf(source)
    const notice = notices.get(key)
    if (!notice || (applicationId && notice.applicationId !== applicationId)) return null
    notices.delete(key)
    return notice
  }

  function snapshot() {
    prune()
    return {
      version: 1,
      currents: Object.fromEntries(currents),
      lastInbound: Object.fromEntries(lastInbound),
      notifications: notifications.map((n) => ({ ...n })),
    }
  }

  function restore(data) {
    if (!data || typeof data !== 'object' || data.version !== 1) return false
    currents.clear()
    lastInbound.clear()
    for (const [key, id] of Object.entries(data.currents ?? {})) if (typeof id === 'string') currents.set(key, id)
    for (const [key, at] of Object.entries(data.lastInbound ?? {})) if (Number.isFinite(at)) lastInbound.set(key, at)
    notifications = (Array.isArray(data.notifications) ? data.notifications : [])
      .filter((n) => n && typeof n.key === 'string' && typeof n.applicationId === 'string' && Number.isFinite(n.at))
      .map((n) => ({ key: n.key, applicationId: n.applicationId, text: squash(n.text), messageId: n.messageId ?? null, at: n.at }))
    prune()
    return true
  }

  return {
    isShared,
    applications,
    current,
    select,
    find,
    list,
    route,
    takeNotice,
    noteNotification,
    noteNotificationMessageId,
    snapshot,
    restore,
    stats: () => ({ conversations: currents.size, notifications: notifications.length }),
  }
}
