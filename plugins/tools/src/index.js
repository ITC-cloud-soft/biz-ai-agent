import { createRequire } from 'node:module'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONNECTOR_REFRESH_SECONDS, DEFAULT_APPLICATION_ID, DEFAULT_DENY_HINTS, autoTaskRunResolver, createConnectorCatalogHolder, groupChatPolicy, autoTaskSessionChecker, cfg, fallbackRegistry, createDelegationGate, createToolRequester,
  currentPrincipal, defineTool, guardTool, inNamespace, loadSchemastery, makeLogger, manifestTools, onDispose, sessionIdOf, watchRegistry,
  whenServices,
} from '@dsh-bridge/dsh-core'
import { args, defineProposeTool, PROPOSALS_PATH } from './propose.js'
import { connectorTools } from './connectors.js'

/**
 * bridge-tools — 業務ツール（DSH の AI 社員が使う HTTP ツール）の汎用プラグイン。
 *
 * 決まり：このプラグインは業務の状態を変えない。業務 API の GET と、人が業務 Web で採択するまで何も変わらない「提案」の POST だけ。
 * 権限・承認・金額・監査は業務システムが持つ。読み取りツールは GET しか呼べない（@dsh-bridge/dsh-core の tools-sdk が強制）。
 *
 * アプリケーションごと（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps。無ければプラグイン設定 apiUrl / serviceToken の 1 件）に：
 *   - 委託 gate（呼び出しごとの認可）：IM 発信者（bridge-identity の forSession）→ 連携済み職員 → 委託トークン（アプリケーションごと）。
 *     業務 Web の AI アシスタント（bridge-assistant）の会話は本人の委託だけ。定時報告（bridge-notify の aiReportOwner と
 *     dsh-proactive の business モードの起動）は本人の委託で読み取りだけ。自動タスク（unattended）は設定した職員の委託で
 *     （playbook の委託の分類 source.delegation ごとの職員 unattendedDelegates、無ければ unattendedOnBehalfOf。`<class>=each` は
 *     いま動いている回の起動事件の本人に業務システムが発行する委託）、その会話に登録されたタスクの source.tools に挙がった提案だけ。未連携・発信元なしは既定で拒否（unlinkedPolicy で ai-readonly）。
 *     グループ会話（1:1 でない IM 会話）は既定で拒否（groupChat: allow で発言者本人の委託。答えが他のメンバーに見えるため）。
 *   - manifest の tools（access: read の GET / open）から読み取りツールを生成する。
 *   - 外部連携（業務システムの paths.connectorCatalog の一覧。docs/AI_EMPLOYEE_PROFILE.md §3）から `<namespace>_ext_<接続先>_<操作>` を生成する：
 *     読む操作は本人の委託で業務システムに実行させる（許可リストの項目だけ返る）、書く操作は提案だけ（人が承認してから業務システムが実行）。
 *   - 手書きのツール（提案ツールなど）：toolModules（パッケージ名・パス）か、別のプラグインから ctx.bridgeTools.register(appId, factory)。
 *     ツール名はアプリケーションの名前空間（`<namespace>_*`）の中だけ。
 * 委託トークンは発行したアプリケーションにしか送らない。ツール出力にも出さない。
 */

export const name = 'bridge-tools'
export const inject = ['tools']
export const SERVICE = 'bridgeTools'

const z = await loadSchemastery()
// 呼ぶたびに新しいスキーマ（default などを付けても他の場所に影響しない）
const policySchema = () => (z
  ? {
      unlinkedPolicy: z.union([z.const('deny'), z.const('ai-readonly')]).description('未連携・発信元なし（DSH Web の owner 会話など）のとき'),
      groupChat: z.union([z.const('deny'), z.const('allow')]).description('グループ会話（1:1 でない IM 会話）で業務ツールを使わせるか（既定 deny：答えが他のメンバーに見えるため）'),
      unattendedPolicy: z.union([z.const('deny'), z.const('delegate')]).description('自動タスクの会話（IM 発信者なし・auto-tasks に登録された会話だけ）のとき'),
      unattendedOnBehalfOf: z.object({
        platform: z.string().description('IM のプラットフォーム（line / slack など）'),
        userId: z.string().description('その職員の IM ユーザー ID（業務システムで連携済みであること）'),
        teamId: z.string().description('Slack 等のワークスペース ID（必要なプラットフォームのみ）'),
      }).description('unattendedPolicy=delegate のとき、自動タスクを誰の委託で実行するか（委託の分類の職員が無いときの既定）'),
      unattendedDelegates: z.dict(z.union([
        z.const('each'),
        z.object({
          platform: z.string().description('IM のプラットフォーム'),
          userId: z.string().description('その職員の IM ユーザー ID（業務システムで連携済みであること）'),
          teamId: z.string().description('Slack 等のワークスペース ID（必要なプラットフォームのみ）'),
        }),
      ])).description('unattendedPolicy=delegate のとき、playbook の委託の分類（source.delegation の <class>）ごとの職員。'
        + 'each は <class>=each の playbook に、起動事件の本人ごとの委託（業務システムが事件に対して発行）を許す（install.mjs --auto-task-delegate <class>=…）'),
      unattendedWarnRoles: z.array(z.string()).description('自動タスクの委託がこの役割の職員になったら一度だけ警告する（例：管理者。動作は止めない）'),
      unattendedDefaultTools: z.array(z.string()).description('source.tools を持つタスクが無い自動タスクの会話で許す提案ツール（既定なし）'),
      unattendedTools: z.array(z.string()).description('自動タスクで使ってよい提案ツールの上限（順番どおり。既定はそのアプリケーションの提案ツールすべて）'),
      toolKind: z.string().description('拒否の文言でのツールの呼び名（既定「<アプリ名> tools」）'),
      denyHints: z.object({
        linked: z.string().description('連携済みの職員の会話でない（未連携など）ときの案内'),
        noSender: z.string().description('IM の発信者がいない会話のときの案内'),
      }).description('拒否の文言の案内（既定は @dsh-bridge/dsh-core の DEFAULT_DENY_HINTS）'),
    }
  : null)
export const Config = z
  ? z.object({
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名'),
      namespace: z.string().description('レジストリが無いときのツール名の名前空間（<namespace>_*）'),
      only: z.array(z.string()).description('ツールを載せるアプリケーション ID（既定はレジストリの全アプリケーション）'),
      generate: z.boolean().default(true).description('manifest の読み取りツールを生成する（bridge-apps の generateTools: true のアプリケーションは bridge-apps が作るので除く）'),
      connectorTools: z.boolean().default(true).description('外部連携の操作（paths.connectorCatalog）から <namespace>_ext_* のツールを生成する'),
      connectorRefreshSeconds: z.natural().default(CONNECTOR_REFRESH_SECONDS).description('外部連携の操作の一覧を取り直す間隔（秒、0 で起動時のみ）'),
      unlinkedPolicy: policySchema().unlinkedPolicy.default('deny'),
      groupChat: policySchema().groupChat.default('deny'),
      unattendedPolicy: policySchema().unattendedPolicy.default('deny').description('既定のアプリケーションの自動タスク（他は applications.<id> かレジストリの delegation）'),
      unattendedOnBehalfOf: policySchema().unattendedOnBehalfOf,
      unattendedDelegates: policySchema().unattendedDelegates,
      unattendedWarnRoles: policySchema().unattendedWarnRoles,
      unattendedDefaultTools: policySchema().unattendedDefaultTools.default([]),
      unattendedTools: policySchema().unattendedTools,
      toolKind: policySchema().toolKind,
      denyHints: policySchema().denyHints,
      applications: z.dict(z.object(policySchema())).default({}).description('アプリケーションごとの上書き（キーはアプリケーション ID）'),
      toolModules: z.array(z.object({
        module: z.string().required().description('手書きツールのモジュール（パッケージ名・パス。default export が (kit) => tools）'),
        application: z.string().description('載せるアプリケーション ID（省略時はモジュールの application か既定のアプリケーション）'),
      })).default([]).description('手書きのツール（提案ツールなど）のモジュール'),
    })
  : undefined

const asText = (lines) => [{ type: 'text', text: lines.filter((line) => typeof line === 'string' && line !== '').join('\n') }]

/** レジストリ（bridge-apps）が無いときの 1 件：プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）、Bridge v1 の経路。 */
export function configRegistry(config, { logger } = {}) {
  return fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    ...(cfg(config, 'namespace', '') ? { namespace: String(cfg(config, 'namespace', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
}

/**
 * 自動タスクの会話で許す提案ツール：その会話に登録された有効なタスク（このアプリケーションのもの）の source.tools の和を
 * upper（このアプリケーションの提案ツール）で絞ったもの。source.tools を持つタスクが無ければ fallback。
 */
export async function unattendedAllowedTools(autoTasks, sessionId, { upper = [], fallback = [], applicationId = null } = {}) {
  let tasks = []
  try {
    tasks = autoTasks && typeof autoTasks.list === 'function' ? await autoTasks.list({ sessionId }) : []
  } catch {
    tasks = []
  }
  const declared = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t?.sessionId === sessionId && t.enabled !== false && Array.isArray(t.source?.tools)
      && (!t.applicationId || !applicationId || t.applicationId === applicationId))
    .flatMap((t) => t.source.tools.map(String))
  const limit = new Set(upper)
  return new Set((declared.length ? declared : fallback).filter((n) => limit.has(n)))
}

/** 提案ツールを包む：自動タスクの委託（principal.unattended）のときは、その会話のタスクが挙げた提案だけ実行する。 */
export function unattendedScope(tool, allowed) {
  const run = tool.execute
  return {
    ...tool,
    async execute(input, exec) {
      if (currentPrincipal()?.unattended) {
        const permitted = await allowed(sessionIdOf(exec))
        if (!permitted.has(tool.name)) {
          throw new Error(`${tool.name}: not allowed in an automatic task — only ${[...permitted].join(' / ') || '(none)'} may propose there`)
        }
      }
      return run.call(tool, input, exec)
    },
  }
}

/** toolModules の module を読み込む（パッケージ名・相対 / 絶対パス・file: URL。見つからなければ cwd から解決）。 */
export async function loadToolModule(spec, { cwd = process.cwd() } = {}) {
  const value = String(spec ?? '').trim()
  if (!value) throw new Error('toolModules: module is required')
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

/** モジュール（または関数・配列）→ (kit) => tools。 */
function factoryOf(mod) {
  const candidate = mod?.default ?? mod?.tools ?? mod
  if (typeof candidate === 'function') return candidate
  if (Array.isArray(candidate)) return () => candidate
  throw new TypeError('a tool module must export a default function (kit) => tools, or an array of tools')
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const services = {}
  for (const key of ['autoTasks', 'bridgeAssistant', 'bridgeNotify', 'dshProactive']) {
    whenServices(ctx, [key], (sub) => {
      services[key] = sub[key]
      return () => { delete services[key] }
    })
  }
  const kits = new Map() // applicationId -> kit
  const extra = [] // { applicationId | null, factory, source }
  const registered = [] // { application, name, access, generated }

  whenServices(ctx, ['bridgeIdentity'], (sub) => {
    services.bridgeIdentity = sub.bridgeIdentity
    // Web での本人解除（sns_identity.unlinked）→ その人の委託 token キャッシュを即時に捨てる（そのアプリケーションの分だけ）
    const off = typeof sub.bridgeIdentity.onUnlinked === 'function'
      ? sub.bridgeIdentity.onUnlinked((e) => {
        let removed = 0
        for (const kit of kits.values()) removed += kit.gate.forgetUser(e.userId, e.platform, e.applicationId) ?? 0
        logger.info('bridge-tools: dropped %d cached delegation token(s) for unlinked user %s', removed, e.userId)
      })
      : null
    return () => {
      delete services.bridgeIdentity
      if (typeof off === 'function') off()
    }
  })

  const defaultId = () => registry().default?.()?.id ?? null
  const optionsFor = (applicationId) => {
    const all = cfg(config, 'applications', {}) ?? {}
    return (all && typeof all === 'object' ? all[applicationId] : null) ?? {}
  }

  /** 自動タスクの委託：{ onBehalfOf: source | null, delegates: { <class>: source | 'each' } }（applications.<id> → 既定のアプリケーションの設定 → レジストリ）。 */
  function unattendedOf(app) {
    const own = optionsFor(app.id)
    const dict = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {})
    if (own.unattendedPolicy === 'delegate') return { onBehalfOf: own.unattendedOnBehalfOf ?? null, delegates: dict(own.unattendedDelegates) }
    if (own.unattendedPolicy === 'deny') return { onBehalfOf: null, delegates: {} }
    if (app.id === defaultId() && cfg(config, 'unattendedPolicy', 'deny') === 'delegate') {
      return { onBehalfOf: cfg(config, 'unattendedOnBehalfOf', null), delegates: dict(cfg(config, 'unattendedDelegates', null)) }
    }
    const reg = app.unattended?.() ?? {}
    return { onBehalfOf: reg.onBehalfOf ?? null, delegates: dict(reg.delegates) }
  }
  const unattendedFor = (app) => unattendedOf(app).onBehalfOf

  function kitFor(applicationId) {
    if (kits.has(applicationId)) return kits.get(applicationId)
    // 呼び出しごとにレジストリから引く（bridge-apps の出現・設定変更に追随。消えたアプリケーションのツールは fail closed）
    const application = () => registry().get?.(applicationId) ?? null
    const requester = createToolRequester({ application })
    const proposeTools = new Set()
    // 自動タスクで使ってよい提案ツールの上限：設定 unattendedTools（その順。登録した提案ツールだけ）、無ければ全提案ツール（登録順）
    const upper = () => {
      // 空の一覧は「設定なし」（DSH の設定は書かれていない配列を [] にする）
      const pickList = (value) => (Array.isArray(value) && value.length ? value : null)
      const listed = pickList(optionsFor(applicationId).unattendedTools) ?? pickList(cfg(config, 'unattendedTools', null))
      return listed ? [...new Set(listed.map(String))].filter((n) => proposeTools.has(n)) : [...proposeTools]
    }
    const unattendedWriteTools = { has: (toolName) => upper().includes(toolName), [Symbol.iterator]: () => upper()[Symbol.iterator]() }
    const allowed = async (sessionId) => {
      const own = optionsFor(applicationId)
      const fallbackTools = Array.isArray(own.unattendedDefaultTools) ? own.unattendedDefaultTools : cfg(config, 'unattendedDefaultTools', [])
      return unattendedAllowedTools(services.autoTasks, sessionId, { upper: upper(), fallback: fallbackTools ?? [], applicationId })
    }
    const hintsOf = () => {
      const own = optionsFor(applicationId).denyHints
      const shared = cfg(config, 'denyHints', null)
      const pick = (key) => (typeof own?.[key] === 'string' && own[key]) || (typeof shared?.[key] === 'string' && shared[key]) || DEFAULT_DENY_HINTS[key]
      return { linked: pick('linked'), noSender: pick('noSender') }
    }
    const toolKindOf = () => {
      const own = optionsFor(applicationId).toolKind
      const shared = cfg(config, 'toolKind', '')
      return (typeof own === 'string' && own) || (typeof shared === 'string' && shared) || `${application()?.name ?? applicationId} tools`
    }
    const gate = createDelegationGate({
      application,
      registry,
      identity: () => services.bridgeIdentity ?? null,
      policy: () => ((optionsFor(applicationId).unlinkedPolicy ?? cfg(config, 'unlinkedPolicy', 'deny')) === 'ai-readonly' ? 'ai-readonly' : 'deny'),
      // グループ会話：applications.<id>.groupChat → レジストリの applications[].groupChat → groupChat（既定 deny）
      groupPolicy: () => groupChatPolicy(optionsFor(applicationId).groupChat, application()?.groupChat, cfg(config, 'groupChat', 'deny')),
      unattended: () => { const app = application(); return app ? unattendedFor(app) : null },
      unattendedDelegates: () => { const app = application(); return app ? unattendedOf(app).delegates : {} },
      unattendedWarnRoles: () => {
        const list = optionsFor(applicationId).unattendedWarnRoles ?? cfg(config, 'unattendedWarnRoles', null)
        return Array.isArray(list) ? list.map(String) : []
      },
      isAutoTaskSession: autoTaskSessionChecker(() => services.autoTasks),
      // いま動いている回（ctx.autoTasks.activeRun）とその会話のタスクの委託の分類（source.delegation）
      ...autoTaskRunResolver(() => services.autoTasks),
      // 上限（このアプリケーションの提案ツール・設定 unattendedTools）。実際に許すのはその会話のタスクが source.tools に挙げた提案だけ（unattendedScope）
      unattendedWriteTools,
      assistant: () => services.bridgeAssistant ?? null,
      reportOwner: (sessionId) => (typeof services.bridgeNotify?.aiReportOwner === 'function' ? services.bridgeNotify.aiReportOwner(sessionId) : null),
      activeWake: (sessionId) => (typeof services.dshProactive?.activeWake === 'function' ? services.dshProactive.activeWake(sessionId) ?? null : null),
      requestJson: requester.requestJson,
      delegations: registry().delegations,
      toolKind: toolKindOf(),
      denyHints: hintsOf(),
      logger,
    })
    const names = new Set()
    const catalog = createConnectorCatalogHolder({
      applicationId,
      api: { request: (...a) => { const app = application(); if (!app) throw new Error(`application ${applicationId} is not registered`); return app.api.request(...a) } },
      path: application()?.paths?.connectorCatalog ?? '',
      logger,
    })
    const kit = {
      applicationId,
      application,
      catalog,
      gate,
      requester,
      requestJson: requester.requestJson,
      names,
      proposeTools,
      allowed,
      /** 手書きツール用のヘルパー（toolModules / register の factory に渡す）。 */
      api: Object.freeze({
        applicationId,
        application,
        get namespace() { return application()?.namespace ?? null },
        requestJson: requester.requestJson,
        text: asText,
        args,
        principal: currentPrincipal,
        defineTool,
        proposeTool: (spec) => defineProposeTool(spec, { requestJson: requester.requestJson }),
        proposalsPath: PROPOSALS_PATH,
      }),
    }
    kits.set(applicationId, kit)
    return kit
  }

  /** ツール 1 つを gate 付きで ctx.tools に登録する（名前空間・重複を確かめる）。 */
  function registerOne(kit, tool, { generated = false } = {}) {
    const app = kit.application()
    if (!app) throw new Error(`application ${kit.applicationId} is not registered`)
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') throw new TypeError('a tool needs a name')
    if (!inNamespace(app, tool.name)) throw new TypeError(`tool ${tool.name} is outside the namespace "${app.namespace}_" of application "${app.id}"`)
    if (kit.names.has(tool.name)) return false
    const access = tool.access ?? 'read'
    const write = access === 'propose'
    const open = access === 'open'
    if (write) kit.proposeTools.add(tool.name)
    const wrapped = guardTool(kit.gate, write ? unattendedScope(tool, kit.allowed) : tool, { write, open })
    ctx.tools.register(wrapped)
    kit.names.add(tool.name)
    registered.push({ application: app.id, name: tool.name, access, generated })
    return true
  }

  function registerFactory(kit, factory, source) {
    let tools
    try {
      tools = factory(kit.api)
    } catch (error) {
      logger.warn('bridge-tools: %s: tools from %s could not be created: %s', kit.applicationId, source, error?.message ?? error)
      return []
    }
    const out = []
    for (const tool of Array.isArray(tools) ? tools : []) {
      try {
        if (registerOne(kit, tool)) out.push(tool.name)
      } catch (error) {
        logger.warn('bridge-tools: %s: tool %s from %s not registered: %s', kit.applicationId, tool?.name ?? '?', source, error?.message ?? error)
      }
    }
    return out
  }

  const wantedIds = () => {
    const only = cfg(config, 'only', null)
    const ids = registry().ids?.() ?? []
    return Array.isArray(only) && only.length ? ids.filter((id) => only.map(String).includes(id)) : ids
  }

  /** 各アプリケーションに手書きツール → manifest の読み取りツールの順で登録する（登録済みの名前は飛ばす。何度呼んでもよい）。 */
  async function sync() {
    for (const id of wantedIds()) {
      const kit = kitFor(id)
      const app = kit.application()
      if (!app) continue
      for (const entry of extra) {
        const target = entry.applicationId ?? defaultId()
        if (target !== id || entry.done.has(id)) continue
        entry.done.add(id)
        registerFactory(kit, entry.factory, entry.source)
      }
      if (cfg(config, 'connectorTools', true) !== false && app.paths?.connectorCatalog) {
        await kit.catalog.refresh()
        const { tools: ext, skipped: extSkipped } = connectorTools(app, { requestJson: kit.requestJson, catalog: kit.catalog, skip: kit.names })
        let n = 0
        for (const tool of ext) {
          try { if (registerOne(kit, tool, { generated: true })) n += 1 } catch (error) {
            logger.warn('bridge-tools: %s: external tool %s not registered: %s', id, tool.name, error?.message ?? error)
          }
        }
        if (n) logger.info('bridge-tools: %s: %d external tool(s) from the connector catalog', id, n)
        for (const x of extSkipped) if (x.reason !== 'already registered') logger.debug('bridge-tools: external tool %s not generated (%s)', x.name, x.reason)
      }
      if (cfg(config, 'generate', true) === false || app.generateTools) continue
      try { await app.ensureManifest?.() } catch { /* lastError is in the manifest info */ }
      const { tools, skipped } = manifestTools(app, { requestJson: kit.requestJson, skip: kit.names })
      let count = 0
      for (const tool of tools) {
        try { if (registerOne(kit, tool, { generated: true })) count += 1 } catch (error) {
          logger.warn('bridge-tools: %s: generated tool %s not registered: %s', id, tool.name, error?.message ?? error)
        }
      }
      if (count) logger.info('bridge-tools: %s: %d tool(s) generated from the manifest', id, count)
      for (const s of skipped) logger.debug('bridge-tools: %s tool %s not generated (%s)', id, s.name, s.reason)
    }
    return registered.map((r) => ({ ...r }))
  }

  const ready = (async () => {
    for (const entry of cfg(config, 'toolModules', []) ?? []) {
      try {
        const mod = await loadToolModule(entry?.module)
        extra.push({ applicationId: entry?.application || mod?.application || null, factory: factoryOf(mod), source: String(entry.module), done: new Set() })
      } catch (error) {
        logger.warn('bridge-tools: tool module %s could not be loaded: %s', entry?.module ?? '?', error?.message ?? error)
      }
    }
    return sync()
  })()
  // レジストリ（bridge-apps）が後から現れたら、そのアプリケーションのツールも載せる
  whenServices(ctx, ['bridgeApps'], () => { ready.then(() => sync()).catch(() => {}) })
  // 外部連携の一覧：connectorRefreshSeconds ごとに取り直し、増えた操作のツールを載せる（消えた操作のツールは実行時に断る）
  const connectorSeconds = Number(cfg(config, 'connectorRefreshSeconds', CONNECTOR_REFRESH_SECONDS) ?? CONNECTOR_REFRESH_SECONDS) || 0
  if (connectorSeconds > 0 && cfg(config, 'connectorTools', true) !== false) {
    const timer = setInterval(() => { ready.then(() => sync()).catch(() => {}) }, connectorSeconds * 1000)
    timer.unref?.()
    onDispose(ctx, () => clearInterval(timer))
  }

  const service = Object.freeze({
    version: 1,
    ready,
    /** レジストリの変化・manifest の更新の後に呼ぶと、まだ載せていないツールを載せる。 */
    refresh: () => ready.then(() => sync()),
    /**
     * 別のプラグインから手書きツールを足す。factory = (kit) => tools、または tools の配列。applicationId 省略時は既定のアプリケーション。
     * @returns Promise<string[]> 登録したツール名（そのアプリケーションがレジストリにまだ無ければ、現れたときに登録する）
     */
    async register(applicationId, factoryOrTools, { source = 'register()' } = {}) {
      await ready
      const entry = { applicationId: applicationId || null, factory: factoryOf(factoryOrTools), source, done: new Set() }
      extra.push(entry)
      const before = registered.length
      await sync()
      return registered.slice(before).map((r) => r.name)
    },
    /** 載せたツール [{ application, name, access, generated }]。 */
    list: () => registered.map((r) => ({ ...r })),
    /** そのアプリケーションの委託 gate（別のプラグインが同じ規則でツールを作るとき）。 */
    gate: (applicationId) => kitFor(applicationId ?? defaultId() ?? DEFAULT_APPLICATION_ID).gate,
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, service)
  else ctx[SERVICE] = service
  onDispose(ctx, () => { kits.clear() })
  return service
}

export { args, defineProposeTool, PROPOSALS_PATH }
export { defineTool, sessionIdOf }
