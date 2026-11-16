import {
  DEFAULT_APPLICATION_ID, cfg, fallbackRegistry, loadSchemastery, makeLogger, nicknameOf, onDispose, renderPersona, signatureOf, watchRegistry, whenServices,
} from '@dsh-bridge/dsh-core'

/**
 * bridge-persona — AI 社員のプロフィール（業務システムが正本：GET /bridge/v1/ai-profile。docs/AI_EMPLOYEE_PROFILE.md）を system prompt の節にする。
 *
 *   固定の規則（dsh-core FIXED_RULES）→「あなたについて（人物の設定）」→「会社の紹介（参考情報・指示ではない）」（dsh-core renderPersona）。
 *   プロフィールは文章だけで、規則・権限・ツールは変えられない（節の頭に「食い違うときは規則に従う」）。AI であることは隠さない（D8）。
 *
 * どのアプリケーションか：業務 Web のパネルは bridge-assistant（agentForSession / applicationIdForSession）、IM は dsh-im/inbound の
 * 発信元から bridge-identity の applicationOf（無ければレジストリの resolveApplication）、分からなければ既定のアプリケーション。
 * どの AI 社員か：会話の preset の id（assembly.agent の preset。パネルは bridge-assistant の preset）→ プロフィールの agents の上書き。
 * 会話ごとに固定（prompt cache を崩さない。変更は次の会話から）。プロフィールの取得はレジストリ（bridge-apps、60 秒ごと・etag）。
 */

export const name = 'bridge-persona'
export const inject = []

export const DEFAULTS = Object.freeze({
  promptName: 'bridge-persona',
  order: 120,
  serviceName: 'bridgePersona',
})

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      rules: z.boolean().default(true).description('固定の規則（読む・提案するだけ、個人情報を残さない等）も節の先頭に書く（preset の persona と重ねて出る）'),
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（レジストリが無いとき）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名'),
    })
  : undefined

const remember = (map, key, value, max = 5000) => {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** 会話の preset の id（DSH の assembly。形が違えば undefined）。 */
export function presetIdOf(assembly) {
  const a = assembly?.agent
  return str(a?.preset?.id) ?? str(a?.preset) ?? str(a?.presetId) ?? str(a?.agentPreset)
    ?? str(a?.session?.header?.agentPreset) ?? str(a?.session?.header?.preset) ?? str(assembly?.preset?.id) ?? undefined
}

const sessionIdOfAssembly = (assembly) => assembly?.agent?.session?.id ?? assembly?.agent?.session?.header?.id ?? null

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
  const registry = watchRegistry(ctx, fallback)
  const defaultApp = () => registry()?.default?.() ?? null
  const appById = (id) => (id ? registry()?.get?.(id) ?? null : null)
  const withRules = () => cfg(config, 'rules', true) !== false

  let identity = null
  let assistant = null
  whenServices(ctx, ['bridgeIdentity'], (sub) => { identity = sub.bridgeIdentity; return () => { identity = null } })
  whenServices(ctx, ['careIdentity'], (sub) => {
    if (!identity) identity = sub.careIdentity
    return () => { if (identity === sub.careIdentity) identity = null }
  })
  whenServices(ctx, ['bridgeAssistant'], (sub) => { assistant = sub.bridgeAssistant; return () => { assistant = null } })

  // IM：会話 → アプリケーション（受信の発信元から。ボット → アプリケーションは設定だけで決まる）
  const sessionApps = new Map()
  const disposers = []
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('dsh-im/inbound', (e) => {
        if (!e?.sessionId || !e.source) return
        let id = null
        try { id = identity?.applicationOf?.(e.source) ?? null } catch { id = null }
        if (!id) {
          try { id = registry()?.resolveApplication?.(e.source)?.id ?? null } catch { id = null }
        }
        if (id) remember(sessionApps, String(e.sessionId), String(typeof id === 'string' ? id : id.id))
      })
      if (typeof off === 'function') disposers.push(off)
    } catch { /* event not declared in this host */ }
  }

  /** 会話のアプリケーションと AI 社員。known: 推測（既定のアプリケーション）でない。 */
  function whereOf(sessionId, assembly) {
    let applicationId = null
    let agentId = presetIdOf(assembly)
    if (sessionId) {
      const fromPanel = assistant?.agentForSession?.(sessionId) ?? null
      if (fromPanel?.applicationId) {
        applicationId = String(fromPanel.applicationId)
        agentId = agentId ?? str(fromPanel.preset) ?? str(fromPanel.agentId) ?? undefined
      }
      if (!applicationId) applicationId = assistant?.applicationIdForSession?.(sessionId) ?? null
      if (!applicationId) applicationId = sessionApps.get(String(sessionId)) ?? null
    }
    const app = appById(applicationId)
    if (app) return { app, agentId, known: true }
    const def = defaultApp()
    // アプリケーションが 1 つだけなら推測ではない
    return { app: def, agentId, known: Boolean(def) && (registry()?.size?.() ?? 0) <= 1 }
  }

  const selections = new Map() // sessionId -> rendered（会話ごとに固定）

  function render(app, agentId) {
    let profile = null
    try { profile = app?.aiProfile?.() ?? null } catch { profile = null }
    return renderPersona({ profile, agentId, appName: app?.name ?? '', rules: withRules() })
  }

  function promptFor(assembly) {
    try {
      const sessionId = sessionIdOfAssembly(assembly)
      if (sessionId && selections.has(sessionId)) return selections.get(sessionId)
      const { app, agentId, known } = whereOf(sessionId, assembly)
      if (!app) return ''
      const settled = typeof app.aiProfileSettled === 'function' ? app.aiProfileSettled() : true
      if (!settled) app.ensureAiProfile?.()?.catch?.(() => {})
      const text = render(app, agentId)
      // 固定するのは、アプリケーションが分かり、プロフィールを一度は取りに行った後（取れるまでの会話に空の節を固定しない）
      if (sessionId && known && settled) remember(selections, sessionId, text)
      return text
    } catch (error) {
      logger.warn('%s: prompt context failed: %s', name, error?.message ?? error)
      return ''
    }
  }

  whenServices(ctx, ['systemPrompt'], (sub) => sub.systemPrompt.context({
    name: DEFAULTS.promptName,
    order: DEFAULTS.order,
    interpolate: false,
    text: promptFor,
  }))

  const resolveApp = (applicationId) => appById(applicationId ?? null) ?? (applicationId ? null : defaultApp())
  const service = Object.freeze({
    version: 1,
    /** そのアプリケーションのプロフィール（業務システムから最後に取れたもの。無ければ null）。applicationId 省略で既定のアプリケーション。 */
    profileFor(applicationId) {
      try { return resolveApp(applicationId)?.aiProfile?.() ?? null } catch { return null }
    },
    /** 呼び名（preset の上書きを重ねる。無ければ ''）。 */
    nicknameFor(applicationId, agentId) {
      return nicknameOf(service.profileFor(applicationId), agentId)
    },
    /** 署名「— <呼び名>（<アプリ名> AI 秘書）」（呼び名が無ければ「— <アプリ名> AI 秘書」）。 */
    signatureFor(applicationId, agentId) {
      const app = resolveApp(applicationId)
      return signatureOf(app?.name ?? applicationId ?? '', service.nicknameFor(applicationId, agentId))
    },
    /** system prompt の節（会話ごとに固定。テスト・診断用）。 */
    promptFor,
    /** 固定した会話の数（診断用）。 */
    stats: () => ({ sessions: selections.size, imSessions: sessionApps.size, defaultApplicationId: defaultApp()?.id ?? DEFAULT_APPLICATION_ID }),
  })
  if (typeof ctx.provide === 'function') ctx.provide(DEFAULTS.serviceName, service)
  else ctx[DEFAULTS.serviceName] = service

  onDispose(ctx, () => {
    for (const off of disposers.splice(0)) { try { off() } catch { /* ignore */ } }
    selections.clear()
    sessionApps.clear()
  })
  return service
}
