import {
  BridgeApiError, DEFAULT_APPLICATION_ID, GROUP_CHAT_GUIDE, appNickname, HELP_LABEL, NOTIFY_ONLY_PLATFORMS, V1_PATHS, apiSource, cfg, createLinkGuard, fallbackRegistry,
  frameAiText, groupChatPolicy, isGroupConversation, loadSchemastery, makeLogger, normalizeText, onDispose, signatureOf, sourceKey, watchRegistry, whenServices,
} from '@dsh-bridge/dsh-core'
import { defaultSwitchStatePath, installAppSwitch } from './app-switch.js'

/**
 * bridge-identity — IM 発信者 → 業務アプリケーションの職員 の対応付け（DSH Business Bridge の汎用プラグイン）。
 *
 * - dsh-im の setAccessResolver: 連携済み職員は allow、未連携は deny + 連携手順を返信。
 *   グループ会話（1:1 でない会話）は既定で deny ＋ 固定の案内（messages.groupChat「業務の内容は個別チャットでお尋ねください。」）：
 *   AI は動かず、業務システムにも照会しない（発言者の権限で答えるとグループの他の人に見えるため。N1b）。
 *   アプリケーションごと（レジストリの applications[].groupChat）・プラグインの groupChat で allow にできる。
 * - claimReplies: 「連携 123456」（キーワードは設定 linkKeywords）を agent に渡さず処理（Bridge プロトコル identities/link）
 * - ctx.bridgeIdentity: resolve(source) / forSession(sessionId) / invalidate / onUnlinked / applicationOf / stats
 * - bridge-events の `sns_identity.unlinked`（Web で本人が解除）→ その職員・プラットフォームのキャッシュを即時に消し、
 *   onUnlinked の購読者（bridge-tools の委託 token キャッシュ）にも知らせる。以後は未連携として拒否し、連携手順を案内する。
 *
 * 複数アプリケーション（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps）：発信元のボット（dsh-im の ImSource.botId）から
 * アプリケーションを決め、照会・連携はそのアプリケーションの API に送る。キャッシュはアプリケーションごと。
 * どのアプリケーションにも属さないボットの発言は拒否する。レジストリが無ければプラグイン設定（apiUrl / serviceToken）の
 * 1 件（Bridge v1 の経路）として動く。
 *
 * 共用ボット（個人 WeChat。レジストリで multiApp: true のボット）は同じ窓口内でアプリケーションを切り替える（src/app-switch.js）：
 * 「#一覧」「#<アプリ名>」「#いま」、返信の【アプリ名】、通知への返信はその通知のアプリケーションへ。
 *
 * 信頼できる発信元は dsh-im がプラットフォームのイベントから作る ImSource だけ。本文のテキストは信用しない。
 *
 * システムの使い方（care-ai-native docs/design/SNS_HELP_QA.md）：
 * - 未連携の発信者の質問（1:1）には、manifest に help があり経路 paths.publicHelp（v1 は /bridge/v1/help/public、ケアビリングは /api/ai/help/public）があれば、
 *   AI を使わずに公開の節（ログイン・SNS 連携）だけで答え、連携の案内を添える（D1）。見つからなければ従来どおり案内だけ。
 * - リンクの検査（linkGuard）：AI の答え（IM のターン）を送る前に、業務 Web の URL は manifest の web.routes の画面だけを残し、
 *   ほかのホストは linkGuard.allowHosts だけを残す（dsh-im の setAnswerFilter。routes の無いアプリケーションでは何もしない）。
 *
 * email は通知専用のプラットフォーム：差出人（From）は詐称でき、dsh-im は DKIM / DMARC を検証しないので、連携コードを受け付けず
 * （「メールでは連携できません」と返す）、AI の利用も拒否する（返信しない：詐称された宛先へ送り返さない）。
 */

export const name = 'bridge-identity'
export const inject = ['dshIm']
export const SERVICE = 'bridgeIdentity'

export const DEFAULT_LINK_KEYWORDS = Object.freeze(['連携'])

/** 未連携の案内（キーワードは linkKeywords の先頭）。 */
export function linkGuide(keyword = DEFAULT_LINK_KEYWORDS[0]) {
  return `AI 秘書です。お手伝いを始める前に、業務システムとの連携をお願いします。業務Webで連携コードを発行し、『${keyword} 123456』と送信してください（コードの有効期限は 10 分です）。`
}
export const LINK_GUIDE_JA = linkGuide()

// 会話の返事（AI 秘書の口調。ラベルは付けない）。設定 messages / レジストリの applications[].messages で上書きできる
export const DEFAULT_MESSAGES = Object.freeze({
  unavailable: '申し訳ありません。現在、業務システムに接続できません。しばらくしてから、もう一度お試しください。',
  linked: '連携が完了しました。{displayName}ご利用いただけます。これから、確認やお願いが必要なことをこのチャットでお知らせします。気になることがあれば、いつでも話しかけてください。',
  invalidCode: '連携コードが無効か、有効期限（10分）が切れているようです。お手数ですが、業務Webで新しいコードを発行して、もう一度送ってください。',
  alreadyLinked: 'このアカウントは既に連携済みです。連携先を変更する場合は、管理者にご連絡ください。',
  groupNotAllowed: '連携はボットとの個別チャット（DM）でお願いします。このコードは他の方に見えた可能性があるため、業務Webで新しいコードを発行してください。',
  tooMany: '連携の試行回数が多すぎます。しばらく時間をおいてから、もう一度お試しください。',
  failed: '申し訳ありません。連携に失敗しました。時間をおいて再度お試しいただくか、管理者にご連絡ください。',
  noApplication: '申し訳ありません。このボットはどの業務システムにも割り当てられていません。管理者にご連絡ください。',
  emailNotLinkable: 'メールでは連携できません。業務Webで別の SNS を連携してください。',
  groupChat: GROUP_CHAT_GUIDE,
})

/** 発信者を検証できない（通知だけの）プラットフォームか。 */
export const isNotifyOnlySource = (source) => NOTIFY_ONLY_PLATFORMS.includes(String(source?.platform ?? ''))

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 「<キーワード> 123456」の正規表現（全角数字・全角スペースは normalizeText で半角にしてから照合する）。 */
export function linkPattern(keywords = DEFAULT_LINK_KEYWORDS) {
  const words = (Array.isArray(keywords) ? keywords : [keywords]).map((w) => String(w ?? '').normalize('NFKC').trim()).filter(Boolean)
  const list = words.length ? words : [...DEFAULT_LINK_KEYWORDS]
  return new RegExp(`^(?:${list.map(escapeRe).join('|')})\\s*(\\d{6})$`, 'i')
}
export const LINK_RE = linkPattern()
export const UNLINKED_EVENT = 'sns_identity.unlinked'

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名'),
      cacheTtlSeconds: z.natural().default(60).description('連携状態キャッシュの有効秒数'),
      linkKeywords: z.array(z.string()).default([...DEFAULT_LINK_KEYWORDS]).description('連携コードの前に付けるキーワード（例 連携 / link）'),
      unlinkedReply: z.string().description('未連携アカウントへの返信（既定は linkKeywords の先頭を使った案内）'),
      messages: z.dict(z.string()).default({}).description('会話の返事の上書き（unavailable / linked（{displayName} 可）/ invalidCode / alreadyLinked / groupNotAllowed / tooMany / failed / noApplication / emailNotLinkable / groupChat）'),
      groupChat: z.union([z.const('deny'), z.const('allow')]).default('deny').description('グループ会話（1:1 でない会話）で AI を使わせるか（deny：AI は動かず messages.groupChat の案内だけ返す。アプリケーションごとはレジストリの applications[].groupChat）'),
      guideIntervalSeconds: z.natural().default(600).description('同じ未連携アカウントへ手順を再送しない秒数（グループの連投対策）'),
      linkAttemptsPerWindow: z.natural().default(5).description('連携コード試行の上限（10分あたり・アカウントごと）'),
      switchReplyWindowSeconds: z.natural().default(600).description('共用ボット：通知の後、引用なしの最初の返信をその通知のアプリに結び付ける秒数（0 で引用だけ）'),
      switchStatePath: z.string().description('共用ボット：「いまのアプリ」と通知の記録の保存先（既定 $DSH_HOME/integrations/bridge-identity/app-switch.json）'),
      switchWords: z.object({
        list: z.array(z.string()).description('一覧の語（既定 一覧 / いちらん / アプリ / apps / list）'),
        current: z.array(z.string()).description('いまのアプリの語（既定 いま / 今 / 現在 / now / current）'),
        help: z.array(z.string()).description('使い方の語（既定 ヘルプ / 使い方 / つかいかた / help / ?）'),
      }).description('共用ボットの切り替えコマンド（# の後ろの語）'),
      switchMessages: z.dict(z.string()).default({}).description('共用ボットの返事の上書き（listTitle / listFooter / helpTitle / helpExample）'),
      publicHelp: z.object({
        enabled: z.boolean().default(true).description('未連携の発信者の質問に、公開の節（paths.publicHelp）で答える（AI は使わない）'),
        perWindow: z.natural().default(10).description('1 アカウントの 10 分あたりの答えの上限'),
      }).description('未連携の発信者へのシステムの使い方の答え（アプリケーションの paths.publicHelp があるときだけ）'),
      linkGuard: z.object({
        enabled: z.boolean().default(true).description('AI の答えのリンクを、業務 Web の画面（manifest の web.routes）と許可したホストだけにする'),
        webUrl: z.string().description('既定のアプリケーションの業務 Web の URL（通知の webUrl と同じ値）'),
        webUrls: z.dict(z.string()).default({}).description('アプリケーション ID ごとの業務 Web の URL'),
        allowHosts: z.array(z.string()).default([]).description('業務 Web 以外に残してよいホスト（そのホストとサブドメイン）'),
      }).description('AI の答えのリンクの検査（dsh-im の setAnswerFilter）'),
    })
  : undefined

function toDisposer(handle) {
  if (typeof handle === 'function') return handle
  if (handle && typeof handle.dispose === 'function') return () => handle.dispose()
  return () => {}
}

/**
 * レジストリ（bridge-apps）が無いときの 1 件：プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）、Bridge v1 の経路。
 * 業務固有の環境変数は読まない（profile の cordis.patch.yml で `!!js process.env.X` として渡す）。
 */
export function configRegistry(config, { logger } = {}) {
  return fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
}

/**
 * 照会の source：業務 API の形（platform / teamId / userId）に、受信したボット（botId）を足したもの。業務システムは、登録済みの
 * 個人ボット経由の発言を、そのボットの持ち主の職員にだけ解決する（care-ai-native IM_PERSONAL_BOTS §4。他の職員は「連携なし」）。
 */
export function lookupSource(source) {
  const body = apiSource(source)
  return body && source?.botId ? { ...body, botId: String(source.botId) } : body
}
// キャッシュはボットごと（同じアカウントでも、個人ボット経由と組織ボット経由で結果が違う）
const accountKey = (applicationId, source) => `${applicationId}\u0001${sourceKey(apiSource(source) ?? source)}\u0001`
const appKey = (applicationId, source) => `${accountKey(applicationId, source)}${source?.botId ? String(source.botId) : ''}`

/**
 * ctx に依存しない本体（テストから直接使う）。
 * @param {object} deps
 * @param {object|(() => object)} [deps.registry]  アプリケーションレジストリ（@dsh-bridge/dsh-core）。関数なら呼び出しごとに評価
 * @param {object} [deps.api]   レジストリの代わりに 1 つの API クライアント（get / post）。Bridge v1 の経路で使う
 * @param {object} [deps.paths] api を渡すときの経路（既定 V1_PATHS）
 * @param {object} deps.dshIm
 */
export function createIdentityService({ registry = null, api = null, paths = V1_PATHS, dshIm, ttlMs = 60_000, now = Date.now, logger = console }) {
  const single = api ? { id: DEFAULT_APPLICATION_ID, api, paths } : null
  const currentRegistry = () => (typeof registry === 'function' ? registry() : registry)
  const cache = new Map() // appKey -> { value, expiresAt, source, applicationId }
  const inflight = new Map()
  const unlinkListeners = new Set()
  let epoch = 0 // 解除のたびに進める。解除前に始まった照会結果はキャッシュしない
  const stats = { lookups: 0, cacheHits: 0, links: 0, lastError: null, lastErrorAt: null, lastOkAt: null }
  const linkedUsers = new Map() // appKey -> userId（このプロセスで確認できた連携）

  /** 発信元（ボット）→ アプリケーション。レジストリが無ければ単一の API。どれにも属さなければ null。 */
  function applicationFor(source) {
    if (single) return single
    const reg = currentRegistry()
    if (!reg) return null
    return reg.resolveApplication(source) ?? null
  }

  function defaultApplicationId() {
    if (single) return single.id
    return currentRegistry()?.default?.()?.id ?? null
  }

  function remember(key, value, source, applicationId) {
    cache.set(key, { value, expiresAt: now() + ttlMs, source, applicationId })
    if (value.linked && value.user?.id) linkedUsers.set(key, value.user.id)
    else linkedUsers.delete(key)
  }

  async function resolveIn(app, source) {
    const body = lookupSource(source)
    if (!body) return { linked: false }
    // 通知専用のプラットフォーム（email）の発信者は誰の連携にもならない（業務システムにも照会しない）
    if (isNotifyOnlySource(body)) return { linked: false, orgId: null, notifyOnly: true }
    if (!app) return { linked: false, orgId: null }
    const key = appKey(app.id, body)
    stats.lookups += 1
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now()) {
      stats.cacheHits += 1
      return hit.value
    }
    if (inflight.has(key)) return inflight.get(key)
    const startedAt = epoch
    const task = (async () => {
      try {
        const res = await app.api.get(app.paths.identity, { query: body })
        const orgId = res.orgId === undefined || res.orgId === null ? null : String(res.orgId)
        const value = res.linked && res.user
          ? { linked: true, orgId, user: { id: String(res.user.id), role: res.user.role ?? null, displayName: res.user.displayName ?? null } }
          : { linked: false, orgId }
        if (startedAt === epoch) remember(key, value, body, app.id)
        stats.lastOkAt = new Date(now()).toISOString()
        return value
      } catch (error) {
        stats.lastError = error instanceof Error ? error.message : String(error)
        stats.lastErrorAt = new Date(now()).toISOString()
        throw error
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, task)
    return task
  }

  /** 連携状態（発信元のボットのアプリケーションで照会）。{linked, orgId?, user?} */
  async function resolve(source) {
    return resolveIn(applicationFor(source), source)
  }

  async function forSession(sessionId) {
    if (!sessionId || typeof dshIm?.sourceForTurn !== 'function') return null
    let source = null
    try {
      source = await dshIm.sourceForTurn(sessionId)
    } catch (error) {
      logger.warn?.('bridge-identity: sourceForTurn failed: %s', error?.message ?? error)
      return null
    }
    if (!source) return null
    const app = applicationFor(source)
    const identity = await resolveIn(app, source)
    return { source, ...identity, applicationId: app ? app.id : null }
  }

  /** そのアカウントのキャッシュ（どのボット経由の分も）を消す。 */
  function invalidate(source) {
    const app = applicationFor(source)
    if (!app) return
    const prefix = accountKey(app.id, source)
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) { cache.delete(key); linkedUsers.delete(key) }
  }

  async function link(code, source) {
    const body = apiSource(source)
    if (!body) throw new BridgeApiError('source is required', { status: 400, code: 'invalid_source', kind: 'request' })
    if (isNotifyOnlySource(body)) throw new BridgeApiError('this platform cannot be linked', { status: 400, code: 'platform_not_linkable', kind: 'request' })
    const app = applicationFor(source)
    if (!app) throw new BridgeApiError('the bot is not assigned to an application', { status: 400, code: 'no_application', kind: 'request' })
    // 業務システムは link 時の source.botId を保存する（個人ボット・複数ワークスペースの宛先はそのボットでしか通じない）
    const linkSource = source.botId ? { ...body, botId: String(source.botId) } : body
    const res = await app.api.post(app.paths.link, { code, source: linkSource })
    stats.links += 1
    invalidate(source)
    return { ...res, applicationId: app.id }
  }

  /**
   * `sns_identity.unlinked` {identityId, userId, platform}：その職員（userId = そのアプリケーションの職員 ID）の当該プラットフォームの
   * 連携キャッシュを消す。applicationId（既定は既定のアプリケーション）以外のキャッシュは触らない。
   * 既定のアプリケーションが無い構成では全アプリケーションから消す（消し過ぎは再照会になるだけで安全側）。
   * @returns 消した source の配列
   */
  function unlinked({ userId, platform, applicationId } = {}) {
    if (!userId) return []
    const appId = applicationId ? String(applicationId) : defaultApplicationId()
    epoch += 1
    const removed = []
    for (const [key, entry] of [...cache.entries()]) {
      const sameApp = !appId || entry.applicationId === appId
      const sameUser = entry.value?.user?.id === String(userId)
      const samePlatform = !platform || entry.source?.platform === String(platform)
      if (sameApp && sameUser && samePlatform) {
        cache.delete(key)
        linkedUsers.delete(key)
        removed.push(entry.source)
      }
    }
    for (const fn of unlinkListeners) {
      try {
        fn({ userId: String(userId), platform: platform ? String(platform) : null, applicationId: appId ?? null, sources: removed })
      } catch (error) {
        logger.warn?.('bridge-identity: unlink listener failed: %s', error?.message ?? error)
      }
    }
    return removed
  }

  return {
    resolve,
    forSession,
    invalidate,
    link,
    unlinked,
    /** 発信元のボットのアプリケーション ID（どれにも属さなければ null）。 */
    applicationOf: (source) => applicationFor(source)?.id ?? null,
    /** 発信元のボットのアプリケーション（レジストリの要素。どれにも属さなければ null）。 */
    application: (source) => applicationFor(source),
    defaultApplicationId,
    onUnlinked(fn) {
      unlinkListeners.add(fn)
      return () => { unlinkListeners.delete(fn) }
    },
    stats: () => ({ ...stats, cacheSize: cache.size, linkedSeen: new Set(linkedUsers.values()).size }),
  }
}

/** 試行回数の簡易制限（アカウントごと・スライディングウィンドウ）。 */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map()
  return {
    take(key) {
      const t = now()
      const list = (hits.get(key) ?? []).filter((at) => t - at < windowMs)
      if (list.length >= limit) {
        hits.set(key, list)
        return false
      }
      list.push(t)
      hits.set(key, list)
      return true
    },
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const dshIm = ctx.dshIm
  const service = createIdentityService({
    registry,
    dshIm,
    ttlMs: Number(cfg(config, 'cacheTtlSeconds', 60)) * 1000,
    logger,
  })
  const limiter = createRateLimiter({ limit: Number(cfg(config, 'linkAttemptsPerWindow', 5)) || 5, windowMs: 10 * 60_000 })
  const guideSentAt = new Map()
  // 同じ IM アカウントでもアプリケーション（ボット）が違えば別の案内・別の試行回数
  const accountKey = (source) => `${service.applicationOf(source) ?? ''}\u0001${sourceKey(source)}`
  const keywords = () => {
    const list = cfg(config, 'linkKeywords', DEFAULT_LINK_KEYWORDS)
    return Array.isArray(list) && list.length ? list.map(String) : [...DEFAULT_LINK_KEYWORDS]
  }
  let linkRe = linkPattern(keywords())
  let linkReFor = keywords().join('\u0001')
  const currentLinkRe = () => {
    const key = keywords().join('\u0001')
    if (key !== linkReFor) { linkRe = linkPattern(keywords()); linkReFor = key }
    return linkRe
  }

  /** 返事の文：アプリケーションの messages → プラグイン設定の messages → 既定。 */
  function msg(app, key, vars = {}) {
    const fromApp = app?.messages?.[key]
    const fromConfig = (cfg(config, 'messages', {}) ?? {})[key]
    const text = String((typeof fromApp === 'string' && fromApp) || (typeof fromConfig === 'string' && fromConfig) || DEFAULT_MESSAGES[key] || '')
    return text.replace(/\{([A-Za-z]+)\}/g, (_, name) => String(vars[name] ?? ''))
  }

  function shouldSendGuide(source) {
    const key = accountKey(source)
    const interval = Number(cfg(config, 'guideIntervalSeconds', 600)) * 1000
    const last = guideSentAt.get(key) ?? 0
    if (Date.now() - last < interval) return false
    guideSentAt.set(key, Date.now())
    return true
  }

  // グループの案内は会話ごと（メンバーごとに出さない）
  function shouldSendGroupGuide(app, source) {
    const key = `${app?.id ?? ''}group${source?.platform ?? ''}${source?.teamId ?? ''}${source?.conversationId ?? source?.userId ?? ''}`
    const interval = Number(cfg(config, 'guideIntervalSeconds', 600)) * 1000
    const last = guideSentAt.get(key) ?? 0
    if (Date.now() - last < interval) return false
    guideSentAt.set(key, Date.now())
    return true
  }

  function guideFor(source) {
    const app = service.application(source)
    return String(app?.messages?.unlinkedReply || cfg(config, 'unlinkedReply', '') || linkGuide(keywords()[0]))
  }

  async function accessResolver(source, { text = '' } = {}) {
    // email：差出人を検証できないので AI は使わせない。詐称された差出人へ案内を送り返さないよう、返信もしない
    if (isNotifyOnlySource(source)) {
      logger.info('bridge-identity: %s source denied (notify-only platform)', source?.platform)
      return 'deny'
    }
    const app = service.application(source)
    if (!app) {
      logger.info('bridge-identity: %s bot %s is not assigned to any application; denied', source?.platform ?? '?', source?.botId ?? '?')
      if (!shouldSendGuide(source)) return 'deny'
      return { deny: true, reply: msg(null, 'noApplication') }
    }
    // グループ会話：業務の内容は扱わない（既定）。業務システムに照会せず、固定の案内だけ（同じ会話には guideIntervalSeconds に 1 回）
    if (isGroupConversation(source) && groupChatPolicy(app.groupChat, cfg(config, 'groupChat', 'deny')) !== 'allow') {
      logger.info('bridge-identity: %s group conversation denied (business is handled in 1:1 chats only)', source?.platform ?? '?')
      if (!shouldSendGroupGuide(app, source)) return 'deny'
      return { deny: true, reply: msg(app, 'groupChat') }
    }
    try {
      const identity = await service.resolve(source)
      if (identity.linked) return 'allow'
      const help = await publicHelpReply(app, source, text)
      if (help) return { deny: true, reply: help }
      if (!shouldSendGuide(source)) return 'deny'
      return { deny: true, reply: guideFor(source) }
    } catch (error) {
      logger.warn('bridge-identity: identity lookup failed: %s', error?.message ?? error)
      if (!shouldSendGuide(source)) return 'deny'
      return { deny: true, reply: msg(app, 'unavailable') }
    }
  }

  /**
   * 未連携の発信者の質問への答え（D1）：アプリケーションの paths.publicHelp に聞き、見つかった最初の公開の節を【ご案内】の形で返す。
   * 連携コードの形・空の文・経路が無い・上限・見つからない・失敗のときは null（従来の案内に戻る）。
   */
  async function publicHelpReply(app, source, text) {
    const conf = cfg(config, 'publicHelp', {}) ?? {}
    // only an application that declares the capability (manifest help) is asked: the v1 path exists by default
    if (conf.enabled === false || !app?.paths?.publicHelp || !app.api || !app.manifest?.()?.help) return null
    const question = normalizeText(String(text ?? '')).trim()
    if (question.length < 2 || currentLinkRe().test(question)) return null
    if (!helpLimiter(conf).take(accountKey(source))) return null
    try {
      const res = await app.api.get(app.paths.publicHelp, { query: { q: question.slice(0, 200), limit: '1' } })
      const hit = res?.found ? (Array.isArray(res.results) ? res.results[0] : null) : null
      if (!hit?.title) return null
      const steps = (Array.isArray(hit.steps) ? hit.steps : []).filter((s) => typeof s === 'string').slice(0, 4)
      const lines = [
        `${HELP_LABEL}${hit.title}`,
        typeof hit.summary === 'string' ? hit.summary : '',
        ...steps.map((s, i) => `${i + 1}. ${s}`),
        typeof hit.url === 'string' && hit.url ? `こちらから開けます：${hit.url}` : '',
        typeof hit.manualUrl === 'string' && hit.manualUrl ? `くわしい手順：${hit.manualUrl}` : '',
        '',
        guideFor(source),
      ]
      guideSentAt.set(accountKey(source), Date.now())
      return frameAiText(lines.filter((l, i) => l !== '' || i === lines.length - 2).join('\n'), { signature: signatureOf(app.name, appNickname(app, undefined)) }).body
    } catch (error) {
      logger.info('bridge-identity: public help failed (%s)', error?.status ?? error?.message ?? error)
      return null
    }
  }
  let helpLimit = null
  function helpLimiter(conf) {
    const limit = Number(conf.perWindow ?? 10) || 10
    if (!helpLimit || helpLimit.limit !== limit) helpLimit = { limit, limiter: createRateLimiter({ limit, windowMs: 10 * 60_000 }) }
    return helpLimit.limiter
  }

  /** リンクの検査（dsh-im の setAnswerFilter）：AI の答えの URL を、そのアプリケーションの業務 Web の画面と許可したホストだけにする。 */
  const guards = new Map()
  const unguarded = new Set() // applications warned once: routes but no web URL
  function answerFilter({ source, text }) {
    const conf = cfg(config, 'linkGuard', {}) ?? {}
    if (conf.enabled === false || typeof text !== 'string') return text
    const app = service.application(source)
    if (!app) return text
    const base = (conf.webUrls ?? {})[app.id] || (app.default || app.id === defaultApp()?.id ? conf.webUrl : '') || ''
    const routes = app.manifest?.()?.web?.routes
    if (!base && Array.isArray(routes) && routes.length && !unguarded.has(app.id)) {
      // fail open (no URL = nothing to compare with), but say so once: write linkGuard.webUrls.<id> (webUrl: the default application only)
      unguarded.add(app.id)
      logger.warn('bridge-identity: link guard is off for application %s (no linkGuard.webUrls.%s / webUrl): its AI answers keep every link', app.id, app.id)
    }
    if (!base || !Array.isArray(routes) || !routes.length) return text
    const key = `${app.id}\u0001${base}\u0001${routes.length}\u0001${(conf.allowHosts ?? []).join(',')}`
    let guard = guards.get(app.id)
    if (!guard || guard.key !== key) { guard = { key, run: createLinkGuard({ base, routes, allowHosts: conf.allowHosts ?? [] }) }; guards.set(app.id, guard) }
    const { text: out, removed } = guard.run(text)
    if (removed.length) logger.info('bridge-identity: link guard removed %d link(s) the application does not have', removed.length)
    return out
  }

  async function handleLink({ text, source, reply }) {
    const match = currentLinkRe().exec(normalizeText(text))
    if (!match) return
    const app = service.application(source)
    if (isNotifyOnlySource(source)) {
      await reply(msg(app, 'emailNotLinkable'))
      return
    }
    if (source?.conversationKind && source.conversationKind !== 'direct') {
      await reply(msg(app, 'groupNotAllowed'))
      return
    }
    if (!app) {
      await reply(msg(null, 'noApplication'))
      return
    }
    if (!limiter.take(accountKey(source))) {
      await reply(msg(app, 'tooMany'))
      return
    }
    try {
      const res = await service.link(match[1], source)
      guideSentAt.delete(accountKey(source))
      const displayName = res.user?.displayName
      await reply(msg(app, 'linked', { displayName: displayName ? `${displayName} さんとして` : '' }))
    } catch (error) {
      const status = error instanceof BridgeApiError ? error.status : 0
      if (status === 404 || status === 410) await reply(msg(app, 'invalidCode'))
      else if (status === 409) await reply(msg(app, 'alreadyLinked'))
      else if (status === 429) await reply(msg(app, 'tooMany'))
      else if (status === 0) await reply(msg(app, 'unavailable'))
      else await reply(msg(app, 'failed'))
      logger.info('bridge-identity: link failed (%s %s)', status, error?.code ?? '')
    }
  }

  const disposers = []
  // 共用ボット（multiApp）の同じ窓口内のアプリケーション切り替え。共用ボットが無ければ何も変わらない（ルーターは null を返す）。
  const switching = installAppSwitch({
    registry,
    dshIm,
    identity: service,
    logger,
    replyWindowMs: Number(cfg(config, 'switchReplyWindowSeconds', 600)) * 1000,
    statePath: cfg(config, 'switchStatePath', '') || defaultSwitchStatePath(),
    words: cfg(config, 'switchWords', null) ?? undefined,
    messages: cfg(config, 'switchMessages', {}) ?? {},
    linkKeyword: () => keywords()[0],
  })
  disposers.push(() => switching.dispose())
  whenServices(ctx, ['bridgeApps'], (sub) => switching.attachSelector(sub.bridgeApps))
  if (typeof dshIm?.setAccessResolver === 'function') {
    disposers.push(toDisposer(dshIm.setAccessResolver(accessResolver)))
  } else {
    logger.warn('bridge-identity: ctx.dshIm.setAccessResolver is missing (the bridge fork of dsh-im is required); access control not installed')
  }
  if (typeof dshIm?.setAnswerFilter === 'function') {
    disposers.push(toDisposer(dshIm.setAnswerFilter(answerFilter)))
  } else {
    logger.warn('bridge-identity: ctx.dshIm.setAnswerFilter is missing (dsh-im older than the 2026-11-15 fix); AI answers are sent WITHOUT the link guard')
  }
  if (typeof dshIm?.claimReplies === 'function') {
    disposers.push(toDisposer(dshIm.claimReplies((text) => currentLinkRe().test(normalizeText(text)), handleLink)))
  } else {
    logger.warn('bridge-identity: ctx.dshIm.claimReplies is missing; link codes cannot be handled')
  }

  const defaultApp = () => registry().default?.() ?? registry().list?.()[0] ?? null
  const publicService = Object.freeze({
    version: 1,
    resolve: service.resolve,
    forSession: service.forSession,
    invalidate: service.invalidate,
    onUnlinked: service.onUnlinked,
    applicationOf: service.applicationOf,
    stats: service.stats,
    /** 共用ボットの「いまのアプリ」（共用ボットでなければ null）。 */
    currentApplication: (source) => switching.appSwitch.current(source)?.id ?? null,
    /** 既定のアプリケーションの接続表示（設定画面など）。 */
    api: Object.freeze({
      baseUrl: () => defaultApp()?.api.baseUrl() ?? '',
      hasServiceToken: () => Boolean(defaultApp()?.api.hasServiceToken()),
    }),
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, publicService)
  else ctx[SERVICE] = publicService

  // Web での本人解除（業務システムのイベント）→ 即時にキャッシュを消す。解除後の発言は未連携として拒否され、連携手順が案内される。
  // イベントの applicationId（bridge-events が付ける。無ければ既定のアプリケーション）のキャッシュだけを消す。
  const handleUnlinked = async (event) => {
    const payload = event?.payload ?? {}
    const removed = service.unlinked({ userId: payload.userId, platform: payload.platform, applicationId: event?.applicationId })
    // 案内の間隔も解除したアカウントの分は戻す（どのボット経由の記録かは問わない。消し過ぎても案内が 1 回増えるだけ）
    const suffixes = removed.filter(Boolean).map((source) => `\u0001${sourceKey(source)}`)
    for (const key of [...guideSentAt.keys()]) if (suffixes.some((s) => key.endsWith(s))) guideSentAt.delete(key)
    logger.info('bridge-identity: identity %s unlinked (user %s, %s); %d cached account(s) cleared',
      payload.identityId ?? '?', payload.userId ?? '?', payload.platform ?? '*', removed.length)
  }
  whenServices(ctx, ['bridgeEvents'], (sub) => sub.bridgeEvents.subscribe([UNLINKED_EVENT], handleUnlinked))

  onDispose(ctx, () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
  })

  return { service: publicService, accessResolver, handleLink, handleUnlinked, switching, answerFilter, publicHelpReply }
}
