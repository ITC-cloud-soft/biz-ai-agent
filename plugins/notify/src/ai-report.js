// ai-report.js — AI 社員の定時報告（定時報告 オン / オフ / テスト）のエンジン。
//
// 規則ベースの報告（業務システムが作る定時報告のイベント → bridge-notify の文面）とは別の層。モデルが使えなくても規則ベースの報告は届く。
// こちらは AI 社員が自分の IM 会話で「誰が何を確認すべきか」を添えて報告する。
//
// 有効にする方法（職員本人が、ボットとの個別チャットで）：
//   1. 業務 Web で SNS 連携し、AI 社員（ボット）に一度話しかける（この会話の sessionId を覚える：dsh-im の 'dsh-im/inbound' イベント。
//      プラットフォームのイベントから作られた信頼できる発信元だけを使う）。
//   2. 「定時報告 オン」と送る（claimReplies。エージェントには渡らない。キーワードは設定 aiReportCommand）。設定した役割（既定
//      admin / manager）の職員だけ。→ 報告の時刻（業務システムの reportSettings の経路、無ければ manifest の reports.*.cron）ごとに、
//      この会話へ dsh-proactive の business アラーム（cron・respect_quiet_hours=false）を作る。IM へ届けるため dsh-im の配信先
//      （createTarget：個別チャット）を作り、アラームの deliver_to にする。
//   3. 「定時報告 オフ」で削除、「定時報告」で状態、「定時報告 テスト」で今すぐ 1 回起動。
// アラームのターンでは IM の発信者がいないため、bridge-tools の gate は ownerOf(sessionId)（ここで保存した本人の発信元）と
// dshProactive.activeWake(sessionId)（その会話で business モードの起動ターンが実行中の間だけ）で、本人の委任・読み取りだけを許す。
//
// 報告の中身（拡張点 = 差し替えられる報告のテンプレート）：
//   AI への指示（prompt）は アプリケーションごとの aiReportPrompt → プラグインの aiReportPrompt → manifest の reports.*.playbook の instructions
//   → 既定の指示（<namespace>_* のツールで確認し、【定時のご報告】の形で 1 通）の順。先頭は必ず AI_REPORT_MARKER（アラームの識別に使う）。
//
// 宛先の保証（N1b。dsh-proactive の FORK #14・#15 の守卫を使う。apply が ctx.dshProactive に登録する）：
//   - 起動の直前（wakeGuard）：本人が今も在職・連携済み（業務システムの identity。個人ボットはその持ち主だけ）・同じ 1:1 の会話・
//     許された役割かを業務システムに確かめる。違えば起動せず（skipped）、その会話の定時報告を止める（アラームを消し、本人の記録を消す）。
//     業務システムに届かないときはその回だけ起動しない（止めない）。
//   - IM へ送る直前（deliveryGuard）：送り先は本人の 1:1 の配信先（enable で作った reportTargetId と本人のボット）だけ。
//     本文は aiReportGuard（off / screen / template。既定 screen）：screen は @dsh-bridge/dsh-core の screenOutboundText で
//     金額・敬称つきの人名・連絡先・業務 Web 以外の URL・長すぎる文・健康情報の語（HEALTH_WORDS、G1）を見つけたら、全文を固定の文面（件名・あいさつ・業務 Web で確認・リンク・署名）に置き換える。
//     template は常に固定の文面。定時報告以外の business アラームの IM 送信は proactiveDelivery（allow / deny）で決める。
//
// 複数アプリケーション：会話（ボット。共用ボットは dsh-im が付けた会話のアプリケーション）のアプリケーションに結び付ける。
// 本人確認・役割はそのアプリケーションの API。ownerOf は既定以外のアプリケーションでは applicationId を含める（bridge-tools の gate が照合する）。
import { createHash } from 'node:crypto'
import {
  BridgeApiError, DEFAULT_APPLICATION_ID, REPORT_LABEL, appNickname, V1_PATHS, apiSource, appPath, frameMessage, hasPath, normalizeText, registryGetter, scopedKey,
  screenOutboundText, signatureOf, singleApplicationRegistry, sourceKey,
} from '@dsh-bridge/dsh-core'
import { absoluteLink } from './templates.js'

export const AI_REPORT_MARKER = '【定時業務報告】'
export const DEFAULT_AI_REPORT_COMMAND = '定時報告'
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 「<キーワード> オン / オフ / 状態 / テスト」の正規表現。 */
export function commandPattern(keyword = DEFAULT_AI_REPORT_COMMAND) {
  const word = String(keyword ?? '').normalize('NFKC').trim() || DEFAULT_AI_REPORT_COMMAND
  return new RegExp(`^${escapeRe(word)}\\s*(オン|on|開始|有効|オフ|off|停止|無効|状態|確認|テスト|test)?$`, 'i')
}
export const COMMAND_RE = commandPattern()

/**
 * 既定の指示（アプリケーションの manifest に報告の playbook が無く、設定も無いとき）。報告の形は AI 秘書（docs の IM の文面の決まり）：
 * 【定時のご報告】/ あいさつ / ■ 対応が必要なこと / ■ ご参考 / 署名。
 */
export function defaultReportPrompt(app) {
  return `定時業務報告の時刻です。${app?.namespace ?? 'app'}_* のツールで最新の業務状況を確認し、必ず 1 通だけ、${app?.name ?? '業務システム'}の AI 秘書として担当者への簡潔な報告を日本語で返してください。`
    + '1 行目は「【定時のご報告】」と日時、次に時刻に合ったあいさつ（名前は書かない）。「■ 対応が必要なこと」（件数が 1 以上で誰かが対応するものだけ。役割名と、何をするかをお願いの形で）と'
    + `「■ ご参考」（情報だけ）を分け、対応が必要なものが無ければそう一言添える。最後の行は「${signatureOf(app?.name ?? '業務システム', appNickname(app, undefined))}」。`
    + '氏名・個人の情報・自由記述は書かない。件数はツールの結果どおりに書き、推測で補わない。この報告では proactive_reclaim を使わない。'
}
const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/
export const DEFAULT_REPORT_ROLES = Object.freeze(['admin', 'manager'])
export const AI_REPORT_GUARDS = Object.freeze(['off', 'screen', 'template'])
/** 定時報告の固定の文面（AI の文が検査を通らないとき・aiReportGuard: template）。業務の中身は書かない。nickname：AI 社員の呼び名（署名） */
export function reportTemplate({ appName, nickname, url = null, now = Date.now() } = {}) {
  return frameMessage({
    intent: 'info', label: REPORT_LABEL, title: '',
    lead: '定時業務報告の時刻になりました。最新の状況は業務 Web のダッシュボードでご確認ください。',
    url, now, signature: signatureOf(appName, nickname),
  }).body
}
const CLOSED = new Set(['cancelled', 'completed', 'failed'])

// 会話の返事（ラベルは付けない。AI 秘書の口調で、次にできることを添える）
const MSG = {
  enabled: (times, delivery, tz, k = DEFAULT_AI_REPORT_COMMAND) => `承知しました。定時業務報告をオンにしました（毎日 ${times.join('・')}、${tz === 'Asia/Tokyo' ? '日本時間' : tz}）。この会話にご報告します。`
    + (delivery === 'im' ? '' : '（このチャンネルでは報告を自動で転送できないため、DSH の会話にだけ残ります）')
    + `止めるときは「${k} オフ」、今すぐ試すときは「${k} テスト」と送ってください。`,
  disabled: (n, k = DEFAULT_AI_REPORT_COMMAND) => (n ? `承知しました。定時業務報告をオフにしました。また必要になったら「${k} オン」と送ってください。` : `定時業務報告は設定されていません。始めるときは「${k} オン」と送ってください。`),
  status: (times, k = DEFAULT_AI_REPORT_COMMAND) => (times.length ? `定時業務報告はオンです（毎日 ${times.join('・')}）。この時刻にこの会話へご報告します。` : `定時業務報告はオフです。「${k} オン」で始められます。`),
  fired: '定時業務報告を今すぐ 1 回起動しました。まとまり次第、この会話にお届けします。',
  notEnabled: (k = DEFAULT_AI_REPORT_COMMAND) => `定時業務報告がオフになっています。先に「${k} オン」と送ってください。`,
  notLinked: 'このアカウントはまだ業務システムと連携していません。お手数ですが、業務Webで SNS 連携をしてから、もう一度お試しください。',
  role: '申し訳ありません。定時業務報告は、設定された役割（管理者・責任者など）の方だけが設定できます。',
  direct: '定時業務報告の設定は、ボットとの個別チャットでお願いします。',
  noSession: (k = DEFAULT_AI_REPORT_COMMAND) => `お手数ですが、まずこの会話で AI 社員に一度話しかけてから、もう一度「${k} オン」と送ってください。`,
  noTimes: '報告の時刻がまだ設定されていません（業務システムの定時報告の設定、または manifest の reports）。管理者に設定をご依頼ください。',
  unavailable: '申し訳ありません。この環境では定時の呼び出し（dsh-proactive）が使えません。管理者にご連絡ください。',
  failed: '申し訳ありません。定時業務報告の設定に失敗しました。時間をおいて再度お試しいただくか、管理者にご連絡ください。',
  noApplication: '申し訳ありません。このボットはどの業務システムにも割り当てられていません。管理者にご連絡ください。',
}

const fail = (code, message) => Object.assign(new Error(message ?? code), { code })

const WHATSAPP_USER_JID_RE = /^\d{5,32}@(s\.whatsapp\.net|lid)$/
const MATRIX_USER_RE = /^@[^:\s]+:[^\s:]+(?::\d{1,5})?$/u

/**
 * 個別チャットの配信先（dsh-im の createTarget 形。plugin-src/host/delivery-adapter.mjs の normalizeRoute と同じ形）。
 * プラットフォームで個別チャットの宛先が決まらないもの（Teams の会話 ID が無い等）・email（通知専用のプラットフォーム。報告の会話にならない）は null。
 */
export function deliveryDraft(source) {
  const user = typeof source?.userId === 'string' ? source.userId : ''
  const conversation = typeof source?.conversationId === 'string' ? source.conversationId : ''
  switch (source?.platform) {
    case 'weixin': return user ? { kind: 'user', route: { toUserId: user } } : null
    case 'telegram': return conversation || user ? { kind: 'chat', route: { chatId: String(conversation || user) } } : null
    case 'slack': return conversation ? { kind: 'conversation', route: { channelId: conversation } } : null
    case 'line': return user ? { kind: 'user', route: { userId: user } } : null
    case 'feishu': return user ? { kind: 'user', route: { openId: user } } : null
    case 'dingtalk': return user ? { kind: 'user', route: { userId: user } } : null
    // WeCom（企業微信）のボット・自社開発アプリ：個別チャットの chatId は発信者の userid
    case 'wecom': return user ? { kind: 'user', route: { chatId: user } } : null
    case 'wecom-app': return user ? { kind: 'user', route: { chatId: user } } : null
    // Teams：配信は会話の参照（serviceUrl）を持つ既存の会話にだけ届く
    case 'teams': return conversation ? { kind: 'conversation', route: { conversationId: conversation } } : null
    case 'qq': return user ? { kind: 'user', route: { userOpenId: user } } : null
    case 'whatsapp': {
      const jid = [conversation, user].find((v) => WHATSAPP_USER_JID_RE.test(v))
      return jid ? { kind: 'user', route: { jid } } : null
    }
    case 'matrix': return MATRIX_USER_RE.test(user) ? { kind: 'dm', route: { userId: user } } : null
    // Discord：ユーザーの DM チャンネル宛て（bridge fork の dsh-im の kind 'user'）
    case 'discord': return /^\d{5,30}$/.test(user) ? { kind: 'user', route: { userId: user } } : null
    // iMessage：会話（chat GUID）宛て
    case 'imessage': return conversation ? { kind: 'user', route: { chatGuid: conversation } } : null
    default: return null
  }
}

export const DEFAULT_REPORT_TARGET_PREFIX = 'bridge-report'
/** 配信先 ID（同じ職員・同じプラットフォームで常に同じ）。prefix は設定 aiReportTargetPrefix（英数字と -）。 */
export function reportTargetId(source, prefix = DEFAULT_REPORT_TARGET_PREFIX) {
  const s = apiSource(source)
  const head = /^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(String(prefix ?? '')) ? String(prefix) : DEFAULT_REPORT_TARGET_PREFIX
  return `${head}-${createHash('sha256').update(`${s?.platform}:${s?.teamId ?? ''}:${s?.userId}`).digest('hex').slice(0, 16)}`
}

/** manifest の cron（'M H * * *'、H は 8,17 のような列挙も可）→ 'HH:MM' の配列。毎日でないものは無視。 */
export function timesOfCron(expr) {
  const m = /^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/.exec(String(expr ?? '').trim())
  if (!m) return []
  const minute = Number(m[1])
  if (minute > 59) return []
  return m[2].split(',').map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .map((h) => `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
}

/** 'HH:MM'（JST）→ cron（毎日）。 */
export function cronOf(hhmm) {
  const m = HHMM_RE.exec(hhmm)
  if (!m) throw fail('invalid_time', `invalid time ${hhmm}`)
  return `${Number(m[2])} ${Number(m[1])} * * *`
}

function memoryTable() {
  const map = new Map()
  return { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, structuredClone(v)) }, delete: async (k) => map.delete(k) }
}

/**
 * @param deps.registry   アプリケーションレジストリ（@dsh-bridge/dsh-core。関数なら呼び出しごとに評価）
 * @param deps.api        レジストリの代わりに業務 API クライアント 1 つ（サービストークン。Bridge v1 の経路。単体テスト）
 * @param deps.paths      api を渡すときの経路の上書き（例 { reportSettings: '/api/report/settings' }）
 * @param deps.dshIm      ctx.dshIm（listTargets / createTarget）
 * @param deps.proactive  () => ctx.dshProactive（state / action）| null
 * @param deps.tables     { sessions, owners }（KvTable 互換）
 * @param deps.prompt     () => 全アプリケーション共通の指示（空なら manifest の報告 playbook → 既定の指示）
 * @param deps.roles      () => 「定時報告 オン」を許す役割（既定 admin / manager）
 * @param deps.command    () => コマンドのキーワード（既定 定時報告）
 * @param deps.applicationOptions  (applicationId) => { aiReportPrompt?, aiReportRoles? }（アプリケーションごとの上書き）
 * @param deps.messages   () => { notLinked?, role?, direct?, noTimes?, unavailable?, failed?, noApplication?, fired? }（返事の上書き）
 * @param deps.targetPrefix () => dsh-im の配信先 ID の接頭辞（既定 bridge-report）
 */
export function createAiReporter({
  api, paths = {}, registry = null, dshIm, proactive = () => null, tables = { sessions: memoryTable(), owners: memoryTable() },
  prompt = () => '', roles = () => DEFAULT_REPORT_ROLES, command = () => DEFAULT_AI_REPORT_COMMAND, applicationOptions = () => ({}),
  messages = () => ({}), targetPrefix = () => DEFAULT_REPORT_TARGET_PREFIX,
  webUrl = () => '', guardMode = () => 'screen', proactiveDelivery = () => 'allow',
  timeZone = 'Asia/Tokyo', logger = console, now = Date.now,
}) {
  const { sessions, owners } = tables
  const stats = { enabled: 0, disabled: 0, fired: 0, denied: 0, skipped: 0, revoked: 0, screened: 0, refused: 0, lastError: null }
  const single = api ? singleApplicationRegistry(api, { id: DEFAULT_APPLICATION_ID, name: 'business', label: 'business API', namespace: 'app', paths: { ...V1_PATHS, ...paths } }) : null
  let commandFor = null
  let commandRe = COMMAND_RE
  const keyword = () => String(command() || DEFAULT_AI_REPORT_COMMAND)
  const currentCommandRe = () => {
    const k = keyword()
    if (k !== commandFor) { commandRe = commandPattern(k); commandFor = k }
    return commandRe
  }
  const getRegistry = single ? () => single : registryGetter(registry)
  const defaultId = () => getRegistry()?.default?.()?.id ?? DEFAULT_APPLICATION_ID
  const isDefault = (id) => !id || id === defaultId()
  /** 会話（信頼できる発信元のボット。共用ボットは dsh-im が付けた applicationId）のアプリケーション。 */
  const appFor = (source) => getRegistry()?.resolveApplication?.(source) ?? null
  const sessionKeyOf = (app, s) => scopedKey(app?.id, defaultId(), sourceKey(s))

  /** 'dsh-im/inbound'：連携済みかどうかに関係なく、個別チャットの発信元 → sessionId を覚える（判定は有効化の時）。 */
  async function noteInbound(e) {
    const source = e?.source
    const s = apiSource(source)
    if (!s || typeof e?.sessionId !== 'string' || !e.sessionId) return
    if (source.conversationKind && source.conversationKind !== 'direct') return
    const app = appFor(source)
    if (!app) return
    const key = sessionKeyOf(app, s)
    const prev = sessions.get(key)
    if (prev?.sessionId === e.sessionId) return
    await sessions.put(key, { sessionId: e.sessionId, at: now(), ...(isDefault(app.id) ? {} : { applicationId: app.id }) })
  }

  /** 報告の時刻：業務システムの設定（reportSettings の経路があれば）か、無ければ manifest の reports.*.cron。 */
  async function scheduleOf(app) {
    if (hasPath(app, 'reportSettings')) {
      const sched = await app.api.get(appPath(app, 'reportSettings'))
      return { times: (Array.isArray(sched?.times) ? sched.times : []).filter((t) => HHMM_RE.test(t)), timeZone: sched?.timeZone || timeZone }
    }
    const manifest = app.manifest?.() ?? null
    const times = new Set()
    for (const rep of Object.values(manifest?.reports ?? {})) {
      for (const expr of Array.isArray(rep?.cron) ? rep.cron : [rep?.cron]) for (const t of timesOfCron(expr)) times.add(t)
    }
    return { times: [...times].sort(), timeZone: manifest?.system?.timezone || timeZone }
  }

  /** そのアプリケーションの指示（先頭は必ず【定時業務報告】：アラームの識別に使う）。 */
  function promptFor(app) {
    const own = applicationOptions(app.id)?.aiReportPrompt
    const shared = prompt()
    let text = typeof own === 'string' && own.trim() ? own.trim() : typeof shared === 'string' && shared.trim() ? shared.trim() : ''
    if (!text) {
      const manifest = app.manifest?.() ?? null
      const playbookId = Object.values(manifest?.reports ?? {}).map((r) => r?.playbook).find(Boolean)
      text = String(manifest?.playbooks?.[playbookId]?.instructions ?? '').trim()
    }
    if (!text) text = defaultReportPrompt(app)
    return text.startsWith(AI_REPORT_MARKER) ? text : `${AI_REPORT_MARKER}${text}`
  }

  function rolesFor(app) {
    const own = applicationOptions(app.id)?.aiReportRoles
    if (Array.isArray(own) && own.length) return own.map(String)
    const shared = roles()
    return Array.isArray(shared) && shared.length ? shared.map(String) : [...DEFAULT_REPORT_ROLES]
  }

  const markerAlarms = async (svc, sessionId) => {
    const snap = await svc.state(sessionId)
    return (snap?.alarms ?? []).filter((a) => a?.sessionId === sessionId && typeof a.prompt === 'string'
      && a.prompt.startsWith(AI_REPORT_MARKER) && !CLOSED.has(a.state))
  }

  async function verify(source) {
    if (source?.conversationKind && source.conversationKind !== 'direct') throw fail('direct_only')
    const s = apiSource(source)
    if (!s) throw fail('not_linked')
    const app = appFor(source)
    if (!app) throw fail('no_application')
    const ident = await app.api.get(appPath(app, 'identity'), { query: s })
    if (!ident?.linked || !ident.user?.id) throw fail('not_linked')
    if (!rolesFor(app).includes(ident.user.role)) throw fail('role')
    const rec = sessions.get(sessionKeyOf(app, s))
    if (!rec?.sessionId) throw fail('no_session')
    const svc = proactive()
    if (!svc || typeof svc.action !== 'function' || typeof svc.state !== 'function') throw fail('proactive_unavailable')
    return { s, app, user: ident.user, sessionId: rec.sessionId, svc }
  }

  /** dsh-im の個別チャット配信先を用意する（既にあれば使う）。作れないプラットフォーム・失敗は null（会話にだけ残る）。 */
  async function ensureTarget(source) {
    const draft = deliveryDraft(source)
    const botId = typeof source?.botId === 'string' ? source.botId : ''
    if (!draft || !botId || typeof dshIm?.listTargets !== 'function' || typeof dshIm?.createTarget !== 'function') return null
    const targetId = reportTargetId(source, targetPrefix() || DEFAULT_REPORT_TARGET_PREFIX)
    try {
      const list = await dshIm.listTargets(botId)
      if (!(Array.isArray(list) ? list : []).some((t) => t?.targetId === targetId)) {
        await dshIm.createTarget(botId, { targetId, name: '定時業務報告（AI 社員）', ...draft })
      }
      return { bot_id: botId, target_id: targetId }
    } catch (error) {
      logger.warn('bridge-notify: could not prepare the report delivery target (%s): %s', source.platform, error?.code ?? error?.message ?? error)
      return null
    }
  }

  async function enable(source) {
    const { s, app, user, sessionId, svc } = await verify(source)
    const sched = await scheduleOf(app)
    const times = sched.times
    if (!times.length) throw fail('no_times')
    for (const a of await markerAlarms(svc, sessionId)) await svc.action({ kind: 'cancel', id: a.id }, sessionId)
    const deliver = await ensureTarget(source)
    for (const time of times) {
      const res = await svc.action({
        kind: 'create',
        sessionId,
        args: {
          prompt: promptFor(app), cron: cronOf(time), time_zone: sched.timeZone || timeZone, mode: 'business',
          target_mode: 'resume', respect_quiet_hours: false, ...(deliver ? { deliver_to: [deliver] } : {}),
        },
      }, sessionId)
      if (res && res.ok === false) throw fail('proactive_error', res.error?.message ?? 'create failed')
    }
    const alarms = await markerAlarms(svc, sessionId)
    await owners.put(sessionId, {
      source: { ...s, ...(source.botId ? { botId: String(source.botId) } : {}) }, userId: String(user.id), times, alarmIds: alarms.map((a) => a.id),
      delivery: deliver ? 'im' : 'session', ...(deliver ? { target: { botId: deliver.bot_id, targetId: deliver.target_id } } : {}),
      conversationKind: 'direct', enabledAt: now(), ...(isDefault(app.id) ? {} : { applicationId: app.id }),
    })
    stats.enabled += 1
    return { sessionId, applicationId: app.id, times, timeZone: sched.timeZone || timeZone, alarms: alarms.length, delivery: deliver ? 'im' : 'session' }
  }

  async function disable(source) {
    const { sessionId, svc } = await verify(source)
    const alarms = await markerAlarms(svc, sessionId)
    for (const a of alarms) await svc.action({ kind: 'cancel', id: a.id }, sessionId)
    await owners.delete(sessionId)
    stats.disabled += 1
    return { sessionId, cancelled: alarms.length }
  }

  async function status(source) {
    const { sessionId, svc } = await verify(source)
    const alarms = await markerAlarms(svc, sessionId)
    const times = alarms.map((a) => (typeof a.cron === 'string' ? a.cron.split(' ') : null))
      .filter(Boolean).map(([m, h]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).sort()
    return { sessionId, enabled: alarms.length > 0, times }
  }

  async function fire(source) {
    const { sessionId, svc } = await verify(source)
    const [first] = await markerAlarms(svc, sessionId)
    if (!first) throw fail('not_enabled')
    const res = await svc.action({ kind: 'fire', id: first.id }, sessionId)
    if (res && res.ok === false) throw fail('proactive_error', res.error?.message ?? 'fire failed')
    stats.fired += 1
    return { sessionId, alarmId: first.id }
  }

  /** 本人の記録のアプリケーション（共用ボットは記録した applicationId）。 */
  const ownerApp = (o) => appFor(o.applicationId ? { ...o.source, applicationId: o.applicationId } : o.source)
  const isReportAlarm = (alarm) => alarm?.mode === 'business' && typeof alarm.prompt === 'string' && alarm.prompt.startsWith(AI_REPORT_MARKER)

  /**
   * 起動の直前の確認（N1b）：本人が今も在職・連携済み・同じ 1:1 の会話・許された役割か（業務システムの identity）。
   * → { ok: true } | { ok: false, reason, revoke }（revoke = 定時報告を止める。業務システムに届かないときは false）
   */
  async function checkOwner(sessionId) {
    const o = typeof sessionId === 'string' ? owners.get(sessionId) : null
    if (!o?.source) return { ok: false, reason: 'no_owner', revoke: true }
    const app = ownerApp(o)
    if (!app) return { ok: false, reason: 'no_application', revoke: true }
    const s = apiSource(o.source)
    if (!s) return { ok: false, reason: 'no_owner', revoke: true }
    if (o.conversationKind && o.conversationKind !== 'direct') return { ok: false, reason: 'not_direct', revoke: true }
    // 本人の 1:1 の会話が今もこの会話か（dsh-im/inbound の記録。個別チャットだけを記録している）
    if (sessions.get(sessionKeyOf(app, s))?.sessionId !== sessionId) return { ok: false, reason: 'not_direct', revoke: true }
    let ident
    try {
      ident = await app.api.get(appPath(app, 'identity'), { query: { ...s, ...(o.source.botId ? { botId: String(o.source.botId) } : {}) } })
    } catch (error) {
      return { ok: false, reason: error instanceof BridgeApiError && error.status ? 'identity_' + error.status : 'unavailable', revoke: false }
    }
    if (!ident?.linked || !ident.user?.id) return { ok: false, reason: 'not_linked', revoke: true }
    if (String(ident.user.id) !== String(o.userId)) return { ok: false, reason: 'other_user', revoke: true }
    if (!rolesFor(app).includes(ident.user.role)) return { ok: false, reason: 'role', revoke: true }
    return { ok: true }
  }

  /** その会話の定時報告を止める（アラームを消し、本人の記録を消す）。 */
  async function revoke(sessionId, reason) {
    const svc = proactive()
    let cancelled = 0
    if (svc && typeof svc.state === 'function' && typeof svc.action === 'function') {
      for (const a of await markerAlarms(svc, sessionId).catch(() => [])) {
        try { await svc.action({ kind: 'cancel', id: a.id }, sessionId); cancelled += 1 } catch { /* the next fire skips again */ }
      }
    }
    await owners.delete(sessionId)
    stats.revoked += 1
    logger.info('bridge-notify: AI report of a conversation stopped (%s); %d alarm(s) cancelled', reason, cancelled)
    return cancelled
  }

  /** dsh-proactive の起動の守卫（FORK #15）：定時報告のアラームだけを見る。 */
  async function wakeGuard({ alarm } = {}) {
    if (!isReportAlarm(alarm)) return undefined
    const check = await checkOwner(alarm.sessionId)
    if (check.ok) return undefined
    stats.skipped += 1
    if (check.revoke) await revoke(alarm.sessionId, check.reason)
    else logger.warn('bridge-notify: AI report not started this time (%s)', check.reason)
    return { skip: 'ai report: ' + check.reason }
  }

  /** 固定の文面のリンク（applications.<id>.aiReportLink（相対なら webUrl に前置）→ webUrl）。 */
  function linkFor(app) {
    const own = applicationOptions(app.id) ?? {}
    const base = typeof own.webUrl === 'string' && own.webUrl ? own.webUrl : isDefault(app.id) ? String(webUrl() ?? '') : ''
    return absoluteLink(typeof own.aiReportLink === 'string' && own.aiReportLink ? own.aiReportLink : '/', base)
  }

  /** dsh-proactive の IM 送信の守卫（FORK #14）：定時報告は本人の 1:1 の配信先だけ、本文は aiReportGuard。 */
  async function deliveryGuard({ alarm, target, text } = {}) {
    if (!isReportAlarm(alarm)) {
      if (proactiveDelivery() === 'deny') { stats.refused += 1; return { deny: 'only the AI report may push to IM on this host' } }
      return undefined
    }
    const o = owners.get(alarm.sessionId)
    const app = o?.source ? ownerApp(o) : null
    if (!o?.source || !app) { stats.refused += 1; return { deny: 'the AI report of this conversation has no owner' } }
    const ownTarget = reportTargetId(o.source, targetPrefix() || DEFAULT_REPORT_TARGET_PREFIX)
    if (String(target?.botId ?? '') !== String(o.source.botId ?? '') || String(target?.targetId ?? '') !== ownTarget) {
      stats.refused += 1
      return { deny: "not the owner's own 1:1 report target" }
    }
    const own = applicationOptions(app.id)?.aiReportGuard
    const shared = guardMode()
    const mode = AI_REPORT_GUARDS.includes(own) ? own : AI_REPORT_GUARDS.includes(shared) ? shared : 'screen'
    if (mode === 'off') return { text }
    const url = linkFor(app)
    if (mode === 'screen') {
      const prefixes = [url, applicationOptions(app.id)?.webUrl, isDefault(app.id) ? webUrl() : '']
        .filter((p) => typeof p === 'string' && /^https?:\/\//i.test(p)).map((p) => p.replace(/\/+$/, ''))
      const screen = screenOutboundText(text, { allowedUrlPrefixes: prefixes })
      if (screen.ok) return { text }
      stats.screened += 1
      logger.info('bridge-notify: AI report text replaced by the fixed template (%s)', screen.reasons.join(','))
    }
    return { text: reportTemplate({ appName: app.name, nickname: appNickname(app, undefined), url, now: now() }) }
  }

  /**
   * bridge-tools の委任ゲート用：この会話で定時報告を有効にした本人の IM の発信元（無ければ null）。
   * 既定以外のアプリケーションでは applicationId を含める（gate は自分のアプリケーションと照合する）。
   */
  function ownerOf(sessionId) {
    const o = typeof sessionId === 'string' ? owners.get(sessionId) : null
    if (!o?.source) return null
    return o.applicationId ? { ...o.source, applicationId: o.applicationId } : { ...o.source }
  }

  /** 返事の文：設定 aiReportMessages（文字列の項目だけ上書きできる）→ MSG。 */
  const say = (key) => {
    const own = messages()?.[key]
    return typeof own === 'string' && own ? own : MSG[key]
  }

  function replyFor(error) {
    switch (error?.code) {
      case 'direct_only': return say('direct')
      case 'not_linked': return say('notLinked')
      case 'role': return say('role')
      case 'no_session': return MSG.noSession(keyword())
      case 'no_times': return say('noTimes')
      case 'not_enabled': return MSG.notEnabled(keyword())
      case 'proactive_unavailable': return say('unavailable')
      case 'no_application': return say('noApplication')
      default: return say('failed')
    }
  }

  /** claimReplies の handler。返り値は返信文。 */
  async function handleCommand(text, source) {
    const m = currentCommandRe().exec(normalizeText(text))
    if (!m) return null
    const word = (m[1] ?? '').toLowerCase()
    try {
      if (['オン', 'on', '開始', '有効'].includes(word)) {
        const r = await enable(source)
        return MSG.enabled(r.times, r.delivery, r.timeZone, keyword())
      }
      if (['オフ', 'off', '停止', '無効'].includes(word)) return MSG.disabled((await disable(source)).cancelled, keyword())
      if (['テスト', 'test'].includes(word)) { await fire(source); return say('fired') }
      return MSG.status((await status(source)).times, keyword())
    } catch (error) {
      if (['direct_only', 'not_linked', 'role', 'no_application'].includes(error?.code)) stats.denied += 1
      else if (!(error?.code in { no_session: 1, no_times: 1, not_enabled: 1 })) {
        stats.lastError = String(error?.message ?? error).slice(0, 200)
        logger.warn('bridge-notify: AI report command failed: %s', error instanceof BridgeApiError ? `${error.status} ${error.code}` : stats.lastError)
      }
      return replyFor(error)
    }
  }

  return {
    noteInbound, enable, disable, status, fire, ownerOf, handleCommand, checkOwner, wakeGuard, deliveryGuard,
    matches: (text) => currentCommandRe().test(normalizeText(text)),
    stats: () => ({ ...stats, owners: [...owners.entries()].length }),
  }
}
