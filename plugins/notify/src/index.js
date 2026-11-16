import {
  BridgeApiError, DEFAULT_APPLICATION_ID, DEFAULT_PLATFORM_PRIORITY, MAX_REQUEST_PLATFORMS, V1_PATHS, appPath, applicationOfEvent, backoffDelay, cfg,
  classifyDeliveryError, fallbackRegistry, createBotResolver, frameAiText, frameMessage, loadSchemastery, makeLogger, noticeCard, onDispose, openDomain,
  appNickname, registryGetter, scopedKey, signatureOf, singleApplicationRegistry, watchRegistry, whenServices,
} from '@dsh-bridge/dsh-core'
import { createRequire } from 'node:module'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { quietUntil } from './quiet-hours.js'
import { absoluteLink, normalizeTemplateModule, renderNotification } from './templates.js'
import { AI_REPORT_GUARDS, createAiReporter, DEFAULT_AI_REPORT_COMMAND, DEFAULT_REPORT_ROLES } from './ai-report.js'

/**
 * bridge-notify — 業務イベントの IM 通知（DSH Business Bridge の汎用プラグイン）。
 *
 * 受信者・本人の通知設定・おやすみ時間・文面の材料（件数・日付・時刻）は業務システムが決める（Bridge v1 の
 * GET /bridge/v1/notifications/for-event/{eventId}）。このプラグインは「いつ・どのボットで・何通に分けて・どの文面で送るか」だけを扱う。
 *
 * 複数アプリケーション（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps）：イベントの applicationId（bridge-events が付ける）の
 * アプリケーションの API で受信者を解決し、受信者の「そのアプリケーションでの」連携先へ、そのアプリケーションのボット
 * （プラットフォームごと。他のアプリケーションのボットは使わない）から送り、結果もそのアプリケーションに報告する。
 * 既定のアプリケーションは保存キー `<eventId>:<userId>`・冪等キー `notify:<eventId>:<userId>`、他は保存キーと冪等キーに
 * アプリケーション ID を含める。設定 applications.<id> でアプリケーションごとの platformPriority / bots / webUrl などを上書きできる。
 * dsh-auto-tasks の playbook タスク（applicationId と audience を持つ）の報告は、起動したイベントの受信者（そのアプリケーションが
 * 解決した人）それぞれの連携先へ届ける（ctx.autoTasks.setAudienceDelivery）。applications.<id>.audienceFallback: none なら、受信者が
 * 決まらないときも auto-tasks の固定の配信先に回さない（handled: true・何も送らない・ログ）。audienceText: template なら AI の summary を
 * 送らず固定の文面（状態ごとの件名・業務 Web のリンク）だけを送る（summary は DSH の自動タスクの報告に残る。N1b）。
 *
 * 流れ
 *   bridge-events（通知イベントを転送：設定 notifyTypes の種別と、manifest が events.<type>.notify と宣言した種別）
 *     → GET <notificationRecipients>?platforms=… → 受信者ごとに DSH のストレージサービス（domain bridge_notify / table pending）へ保存
 *     → flush：短時間のまとめ送信（digestTypes の種別は、同じ人・同じ種別を最後のイベントから realtimeSettleSeconds、遅くとも最初のイベントから
 *       realtimeDigestSeconds で 1 通に）、定期のまとめ送信（digestWindows、または manifest の notify.digestMinutes）、即時（それ以外）、
 *       おやすみ時間（本人設定。その時間帯の間は終わるまで延期。manifest の notify.quiet: exempt の種別は延期しない）
 *     → ctx.dshIm.sendCard({ botId, to:{userId: externalId}, card（ボタン無し。noticeCard）, idempotencyKey: notify:<eventId>:<userId> })
 *       （dshIm.send は登録済み配信先にしか送れないため既定にしない。deliveryMode:text では send → unknown-target なら sendCard）
 *       （まとめ送信のキーは含めたイベントのうち最大の eventId。1 度送り始めた束の構成は固定し、再試行でも同じキー）
 *     → POST <notificationDeliveries>（業務システムの通知ログ。同じイベント・同じ人へは 1 回だけ）
 *
 * 失敗：送信は指数バックオフで maxAttempts 回まで再試行（同じ idempotencyKey なので二重送信しない）。届けられない理由が分かるもの
 *   （@dsh-bridge/dsh-core の classifyDeliveryError：WeChat の会話コンテキスト切れ・iLink の拒否・宛先不正・ボット未接続・レート制限／送信上限）は
 *   理由付きで undeliverable / failed として業務システムに報告する。黙って捨てない。
 * 再起動：未送信・延期中の通知も、業務システムへの報告待ちもストレージサービスに残っているので、起動時の flush で再開する。
 * 文面（AI 秘書）：1 行目に【ご報告】【対応のお願い】【至急】と件名、あいさつ、事実、▶ お願いしたいこと（または「ご対応は不要です」）、
 *   リンク、署名（— <アプリ名> AI 秘書）。文面はアプリケーションの文面モジュール（templateModules）→ manifest の templates の順
 *   （src/templates.js）。業務固有の日本語の文面はアプリケーション側に置く。
 */

export const name = 'bridge-notify'
export const inject = ['dshIm', 'storageDomain']
export const SERVICE = 'bridgeNotify'

export const DOMAIN = 'bridge_notify'
const ERROR_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/

/** 保存先の domain 名（設定 stateDomain。既定 bridge_notify / bridge_notify_ai_report / bridge_notify_audience）。 */
export function stateDomains(config) {
  const base = String(cfg(config, 'stateDomain', '') || '').trim() || DOMAIN
  return Object.freeze({ main: base, aiReport: `${base}_ai_report`, audience: `${base}_audience` })
}
const SENT_RETENTION_MS = 7 * 24 * 3600_000
const REPORT_MAX_ATTEMPTS = 50
// dsh-im が対応するプラットフォームすべて（Lark（飛書）を含む）。email は通知専用のプラットフォームで、業務側のメールアドレスを宛先にする仕組みが無いため既定に含めない。
const DEFAULT_PLATFORMS = DEFAULT_PLATFORM_PRIORITY

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).description('IM 通知を送る'),
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名（署名に使う）'),
      notifyTypes: z.array(z.string()).default([]).description('通知するイベント種別（manifest の events.<type>.notify と文面モジュールの types に加えて）'),
      platformPriority: z.array(z.string()).default([...DEFAULT_PLATFORMS])
        .description('通知を届ける配信先の優先順位（業務システムが各職員の連携済み最優先のプラットフォームを 1 つ選ぶ）'),
      bots: z.dict(z.string()).default({}).description('プラットフォーム → botId（既定のアプリケーション）。未指定ならレジストリの bots → listBots() のうちそのアプリケーションのもの'),
      webUrl: z.string().description('業務 Web の URL（業務システムが相対パスのリンクを返した場合に前置）。例: https://app.example.test'),
      applications: z.dict(z.object({
        platformPriority: z.array(z.string()).description('このアプリケーションの配信先の優先順位（既定は上の platformPriority）'),
        bots: z.dict(z.string()).description('プラットフォーム → botId（このアプリケーションのボット）'),
        webUrl: z.string().description('このアプリケーションの業務 Web の URL（相対リンクに前置）'),
        aiReportPrompt: z.string().description('このアプリケーションの AI 社員の定時報告の指示（既定は manifest の報告 playbook）'),
        aiReportRoles: z.array(z.string()).description('「定時報告 オン」を許す役割（既定は上の aiReportRoles）'),
        apiErrorPrefix: z.string().description('このアプリケーションの API に届かなかった送信の errorCode の接頭辞（既定は上の apiErrorPrefix）'),
        audienceSource: z.union(['notification', 'resolve']).description('自動タスクの報告の受信者：notification = そのイベントの通知の受信者（既定）/ resolve = 報告のときに業務システムに解決させる'),
        audienceFallback: z.union(['channels', 'none']).description('自動タスクの報告の受信者が決まらないとき：channels = auto-tasks の固定の配信先に回す（既定）/ none = 送らない（記録だけ）'),
        audienceText: z.union(['summary', 'template']).description('自動タスクの報告の本文：summary = AI の summary を AI 秘書の形にそろえる（既定）/ template = 固定の文面だけ（AI の自由文を IM に出さない）'),
        audienceLink: z.string().description('audienceText: template のリンク（相対なら webUrl に前置。既定 /）'),
        aiReportGuard: z.union(AI_REPORT_GUARDS).description('定時報告の本文の検査（既定は上の aiReportGuard）'),
        aiReportLink: z.string().description('定時報告の固定の文面のリンク（相対なら webUrl に前置。既定 /）'),
      })).default({}).description('アプリケーションごとの上書き（キーはアプリケーション ID）'),
      audienceFallback: z.union(['channels', 'none']).description('全アプリケーションの自動タスクの報告の受信者が決まらないとき（applications.<id>.audienceFallback が優先）：channels = auto-tasks の固定の配信先に回す（未指定時）/ none = 送らない。profile の雛形は none'),
      audienceText: z.union(['summary', 'template']).description('全アプリケーションの自動タスクの報告の本文（applications.<id>.audienceText が優先）：summary = AI の summary（未指定時）/ template = 固定の文面だけ。profile の雛形は template'),
      digestTypes: z.array(z.string()).default([]).description('短時間のまとめ送信で送るイベント種別（同じ人・同じ種別を realtimeSettleSeconds / realtimeDigestSeconds でまとめる）'),
      digestWindows: z.dict(z.natural()).default({}).description('定期のまとめ送信の間隔（種別 → 分。0 = まとめない）。manifest の notify.digestMinutes より優先'),
      digestMinutes: z.natural().default(30).description('定期のまとめ送信の間隔の上限（分。manifest の notify.digestMinutes と digestWindows はこれで頭打ち）。0 = どの種別もまとめない（検証用）'),
      realtimeSettleSeconds: z.natural().default(15)
        .description('短時間のまとめ送信：同じ種別のイベントが途切れてからこの秒数で 1 通にまとめて送る（0 = まとめない）'),
      realtimeDigestSeconds: z.natural().default(120)
        .description('短時間のまとめ送信：イベントが続いても、最初のイベントからこの秒数で送る（まとめる時間の上限）'),
      honorQuietHours: z.boolean().default(true).description('本人設定のおやすみ時間（通知を控える時間帯）を守る（false は検証環境専用）'),
      flushIntervalSeconds: z.natural().min(1).default(30).description('送信待ちを確認する間隔（秒）'),
      maxAttempts: z.natural().min(1).default(8).description('送信の再試行回数の上限'),
      retryBaseSeconds: z.natural().min(1).default(30).description('再試行の初回待ち時間（秒。指数バックオフ）'),
      maxRetrySeconds: z.natural().min(1).default(3600).description('再試行の待ち時間の上限（秒）'),
      undeliverableRetries: z.natural().min(1).default(3).description('WeChat の ret=-2（コンテキストはあるが拒否）を undeliverable とするまでの送信回数'),
      deliveryMode: z.union(['card', 'text']).default('card').description('card = dshIm.sendCard（to.userId 宛て・ボタン無し。既定）、text = dshIm.send（登録済み配信先のみ。unknown-target なら sendCard）'),
      templateModules: z.array(z.object({
        module: z.string().required().description('文面モジュール（パッケージ名・パス。render(input) か templates を export）'),
        application: z.string().description('このモジュールを使うアプリケーション ID（省略時は全アプリケーション）'),
      })).default([]).description('アプリケーションの文面モジュール（manifest の templates より先に使う）'),
      aiReport: z.boolean().default(true)
        .description('AI 社員の定時報告：設定した役割の職員がボットとの個別チャットで「定時報告 オン / オフ / テスト」と送ると、その会話に dsh-proactive の業務アラームを作る'),
      aiReportCommand: z.string().default(DEFAULT_AI_REPORT_COMMAND).description('定時報告のコマンドのキーワード'),
      aiReportPrompt: z.string().description('AI 社員の定時報告の指示（全アプリケーション共通。既定は manifest の報告 playbook → 既定の指示）'),
      aiReportRoles: z.array(z.string()).default([...DEFAULT_REPORT_ROLES]).description('「定時報告 オン」を許す役割'),
      aiReportMessages: z.dict(z.string()).default({}).description('定時報告のコマンドへの返事の上書き（notLinked / role / direct / noTimes / unavailable / failed / noApplication / fired）'),
      aiReportTargetPrefix: z.string().description('定時報告の dsh-im の配信先 ID の接頭辞（既定 bridge-report）。以前の接頭辞で作った配信先を使い続けるときだけ変える'),
      aiReportGuard: z.union(AI_REPORT_GUARDS).default('screen').description('定時報告の本文の検査（dsh-proactive の送信の守卫）：off / screen = 金額・人名・連絡先・外部 URL・長文・健康情報の語なら固定の文面に置き換える（既定）/ template = 常に固定の文面'),
      proactiveDelivery: z.union(['allow', 'deny']).default('allow').description('定時報告以外の dsh-proactive の business アラームの IM 送信（deliver_to）を許すか'),
      apiErrorPrefix: z.string().default('api').description('業務 API に届かなかった送信の errorCode の接頭辞：<prefix>_unreachable / <prefix>_<HTTP status>'),
      stateDomain: z.string().description(`送信待ち・送信記録を保存する DSH のストレージサービスの domain 名（既定 ${DOMAIN}。定時報告と自動タスクの報告は <name>_ai_report / <name>_audience）。別の名前で動いていた導入先を引き継ぐときだけ変える`),
    })
  : undefined

/** レジストリ（bridge-apps）が無いときの 1 件：プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）、Bridge v1 の経路。 */
export function configRegistry(config, { logger } = {}) {
  return fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
}

function memoryTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async (key) => map.delete(key),
    persistent: false,
  }
}

const itemKey = (eventId, userId) => `${eventId}:${userId}`
/**
 * dsh-auto-tasks の既定の報告文（「🙋 **タスク名**」の見出し・先頭の状態の絵文字）を外す（AI 秘書の文面は件名とラベルで示す）。
 */
export function withoutAutoTaskHeader(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  return raw.replace(/^\s*(?:✅|❌|🙋|⏸️?)\s*\*\*[^\n]*\*\*\s*\n+/u, '').replace(/^\s*(?:✅|❌|🙋|⏸️?)\s*/u, '').trim()
}
const errorText = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 自動タスクの報告の固定の文面（audienceText: template）。AI の summary は使わない（受信者は委託した職員と別の人になりうるため）。
 * status：needsDecision → 【対応のお願い】、failed・done → 【ご報告】。title はタスク名（テンプレートの名前。業務データではない）。
 */
export function audienceTemplate({ status, title = '', url = null, now = Date.now(), signature } = {}) {
  if (status === 'needsDecision') {
    return frameMessage({ intent: 'action', title, lead: 'AI が自動処理で、確認していただきたい内容をまとめました。', ask: '業務 Web で内容をご確認のうえ、ご対応をお願いします。', url, now, signature })
  }
  if (status === 'failed') {
    return frameMessage({ intent: 'info', title, lead: 'AI の自動処理を完了できませんでした。', note: '詳しい内容は業務 Web でご確認ください。', url, now, signature })
  }
  return frameMessage({ intent: 'info', title, lead: 'AI の自動処理が完了しました。', url, now, signature })
}
// 届かない理由の分類は共通部品（@dsh-bridge/dsh-core の delivery）。テストと呼び出し元のため再エクスポートする。
export { classifyDeliveryError }

const errorCode = (error, prefix = 'api') => {
  if (error instanceof BridgeApiError) return error.status === 0 ? `${prefix}_unreachable` : `${prefix}_${error.status}`
  const code = String(error?.code ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60)
  return code || 'im_send_failed'
}

/** アプリケーションの manifest の events.<type>（無ければ null）。 */
function manifestEvent(app, type) {
  try {
    return app?.manifest?.()?.events?.[type] ?? null
  } catch {
    return null
  }
}

/** アプリケーションの manifest が通知すると宣言した種別か。 */
export function manifestNotifies(app, type) {
  const ev = manifestEvent(app, type)
  return Boolean(ev && ev.notify && !ev.internal && !ev.deprecated)
}

/** その種別で起動する playbook が manifest にあるか（playbook の宛先として受信者を覚えておく）。 */
function playbookTriggeredBy(app, type) {
  try {
    const playbooks = app?.manifest?.()?.playbooks ?? {}
    return Object.values(playbooks).some((pb) => Array.isArray(pb?.trigger?.events) && pb.trigger.events.includes(type))
  } catch {
    return false
  }
}

/** 文面モジュールの読み込み（パッケージ名・相対 / 絶対パス・file: URL。見つからなければ cwd から解決）。 */
export async function loadTemplateModule(spec, { cwd = process.cwd() } = {}) {
  const value = String(spec ?? '').trim()
  if (!value) throw new Error('templateModules: module is required')
  if (value.startsWith('file:')) return import(value)
  if (isAbsolute(value) || value.startsWith('.')) return import(pathToFileURL(resolvePath(cwd, value)).href)
  try {
    return await import(value)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    const require = createRequire(pathToFileURL(resolvePath(cwd, 'noop.js')).href)
    return import(pathToFileURL(require.resolve(value)).href)
  }
}

/**
 * ctx に依存しない本体。
 * @param deps.registry   アプリケーションレジストリ（@dsh-bridge/dsh-core。関数なら呼び出しごとに評価）
 * @param deps.api        レジストリの代わりに API クライアント 1 つ（1 アプリケーション・Bridge v1 の経路。単体テスト）
 * @param deps.tables     { pending, sent, reports, audiences? }（storage-domain の KvTable 互換：get / entries / put / delete）
 * @param deps.applicationOptions  (applicationId) => { platformPriority?, bots?, webUrl? }（アプリケーションごとの上書き）
 * @param deps.templateModules     () => [{ application: string|null, module }]（normalizeTemplateModule の結果）
 * @param deps.notifyTypes  () => 通知する種別（manifest と文面モジュールの types に加えて）
 * @param deps.digestTypes  () => 短時間のまとめ送信の種別
 * @param deps.digestWindows () => { [type]: 分 }（定期のまとめ送信。0 = まとめない）
 */
export function createNotifier({
  api,
  registry = null,
  dshIm,
  tables,
  logger = console,
  applicationName = 'business',
  platformPriority = () => [...DEFAULT_PLATFORMS],
  bots = () => ({}),
  webUrl = () => '',
  applicationOptions = () => ({}),
  templateModules = () => [],
  notifyTypes = () => [],
  digestTypes = () => [],
  digestWindows = () => ({}),
  digestMs = () => 30 * 60_000,
  realtimeSettleMs = () => 15_000,
  realtimeDigestMs = () => 120_000,
  wake = null,
  maxAttempts = () => 8,
  retryBaseMs = () => 30_000,
  maxRetryMs = () => 3_600_000,
  deliveryMode = () => 'card',
  undeliverableRetries = () => 3,
  enabled = () => true,
  honorQuietHours = () => true,
  apiErrorPrefix = () => 'api',
  now = Date.now,
  random = Math.random,
}) {
  const { pending, sent, reports } = tables
  const audiences = tables.audiences ?? null
  const single = api ? singleApplicationRegistry(api, { id: DEFAULT_APPLICATION_ID, name: applicationName, label: 'business API', namespace: 'app', paths: V1_PATHS }) : null
  const getRegistry = single ? () => single : registryGetter(registry)
  const defaultId = () => getRegistry()?.default?.()?.id ?? DEFAULT_APPLICATION_ID
  const isDefault = (applicationId) => !applicationId || applicationId === defaultId()
  const appOf = (applicationId) => (isDefault(applicationId) ? getRegistry()?.default?.() ?? null : getRegistry()?.get?.(applicationId) ?? null)
  const bot = createBotResolver({ dshIm, registry: getRegistry, logger, label: 'bridge-notify' })
  const stats = {
    events: 0, resolved: 0, queued: 0, duplicates: 0, messages: 0, deduped: 0, cardFallbacks: 0, deferred: 0, retries: 0, failed: 0, undeliverable: 0, reported: 0,
    audienceDeliveries: 0, audienceSuppressed: 0,
    lastError: null, lastErrorAt: null, lastUndeliverable: null,
  }
  let flushing = null
  let again = false

  function noteError(error) {
    stats.lastError = errorText(error)
    stats.lastErrorAt = new Date(now()).toISOString()
  }

  /** そのアプリケーションに効く文面モジュール（アプリケーション専用 → 全アプリケーション共通の順）。 */
  function modulesFor(applicationId) {
    const list = templateModules() ?? []
    return [...list.filter((m) => m.application === applicationId), ...list.filter((m) => !m.application)].map((m) => m.module)
  }

  /** この種別を通知するか：設定 notifyTypes / manifest の events.<type>.notify / 文面モジュールの types。 */
  function notifies(app, type) {
    if ((notifyTypes() ?? []).includes(type)) return true
    if (manifestNotifies(app, type)) return true
    return modulesFor(app?.id).some((m) => m.types.includes(type))
  }

  /**
   * まとめ送信にするかの決め方（受信時に決めて pending に保存する）：digestWindows（運用者の設定）→ digestTypes（短時間のまとめ送信）→ manifest の
   * notify.digestMinutes → 即時。@returns { digest: boolean, windowMs: number|null }（windowMs null = 短時間のまとめ送信）
   */
  function digestPlan(app, type) {
    const cap = Number(digestMs())
    if (!(cap > 0)) return { digest: false, windowMs: null } // digestMinutes 0：検証用にまとめない
    const fixed = (minutes) => ({ digest: true, windowMs: Math.min(minutes * 60_000, cap) })
    const windows = digestWindows() ?? {}
    if (Object.hasOwn(windows, type)) {
      const minutes = Number(windows[type])
      return minutes > 0 ? fixed(minutes) : { digest: false, windowMs: null }
    }
    if ((digestTypes() ?? []).includes(type)) return { digest: true, windowMs: null }
    const minutes = Number(manifestEvent(app, type)?.notify?.digestMinutes ?? 0)
    return minutes > 0 ? fixed(minutes) : { digest: false, windowMs: null }
  }

  /** アプリケーションごとの設定（applications.<id> → 直下の設定）。 */
  function optionsFor(applicationId) {
    const o = applicationOptions(applicationId) ?? {}
    const shared = {
      apiErrorPrefix: (typeof o.apiErrorPrefix === 'string' && ERROR_PREFIX_RE.test(o.apiErrorPrefix) && o.apiErrorPrefix) || apiErrorPrefix() || 'api',
      audienceSource: o.audienceSource === 'resolve' ? 'resolve' : 'notification',
      audienceFallback: o.audienceFallback === 'none' ? 'none' : 'channels',
      audienceText: o.audienceText === 'template' ? 'template' : 'summary',
      audienceLink: typeof o.audienceLink === 'string' && o.audienceLink ? o.audienceLink : '/',
    }
    if (isDefault(applicationId)) {
      return {
        platformPriority: Array.isArray(o.platformPriority) && o.platformPriority.length ? o.platformPriority.map(String) : platformPriority(),
        bots: o.bots && typeof o.bots === 'object' ? o.bots : bots() ?? {},
        webUrl: typeof o.webUrl === 'string' ? o.webUrl : webUrl(),
        ...shared,
      }
    }
    const list = Array.isArray(o.platformPriority) && o.platformPriority.length ? o.platformPriority.map(String) : platformPriority()
    return { platformPriority: list, bots: o.bots && typeof o.bots === 'object' ? o.bots : {}, webUrl: typeof o.webUrl === 'string' ? o.webUrl : '', ...shared }
  }

  /** 送信ボット：連携の botId（そのアプリケーションのボットなら）→ 設定 → レジストリ → listBots（そのアプリケーションのもの）。 */
  async function botFor(app, identity) {
    return bot.resolve(app, identity?.platform, { preferred: identity?.botId, configured: optionsFor(app.id).bots })
  }

  /**
   * 受信者の解決に渡すプラットフォーム（優先順）。Bridge v1 は最大 10 件：超えるときはボットのあるプラットフォームを優先して 10 件にする。
   */
  async function requestPlatforms(app) {
    const list = [...new Set(optionsFor(app.id).platformPriority)]
    if (list.length <= MAX_REQUEST_PLATFORMS) return list
    const withBot = []
    for (const platform of list) if (await botFor(app, { platform })) withBot.push(platform)
    const keep = new Set([...withBot, ...list.filter((p) => !withBot.includes(p))].slice(0, MAX_REQUEST_PLATFORMS))
    return list.filter((p) => keep.has(p))
  }

  function identityOf(identity) {
    return {
      platform: String(identity.platform),
      externalId: String(identity.externalId),
      ...(identity.teamId ? { teamId: String(identity.teamId) } : {}),
      ...(identity.botId ? { botId: String(identity.botId) } : {}),
    }
  }

  // ---------------------------------------------------------------- intake
  /** bridge-events から呼ばれる。業務システムに届かない等は throw（bridge-events が再試行）。 */
  async function handleEvent(event) {
    const type = String(event?.type ?? '')
    if (event?.id === undefined || event?.id === null) return { queued: 0 }
    const app = applicationOfEvent(getRegistry, event)
    const appId = app?.id ?? (event?.applicationId ? String(event.applicationId) : defaultId())
    const scoped = !isDefault(appId)
    if (!app) {
      if (!(notifyTypes() ?? []).includes(type)) return { queued: 0 }
      stats.events += 1
      logger.warn('bridge-notify: event %s (%s) belongs to unknown application %s; skipped', event.id, type, appId)
      return { queued: 0, skipped: 'unknown_application' }
    }
    if (!notifies(app, type)) return { queued: 0 }
    stats.events += 1
    if (!enabled()) return { queued: 0, disabled: true }
    let res
    try {
      res = await app.api.get(appPath(app, 'notificationRecipients', { eventId: event.id }), {
        query: { platforms: (await requestPlatforms(app)).join(',') || undefined },
      })
    } catch (error) {
      if (error instanceof BridgeApiError && error.status === 404) {
        logger.warn('bridge-notify: event %s not found in %s; skipped', event.id, app.label)
        return { queued: 0 }
      }
      noteError(error)
      throw error
    }
    stats.resolved += 1
    const eventId = Number(res.eventId ?? event.id)
    const recipients = Array.isArray(res.recipients) ? res.recipients : []
    const resolvedType = String(res.type ?? type)
    const plan = digestPlan(app, resolvedType)
    const quietExempt = manifestEvent(app, resolvedType)?.notify?.quiet === 'exempt'
    let queued = 0
    for (const r of recipients) {
      if (!r?.userId || !r?.identity?.externalId || !r?.identity?.platform) continue
      const key = scopedKey(app.id, defaultId(), itemKey(eventId, r.userId))
      if (pending.get(key) || sent.get(key)) { stats.duplicates += 1; continue }
      await pending.put(key, {
        eventId,
        userId: String(r.userId),
        ...(scoped ? { applicationId: app.id } : {}),
        type: resolvedType,
        template: String(r.template ?? resolvedType),
        params: r.params && typeof r.params === 'object' ? r.params : {},
        link: typeof r.link === 'string' ? r.link : null,
        identity: identityOf(r.identity),
        quietHours: quietExempt ? null : r.quietHours ?? null,
        digest: plan.digest,
        digestWindowMs: plan.windowMs,
        receivedAt: now(),
        attempts: 0,
        nextAttemptAt: null,
        batchKey: null,
      })
      queued += 1
    }
    // dsh-auto-tasks の playbook（この種別で起動するもの）の報告の宛先として、このイベントの受信者を覚えておく
    if (audiences && optionsFor(app.id).audienceSource !== 'resolve' && playbookTriggeredBy(app, type)) {
      const akey = `${app.id}|${eventId}`
      const prev = audiences.get(akey)
      const merged = new Map((prev?.recipients ?? []).map((x) => [x.userId, x]))
      for (const r of recipients) {
        if (r?.userId && r?.identity?.externalId && r?.identity?.platform) merged.set(String(r.userId), { userId: String(r.userId), identity: identityOf(r.identity) })
      }
      await audiences.put(akey, { applicationId: app.id, eventId, type, recipients: [...merged.values()], at: now() })
    }
    stats.queued += queued
    if (queued) await flush()
    return { queued }
  }

  // ---------------------------------------------------------------- batching
  /** 送信単位（束）に分ける。一度送り始めた束（batchKey あり）は構成を変えない。 */
  function batches() {
    const groups = new Map()
    for (const [key, item] of pending.entries()) {
      const app = item.applicationId ?? ''
      const groupKey = item.batchKey ? `b|${item.batchKey}` : item.digest ? `d|${app}|${item.userId}|${item.type}` : `i|${key}`
      if (!groups.has(groupKey)) groups.set(groupKey, [])
      groups.get(groupKey).push({ key, item })
    }
    return [...groups.values()].map((entries) => entries.sort((x, y) => x.item.eventId - y.item.eventId))
  }

  /** 束のおやすみ時間の終わり（今その時間帯でなければ null）。束の設定は最新のイベント（本人の今の設定）に従う。 */
  function quietEnd(entries, t) {
    return honorQuietHours() ? quietUntil(t, entries[entries.length - 1].item.quietHours) : null
  }

  /**
   * おやすみ時間で延期しただけの再試行時刻か。本人が解除したあとのイベントが同じ束に入ったら、延期は待たない
   * （解除前に延期した通知が解除後の通知を翌朝まで止めない）。送信失敗の再試行（nextAttemptAt が延期と違う）はそのまま守る。
   */
  const deferralOnly = (item) => Boolean(item.deferredUntil) && item.nextAttemptAt === item.deferredUntil

  function dueAt(entries, t = now()) {
    const first = Math.min(...entries.map((e) => e.item.receivedAt))
    const head = entries[0].item
    const digest = head.digest && !head.batchKey
    let base = first
    if (digest && typeof head.digestWindowMs === 'number' && head.digestWindowMs > 0) {
      // 定期のまとめ送信：最初のイベントから windowMs
      base = first + head.digestWindowMs
    } else if (digest && realtimeSettleMs() > 0) {
      // 短時間のまとめ送信：連続が途切れて settle 経ったら送る（遅くとも最初のイベントから max）
      const last = Math.max(...entries.map((e) => e.item.receivedAt))
      base = Math.min(last + realtimeSettleMs(), first + Math.max(0, realtimeDigestMs()))
    }
    const quiet = quietEnd(entries, t)
    const retry = Math.max(0, ...entries.map((e) => (!quiet && deferralOnly(e.item) ? 0 : e.item.nextAttemptAt ?? 0)))
    return Math.max(base, retry)
  }

  async function updateAll(entries, patch) {
    for (const e of entries) {
      e.item = { ...e.item, ...patch }
      await pending.put(e.key, e.item)
    }
  }

  function messageFor(app, latest, count, items = [latest]) {
    const { webUrl: base } = optionsFor(app.id)
    // まとめ送信では束のすべてのイベントの params も渡す（件数・月の集計に使う）。文面は最新のイベントの template
    return renderNotification({
      modules: modulesFor(app.id),
      manifest: app.manifest?.() ?? null,
      template: latest.template, type: latest.type, count, params: latest.params, items: items.map((i) => i.params ?? {}),
      link: latest.link, webUrl: base, appName: app.name, nickname: appNickname(app, undefined), now: now(),
    })
  }

  /** dsh-im への送信（card 既定、text モードは登録済み配信先 → unknown-target なら card）。 */
  async function sendTo({ botId, identity, message, idempotencyKey, applicationId }) {
    // 既定以外のアプリケーション・共用ボットの送信には applicationId を添える（dsh-im の窓口内切り替えが【アプリ名】と
    // 返信先のアプリケーションを記録するため。上流の dsh-im は未知の項目を無視する）
    const extra = applicationId ? { applicationId } : {}
    const viaCard = () => dshIm.sendCard({
      botId,
      to: { userId: identity.externalId },
      card: noticeCard(message),
      idempotencyKey,
      ...extra,
    })
    const hasCard = typeof dshIm?.sendCard === 'function'
    const hasSend = typeof dshIm?.send === 'function'
    if (deliveryMode() !== 'text' && hasCard) return viaCard()
    if (hasSend) {
      try {
        return await dshIm.send(botId, identity.externalId, message.body, { idempotencyKey, ...extra })
      } catch (error) {
        if (error?.code !== 'unknown-target' || !hasCard) throw error
        stats.cardFallbacks += 1
        return viaCard()
      }
    }
    if (hasCard) return viaCard()
    throw Object.assign(new Error('ctx.dshIm.sendCard / send is not available'), { code: 'no_send' })
  }

  async function deliver(entries) {
    const latest = entries[entries.length - 1].item
    const t = now()
    if (dueAt(entries, t) > t) return 'waiting'
    const appId = latest.applicationId ?? defaultId()
    const scoped = !isDefault(latest.applicationId)
    const app = appOf(latest.applicationId)
    if (!app) {
      // レジストリから消えたアプリケーション：送る先も報告する先も無い
      logger.warn('bridge-notify: application %s is no longer registered; %d queued notification(s) dropped', appId, entries.length)
      for (const e of entries) await pending.delete(e.key)
      return 'failed'
    }
    // おやすみ時間：その時間帯の間は終わるまで延期（延期したことはストレージサービスに残るので再起動しても同じ）
    const until = quietEnd(entries, t)
    if (until) {
      if (entries.some((e) => (e.item.nextAttemptAt ?? 0) < until)) {
        await updateAll(entries, { nextAttemptAt: until, deferredUntil: until })
        stats.deferred += 1
      }
      return 'deferred'
    }
    const batchKey = latest.batchKey ?? (scoped ? `notify:${app.id}:${latest.eventId}:${latest.userId}` : `notify:${latest.eventId}:${latest.userId}`)
    if (!latest.batchKey || entries.some((e) => e.item.batchKey !== batchKey)) await updateAll(entries, { batchKey })
    const message = messageFor(app, latest, entries.length, entries.map((e) => e.item))
    const identity = latest.identity
    const eventIds = entries.map((e) => e.item.eventId)
    const scope = scoped ? { applicationId: app.id } : {}
    try {
      const chosen = await botFor(app, identity)
      if (!chosen?.botId) throw Object.assign(new Error(`no bot for platform ${identity.platform}`), { code: 'no_bot' })
      const result = await sendTo({
        botId: chosen.botId, identity, message, idempotencyKey: batchKey, applicationId: scoped || chosen.shared ? app.id : undefined,
      })
      if (result?.deduped) stats.deduped += 1
      stats.messages += 1
      const sentAt = now()
      for (const e of entries) {
        await sent.put(e.key, { eventId: e.item.eventId, userId: e.item.userId, sentAt, batchKey })
        await pending.delete(e.key)
      }
      await reports.put(batchKey, {
        userId: latest.userId, eventIds, status: 'sent', channel: identity.platform, ...scope,
        messageRef: result?.messageRef ? String(result.messageRef).slice(0, 300) : undefined, attempts: 0, nextAttemptAt: 0,
      })
      return 'sent'
    } catch (error) {
      noteError(error)
      const attempts = Math.max(...entries.map((e) => e.item.attempts ?? 0)) + 1
      const known = classifyDeliveryError(error, identity.platform)
      const giveUpNow = known?.undeliverable === 'now'
        || (known?.undeliverable === 'after-retries' && attempts >= Math.min(maxAttempts(), Math.max(1, undeliverableRetries())))
      if (giveUpNow) {
        logger.warn('bridge-notify: %s is undeliverable on %s (%s) after %d attempt(s)', batchKey, identity.platform, known.reason, attempts)
        for (const e of entries) await pending.delete(e.key)
        await reports.put(batchKey, {
          userId: latest.userId, eventIds, status: 'undeliverable', channel: identity.platform, errorCode: known.reason, ...scope, attempts: 0, nextAttemptAt: 0,
        })
        stats.undeliverable += 1
        stats.lastUndeliverable = { platform: identity.platform, reason: known.reason, at: new Date(now()).toISOString() }
        return 'undeliverable'
      }
      if (attempts >= maxAttempts()) {
        logger.error('bridge-notify: giving up %s after %d attempts: %s', batchKey, attempts, errorText(error))
        for (const e of entries) await pending.delete(e.key)
        await reports.put(batchKey, {
          userId: latest.userId, eventIds, status: 'failed', channel: identity.platform, errorCode: known?.reason ?? errorCode(error, optionsFor(app.id).apiErrorPrefix), ...scope, attempts: 0, nextAttemptAt: 0,
        })
        stats.failed += 1
        return 'failed'
      }
      stats.retries += 1
      logger.warn('bridge-notify: send %s failed (%d/%d): %s', batchKey, attempts, maxAttempts(), errorText(error))
      // レート制限・送信上限（retryLater）は Retry-After より前には送り直さない
      const delay = Math.max(backoffDelay(attempts, retryBaseMs(), maxRetryMs(), random), known?.retryLater ? Math.min(known.retryAfterMs ?? 0, maxRetryMs()) : 0)
      await updateAll(entries, { attempts, nextAttemptAt: now() + delay, lastError: known?.reason ?? errorCode(error, optionsFor(app.id).apiErrorPrefix) })
      return 'retry'
    }
  }

  /** 業務システムへの送信結果の報告（通知ログ）。そのアプリケーションの API へ。失敗は後で再試行。 */
  async function report() {
    for (const [key, r] of [...reports.entries()]) {
      if ((r.nextAttemptAt ?? 0) > now()) continue
      const app = appOf(r.applicationId)
      if (!app) {
        logger.error('bridge-notify: dropping delivery report %s: application %s is no longer registered', key, r.applicationId)
        await reports.delete(key)
        continue
      }
      try {
        await app.api.post(appPath(app, 'notificationDeliveries'), {
          userId: r.userId, eventIds: r.eventIds, status: r.status,
          ...(r.channel ? { channel: r.channel } : {}),
          ...(r.messageRef ? { messageRef: r.messageRef } : {}),
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        })
        await reports.delete(key)
        stats.reported += 1
      } catch (error) {
        noteError(error)
        const attempts = (r.attempts ?? 0) + 1
        // 4xx（入力不正・イベントなし）は再送しても変わらない
        if (attempts >= REPORT_MAX_ATTEMPTS || (error instanceof BridgeApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
          logger.error('bridge-notify: dropping delivery report %s: %s', key, errorText(error))
          await reports.delete(key)
          continue
        }
        await reports.put(key, { ...r, attempts, nextAttemptAt: now() + backoffDelay(attempts, retryBaseMs(), maxRetryMs(), random) })
      }
    }
  }

  async function prune() {
    const cutoff = now() - SENT_RETENTION_MS
    for (const [key, s] of [...sent.entries()]) {
      if ((s.sentAt ?? 0) < cutoff) await sent.delete(key)
    }
    if (audiences) {
      for (const [key, a] of [...audiences.entries()]) {
        if ((a.at ?? 0) < cutoff) await audiences.delete(key)
      }
    }
  }

  /** 次に期限の来る束の時刻に flush を予約する（wake が無ければ flushIntervalSeconds の周期だけ）。おやすみ時間で延期中の束は周期に任せる。 */
  function scheduleWake() {
    if (typeof wake !== 'function') return
    let next = Infinity
    const t = now()
    for (const entries of batches()) {
      if (quietEnd(entries, t) && entries.some((e) => e.item.deferredUntil && e.item.deferredUntil > t)) continue
      next = Math.min(next, dueAt(entries, t))
    }
    if (Number.isFinite(next)) wake(Math.max(0, next - t))
  }

  /**
   * 期限の来た束を送り、報告する。並行呼び出しは 1 本にまとめ、実行中に呼ばれたらもう 1 周する
   * （実行中に積まれた即時通知を次の周期まで待たせない）。
   */
  function flush() {
    if (flushing) {
      again = true
      return flushing
    }
    flushing = (async () => {
      const out = { sent: 0, waiting: 0, deferred: 0, retry: 0, failed: 0, undeliverable: 0 }
      try {
        do {
          again = false
          if (!enabled()) break
          for (const entries of batches()) out[await deliver(entries)] += 1
          await report()
        } while (again)
        await prune()
      } catch (error) {
        noteError(error)
        logger.error('bridge-notify: flush failed: %s', errorText(error))
      } finally {
        flushing = null
      }
      scheduleWake()
      return out
    })()
    return flushing
  }

  /**
   * dsh-auto-tasks の playbook タスク（applicationId と audience を持つ）の報告を、起動したイベントの受信者（そのアプリケーションが
   * 解決した人）それぞれの連携先へ、そのアプリケーションのボットから届ける（ctx.autoTasks.setAudienceDelivery の実装）。
   * 受信者は bridge-notify がそのイベントの通知のときに解決した人（無ければそのアプリケーションの通知 API で解決する）。
   * 受信者が分からない（イベント起動でない・通知しない種別）なら handled: false（auto-tasks は登録済みの配信先に送る）。
   * @param input { task: {id, name, applicationId, audience}, run: {runId, eventType, eventId, dedupeKey} | null, report, text, idempotencyKey }
   */
  async function deliverAudience({ task, run, report: taskReport, text, idempotencyKey } = {}) {
    const applicationId = task?.applicationId ? String(task.applicationId) : null
    const app = applicationId ? getRegistry()?.get?.(applicationId) ?? null : null
    if (!app) return { handled: false, reason: 'unknown_application' }
    // 受信者が決まらない：既定は auto-tasks の固定の配信先へ（handled: false）。audienceFallback: none は何も送らない（handled: true）
    const unresolved = (reason, extra = {}) => {
      if (optionsFor(app.id).audienceFallback !== 'none') return { handled: false, reason, ...extra }
      stats.audienceSuppressed += 1
      logger.info('bridge-notify: report of automatic task %s not delivered (%s; audienceFallback none)', task?.id ?? '?', reason)
      return { handled: true, results: [], reason, suppressed: true }
    }
    if (!run?.eventId || typeof text !== 'string' || !text) return unresolved('no_event')
    // audienceSource: resolve のアプリケーションは記録を使わず、報告のときに業務システムに解決させる
    let recipients = optionsFor(app.id).audienceSource === 'resolve' ? null : audiences?.get(`${app.id}|${Number(run.eventId)}`)?.recipients ?? null
    if (!recipients) {
      const type = String(run.eventType ?? '')
      if (!notifies(app, type)) return unresolved('not_notified')
      try {
        const res = await app.api.get(appPath(app, 'notificationRecipients', { eventId: run.eventId }), {
          query: { platforms: (await requestPlatforms(app)).join(',') || undefined },
        })
        recipients = (Array.isArray(res.recipients) ? res.recipients : [])
          .filter((r) => r?.userId && r?.identity?.externalId && r?.identity?.platform)
          .map((r) => ({ userId: String(r.userId), identity: identityOf(r.identity) }))
      } catch (error) {
        noteError(error)
        return unresolved('resolve_failed', { error: errorText(error) })
      }
    }
    if (!recipients.length) return unresolved('no_recipients')
    // AI が書いた summary を AI 秘書の形にそろえる（先頭の【ご報告】/【対応のお願い】を件名に、あいさつ・署名を足す）。
    // dsh-auto-tasks の既定の文面（絵文字と **タスク名**）ではなく summary を使う。summary が無ければ渡された文面
    const summary = typeof taskReport?.summary === 'string' && taskReport.summary.trim() ? taskReport.summary : withoutAutoTaskHeader(text)
    // タスク名の先頭の【アプリ名】は外す（共用ボットでは dsh-im の窓口が【アプリ名】を付ける）
    const fallbackTitle = String(task?.name ?? app.name).replace(/^【[^】]*】/, '')
    const opts = optionsFor(app.id)
    const signature = signatureOf(app.name, appNickname(app, undefined))
    const framed = opts.audienceText === 'template'
      ? audienceTemplate({ status: taskReport?.status, title: fallbackTitle, url: absoluteLink(opts.audienceLink, opts.webUrl), now: now(), signature })
      : frameAiText(summary, { status: taskReport?.status, fallbackTitle, now: now(), signature })
    const results = []
    for (const r of recipients) {
      try {
        const chosen = await botFor(app, r.identity)
        if (!chosen?.botId) throw Object.assign(new Error(`no bot for platform ${r.identity.platform}`), { code: 'no_bot' })
        const res = await sendTo({
          botId: chosen.botId, identity: r.identity, message: framed, idempotencyKey: `${idempotencyKey ?? `auto-tasks:${task?.id}`}:u:${r.userId}`, applicationId: app.id,
        })
        stats.audienceDeliveries += 1
        results.push({ channel: 'im', botId: chosen.botId, userId: r.userId, ok: true, ...(res?.deduped ? { deduped: true } : {}) })
      } catch (error) {
        noteError(error)
        results.push({ channel: 'im', userId: r.userId, ok: false, error: String(error?.code ?? errorText(error)).slice(0, 200) })
      }
    }
    return { handled: true, results }
  }

  function status() {
    let queued = 0
    let deferred = 0
    let retrying = 0
    const t = now()
    for (const [, item] of pending.entries()) {
      queued += 1
      if (item.deferredUntil && item.deferredUntil > t) deferred += 1
      else if (item.attempts > 0) retrying += 1
    }
    let reportsPending = 0
    for (const _ of reports.entries()) reportsPending += 1 // eslint-disable-line no-unused-vars
    return {
      ...stats, pending: queued, deferredNow: deferred, retrying, reportsPending,
      persistent: pending.persistent !== false, platformPriority: platformPriority(),
    }
  }

  return { handleEvent, flush, status, deliverAudience, notifies: (applicationId, type) => notifies(appOf(applicationId), type) }
}

/** Keys of the plugin config that apply to every application unless applications.<id> sets them. */
const SHARED_APPLICATION_KEYS = Object.freeze(['audienceFallback', 'audienceText'])

/**
 * (applicationId) => the options of one application: applications.<id>, over the plugin-wide audienceFallback / audienceText
 * (so a profile closes the automatic-task report for every application with two lines, and one application can still opt out).
 */
export function applicationOptionsFrom(config) {
  return (id) => {
    const all = cfg(config, 'applications', {}) ?? {}
    const own = all && typeof all === 'object' ? all[id] ?? {} : {}
    const shared = {}
    for (const key of SHARED_APPLICATION_KEYS) {
      const value = cfg(config, key, undefined)
      if (value !== undefined) shared[key] = value
    }
    return { ...shared, ...own }
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const applicationOptions = applicationOptionsFrom(config)
  const dshIm = ctx.dshIm
  if (typeof dshIm?.send !== 'function' && typeof dshIm?.sendCard !== 'function') {
    logger.warn('bridge-notify: ctx.dshIm.sendCard is missing (the bridge fork of dsh-im is required)')
  }
  let domain = null
  let reportDomain = null
  let audienceDomain = null
  let timer = null
  let wakeTimer = null
  let flushRef = null
  let reporter = null
  let proactiveService = null
  const modules = [] // { application: string|null, module }
  const disposers = []
  const domains = stateDomains(config)
  const list = (key) => {
    const value = cfg(config, key, [])
    return Array.isArray(value) ? value.map(String) : []
  }
  whenServices(ctx, ['dshProactive'], (sub) => {
    proactiveService = sub.dshProactive
    // 定時報告の守卫（dsh-proactive FORK #14・#15。N1b）：起動の直前に本人を確かめ、IM へは本人の 1:1 の配信先にだけ、検査した本文を送る
    const offs = []
    if (typeof sub.dshProactive?.setWakeGuard === 'function') {
      offs.push(sub.dshProactive.setWakeGuard(async (input) => { await ready; return reporter?.wakeGuard(input) }))
    }
    if (typeof sub.dshProactive?.setDeliveryGuard === 'function') {
      offs.push(sub.dshProactive.setDeliveryGuard(async (input) => {
        await ready
        return reporter ? reporter.deliveryGuard(input) : { deny: 'bridge-notify is not ready' }
      }))
    } else {
      logger.warn('bridge-notify: ctx.dshProactive.setDeliveryGuard is missing (an older dsh-proactive); the AI report text is not screened')
    }
    return () => {
      proactiveService = null
      for (const off of offs.splice(0)) { try { off?.() } catch { /* noop */ } }
    }
  })
  const aiReportOn = () => cfg(config, 'aiReport', true) !== false
  // AI 社員の定時報告：個別チャットの発信元 → sessionId（信頼できる dsh-im/inbound イベントだけ）と「定時報告 …」のコマンド
  const inboundQueue = []
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('dsh-im/inbound', (e) => {
        if (!aiReportOn()) return
        if (reporter) reporter.noteInbound(e).catch((error) => logger.warn('bridge-notify: could not remember the AI report session: %s', error?.message ?? error))
        else if (inboundQueue.length < 100) inboundQueue.push(e)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch { /* event not declared in this host */ }
  }
  if (typeof dshIm?.claimReplies === 'function') {
    const claim = dshIm.claimReplies(
      (text) => aiReportOn() && Boolean(reporter?.matches(text)),
      async ({ text, source, reply }) => {
        const answer = reporter ? await reporter.handleCommand(text, source) : null
        if (answer) await reply(answer)
      })
    disposers.push(() => (typeof claim === 'function' ? claim() : claim?.dispose?.()))
  }
  const ready = (async () => {
    for (const entry of cfg(config, 'templateModules', []) ?? []) {
      try {
        modules.push({ application: entry?.application || null, module: normalizeTemplateModule(await loadTemplateModule(entry?.module)) })
      } catch (error) {
        logger.warn('bridge-notify: template module %s could not be loaded: %s', entry?.module ?? '?', error?.message ?? error)
      }
    }
    let tables = { pending: memoryTable(), sent: memoryTable(), reports: memoryTable() }
    try {
      domain = await openDomain(ctx, { name: domains.main, tables: ['pending', 'sent', 'reports'] })
      tables = { pending: domain.table('pending'), sent: domain.table('sent'), reports: domain.table('reports') }
    } catch (error) {
      logger.error('bridge-notify: DSH storage unavailable; queued notifications are kept in memory only: %s', error?.message ?? error)
    }
    try {
      audienceDomain = await openDomain(ctx, { name: domains.audience, tables: ['events'] })
      tables.audiences = audienceDomain.table('events')
    } catch {
      tables.audiences = memoryTable()
    }
    const core = createNotifier({
      registry,
      dshIm,
      tables,
      logger,
      platformPriority: () => {
        const priority = cfg(config, 'platformPriority', DEFAULT_PLATFORMS)
        return Array.isArray(priority) && priority.length ? priority.map(String) : [...DEFAULT_PLATFORMS]
      },
      bots: () => cfg(config, 'bots', {}),
      webUrl: () => cfg(config, 'webUrl', ''),
      applicationOptions,
      templateModules: () => modules,
      notifyTypes: () => list('notifyTypes'),
      digestTypes: () => list('digestTypes'),
      digestWindows: () => cfg(config, 'digestWindows', {}) ?? {},
      digestMs: () => Number(cfg(config, 'digestMinutes', 30)) * 60_000,
      realtimeSettleMs: () => Number(cfg(config, 'realtimeSettleSeconds', 15)) * 1000,
      realtimeDigestMs: () => Number(cfg(config, 'realtimeDigestSeconds', 120)) * 1000,
      // 期限の来る時刻に flush する（短時間のまとめ送信が flushIntervalSeconds の周期を待たない）
      wake: (ms) => {
        if (wakeTimer) clearTimeout(wakeTimer)
        wakeTimer = setTimeout(() => { wakeTimer = null; flushRef?.() }, Math.min(Math.max(ms, 0) + 50, 2_147_000_000))
        wakeTimer.unref?.()
      },
      maxAttempts: () => Number(cfg(config, 'maxAttempts', 8)),
      retryBaseMs: () => Number(cfg(config, 'retryBaseSeconds', 30)) * 1000,
      maxRetryMs: () => Number(cfg(config, 'maxRetrySeconds', 3600)) * 1000,
      deliveryMode: () => cfg(config, 'deliveryMode', 'card'),
      undeliverableRetries: () => Number(cfg(config, 'undeliverableRetries', 3)),
      honorQuietHours: () => cfg(config, 'honorQuietHours', true) !== false,
      enabled: () => Boolean(cfg(config, 'enabled', true)),
      apiErrorPrefix: () => {
        const prefix = String(cfg(config, 'apiErrorPrefix', 'api') || 'api')
        return ERROR_PREFIX_RE.test(prefix) ? prefix : 'api'
      },
    })
    let reportTables
    try {
      reportDomain = await openDomain(ctx, { name: domains.aiReport, tables: ['sessions', 'owners'] })
      reportTables = { sessions: reportDomain.table('sessions'), owners: reportDomain.table('owners') }
    } catch (error) {
      logger.warn('bridge-notify: DSH storage unavailable for the AI report; kept in memory only: %s', error?.message ?? error)
    }
    reporter = createAiReporter({
      registry, dshIm, proactive: () => proactiveService, ...(reportTables ? { tables: reportTables } : {}), logger,
      prompt: () => cfg(config, 'aiReportPrompt', '') || '',
      roles: () => cfg(config, 'aiReportRoles', DEFAULT_REPORT_ROLES),
      command: () => cfg(config, 'aiReportCommand', DEFAULT_AI_REPORT_COMMAND),
      messages: () => cfg(config, 'aiReportMessages', {}) ?? {},
      targetPrefix: () => cfg(config, 'aiReportTargetPrefix', '') || '',
      applicationOptions,
      webUrl: () => cfg(config, 'webUrl', '') || '',
      guardMode: () => cfg(config, 'aiReportGuard', 'screen'),
      proactiveDelivery: () => cfg(config, 'proactiveDelivery', 'allow'),
    })
    for (const e of inboundQueue.splice(0)) await reporter.noteInbound(e).catch(() => {})
    flushRef = () => core.flush()
    // 再起動前の送信待ち・延期中・報告待ちを再開
    await core.flush()
    const ms = Math.max(1, Number(cfg(config, 'flushIntervalSeconds', 30))) * 1000
    timer = setInterval(() => { core.flush() }, ms)
    timer.unref?.()
    return core
  })()

  const handleEvent = async (event) => (await ready).handleEvent(event)
  whenServices(ctx, ['bridgeEvents'], (sub) => {
    const offs = []
    // 設定 notifyTypes と文面モジュールの types（読み込み後）。manifest が宣言した種別は subscribeManifestNotify で受ける
    const types = list('notifyTypes')
    if (types.length) offs.push(sub.bridgeEvents.subscribe(types, handleEvent))
    ready.then(() => {
      const extra = [...new Set(modules.flatMap((m) => m.module.types))].filter((t) => !types.includes(t))
      if (extra.length) offs.push(sub.bridgeEvents.subscribe(extra, handleEvent))
    }).catch(() => {})
    if (typeof sub.bridgeEvents.subscribeManifestNotify === 'function') offs.push(sub.bridgeEvents.subscribeManifestNotify(handleEvent))
    return () => { for (const off of offs.splice(0)) { try { off?.() } catch { /* noop */ } } }
  })
  // dsh-auto-tasks の playbook タスク（applicationId + audience）の報告を、そのアプリケーションの受信者へ
  whenServices(ctx, ['autoTasks'], (sub) => {
    if (typeof sub.autoTasks?.setAudienceDelivery !== 'function') return undefined
    const off = sub.autoTasks.setAudienceDelivery(async (input) => (await ready).deliverAudience(input))
    return typeof off === 'function' ? off : undefined
  })

  const service = Object.freeze({
    version: 1,
    ready,
    handleEvent,
    flushNow: async () => (await ready).flush(),
    status: async () => ({ ...(await ready).status(), aiReport: reporter?.stats() ?? null, templateModules: modules.length }),
    deliverAudience: async (input) => (await ready).deliverAudience(input),
    /**
     * 文面モジュールを足す（別のプラグインから）。applicationId = null なら全アプリケーション。
     * 登録した後に届くイベントから使う。types に挙げた種別は、bridge-events の購読にも足す（apply のあと bridgeEvents があれば）。
     */
    async registerTemplates(applicationId, mod) {
      await ready
      const entry = { application: applicationId || null, module: normalizeTemplateModule(mod) }
      modules.push(entry)
      if (entry.module.types.length && ctx.bridgeEvents?.subscribe) disposers.push(ctx.bridgeEvents.subscribe(entry.module.types, handleEvent))
      return () => { const i = modules.indexOf(entry); if (i >= 0) modules.splice(i, 1) }
    },
    /** bridge-tools の委任ゲート：この会話で AI 社員の定時報告を有効にした本人の IM の発信元（無ければ null）。 */
    aiReportOwner: (sessionId) => (aiReportOn() ? reporter?.ownerOf(sessionId) ?? null : null),
    /** ホスト側から同じ操作をする（IM のコマンドと同じ検証。source は dsh-im の ImSource）。 */
    aiReport: Object.freeze({
      enable: async (source) => { await ready; return reporter.enable(source) },
      disable: async (source) => { await ready; return reporter.disable(source) },
      status: async (source) => { await ready; return reporter.status(source) },
      fire: async (source) => { await ready; return reporter.fire(source) },
    }),
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, service)
  else ctx[SERVICE] = service

  onDispose(ctx, async () => {
    if (timer) clearInterval(timer)
    timer = null
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = null
    flushRef = null
    for (const fn of disposers.splice(0)) { try { fn() } catch { /* noop */ } }
    await ready.catch(() => {})
    if (domain) await domain.close().catch(() => {})
    if (reportDomain) await reportDomain.close().catch(() => {})
    if (audienceDomain) await audienceDomain.close().catch(() => {})
  })
  return service
}

export { createAiReporter } from './ai-report.js'
export { absoluteLink, frameFact, frameReport, renderManifestMessage, renderNotification } from './templates.js'
export { quietUntil } from './quiet-hours.js'
export * as format from './format.js'
