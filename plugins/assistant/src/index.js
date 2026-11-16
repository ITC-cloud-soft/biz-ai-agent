import { DEFAULT_APPLICATION_ID, cfg, fallbackRegistry, loadSchemastery, makeLogger, onDispose, watchRegistry } from '@dsh-bridge/dsh-core'
import { createAssistantService, DEFAULT_AGENTS } from './service.js'
import { createHostHarness } from './harness.js'
import { IMAGE_CLEANUP_DEFAULTS, createImageCleanup, resolveDshHome } from '@dsh-bridge/dsh-core'

/**
 * bridge-assistant — 業務 Web の右サイドパネルから、ログイン中の職員が「本人の権限で」AI 社員に質問するための DSH 側（汎用プラグイン）。
 *
 * - 管理 RPC `POST /api/bridge-assistant/assistant`（dsh-im の管理 RPC と同じ形式（エンベロープ）、method `bridge-assistant/assistant`）。
 *   呼ぶのは業務 Web の BFF だけ（@dsh-bridge/gateway の gateway.rpc、許可リスト plugin=bridge-assistant / channel=/assistant）。
 *   既定でループバックの要求だけ受け付ける（rpcAuthority: loopback）。
 * - 本文の `ticket`（業務システムが本人のセッションに対して発行）を業務システムで委託 token に交換して職員を確定する。本文の userId は無い。
 * - アプリケーション × 職員 × AI 社員ごとに DSH の会話を持つ（プリセットは agents[].preset）。応答は Host の `session/event` から集める。
 * - `ctx.bridgeAssistant.delegationForSession(sessionId, exec)`：bridge-tools が、アシスタント会話のツール呼び出しで本人の委託 token を得る。
 *   `applicationIdForSession(sessionId)` で会話のアプリケーションを公開し、tools-sdk の委託 gate はそのアプリケーションのツールにだけ使わせる。
 * - 複数アプリケーション（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps）：RPC の `application`（省略時は既定のアプリケーション）の API で
 *   チケットを交換する。AI 社員は `agents[].application` でアプリケーションに属する（無ければ既定のアプリケーション）。
 *   レジストリが無ければプラグイン設定の apiUrl / serviceToken の 1 件（Bridge v1 の経路）。
 * - 添付の画像の後片付け（@dsh-bridge/dsh-core の image-cleanup.js）：画像を送った会話を台帳に残し、やり直し・使われなくなった会話（12 時間）の画像のうち、
 *   ほかの会話が参照しないものを定期的に消す（設定 imageCleanup、既定 on）。
 */

export const name = 'bridge-assistant'
// Host の接続サービス（管理 RPC の登録・Host への peer）と Harness（Typert gateway：会話の作成・送信、src/harness.js）。
// 宣言しないと実 DSH では ctx.connection / ctx.typertGateway を読めない（"cannot get property ... without inject"）。
// llm：添付の画像をモデルが読めるか（resolveModelInfo の inputModalities、src/harness.js の imageSupport）。
export const inject = ['connection', 'typertGateway', 'llm']
export const SERVICE = 'bridgeAssistant'
export const RPC_NAME = 'bridge-assistant'
export const RPC_PATH = '/api/bridge-assistant/assistant'
export const RPC_ENDPOINT = 'bridge-assistant/assistant'
const RPC_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

/**
 * 管理 RPC の名前（設定 rpcName。既定 bridge-assistant）→ { path: /api/<name>/assistant, endpoint: <name>/assistant }。
 * 業務 Web の BFF（@dsh-bridge/gateway の gateway.rpc(..., { plugin: <name> })）が以前の名前で呼んでいる導入先で変える。
 */
export function rpcRoute(rpcName = RPC_NAME) {
  const value = String(rpcName ?? '').trim() || RPC_NAME
  if (!RPC_NAME_RE.test(value)) throw new TypeError(`bridge-assistant: invalid rpcName ${JSON.stringify(value)}`)
  return Object.freeze({ name: value, path: `/api/${value}/assistant`, endpoint: `${value}/assistant` })
}

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名'),
      workspace: z.string().description('アシスタント会話の workspace。未設定なら DSH の cwd'),
      timeZone: z.string().default('Asia/Tokyo').description('アシスタント会話の時刻の基準（Harness の clientTimeZone）'),
      rpcAuthority: z.union([z.const('loopback'), z.const('trusted-host')]).default('loopback')
        .description('管理 RPC を受け付ける要求：loopback=ゲートウェイ（同一ホスト）からだけ / trusted-host=DSH の既定の信頼ホスト'),
      sendsPerMinute: z.natural().default(20).description('職員ごとの送信の上限（1 分あたり）'),
      turnTimeoutMinutes: z.natural().default(10).description('応答が無いときに打ち切るまでの分'),
      agents: z.array(z.object({
        id: z.string().description('画面に出す AI 社員の ID（英小文字・数字・-）'),
        preset: z.string().description('DSH の Agent プリセット ID'),
        name: z.string().description('表示名'),
        description: z.string().description('説明'),
        application: z.string().description('この AI 社員の業務アプリケーション ID（省略時は既定のアプリケーション）'),
        sessionTitle: z.string().description('DSH の会話の題名（{application} = アプリ名、{user} = 職員 ID の先頭 8 文字。既定 AIアシスタント（{application}・職員 {user}））'),
      })).default(DEFAULT_AGENTS.map((a) => ({ ...a }))).description('パネルで選べる AI 社員（プリセットは業務ツールだけのものにすること）'),
      contextIds: z.dict(z.string()).default({}).description('画面の文脈で渡せる ID の種類（キー → 表示名。例 equipmentId: 設備ID）。manifest の entities からも作る'),
      roleLabels: z.dict(z.string()).default({}).description('役割の表示名（manifest の roles.<id>.label に足す・上書き）'),
      rpcName: z.string().description('管理 RPC の名前（/api/<rpcName>/assistant。既定 bridge-assistant）。BFF が以前の名前で呼ぶ導入先だけ変える（再起動が要る）'),
      errorCodes: z.dict(z.string()).default({}).description('RPC のエラーコードの置き換え（例 api-unavailable → 以前の BFF が知っているコード）'),
      imageInput: z.union([z.const('auto'), z.const('on'), z.const('off')]).default('auto')
        .description('添付の画像をモデルが読めるか：auto=DSH のモデル情報（inputModalities）で判定 / on=読める / off=読めない（画像の添付を断る）'),
      maxAttachmentBytes: z.natural().default(20 * 1024 * 1024).description('1 回の質問の添付の合計の上限（バイト。画像はデコード後、文書は文字の UTF-8）'),
      imageCleanup: z.union([z.const('on'), z.const('off')]).default('on')
        .description('終わった会話（やり直し・12 時間使われない）の添付の画像を、ほかの会話が参照していなければ消す'),
      imageCleanupMinutes: z.natural().default(60).description('画像の後片付けの間隔（分）'),
      dshHome: z.string().description('DSH のホーム（画像の保存先・会話のログ）。未設定なら環境変数 DSH_HOME、無ければ ~/.dsh'),
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

function isLoopbackAuthority(authority) {
  if (!authority) return false
  try {
    const url = new URL(`http://${authority}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
    const hostname = url.hostname.replace(/\.$/, '')
    return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
  } catch {
    return false
  }
}

/** Server-to-server call from the gateway: loopback Host and no (or a loopback) Origin. */
export function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get('host'))) return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host)
  } catch {
    return false
  }
}

function reply(rpcId, result) {
  const value = result.ok === false ? { ...result, error: { ...result.error, details: result.error.details ?? {} } } : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The fetch handler of the management RPC (exported for tests). */
export function createRpcHandler(service, { authority = () => 'loopback', endpoint = RPC_ENDPOINT } = {}) {
  return async function fetch(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (authority() === 'loopback' && !isLoopbackRequest(request)) return new Response('forbidden', { status: 403 })
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }
    let message
    try { message = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    const call = message?.payload
    if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
      || message.method !== endpoint || !isRecord(call) || typeof call.method !== 'string' || !Object.hasOwn(call, 'payload')) {
      return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid assistant request.' } })
    }
    return reply(rpcId, await service.handleRpc(call.method, call.payload))
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const harness = createHostHarness(ctx, {
    workspace: () => cfg(config, 'workspace', '') || process.cwd(),
    timeZone: () => cfg(config, 'timeZone', 'Asia/Tokyo'),
    logger,
  })
  const cleanupOn = String(cfg(config, 'imageCleanup', 'on')) !== 'off'
  const imageCleanup = cleanupOn ? createImageCleanup({ dshHome: resolveDshHome(cfg(config, 'dshHome', '')), logger }) : null
  const service = createAssistantService({
    imageCleanup,
    registry,
    harness,
    agents: () => cfg(config, 'agents', DEFAULT_AGENTS),
    contextIds: () => cfg(config, 'contextIds', {}) ?? {},
    roleLabels: () => cfg(config, 'roleLabels', {}) ?? {},
    errorCodes: () => cfg(config, 'errorCodes', {}) ?? {},
    imageInput: () => cfg(config, 'imageInput', 'auto'),
    limits: {
      sendsPerMinute: Number(cfg(config, 'sendsPerMinute', 20)) || 20,
      turnTimeoutMs: (Number(cfg(config, 'turnTimeoutMinutes', 10)) || 10) * 60_000,
      maxAttachmentBytes: Number(cfg(config, 'maxAttachmentBytes', 20 * 1024 * 1024)) || 20 * 1024 * 1024,
    },
    logger,
  })

  const disposers = []
  if (imageCleanup) {
    const every = Math.max(1, Number(cfg(config, 'imageCleanupMinutes', 60)) || 60) * 60_000
    const tick = () => { imageCleanup.run({ live: service.liveSessionIds() }) }
    const first = setTimeout(tick, Math.min(IMAGE_CLEANUP_DEFAULTS.firstRunMs, every))
    const timer = setInterval(tick, every)
    first.unref?.()
    timer.unref?.()
    disposers.push(() => { clearTimeout(first); clearInterval(timer) })
  }
  const route = rpcRoute(cfg(config, 'rpcName', ''))
  if (typeof ctx?.connection?.fetch?.register === 'function') {
    const handle = ctx.connection.fetch.register({
      path: route.path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createRpcHandler(service, { authority: () => cfg(config, 'rpcAuthority', 'loopback'), endpoint: route.endpoint }),
    })
    if (typeof handle === 'function') disposers.push(handle)
    else if (handle && typeof handle.dispose === 'function') disposers.push(() => handle.dispose())
  } else {
    logger.warn('bridge-assistant: DSH Host Connection Fetch registry is missing; the assistant RPC is not available')
  }
  if (typeof ctx?.on === 'function') {
    const off = ctx.on('session/event', (session, event) => {
      try { service.onSessionEvent(session?.id, event) } catch (error) {
        logger.warn('bridge-assistant: event handling failed: %s', error?.name ?? 'error')
      }
    }, { global: true })
    if (typeof off === 'function') disposers.push(off)
  } else {
    logger.warn('bridge-assistant: ctx.on is missing; replies cannot be collected')
  }

  const publicService = Object.freeze({
    version: 1,
    isAssistantSession: service.isAssistantSession,
    delegationForSession: service.delegationForSession,
    /** アシスタントの会話のアプリケーション（tools-sdk の委託 gate が照合する）。アシスタントの会話でなければ null。 */
    applicationIdForSession: service.applicationIdForSession,
    /** アシスタントの会話の職員 {userId, applicationId, role}（読み取りだけ。bridge-memory の振り返り用）。アシスタントの会話でなければ null。 */
    userForSession: service.userForSession,
    /** アシスタントの会話の AI 社員 {applicationId, agentId, preset}（bridge-persona の呼び名・人物の設定用）。アシスタントの会話でなければ null。 */
    agentForSession: service.agentForSession,
    /** 既定のアプリケーション（applicationIdForSession が使えない古い gate 向け）。 */
    get applicationId() { return service.defaultApplicationId() },
    invalidate: service.invalidate,
    stats: () => ({ ...service.stats(), imageCleanup: imageCleanup ? imageCleanup.stats() : null }),
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, publicService)
  else ctx[SERVICE] = publicService

  onDispose(ctx, () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  })
  return { service, publicService }
}
