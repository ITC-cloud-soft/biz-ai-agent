> **care fork**：本目录是 `@care/dsh-auto-tasks`（`0.2.0-care.1`）。与上游的差异（`ctx.autoTasks`、事件触发、dedupeKey、相对 URL、i18n 等）见 [CARE_FORK.md](./CARE_FORK.md)。下文为上游 README 原文，其中的安装路径与 `sync-profile.ps1` 不适用于本 fork。

# dsh-auto-tasks · 自动任务

DSH 的 dots 式常驻自动化面板：把「什么时候做 / 做什么 / 做完告诉谁」写成一条任务，
交给 **DSH 核心 `schedule` 服务**准点唤醒 AI 执行，结果通过 **dsh-im** 主动投递到
IM / 工作邮箱，并在会话页第 7 个 Tab【自动任务】里集中管理。

```
会话页 Tab： [对话][轨迹][记忆][技能][待办][Memory Evolve 设置][自动任务]  ← order 130
                                                         └ 概览｜任务｜收件箱｜反馈｜渠道｜指南
```

当前版本 **0.2.0**：P0 骨架 → P1 投递 → P2 反馈经济 → P3 收件箱 → P4 护栏。

## 安装（本地开发）

```bash
dsh plugin --profile web add file:C:\work\deepseek-im\dsh-auto-tasks
```

装完 `dsh --profile web --dump-config` 应能看到 `- id: dsh-auto-tasks`。
DSH 的 `patchReload: live` 会让新安装直接在运行中的宿主里生效；**修改插件源码后需要重启宿主**才会加载新的宿主 half（客户端 bundle 刷新页面即可）。

> ⚠️ 本机的 `file:` 依赖被 pnpm 复制成了实目录（`profiles/web/node_modules/dsh-auto-tasks`），**改工作区不会自动生效**。
> 每次改完执行 `pwsh -File scripts\sync-profile.ps1` 同步到 profile 副本，再重启 dsh web。

## 构成

| 层 | 文件 | 说明 |
|---|---|---|
| 宿主 | `lib/index.js` | 任务存储、HTTP API（`/auto-tasks/api/*`）、3 个模型工具、核心 `schedule` 接线、对账、投递、护栏 |
| 客户端 | `lib/client.js` | 手写 CJS bundle（`window.__ModuleLoader__.load`），无构建步骤，6 个子页 |
| 补丁 | `cordis.patch.yml` | 把宿主行插进 profile roster |
| 冒烟测试 | `../../test/host-smoke.mjs` | 假 ctx 直接加载宿主，覆盖 P1–P4 |

存储：`$DSH_HOME/auto-tasks/`
- `tasks.json` — 任务定义（原子写：tmp + rename）
- `reports.jsonl` — 反馈流水（追加式；标记已读时整文件原子重写并留 `.bak`）
- `config.json` — 全局配置（可选：`quietHours`、`maxDeliveriesPerDay`、`retry`）
- `inbox/` — 收件箱候选（`.eml` / `.json` / `.txt` / `.md`），采纳后移入 `inbox/adopted/`

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/auto-tasks/api/health` | 自检：schedule / dsh-im 是否可用、store 路径 |
| GET/POST | `/auto-tasks/api/config` | 全局配置读写 |
| GET | `/auto-tasks/api/tasks?sessionId=` | 任务列表（附 `nextRunAt`、`scheduleState`） |
| POST | `/auto-tasks/api/tasks` | 新建（同时排程；支持 approval / feedback / guard） |
| POST | `/auto-tasks/api/tasks/update` | 更新（先建新排程成功后再删旧，失败不动旧排程） |
| POST | `/auto-tasks/api/tasks/toggle` | 启用 / 暂停 |
| POST | `/auto-tasks/api/tasks/delete` | 删除（连带取消排程） |
| POST | `/auto-tasks/api/tasks/run` | 立即执行一次（`after_seconds: 1` 的一次性 schedule） |
| GET | `/auto-tasks/api/reports?limit=` | 反馈流水 + 全量未读数 |
| POST | `/auto-tasks/api/reports/read` | 标为已读（传 `ids` 标记指定项；空数组=全部） |
| POST | `/auto-tasks/api/reports/approve` | **P4** 批准一条待决策报告 → 真正执行一次 |
| POST | `/auto-tasks/api/delivery/test` | **P1** 测试投递（走真实 `dshIm.send`） |
| GET | `/auto-tasks/api/channels` | 转发 `ctx.dshIm.listBots()` + `listTargets()` |
| GET | `/auto-tasks/api/inbox` | **P3** 收件箱候选列表 |
| POST | `/auto-tasks/api/inbox/adopt` | **P3** 一键采纳为（停用的）自动任务 |

## 模型工具

| 工具 | 用途 |
|---|---|
| `auto_task_list` | 列出任务（`all=true` 跨会话），带审批/证据/异常标记 |
| `auto_task_report` | 汇报结果：写流水 + 投递 + 进未读；完成需证据时做硬门控 |
| `auto_task_silent` | 静默收尾：写流水但不推送、不进未读 |

## 能力与边界（按分期）

- **P1 投递**：渠道列表 / 任务级多选 / `deliverOn` 过滤 / 失败重试（默认 2 次）/ 测试投递 / 投递结果逐渠道记录。邮箱走 dsh-im 的 email/office 渠道（同样只存 `botId + targetId`）。
- **P2 反馈经济**：静默路径、未读红点、单条与全部已读、免打扰时段（支持跨零点）、每日投递预算、连续失败自动暂停（默认 3 次，可在任务 guard 里调）。
- **P3 收件箱**：`inbox/` 目录监控 + 候选列表 + 一键采纳。**IMAP 直连未做**——本插件不存凭据，等 dsh-im 暴露收件箱读取能力后再接；当前用文件投递（把 `.eml` 丢进目录）覆盖同一工作流。
- **P4 护栏**：`approval=require` 时到点先出计划（报告 needsDecision），在反馈页点「批准并执行」才真正跑；`guard.requireEvidence` 开启后，`done` 必须带真实存在的 artifacts，否则自动降级为 needsDecision。
- 触发后端为**核心 schedule**（与 `schedule_create` 同源），排程持久化在 `storages/schedule.json`；插件启动 8 秒后做一次对账，把 `tasks.json` 与 schedule 存储拉回一致（会话被停止导致排程丢失时会自动重建）。

## 安全

本插件**不保存任何平台凭据**：渠道只存 `botId + targetId` 引用，凭据由 dsh-im 管理。
扫码关联 / 新建目标 / 测试投递全部由 dsh-im 的原生面板（`dshImClient`）承担。

> 例外：邮件监控功能会把 IMAP/SMTP 配置保存在 `$DSH_HOME/auto-tasks/mail.json`（仅当前用户 ACL 可读），
> 这是用户显式配置的本地凭据，不属于 dsh-im 渠道凭据。

## 规范整改（2026-10）

已完成的合规改进：

1. **本地 API 鉴权**：`/auto-tasks/api/*` 只接受回环地址；所有写操作必须带
   `x-auto-tasks-client: web|cli` 头（浏览器跨站无法伪造），并拒绝跨站 `Origin`；
   `POST /api/mail/send` 额外要求 `x-auto-tasks-confirm: 1`。UI 的 `api()` 已自动带头。
2. **后端适配层**：新增 `lib/backends.js`，把 `dsh-proactive`（面板 action API）与
   `dsh-im`（可选服务）的契约集中隔离；核心 `ctx.schedule` 直接使用公共契约。
3. **任务级唤醒后端**：`wakeBackend: "schedule" | "proactive"`；proactive 路径支持
   冷会话、抖动、免打扰、预算；更新/暂停/删除会同步取消对应闹钟。
4. **配置 schema**：新增 `lib/config-schema.js`，加载时补默认值并对未知字段告警；
   `GET /api/config/schema` 暴露 schema 与生效值。
5. **可脚本化检查**：`npm run check`（语法检查）；冒烟测试见 `../../test/host-smoke.mjs`。

仍未完成（后续）：

- 尚未迁移到官方 monorepo 的 TypeScript + esbuild 构建与 `node --test` 测试；
- 仍依赖若干未公开接口（`ctx.schedule.catalog`、proactive 面板 action API、dsh-im 投递 HTTP），
  升级 DSH 时需回归 `lib/backends.js`；
- 没有 i18n / locale，界面文案为中文硬编码；服务端日报文案已走 `lib/i18n.js`。

## 工程化（2026-10 第二轮）

- **TypeScript 源 + 构建**：`src/backends.ts`、`src/config-schema.ts`、`src/i18n.ts`，
  用 Node 内置 `stripTypeScriptTypes` 构建到 `lib/*.js`（零外部依赖）：
  ```bash
  npm run build
  ```
- **测试**：`node --test`（同一进程，规避 Windows 沙箱 spawn 限制）：
  ```bash
  npm test        # 9 tests：host smoke 20 checks + config/i18n/backends 单测
  npm run ci      # build + check + test
  ```
- **能力探测**：`proactiveBackend.available()` 30 秒缓存，避免每次请求都打面板 API；
  dsh-im 缺失时 `available=false`，投递降级。
- **打包元数据**：`files` 白名单、`npm run ci` 作为提交前闸门。

## 类型与打包（2026-10 第四轮）

- **类型检查进 CI**：`tsconfig.json` + `npm run typecheck`（tsc `--noEmit`），当前 **0 error**；
  修掉了 26 个真实类型错误（payload 字面量、schedule/proactive 请求对象、inbox body、
  bot 列表、poll 结果联合类型等）。
- **客户端改用 esbuild 打包**：`src/client.ts` → `lib/client.js`（CJS、react external、banner 标记）；
  沙箱禁止 spawn 时自动回退为类型剥离，保证 CI 可跑。
- **API 契约测试**：新增鉴权用例（无头 403、跨站 Origin 403、mail send 缺 confirm 403、
  带头创建/删除任务 200）与 proactive 建/删闹钟 mock 测试。
- **测试数**：**14 tests**（host smoke 20 checks + config/i18n/backends/api/proactive）。
- **剩余**：`strict` 仍为 false，边界处用了 `any`；客户端 UI 文案未 i18n；契约测试跑的是假 ctx，
  真实宿主回归仍需手动 smoke。

## 类型迁移（2026-10 第五/六轮）

- **基座已开 `strict: true`**：`tsconfig.json` 覆盖 `src/**/*.ts`，`npm run typecheck` 进 CI。
- **`noImplicitAny` 已打开且 0 error**：用 TypeScript AST codemod（`scripts/annotate-params.mjs`）
  把 **233** 个未标注参数转成显式类型；边界处仍是显式 `any`（后续可换真实接口）。
- **已完成的 strict 清零**：`mail`（21）、`client`（33）、`index`（61）——空数组推断、定时器句柄、
  catch 变量、report/payload 字面量、`Promise.all` 结果等。
- **UI i18n（起步）**：会话 Tab 名称、6 个子页签、刷新/新建按钮按 `navigator.language`
  切换中/英（非英文环境保持中文）；其余正文文案仍为中文，按页逐步迁移。
- **真实 HTTP 契约测试**：`test/http.test.mjs` 起临时 `127.0.0.1` 服务，用真实 `fetch` 验证
  无头 403、跨站 403、带头建/删任务 200、mail send 缺 confirm 403、只读 health 200。
- **测试数**：**19 tests**；`npm run ci` = build + typecheck + check + test。

## 核心接口（2026-10 第七轮）

- 新增 [src/types.ts](<dsh-auto-tasks/src/types.ts>)：`Task` / `Report` / `Trigger` / `Delivery` /
  `FeedbackPolicy` / `GuardPolicy` / `MailConfig` / `MailState` / `MailCandidate` / `HostContext`。
- `index.ts` 的核心签名改用接口：`loadTasks(): Task[]`、`saveTasks(tasks: Task[])`、
  `readReports(): Report[]`、`appendReport(report: Report)`、`buildPrompt(task: Task)`、
  `scheduleRequest(task: Task)`、`attach/detachSchedule(ctx: HostContext, task: Task)`、
  `deliver(ctx: HostContext, task: Task, report: Report)`、`apply(ctx: HostContext)`。
- `mail.ts`：`loadMailConfig(): MailConfig`、`loadMailState(): MailState`、
  `listMailCandidates(): MailCandidate[]`、`readMailCandidate(): MailCandidate | null`；
  补了 `imap`/`candidate` 的空值守卫。
- **剩余显式 `any`**：约 210 处（client 75 / index 107 / mail 28），主要是事件回调、
  工具 args 与 DSH ctx 边界；`typecheck` 仍 0 error，后续按模块替换。

## UI 接口（2026-10 第八轮）

- 客户端新增 `ViewProps` 契约：`tasks?: Task[]`、`reports?: Report[]`、`editing?: Task | null`、
  `onToggle/onEdit(task: Task)`、`onApprove(report: Report)`、`onDelete/onAdopt/onRefresh/onDone…`，
  9 个子组件统一使用 `props: ViewProps`。
- `client.ts` 通过 `import type { Task, Report } from './types.js'` 复用域模型（esbuild 构建时擦除）。
- 剩余 `any` 主要在事件处理器 `(e: any)`、本地 `useState<any>` 与 `h()` 的宽松签名；
  下一步可定义 `ChangeEvent`/`FormState` 再降一档。

## 工具 / 事件 / 邮件边界（2026-10 第九轮）

- **工具 args 接口**：`TaskListArgs` / `ReportArgs` / `SilentArgs` / `MailToolArgs` 定义在 `types.ts`，
  四个模型工具的 `execute(args, …)` 与 `render(_args, value)` 都改为接口/最小形状。
- **DOM 事件**：客户端定义最小 `ChangeEvt { target: { value, checked }; key?; preventDefault? }`，
  18 处 `(e: any)` 换成 `(e: ChangeEvt)`。
- **IMAP 边界**：`ImapFlowLike`（connect/getMailboxLock/fetchOne/fetch/messageMove/logout）与
  `ParsedMail` 接口；`client` / `parsed` / `raw` 从 `any` 换成显式类型，并补空值守卫。
- **UI i18n**：任务表单、收件箱、反馈、渠道按钮、指南（6 步 + 简介）接入 zh/en。
- **剩余 `any`**：约 186（client 61 / index 100 / mail 25）；均为显式边界，`noImplicitAny` 为 0 error。
- **验收**：`npm run ci` 19 tests 全绿；`typecheck` strict 0 error；profile 与工作区 `lib/index.js`
  SHA256 一致；宿主 `/api/health` 返回 `schedule/proactive/im: true`。

## 邮件任务修复（2026-10 第十轮）

- **触发模型显式化**：任务新增 `triggerMode: "schedule" | "poll"`；邮件任务为 `poll`，
  删除占位 cron，`attachSchedule`/启动对账/更新都不会为 poll 任务建核心排程；UI 显示「由邮件轮询触发」。
- **运行预算真正生效**：`guard.maxRunsPerDay` 以前只存不执行；现在：
  - `0`/缺省 = 不限（邮件任务已设为 `0`）；
  - 邮件唤醒、立即执行、批准执行三处按当天反馈流水计数，超预算拒绝/跳过；
  - 普通任务仍用默认 3。
- **轮询失败告警**：连续失败计数写入 `mail-state.pollFailures`；≥3 次且 6 小时内未告警时，
  通过邮件任务的投递渠道发一条微信；成功轮询清零。
- **测试数据清理**：删除 3 条「テスト商事株式会社」测试报告（reports 8 条、unread 0），
  备份为 `*.bak-2026-10-24T14-42-57-357Z`。
- **测试**：新增 poll 任务契约测试，`npm run ci` **20 tests** 全绿。

