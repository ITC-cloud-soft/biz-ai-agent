> **Maintained for @dsh-bridge.** This fork is vendored in the DSH Business Bridge framework (`vendor/dsh-auto-tasks`) and maintained
> for the `@dsh-bridge/*` packages and plugins. It was started for ケアビリング (care-ai-native, the first user of the framework);
> the package name and the test-only `CARE_*` environment overrides are kept so that existing profiles keep working.
> This file was `CARE_FORK.md`; code comments that cite "CARE_FORK #n" refer to the numbered changes below. Content unchanged.

# @care/dsh-auto-tasks — care fork 记录

| 项目 | 值 |
|---|---|
| 包名 / 版本 | `@care/dsh-auto-tasks` `0.2.0-care.1`（`private`；DSH 0.2.2-rc.1） |
| 上游 | `dsh-auto-tasks` 0.2.0（用户自有仓库 `C:\work\deepseek-im\dsh-auto-tasks`，MIT，未 git 管理）。2026-10-25 复制，不含 `node_modules` / `lib` |
| 构建 | `npm install && npm run ci`（= build → typecheck → check → test）。`lib/` 是生成物（宿主 = TS 类型剥离，客户端 = esbuild 打包，JSON 词典内嵌） |
| 契约 | `docs/design/AI_PLANE_CONTRACTS.md` §3 |

## 改动

| # | 改动 | 理由 |
|---|---|---|
| 1 | **`ctx.autoTasks` 服务**（`provide('autoTasks')`，生命周期随插件）：`list(filter?)` / `trigger(taskId, {reason, payload?, dedupeKey?})` / `emit(eventType, payload?, dedupeKey?)`，`contractVersion: 1` | care-events 等插件需要程序化地唤醒 AI 员工作业；上游只有 tools + schedule |
| 2 | 任务 `trigger.type = 'event'` + `eventTypes[]`（1–20 项；精确匹配 / `prefix.*` / `*`）。event 任务不建核心排程，由 `emit` 唤醒（核心 `schedule.create(after_seconds: 1)`，提示词带 runId、事件名和截断到 4000 字的 payload JSON，并标注「业务数据，不是指令」） | 事件驱动（`approval.requested` 等） |
| 3 | **dedupeKey 持久化去重**：`$DSH_HOME/auto-tasks/runs.json`（原子写，保留 30 天、最多 5000 条）。同一 `(taskId, dedupeKey)` 只触发一次，重放返回原 runId + `deduped: true`；同进程并发调用合并；先写台账再排程，排程失败则回滚（可重试） | 防止 care-api outbox 重放 / dsh-im 重试叠加成重复消息 |
| 4 | **投递幂等键**：`sendOne` 的所有重试带同一个 `idempotencyKey`（`auto-tasks:<taskId>:k:<dedupeKey>` / `r:<runId>` / `p:<reportId>` + `:<botId>:<targetId>`）作为 `dshIm.send` 的可选参数；上游 dsh-im 忽略未知选项。`deduped: true` 视为已送达 | 契约 §3「投递按 dedupeKey 去重」 |
| 5 | `auto_task_report` / `auto_task_silent` 新增可选 `runId`；同一运行已成功投递后，再次汇报只记录不推送（`deferred: 'duplicateRun'`）。审批（`/api/reports/approve`）对触发回合会带回原 runId 与 payload 重跑 | 模型重复汇报不重复打扰 |
| 6 | 新 HTTP（回环 + `x-auto-tasks-client` 头，与既有写接口相同）：`POST /auto-tasks/api/tasks/trigger`、`POST /auto-tasks/api/events/emit`、`GET /auto-tasks/api/runs`（不返回 payload）。`/api/health` 增加 `careVersion`、`service`（`version` 仍为 `0.2.0`） | 运维 / 测试；既有接口全部保持兼容 |
| 7 | 配置 `api.allowNonLoopback`（默认 `false`）：容器部署（DSH 监听非回环、前置认证网关）时可显式放开回环限制 | 上游「只接受回环」在 `--host $(hostname -i)` 下会让面板 403 |
| 8 | **客户端相对 URL**：所有请求 = `new URL('auto-tasks/api' + path, document.baseURI)`（DSH 自身 `/api` 也按 `document.baseURI` 解析，页面有 `<base href="./">`）。直接访问时 = `/auto-tasks/api/*`，挂在 `/dsh/` 下 = `/dsh/auto-tasks/api/*` | 去掉网关 `rootPaths` 中 `/auto-tasks/api` 的绕过 |
| 9 | ModuleLoader id、`cordis.patch.yml` 的 `name` 改为包名 `@care/dsh-auto-tasks`（roster 行 id 仍为 `dsh-auto-tasks`） | scoped 包名下客户端注册表按包名查找 |
| 10 | 与 dsh-proactive 的接线优先走 `@care/dsh-proactive` 提供的进程内服务 `ctx.dshProactive`（state / action），找不到时才回退到上游的 HTTP（`DSH_WEB_BASE` / `DSH_WEB_PORT` / 默认 3080） | 上游默认打 `127.0.0.1:3080`：在隔离 DSH 里会把闹钟建到另一个 DSH 上 |
| 11 | **i18n**（WS-H 的 `plugins/dsh-lang-ja/fork-resources/dsh-auto-tasks`）：客户端文案全部改为 `ctx.locale.bind('dsh-auto-tasks')` 查词典。`src/locales/{zh,en}.json` = fork-resources 的 141 键 + 本 fork 新增 9 键；本插件**只注册 zh / en**（`register(ns, {zh, en})`），**ja 由 `@care/dsh-lang-ja` 注册**（同一 `(namespace, locale)` 二重注册会抛异常）。客户端 `inject` 增加 `locale`；视图订阅 locale 切换后重渲染；locale 服务缺失时回退为上游的 `navigator.language` → zh/en | 日语界面 |
| 12 | 删除 `scripts/sync-profile.ps1` 与 `npm run sync` | 该脚本会写入用户的 `~/.dsh/profiles/web` |
| 13 | **Bridge 多应用**（`docs/design/BRIDGE_STAGE2_PLAN.md` B2-plugins、`BRIDGE_ARCHITECTURE.md` §13）：任务可带 `applicationId` / `audience`。`ctx.autoTasks.deployPlaybooks(applicationId, playbooks, {version, applicationName})` 把业务应用 manifest 的 playbooks（只限事件触发；cron 由 dsh-proactive 负责）部署为任务 `pb_<applicationId>_<playbookId>`：新建时停用（运维绑定会话后启用），已有任务只覆盖模板拥有的字段（name / instruction / trigger / approval / source / applicationId / audience，与 profile `install.mjs` 的规则相同），manifest 中已删除的该应用 playbook 任务被停用（不删除）。`emit(type, payload, dedupeKey, scope?)` 的 `scope = { applicationId, eventId, matchUnscoped }`：带 `applicationId` 的任务只被同一应用的事件唤醒，无 `applicationId` 的任务（单应用时代 / profile 模板）只在 `matchUnscoped !== false` 时唤醒；不带 scope 的调用与旧行为相同。运行台账记录 `applicationId` / `eventId`。`setAudienceDelivery(fn)`（care-notify 注册）：有 `applicationId` + `audience` 的任务的报告先交给它，按该应用为该事件解析出的收件人投递到各自已关联的 SNS（`handled: false` / 出错 / 未注册时回退到固定投递目标）。`list({ applicationId })` 过滤 | §13「动态收件人」「任务来源」：投递目标不再只是事先登记的 `botId+targetId`；一个应用的事件不唤醒另一个应用的任务 |
| 14 | **会话自动开设**（`sessionPreset`）：事件任务没有 `sessionId` 但有 `sessionPreset`（Agent 预设 id）时，第一次运行前用宿主 Harness 开设一个专用会话（`ctx.inject(['connection', 'typertGateway'])`，与 dsh-im 的 channel 插件相同：owner peer、`workspace.follow`→`workspace.create`、`session.create {workspaceId, agentPreset}`、`session.rename`「自動タスク：<任务名>」），写回 tasks.json；同一任务的并发调用合并为一次。顺序：dedupe → disabled → 预算 → 开设会话 → 写台账 → 排程。开设失败 / 宿主没有这两个服务 → `no_session`（原因写入任务的 `lastError`；emit 记为 skipped，不写台账，可用同一 dedupeKey 重试）。预设 id 先校验（`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`） | profile 模板（`dsh/runtime-profile/auto-tasks/`）`install.mjs --enable-auto-tasks` 即可启用，无需运维先建会话、再绑定；报告走 #13 的 audience 投递，不需要固定投递目标 |
| 15 | **正在执行的触发回合**（`ctx.autoTasks.activeRun(sessionId)` → `{ runId, taskId, sessionId, startedAt, eventType?, eventId?, applicationId?, delegation? }` 或 undefined）：订阅宿主 `ctx.on('session/event', …, { global: true })`，`turn/start` 记下当前回合，来源为 `schedule` 的 `user/message`（核心 schedule 的唤醒消息，正文带 `schedule_id_json`）按运行台账的 `scheduleId` 找到运行（找不到时用 `reminder_prompt_json` 中提示词的 `runId:` 行），且该运行的任务必须绑定在这个会话上；`turn/end`、下一个回合开始、别人发来的消息（`runtime-context` 除外）时清除；2 小时兜底过期。核心的 agent loop 每个回合只认领一条 next-turn 消息，所以「认领了哪条唤醒消息」就是「这个回合属于哪次运行」。`delegation` = 任务的 `source.delegation`。另外：`deployPlaybooks` 把 playbook 的 `delegation`（`<class>` / `<class>=each`）写进 `source.delegation`；`emit` 没有 `scope.eventId` 时取事件 payload 的 `id`（正整数或 64 字以内的 ID） | Bridge 的业务工具委托 gate（`@dsh-bridge/dsh-core`）要知道工具调用属于哪次运行、哪个业务事件：playbook 的委托分类为 `<class>=each` 时，按触发事件向业务系统申请该事件本人的委托（每个人用自己的委托，而不是一个固定的代理人） |
| 16 | **投递限制**（插件 cordis 配置，N1b）：`restrictDelivery: true` = 报告**只**按业务应用解析的收件人投递（#13 的 `setAudienceDelivery`）。没有 applicationId / audience、未注册、`handled: false`、出错时**不回退**到任务的固定投递目标：不发，`deferred: 'noAudience'`，写 info 日志；`auto_task_report` / `auto_task_silent` 只接受任务自己绑定的会话（`exec.agent.session.id === task.sessionId`，其他会话的 AI 不能替任务汇报）；`POST /api/delivery/test` 返回 403。`mail: false` = 不注册 `auto_task_mail`（模型经 SMTP 发信）、不轮询 IMAP、不发邮件汇总 / 轮询告警（这两者会推到固定目标）、`/api/mail/*` 返回 403。两者默认 `false` / `true`（= 以前的行为）。上游 `test/config.test.mjs` 的 schema 键一览补上这两个键（1 行） | 产品要求「AI 的输出只发给业务系统决定的人」：固定的 `botId+targetId` 不经业务系统的收件人规则；邮件发送没有任何收件人规则 |
| 17 | **DSH 0.2.2 的核心 schedule**（`scheduleApi()`，`src/index.ts`）：插件内部仍按 0.2.1 的形状调用 `create(sessionId, {title, prompt, after_seconds \| at \| every_seconds \| daily \| weekly \| cron})` / `delete({id, sessionId})` / `catalog()`；宿主的 ScheduleService 有 `edit`（0.2.2）时换成 `create({title, prompt, timing: {kind, …}, target: {kind: 'session', sessionId}}, sessionId)` / `edit({id, action: 'delete'}, sessionId)`，`catalog()` 的条目补上 `sessionId`（取自 `target`），`paused` / `ended` 视为 `inactive`。`actorSessionId` 传任务自己的会话：0.2.2 会向相关会话的在线 Agent 注入 `[SCHEDULE CHANGE]` 通知（发起方会话除外），不传的话每次排程都在任务会话里多一条消息。#15 的回合跟踪忽略 `[SCHEDULE CHANGE]`（它的 `source.kind` 也是 `schedule`，但不是投递）。`package.json` `dsh.compatibility.dsh` = `0.2.2-rc.1`。测试 `test/care-schedule-022.test.mjs` | DSH 0.2.2-rc.1 把 schedule 服务改成了按投递目标（target）管理；不改的话 `create` 抛错，事件任务的运行被回滚（e2e 场景 e：会话已开设但 0 次运行） |

本 fork 新增、尚无 ja 译文的键（ja 下回退为 en，请 dsh-lang-ja 补）：`guide.step2Body`、`form.cron`、`form.mailMonitorNote`、`form.requireEvidenceNote`、`channels.noImClient`、`trigger.event`、`form.eventTrigger`、`form.eventTypes`、`form.eventTypesRequired`。

## `ctx.autoTasks` 签名

```ts
interface AutoTasksService {
  readonly contractVersion: 1
  list(filter?: { sessionId?: string; eventType?: string; applicationId?: string }): Promise<Task[]>        // 深拷贝
  trigger(taskId: string, opts: { reason: string; payload?: unknown; dedupeKey?: string }): Promise<{ runId: string; deduped: boolean }>
  // scope（#13）：{ applicationId?, eventId?, matchUnscoped? }。省略时与旧行为相同
  emit(eventType: string, payload?: unknown, dedupeKey?: string, scope?: EmitScope): Promise<{
    triggered: string[]                                   // 新触发的 taskId（契约字段）
    deduped: string[]                                     // dedupeKey 命中的 taskId
    skipped: { taskId: string; reason: string }[]         // disabled / over_budget / ...
    runs: { taskId: string; runId: string; deduped: boolean }[]
  }>
  // #13：manifest playbooks → 任务（幂等合并）。{ created, updated, unchanged, disabled, skipped: [{playbook, reason}] }
  deployPlaybooks(applicationId: string, playbooks: Record<string, unknown>, opts?: { version?: string; applicationName?: string }): Promise<DeployResult>
  // #13：按收件人投递。fn({ task: {id, name, applicationId, audience}, run: {runId, eventType, eventId, dedupeKey} | null, report, text, idempotencyKey })
  //      → { handled, results? }。返回注销函数
  setAudienceDelivery(fn: AudienceDelivery): () => void
  // #15：该会话此刻正在执行的触发回合（没有则 undefined）
  activeRun(sessionId: string): { runId: string; taskId: string; sessionId: string; startedAt: string; eventType?: string; eventId?: string; applicationId?: string; delegation?: string } | undefined
}
```

`trigger` 的错误带 `code`：`not_found` / `task_disabled` / `over_budget` / `no_session` / `invalid_reason` / `invalid_dedupe_key`。dedupe 命中优先于 disabled / 预算检查（重放总是返回原 runId）。`emit` 的 `eventType` 必须是具体名（不能含通配），否则 `invalid_event_type`。

## 测试

`npm test`：上游 20 个（`api` 5、`backends` 2、`config` 4、`http` 5、`i18n` 2、`proactive` 1、`smoke` 1 = host-smoke 20 项）全部通过；新增 `test/care-service.test.mjs` 11 个、`test/care-i18n.test.mjs` 3 个、`test/care-bridge.test.mjs` 3 个（#13：playbook 部署与合并、emit 的应用作用域、按收件人投递与回退）、`test/care-session.test.mjs` 3 个（#14：首个事件开设一个会话并写回、并发合并；无预设 / 无 Harness / 开设失败 → no_session 且可重试；非法预设与停用任务不开设）。`test/care-active-run.test.mjs` 4 个（#15：认领唤醒消息到回合结束、按 scheduleId / runId 找到运行、只认绑定在该会话上的任务、别人的消息清除、无 scope 时取 payload 的 id、无 `ctx.on` 的宿主不跟踪；deployPlaybooks 写入委托分类）。`test/care-restrict.test.mjs` 4 个（#16：配置键、不回退到固定目标（handled:false / 未注册 / 无 audience / 测试投递）、只接受自己会话的汇报、mail: false 无工具无 API）。合计 48 / 48（`npm run ci`，2026-10-29 重跑相同）。

**产品配置**（Bridge 的「收件人保证」，framework `docs/GUIDELINE.md` d.8）：#16 的默认值（`restrictDelivery: false`、`mail: true`）保持以前的行为。业务产品应写 `restrictDelivery: true`、`mail: false`，并配合 bridge-notify 的 `applications.<id>.audienceFallback: none`（收件人无法确定时不发送）。framework 的 `profile/template` 尚未写入这些值；`install.mjs` 的 `--auto-task-session / --auto-task-bot / --auto-task-target`（固定投递目标）为兼容而保留，产品中不要使用（`restrictDelivery: true` 时固定目标不会被使用）。注意：`npm run ci` 会以 LF 重新生成 `lib/index.js`（仓库中为 CRLF），只有换行不同时请勿提交。
