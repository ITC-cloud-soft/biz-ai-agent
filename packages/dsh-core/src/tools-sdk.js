// tools-sdk.js — 業務ツール（DSH の AI 社員が使う HTTP ツール）の共通部品。BRIDGE_ARCHITECTURE §5・§13。
//
//  - defineTool：ツール定義（access = read | propose | open）。書き込みは「提案」だけ。read のツールは GET しか呼べない。
//  - createDelegationGate：呼び出しごとの認可。信頼できる発信元 → 職員 → 委託トークン（アプリケーションごと）。
//      経路：IM 発信者 / 業務 Web の AI アシスタント（チケット）/ 定時業務報告（dsh-proactive の business モードの起動）/
//            自動タスク（unattended：設定した職員の委託。playbook の委託の分類 `<class>` ごとの職員、`<class>=each` は
//            その回の起動事件の本人に業務システムが発行する委託）/ 未連携（deny | ai-readonly）
//  - createToolRequester：ツールから業務 API を呼ぶ（サービストークン＋その呼び出しの委託トークン）。
//      委託トークンは発行したアプリケーションにしか送らない。
//  - registerTools / guardTool：アプリケーションの名前空間（`<namespace>_*`）の確認と gate の適用。
//  - manifestTools / registerManifestTools：manifest の `tools`（access: read の GET）から簡単な読み取りツールを生成する。
//
// ケアビリング（最初の利用者）の委託 gate を一般化したもの（挙動は同じ。業務固有の文言は denyHints / toolKind で渡す）。
import { AsyncLocalStorage } from 'node:async_hooks'
import { BridgeApiError, apiSource, sourceKey } from './api-client.js'
import { createDelegationCache, delegationKey, eventIdForRequest } from './delegation.js'
import { GROUP_CHAT_GUIDE, groupChatPolicy, isGroupConversation } from './outbound.js'
import { helpToolSpec } from './help-tool.js'
import { isConnectorRunPath } from './connectors.js'

export const TOOL_ACCESS = Object.freeze(['read', 'propose', 'open'])
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/

/** 自動タスク（playbook）の委託の分類：`<class>`（その分類の職員の委託）か `<class>=each`（起動事件の本人ごとの委託）。 */
export const DELEGATION_SPEC_RE = /^([a-z][a-z0-9_]{0,39})(=each)?$/
/** source.delegation → { class, each } | null（無い・不正）。 */
export function parseDelegationSpec(value) {
  const m = typeof value === 'string' ? DELEGATION_SPEC_RE.exec(value.trim()) : null
  return m ? { class: m[1], each: Boolean(m[2]) } : null
}

/** 実行中のツール呼び出しの呼び出し元（{ mode: 'delegated', delegationToken, applicationId, access } | { mode: 'ai' } | undefined）。 */
const callPrincipal = new AsyncLocalStorage()
export function currentPrincipal() {
  return callPrincipal.getStore()
}
export function runWithPrincipal(principal, fn) {
  return callPrincipal.run(principal, fn)
}

/** ツール呼び出しの会話 ID（DSH の ToolRunContext）。 */
export function sessionIdOf(exec) {
  const session = exec?.agent?.session
  return session?.id ?? session?.header?.id ?? exec?.sessionId ?? null
}

/** BridgeApiError → モデルに見せるツールのエラー（`<tool>: <理由>`）。status / code / kind / applicationId を保つ。 */
export function toolError(tool, error) {
  if (!(error instanceof BridgeApiError)) return error
  const out = new Error(`${tool}: ${error.message}`, { cause: error })
  out.status = error.status
  out.code = error.code
  out.kind = error.kind
  out.applicationId = error.applicationId
  return out
}

/**
 * ツール → 業務 API。requestJson(tool, path, query?, { method, body, auth }) → JSON。
 *  - 2xx 以外・非 JSON・到達不能・`ok: false` は `<tool>: ...` のエラー（status / code 付き）
 *  - 呼び出し元（auth、無ければ実行中の呼び出し）の委託トークンを x-delegation-token で送る。発行元のアプリケーションと送り先が違えば送らずに拒否
 *  - read のツールの呼び出し中は GET 以外を拒否（書き込みは propose のツールの「提案」だけ）
 * @param {object} opts
 * @param {() => object} opts.application  送り先のアプリケーション（registry の要素）。呼び出しごとに評価
 */
export function createToolRequester({ application }) {
  function appOrThrow(tool) {
    const app = application()
    if (!app) throw new Error(`${tool}: no business application is configured for these tools`)
    return app
  }

  async function requestJson(tool, path, params, { method = 'GET', body, auth, connectorRun = false } = {}) {
    const app = appOrThrow(tool)
    const verb = String(method).toUpperCase()
    const principal = auth ?? callPrincipal.getStore()
    if (principal?.delegationToken && principal.applicationId && principal.applicationId !== app.id) {
      throw new Error(`${tool}: refusing to send a delegation token of application "${principal.applicationId}" to "${app.id}"`)
    }
    // the one POST a read tool may make: running a READ operation of an external connector (the business system runs it, a write is refused there)
    const readRun = connectorRun && verb === 'POST' && isConnectorRunPath(app.paths?.connectorRun, path)
    if (principal?.access === 'read' && verb !== 'GET' && !readRun) {
      throw new Error(`${tool}: a read-only tool cannot call ${verb} ${path}; only propose tools may write (as a proposal)`)
    }
    const api = app.toolApi ?? app.api
    let result
    try {
      result = await api.request(verb, path, {
        query: params,
        body: verb === 'GET' ? undefined : (body ?? {}),
        delegationToken: principal?.delegationToken,
        allowEmpty: false,
      })
    } catch (error) {
      throw toolError(tool, error)
    }
    if (result.ok === false) {
      const url = api.buildUrl(path, params)
      throw new Error(
        `${tool}: ${app.label} reported failure for ${verb} ${url.pathname}${url.search}${typeof result.error === 'string' ? ` (${result.error})` : ''}`,
      )
    }
    return result
  }

  return {
    requestJson,
    buildUrl: (path, params) => appOrThrow('buildUrl').api.buildUrl(path, params),
    baseUrl: () => application()?.api.baseUrl() ?? '',
  }
}

export const DEFAULT_DENY_HINTS = Object.freeze({
  linked: 'the employee can link their account in the business web app (IM account linking in the settings) and ask again from that IM account.',
  noSender: 'linking an account does not enable this conversation; ask from a linked IM account (Slack / LINE / Teams / WeChat) '
    + 'or use the business web app directly.',
})

/**
 * 呼び出しごとの認可（1 アプリケーション分）。
 * @param {object} deps
 * @param {() => object} deps.application   この gate が守るアプリケーション（registry の要素）
 * @param {() => object|null} [deps.registry] ボット → アプリケーションの解決（定時報告の本人・アシスタントの照合に使う）
 * @param {() => any} deps.identity         ctx.bridgeIdentity 相当（forSession(sessionId) → {source, linked, applicationId?}）
 * @param {() => string} deps.policy        'deny' | 'ai-readonly'（未連携・発信元なし）
 * @param {() => string} [deps.groupPolicy]  グループ会話（1:1 でない IM 会話）のとき：'deny'（既定）| 'allow'（発言者本人の委託で使わせる）
 * @param {() => object|null} [deps.unattended]  自動タスクのターンを委託で実行するときの IM 発信元（{platform, userId, teamId?}）。null=しない
 * @param {(sessionId: string, applicationId: string) => Promise<boolean>} [deps.isAutoTaskSession]
 * @param {() => object} [deps.unattendedDelegates]  委託の分類ごとの職員（{ <class>: {platform, userId, teamId?} | 'each' }）。
 *                                                  'each' は `<class>=each` の playbook に起動事件ごとの委託を許す（導入先の明示の同意）
 * @param {(sessionId: string, applicationId: string) => object|null|Promise<object|null>} [deps.activeRun]
 *        その会話でいま動いている自動タスクの回（{ runId, taskId, eventId?, eventType?, applicationId?, delegation? }。ctx.autoTasks.activeRun）
 * @param {(sessionId: string, applicationId: string) => Promise<string[]>} [deps.sessionDelegations]
 *        回の外のとき：その会話に登録されたタスクの source.delegation（1 種類のときだけその分類を使う）
 * @param {() => string[]} [deps.unattendedWarnRoles]  自動タスクの委託がこの役割の職員になったら一度だけ警告する（例：管理者）
 * @param {Set<string>} [deps.unattendedWriteTools]  自動タスクのターンで許す提案ツール
 * @param {(sessionId: string) => object|null} [deps.reportOwner]  定時業務報告：その会話で「定時報告 オン」にした本人の IM の発信元
 * @param {(sessionId: string) => {mode: string}|null} [deps.activeWake]  その会話でいま実行中の dsh-proactive の起動ターン
 * @param {() => any} [deps.assistant]       ctx.bridgeAssistant 相当（isAssistantSession / delegationForSession / invalidate）
 * @param {(tool, path, query, opts) => Promise<any>} deps.requestJson  委託トークンの発行に使う（createToolRequester）
 * @param {object} [deps.delegations]        createDelegationCache（既定は新規）
 * @param {string} [deps.toolKind]           文言用（既定 'business tools'）
 * @param {{linked: string, noSender: string}} [deps.denyHints]  拒否の案内（既定 DEFAULT_DENY_HINTS）
 */
export function createDelegationGate({
  application, registry = () => null, identity, policy = () => 'deny', unattended = () => null, isAutoTaskSession = async () => false,
  unattendedDelegates = () => ({}), activeRun = () => null, sessionDelegations = async () => [], unattendedWarnRoles = () => [],
  unattendedWriteTools = new Set(), assistant = () => null, reportOwner = () => null, activeWake = () => null, groupPolicy = () => 'deny',
  requestJson, delegations, now = Date.now, logger = console, toolKind = 'business tools', denyHints = DEFAULT_DENY_HINTS,
}) {
  const cache = delegations ?? createDelegationCache({ now })
  const appOf = () => application()
  const warned = new Set()

  const mintWith = (app, tool) => (body) => requestJson(tool, app.paths.delegations, undefined, {
    method: 'POST',
    body,
    auth: { mode: 'ai', applicationId: app.id },
  })

  async function delegationFor(app, source, tool) {
    return cache.get(app.id, source, mintWith(app, tool), { error: (message) => new Error(`${tool}: ${app.label} ${message}`) })
  }

  /**
   * 自動タスクの回合を誰の委託で動かすか（IM 発信者なし・auto-tasks に登録された会話）。
   *  - 分類：いま動いている回（activeRun）のタスクの source.delegation。回の外ならその会話のタスクの source.delegation（1 種類のときだけ）
   *  - `<class>=each`：その回の起動事件で業務システムに委託を発行させる（{ event: { id } }）。導入先が unattendedDelegates の
   *    <class> に 'each' と書いたときだけ（install.mjs --auto-task-delegate <class>=each）。回の外・事件の無い回は拒否
   *  - `<class>`：unattendedDelegates の <class> の職員、無ければ既定（unattendedOnBehalfOf）
   * → { source, delegationClass } | { event, delegationClass } | { deny: reason } | null（委託の設定が無い：従来どおり既定の拒否へ）
   */
  async function unattendedPlan(app, sessionId) {
    let delegates = {}
    try { delegates = unattendedDelegates() ?? {} } catch { delegates = {} }
    const fallback = apiSource(unattended())
    let run = null
    try { run = (await activeRun(sessionId, app.id)) ?? null } catch { run = null }
    if (run && run.applicationId && String(run.applicationId) !== app.id) {
      return { deny: `this automatic-task run belongs to application "${run.applicationId}", not "${app.id}"` }
    }
    let spec = run ? parseDelegationSpec(run.delegation) : null
    if (!run) {
      let declared = []
      try { declared = (await sessionDelegations(sessionId, app.id)) ?? [] } catch { declared = [] }
      const specs = [...new Set(declared.filter((d) => typeof d === 'string'))].map(parseDelegationSpec).filter(Boolean)
      if (specs.length === 1) spec = specs[0]
      else if (specs.length > 1 && specs.every((s) => s.each)) spec = specs[0]
    }
    if (spec?.each) {
      if (delegates[spec.class] !== 'each') {
        return { deny: `the per-person delegation of "${spec.class}" is not enabled for automatic tasks (the operator enables it with --auto-task-delegate ${spec.class}=each)` }
      }
      if (!run) return { deny: 'a per-person automatic task acts only during one of its triggered runs' }
      const id = eventIdForRequest(run.eventId)
      if (id === null) return { deny: 'this automatic-task run has no business event to be delegated by' }
      return { event: { id }, eventType: run.eventType ?? null, delegationClass: spec.class }
    }
    const own = spec?.class ? apiSource(delegates[spec.class]) : null
    const source = own ?? fallback
    return source ? { source, delegationClass: own ? spec.class : null } : null
  }

  /** 自動タスクの委託が何か設定されているか（既定の職員か、分類ごとの職員・'each'）。 */
  function hasUnattendedDelegation() {
    if (apiSource(unattended())) return true
    let delegates = {}
    try { delegates = unattendedDelegates() ?? {} } catch { delegates = {} }
    return Object.values(delegates).some((d) => d === 'each' || apiSource(d))
  }

  function warnRole(app, delegation, delegationClass) {
    let roles = []
    try { roles = unattendedWarnRoles() ?? [] } catch { roles = [] }
    if (!delegation?.role || !Array.isArray(roles) || !roles.includes(delegation.role)) return
    const key = `${app.id}\u0001${delegationClass ?? ''}\u0001${delegation.userId ?? ''}`
    if (warned.has(key)) return
    warned.add(key)
    logger.warn?.('%s: automatic tasks%s run on behalf of an employee with the role "%s"; a narrower delegate is recommended (--auto-task-delegate <class>=<platform>:<userId>)',
      app.id, delegationClass ? ` of the delegation class "${delegationClass}"` : '', delegation.role)
  }

  function delegated(app, delegation, { source, ...extra } = {}) {
    return {
      mode: 'delegated',
      delegationToken: delegation.token,
      userId: delegation.userId ?? null,
      applicationId: app.id,
      cacheKey: delegation.key ?? delegationKey(app.id, source),
      ...extra,
    }
  }

  /** ボット（信頼できる発信元）→ アプリケーション ID。レジストリが無ければ null（= 判定しない）。 */
  function applicationIdOf(source) {
    if (!source) return null
    if (source.applicationId) return String(source.applicationId)
    const reg = registry()
    if (!reg || typeof reg.resolveApplication !== 'function') return undefined
    return reg.resolveApplication(source)?.id ?? null
  }

  async function authorize(tool, exec, { write = false } = {}) {
    const app = appOf()
    if (!app) throw new Error(`${tool}: not allowed — no business application is configured for these tools`)
    const sessionId = sessionIdOf(exec)
    // 業務 Web の AI アシスタントの会話：本人の委託だけ（未連携・自動タスク・ai-readonly の分岐には落とさない）
    const panel = assistant()
    if (sessionId && panel && typeof panel.isAssistantSession === 'function' && panel.isAssistantSession(sessionId)) {
      const panelApp = (typeof panel.applicationIdForSession === 'function' ? panel.applicationIdForSession(sessionId) : null)
        ?? panel.applicationId ?? registry()?.default?.()?.id ?? app.id
      if (panelApp !== app.id) {
        throw new Error(`${tool}: not allowed — this assistant conversation belongs to application "${panelApp}", not "${app.id}"`)
      }
      let delegation
      try {
        delegation = await panel.delegationForSession(sessionId, exec)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        logger.info?.('%s: %s denied in an assistant conversation', app.id, tool)
        throw new Error(`${tool}: not allowed — ${reason}`)
      }
      if (delegation?.token) {
        return { mode: 'delegated', delegationToken: delegation.token, userId: delegation.userId ?? null, applicationId: app.id, cacheKey: `assistant:${sessionId}`, assistant: true }
      }
      throw new Error(`${tool}: not allowed — the assistant conversation has no employee delegation`)
    }
    const service = identity()
    let current = null
    if (sessionId && service && typeof service.forSession === 'function') {
      try {
        current = await service.forSession(sessionId)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`${tool}: could not verify the sender of this conversation (${reason})`)
      }
    }
    // 会話（ボット）のアプリケーションと、このツールのアプリケーションが違えば使わせない（委託トークンも取らない）
    if (current) {
      const currentApp = current.applicationId === undefined ? undefined : current.applicationId
      if (currentApp === null) {
        throw new Error(`${tool}: not allowed — the bot of this conversation is not assigned to application "${app.id}"`)
      }
      if (currentApp !== undefined && String(currentApp) !== app.id) {
        throw new Error(`${tool}: not allowed — this conversation belongs to application "${currentApp}", not "${app.id}"`)
      }
    }
    // グループ会話（1:1 でない会話）：既定では業務ツールを使わせない。発言者本人の権限の範囲でも、答え（氏名・健康情報など）が
    // グループの他の人に見えるため（N1b）。未連携・ai-readonly の分岐にも落とさない（読み取りも AI 自身の権限も許さない）。
    if (current && isGroupConversation(current.source)) {
      let allowed = false
      try { allowed = groupChatPolicy(groupPolicy()) === 'allow' } catch { allowed = false }
      if (!allowed) {
        logger.info?.('%s: %s denied (group conversation)', app.id, tool)
        throw new Error(`${tool}: not allowed — ${toolKind} are not available in a group conversation (the answer would be visible to the other members). `
          + `Do not answer business questions here; reply only: 「${GROUP_CHAT_GUIDE}」`)
      }
    }
    let reason = current ? 'the sender of this conversation is not linked to an employee'
      : 'this conversation has no IM sender (e.g. a DSH Web owner session)'
    if (current?.linked) {
      try {
        const delegation = await delegationFor(app, current.source, tool)
        return delegated(app, delegation, { source: current.source })
      } catch (error) {
        if (error?.status !== 404) throw error
        // identity_not_linked: the link was removed after we cached it.
        service.invalidate?.(current.source)
        cache.forget(app.id, current.source)
        reason = 'the sender of this conversation is no longer linked to an employee'
      }
    }
    // 定時業務報告（dsh-proactive の business モードの起動）のターンにも IM 発信者がいない。その会話で本人が「定時報告 オン」にした
    // 会話に限り、business モードの起動ターンの実行中だけ、本人の委任で読み取りを許す。提案（write）は許さない。
    if (!current && sessionId && !write) {
      let wake = null
      try { wake = activeWake(sessionId) } catch { wake = null }
      const owner = wake?.mode === 'business' ? reportOwner(sessionId) : null
      if (owner && apiSource(owner)) {
        const ownerApp = applicationIdOf(owner)
        if (ownerApp !== undefined && ownerApp !== app.id) {
          throw new Error(`${tool}: not allowed — the scheduled report of this conversation belongs to ${ownerApp ? `application "${ownerApp}"` : 'no application'}, not "${app.id}"`)
        }
        try {
          const delegation = await delegationFor(app, owner, tool)
          return delegated(app, delegation, { source: owner, proactive: true })
        } catch (error) {
          if (error?.status !== 404) throw error
          cache.forget(app.id, owner)
          throw new Error(`${tool}: not allowed — the employee who enabled the scheduled report in this conversation is no longer linked`)
        }
      }
    }
    // 自動タスク（event / schedule のターン）には IM 発信者がいない。委託が設定されているとき（unattendedOnBehalfOf・
    // unattendedDelegates）だけ、auto-tasks に登録された会話（このアプリケーションのもの）に限り、その回の playbook の
    // 委託の分類の職員（`<class>=each` は起動事件の本人に業務システムが発行する委託）で読み取りと指定の提案を許す。
    // 未連携の IM 発信者・DSH Web の owner 会話には適用しない。
    if (!current && sessionId && hasUnattendedDelegation() && await isAutoTaskSession(sessionId, app.id)) {
      const plan = await unattendedPlan(app, sessionId)
      if (plan?.deny) {
        logger.info?.('%s: %s denied in an automatic task (%s)', app.id, tool, plan.deny)
        throw new Error(`${tool}: not allowed — ${plan.deny}`)
      }
      if (plan) {
        if (write && !unattendedWriteTools.has(tool)) {
          throw new Error(`${tool}: not allowed in an automatic task — only ${[...unattendedWriteTools].join(' / ')} may propose there`)
        }
        if (plan.event) {
          let delegation
          try {
            delegation = await cache.getForEvent(app.id, plan.event.id, mintWith(app, tool), { error: (message) => new Error(`${tool}: ${app.label} ${message}`) })
          } catch (error) {
            if (error instanceof Error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 401) {
              throw new Error(`${tool}: not allowed — ${app.label} issues no delegation for the event that started this automatic task (${error.code ?? error.status})`)
            }
            throw error
          }
          warnRole(app, delegation, plan.delegationClass)
          return {
            mode: 'delegated',
            delegationToken: delegation.token,
            userId: delegation.userId ?? null,
            applicationId: app.id,
            cacheKey: delegation.key,
            unattended: true,
            perEvent: true,
            delegationClass: plan.delegationClass,
          }
        }
        let delegation
        try {
          delegation = await delegationFor(app, plan.source, tool)
        } catch (error) {
          if (error?.status === 404) {
            cache.forget(app.id, plan.source)
            throw new Error(`${tool}: the employee configured ${plan.delegationClass ? `for the delegation class "${plan.delegationClass}"` : 'in unattendedOnBehalfOf'} is not linked in ${app.label} (${plan.source.platform})`)
          }
          throw error
        }
        warnRole(app, delegation, plan.delegationClass)
        return delegated(app, delegation, { source: plan.source, unattended: true, ...(plan.delegationClass ? { delegationClass: plan.delegationClass } : {}) })
      }
    }
    if (policy() === 'ai-readonly' && !write) return { mode: 'ai', applicationId: app.id }
    logger.info?.('%s: %s denied (%s)', app.id, tool, reason)
    // 案内は発信者の有無で変える。DSH Web の owner 会話は SNS 連携しても使えるようにならない。
    const hint = current ? denyHints.linked : denyHints.noSender
    throw new Error(`${tool}: not allowed — ${reason}. ${toolKind} run only on behalf of a linked employee; ${hint}`)
  }

  /** 職員（userId）の委託 token を捨てる（本人の連携解除）。このアプリケーションのものだけ。platform 指定時はそのプラットフォームのみ。 */
  function forgetUser(userId, platform, applicationId) {
    const app = appOf()
    if (applicationId && app && String(applicationId) !== app.id) return 0
    return cache.forgetUser(userId, platform, app?.id)
  }

  function forget(key) {
    if (typeof key === 'string' && key.startsWith('assistant:')) {
      try { assistant()?.invalidate?.(key.slice('assistant:'.length)) } catch { /* noop */ }
      return true
    }
    return cache.forget(key)
  }

  return { authorize, forget, forgetUser, clear: () => cache.forgetApplication(appOf()?.id), size: () => cache.size(), delegations: cache }
}

/**
 * ツールに gate を掛ける：呼び出しごとに認可し、その呼び出し元の権限で実行する。
 * 401（委託トークンの失効・職員の無効化・連携解除）は一度だけ取り直して再試行する（無効化・解除なら認可で拒否される）。
 */
export function guardTool(gate, tool, { write = false, open = false } = {}) {
  const run = tool.execute
  const access = open ? 'open' : write ? 'propose' : 'read'
  return {
    ...tool,
    async execute(args, exec) {
      if (open) return run(args, exec)
      const principal = { ...(await gate.authorize(tool.name, exec, { write })), access }
      try {
        return await callPrincipal.run(principal, () => run(args, exec))
      } catch (error) {
        if (error?.status !== 401 || principal.mode !== 'delegated') throw error
        gate.forget(principal.cacheKey)
        const retry = { ...(await gate.authorize(tool.name, exec, { write })), access }
        return callPrincipal.run(retry, () => run(args, exec))
      }
    },
  }
}

/**
 * ツール定義。access: 'read'（GET のみ）| 'propose'（業務システムへの「提案」だけ）| 'open'（委託不要の稼働確認など）。
 * 返り値は DSH の tools.register に渡せる形（access は registerTools が gate に渡すために別に持つ）。
 */
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('defineTool: spec must be an object')
  const { access = 'read', ...tool } = spec
  if (!TOOL_NAME_RE.test(String(tool.name ?? ''))) throw new TypeError(`defineTool: invalid tool name ${JSON.stringify(tool.name)}`)
  if (!TOOL_ACCESS.includes(access)) {
    throw new TypeError(`defineTool: ${tool.name}: access must be one of ${TOOL_ACCESS.join(' | ')} (writes are proposals only)`)
  }
  if (typeof tool.execute !== 'function') throw new TypeError(`defineTool: ${tool.name}: execute must be a function`)
  if (typeof tool.description !== 'string' || !tool.description.trim()) throw new TypeError(`defineTool: ${tool.name}: description is required`)
  tool.parameters ??= { type: 'object', properties: {}, additionalProperties: false }
  Object.defineProperty(tool, 'access', { value: access, enumerable: false })
  return tool
}

/** ツール名がアプリケーションの名前空間（`<namespace>_`）にあるか。 */
export function inNamespace(app, toolName) {
  return Boolean(app?.namespace) && String(toolName).startsWith(`${app.namespace}_`)
}

/**
 * ツール群を登録する（名前空間の確認＋gate）。
 * @param {{register: (tool) => any}} registrar  ctx.tools
 * @param {object} gate                          createDelegationGate
 * @param {Array<object>} tools                  defineTool の結果（access を持つ）、または { tool, access }
 * @param {object} [opts]
 * @param {object} [opts.application]            名前空間を確かめるアプリケーション
 */
export function registerTools(registrar, gate, tools, { application } = {}) {
  const names = []
  for (const entry of tools) {
    const tool = entry?.tool ?? entry
    const access = entry?.tool ? entry.access : tool.access ?? 'read'
    if (application && !inNamespace(application, tool.name)) {
      throw new TypeError(`tool ${tool.name} is outside the namespace "${application.namespace}_" of application "${application.id}"`)
    }
    registrar.register(guardTool(gate, tool, { write: access === 'propose', open: access === 'open' }))
    names.push(tool.name)
  }
  return names
}

// ── manifest から生成する読み取りツール ───────────────────────────────────

function resolveInputSchema(manifest, input) {
  if (!input || typeof input !== 'object') return { type: 'object', properties: {}, additionalProperties: false }
  if (typeof input.$ref === 'string') {
    const m = /^#\/schemas\/([A-Za-z0-9_]+)$/.exec(input.$ref)
    const schema = m ? manifest?.schemas?.[m[1]] : null
    return schema && typeof schema === 'object' ? structuredClone(schema) : { type: 'object', properties: {}, additionalProperties: false }
  }
  return structuredClone(input)
}

const MAX_RENDER = 4000

/**
 * manifest の tools から、生成できる読み取りツール（access: read かつ `GET <path>`、または open）を作る。
 * 名前空間の外の名前（他のアプリケーションの `<namespace>_*` 等）・propose・GET 以外は作らない（skipped に理由）。
 * @returns {{ tools: Array, skipped: Array<{name, reason}> }}
 */
export function manifestTools(app, { requestJson, skip = new Set() } = {}) {
  const manifest = app?.manifest?.()
  const out = { tools: [], skipped: [] }
  if (!manifest || !Array.isArray(manifest.tools)) return out
  for (const entry of manifest.tools) {
    const name = String(entry?.name ?? '')
    if (skip.has(name)) { out.skipped.push({ name, reason: 'already registered' }); continue }
    if (!inNamespace(app, name) || !TOOL_NAME_RE.test(name)) { out.skipped.push({ name, reason: `outside namespace ${app.namespace}_` }); continue }
    if (entry.access !== 'read') { out.skipped.push({ name, reason: 'only read tools are generated (proposals need a hand-written tool)' }); continue }
    const m = /^GET\s+(\/\S*)$/.exec(String(entry.http ?? ''))
    if (!m) { out.skipped.push({ name, reason: 'only GET endpoints are generated' }); continue }
    const pathTemplate = m[1]
    // the manifest's help tool (manifest.help.tool): the manual search with its own rendering and URL rules (help-tool.js)
    if (manifest.help?.tool === name && !pathTemplate.includes('{')) {
      out.tools.push(defineTool(helpToolSpec({ name, path: pathTemplate, requestJson, systemName: app.name })))
      continue
    }
    const pathParams = [...pathTemplate.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((x) => x[1])
    const parameters = resolveInputSchema(manifest, entry.input)
    const declared = parameters.properties && typeof parameters.properties === 'object' ? Object.keys(parameters.properties) : []
    const strict = parameters.additionalProperties === false
    const open = entry.open === true
    const tool = defineTool({
      name,
      access: open ? 'open' : 'read',
      description: `Read-only: ${String(entry.description ?? name)} (${app.name}; generated from the business manifest)`,
      parameters,
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args, result) => {
          let body = ''
          try { body = JSON.stringify(result?.data ?? null) } catch { body = '[unserializable]' }
          return [{ type: 'text', text: body.length > MAX_RENDER ? `${body.slice(0, MAX_RENDER)}… (truncated)` : body }]
        },
      },
      async execute(args = {}) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${name}: arguments must be an object`)
        const unknown = strict ? Object.keys(args).filter((k) => !declared.includes(k) && !pathParams.includes(k)) : []
        if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
        for (const req of Array.isArray(parameters.required) ? parameters.required : []) {
          if (args[req] === undefined || args[req] === null || args[req] === '') throw new Error(`${name}: "${req}" is required`)
        }
        let path = pathTemplate
        for (const p of pathParams) {
          const value = args[p]
          if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${name}: "${p}" is required`)
          const text = String(value).trim()
          if (!text) throw new Error(`${name}: "${p}" must be non-empty`)
          path = path.replace(`{${p}}`, encodeURIComponent(text))
        }
        const query = {}
        for (const [key, value] of Object.entries(args)) {
          if (pathParams.includes(key) || value === undefined || value === null) continue
          if (typeof value === 'object') throw new Error(`${name}: "${key}" must be a scalar`)
          query[key] = value
        }
        const body = await requestJson(name, path, query)
        return { ok: true, data: body }
      },
    })
    out.tools.push(tool)
  }
  return out
}

/**
 * manifest から生成した読み取りツールを登録する。
 * @returns {{ registered: string[], skipped: Array<{name, reason}> }}
 */
export function registerManifestTools(registrar, { application, gate, requestJson, skip = new Set(), logger = console } = {}) {
  const { tools, skipped } = manifestTools(application, { requestJson, skip })
  const registered = registerTools(registrar, gate, tools, { application })
  for (const s of skipped) logger.debug?.('bridge: %s tool %s not generated (%s)', application?.id, s.name, s.reason)
  return { registered, skipped }
}

/**
 * 「その会話は auto-tasks に登録された自動タスクの会話か」（このアプリケーションの）。
 * タスクに applicationId があれば一致するものだけ（無いタスクは単一アプリケーション時代のもの＝どのアプリケーションでも可）。
 * @param {() => any} autoTasks  ctx.autoTasks 相当（list({sessionId})）
 */
export function autoTaskSessionChecker(autoTasks) {
  return async (sessionId, applicationId) => {
    const service = autoTasks()
    if (!service || typeof service.list !== 'function') return false
    try {
      const tasks = await service.list({ sessionId })
      return Array.isArray(tasks) && tasks.some((t) => t?.sessionId === sessionId && t.enabled !== false
        && (!t.applicationId || !applicationId || t.applicationId === applicationId))
    } catch {
      return false
    }
  }
}

/**
 * 自動タスクの回と委託の分類（createDelegationGate の activeRun / sessionDelegations）。
 *  - activeRun(sessionId, applicationId)：ctx.autoTasks.activeRun(sessionId)（いま動いている回。無い auto-tasks では null）。
 *    回のタスクがその会話に結び付いていること、別のアプリケーションのタスクでないことは gate と auto-tasks が確かめる。
 *  - sessionDelegations(sessionId, applicationId)：その会話の有効なタスク（このアプリケーションのもの）の source.delegation
 * @param {() => any} autoTasks  ctx.autoTasks 相当
 */
export function autoTaskRunResolver(autoTasks) {
  return {
    async activeRun(sessionId) {
      const service = autoTasks()
      if (!service || typeof service.activeRun !== 'function') return null
      try {
        const run = await service.activeRun(sessionId)
        return run && typeof run === 'object' && (run.sessionId === undefined || run.sessionId === sessionId) ? run : null
      } catch {
        return null
      }
    },
    async sessionDelegations(sessionId, applicationId) {
      const service = autoTasks()
      if (!service || typeof service.list !== 'function') return []
      try {
        const tasks = await service.list({ sessionId })
        return (Array.isArray(tasks) ? tasks : [])
          .filter((t) => t?.sessionId === sessionId && t.enabled !== false && (!t.applicationId || !applicationId || t.applicationId === applicationId))
          .map((t) => t.source?.delegation)
          .filter((d) => typeof d === 'string' && d)
      } catch {
        return []
      }
    },
  }
}

export { sourceKey, apiSource }
