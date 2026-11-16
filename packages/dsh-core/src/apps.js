// apps.js — プラグイン（@dsh-bridge/plugin-events / -notify / -approvals / -assistant）が共通で使う、
// アプリケーション単位のヘルパー。
//
//   appPath(app, key, params)        レジストリの paths（v1 か登録した path profile）から経路を作る（{eventId} などを埋める）
//   singleApplicationRegistry(api)   API クライアント 1 つを 1 件だけのレジストリに見せる（単体テスト・api を直接渡す呼び出し方）
//   registryGetter / applicationOfEvent / scopedKey
//   createBotResolver                アプリケーションの送信ボット（プラットフォームごと）。他のアプリケーションのボットは使わない
import { BridgeApiError } from './api-client.js'
import { DEFAULT_APPLICATION_ID, V1_PATHS } from './registry.js'

/**
 * アプリケーションの経路。paths[key] が無い（そのプロトコル・業務システムに無い）ときは BridgeApiError（kind 'request'、
 * code 'path_unsupported'）。params の値は encodeURIComponent して {name} に入れる。
 */
export function appPath(app, key, params = {}) {
  const template = app?.paths?.[key]
  if (!template) {
    throw new BridgeApiError(`${app?.label ?? 'business API'}: "${key}" is not available for application "${app?.id ?? '?'}"`, {
      kind: 'request', code: 'path_unsupported', applicationId: app?.id ?? null,
    })
  }
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
    const value = params?.[name]
    if (value === undefined || value === null || value === '') {
      throw new BridgeApiError(`${key}: "${name}" is required`, { kind: 'request', code: 'path_param_missing', applicationId: app?.id ?? null })
    }
    return encodeURIComponent(String(value))
  })
}

/** その経路があるか（v1 に報告時刻の照会が無い等）。 */
export function hasPath(app, key) {
  return Boolean(app?.paths?.[key])
}

/**
 * API クライアント 1 つ（createBusinessApi）を 1 件だけのレジストリのように見せる。
 * 単体テストや、プラグインに直接 api を渡す呼び出し方（createNotifier({ api }) など）で使う。全ボットがこのアプリケーション。
 * 既定は id 'default'・v1 の経路。ケアビリングの旧来の既定（care-billing / care / /api/ai/*）は
 * compat/care-billing-paths の careBillingSingleApplicationRegistry。
 */
export function singleApplicationRegistry(api, {
  id = DEFAULT_APPLICATION_ID, name = id, label = 'business API', namespace = String(id).replace(/-/g, '_'), paths = V1_PATHS,
} = {}) {
  const app = Object.freeze({
    id, name, label, namespace,
    bots: Object.freeze([]),
    agents: Object.freeze([]),
    delegation: Object.freeze({}),
    messages: Object.freeze({}),
    paths: Object.freeze({ ...paths }),
    default: true,
    catchAll: true,
    api,
    toolApi: api,
    apiUrl: () => (typeof api?.baseUrl === 'function' ? api.baseUrl() : ''),
    hasServiceToken: () => (typeof api?.hasServiceToken === 'function' ? api.hasServiceToken() : false),
    manifest: () => null,
    unattended: () => ({ policy: 'deny', onBehalfOf: null, delegates: {} }),
  })
  return Object.freeze({
    size: () => 1,
    list: () => [app],
    ids: () => [id],
    get: (x) => (x !== undefined && x !== null && String(x) === id ? app : null),
    has: (x) => String(x) === id,
    default: () => app,
    resolveApplication: () => app,
    strict: false,
    describe: () => [{ id, name, default: true, catchAll: true }],
  })
}

/** registry（値）または () => registry → () => registry。 */
export function registryGetter(registry) {
  return typeof registry === 'function' ? registry : () => registry
}

/**
 * イベントのアプリケーション。plugin-events が取り込んだアプリケーションの ID を event.applicationId に付ける（信頼できる値：
 * どの API から読んだか）。無いイベント（単一アプリケーション時代の呼び出し）は既定のアプリケーション。レジストリに無ければ null。
 */
export function applicationOfEvent(registry, event) {
  const reg = typeof registry === 'function' ? registry() : registry
  if (!reg) return null
  const id = event?.applicationId
  if (id === undefined || id === null || id === '') return reg.default?.() ?? null
  return reg.get?.(String(id)) ?? null
}

/**
 * 保存キー。既定のアプリケーションは従来どおりのキー（再起動前のデータ・冪等キーと互換）、それ以外は `<applicationId>|<key>`。
 */
export function scopedKey(applicationId, defaultApplicationId, key) {
  if (!applicationId || applicationId === defaultApplicationId) return String(key)
  return `${applicationId}|${key}`
}

const platformOfBot = (b) => String(b?.channel ?? b?.platform ?? b?.type ?? '')
const idOfBot = (b) => {
  const id = b?.botId ?? b?.id
  return id === undefined || id === null || id === '' ? null : String(id)
}

/**
 * アプリケーションの送信ボット（プラットフォームごと）。
 *   1. preferred（連携の botId：個人ボット・連携に使ったボット）。そのボットがこのアプリケーションのものなら
 *   2. configured[platform]（プラグイン設定。そのアプリケーションの分）
 *   3. レジストリのこのアプリケーションの bots（プラットフォームが一致する最初のもの）
 *   4. dshIm.listBots() のうちプラットフォームが一致し、レジストリでこのアプリケーションに解決されるもの（既定のアプリケーションは未割り当てのボット全部）
 * 「このアプリケーションのもの」= registry.applicationsForBot({platform, botId}) に含まれる（共用ボット multiApp なら
 * shared: true）。applicationsForBot の無いレジストリでは resolveApplication({platform, botId}) がこのアプリケーション。
 * @returns {Promise<{botId: string, shared: boolean} | null>}
 */
export function createBotResolver({ dshIm, registry, logger = console, label = 'bridge' }) {
  const getRegistry = registryGetter(registry)
  const cache = new Map()

  function serves(app, platform, botId) {
    const reg = getRegistry()
    if (!reg) return { ok: true, shared: false }
    // 共用ボット（レジストリの multiApp: true。個人 WeChat）：そのボットが載せるアプリケーションに含まれていればよい
    if (typeof reg.applicationsForBot === 'function') {
      try {
        const list = reg.applicationsForBot({ platform, botId }) ?? []
        const shared = typeof reg.isMultiAppBot === 'function' ? Boolean(reg.isMultiAppBot({ platform, botId })) : list.length > 1
        return { ok: list.some((a) => a?.id === app.id), shared }
      } catch { /* fall back to the bot table */ }
    }
    const owner = typeof reg.resolveApplication === 'function' ? reg.resolveApplication({ platform, botId }) : null
    return { ok: Boolean(owner) && owner.id === app.id, shared: false }
  }

  async function listBots() {
    if (typeof dshIm?.listBots !== 'function') return []
    const list = await dshIm.listBots()
    return Array.isArray(list) ? list : (Array.isArray(list?.bots) ? list.bots : [])
  }

  async function resolve(app, platform, { preferred, configured } = {}) {
    if (!app || !platform) return null
    const plat = String(platform)
    if (preferred) {
      const s = serves(app, plat, String(preferred))
      if (s.ok) return { botId: String(preferred), shared: s.shared }
    }
    const fixed = configured && typeof configured === 'object' ? configured[plat] : null
    if (fixed) return { botId: String(fixed), shared: false }
    const own = (app.bots ?? []).find((b) => b.platform === plat)
    if (own) return { botId: String(own.botId), shared: own.multiApp === true }
    const key = `${app.id}\u0001${plat}`
    if (cache.has(key)) return cache.get(key)
    let found = null
    try {
      for (const bot of await listBots()) {
        const id = idOfBot(bot)
        if (!id || platformOfBot(bot) !== plat) continue
        const s = serves(app, plat, id)
        if (s.ok) { found = { botId: id, shared: s.shared }; break }
      }
    } catch (error) {
      logger.warn?.('%s: listBots failed: %s', label, error?.message ?? error)
    }
    if (found) cache.set(key, found)
    return found
  }

  return { resolve, forget: () => cache.clear() }
}
