// plugin.js — DSH（Cordis）プラグイン `bridge-apps`：アプリケーションレジストリを ctx.bridgeApps として提供する。
//
//   - id: bridge-apps
//     name: '@dsh-bridge/dsh-core'
//     config:
//       applications:
//         - id: equipment-inspection
//           name: 設備点検
//           apiUrlEnv: INSPECTION_API_URL
//           serviceTokenEnv: INSPECTION_SERVICE_TOKEN
//           manifestUrl: /bridge/v1/manifest
//           manifestFile: pkg:@dsh-bridge/protocol/manifests/equipment-inspection.manifest.yaml
//       pathProfiles: {}          # 任意：v1 以外の経路表 { <name>: { identity, link, delegations, ... } }
//       compat: []                # 任意：互換 profile（care-billing-paths：ケアビリングの旧来の /api/ai/* 経路と旧サービス名）
//
// manifest は起動時と manifestRefreshSeconds ごとに取り直す（etag）。AI 社員のプロフィール（paths.aiProfile）は起動時と aiProfileRefreshSeconds（既定 60 秒）ごと。generateTools: true のアプリケーションは、
// manifest の読み取りツールを生成して ctx.tools に登録する（委託 gate 付き。身元は ctx.bridgeIdentity）。
import { cfg, loadSchemastery, makeLogger, onDispose, whenServices } from './runtime.js'
import { createApplicationRegistry, registerPathProfile } from './registry.js'
import { autoTaskRunResolver, autoTaskSessionChecker, createDelegationGate, createToolRequester, registerManifestTools } from './tools-sdk.js'
import * as careBillingPaths from './compat/care-billing-paths.js'

/** 設定 `compat` で有効にできる互換 profile。 */
export const COMPAT_PROFILES = Object.freeze({
  'care-billing-paths': Object.freeze({
    enable: careBillingPaths.enableCareBillingPaths,
    serviceNames: careBillingPaths.LEGACY_SERVICE_NAMES,
  }),
})
/** 身元・アシスタントのサービス名（互換 profile が旧名を足す）。 */
export const SERVICE_NAMES = Object.freeze({ identity: 'bridgeIdentity', assistant: 'bridgeAssistant' })

export const name = 'bridge-apps'
export const SERVICE = 'bridgeApps'

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      applications: z.array(z.object({
        id: z.string().required().description('アプリケーション ID（manifest の system.id と同じ。例 equipment-inspection）'),
        name: z.string().description('表示名（例 設備点検）'),
        label: z.string().description('エラー文言での API の名前（既定 <id> API）'),
        default: z.boolean().description('既定のアプリケーション（bots を書かなければ未割り当てのボットを受ける）'),
        apiUrl: z.string().description('業務 API の URL'),
        apiUrlEnv: z.string().description('業務 API の URL を読む環境変数名（値があれば apiUrl より優先）'),
        serviceToken: z.string().role('secret').description('サービストークン'),
        serviceTokenEnv: z.string().description('サービストークンを読む環境変数名（値があれば serviceToken より優先）'),
        manifestUrl: z.string().description('manifest の URL（API からの相対 /bridge/v1/manifest か絶対 URL）'),
        manifestFile: z.string().description('同梱の manifest（パス、または pkg:<package>/<path>）'),
        namespace: z.string().description('ツール名の名前空間（<namespace>_*。既定は id の - を _ に）'),
        paths: z.any().description("API の経路：'v1'（既定）| path profile 名（pathProfiles・compat で登録）| 個別指定 { base?, identity, ... }"),
        protocol: z.any().description('応答の bridge-protocol ヘッダに期待する版（既定 1。null で検査しない）'),
        bots: z.array(z.object({
          platform: z.string(),
          botId: z.string(),
          multiApp: z.boolean().description('共用ボット（個人 WeChat）：複数のアプリケーションに載せ、同じ窓口内で切り替える'),
        })).description('このアプリケーションのボット（dsh-im の botId）'),
        aliases: z.array(z.string()).description('共用ボットでの切り替え名（「#点検」の 点検 など）'),
        agents: z.array(z.any()).description('このアプリケーションの AI 社員（プリセット ID）'),
        delegation: z.any().description('委託の方針（unattendedPolicy / unattendedOnBehalfOf）'),
        generateTools: z.boolean().description('manifest の読み取りツールを生成して登録する'),
        messages: z.any().description('IM の案内文の上書き（unlinkedReply など）'),
        timeoutMs: z.natural().description('サービス呼び出しのタイムアウト（ミリ秒）'),
        retries: z.natural().description('冪等な呼び出しの再試行回数'),
      })).default([]).description('この DSH が載せる業務アプリケーション'),
      strict: z.boolean().default(false).description('未割り当てのボットを既定のアプリケーションに回さない'),
      manifestRefreshSeconds: z.natural().default(600).description('manifest を取り直す間隔（秒、0 で起動時のみ）'),
      aiProfileRefreshSeconds: z.natural().default(60).description('AI 社員のプロフィール（paths.aiProfile）を取り直す間隔（秒、0 で起動時のみ）'),
      pathProfiles: z.dict(z.any()).default({}).description('v1 以外の経路表（名前 → { identity, link, delegations, ... }）'),
      compat: z.array(z.string()).default([]).description('互換 profile（例 care-billing-paths）'),
    })
  : undefined

function firstService(services, names) {
  for (const key of names) if (services[key]) return services[key]
  return null
}

function provide(ctx, key, value) {
  if (typeof ctx.provide === 'function') ctx.provide(key, value)
  else ctx[key] = value
}

/** レジストリ → 公開サービス（ctx.bridgeApps）。 */
export function registryService(registry) {
  return Object.freeze({
    version: 1,
    size: registry.size,
    list: registry.list,
    ids: registry.ids,
    get: registry.get,
    has: registry.has,
    default: registry.default,
    resolveApplication: registry.resolveApplication,
    applicationsForBot: registry.applicationsForBot,
    isMultiAppBot: registry.isMultiAppBot,
    sharedDefaultApplication: registry.sharedDefaultApplication,
    setApplicationSelector: registry.setApplicationSelector,
    sharedBots: registry.sharedBots,
    refreshManifests: registry.refreshManifests,
    ensureManifests: registry.ensureManifests,
    refreshAiProfiles: registry.refreshAiProfiles,
    delegations: registry.delegations,
    strict: registry.strict,
    describe: registry.describe,
  })
}

/** 設定の compat / pathProfiles を反映し、身元・アシスタントのサービス名の一覧を返す。 */
export function applyCompat(config = {}) {
  const identity = [SERVICE_NAMES.identity]
  const assistant = [SERVICE_NAMES.assistant]
  const profiles = cfg(config, 'pathProfiles', {}) ?? {}
  for (const [profileName, paths] of Object.entries(profiles)) registerPathProfile(profileName, paths)
  for (const key of cfg(config, 'compat', []) ?? []) {
    const profile = COMPAT_PROFILES[key]
    if (!profile) throw new TypeError(`bridge-apps: unknown compat profile "${key}" (known: ${Object.keys(COMPAT_PROFILES).join(', ')})`)
    profile.enable()
    if (profile.serviceNames?.identity) identity.push(profile.serviceNames.identity)
    if (profile.serviceNames?.assistant) assistant.push(profile.serviceNames.assistant)
  }
  return { identity, assistant }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const serviceNames = applyCompat(config)
  const registry = createApplicationRegistry({
    applications: cfg(config, 'applications', []) ?? [],
    strict: Boolean(cfg(config, 'strict', false)),
    logger,
  })
  const service = registryService(registry)
  provide(ctx, SERVICE, service)

  let disposed = false
  onDispose(ctx, () => { disposed = true })
  const loaded = registry.refreshManifests().then(() => {
    for (const app of registry.list()) {
      const info = app.manifestInfo()
      if (info.source) logger.info('bridge: %s manifest %s from %s', app.id, info.version ?? '?', info.source)
      else logger.warn('bridge: %s has no manifest (%s)', app.id, info.lastError ?? 'not configured')
    }
  })
  // AI 社員のプロフィール：起動時と aiProfileRefreshSeconds ごと（etag / 304。paths.aiProfile の無いアプリケーションは取りに行かない）
  registry.refreshAiProfiles().catch(() => {})
  const profileSeconds = Number(cfg(config, 'aiProfileRefreshSeconds', 60) ?? 60) || 0
  if (profileSeconds > 0) {
    const timer = setInterval(() => { if (!disposed) registry.refreshAiProfiles().catch(() => {}) }, profileSeconds * 1000)
    timer.unref?.()
    onDispose(ctx, () => clearInterval(timer))
  }
  const everySeconds = Number(cfg(config, 'manifestRefreshSeconds', 600)) || 0
  if (everySeconds > 0) {
    const timer = setInterval(() => { if (!disposed) registry.refreshManifests().catch(() => {}) }, everySeconds * 1000)
    timer.unref?.()
    onDispose(ctx, () => clearInterval(timer))
  }

  // manifest からの読み取りツール（generateTools: true のアプリケーションだけ）
  const services = {}
  for (const key of [...serviceNames.identity, 'autoTasks', 'bridgeTools', ...serviceNames.assistant]) {
    whenServices(ctx, [key], (sub) => {
      services[key] = sub[key]
      return () => { delete services[key] }
    })
  }
  const generated = []
  if (registry.list().some((app) => app.generateTools)) {
    whenServices(ctx, ['tools'], (sub) => {
      let alive = true
      loaded.then(() => {
        if (!alive || disposed) return
        for (const app of registry.list().filter((a) => a.generateTools)) {
          const requester = createToolRequester({ application: () => app })
          const local = createDelegationGate({
            application: () => app,
            registry: () => registry,
            identity: () => firstService(services, serviceNames.identity),
            policy: () => 'deny',
            unattended: () => app.unattended().onBehalfOf,
            unattendedDelegates: () => app.unattended().delegates ?? {},
            isAutoTaskSession: autoTaskSessionChecker(() => services.autoTasks),
            ...autoTaskRunResolver(() => services.autoTasks),
            assistant: () => firstService(services, serviceNames.assistant),
            requestJson: requester.requestJson,
            delegations: registry.delegations,
            toolKind: `${app.name} tools`,
            logger,
          })
          // With @dsh-bridge/plugin-tools loaded, its gate of this application decides (the same rules for generated and
          // hand-written tools: bridge-tools' unattendedPolicy / unattendedOnBehalfOf — what install.mjs --auto-task-delegate
          // writes —, scheduled-report owners, ...). Without it, this gate (registry delegation only).
          const pick = () => (typeof services.bridgeTools?.gate === 'function' ? services.bridgeTools.gate(app.id) : null) ?? local
          const gate = {
            authorize: (...a) => pick().authorize(...a),
            forget: (...a) => pick().forget(...a),
            forgetUser: (...a) => pick().forgetUser(...a),
            clear: () => pick().clear(),
            size: () => pick().size(),
            get delegations() { return pick().delegations },
          }
          const { registered } = registerManifestTools(sub.tools, { application: app, gate, requestJson: requester.requestJson, logger })
          generated.push(...registered)
          logger.info('bridge: %s: %d tool(s) generated from the manifest', app.id, registered.length)
        }
      }).catch((error) => logger.warn('bridge: tool generation failed: %s', error?.message ?? error))
      return () => { alive = false }
    })
  }

  return { registry: service, loaded, generated }
}
