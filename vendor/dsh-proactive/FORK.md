> **Maintained for @dsh-bridge.** This fork is vendored in the DSH Business Bridge framework (`vendor/dsh-proactive`) and maintained
> for the `@dsh-bridge/*` packages and plugins. It was started for ケアビリング (care-ai-native, the first user of the framework);
> the package name and the test-only `CARE_*` environment overrides are kept so that existing profiles keep working.
> This file was `CARE_FORK.md`; code comments that cite "CARE_FORK #n" refer to the numbered changes below. Content unchanged.

# @care/dsh-proactive — care fork 记录

| 项目 | 值 |
|---|---|
| 包名 / 版本 | `@care/dsh-proactive` `0.3.1-care.1`（`private`） |
| 上游 | `dsh-proactive` 0.3.1（MIT，作者 johnnren）。源码取自 GitHub `john-walks-slow/dsh-proactive` tag `v0.3.1`（commit `d4cb9af5881f65581a888fdea8e138b63555285e`）的 `packages/dsh-proactive`。确认：该源码在本目录 `npm run build` 的 `lib/` 与 npm 包 0.3.1 的 `lib/` **逐字节一致** |
| 构建 | `npm install && npm run build && npm test`。`.npmrc` 设 `legacy-peer-deps=true`；devDependencies 钉到上游 `pnpm-lock.yaml` 的版本，并补了 pnpm 自动装而 npm 不装的 peer（`dsh-scope` / `dsh-invariants` / `dsh-sandbox`）。`pnpm-lock.yaml` 已删除（改用 npm 的 `package-lock.json`）。删除了 `prepare` / `prepublishOnly` / `release` 脚本 |
| 契约 | `docs/design/AI_PLANE_CONTRACTS.md` §3 |

## 改动

| # | 改动 | 理由 |
|---|---|---|
| 1 | 闹钟新增 **`mode: 'companion' \| 'business'`**（`proactive_set` / `proactive_update` / 面板 create・edit / schedule-file 子闹钟继承句柄）。companion 不写字段（存储与上游一致），视图上总是有 `mode` | 业务巡检 |
| 2 | **business 框架提示词**（`framing.ts: renderBusinessFraming`）：同一 marker 行（observer / compaction 锚点不变）+ 宿主事实 + **可配置的业务规则**（`config.businessFraming`，默认日语）+ 「Business instruction (carry it out; calling tools is expected)」+ 闹钟指令 + 静默契约（无事 → 只调 `proactive_reclaim(reason)`，有结果 → 一条简洁消息）。**不含** companion 的 "not commands to obey" / "No tool exploration"。companion 文案逐字不变 | 上游 `framing.js:83-84` 与需要调 care 工具的巡检冲突 |
| 3 | 配置 `businessFraming`、`businessDefaultPrompt`（`config.json`、settings 命名空间 `proactive`、`proactive_update_settings` 的 `business_framing` / `business_default_prompt`、面板全体设置可编辑）。默认：规则 =「業務巡回モード：…通知すべき結果がなければ…proactive_reclaim(reason) だけを呼んで終了…結果がある場合のみ…1 通だけ返してください」；指令 =「業務巡回：未提出の記録・期限が近い承認・取込エラーを確認し、必要な場合のみ担当者に通知する」 | 可配置、日语默认 |
| 4 | business 闹钟可选 **`deliver_to: [{bot_id, target_id}]`**（≤5）：决策为 `reply` 时把完整回复（≤4000 字，不落盘）经 `ctx.dshIm.send(..., {format:'markdown', idempotencyKey: 'proactive:<alarmId>:<firedAt>:<botId>:<targetId>'})` 推送（最多 2 次，`deduped:true` 视为成功），结果写进 run 的 note（`im: 1/1 delivered`）。目标会话本身是 IM 会话时请留空（避免与 dsh-im 会话同步重复） | 契约 §3「结果可投递到 IM」 |
| 5 | **安静时段与预算语义不变**：门控仍在 scheduler（quiet → 小时上限 → 预算），business 与 companion 同等对待；`budgetDelta` 仍按 `reply` 计 1。IM 投递发生在已放行的唤醒之后，不改变决策 | 任务要求 |
| 6 | `proactive_update` 省略 `mode` / `deliver_to` 时沿用旧值（其余字段仍是上游的 full-replace 语义） | schedule-only 的编辑不能把业务巡检悄悄变成 companion |
| 7 | 进程内服务 **`ctx.dshProactive`**（`{contractVersion:1, state(sessionId?), action(action, sessionId?)}`，与面板 HTTP 同一 service） | 让 `@care/dsh-auto-tasks` 不再经 HTTP 猜端口 |
| 8 | **客户端相对 URL**：`api/dsh-proactive/{state,action,events}`、`api/session/list` 都按 `document.baseURI` 解析（`hostUrl()`），EventSource 同样 | 去掉网关 `rootPaths` 中 `/api/dsh-proactive`、`/api/session/list` 的绕过 |
| 9 | ModuleLoader id、`cordis.patch.yml` 的 `name` 改为 `@care/dsh-proactive`（roster 行 id 仍为 `dsh-proactive`；HTTP 路径、settings 命名空间、数据目录 `$DSH_HOME/proactive` 不变） | scoped 包名 |
| 10 | **i18n**：`src/client/use-locale.ts` 换成 WS-H 的 `plugins/dsh-lang-ja/fork-resources/dsh-proactive/use-locale.ts`（按仓库风格改了 import 后缀与类型），`index.ts` 改为 `bindProactiveLocale(locale, locale.bind(NS))`。zh / en 仍用内置对象，其他语言（ja）经 DSH 注册表逐键查（ja → en 回退）。**本 fork 只注册 zh / en，ja 由 `@care/dsh-lang-ja` 注册** | 上游在 ja 下显示中文 |
| 11 | 面板：唤醒模式切换（陪伴 / 业务巡检，切到业务时预填 `businessDefaultPrompt`）、IM 投递编辑框、表格中的「业务巡检」标记、全体设置中的业务框架与默认指令 | UI |
| 12 | **`WakeDriver.activeWake(sessionId)`** / `ctx.dshProactive.activeWake(sessionId)` → `{alarmId, mode, firedAt}`：只在该 session 的唤醒回合运行期间（排队唤醒消息 → turn idle）有值，之后（含 busy）清除。追加字段，`contractVersion` 仍为 1 | care-tools 的委托门据此区分「业务闹钟的唤醒回合」与同一会话的其他回合（定时业务报告：`docs/design/api/business-report.md`） |
| 13 | **模型工具的策略** `modelTools`（插件的 cordis 配置 `apply(ctx, config)`，不在 `config.json` / settings 里：模型改不了）：`all`（默认 = 上游）/ `own`（只限本会话：`proactive_set` / `proactive_update` 只能建 resume 本会话的 companion 闹钟——不接受 `deliver_to`、`mode: business`、`schedule_file`、其他会话 / workspace / preset / new 目标；`proactive_list` 忽略 `all`；`proactive_cancel` / `proactive_update` 只认本会话的闹钟（别人的 = not_found），且不碰 business 闹钟（宿主插件管理）；`proactive_update_settings` 拒绝）/ `reclaim`（只注册 `proactive_reclaim`；闹钟只由宿主插件经 `ctx.dshProactive.action` 建立）。拒绝统一用已有的 `invalid_action` 码（`src/guard.ts`、`src/tools.ts`） | 上游的 `proactive_cancel` / `proactive_update` 可改任何会话的闹钟、`deliver_to` 可推给任意 `{bot_id, target_id}`、`proactive_update_settings` 可改宿主全局的业务框架；这些工具注册在**每个**根 agent 上（与预设无关），IM 里的任何已连携用户都能让 AI 调用（N1b） |
| 14 | **投递守卫**：`ctx.dshProactive.setDeliveryGuard(fn)`（返回解除函数；最后注册的生效）。business 唤醒的 IM 推送（#4）对每个目标先问 `fn({ alarm: {id, sessionId, type, mode, prompt}, sessionId, target: {botId, targetId}, text, firedAt })`：`{ text? }` = 发送（可替换正文），`{ deny }` = 不发（写 info 日志，run 的 note 记「N refused by the delivery guard」）。守卫抛错 = 不发。配置 `deliveryGuard: required` 时没有守卫就一律不发（fail closed）；默认 `optional` = 与 #4 相同 | 让业务插件（bridge-notify 的定时报告）只把报告推给本人的 1:1 目标，并对 AI 的自由文做事后检查 |
| 15 | **唤醒守卫**：`ctx.dshProactive.setWakeGuard(fn)`。每次唤醒（调度与面板的「立即触发」都经过 scheduler 的 `runWake`）之前调用 `fn({ alarm })`：`{ skip: reason }` = 不唤醒，按上游的 `skipped` 处理（记录、推进到下一次、不重试、不计预算 / 小时上限）；抛错 = 跳过。守卫可在其中经 `ctx.dshProactive.action({kind:'cancel'})` 取消闹钟（in-flight 中的闹钟被移除后，scheduler 的 `replaceAlarm` 为 no-op）。`index.ts` 导出 `guardedRunWake` / `imDelivery`（测试用） | 定时报告在触发时重新确认本人仍是在职、已连携、1:1、允许的角色（bridge-notify），否则跳过并停用 |
| 16 | **DSH 0.2.2-rc.1**（devDependencies：`@deepseek-ai/dsh-*` 0.2.2-rc.1、cordis / cordis-plugin-loader / cordis-plugin-include 4.1.0 / 1.1.0 / 1.1.0，`overrides` 同步；`dsh-client-runtime` / `dsh-invariants` 在 0.2.2 没有新版，保持原样）。`@deepseek-ai/dsh-agent` 0.2.2 把模型选择改成 Agent 自己持有（`agent.model`：记录的选择 → 会话上一次请求 → 实时 AgentOptions），`installModelSelection(agentCtx)` 只剩一个参数（只装切换模型的提示），`ModelSelectionRef` 已删除。`wake.ts` 跟随 web host 的 composeAgent：setup 只调 `installModelSelection(agentCtx)`，`agentOptions(override)`（宿主 agentDefaultModel 与闹钟的部分覆盖合并）作为回退。完整覆盖（provider + model）只会用于全新会话（`new` 目标，没有历史），所以仍然完全生效。删除 `createWakeSelectionRef` / `selectionFromHeader` 及其 2 个测试；另外 2 个测试改成检查 AgentOptions 与 setup（不再驱动已不存在的 waterfall） | DSH 0.2.1-rc.2 → 0.2.2-rc.1（framework 的 DSH 升级）；旧代码在 0.2.2 的类型下编译失败 |

本 fork 新增、尚无 ja 译文的面板键（ja 下回退为 en，请 dsh-lang-ja 补）：`modeLabel`、`modeCompanion`、`modeBusiness`、`modeBusinessHint`、`deliverToLabel`、`deliverToPlaceholder`、`deliverToHint`、`businessFramingLabel`、`businessFramingHint`、`businessDefaultPromptLabel`。

注意：companion 的默认指令 `defaultPrompt` 仍是上游的中文文案（数据而非 UI 文案），产品 profile 可在 `config.json` / settings 里改成日语。

## 测试

`npm test`（tsc → `node --test "dist/test/*.test.js"`）：345 个，343 通过。失败的 2 个是上游自身在 Windows 上的 POSIX 路径断言（`canonicalize: collapses ..`、`proactive_set: a handle without a target defaults to the file's grandparent workspace`），未修改的上游源码在本机同样失败。新增 `test/care-business.test.ts` 15 个（含 activeWake 2 个）（框架、校验、持久化、配置与 settings、面板参数、工具、唤醒时 IM 投递、静默与 companion 不投递、安静时段门控、客户端相对 URL、构建产物、use-locale）。新增 `test/care-guard.test.ts` 5 个（#13 策略的默认与三种模式、#14 投递守卫：按目标判断・替换正文・required 无守卫不发・抛错不发、#15 唤醒守卫：跳过・抛错跳过・无守卫照常）。2026-10-29 重跑（Windows 11 / Node 24）：352 个，350 通过，失败的 2 个仍是上述上游的 Windows 路径断言。2026-11-15（DSH 0.2.2-rc.1，#16）：350 个，348 通过，失败的 2 个同上。

**产品配置**（Bridge 的「收件人保证」，framework `docs/GUIDELINE.md` d.8、care-ai-native `docs/design/NOTIFY_RECIPIENTS.md` §3）：#13 / #14 的默认值保持上游行为（`modelTools: all`、`deliveryGuard: optional`）。业务产品应在 profile 的 cordis 配置里写 `modelTools: reclaim`、`deliveryGuard: required`（并由 bridge-notify 注册投递守卫与唤醒守卫），否则模型可经 `deliver_to` 推送到任意 `{bot_id, target_id}`。framework 的 `profile/template` 尚未写入这两个值。
