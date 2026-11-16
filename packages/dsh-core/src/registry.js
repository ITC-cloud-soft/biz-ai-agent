// registry.js — 1 つの DSH が載せる業務アプリケーションのレジストリ（BRIDGE_ARCHITECTURE §15.2）。
//
//   applications: [{ id, name?, manifestUrl?, manifestFile?, apiUrl | apiUrlEnv, serviceToken | serviceTokenEnv,
//                    bots: [{ platform, botId, multiApp? }], agents?, delegation?, default?, namespace?, paths?, generateTools?,
//                    aliases?, groupChat?: 'deny' | 'allow' }]（groupChat：グループ会話で業務を扱うか。未指定はプラグインの設定・既定 deny）
//
// ボット → アプリケーションの対応は設定だけから決める（メッセージ本文は見ない）。1 つのボットは 1 つのアプリケーションにしか
// 属せない（重複は起動時エラー）。bots を書かない既定アプリケーションは「未割り当てのボット全部」を受ける（単一アプリケーションの
// 現行構成と同じ動作）。strict: true ならそれも無効にし、未割り当てのボットはどのアプリケーションにも属さない（拒否される）。
//
// 共用ボット（§15.2 の個人 WeChat。1 つの WeChat アカウントに 1 ボットしか持てない）：`{ platform: weixin, botId, multiApp: true }`
// と書いたボットだけは複数のアプリケーションに載せられる（載せる全アプリケーションで multiApp: true が必要。混在は起動時
// エラー）。共用ボットの会話のアプリケーションは (1) dsh-im が信頼できる発信元に付けた source.applicationId（会話ごとの
// 「いまのアプリ」・通知への返信。そのボットを載せたアプリケーションに限る）、(2) setApplicationSelector の選択、
// (3) そのボットの既定（レジストリの既定アプリケーションが載せていればそれ、無ければ登録順の最初）の順で決まる。
// MULTI_APP_PLATFORMS 以外での multiApp は起動時エラー：会話（DSH セッション）をアプリケーションごとに分けられない
// チャネルで身元だけが切り替わると、文脈が混ざるため（WeCom（企業微信）・Slack・LINE・Teams は 1 アプリケーション 1 ボット）。
import { createBusinessApi } from './api-client.js'
import { createDelegationCache } from './delegation.js'
import { createManifestHolder } from './manifest.js'
import { createAiProfileHolder } from './ai-profile.js'

/** Bridge v1 の経路（packages/protocol/openapi/bridge-v1.yaml）。 */
export const V1_PATHS = Object.freeze({
  identity: '/bridge/v1/identity',
  identityStats: '/bridge/v1/identities/stats',
  link: '/bridge/v1/identities/link',
  delegations: '/bridge/v1/delegations',
  manifest: '/bridge/v1/manifest',
  health: '/bridge/v1/health',
  events: '/bridge/v1/events',
  notificationRecipients: '/bridge/v1/notifications/for-event/{eventId}',
  notificationDeliveries: '/bridge/v1/notifications/deliveries',
  approvalDeliveries: '/bridge/v1/approvals/{approvalId}/deliveries',
  approvalDeliverySent: '/bridge/v1/approvals/{approvalId}/deliveries/{deliveryId}/sent',
  approvalDecision: '/bridge/v1/approvals/{approvalId}/im-decision',
  approvalDecisions: '/bridge/v1/approvals/im-decisions',
  assistantDelegations: '/bridge/v1/assistant/delegations',
  // 任意の機能（x-optional）：記憶（bridge-memory）に入れる前の個人情報の検査
  piiScan: '/bridge/v1/pii-scan',
  // 任意の機能：AI 社員のプロフィール（呼び名・口調・会社の紹介・性格・背景。docs/AI_EMPLOYEE_PROFILE.md）
  aiProfile: '/bridge/v1/ai-profile',
  // 任意の機能：AI 社員の外部連携（docs/AI_EMPLOYEE_PROFILE.md §3）。AI に渡す操作の一覧、読む操作の実行（本人の委託）、書く操作の提案
  connectorCatalog: '/bridge/v1/connectors/catalog',
  connectorRun: '/bridge/v1/connectors/{connectorId}/operations/{operationId}/run',
  connectorPropose: '/bridge/v1/proposals',
  // 任意の機能：AI が読むスキャンの文書（docs/DOCUMENT_READS.md）。ページの画像を受け取り（claim）、読んだ文字を返す。bridge-reader
  documentReads: '/bridge/v1/document-reads',
  documentReadResult: '/bridge/v1/document-reads/{readId}/result',
  // プロトコル v1 に報告時刻の照会は無い（時刻は manifest の reports.*.cron から取る）
  reportSettings: '',
  // システムの使い方（任意の機能。@dsh-bridge/help、server-kit の help）：検索と、未連携の発信者への公開の節（bridge-identity の publicHelp）
  helpSearch: '/bridge/v1/help/search',
  publicHelp: '/bridge/v1/help/public',
})

/**
 * 経路の profile（名前 → 経路表）。既定は 'v1' だけ。業務システムが v1 以外の経路（移行前の独自 API）を持つときは
 * registerPathProfile(name, paths) で登録し、レジストリで paths: <name> と書く（bridge-apps プラグインの pathProfiles 設定、
 * または互換 profile：compat/care-billing-paths の enableCareBillingPaths()）。
 */
const PATH_PROFILES = new Map([['v1', V1_PATHS]])
export function registerPathProfile(name, paths) {
  const key = String(name ?? '').trim()
  if (!key || !paths || typeof paths !== 'object') throw new TypeError('registerPathProfile(name, paths) needs a name and a paths object')
  PATH_PROFILES.set(key, Object.freeze({ ...paths }))
  return PATH_PROFILES.get(key)
}
export function pathProfile(name) {
  return PATH_PROFILES.get(String(name ?? '').trim()) ?? null
}
export function pathProfileNames() {
  return [...PATH_PROFILES.keys()]
}

/** 単一アプリケーションの互換レジストリ（fallbackRegistry / singleApplicationRegistry）で id を省いたときの ID。 */
export const DEFAULT_APPLICATION_ID = 'default'
/** 同じ窓口内でアプリケーションを切り替えられる（dsh-im が会話をアプリケーションごとのセッションに分ける）プラットフォーム。 */
export const MULTI_APP_PLATFORMS = Object.freeze(['weixin'])
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/
const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,30}$/

function str(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function readValue(value) {
  try {
    if (typeof value === 'function') return value()
    if (value && typeof value === 'object' && typeof value.get === 'function') return value.get()
    return value
  } catch {
    return undefined
  }
}

function envValue(name) {
  return name ? process.env[String(name)] : undefined
}

/** 設定 1 件 → 正規化した定義（API クライアントや manifest はまだ作らない）。不正なら例外。 */
export function normalizeApplication(raw, index = 0) {
  if (!raw || typeof raw !== 'object') throw new TypeError(`applications[${index}] must be an object`)
  const id = str(raw.id)
  if (!ID_RE.test(id)) throw new TypeError(`applications[${index}].id must match ${ID_RE} (got ${JSON.stringify(raw.id)})`)
  const bots = []
  if (raw.bots !== undefined && raw.bots !== null) {
    if (!Array.isArray(raw.bots)) throw new TypeError(`applications[${index}] (${id}).bots must be an array`)
    raw.bots.forEach((bot, i) => {
      const platform = str(bot?.platform)
      const botId = str(bot?.botId)
      if (!platform || !botId) throw new TypeError(`applications[${index}] (${id}).bots[${i}] needs platform and botId`)
      const multiApp = bot?.multiApp === true
      if (multiApp && !MULTI_APP_PLATFORMS.includes(platform)) {
        throw new TypeError(`applications[${index}] (${id}).bots[${i}]: multiApp is only supported on ${MULTI_APP_PLATFORMS.join(', ')} (got ${platform}); give each application its own ${platform} bot`)
      }
      bots.push(Object.freeze(multiApp ? { platform, botId, multiApp: true } : { platform, botId }))
    })
  }
  const namespace = str(raw.namespace) || id.replace(/-/g, '_')
  if (!NAMESPACE_RE.test(namespace)) throw new TypeError(`applications[${index}] (${id}).namespace must match ${NAMESPACE_RE}`)
  let paths
  const profileOf = (name) => {
    const found = pathProfile(name)
    if (!found) throw new TypeError(`applications[${index}] (${id}).paths: unknown path profile "${name}" (known: ${pathProfileNames().join(', ')})`)
    return found
  }
  if (raw.paths === undefined || raw.paths === null || raw.paths === '') paths = { ...V1_PATHS }
  else if (typeof raw.paths === 'string') paths = { ...profileOf(raw.paths) }
  else if (typeof raw.paths === 'object') {
    const base = raw.paths.base
    const basePaths = base === undefined || base === null || base === '' ? V1_PATHS : typeof base === 'object' ? base : profileOf(base)
    paths = { ...basePaths, ...raw.paths }
  } else throw new TypeError(`applications[${index}] (${id}).paths must be a path profile name ('v1', ...) or an object`)
  delete paths.base
  return {
    id,
    name: str(raw.name) || id,
    label: str(raw.label) || `${id} API`,
    namespace,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(str).filter(Boolean) : [],
    bots,
    botsConfigured: Array.isArray(raw.bots) && raw.bots.length > 0,
    default: raw.default === true,
    agents: Array.isArray(raw.agents) ? [...raw.agents] : [],
    delegation: raw.delegation && typeof raw.delegation === 'object' ? { ...raw.delegation } : {},
    generateTools: raw.generateTools === true,
    messages: raw.messages && typeof raw.messages === 'object' ? { ...raw.messages } : {},
    groupChat: raw.groupChat === 'allow' || raw.groupChat === 'deny' ? raw.groupChat : null,
    paths: Object.freeze(paths),
    manifestUrl: str(raw.manifestUrl),
    manifestFile: str(raw.manifestFile),
    manifest: raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : null,
    aiProfile: raw.aiProfile && typeof raw.aiProfile === 'object' && !Array.isArray(raw.aiProfile) ? raw.aiProfile : null,
    timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs),
    toolTimeoutMs: raw.toolTimeoutMs === undefined ? undefined : Number(raw.toolTimeoutMs),
    retries: raw.retries === undefined ? undefined : Number(raw.retries),
    protocol: raw.protocol === undefined ? undefined : raw.protocol,
    raw,
  }
}

/**
 * アプリケーション（実体）。API クライアント・manifest 保持者・委託方針を持つ。
 * apiUrl / serviceToken は呼び出しごとに評価する（設定値・関数・Volatile、または *Env の環境変数名）。
 */
function buildApplication(def, { fetch, logger, now, baseDir, defaults = {} }) {
  // *Env（環境変数名）が設定されていて値があればそれ、無ければ apiUrl / serviceToken の値、さらに無ければ互換の既定値
  const apiUrl = () => str(envValue(def.raw.apiUrlEnv)) || str(readValue(def.raw.apiUrl)) || str(defaults.apiUrl?.())
  const serviceToken = () => str(envValue(def.raw.serviceTokenEnv)) || str(readValue(def.raw.serviceToken)) || str(defaults.serviceToken?.())
  const api = createBusinessApi({
    applicationId: def.id,
    label: def.label,
    baseUrl: apiUrl,
    serviceToken,
    // 他のアプリケーションへ互換の環境変数の値が漏れないよう、既定値は明示（空）。互換の単一アプリケーションだけ defaults を持つ。
    defaultBaseUrl: defaults.baseUrl ?? '',
    defaultServiceToken: '',
    timeoutMs: def.timeoutMs,
    retries: def.retries,
    protocol: def.protocol,
    fetch,
  })
  // 業務ツールの呼び出し用（長い集計でも切らない程度に長く取る）
  const toolApi = createBusinessApi({
    applicationId: def.id,
    label: def.label,
    baseUrl: apiUrl,
    serviceToken,
    defaultBaseUrl: defaults.baseUrl ?? '',
    defaultServiceToken: '',
    timeoutMs: def.toolTimeoutMs ?? 120_000,
    retries: 0,
    protocol: def.protocol,
    fetch,
  })
  const manifest = createManifestHolder({
    applicationId: def.id,
    api,
    manifestUrl: def.manifestUrl,
    manifestFile: def.manifestFile,
    manifest: def.manifest,
    baseDir,
    now,
    logger,
  })
  // AI 社員のプロフィール（paths.aiProfile があれば GET。etag / 304。失敗しても前の値。ai-profile.js）
  const aiProfile = createAiProfileHolder({ applicationId: def.id, api, path: def.paths.aiProfile ?? '', profile: def.aiProfile, now, logger })
  const app = {
    id: def.id,
    name: def.name,
    label: def.label,
    namespace: def.namespace,
    /** 共用ボットでの切り替え名（「#点検」の 点検 など。name・id に加えて受け付ける） */
    aliases: Object.freeze([...def.aliases]),
    bots: Object.freeze([...def.bots]),
    agents: Object.freeze([...def.agents]),
    delegation: Object.freeze({ ...def.delegation }),
    generateTools: def.generateTools,
    messages: Object.freeze({ ...def.messages }),
    /** グループ会話（1:1 でない会話）で業務を扱うか：'deny' | 'allow' | null（プラグインの設定に任せる。既定 deny） */
    groupChat: def.groupChat,
    paths: def.paths,
    default: false,
    catchAll: false,
    api,
    toolApi,
    apiUrl: () => api.baseUrl(),
    hasServiceToken: () => api.hasServiceToken(),
    manifest: () => manifest.get(),
    manifestInfo: () => manifest.info(),
    refreshManifest: () => manifest.refresh(),
    ensureManifest: () => manifest.ensure(),
    /** AI 社員のプロフィール（同期：最後に取れたもの or null。呼び名は nicknameOf(app.aiProfile(), agentId)） */
    aiProfile: () => aiProfile.get(),
    aiProfileInfo: () => aiProfile.info(),
    refreshAiProfile: () => aiProfile.refresh(),
    ensureAiProfile: () => aiProfile.ensure(),
    /** 一度は取りに行った（経路が無いときも true）：会話の system prompt を固定してよい */
    aiProfileSettled: () => aiProfile.settled(),
    /**
     * 自動タスク（IM 発信者なし）の委託方針：{ policy: 'deny' | 'delegate', onBehalfOf: source | null, delegates: { <class>: source | 'each' } }
     * （delegates は playbook の委託の分類ごとの職員。unattendedDelegates）
     */
    unattended() {
      const d = def.delegation
      const policy = readValue(d.unattendedPolicy) === 'delegate' ? 'delegate' : 'deny'
      const delegates = policy === 'delegate' ? readValue(d.unattendedDelegates) : null
      return {
        policy,
        onBehalfOf: policy === 'delegate' ? readValue(d.unattendedOnBehalfOf) ?? null : null,
        delegates: delegates && typeof delegates === 'object' && !Array.isArray(delegates) ? { ...delegates } : {},
      }
    },
    describe() {
      return {
        id: def.id,
        name: def.name,
        namespace: def.namespace,
        aliases: [...def.aliases],
        default: app.default,
        catchAll: app.catchAll,
        bots: def.bots.map((b) => ({ ...b })),
        agents: [...def.agents],
        apiUrl: api.baseUrl(),
        hasServiceToken: api.hasServiceToken(),
        manifest: manifest.info(),
        aiProfile: aiProfile.info(),
      }
    },
  }
  return app
}

/**
 * @param {object} options
 * @param {Array<object>} options.applications
 * @param {boolean} [options.strict]       未割り当てのボットを既定アプリケーションに回さない
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.baseDir]       manifestFile の相対パスの基準
 * @param {object} [options.delegations]   共有する委託トークンキャッシュ（既定は新規）
 */
export function createApplicationRegistry({ applications = [], strict = false, fetch, logger = console, now = Date.now, baseDir, delegations } = {}) {
  const list = Array.isArray(applications) ? applications : []
  const defs = list.map((raw, i) => normalizeApplication(raw, i))
  const seen = new Set()
  for (const def of defs) {
    if (seen.has(def.id)) throw new TypeError(`application "${def.id}" is registered twice`)
    seen.add(def.id)
  }
  const botOwners = new Map() // platform\0botId -> { ids: [app id, ...], multiApp }
  for (const def of defs) {
    for (const bot of def.bots) {
      const key = `${bot.platform}\u0000${bot.botId}`
      const entry = botOwners.get(key)
      if (!entry) {
        botOwners.set(key, { ids: [def.id], multiApp: bot.multiApp === true })
        continue
      }
      if (entry.ids.includes(def.id)) continue
      if (!entry.multiApp || bot.multiApp !== true) {
        throw new TypeError(`bot ${bot.platform}/${bot.botId} is assigned to both "${entry.ids[0]}" and "${def.id}"`
          + (entry.multiApp || bot.multiApp ? ' (a shared bot needs multiApp: true in every application that lists it)' : ''))
      }
      entry.ids.push(def.id)
    }
  }
  const defaults_ = defs.filter((d) => d.default)
  if (defaults_.length > 1) throw new TypeError(`more than one default application: ${defaults_.map((d) => d.id).join(', ')}`)
  const apps = new Map()
  for (const def of defs) apps.set(def.id, buildApplication(def, { fetch, logger, now, baseDir, defaults: def.raw.__defaults ?? {} }))
  const defaultId = defaults_[0]?.id ?? (defs.length === 1 ? defs[0].id : null)
  const defaultApp = defaultId ? apps.get(defaultId) : null
  if (defaultApp) defaultApp.default = true
  const catchAll = !strict && defaultApp && !defs.find((d) => d.id === defaultId).botsConfigured ? defaultApp : null
  if (catchAll) catchAll.catchAll = true
  const cache = delegations ?? createDelegationCache({ now })

  let selectors = [] // 共用ボットの会話ごとの選択（後に登録したものが優先）

  function ownersOf(input) {
    const platform = str(input?.platform)
    const botId = str(input?.botId)
    if (!platform || !botId) return null
    return botOwners.get(`${platform}\u0000${botId}`) ?? null
  }

  /** 共用ボットの既定：レジストリの既定アプリケーションが載せていればそれ、無ければ登録順の最初。 */
  function sharedDefault(owner) {
    if (defaultId && owner.ids.includes(defaultId)) return defaultId
    return owner.ids[0]
  }

  /**
   * ボット → アプリケーション。信頼できる値（dsh-im の ImSource の platform / botId、または設定）だけを渡すこと。
   * 共用ボット（multiApp）だけは source.applicationId（dsh-im が会話の選択から付けた値）→ selector → 既定 の順。
   * どの値も、そのボットを載せたアプリケーションでなければ無視する（他のボットの値・本文で別のアプリケーションへは行けない）。
   * @returns application | null
   */
  function resolveApplication(input) {
    const owner = ownersOf(input)
    if (!owner) return catchAll
    if (!owner.multiApp) return apps.get(owner.ids[0])
    const claimed = str(input?.applicationId)
    if (claimed && owner.ids.includes(claimed)) return apps.get(claimed)
    for (const selector of [...selectors].reverse()) {
      let chosen = null
      try { chosen = str(selector(input)) } catch { chosen = null }
      if (chosen && owner.ids.includes(chosen)) return apps.get(chosen)
    }
    return apps.get(sharedDefault(owner))
  }

  /** そのボットが載せるアプリケーション（共用ボットは登録順の全部、それ以外は 0〜1 件）。 */
  function applicationsForBot(input) {
    const owner = ownersOf(input)
    if (!owner) return catchAll ? [catchAll] : []
    return owner.ids.map((id) => apps.get(id))
  }

  /** 同じ窓口内でアプリケーションを切り替えるボット（multiApp: true）か。 */
  function isMultiAppBot(input) {
    return ownersOf(input)?.multiApp === true
  }

  /** 共用ボットの既定のアプリケーション（共用ボットでなければ null）。 */
  function sharedDefaultApplication(input) {
    const owner = ownersOf(input)
    return owner?.multiApp ? apps.get(sharedDefault(owner)) : null
  }

  /**
   * 共用ボットの会話ごとの選択を登録する（@dsh-bridge/plugin-identity の窓口内切り替え）。fn(source) → applicationId | null。
   * 返り値は登録解除の関数（初回 true）。
   */
  function setApplicationSelector(fn) {
    if (typeof fn !== 'function') throw new TypeError('application selector must be a function')
    selectors = [...selectors, fn]
    let active = true
    return () => {
      if (!active) return false
      active = false
      selectors = selectors.filter((s) => s !== fn)
      return true
    }
  }

  return {
    size: () => apps.size,
    list: () => [...apps.values()],
    ids: () => [...apps.keys()],
    get: (id) => (id === undefined || id === null ? null : apps.get(String(id)) ?? null),
    has: (id) => apps.has(String(id)),
    default: () => defaultApp,
    resolveApplication,
    applicationsForBot,
    isMultiAppBot,
    sharedDefaultApplication,
    setApplicationSelector,
    /** 共用ボットの一覧 [{ platform, botId, applications: [id, ...] }] */
    sharedBots: () => [...botOwners.entries()].filter(([, o]) => o.multiApp).map(([key, o]) => {
      const [platform, botId] = key.split('\u0000')
      return { platform, botId, applications: [...o.ids] }
    }),
    /** 全アプリケーションの manifest を取り直す（失敗は各 info().lastError）。 */
    async refreshManifests() {
      return Promise.all([...apps.values()].map((app) => app.refreshManifest().catch(() => null)))
    },
    async ensureManifests() {
      return Promise.all([...apps.values()].map((app) => app.ensureManifest().catch(() => null)))
    },
    /** 全アプリケーションの AI 社員のプロフィールを取り直す（失敗は各 aiProfileInfo().lastError、前の値のまま）。 */
    async refreshAiProfiles() {
      return Promise.all([...apps.values()].map((app) => app.refreshAiProfile().catch(() => null)))
    },
    delegations: cache,
    strict: Boolean(strict),
    describe: () => [...apps.values()].map((app) => app.describe()),
  }
}

/**
 * 単一アプリケーションのレジストリ（bridgeApps サービスが無い環境：単体テスト・レジストリを書かない小さな profile）。
 * プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）を優先し、空なら envFallback の環境変数、さらに defaultBaseUrl。
 *
 *   fallbackRegistry({ id: 'equipment-inspection', apiUrl: () => config.apiUrl,
 *                      envFallback: { apiUrl: 'INSPECTION_API_URL', serviceToken: 'INSPECTION_SERVICE_TOKEN' } })
 *
 * ケアビリングの旧来の構成（CARE_API_URL / CARE_SERVICE_TOKEN・/api/ai/* の経路）は compat/care-billing-paths の
 * careBillingRegistry()（旧 legacyRegistry）。
 * @param {object} options
 * @param {string} [options.id]            既定 DEFAULT_APPLICATION_ID（'default'）
 * @param {string|object} [options.paths]  path profile 名か経路表（既定 'v1'）
 * @param {{apiUrl?: string, serviceToken?: string}} [options.envFallback]  環境変数名（値が空なら使わない）
 * @param {string} [options.defaultBaseUrl]  URL がどこにも無いときの base URL（既定 ''：未設定エラー）
 */
export function fallbackRegistry({
  id = DEFAULT_APPLICATION_ID, name, label, namespace, paths = 'v1', apiUrl = () => '', serviceToken = () => '',
  envFallback = {}, defaultBaseUrl = '', protocol, fetch, logger, now, delegations, messages, delegation,
} = {}) {
  return createApplicationRegistry({
    applications: [{
      id,
      name: name ?? id,
      label: label ?? `${id} API`,
      ...(namespace ? { namespace } : {}),
      paths,
      apiUrl,
      serviceToken,
      ...(protocol !== undefined ? { protocol } : {}),
      ...(messages ? { messages } : {}),
      ...(delegation ? { delegation } : {}),
      __defaults: {
        apiUrl: () => (envFallback.apiUrl ? process.env[envFallback.apiUrl] || '' : ''),
        serviceToken: () => (envFallback.serviceToken ? process.env[envFallback.serviceToken] || '' : ''),
        baseUrl: defaultBaseUrl,
      },
    }],
    fetch,
    logger,
    now,
    delegations,
  })
}
