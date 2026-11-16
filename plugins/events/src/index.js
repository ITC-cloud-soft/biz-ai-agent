import {
  DEFAULT_APPLICATION_ID, V1_PATHS, appPath, backoffDelay, cfg, fallbackRegistry, loadSchemastery, makeLogger, onDispose, openDomain,
  watchRegistry, whenServices,
} from '@dsh-bridge/dsh-core'

/**
 * bridge-events — 業務アプリケーションの outbox（Bridge プロトコル `GET /bridge/v1/events`）を取り込み、DSH 内の受け手に配る。
 *
 * 複数アプリケーション（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps）：アプリケーションごとに 1 本の取り込み（カーソル・
 * 処理数・dead letter もアプリケーションごと）。配る前にイベントへ `applicationId`（どの API から読んだか＝信頼できる値。
 * 業務システムが本文に書いた値は上書きする）を付ける。受け手（bridge-identity / bridge-notify / bridge-approvals）は
 * それでそのアプリケーションの API・ボットを使う。レジストリが無ければプラグイン設定（apiUrl / serviceToken）の 1 件。
 *
 * - カーソルは DSH のストレージサービス（domain `bridge_events` の global）に 1 件ごとに保存する。既定のアプリケーションは global の直下
 *   （cursor / processed / …）、他のアプリケーションは global.applications[<id>]。
 * - 少なくとも 1 回（at-least-once）：処理に成功したイベントまでしかカーソルを進めない。
 *   受け手（bridge-approvals の sendCard idempotencyKey、autoTasks.emit の dedupeKey）は冪等。
 *   dedupeKey は既定のアプリケーションは event.id、他は `<applicationId>:<event.id>`（イベント ID はアプリケーションごと）。
 * - 失敗は指数バックオフ。同じイベントが maxAttemptsPerEvent 回失敗したら dead letter に記録して先へ進む。
 * - approval.requested / approval.decided / approval.expired → subscribe した受け手（bridge-approvals）
 *   sns_identity.unlinked → subscribe した受け手（bridge-identity。キャッシュ即時破棄）
 *   通知イベント（設定 notifyEvents、および manifest が `events.<type>.notify` と宣言した種別）→ 通知の受け手（bridge-notify）に渡し、
 *     続けて autoTasks にも渡す。通知の受け手が未登録なら起動後 notifyGraceSeconds の間は失敗扱い（起動順の競合で取りこぼさない）、
 *     それ以降は通知を諦めて autoTasks だけに渡す（bridge-notify を入れない構成でイベントの流れを止めない）。
 *   それ以外 → ctx.autoTasks.emit(type, event, dedupeKey, { applicationId, eventId, matchUnscoped })。
 *   autoTasks が無ければログを残してスキップ（カーソルは進む）。
 * - manifest の playbooks（イベント起動のもの）を dsh-auto-tasks のタスクとしてデプロイする（ctx.autoTasks.deployPlaybooks。
 *   設定 deployPlaybooks、既定は全アプリケーション）。applicationId 付き・無効のまま（会話を結び付けてから有効にする）。
 */

export const name = 'bridge-events'
export const inject = ['storageDomain']
export const SERVICE = 'bridgeEvents'

export const APPROVAL_EVENT_TYPES = Object.freeze(['approval.requested', 'approval.decided', 'approval.expired'])
export const IDENTITY_EVENT_TYPES = Object.freeze(['sns_identity.unlinked'])
// プラグイン内部の受け手が必須のイベント（受け手が未登録なら失敗扱いで再試行。autoTasks には渡さない）
const ROUTED = new Map([
  ...APPROVAL_EVENT_TYPES.map((t) => [t, 'bridge-approvals']),
  ...IDENTITY_EVENT_TYPES.map((t) => [t, 'bridge-identity']),
])
export const DOMAIN = 'bridge_events'
const DEAD_LETTER_MAX = 20
export const MANIFEST_NOTIFY_MODES = Object.freeze(['all', 'others', 'none'])

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).description('イベントの取り込みを行う'),
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名'),
      pollIntervalSeconds: z.natural().min(1).default(5).description('取り込み間隔（秒）'),
      maxBackoffSeconds: z.natural().min(1).default(300).description('失敗時バックオフの上限（秒）'),
      batchSize: z.natural().min(1).max(500).default(100).description('1 回に読む件数'),
      maxAttemptsPerEvent: z.natural().min(1).default(8).description('同じイベントの処理を諦めるまでの試行回数'),
      notifyEvents: z.array(z.string()).default([]).description('通知の受け手（bridge-notify）に必ず渡すイベント種別（manifest の events.<type>.notify に加えて）'),
      manifestNotify: z.union(['all', 'others', 'none']).default('all')
        .description('manifest が通知すると宣言した種別（events.<type>.notify）を通知イベントとして扱う：all / others = 既定以外のアプリケーションだけ / none'),
      notifyGraceSeconds: z.natural().default(120)
        .description('起動後この秒数の間は、通知の受け手が未登録の通知イベントを失敗扱いにして再試行する（0 = 待たない）'),
      deployPlaybooks: z.union(['all', 'others', 'none']).default('all')
        .description('manifest の playbooks（イベント起動）を自動タスクとしてデプロイする：all / others = 既定以外のアプリケーション / none'),
      stateDomain: z.string().description(`カーソルを保存する DSH のストレージサービスの domain 名（既定 ${DOMAIN}）。別の名前で動いていた導入先の状態を引き継ぐときだけ変える`),
    })
  : undefined

export const INITIAL_STATE = Object.freeze({
  cursor: null,
  processed: 0,
  skipped: 0,
  deadLetters: [],
  lastSuccessAt: null,
  lastError: null,
  lastErrorAt: null,
})
const STATE_KEYS = Object.keys(INITIAL_STATE)

/** カーソルの domain 名（設定 stateDomain。既定 bridge_events）。 */
export function stateDomainName(config) {
  const value = String(cfg(config, 'stateDomain', '') || '').trim()
  return value || DOMAIN
}

/** レジストリ（bridge-apps）が無いときの 1 件：プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）、Bridge v1 の経路。 */
export function configRegistry(config, { logger } = {}) {
  return fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
}

/** メモリだけの状態ストア（ストレージサービスが開けないときの縮退）。 */
function memoryStore(initial) {
  let value = { ...initial }
  return { get: () => value, set: async (next) => { value = next }, persistent: false }
}

/**
 * domain.global（1 つ）をアプリケーションごとの状態ストアに分ける。既定のアプリケーションは直下のキー、
 * 他は applications[<id>]。書き込みはメモリの現在値を更新してから順番に保存する（並行する取り込みが上書きし合わない）。
 */
export function createStateStores(global, { defaultId = () => DEFAULT_APPLICATION_ID } = {}) {
  let current = { ...INITIAL_STATE, ...(global.get?.() ?? {}) }
  let chain = Promise.resolve()
  const persist = () => {
    const snapshot = current
    chain = chain.catch(() => {}).then(() => global.set(snapshot))
    return chain
  }
  const pickState = (obj) => Object.fromEntries(STATE_KEYS.map((k) => [k, obj?.[k] ?? INITIAL_STATE[k]]))
  return {
    persistent: global.persistent !== false,
    forApplication(applicationId) {
      const isDefault = () => applicationId === defaultId()
      return {
        persistent: global.persistent !== false,
        get: () => (isDefault() ? pickState(current) : { ...INITIAL_STATE, ...(current.applications?.[applicationId] ?? {}) }),
        set: async (next) => {
          const state = pickState(next)
          if (isDefault()) current = { ...current, ...state }
          else current = { ...current, applications: { ...(current.applications ?? {}), [applicationId]: state } }
          await persist()
        },
      }
    },
    snapshot: () => structuredClone(current),
  }
}

/**
 * ctx に依存しない取り込みエンジン（1 アプリケーション分）。
 * @param {object} deps
 * @param deps.api        業務 API クライアント（get(path, {query})）
 * @param deps.path       イベントの経路（既定は Bridge v1 の /bridge/v1/events）。関数なら呼び出しごとに評価
 * @param deps.store      { get(), set(state) }（domain.global 互換）
 * @param deps.dispatch   async (event) => void。throw で失敗扱い
 * @param deps.applicationId  イベントに付けるアプリケーション ID（null なら付けない：単体テスト・単一アプリケーションの呼び方）
 */
export function createEventPump({
  api,
  path = V1_PATHS.events,
  store,
  dispatch,
  applicationId = null,
  logger = console,
  batchSize = () => 100,
  intervalMs = () => 5_000,
  maxBackoffMs = () => 300_000,
  maxAttempts = () => 8,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  const attempts = new Map()
  const recent = new Set()
  const live = { running: false, consecutiveFailures: 0, lastPolledAt: null, nextPollAt: null, stopped: true }
  const where = applicationId ? ` [${applicationId}]` : ''
  let timer = null
  let inflight = null

  const iso = () => new Date(now()).toISOString()
  const state = () => ({ ...INITIAL_STATE, ...(store.get() ?? {}) })
  const eventsPath = () => (typeof path === 'function' ? path() : path)

  function remember(id) {
    recent.add(id)
    if (recent.size > 1000) recent.delete(recent.values().next().value)
  }

  async function save(patch) {
    await store.set({ ...state(), ...patch })
  }

  /** 1 回分の取り込み。戻り値: { fetched, more } */
  async function cycle() {
    live.running = true
    live.lastPolledAt = iso()
    try {
      const limit = batchSize()
      const res = await api.get(eventsPath(), { query: { after: state().cursor ?? undefined, limit } })
      const events = Array.isArray(res.events) ? res.events : []
      for (const raw of events) {
        if (!raw || raw.id === undefined || raw.id === null) continue
        // どの API から読んだか（信頼できる値）を付ける。本文の applicationId は信用しない。
        const event = applicationId ? { ...raw, applicationId } : raw
        const id = String(event.id)
        if (recent.has(id)) {
          await save({ cursor: event.id })
          continue
        }
        try {
          await dispatch(event)
          attempts.delete(id)
          remember(id)
          const s = state()
          await save({ cursor: event.id, processed: s.processed + 1, lastSuccessAt: iso() })
        } catch (error) {
          const count = (attempts.get(id) ?? 0) + 1
          attempts.set(id, count)
          const message = error instanceof Error ? error.message : String(error)
          if (count < maxAttempts()) {
            throw Object.assign(new Error(`event ${id} (${event.type}) failed [${count}/${maxAttempts()}]: ${message}`), { eventFailure: true })
          }
          attempts.delete(id)
          logger.error('bridge-events%s: giving up on event %s (%s) after %d attempts: %s', where, id, event.type, count, message)
          const s = state()
          const deadLetters = [...s.deadLetters, { id, type: event.type ?? null, error: message, at: iso() }].slice(-DEAD_LETTER_MAX)
          await save({ cursor: event.id, skipped: s.skipped + 1, deadLetters, lastError: message, lastErrorAt: iso() })
        }
      }
      if (events.length === 0 && res.nextAfter !== undefined && res.nextAfter !== null && res.nextAfter !== state().cursor) {
        await save({ cursor: res.nextAfter })
      }
      live.consecutiveFailures = 0
      return { fetched: events.length, more: events.length >= limit }
    } catch (error) {
      live.consecutiveFailures += 1
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('bridge-events%s: poll failed (%d in a row): %s', where, live.consecutiveFailures, message)
      try { await save({ lastError: message, lastErrorAt: iso() }) } catch { /* storage failure is logged by caller */ }
      throw error
    } finally {
      live.running = false
    }
  }

  function schedule(ms) {
    if (live.stopped) return
    if (timer) clearTimer(timer)
    live.nextPollAt = new Date(now() + ms).toISOString()
    timer = setTimer(tick, ms)
  }

  async function tick() {
    timer = null
    if (live.stopped) return
    let delay
    try {
      inflight = cycle()
      const { more } = await inflight
      delay = more ? 0 : intervalMs()
    } catch {
      delay = backoffDelay(live.consecutiveFailures, intervalMs(), maxBackoffMs())
    } finally {
      inflight = null
    }
    schedule(delay)
  }

  return {
    applicationId,
    cycle,
    start(delayMs = 0) {
      if (!live.stopped) return
      live.stopped = false
      schedule(delayMs)
    },
    async stop() {
      live.stopped = true
      if (timer) clearTimer(timer)
      timer = null
      live.nextPollAt = null
      if (inflight) await inflight.catch(() => {})
    },
    status: () => ({ ...state(), ...live, persistent: store.persistent !== false, pendingAttempts: attempts.size }),
  }
}

/** アプリケーションの manifest が通知イベントとして宣言した種別か（events.<type>.notify。internal / deprecated は除く）。 */
export function manifestNotifies(app, type) {
  try {
    const ev = app?.manifest?.()?.events?.[type]
    return Boolean(ev && ev.notify && !ev.internal && !ev.deprecated)
  } catch {
    return false
  }
}

/**
 * 受け手のレジストリ。approval.* / sns_identity.unlinked は受け手がいないと失敗扱い（起動順の競合で取りこぼさない）。
 * 通知イベントは通知の受け手が未登録なら notifyGraceMs の間だけ失敗扱い、その後は autoTasks のみ。
 * @param deps.registry       () => レジストリ（無ければ単一アプリケーション扱い：applicationId の無いイベントは既定のアプリケーション）
 * @param deps.notifyTypes    () => 通知イベントとして必ず扱う種別（設定 notifyEvents）
 * @param deps.manifestNotify () => 'all' | 'others' | 'none'（manifest の events.<type>.notify を通知イベントとして扱うか）
 */
export function createDispatcher({
  getAutoTasks, registry = () => null, logger = console, notifyGraceMs = () => 120_000, now = Date.now,
  notifyTypes = () => [], manifestNotify = () => 'all',
}) {
  const subscribers = new Set()
  const manifestNotifySubscribers = new Set() // manifest 由来の通知イベントの受け手
  const stats = { emitted: 0, skippedNoAutoTasks: 0, notified: 0, notifySkippedNoSubscriber: 0 }
  const startedAt = now()

  function applicationOf(event) {
    const reg = registry()
    const appId = event?.applicationId ? String(event.applicationId) : null
    const defaultId = reg?.default?.()?.id ?? DEFAULT_APPLICATION_ID
    const isDefault = !appId || appId === defaultId
    const app = appId ? reg?.get?.(appId) ?? null : reg?.default?.() ?? null
    return { appId, isDefault, app }
  }

  async function dispatch(event) {
    const type = String(event.type ?? '')
    const targets = [...subscribers].filter((s) => s.types.has(type) || s.types.has('*'))
    if (ROUTED.has(type)) {
      const routed = targets.filter((s) => s.types.has(type))
      if (routed.length === 0) throw new Error(`no subscriber for ${type} yet (is ${ROUTED.get(type)} loaded?)`)
      for (const s of routed) await s.handler(event)
      return
    }
    const { appId, isDefault, app } = applicationOf(event)
    const listed = new Set(notifyTypes() ?? []).has(type)
    const mode = MANIFEST_NOTIFY_MODES.includes(manifestNotify()) ? manifestNotify() : 'all'
    // manifest が通知すると宣言した種別は subscribeManifestNotify の受け手（bridge-notify）へ
    const viaManifest = !listed && mode !== 'none' && (mode === 'all' || !isDefault) && manifestNotifies(app, type)
    if (viaManifest) {
      // 同じ受け手（同じ handler）が種別でも購読していれば 1 回だけ渡す
      for (const s of manifestNotifySubscribers) if (!targets.some((t) => t === s || t.handler === s.handler)) targets.push(s)
    }
    if (listed || viaManifest) {
      const has = targets.some((s) => s.types.has(type) || (viaManifest && manifestNotifySubscribers.has(s)))
      if (!has) {
        if (now() - startedAt < notifyGraceMs()) throw new Error(`no subscriber for ${type} yet (is bridge-notify loaded?)`)
        stats.notifySkippedNoSubscriber += 1
        logger.warn('bridge-events: no notification subscriber (bridge-notify) is loaded; event %s (%s) is not notified', event.id, type)
      } else {
        stats.notified += 1
      }
    }
    for (const s of targets) await s.handler(event)
    const autoTasks = getAutoTasks()
    if (!autoTasks || typeof autoTasks.emit !== 'function') {
      stats.skippedNoAutoTasks += 1
      logger.info('bridge-events: ctx.autoTasks is not available; event %s (%s) not forwarded', event.id, type)
      return
    }
    // イベント ID はアプリケーションごとの連番なので、既定以外は dedupeKey にアプリケーションを前置する。
    // scope：applicationId の付いたタスクは同じアプリケーションのイベントだけ、付いていないタスク（profile のテンプレート）は
    // 既定のアプリケーションのイベントだけで起動する（matchUnscoped）。
    const dedupeKey = isDefault ? String(event.id) : `${appId}:${event.id}`
    if (appId) await autoTasks.emit(type, event, dedupeKey, { applicationId: appId, eventId: String(event.id), matchUnscoped: isDefault })
    else await autoTasks.emit(type, event, dedupeKey)
    stats.emitted += 1
  }

  return {
    dispatch,
    stats: () => ({ ...stats, subscribers: subscribers.size }),
    subscribe(types, handler) {
      const entry = { types: new Set(types), handler }
      subscribers.add(entry)
      return () => { subscribers.delete(entry) }
    },
    /** manifest が通知すると宣言した種別（events.<type>.notify）の受け手。 */
    subscribeManifestNotify(handler) {
      const entry = { types: new Set(), handler }
      manifestNotifySubscribers.add(entry)
      return () => { manifestNotifySubscribers.delete(entry) }
    },
  }
}

/**
 * manifest の playbooks → dsh-auto-tasks（ctx.autoTasks.deployPlaybooks）。manifest の版が変わったときだけ呼ぶ。
 * @param {Map<string, string>} deployed  applicationId → デプロイ済みの manifest の版
 * @returns 呼んだら deployPlaybooks の結果、呼ばなければ null
 */
export async function deployApplicationPlaybooks(autoTasks, app, deployed = new Map(), logger = console) {
  if (!autoTasks || typeof autoTasks.deployPlaybooks !== 'function' || !app) return null
  const manifest = app.manifest?.()
  const playbooks = manifest?.playbooks
  if (!playbooks || typeof playbooks !== 'object') return null
  const version = String(manifest.version ?? '')
  if (deployed.get(app.id) === version) return null
  const result = await autoTasks.deployPlaybooks(app.id, playbooks, { version, applicationName: app.name })
  deployed.set(app.id, version)
  logger.info('bridge-events: %s playbooks deployed (created %d, updated %d, skipped %d)', app.id,
    result?.created?.length ?? 0, result?.updated?.length ?? 0, result?.skipped?.length ?? 0)
  return result
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const defaultId = () => registry().default?.()?.id ?? DEFAULT_APPLICATION_ID
  let autoTasks = null
  whenServices(ctx, ['autoTasks'], (sub) => {
    autoTasks = sub.autoTasks
    return () => { autoTasks = null }
  })
  const dispatcher = createDispatcher({
    getAutoTasks: () => autoTasks,
    registry,
    logger,
    notifyGraceMs: () => Number(cfg(config, 'notifyGraceSeconds', 120)) * 1000,
    notifyTypes: () => {
      const list = cfg(config, 'notifyEvents', [])
      return Array.isArray(list) ? list.map(String) : []
    },
    manifestNotify: () => cfg(config, 'manifestNotify', 'all'),
  })

  let stores = null
  const pumps = new Map() // applicationId -> pump
  const deployed = new Map()
  let domain = null
  let disposed = false
  let syncTimer = null

  function pumpFor(applicationId) {
    if (pumps.has(applicationId)) return pumps.get(applicationId)
    // API・経路は呼び出しごとにレジストリから引く（bridge-apps の出現・設定変更に追随）
    const app = () => {
      const found = registry().get(applicationId)
      if (!found) throw new Error(`application ${applicationId} is no longer registered`)
      return found
    }
    const pump = createEventPump({
      api: { get: (path, opts) => app().api.get(path, opts) },
      path: () => appPath(app(), 'events'),
      store: stores.forApplication(applicationId),
      dispatch: dispatcher.dispatch,
      applicationId,
      logger,
      batchSize: () => Number(cfg(config, 'batchSize', 100)),
      intervalMs: () => Number(cfg(config, 'pollIntervalSeconds', 5)) * 1000,
      maxBackoffMs: () => Number(cfg(config, 'maxBackoffSeconds', 300)) * 1000,
      maxAttempts: () => Number(cfg(config, 'maxAttemptsPerEvent', 8)),
    })
    pumps.set(applicationId, pump)
    if (cfg(config, 'enabled', true) && !disposed) pump.start(Number(cfg(config, 'startDelayMs', 2000)))
    return pump
  }

  /** レジストリのアプリケーションと取り込みを揃える（増えたら始め、消えたら止める）。playbooks もデプロイする。 */
  async function sync() {
    if (!stores || disposed) return
    const ids = registry().ids?.() ?? []
    for (const id of ids) pumpFor(id)
    for (const [id, pump] of [...pumps]) {
      if (!ids.includes(id)) { pumps.delete(id); await pump.stop() }
    }
    const mode = cfg(config, 'deployPlaybooks', 'all')
    if (mode !== 'none' && autoTasks) {
      for (const app of registry().list?.() ?? []) {
        if (mode === 'others' && app.id === defaultId()) continue
        try { await deployApplicationPlaybooks(autoTasks, app, deployed, logger) } catch (error) {
          logger.warn('bridge-events: %s playbooks could not be deployed: %s', app.id, error?.message ?? error)
        }
      }
    }
  }

  const ready = (async () => {
    let global = memoryStore(INITIAL_STATE)
    try {
      domain = await openDomain(ctx, { name: stateDomainName(config), tables: [], global: { ...INITIAL_STATE } })
      global = domain.global
    } catch (error) {
      logger.error('bridge-events: DSH storage unavailable, cursor is kept in memory only: %s', error?.message ?? error)
    }
    stores = createStateStores(global, { defaultId })
    const defaultPump = pumpFor(defaultId())
    await sync().catch(() => {})
    const every = Math.max(5, Number(cfg(config, 'pollIntervalSeconds', 5))) * 1000
    if (!disposed) {
      syncTimer = setInterval(() => { sync().catch(() => {}) }, every)
      syncTimer.unref?.()
    }
    return defaultPump
  })()

  const statusOf = (pump) => (pump ? pump.status() : { ...INITIAL_STATE, running: false, persistent: false })
  const service = Object.freeze({
    version: 1,
    ready,
    subscribe: (types, handler) => dispatcher.subscribe(types, handler),
    subscribeManifestNotify: (handler) => dispatcher.subscribeManifestNotify(handler),
    status: () => {
      const applications = {}
      for (const [id, pump] of pumps) applications[id] = statusOf(pump)
      return {
        enabled: Boolean(cfg(config, 'enabled', true)),
        ...statusOf(pumps.get(defaultId())),
        applicationId: defaultId(),
        applications,
        dispatch: dispatcher.stats(),
        autoTasksAvailable: Boolean(autoTasks),
      }
    },
    /** 1 回取り込む（既定は既定のアプリケーション）。 */
    async pollNow(applicationId) {
      await ready
      await sync().catch(() => {})
      const id = applicationId ?? defaultId()
      if (!registry().has?.(id)) throw new Error(`unknown application ${id}`)
      return pumpFor(id).cycle()
    },
    /** 全アプリケーションを 1 回ずつ取り込む → { [applicationId]: { fetched, more } | { error } } */
    async pollAll() {
      await ready
      await sync().catch(() => {})
      const out = {}
      for (const id of registry().ids?.() ?? []) {
        try { out[id] = await pumpFor(id).cycle() } catch (error) { out[id] = { error: error?.message ?? String(error) } }
      }
      return out
    },
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, service)
  else ctx[SERVICE] = service

  onDispose(ctx, async () => {
    disposed = true
    if (syncTimer) clearInterval(syncTimer)
    await ready.catch(() => {})
    if (syncTimer) clearInterval(syncTimer)
    for (const pump of pumps.values()) await pump.stop()
    if (domain) await domain.close().catch(() => {})
  })
  return service
}
