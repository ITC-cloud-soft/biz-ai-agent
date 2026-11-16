/** dsh-auto-tasks 核心域类型（宿主与客户端共享的契约）。 */

export type WakeBackend = 'schedule' | 'proactive'
export type TriggerType = 'cron' | 'every' | 'daily' | 'after' | 'event'
export type ReportStatus = 'done' | 'failed' | 'needsDecision' | 'silent'

export interface Trigger {
  type: TriggerType
  expr?: string
  timeZone?: string
  everySeconds?: number
  dailyTime?: string
  afterSeconds?: number
  jitterSeconds?: number
  /** type='event'：由 ctx.autoTasks.emit(eventType) 触发；支持精确匹配、`prefix.*` 与 `*`。 */
  eventTypes?: string[]
}

export interface DeliveryChannel {
  channel?: string
  botId?: string
  targetId?: string
  name?: string
}

export interface Delivery {
  channels: DeliveryChannel[]
}

export interface FeedbackPolicy {
  deliverOn?: ReportStatus[] | string[]
  respectQuietHours?: boolean
  quietHours?: { start: string; end: string; timeZone?: string } | null
}

export interface GuardPolicy {
  maxRunsPerDay?: number
  maxConsecutiveFailures?: number
  autoPause?: boolean
  requireEvidence?: boolean
}

export interface Task {
  id: string
  name: string
  instruction: string
  enabled: boolean
  approval: 'auto' | 'require'
  wakeBackend: WakeBackend
  /** schedule=核心排程；poll=由外部轮询器（如邮件轮询）触发，不建排程。 */
  triggerMode?: 'schedule' | 'poll'
  proactiveAlarmId: string | null
  scheduleId: string | null
  trigger?: Trigger
  sessionId: string
  workspacePath: string | null
  delivery: Delivery
  feedback: FeedbackPolicy
  guard: GuardPolicy
  createdAt?: string
  updatedAt?: string
  failureStreak?: number
  pausedAt?: string | null
  pauseReason?: string | null
  lastError?: string | null
  lastReportAt?: string
  runsToday?: number
  source?: unknown
  /** @care（Bridge 多应用）：任务所属的业务应用（由 manifest playbook 部署的任务才有）。只被该应用的事件唤醒。 */
  applicationId?: string
  /** @care（Bridge 多应用）：playbook 的 audience（如 `{ rule: 'managers' }`）。有 audience 的应用任务按收件人动态投递。 */
  audience?: { rule?: string; [key: string]: unknown } | null
  /**
   * @care（#14）：事件任务没有 sessionId 时，第一次运行前用这个 Agent 预设自动开设一个专用会话（宿主 Harness 的
   * session.create），并把 sessionId 写回 tasks.json。没有 sessionPreset 的任务仍然需要运维绑定会话（no_session）。
   */
  sessionPreset?: string | null
}

export interface ReportDelivery {
  channel?: string
  botId?: string
  targetId?: string
  ok: boolean
  attempts?: number
  error?: string
}

export interface Report {
  id: string
  taskId: string
  taskName: string
  at: string
  status: ReportStatus
  summary: string
  artifacts: string[]
  read: boolean
  delivered: ReportDelivery[]
  deferred?: string
  verifyFailed?: string
  approvedAt?: string
  approvedScheduleId?: string
  /** 由 ctx.autoTasks.trigger/emit 发起的运行 id（模型在汇报时回传）。 */
  runId?: string
}

/** ctx.autoTasks.trigger / emit 发起的一次运行（持久化在 runs.json，用于 dedupeKey 去重）。 */
export interface TaskRun {
  runId: string
  taskId: string
  at: string
  source: 'trigger' | 'event'
  reason: string
  eventType?: string
  dedupeKey?: string
  /** 渲染后的 payload（截断）；审批后重跑时复用。 */
  payloadText?: string | null
  scheduleId?: string | null
  /** 首次成功投递的报告 id；同一运行的后续报告不再重复投递。 */
  deliveredReportId?: string
  reportIds?: string[]
  /** @care（Bridge 多应用）：emit 时带来的业务应用与事件 id（用于按收件人投递）。 */
  applicationId?: string
  eventId?: string
}

/** @care：emit 的作用域（Bridge 多应用）。 */
export interface EmitScope {
  /** 事件所属的业务应用。带 applicationId 的任务只被同一应用的事件唤醒。 */
  applicationId?: string
  /** 业务系统的事件 id（按收件人投递时用于解析收件人）。 */
  eventId?: string | number
  /** 没有 applicationId 的任务（单应用时代 / profile 模板）是否也被唤醒（默认 true；care-events 只对默认应用为 true）。 */
  matchUnscoped?: boolean
}

/** @care：按收件人投递（由 Bridge 插件 care-notify 实现）。handled=false 时回退到任务的固定投递目标。 */
export interface AudienceDeliveryInput {
  task: { id: string; name: string; applicationId: string; audience: Task['audience'] }
  run: { runId: string; eventType?: string; eventId?: string; dedupeKey?: string; applicationId?: string } | null
  report: { id: string; status: ReportStatus }
  text: string
  idempotencyKey: string
}
export interface AudienceDeliveryResult {
  handled: boolean
  results?: ReportDelivery[]
  reason?: string
}
export type AudienceDelivery = (input: AudienceDeliveryInput) => Promise<AudienceDeliveryResult | null | undefined>

/** @care：deployPlaybooks 的结果。 */
export interface DeployResult {
  created: string[]
  updated: string[]
  unchanged: string[]
  disabled: string[]
  skipped: Array<{ playbook: string; reason: string }>
}

export interface TriggerOptions {
  reason: string
  payload?: unknown
  dedupeKey?: string
}

export interface TriggerResult {
  runId: string
  deduped: boolean
}

export interface EmitResult {
  /** 本次新触发的任务 id（与契约一致）。 */
  triggered: string[]
  /** 因 dedupeKey 命中而跳过的任务 id。 */
  deduped: string[]
  /** 未触发的任务及原因（disabled / budget / error）。 */
  skipped: Array<{ taskId: string; reason: string }>
  runs: Array<{ taskId: string; runId: string; deduped: boolean }>
}

/** `ctx.autoTasks` 服务（由本插件 provide）。 */
export interface AutoTasksService {
  readonly contractVersion: 1
  list(filter?: { sessionId?: string; eventType?: string; all?: boolean; applicationId?: string }): Promise<Task[]>
  trigger(taskId: string, opts: TriggerOptions): Promise<TriggerResult>
  emit(eventType: string, payload?: unknown, dedupeKey?: string, scope?: EmitScope): Promise<EmitResult>
  /** @care：把业务应用 manifest 的 playbooks（事件触发）部署为任务（幂等合并，带 applicationId，新建时停用）。 */
  deployPlaybooks(applicationId: string, playbooks: Record<string, unknown>, opts?: { version?: string; applicationName?: string }): Promise<DeployResult>
  /** @care：注册按收件人投递的实现（返回注销函数）。 */
  setAudienceDelivery(fn: AudienceDelivery): () => void
  /**
   * @care（#15）：该会话里此刻正在执行的触发回合（从排程的唤醒消息被认领到该回合结束），没有则 undefined。
   * 业务工具的委托 gate 用它区分「哪一次运行、哪个事件」（例如按事件签发的委托 `<class>=each`）。
   */
  activeRun(sessionId: string): ActiveRun | undefined
}

/** @care（#15）：会话中正在执行的触发回合（ctx.autoTasks.activeRun）。 */
export interface ActiveRun {
  runId: string
  taskId: string
  sessionId: string
  /** 运行开始（唤醒消息被认领）的时刻。 */
  startedAt: string
  eventType?: string
  /** 业务系统的事件 id（emit 的 scope.eventId，没有时取事件 payload 的 id）。 */
  eventId?: string
  applicationId?: string
  /** 任务的 source.delegation（例如 'care'、'care_manager=each'）。 */
  delegation?: string
}

export interface MailImapConfig {
  host?: string
  port?: number
  secure?: boolean
  user?: string
  pass?: string
  mailbox?: string
}

export interface MailSmtpConfig {
  host?: string
  port?: number
  secure?: boolean
  requireTLS?: boolean
  user?: string
  pass?: string
  from?: string
}

export interface MailDigestConfig {
  enabled?: boolean
  time?: string
  timeZone?: string
  locale?: 'zh' | 'en'
  botId?: string
  targetId?: string
}

export interface MailConfig {
  enabled?: boolean
  taskId?: string
  imap?: MailImapConfig
  smtp?: MailSmtpConfig
  spam?: { mode?: 'move' | 'keep'; folder?: string; blocklist?: string[] }
  batchSize?: number
  pollMinutes?: number
  wakeCooldownMinutes?: number
  digest?: MailDigestConfig
  allowlist?: string[]
  [key: string]: unknown
}

export interface MailState {
  lastUid?: number | null
  initializedAt?: string
  lastPollAt?: string
  lastError?: string | null
  lastWakeAt?: string
  lastDigestDate?: string
  pollFailures?: number
  lastPollAlertAt?: string
  [key: string]: unknown
}

export interface MailCandidate {
  uid?: number
  file?: string
  from?: string
  subject?: string
  text?: string
  date?: string | null
  messageId?: string | null
  receivedAt?: string
  preview?: string
  headers?: Record<string, unknown>
  spamReason?: string
  [key: string]: unknown
}

export interface TaskListArgs { all?: boolean }

export interface ReportArgs {
  taskId: string
  runId?: string
  status: 'done' | 'failed' | 'needsDecision'
  summary: string
  artifacts?: string[]
}

export interface SilentArgs { taskId: string; reason: string; runId?: string }

export interface MailToolArgs {
  op: 'list' | 'read' | 'junk' | 'send'
  file?: string
  to?: string
  subject?: string
  text?: string
}

export interface HostContext {
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
  schedule: {
    create(sessionId: string, request: Record<string, unknown>): Promise<{ id: string }>
    delete(request: { id: string; sessionId: string }): Promise<unknown>
    catalog(): Promise<Array<{ id: string; status?: string; scheduledAt?: string }>>
  }
  get(name: string): any
  provide?(name: string, value?: unknown): unknown
  /** @care（#15）：宿主事件（'session/event' 用于跟踪触发回合）。返回注销函数。 */
  on?(name: string, listener: (...args: any[]) => unknown, options?: { global?: boolean }): (() => void) | unknown
  inject(deps: string[], cb: (ctx: HostContext) => unknown): unknown
  effect(fn: () => unknown, label?: string): unknown
  tools: { register(def: unknown, label?: string): () => void }
  webServer?: { register(route: { kind: string; path: string; handler: (...args: any[]) => unknown }): () => void }
}
