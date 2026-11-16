# Biz Assistant Framework — 开发指南

包名为 `@dsh-bridge/*`（沿用最初名称 DSH Business Bridge 的前缀）。

## 摘要（Summary）

本文介绍如何使用 Biz Assistant Framework（包 `@dsh-bridge/*`）把业务系统连接到 AI 员工——主要用途是**既有**系统；新系统也用同样的部件构建（b.0：放在哪里、如何依赖 framework，以及绝不修改 framework 本身）。(a) 快速开始——安装、测试、运行 `equipment-inspection` 示例、运行 e2e 场景；接入检查清单（系统需要添加的内容：Bridge v1 端点、manifest、基于系统自身登录的 SNS 绑定、由系统决定的接收人规则、在自身事务中写入的事件、系统的审批规则、会话检查、一致性测试（conformance suite）所需的报告）；(b) 逐步接入——新系统（b.0）、包含三个内部事件的 manifest（b.1）、带完整签名的 server-kit hooks（或像 CareBilling 那样为既有 API 设置 `x-alias` 别名）、业务事务内的事件、一致性测试以及 52 / 52 所强制要求的内容（报告、审批、个人机器人、fixtures 的角色映射）、关闭发送设置并为每个应用配置 link-guard URL 的 DSH 产品 profile、web-kit 画面与 BFF（绝不携带 BFF 密钥转发浏览器请求）、带委托类别的自动任务（非默认应用需要各自的条目）、员工操作手册（b.8）、外部连接（b.9）、外挂模式——在未改动的系统前方放置独立的 bridge 服务，事件取自 CDC 或符合条件的 webhook，而非同一事务（b.10，试行）、检查清单以及由命令构成的完成条件；(c) 扩展点；(d) MUST / SHOULD 规则（AI 绝不决定或设定金额，参数为件数和日期，IM 和事件中不含姓名或健康相关文本，幂等键，一次审批即决定，免打扰时段，AI 秘书的口吻，各平台注意事项，**接收人只由业务系统决定**，拒绝群聊，无人值守的委托类别，发送前筛查，配置开关及其安全值，个人机器人，使用业务系统自身姓名检查 `hooks.piiScan` 的长期记忆，AI 员工的资料（profile）——默认一个昵称，在助手面板中附加文件及 OCR 选择与图像清理，密钥保留在业务系统中的外部连接）；(e) 测试方针；(f) 版本管理；(g) FAQ 与故障排查；(h) 作为参考实现的 CareBilling。架构本身见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

本文中的“MUST”是不遵守就会在 conformance suite 或评审中不通过的规则，“SHOULD”是有理由时可以不遵循的推荐。
整体结构（分层、事件流、会话隔离、安全承诺）请先阅读 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 目录

- [连接既有业务系统：检查清单](#连接既有业务系统检查清单)
- [a. 快速开始](#a-快速开始)
- [b. 把业务系统连接到 AI 员工（步骤）](#b-将业务系统接入-ai-员工步骤)
  - [b.0 构建新的业务系统](#b0-新建业务系统)・[b.1 编写 manifest](#b1-编写-manifest)・[b.2 实现业务侧](#b2-实现业务侧server-kit-的-hooks)・[b.2' 以别名挂载到既有 API](#b2-以别名挂载到既有-apicarebilling-的方法)
  - [b.3 在业务事务中写入 event](#b3-在业务事务中写入-event)・[b.4 通过 conformance suite](#b4-通过-conformance-suite)・[b.5 注册到 DSH 的产品 profile](#b5-注册到-dsh-的产品-profile)
  - [b.6 业务 Web 的画面（web-kit）与 BFF](#b6-业务-web-的画面web-kit与-bff)・[b.7 启用自动任务（delegate）](#b7-启用自动任务delegate)
  - [b.8 操作手册与 SNS 上的使用方法提问（help）](#b8-操作手册与-sns-中使用方法的提问help)・[b.9 外部连接（连接对象、操作、规则）](#b9-外部连接连接对象操作规则)
  - [b.10 外挂模式（试行）](#b10-外挂模式把桥接放在既有系统之外试行)
  - [检查清单](#检查清单)・[完成条件（用命令确认）](#完成条件用命令确认)
- [c. 扩展点](#c-扩展点)
- [d. 规则（MUST / SHOULD）](#d-规则must--should)
  - [d.8 接收人的保证与发送设置](#d8-接收人的保证与发送设置)・[d.9 个人机器人](#d9-个人机器人本人的-sns)
  - [d.10 长期记忆（bridge-memory）](#d10-长期记忆bridge-memory)・[d.11 AI 员工的资料（bridge-persona）](#d11-ai-员工的资料bridge-persona)
  - [d.12 向 AI 助手附加文件](#d12-向-ai-助手添加附件)・[d.13 外部连接（连接对象、操作、规则）](#d13-外部连接连接对象操作规则)
- [e. 测试方针](#e-测试方针)
- [f. 版本管理（protocol / manifest）](#f-版本管理protocol--manifest)
- [g. FAQ 与故障排查](#g-faq-与故障排查)
- [h. 参考实现：CareBilling](#h-参考实现carebilling)

---

## 连接既有业务系统：检查清单

本 framework 的主要用法，是**把正在使用的业务系统变成与 AI 员工（每位员工各自的 AI 助手）协同工作的形态**。
从“人打开画面录入、确认、追着负责人跑”的形态，转变为“AI 员工负责关注、通知、请合适的人处理、起草，人在聊天中做决定”的形态。
业务系统一侧只需添加“桥接”（Bridge v1 的端点、manifest、基于系统自身登录的 SNS 绑定、接收人规则等，见下表），
DSH 运行环境、IM 连接、插件、发送防护、自动任务与定时报告的机制以及测试工具都由 framework 提供。
也可以用同样的部件构建新的业务系统（示例 equipment-inspection 就是在 server-kit 之上新建的）。

CareBilling（首个用户，护理计费系统；仓库 `care-ai-native`）是以 AI 员工为前提构建的业务系统，framework 就是从中抽取出来的。由于它在 framework 出现之前
就已有功能相同的 API，v1 以别名挂载在这些 API 上（b.2'）。每一项都可以按下表“在哪里确认”一栏进行验证。

| # | 业务系统需要添加的内容 | 类别 | framework 的契约（在哪里确认） | 尚未具备时的添加方法 |
|---|---|---|---|---|
| 1 | 通过 HTTP API 读取业务数据的入口，以及接收 AI 提案的入口（Bridge v1 的端点） | 必需 | 实现 Bridge v1（`packages/protocol/openapi/bridge-v1.yaml`），或以别名挂载到既有 API 上（b.2'）。AI 的读取是 manifest 的 `tools[].http` 中列出的 GET（`readToolPolicy`），写入是 `POST /bridge/v1/proposals` → 仅在人采纳时执行 `proposalKinds[kind].apply`（conformance：P1～P6、M1～M3、D5、PR1～PR3） | 如果画面与业务逻辑是一体的（仅服务端渲染、桌面客户端、直连 DB），则添加覆盖 AI 需读取范围的读取 API 和提案的接收入口。Node 使用 server-kit，其他语言实现 OpenAPI |
| 2 | manifest（系统的自我介绍） | 必需 | 角色与委托上限、event 与 payload 的允许列表、通知文案、工具、playbook、报告（b.1）。`bridge-validate manifest --strict` 通过（无警告） | 把既有的角色、业务的变化以及想要通知的内容写出来，整理成 manifest。不修改业务代码 |
| 3 | 员工绑定自己 SNS 账号的画面（业务 Web 的「SNS 連携」（SNS 绑定）），基于**系统自身的登录**运行 | 必需 | web-kit 的 `SnsLinkPage` 以本人的会话调用同源的 `/bridge/v1/me/*`。业务 Web 的 BFF 确认既有登录（gateway 的 `getSessionUser`），把来自浏览器的 `/bridge/v1/me/*` 请求原样带着本人的 cookie、**不附加密钥**地转发给业务系统。**MUST** 只在 BFF 自己在服务端构造的调用（`POST /bridge/v1/assistant/tickets`、`POST /bridge/v1/assistant/attachments/prepare`、以及通过本人用 RPC 成功完成 `createOnly` 创建之后紧接着的 `POST /bridge/v1/me/personal-bots`）上附加 `x-bff-secret`，**不得携带密钥中继浏览器的请求**（若中继，浏览器就能把组织机器人的 botId 注册为自己的个人机器人，所有通过该机器人对话的其他员工都会变成「未連携」（未绑定），即绕过 d.9 的所有者规则。见 b.6）。server-kit 的 `authenticate(req)` 从既有会话（cookie / bearer）返回 `{ user: { id, role }, sessionId }`。仅限 BFF 的操作（Web 助手的票据、个人机器人的注册）同时需要本人的会话**和** `x-bff-secret`。绑定码与签发它的本人绑定，`/me/identities` 只显示本人的绑定（conformance：L2～L9、B1～B4、S1、S2）。使用个人机器人时见 d.9 | 如果登录无法从外部确认（独立的 ID 体系、无法共享的 SSO），则在 BFF 中添加确认既有会话的入口。另建身份确认会造成双重管理并成为冒充的漏洞，因此不要另建 |
| 4 | 由**业务系统决定**通知接收人的规则 | 必需 | `recipientsFor(event, ctx)` → `null` / `{ stale }` / `{ users, paramsFor, link, dedupeKey }`。按角色、所属、负责范围决定，并用与 Web 授权相同的判定来确认（d.8）。本人的通知设置、排除已通知者、免打扰时段、投递渠道的优先顺序由 kit 和插件应用（conformance：N1～N3） | 如果“通知谁”只存在于人的日常运作中，则为每个 event 编写规则（CareBilling 的 `decideRecipients` 是示例）。不要让 DSH 一侧决定接收人 |
| 5 | 把业务状态的变化，与业务数据行在**同一事务**中作为 event 记录（transactional outbox） | 必需 | `kit.tx` + `kit.emitEvent`（b.3）。payload 遵循 manifest 的 `events.<type>.payload`（**按类型的允许列表**：仅限 ID、日期、件数、状态）。违反时抛出 `EventRejected`。DSH 通过 `GET /bridge/v1/events?after=` 拉取（conformance：E1～E4） | 在改变状态的处理中添加一行写入 event 的代码（事后通过差分或触发器捕获，会通知未 commit 的变化、漏掉已 commit 的变化）。若要在不修改既有系统代码的前提下放在外部，则从 CDC 或符合条件的 webhook 接入（b.10，试行） |
| 6 | 可通过 API 查询员工及其角色（含有效 / 无效） | 必需 | `employees.get / list` → `{ id, role, active }`，manifest 的 `roles`（`delegation: none \| read \| propose`）。**AI 的权限 = AI 允许列表（manifest 的 `tools[].roles`）∩ 该员工的角色**。被设为无效的员工立即失去所有令牌（conformance：D1～D7、S5、M3） | 编写从既有员工表返回数据的 hook |
| 7 | 审批规则存在于系统内部（作为函数集中在一处），来自聊天的审批也能使用同一规则 | 必需（为达到 52 / 52。即使业务不需要审批，也要具备最小的 1 种） | `approvals.{get, approvers, card, mayDecide, decide}`（形式见 b.2）。没有审批时 A1～A4 会被 skip，无法满足发布条件（无 skip）。在 Web 上决定时也使用同一个 `mayDecide`，`decide` 在 `ctx.t` 内写入决定并发出 `approval.decided`。一次审批即决定，其他卡片失效（`t.revokeApprovalDeliveries`）（conformance：A1～A4） | 把画面代码中的规则集中到一个函数，从 Web 和聊天两边调用 |
| 8 | 可按用户确认 Web 会话是否仍然有效 | 必需 | `isSessionLive(sessionId, ctx)`：让 Web 助手的票据（30 分钟）和委托随 Web 会话一起结束。在 server-kit 中是可选 hook，但 conformance S4（`hook:revokeSession`）需要它，而发布条件是无 skip | 编写查询会话表的 hook |
| 9 | 面向员工的操作手册（1 个画面 = 1 节）及其索引与检索（在 SNS 上被问到使用方法时的依据） | 可选（推荐） | `@dsh-bridge/help`：在 CI 中把操作手册与画面路由表进行比对，并生成索引。server-kit 的 `help`（`GET /bridge/v1/help/*`）按提问者的角色作答，对其无法打开的画面不附 URL。manifest 的 `help.tool` 与 `web.routes`（b.8） | 每个画面写 1 节（URL、菜单、可用角色、关键词、步骤、常见问题）。角色从画面的 Guard 中机械地获取，因此要让路由表（router）可被读取 |
| 10 | 存入长期记忆之前的个人信息检查（使用业务系统的名册） | 可选（推荐） | `POST /bridge/v1/pii-scan`（Bridge v1 的可选操作）。server-kit 默认具备：在格式检查（联系方式、长号码、ID 号码等；不会命中普通的日语、英语句子）的基础上，合并可选 hook `hooks.piiScan(text, ctx) -> { kinds: string[] }`（名册检查）的类别后返回。默认的格式检查**不知道姓名**，因此持有员工、服务对象、客户姓名的系统要实现 `hooks.piiScan`。bridge-memory 只保存通过本地检查和此检查的文本，检查无法到达时不保存（fail closed）。没有该检查的应用只做本地检查（d.10） | 编写 `hooks.piiScan`：在名册（服务对象、客户、员工等）中查找姓名（姓、名、假名），命中时只返回类别（例如 `staff_name`）（不返回命中的字符串。示例为 equipment-inspection 的 `src/hooks.mjs`） |
| 11 | AI 员工的资料（昵称、语气、公司介绍、性格、背景），由管理员在业务 Web 中编辑，并按版本保存 | 可选（推荐） | `GET /bridge/v1/ai-profile`（服务，etag / 304）以及管理用的 `GET / PUT /bridge/v1/admin/ai-profile`、`POST …/versions/{version}/restore`。server-kit 默认具备（`roles.admins`，用 `aiProfile: false` 禁用）。自行实现时用 `validateAiProfile` 校验，并保留版本和审计记录（仅版本号）。画面为 web-kit `AiProfilePage`（d.11） | 添加版本表和管理员画面。没有时 DSH 以无资料状态运行（署名「— <アプリ名> AI 秘書」（— <应用名> AI 秘书）） |
| 12 | 定时报告（只含件数的报告：manifest 的 `reports` 与 `hooks.reports.compute`） | 必需（为达到 52 / 52） | 没有报告时，52 项中有 10 项不通过：除 R1～R3 外，P4、L9、D6、D7、S2、S4 把 `GET /bridge/v1/reports/latest` 用作委托的探针，D3 确认报告的路径在委托下也返回 403。能够采纳提案的人（`roles.proposalReviewers`）的默认值也是报告的读者（b.2） | 确定 1～4 个“今天的件数”程度的部分，并编写各角色可见的部分（`sectionsByRole`） |
| 13 | 外部连接（AI 员工使用本公司的其他 API 或第三方 API；连接对象、操作、规则） | 可选 | server-kit 的 `createBridgeApp({ connectors: { secretKey } })`：`GET /bridge/v1/connectors/catalog`、`POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run`（仅 read、委托）、管理用的 `/bridge/v1/admin/connectors*` 等，以及提案类型 `connector_write`。密钥和调用都在业务系统中（b.9、d.13） | 管理员在业务 Web（web-kit `ExternalConnectorsPage`）中登记连接对象和操作。先从 1～2 个 read 开始 |

**验证**：全部具备后，针对 TEST 环境通过 **conformance suite 52 项**（b.4）。发布条件是 52 / 52、`knownGaps` 为空、无 skip。
由于不允许 skip，**7（审批）、12（报告）和个人机器人的注册（B1～B4，server-kit 默认具备），即使业务上没有使用计划，也要以最小形式具备**（b.4）。
DSH 一侧在产品 profile 中关闭发送设置，并为所有应用填写链接检查（link-guard）的 URL（b.5、d.8）。是否完成用命令判定（[完成条件](#完成条件用命令确认)）。

**推进方式**

- 先从 1 项业务（例如：账单的审批、点检的期限）开始，与既有画面并行运行并确认后再扩大范围。
- 表中的 1、3（读取 API 和登录）涉及系统构造的根本，需要添加的量因系统而差别很大，应最先估算。需要添加的量很大时，
  也可以选择在同一 framework 之上作为新的业务系统来构建（只需编写 server-kit 的 hooks，Bridge 部分由 kit 提供）。放置位置、依赖关系
  以及不得修改的部分见 b.0。
- 不想修改既有系统的代码时，可使用在外部放置桥接专用服务的**外挂模式**（b.10，试行）。能否使用，取决于既有系统是否具备登录确认、
  可以本人身份调用的 API、变化通知（webhook 或 CDC）以及审批与写入的 API。
- 面向经营者的说明（用浅显的语言讲同样的项目）见 `docs/slides/marketing/biz-assistant-for-executives.pptx` 的第 18 张幻灯片「つなぐために、業務システムに足すもの」（为了连接而需要在业务系统中添加的内容）。

---

## a. 快速开始

### a.1 准备与测试

Node 22.19 及以上（已在 24 上确认），pnpm 10。

```sh
cd framework
pnpm install
pnpm test                    # 所有 workspace 包（不含 vendor/）
pnpm test:protocol           # 单独运行：test:core / test:gateway / test:testing / test:kits / test:plugins / test:profile / test:examples
pnpm validate                # OpenAPI 的 lint 以及随附 manifest 的校验
```

- 需要 PostgreSQL 的测试（server-kit 的 PostgreSQL store、equipment-inspection 的业务测试与 conformance）仅在设置了
  `FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres` 时运行，未设置时显示原因并 skip。
  会创建临时 DB（`fw_serverkit_test`、`fw_equipment_unit_test`、`fw_equipment_test`），最后删除（不删除 `*_test` 以外的 DB）。
- 截至 2026-10-30（含外部连接；用 `pnpm test`、**不设置** `FW_TEST_DATABASE_URL` 重新统计）：**582 项，576 pass・0 fail・6 skip**
  （skip 为需要 PostgreSQL 的测试附带原因的 skip、`packages/protocol/conformance/http.test.mjs`〔仅在设置了 `BRIDGE_BASE_URL` 时运行〕，以及
  缺少参考用 `yaml` 包时的 YAML 解析器对比测试）。
  设置 `FW_TEST_DATABASE_URL` 后，需要 DB 的测试（server-kit 的 PostgreSQL store、equipment-inspection 的业务测试与 conformance）也会运行，
  需要 DB 的测试的 skip 消失（2026-10-29 的统计：514 项・513 pass・1 skip〔http.test.mjs〕。有 DB 时的件数在环境中有 DB 时重新统计）。`pnpm validate` 也为 ok（OpenAPI 46 paths）。件数是各包 `node --test` 的 `tests` 之和
  （以 `pnpm -r` 运行的包的输出行前面带有包名，统计时不要遗漏）。件数会变化，不要照抄，应当场统计。
- fork 在 workspace 之外：`cd vendor/dsh-im && npm ci && npm test`（`dsh-auto-tasks`、`dsh-proactive` 也一样）。

### a.2 运行示例业务系统（equipment-inspection）

设施设备点检（灭火器、应急灯、AED……）的小型业务系统。基于 server-kit 构建，conformance 52 / 52。

```sh
# PostgreSQL 需要在 127.0.0.1:5432 上运行
export EQUIPMENT_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/equipment_inspection   # 首次运行时创建
pnpm --filter @dsh-bridge/example-equipment-inspection start                                      # http://127.0.0.1:19730
```

空 DB 中会写入 4 名虚构员工和 5 台设备（其中 1 台已超期）。在浏览器中打开 http://127.0.0.1:19730/ 并登录，可以试用：
「連携コードを発行」（签发绑定码）→ 向机器人发送「連携 123456」（绑定 123456）→ 显示在「連携中の SNS」（已绑定的 SNS）中 → 解除绑定 → 打开 / 关闭超期通知。
登录密码由 `EQUIPMENT_SEED_PASSWORD` 决定（开发用的默认值见仓库的 `src/config.mjs`，正式环境中不得使用）。

```sh
# 业务测试（16）与 conformance（52 项）
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres \
  pnpm --filter @dsh-bridge/example-equipment-inspection test
```

### a.3 e2e（mock 的 IM 与 LLM）

```sh
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres pnpm run e2e   # packages/testing/e2e/run.mjs
#   -- --keep（不清理） / -- --reuse-home（复用 profile 的依赖） / -- --json-only
```

把示例业务系统（equipment-inspection）＋ 用 profile 模板生成的产品 profile（名称 `fw-e2e`）＋ framework 的插件，
在**真正的 DSH** 上连接 mock LLM、mock LINE 和 `@dsh-bridge/gateway` 运行（`@dsh-bridge/testing`）。完全不连接真实的 IM 和模型，
密钥每次重新生成。使用临时 DB `fw_equipment_e2e_test`、隔离的 home `.dsh-home-e2e`（不使用个人的 `~/.dsh`），
不使用演示环境等的端口（可用 `FW_E2E_PORTS="app=…,dsh=…,llm=…,line=…,gateway=…,other=…"` 修改）。耗时约 70 秒，
结束后清理所启动的进程、DB 和 home（用 `--keep` 保留）。**15 / 15 步骤，场景 a～f 全部 PASS**。
e2e 的产品 profile 由模板生成，因此按 d.8 的关闭设置（产品的值）运行。还会确认自动任务的报告只以固定文案送达、AI 的 summary 不会出现在
IM 中（固定的投递对象和邮件路径处于关闭状态，因此不会出现在 e2e 中）。
e2e 和 `pnpm demo` 使用固定版本的 DSH CLI（`profile/template/package.json` 的 `dshBridge.expectedDsh`，0.2.2-rc.1）在
`.dsh-cli/<version>/` 里的本地副本（第一次运行时用 npm 安装，`packages/testing/src/dsh-cli.mjs`），不使用也不改动全局安装的 DSH。
用 `DSH_BIN=<…/@deepseek-ai/dsh/lib/bin.js>` 可以换成别的 CLI。在你自己产品的 BFF 中，`resolveDshBin()`（`@dsh-bridge/gateway`）按
`DSH_BIN` → `pnpm root -g` → `npm root -g` 的顺序查找。

| 场景 | 确认的内容 |
|---|---|
| a | 未绑定的 LINE 用户只收到引导（不调用 LLM）→ 在业务 Web 中获取绑定码 → 用「連携 123456」完成绑定 |
| b | 提问 → AI 以本人的委托调用由 manifest 生成的读取工具（`facility_list_overdue`） |
| c | `inspection.overdue` → plugin-events → plugin-notify → 已绑定员工的 LINE 收到 AI 秘书的文案（【対応のお願い】（请求处理）、▶ 开头的行、「— 設備点検 AI 秘書」（— 设备点检 AI 秘书）） |
| d | 维修申请 → 审批人的 LINE 收到审批卡片 → 用按钮审批 → 卡片更新为【ご報告】（报告）。第 2 件用回复码（「差戻 <code> 理由」（退回 <code> 理由））退回 |
| e | manifest 的 playbook（`pb_equipment-inspection_overdue_followup`，用 `install.mjs --enable-auto-tasks <id>` 启用）对每个 event 只运行 1 次（dedupe），用 `facility_propose_reschedule` 提案，并以 AI 秘书的固定文案（`audienceText: template`）向 audience 报告。AI 的 summary 不会出现在 IM 中 |
| f | 隔离：其他应用的工具被拒绝（不发送令牌），角色之外的读取工具被拒绝，委托令牌无法写入——需要服务令牌——且在其他应用中被拒绝 |

结果为各场景的 PASS / FAIL 以及 `packages/testing/e2e/.work/result.json`。

### a.4 在隔离的 home 中运行 DSH

```sh
node profile/scripts/install.mjs --home .dsh-home-trial --skip-install     # 个人的 ~/.dsh 会被拒绝
cd .dsh-home-trial
DSH_HOME=$PWD DSH_AGENTS_HOME=$PWD/agents BRIDGE_DSH_WORKSPACE=$PWD/workspace \
INSPECTION_API_URL=http://127.0.0.1:19730 INSPECTION_SERVICE_TOKEN=<从密钥保管处获取> \
dsh --profile bridge --no-open --host 127.0.0.1 --port 3280 --public-url http://127.0.0.1:3290/dsh/
```

端口仅为示例（3280 = DSH，3290 = 业务 Web 的 BFF）。不要使用演示环境和正式环境所用的端口（3010、3080、3180、8790 等。e2e 的 `assertPortsUsable` 拒绝的
列表在 `packages/testing/e2e/run.mjs` 的开头）（d.7）。

DSH 输出的 `dsh web: …?token=…` 是 DSH owner 的凭据。不要交给浏览器，只由 `@dsh-bridge/gateway` 使用。
DSH 也会读取工作目录中的 `.env`，因此不要在仓库根目录下启动。

---

## b. 将业务系统接入 AI 员工（步骤）

整体流程（示例：`examples/equipment-inspection`。既有系统和新系统都相同）。

```mermaid
flowchart LR
  N["0 若为新系统<br/>存放位置与依赖"] -.-> M
  M["1 编写并验证<br/>manifest"] --> H["2 实现 hooks<br/>（或为既有 API 起别名）<br/>接收人规则"]
  H --> E["3 在业务事务中<br/>写入 event"]
  E --> C["4 conformance<br/>52 项"]
  C --> R["5 在 DSH profile 中注册<br/>bridge-apps・机器人<br/>关闭发送设置"]
  R --> W["6 在业务 Web 中加入<br/>web-kit 的画面<br/>（个人机器人）"]
  W --> A["7 带委托类别<br/>启用自动任务"]
  A -.-> O["8 操作手册・9 外部连接<br/>（可选）"]
  O -.-> D["完成条件<br/>（命令）"]
```

### b.0 新建业务系统

不是在既有系统上追加，而是在 framework 之上新建业务系统时（示例：`examples/equipment-inspection`）。Bridge 部分由 server-kit 负责，
业务系统只需编写业务本身、hooks、manifest、操作手册、测试、产品 profile，以及业务 Web 和 BFF（使用 web-kit 和 gateway）。

**存放位置与依赖**（`@dsh-bridge/*` 自 0.1.0 起已发布到 npm：https://www.npmjs.com/org/dsh-bridge 。framework 内部包之间的依赖为 `workspace:*`）：

| 存放位置 | 依赖的写法 | 适用场景 |
|---|---|---|
| framework 的 workspace 内：`examples/<system-id>/`（`pnpm-workspace.yaml` 包含 `examples/*`） | `"@dsh-bridge/server-kit": "workspace:*"` 等。在 framework 根目录执行 `pnpm install` | 示例、验证、与 framework 一起试用的阶段 |
| 独立仓库（产品） | `npm install @dsh-bridge/server-kit`（或 `pnpm add`），固定为验证过的版本 | 产品仓库 |
| 独立仓库，且需要尚未发布的 framework 改动 | 先在 framework 的 checkout 中完成 `pnpm install`，再在业务系统的 `package.json` 中写入 `"@dsh-bridge/server-kit": "file:<framework>/packages/server-kit"` 等，并用 **npm** 安装（`npm install`。npm 只创建链接，包内的 `workspace:*` 由 framework checkout 的 `node_modules` 解析）。pnpm 的 `file:` 无法解析 `workspace:*`，会以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 中止。仅在该改动发布之前使用 | 试用未发布的改动 |

`pg` 是 server-kit 的 peer（如使用 PostgreSQL 的 store，需加入业务系统的依赖）。web-kit 以 `.ts` 原样分发，因此由业务 Web 的打包工具（Vite 等）读取。

**文件结构**（与 equipment-inspection 相同的划分。只有最后的 `web/`、`bff/` 示例中没有）：

```
bridge.manifest.yaml      b.1（system.id = DSH 的应用 id）
src/config.mjs            仅环境变量（密钥的默认值仅用于开发，生产环境必须设置。拒绝其他系统的 DB 名。d.7）
src/auth.mjs              自身的登录与会话：authenticate(req)・isSessionLive（b.2）
src/domain.mjs            业务规则。状态变化通过 kit.tx + kit.emitEvent（b.3），审批规则（mayDecide）集中在一处
src/hooks.mjs             employees・recipientsFor（范围与逐人关卡见 d.8・b.2。示例用 mayViewEquipment，与 Web 列表同一规则）・approvals・proposalKinds・reports・piiScan（・eventDelegations）
src/routes.mjs            将业务 API（/api/*）挂到 kit 的 router：AI 的读取用 kit.readToolPolicy，写入用 { allow: ['user'] }
src/help.mjs              操作手册 → 索引 → createHelpService（b.8）
src/app.mjs, server.mjs   createBridgeApp + store.migrate() + 业务迁移（migrate / readMigrations）、startScheduler（b.3）
src/migrations/*.sql      业务表（bridge_* 由 kit 创建）
manual/NN-*.md            1 个画面 = 1 节（b.8）
test/fixtures.mjs         conformance 的 fixtures（b.4）
test/conformance.test.mjs 用通用 HTTP adapter 运行 suite（示例为 equipment-inspection 中同名文件）
test/*.test.mjs           业务测试（完成条件的第 3 项）
<product>/dsh-profile/    profile/template 的副本（b.5），以及手写的工具与文案模块（c）
web/                      业务 Web（React + web-kit。Vite 等打包工具、tsc。b.6）：SNS 绑定・通知设置・审批・AI 提案・AI 员工设置等
bff/                      业务 Web 的 BFF（同源。b.6・d.9）：@dsh-bridge/gateway（/dsh/*・rpcAllowlist），浏览器的 /bridge/v1/me/* 等
                          不带密钥转发，仅 BFF 自身的调用（票据・附件转换・个人机器人注册）使用 x-bff-secret，个人机器人则使用本人用 RPC
```

- **framework 中没有 web/ 和 bff/ 的示例**（equipment-inspection 只由业务系统自身从 `public/` 提供 1 个画面〔原生 JS〕，既不使用 BFF
  也不使用 web-kit，也未提供仅 BFF 才有的操作〔Web 助手・个人机器人注册〕）。构建时的规则全部写在 b.6（画面・转发・`x-bff-secret`）和
  d.9（本人用 RPC）中。也可以不设 BFF 而由业务系统提供画面，但此时无法使用仅 BFF 才有的操作（不得通过把密钥暴露给浏览器
  来代替）。

- **MUST NOT** 为了自己的系统修改 framework 内部（`packages/*`・`plugins/*`・`vendor/*`・`profile/template`・`profile/scripts`）
  （放在 `examples/<id>` 时也一样）。不足之处通过 hooks（b.2）、`toolModules` / `templateModules`（c）、插件与 profile 的设置（c・d.8）、
  产品 profile 的副本（b.5）来补充。仍然无法实现的，作为 framework 的 issue 提出，并作为 framework 的变更连同测试和文档一起修正。
- 角色名称可自由命名（在 conformance 的 fixtures 中映射到 suite 的通用角色。b.4）。
- 最终判定见[完成条件](#完成条件用命令确认)。

### b.1 编写 manifest

manifest 是业务系统的"自我介绍"。DSH 读取它来组装 AI 员工的词汇、工具、event 的分类、通知文案和 playbook。
从 `packages/protocol/manifests/example.manifest.yaml`（日报）或 `examples/equipment-inspection/bridge.manifest.yaml` 开始
（`packages/protocol/manifests/equipment-inspection.manifest.yaml` 是用于验证的副本，不含操作手册的工具。应从 examples 中的那份开始）。

```yaml
bridge: 1                         # 协议的 major（常量）
version: 2026-10-26               # manifest 的版本（SemVer 或日期）。etag 根据内容生成
system: { id: equipment-inspection, name: 設備点検, locale: ja-JP, timezone: Asia/Tokyo }

roles:                            # 角色及 AI 委托的上限（delegation: none | read | propose）
  admin:     { label: 施設管理者, scope: all,      delegation: propose }
  manager:   { label: 設備責任者, scope: all,      delegation: propose }
  inspector: { label: 点検員,     scope: assigned, delegation: propose }

entities:                         # 数据种类与个人信息分类（none < personal < financial < sensitive < health）
  equipment:    { label: 設備・備品, pii: none, link: "/equipment/{id}" }
  approval:     { label: 承認,       pii: none }      # 下方 approval.* 的 aggregate
  sns_identity: { label: SNS 連携,   pii: personal }

audienceRules:                    # 接收人规则的名称与说明（由业务系统的 recipientsFor 解析。DSH 不生成接收人）
  assignee_and_managers: { description: 設備の担当点検員と、施設管理者・設備責任者。, roles: [admin, manager], includes: [assignee] }

events:
  inspection.overdue:
    label: 点検期限の超過
    aggregate: equipment
    payload: [equipmentId, dueOn, daysOverdue, assigneeUserId]   # 该类型的许可列表：仅 ID・日期・件数・状态
    severity: warning
    audience: { rule: assignee_and_managers }                    # 可选：include: [<规则>]（追加的接收人）・fallback: { roles: [admin] }（仅在 0 人时转交）
    notify: { template: inspection.overdue, digestMinutes: 60 }  # 基于规则的通知（也可写 quiet: exempt / default: off）
    playbook: overdue_followup                                   # 也传给 AI 的步骤

templates:
  inspection.overdue:
    intent: action                # info【ご報告】/ action【対応のお願い】/ urgent【至急】/ approval【承認のお願い】（无按钮）/ consult【ご相談】
    action: 担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。
    description: 点検期限を {daysOverdue} 日過ぎた設備があります（期限 {dueOn}）。あなたの確認対象の未点検は {count} 件です。
    params: { count: { type: integer }, daysOverdue: { type: integer }, dueOn: { type: date } }   # 没有自由文本的字符串类型

tools:                            # AI 员工的业务工具（名称为 <namespace>_*）
  - { name: facility_list_overdue, http: GET /api/inspections/overdue, access: read, roles: [admin, manager], pii: none }
  - { name: facility_list_equipment, http: GET /api/equipment, access: read, roles: [admin, manager, inspector], pii: none }
  - name: facility_propose_reschedule
    http: POST /bridge/v1/proposals
    access: propose               # 写入一律为提案（人采纳后才生效）
    roles: [admin, manager, inspector]
    input: { type: object, required: [equipmentId, dueOn], additionalProperties: false,
             properties: { equipmentId: { type: string }, dueOn: { type: string } } }

playbooks:                        # AI 员工的步骤（= 自动任务的模板）
  overdue_followup:
    agent: facility-inspection
    trigger: { events: [inspection.overdue] }      # 或 { cron: "30 8 * * *" } / { condition: ... }
    instructions: |-
      …（步骤・报告的写法・禁止事项。见下方 d.6 及 profile/template/auto-tasks/README.md 的 "Instruction rules"）
    tools: [facility_list_overdue, facility_list_equipment, facility_propose_reschedule]
    audience: { rule: assignee_and_managers }
    delegation: inspection        # 可选：以谁的委托运行。<class>（该类别的员工）或 <class>=each（触发 event 的本人。b.7）
    delivery: only_if_actionable
    approval: none
    guard: { maxRunsPerDay: 20, maxConsecutiveFailures: 5, dedupe: event }
    enabled: false                # 部署时为禁用。由运维人员启用

reports:
  daily_inspection:
    cron: ["30 8 * * *"]
    audience: { roles: [admin, manager] }
    sections: [equipment, overdue, inspections, repairs]
    sectionsByRole: { inspector: [overdue, inspections] }      # 通过委托读取时按角色显示的章节
```

**MUST** 在 manifest 中声明审批与解除绑定的 event（内容由内部插件处理：`internal: approvals_im` / `internal: identity`）。
server-kit 和业务代码**以这些 payload 的键**写入，缺少时解除绑定和创建审批会失败，conformance 的 L9・A1〜A4・E2 不通过。
bridge-validate 会在缺少这 3 个（`event.internal_missing`）、payload 的键不足（`event.internal_payload`）、写了其他 `internal`
（`event.internal_owner`）时发出警告（以无警告为条件，因此实质上是错误。加上 `--strict` 时警告也会 exit 1。列表见 `@dsh-bridge/protocol` 的 `INTERNAL_EVENTS`）。
由于使用 `aggregate: approval`，还需在 `entities` 中声明 `approval: { label: 承認, pii: none }`（缺少时会出现 `ref.entity` 错误）。
`approval.decided` 也可以不加 `internal` 而作为通知的 event（payload 相同）：

```yaml
events:
  approval.requested:             # 由业务代码在创建审批的事务中发出（b.3）
    { label: …の承認依頼, aggregate: approval, severity: info, internal: approvals_im, audience: { rule: <审批人的规则> },
      payload: [approvalId, subjectType, subjectId, requiredRole, expiresAt] }
  approval.decided:               # 由 hooks.approvals.decide 和 Web 上的决定发出
    { label: …の承認の決定, aggregate: approval, severity: info, internal: approvals_im,
      payload: [approvalId, subjectType, subjectId, decision, status, channel, decidedByUserId] }
  sns_identity.unlinked:          # 由 server-kit 在解除绑定时发出
    { label: SNS 連携の解除, aggregate: sns_identity, severity: info, internal: identity, payload: [identityId, userId, platform] }
```

验证（放入 CI）：

```sh
node packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict
```

不加 `--strict` 时，即使有警告（`warn` 行）也会显示 `ok` 并 exit 0。CI 中必须加上 `--strict`
（也可以在业务测试中确认 `validateManifest(m).warnings` 为空。示例为 equipment-inspection 的 `test/domain.test.mjs`）。

除 schema 外，还会检查所有交叉引用（工具的 roles 存在、playbook 的工具存在、发送通知的 event 具有 audience 和已声明的
模板、`audience.include` / `fallback` 的规则・角色・模板存在、`<class>=each` 的 playbook 由 event 触发…），
并拒绝疑似个人信息的 payload 键和模板参数名（`residentName`・`comment`・`memo` 等。`…Id` 可以）。

### b.2 实现业务侧（server-kit 的 hooks）

```js
import { createServer } from 'node:http'
import { createBridgeApp, createPool, createPostgresStore } from '@dsh-bridge/server-kit'

const pool = await createPool(process.env.MY_DATABASE_URL)
const store = createPostgresStore({ pool })
await store.migrate()                                    // bridge_* 表（幂等）

const bridge = await createBridgeApp({
  manifest: { file: './bridge.manifest.yaml' },          // 启动时验证。通过 GET /bridge/v1/manifest 带 etag 分发
  store,
  serviceToken: process.env.MY_SERVICE_TOKEN,            // DSH 的 x-service-token
  bffSecret: process.env.MY_BFF_SECRET,                  // 业务 Web 的 BFF 的 x-bff-secret
  orgId: 'my-org', service: 'my-system', version: '1.0.0',
  hooks: { employees, authenticate, isSessionLive, recipientsFor, approvals, proposalKinds, reports, piiScan },
  // 可选：help（b.8）、connectors: { secretKey }（b.9）、attachments（d.12）、roles（见下文）
})
createServer(bridge.handler).listen(8080)                // 若用 express 则为 bridge.middleware
```

| hook | 必需 | 编写内容 |
|---|---|---|
| `employees.get(id, ctx)` / `employees.list({ roles }, ctx)` | 必需 | `{ id, role, active }`（`list` 只返回有效员工）。每次使用委托、绑定、决定时都会确认（被禁用的员工立即失去所有 token）。批量查询的 `employees.getMany(ids, ctx)` 为可选 |
| `authenticate(req)` | `/me/*` 必需 | 业务系统自身的会话（cookie / bearer）→ `{ user: { id, role }, sessionId }`。kit 不接触密码 |
| `isSessionLive(sessionId, ctx)` | 可选 | 让 Web 助手的票据和委托随 Web 会话一起结束 |
| `recipientsFor(event, ctx)` | 通知必需 | `null`（不通知）／`{ stale: '原因' }`（情况已变化，无需通知）／`{ users, paramsFor(user), link, dedupeKey, template? }`。kit 会应用本人的设置、排除已通知者、投递渠道的优先顺序、免打扰时段 |
| `approvals.{get, approvers, card, mayDecide, decide}` | 审批必需（达到 52 / 52 也需要） | 审批规则与 Web 使用**同一函数**。`get(id, ctx)` → `{ id, status, expiresAt, requestedBy, … }` 或 null（**camelCase**：kit 用 `expiresAt` 判断期限，用 `requestedBy` 将申请人从接收人中排除。不要返回 DB 的原始行〔`expires_at`〕。`ctx.lock` 时使用 `FOR UPDATE`）・`approvers(approval, ctx)` → `[{ id, role }]`・`card(approval, ctx)` → `{ title, fields: [{ label, value }], body, wording? }`（仅 ID・金额・期限）・`mayDecide(approval, user, ctx)`・`decide(approval, { action, actor, channel, comment, deliveryId }, ctx)`（在 `ctx.t` 中写入决定并发出 `approval.decided`）。若使用自定义状态名，用 `state(a)` 映射到 `'pending'` |
| `proposalKinds[kind]` | 提案必需 | `{ roles, validate(payload, ctx, principal), apply(payload, actor, ctx, proposal) }`。`apply` 仅在人采纳时、在 kit 的事务中运行：**业务写入使用 `ctx.db`**（用 pool 写入会与采纳记录处于不同事务）。`connector_write` 是外部连接使用的名称（b.9） |
| `reports` | 报告必需（达到 52 / 52 也需要） | `{ kind?, compute(viewer, ctx) }`。`viewer = { id?, role?, sections }` → `{ sections: { <章节名>: 件数的 object }, attention, date? }`。kit 只保留 `viewer.sections`（manifest 的 `sectionsByRole`）。manifest 中有多个报告时用 `kind` 选择 |
| `piiScan(text, ctx)` | 持有姓名的系统必需（d.10） | `{ kinds: string[] }`（仅 `staff_name` 等类别。不返回命中的字符串）。由 `POST /bridge/v1/pii-scan` 与 kit 的格式检查类别一并返回。hook 抛出异常时返回 503 `pii_scan_failed`（不保存记忆）。示例为 equipment-inspection（显示名名册） |
| `eventDelegations[type]` | `<class>=each` 必需 | `{ eligible(event, user, ctx), personOf?(event), maxAgeHours? }`。针对 `POST /delegations { event: { id } }`，签发该 event 本人（默认 `payload.userId`）的委托。`eligible` 是本人的设置（例：「AI に下書きを任せる」（让 AI 代写草稿））。在签发时和**每次使用**时确认，不再满足时 token 立即失效。未知类型返回 422，过旧的 event 返回 409（默认 12 小时），本人不再符合条件返回 403（不说明是谁）。没有该 hook 时 `event` 返回 400 |

所有 hook 都接收 `ctx = { db, t, emitEvent, now, lock? }`（`ctx.db` 是当前事务的 client）。hooks 以外的选项：
`roles: { reportReaders, reportRunners, proposalReviewers, admins }`（默认：报告 audience 的角色・`admin`・报告的读者・`admin`。**可采纳提案者的
默认值为报告的读者**，`admins` 是管理 AI 员工设置・附件设置・外部连接的人）、`aiProfile: false`、`attachments`（d.12）、`connectors`（b.9）、
`help`（b.8）、`personalBotPlatforms`。表中未列出的细节见 server-kit README 的 "Hooks"。

`recipientsFor` 的示例（摘自 equipment-inspection 的 `src/hooks.mjs`）：

```js
async function recipientsFor(event, ctx) {
  if (event.type !== 'inspection.overdue') return null
  const { equipmentId, dueOn, daysOverdue } = event.payload
  const e = (await ctx.db.query('select active, next_due_on, assignee_user_id from equipment where id = $1', [equipmentId])).rows[0]
  if (!e || !e.active) return { stale: 'equipment_retired' }
  if (e.next_due_on > dueOn) return { stale: 'inspected' }        // 已点检：不通知
  const users = /* 负责的点检员 + 有效的 admin / manager */ []
  return {
    users,
    template: 'inspection.overdue',
    dedupeKey: `inspection.overdue:${equipmentId}:${dueOn}`,
    link: `/equipment/${equipmentId}`,                            // 业务 Web 打开时会重新授权
    paramsFor: (u) => ({ count: /* 此人确认对象的件数 */ 0, daysOverdue, dueOn }),   // 仅数值和日期
  }
}
```

接收人的确定方法（d.8 的 MUST）：`users` 中只能放入该 event **与其相关**的人（角色・所属・负责范围）。大型系统中
可以使用 CareBilling 的 `decideRecipients` 形式 ― 让规则（角色・发给本人・排除的人）带上 event 的**对象**（服务对象・事业所・整个法人…），
将角色接收人限定为对象范围内的员工，最后在**关卡**处逐人用与 Web 授权相同的函数确认"此人能否在业务 Web 中看到同一对象"，
被筛掉的人不发送，并记入审计（仅 ID 和原因代码）。件数（`paramsFor`）按接收人可见的范围计数。无法确定范围时
不发给任何人（`{ stale: 'no_scope' }` 等）。

业务 API 中供 AI 读取的 GET，只有在 manifest 中列为读取工具时才接受委托：

```js
bridge.router.add('GET', '/api/inspections/overdue', bridge.kit.readToolPolicy('GET /api/inspections/overdue', ['admin', 'manager']), handler)
bridge.router.add('POST', '/api/inspections', { allow: ['user'] }, handler)   // 写入仅限人的会话（委托返回 403）
```

### b.2' 以别名挂载到既有 API（CareBilling 的方法）

已经具有相同功能路由的系统，无需重建即可将 `/bridge/v1` 以**别名**挂载（将对应开头检查清单各项的路由
整理成对照表。没有的项先补上再起别名）。

```js
import { aliasTableFromOpenApi, camelRows, registerAliasRoutes } from '@dsh-bridge/server-kit'
const table = [
  { operationId: 'lookupIdentity', method: 'GET', path: '/identity', aliases: [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] },
  { operationId: 'listMyIdentities', method: 'GET', path: '/me/identities', aliases: [{ method: 'GET', path: '/api/sns-identities', status: 'shape' }] },
]   // 或 aliasTableFromOpenApi(带注解的 bridge-v1.yaml, { key: 'x-alias' })
registerAliasRoutes(router, { table, from: legacyRouter, adapters: { listMyIdentities: camelRows('identities') } })
```

- `status`：`exact`（形状相同）・`shape`（需要形状转换：`adapters`）・`missing`（尚不存在）。若按调用方种类（principal）使用不同路由，
  则写 `for: ['service' | 'delegated' | 'user']`。无法解析的别名列入 `skipped`，不会悄悄提供。
- 若将对照表写在带注解的 `bridge-v1.yaml` 的 `x-alias` 中，可用 `bridge-validate aliases <file> --extension x-alias --label my-app` 列出，
  用 `lintOpenApi(doc, { aliasExtension, requireAliases })` 检查。CareBilling 的对照表：`examples/care-billing/manifest/care-api-v1-aliases.md`。
- 若使用 Node 以外的语言，直接实现 `packages/protocol/openapi/bridge-v1.yaml`，并用 conformance suite 验证。

### b.3 在业务事务中写入 event

```js
return kit.tx(async (t) => {                                    // 业务行与 event 在 1 个事务中（outbox）
  const { rows } = await t.db.query('insert into inspection (...) values (...) returning id', [...])
  await kit.emitEvent(t, {
    type: 'inspection.completed', aggregateType: 'inspection', aggregateId: rows[0].id,
    payload: { inspectionId: rows[0].id, equipmentId, result: 'ok', inspectedOn, inspectorUserId },   // 仅许可列表中的键
  })
  return { status: 201, body: { ok: true, id: rows[0].id } }
})
```

- **MUST** 在与业务变化相同的事务中写入（不把未 commit 的变化告知 DSH，不遗漏已 commit 的变化）。
  在置于既有系统之外的外挂模式中，由 b.10 的接入（试行）代替。
- **MUST** payload 只能包含 manifest 中该类型许可列表的键。违反时抛出 `EventRejected`（错误中不输出值）。
- 在 Web 上决定审批时，用 `t.revokeApprovalDeliveries({ approvalId })` 使 IM 的卡片失效。
- 定期业务处理（扫描超期项等）使用 `startScheduler({ kit, tasks: [{ name, everyMinutes, run }] })`（manifest 的 `reports.*.cron` 的保存也
  由同一 scheduler 执行）。需保证幂等（每个期限・日期 1 次）。若使用外部连接的规则，则加上 `{ name: 'connector-rules', everyMinutes: 1, run: () => kit.connectors.tick() }`（b.9）。

### b.4 通过 conformance suite

```sh
# 通用 HTTP adapter（在 base URL 上提供 /bridge/v1 的系统）
BRIDGE_BASE_URL=https://staging.biz.example.com \
BRIDGE_SERVICE_TOKEN=... BRIDGE_BFF_SECRET=... \
BRIDGE_FIXTURES=./my-fixtures.mjs BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml \
node --test packages/protocol/conformance/http.test.mjs
```

- 针对 **TEST 环境**运行（不要指向生产・演示环境）。fixtures（`conformance/fixtures.example.mjs`）提供各角色已登录的
  员工，以及可选的 hook（绑定码过期・委托过期・会话结束・员工禁用・发送通知的 event・待审批…）。
  没有 hook 的项会被 **skip** 并显示在汇总中（未试过的行为不会被验证）。
- 希望自行启动并准备 DB、或改写为旧路径的系统，使用**应用 adapter**（`BRIDGE_ADAPTER=./my-app.adapter.mjs`，
  示例 `conformance/adapters/example-adapter.mjs`）。
- **MUST** 发布时 52 项全部 pass，`knownGaps` 为空，无 skip。由于不允许 skip，以下各项**实质上是必需的**：
  - 报告（manifest 的 `reports` 与 `hooks.reports`）。缺少时 10 项不通过（R1〜R3，以 `GET /bridge/v1/reports/latest` 作探针的 P4・L9・D6・D7・S2・S4，以及也检查报告路径的 D3）。
  - 审批（`hooks.approvals`，fixtures 的 `capabilities.approvals: true` 和 `createPendingApproval`）。为 `false` 时 A1〜A4 被 skip。
  - 个人机器人（fixtures 的 `personalBotPlatform`。注册和所有者规则由 server-kit 负责）。`capabilities.personalBots: false` 时 B1〜B4 被 skip。
  - 2 种提案类型：委托角色可以创建的（`proposalSample`：PR1・PR2），以及该角色不能创建的（`proposalForbiddenSample`：PR3）。
  - fixtures 的 hook：`expireLinkCode`・`expireDelegation`・`revokeSession`・`deactivateEmployee`・`emitNotifiableEvent`・`createPendingApproval`・
    `produceEvents`・`tryEmitEvent`・`writeProbes`（见 `conformance/fixtures.example.mjs` 的列表。业务写入的 API 全部列入 `writeProbes`）。
- **角色映射**：suite 用通用角色名（`admin`・`manager`・`staff`・`billing`）创建员工（如 `fx.newEmployee('staff')`）。fixtures 的 `employees`
  持有 `admin`・`manager`・`staff` 3 人，`newEmployee(role)` 将这 4 个名称映射到自己的角色。映射目标：`admin` = 可立即执行报告的管理员
  （即便如此也看不到他人的绑定），`manager` = 可阅读报告、进行审批和采纳提案的角色，`staff` / `billing` = 不能阅读报告的普通角色
  （equipment-inspection 中 `staff` / `billing` → `inspector`）。`roles` 中列出 manifest 的所有角色（M3）。
- `emitNotifiableEvent({ employee })` 创建**接收人中包含该 `employee`** 的 event（若接收人规则类似"预约的本人"，则创建以此人为本人的
  业务数据）。fixtures 的示例为 `conformance/fixtures.example.mjs`，实际文件为 `examples/equipment-inspection/test/fixtures.mjs`。

### b.5 注册到 DSH 的产品 profile

1. 将 `profile/template/` 复制到自己的产品中，填写 `cordis.patch.yml` 中所有的 `<placeholder>`（`install.mjs` 会对剩余项发出警告；YAML 注释中的
   `<…>` 不计入）。模板中的 `auto-tasks/example-report-overdue.json`（示例日报应用 `example-app` 的任务）请删除或替换为自己的任务
   （若保留，会以禁用状态进入 `tasks.json`）。
2. 在 dsh-im 中创建**应用的机器人**，并记下其 `botId`（WeCom 自建应用、Slack App、LINE 官方账号、Teams Bot、Lark 应用。
   个人 WeChat 一个账号只能有一个机器人，因此用 `multiApp: true` 挂到多个应用上）。
3. 编写注册表 `bridge-apps`：

```yaml
- id: bridge-apps
  name: '@dsh-bridge/dsh-core'
  config:
    strict: true                                  # 应用有 2 个以上：不属于任何应用的机器人无人处理
    aiProfileRefreshSeconds: 60                   # 重新获取 AI 员工资料（paths.aiProfile、etag / 304）的间隔
    applications:
      - id: equipment-inspection                  # = manifest 的 system.id
        name: 設備点検                             # 【設備点検】与署名「— 設備点検 AI 秘書」（有昵称时为「— はると（設備点検 AI 秘書）」）
        aliases: [点検]                            # 共用机器人中的「#点検」
        namespace: facility                       # 工具为 facility_*
        paths: v1
        apiUrlEnv: INSPECTION_API_URL             # 每次调用时读取（没有则用 apiUrl）
        apiUrl: http://127.0.0.1:19730
        serviceTokenEnv: INSPECTION_SERVICE_TOKEN # 令牌本身不写进 yml
        manifestUrl: /bridge/v1/manifest          # etag / 304
        manifestFile: pkg:@dsh-bridge/example-equipment-inspection/bridge.manifest.yaml   # URL 无法访问时的备用
        generateTools: true                       # 根据 manifest 生成读取工具
        agents: [facility-inspection]
        delegation: { unattendedPolicy: deny }    # 自动任务默认不接触业务数据
        bots:
          - { platform: slack,     botId: <设备点检的 Slack App 的 bot id> }
          - { platform: wecom-app, botId: <设备点检的 WeCom 自建应用的 dsh-im bot id> }
          - { platform: weixin,    botId: <个人 WeChat 机器人>, multiApp: true }   # 其他应用的注册中也写 multiApp: true
```

   - `delegation: { unattendedPolicy: deny }` 是注册表的值。b.7 中 `--auto-task-delegate` 写入的值只对**默认应用**（`default: true`，
     或只有一个应用）生效。像上例那样用 `strict: true` 并列多个应用且不加 `default` 时，请参阅 b.7 中的“非默认应用”。
   - `manifestFile: pkg:…` 仅适用于能从 DSH 的 profile 解析到的包。其他仓库中的系统请使用绝对路径，或省略它只保留 `manifestUrl`。
4. 手写的工具（提案工具等；manifest 中 `access: propose` 的工具不会被生成）放在 `bridge-tools` 的 `toolModules` 中，通知的文案放在
   `bridge-notify` 的 `templateModules` 中（c 节）。`toolModules` 的 `module` 为包名或路径。
5. **发送设置在模板中是关闭的**（d.8 表中的“产品的值”）。`profile/template/cordis.patch.yml` 出厂时写有以下值
   （与 CareBilling 的 `dsh/runtime-profile/cordis.patch.yml` 相同。由 `node profile/scripts/check.mjs <cordis.patch.yml>`〔bin `dsh-bridge-profile-check`〕检查；模板本身用 `--template`）。
   请不要删除，直接使用（以下是模板相关部分的摘录，其他行已省略）。check.mjs **按文本形式**检查，因此请保持与模板相同的 block 写法
   （一行一个值，`name:` 行也保留），不要改写成一行的 `config: { … }` 形式（改写后会以 `closed_value` 失败）：

```yaml
- id: xmanrui-dsh-im
  name: '@care/dsh-im'
  config:
    forwardPluginSources: []                # 不把启动的回复抄写到会话中
- id: dsh-proactive
  name: '@care/dsh-proactive'
  config:
    modelTools: reclaim
    deliveryGuard: required
- id: dsh-auto-tasks
  name: '@care/dsh-auto-tasks'
  config:
    restrictDelivery: true
    mail: false
- id: bridge-identity
  name: '@dsh-bridge/plugin-identity'
  config:
    groupChat: deny
    messages:
      groupChat: '業務の内容は個別チャットでお尋ねください。'   # GROUP_CHAT_GUIDE
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    groupChat: deny                         # toolModules 也写在这个条目中
- id: bridge-notify
  name: '@dsh-bridge/plugin-notify'
  config:
    aiReportGuard: screen                   # template 时始终为固定文案
    proactiveDelivery: deny
    audienceFallback: none                  # 所有应用。用 applications.<id> 覆盖
    audienceText: template
```

   **开放只能是显式的 opt-in**：在产品的 patch 中修改该行，并在注释中写明理由（例如按应用
   `applications: { equipment-inspection: { audienceLink: /equipment } }`，若要开放则 `audienceText: summary`）。对已存在的条目只追加
   值（不要创建两个相同 id 的条目）。`install.mjs` 会拒绝 `--auto-task-session / --auto-task-bot / --auto-task-target`（固定的投递目标）（exit 2）。
6. 用 `node profile/scripts/install.mjs --home <dir>` 安装，并重启 DSH。
7. 模板的 bundle 中包含长期记忆 `@dsh-bridge/plugin-memory`（bridge-memory，d.10）、AI 员工资料 `@dsh-bridge/plugin-persona`
   （bridge-persona，d.11），以及让 AI 读取扫描文档的 `@dsh-bridge/plugin-reader`（bridge-reader，d.12）。业务系统若没有 `pii-scan`、`ai-profile`、
   `document-reads`，则记忆只做本地检查、没有资料、文档读取不做任何事，照样运行。
   AI 员工预设中的 persona 文本（固定规则）请原样保留（bridge-persona 会在开头叠加同样的规则）。
8. **AI 员工的预设**：将模板的 `business-assistant` 按产品调整，并为 manifest 中 playbook 的每个 `agent` 追加同样形式的预设（模板注释中有示例；
   b.7）。若使用操作手册，请将 `helpRules('<ns>_help_search')`（`@dsh-bridge/dsh-core`）返回的文本**原样粘贴**到 persona 的 `prefix` 中
   （YAML 中无法调用函数，因此先用 node 输出一次再抄过来；b.8）。
9. **链接检查**：在 bridge-identity 中设置 `linkGuard: { webUrl: <默认应用的业务 Web 的 URL>, webUrls: { <application-id>: <该业务 Web 的 URL> } }`
   （模板注释中有示例）。**为所有应用都写上**：没有 URL 的应用不会检查 AI 回复中的链接（fail open。对于有 `web.routes` 却没有 URL 的
   应用，bridge-identity 会在该应用第一次 AI 回复时警告一次；b.8、d.8）。`check.mjs` 会检查注册表中每个应用是否有 URL
   （规则 `link_guard`：默认应用需要 `linkGuard.webUrl` 或 `webUrls.<id>`，其他应用需要 `webUrls.<id>`）。
   **只有同时具备 URL 和 manifest 的 `web.routes`（业务 Web 画面路径的模式）时，链接检查才会生效**。没有 `web.routes` 时，即使有 URL 也
   不做任何检查，也不会发出警告。不使用操作手册（b.8）的系统也要在 manifest 中写 `web.routes`（可以用 `@dsh-bridge/help` 的 `setManifestWebRoutes`
   从路由表生成）。
10. **应用有 2 个以上时**（一个 DSH 中有多个应用；ARCHITECTURE.md §6）：默认应用使用插件设置的全局值即可，但**非默认
    应用若不写各自的字段，连默认应用的值也不会被使用**（以空值运行）。对每个非默认应用：
    - `bridge-notify` 的 `applications.<id>.webUrl`（加在通知相对链接前面的源（origin）；没有则该应用通知中的链接为空），必要时还有 `bots`
    - `bridge-approvals` 的 `applications.<id>.webUrl`（审批画面的 URL，`{id}` 替换为审批 ID），必要时还有 `bots`。模板中的全局 `webUrl`
      （`BRIDGE_WEB_PUBLIC_URL` 或 `http://127.0.0.1:3010` 加 `/approvals?id={id}`）不是 `<placeholder>`，因此 check.mjs 不会计入。默认应用的值也
      要改为自己的审批画面
    - `bridge-assistant` 的 `agents[]` 中的 `application: <id>`（没有该项的 AI 员工属于默认应用，业务 Web 的面板会指向别的应用）
    - `bridge-identity` 的 `linkGuard.webUrls.<id>`（9），以及自动任务的委托（b.7 中的“非默认应用”）

### b.6 业务 Web 的画面（web-kit）与 BFF

| 画面 | 组件 | 使用者 |
|---|---|---|
| IM 机器人连接（设置 › IM 机器人） | `ImBotsShell mode="admin"`（用 `--dbw-*` 的 CSS 变量显示 dsh-im 的设置组件。`channels` 为必填：`channelDefs(DEFAULT_CHANNELS, loaders)`。dsh-im 的 client 组件由业务 Web 的打包工具通过 `createImRuntime({ loadVendor, loadWeixin })` 加载〔web-kit README“Use it”〕。用 `excludeBotIds` 排除员工的个人机器人） | 管理员（仅组织机器人） |
| SNS 绑定（设置 › SNS 绑定） | `SnsLinkPage`：① 自己的机器人（用 `personalChannels` + `personalRpc` 以本人模式显示 `ImBotsShell`；所有渠道）② 组织机器人的绑定码 ③ 自己的绑定与解除绑定 ④ 通知设置 | 所有员工（**仅本人的绑定、本人的机器人**） |
| 通知设置 | `NotifyPrefsCard`（类型来自服务器 = manifest 中的通知 event，说明由业务侧提供；暂停通知的时段）。`labels` 为 manifest 的 `events.<type>.label`（manifest 只能用服务令牌获取，因此在构建业务 Web 时从 manifest 生成） | 所有员工 |
| AI 员工设置（管理 › AI 员工设置） | `AiProfilePage`（昵称、第一人称、语气、公司介绍、性格、背景、说话示例，署名与段落的预览，版本列表与「この版に戻す」（恢复到此版本）；`endpoint` 默认为 `/bridge/v1/admin/ai-profile`）。**默认不传 `agents`，昵称只有一个**（保存后，以前版本中按 AI 员工的覆盖会被清除）。仅在为每个 AI 员工〔preset〕分别设置昵称时才使用 `agents={[{ id: <preset id>, name }]}`（d.11） | 仅管理员 |
| 附件设置 | `AttachmentSettingsCard`（可添加附件的角色与文件类型；`endpoint` 默认为 `/bridge/v1/admin/assistant/attachment-settings`；d.12） | 仅管理员 |
| 外部连接（管理 › 外部连接） | `ExternalConnectorsPage`（紧急停止、连接对象、模板、密钥〔只发送一次，列表中显示末尾 4 个字符〕、连接测试、规则、执行记录；`base` 默认为 `/bridge/v1/admin`；b.9） | 仅管理员 |
| 帮助（操作手册） | web-kit core 的 `manualChapters` / `parseMarkdown`（不插入 HTML，渲染同一份 Markdown；AI 回复中 `manualUrl` 的目标，b.8） | 所有员工 |
| 审批、AI 提案、AI 助手的面板 | framework 中没有，按业务自行制作。**AI 提案**画面使用 server-kit 的路由：列表 `GET /bridge/v1/proposals`（`?status=pending_review` 等；本人的会话），采纳 `POST /bridge/v1/proposals/{proposalId}/accept`，驳回 `POST /bridge/v1/proposals/{proposalId}/reject`（`{ comment }`）。只有 `roles.proposalReviewers`（默认是报告的阅读者）中的人可以采纳或驳回，且仅限一次；只有采纳时 kit 才在同一事务中调用 `proposalKinds[kind].apply`。**审批**画面使用业务系统自己的 `/api/*`（`mayDecide` 与 `decide`、`t.revokeApprovalDeliveries`；b.2、b.3） | — |

```tsx
<WebKitProvider runtime={runtime}
  meIm={createMeImClient({ base: '/bridge/v1', weixinBase: '/api/me/im/weixin' })}   // 同源、本人的会话
  adminRpc={createAdminRpc('/dsh/api/dsh-im')}                                         // BFF 的 DSH 网关
  strings={{ 'sns.title': '外部アカウント連携' }}>
  <SnsLinkPage isAdmin={user.role === 'admin'} notify={{ role: user.role, labels: manifestEventLabels }} />
</WebKitProvider>
```

**BFF 的规则**（由 BFF 和业务系统来保证；web-kit 只是隐藏本人不能修改的组件）：

- 将 `@dsh-bridge/gateway` 放在 `/api/*` 转发**之前**（`gateway.handleRequest(req, res)`，WebSocket 用 `handleUpgrade`）。`getSessionUser` 用 req 的 cookie 调用业务 API 的
  登录确认（例如 `GET /api/auth/me`）。`isAllowed` 通常只允许 admin（DSH 的设置画面 `/dsh/*`）。
- 把浏览器请求转发给业务系统的，只有 web-kit 组件在同源调用的路由和业务的 `/api/*`：`/bridge/v1/me/*`（SnsLinkPage、
  NotifyPrefsCard）、`/bridge/v1/admin/ai-profile*`（AiProfilePage）、`/bridge/v1/assistant/attachment-settings` 与 `/bridge/v1/admin/assistant/attachment-settings`
  （附件）、`/bridge/v1/admin/connector*`（ExternalConnectorsPage）、`/bridge/v1/proposals` 与 `/bridge/v1/proposals/*/accept|reject`（按业务制作的
  AI 提案画面）。本人的 cookie 原样传递，**不附加 `x-bff-secret`**（由业务系统根据本人的会话和角色授权）。
- **MUST** 只在 BFF 自己在服务器端组装的调用上附加 `x-bff-secret`：Web 助手的票据（`POST /bridge/v1/assistant/tickets`）、
  附件的转换（`POST /bridge/v1/assistant/attachments/prepare`，`prepareAssistantAttachments` 的 `callPrepare`）、通过本人用 RPC 以 `createOnly` 创建
  成功后立即进行的个人机器人登记（`POST /bridge/v1/me/personal-bots`，d.9）。来自浏览器的这些请求不转发（若带着密钥中继，
  浏览器就能把组织机器人的 botId 登记为自己的个人机器人，与该机器人对话的其他员工就会全部变成“未绑定”）。
- 业务 Web 的 AI 助手：BFF 获取票据，有附件时先经过 `prepareAssistantAttachments`，再调用
  `gateway.rpc('/assistant', 'message.send', { ticket, agent, text, attachments }, { plugin: 'bridge-assistant' })`（`POST /api/bridge-assistant/assistant`）。
  票据、DSH 的 cookie、launch token 不暴露给浏览器。个人 WeChat 的二维码使用 `gateway.rpc('/weixin', 'provision.begin' | …)`（`createMeImClient` 的
  `weixinBase` 下的 `begin | poll | verify | cancel` 是由 BFF 建立的路由；不使用时设为 `weixinBase: null`）。两者都只有写在 `rpcAllowlist` 中的才能通过。
- 若提供个人机器人，需要在 BFF 中建立本人用 RPC（`POST /api/me/im/rpc/<channel>`）。这不是 framework 的组件，framework 中也没有示例
  （需要遵守的就是 d.9 中的全部 MUST：按渠道的允许列表、`botId` 仅限本人的、把响应中的 `bots[]` 缩小到本人的部分、用 `createOnly: true` 创建、
  登记新增的 botId 并在失败时删除。CareBilling 放在 `apps/care-web/me-im-rpc.mjs` 中）。在 `bot.delete` 之前，
  BFF 要通过业务 API（`GET /bridge/v1/me/personal-bots`）确认该机器人属于本人。

### b.7 启用自动任务（delegate）

自动任务的轮次没有 IM 发送者，因此默认无法读取业务数据（`unattendedPolicy: deny`）。
由运维人员选定**一名员工**（已通过 IM 绑定，且其角色能执行任务所需的读取和提案），以该员工的委托来运行。

```sh
node profile/scripts/install.mjs --home <home> --enable-auto-tasks --auto-task-delegate <platform>:<userId>[:<teamId>]
node profile/scripts/install.mjs --home <home> --disable-auto-tasks [ids]
node profile/scripts/install.mjs --home <home> --auto-task-delegate off          # 恢复为 deny
# manifest 的 playbook（DSH 启动过一次、plugin-events 完成部署之后）：指定 id
node profile/scripts/install.mjs --home <home> --skip-install --enable-auto-tasks pb_equipment-inspection_overdue_followup
```

按工作种类分别指定委托对象时，在 playbook 的 `delegation`（模板中为 `source.delegation`）中写上类别，并为每个类别选定员工：

```sh
node profile/scripts/install.mjs --home <home> --auto-task-delegate planning=line:<userId>,billing=line:<userId>,inspector=each[,default=line:<userId>]
```

- `<class>=<platform>:<userId>`：该类别的 playbook 以该员工的委托运行（bridge-tools 的 `unattendedDelegates`）。
- `<class>=each`：该类别的 playbook（`delegation: <class>=each`）**每次都以触发 event 中的本人**的委托运行。业务系统
  针对 `POST /bridge/v1/delegations { event: { id } }`，向自己的 event 中所写的人发放短期委托（可以发放的 event 类型、时效以及
  本人的设置由业务系统决定；server-kit 中为 `hooks.eventDelegations`（b.2）。DSH 一侧不能选择员工。
- 没有指定员工的类别使用 `default`（= 以前的 `unattendedOnBehalfOf`）。`<class>=each` 的模板不会被 `--enable-auto-tasks`（省略 id）
  启用，只有点名 id 时才启用。类别不是 `each` 期间，install.mjs 会警告“工具会被拒绝”。
- 不要选择权限宽泛的角色（如管理员）作为委托对象。在 bridge-tools 的 `unattendedWarnRoles` 中写上角色后，以该角色的委托运行时会留下一次警告。

- `--auto-task-delegate` 会在已安装的 `cordis.patch.yml` 中**产品自己的 `bridge-tools` 条目**里写入 `unattendedPolicy: delegate` 与
  `unattendedOnBehalfOf`（带类别时为 `unattendedDelegates`）（`toolModules` 等保持不变；没有该条目则追加到末尾）。重新安装后仍然保留，用 `off` 恢复原状。
- **这个值只对默认应用生效**（注册表中 `default: true`，或只有一个应用）。非默认应用需要在产品 patch 的
  `bridge-tools` 中手写 `applications: { <application-id>: { unattendedPolicy: delegate, unattendedOnBehalfOf: …, unattendedDelegates: … } }`
  （install.mjs 不会写这个字段；模板注释中有示例），或写在注册表的 `applications[].delegation` 中。优先顺序为 `bridge-tools.applications.<id>` → 若为默认应用则
  `bridge-tools` 的全局值 → 注册表。用 `strict: true` 并列多个应用且不加 `default` 时，`--auto-task-delegate` 对任何应用都不生效，
  自动任务会悄无声息地保持无委托（拒绝）状态（plugins/tools README 中的 `unattendedPolicy`）。
- 手写的委托（`bridge-tools.applications.<id>` 或注册表 `delegation` 中的 `unattendedPolicy: delegate`）在 check.mjs 中被视为**显式的 opt-in**
  （规则 `unattendedPolicy`；仅写上会导致完成条件 6 失败）。运行完成条件 6 时加上 `--allow unattendedPolicy`，并在 patch 中该行上方用注释写明理由
  （把哪个类别交给哪个窄权限角色的员工）。`--auto-task-delegate` 写入安装目标的值
  不会进入产品的 patch（源），因此不需要这样处理。
- manifest 的 playbook 由 plugin-events 以 `pb_<application-id>_<playbook>` 的形式部署（新部署的为禁用）。`--enable-auto-tasks <ids>` /
  `--disable-auto-tasks <ids>` 对已部署的 playbook 也有效，但**仅限显式指定 id 时**。
- **playbook 的 `agent`（例如 `facility-inspection`）会成为专用的会话预设**。请在产品 profile 中定义该预设。
- 允许的只有读取，以及该任务的 `source.tools`（playbook 的 `tools`）中列出的提案。提案和审计都以该员工的名义记录。
  若加载了 bridge-tools，bridge-apps 根据 manifest 生成的读取工具也会通过 `ctx.bridgeTools.gate(<appId>)` 授权，因此
  自动任务的委托（以及定时报告的主体）对生成的工具和手写的工具同样生效。
- deployment 持有的任务为 `profile/template/auto-tasks/*.json`（格式见 `profile/template/auto-tasks/README.md`）。
- auto-tasks 在每个 event 时重新读取 `tasks.json`（启用不需要重启）。委托（patch）和插件代码的变更需要重启 DSH。

### b.8 操作手册与 SNS 中使用方法的提问（help）

员工在 SNS 中问“〇〇在哪里？”“怎样做〇〇？”时，AI 秘书**只以业务系统的操作手册**为依据，附上**该员工能打开的画面的
URL** 来回答。准确性靠“操作手册与画面不脱节（CI）”和“不让 AI 编造 URL（只用索引中的路径、发送前检查）”来保证。

1. **操作手册**：`docs/manual/NN-*.md`（位置自由；equipment-inspection 为 `manual/`）。1 个画面 = 1 节（`## 画面名`、`<a id="manual-…"></a>`、表格：URL、菜单、可使用的角色、相关画面、
   关键词；正文：能做什么、操作流程、注意事项、常见问题）。格式见 `packages/help/README.md`。同义词写在 `_synonyms.yml` 中，
   没有对应节的路由写在 `_exclude.txt` 中（写明理由）。
2. **索引与 CI**：用脚本读取操作手册和**业务系统的路由表**（`[{ path, roles }]`：来自路由器和 Guard），
   执行 `buildHelpIndex` → 提交 JSON。在 CI 中与 `serializeIndex(buildHelpIndex(...))` 比较，并确认 `check*`（路由、覆盖、角色、菜单名、锚点、
   链接、通知中的链接）为空。manifest 的 `web.routes` 也由同一脚本写入（`setManifestWebRoutes(text, routes)`：manifest 中
   有 `web:` 则替换其中的 `routes`，没有则在 `roles:` 之前追加 `web:`）。写在 `_exclude.txt` 中的路由也要保留在路由表中（从表中删除会使
   `check*` 以“exclusion … is no route any more”失败）。
   示例 equipment-inspection 采用简易形式：只有一个画面（`/`），因此索引在启动时由 `src/help.mjs` 生成（既不提交，也不与 `serializeIndex` 比较），
   `test/help.test.mjs` 只确认 `check*` 为空以及回答内容。manifest 的 `web.routes` 手工写成与画面表相同的值（只有 `/`）（b.5 的 9）。
   画面较多的系统应采用提交并比较索引、写入 `web.routes` 的形式（CareBilling 为 `tools/manual-index.mjs`）。
3. **API**：使用 server-kit 时为 `createBridgeApp({ help: createHelpService(index, { webBase, roleLabels, manualPage }) })`。
   若用 `help.onQuestion` 记录提问，不要保留个人信息（CareBilling 只保留通过 PII 检查的文本，保存 90 天）。
4. **manifest**：`help: { tool: <ns>_help_search }`，并把该工具（`GET /bridge/v1/help/search`、read、全部角色）写入 `tools`。
   DSH 会把这个工具生成为操作手册的检索。将 `helpRules('<ns>_help_search')`
   （`@dsh-bridge/dsh-core`）返回的文本粘贴到 AI 员工的 persona（产品 profile 中 preset 的 `prefix`）（YAML 中无法调用函数，因此先用 node 输出一次再抄过来；b.5）。
5. **DSH**：在 bridge-identity 的 `linkGuard` 中写入业务 Web 的 URL（与生成回复 URL 一侧相同的值）：默认应用为 `webUrl`，**其他应用为
   `webUrls.<application-id>`**。没有 URL 的应用不做任何链接检查（fail open。对于有 `web.routes` 却没有 URL 的应用，
   bridge-identity 会在该应用第一次 AI 回复时警告一次），因此
   要为所有应用都写上（由 check.mjs 的 `link_guard` 检查）。只有同时具备 URL 和 manifest 的 `web.routes`（2）时，检查才会生效。
   面向未绑定发送者的公开节回复（`publicHelp`）在 manifest 中有 `help` 时启用。
6. **业务 Web**：在 `manualPage`（默认 `/help/{chapter}#{id}`）放置帮助画面（用 web-kit core 的 `manualChapters` 渲染同一份 Markdown）。
   该路由也要放入 `web.routes`。

**规则**：回答只依据返回的节来写（found=false 时说“没有找到”，不要编造步骤）。URL 原样使用返回的值。对于本人打不开的画面，
不给出 URL，而是告知请 `alt` 中的角色代为处理。业务数据的提问用业务工具来回答。

### b.9 外部连接（连接对象、操作、规则）

让 AI 员工使用本公司其他 API 及第三方 API（会计、考勤、地图、CRM 等）的机制（可选；设计与决定见 docs/AI_EMPLOYEE_PROFILE.md §3 和
“实现记录（P2、P3）”）。**密钥和调用都在业务系统中**：AI 和 DSH 不知道连接对象的 URL 和 API 密钥，只是以委托调用业务系统的路由。

1. **server-kit**：`createBridgeApp({ connectors: { secretKey, allowLocalhost?, onApprovalNeeded?, onProposeByAi?, onRunResult? } })`。
   `secretKey` 是 32 个字符以上的密钥材料（用 AES-256-GCM 封装 API 密钥后保存）。通过环境变量传入，不写进仓库或 yml（equipment-inspection 为
   `EQUIPMENT_CONNECTOR_KEY`，生产环境中拒绝默认值）。`allowLocalhost` 仅用于开发。表为 `bridge_connector*`（`store.migrate()`）。
   路由：`GET /bridge/v1/connectors/catalog`（服务、etag；不输出 URL 和密钥）、`POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run`
   （委托，**仅 read**；角色 ∈ `operation.roles`；write 返回 403 `write_requires_approval`），以及管理员（`roles.admins`）用的 `/bridge/v1/admin/connectors*`
   （连接对象、密钥、连接测试）、`/admin/connector-rules*`、`/admin/connector-runs`、`/admin/connector-settings`（紧急停止）。
   会增加提案类型 `connector_write`（不要在自己的 `proposalKinds` 中使用同名）。
2. **规则**：在 `startScheduler` 的 task 中加入 `kit.connectors.tick()`（每分钟；b.3）。trigger 为 manifest 的 event 或 cron，条件只有等于、包含、大小比较和存在，
   `mode` 为 `approval`（默认）/ `auto`（仅限 read，以及管理员写明理由后允许的幂等 write）/ `propose-by-ai`。启用该功能之前的 event 不会触发。
3. **写操作需要人工审批**：AI 的工具不执行 write，而是创建 `connector_write` 的提案（采纳后由业务系统执行；失败时返回 502 `connector_failed`，提案保持待处理）。
   规则的 `approval` 通过 `onApprovalNeeded({ proposal, connector, operation, rule, approverRole }, ctx)` 交给业务系统的审批机制（b.2 的 approvals、
   接收人规则）。`propose-by-ai` 通过 `onProposeByAi` 触发业务系统的自动任务（没有则按审批处理）。结果交给 `onRunResult`（仅状态和类别）。
4. **DSH**：若为 `paths: v1`，路由 `connectorCatalog` / `connectorRun` / `connectorPropose` 保持默认即可。bridge-tools 根据列表生成 `<namespace>_ext_<连接对象>_<操作>`
   （read 以本人的委托 run，write 为提案；`connectorTools` / `connectorRefreshSeconds`）。不要在 DSH 的 profile 中写连接对象的 URL 和密钥。
5. **业务 Web**：仅管理员可用的“外部连接”使用 web-kit 的 `ExternalConnectorsPage`。BFF 将 `/bridge/v1/admin/connector*` 带着本人的 cookie 原样转发，不附加密钥（b.6）。
6. 规则见 d.13。先从 1～2 个 read 开始。

### b.10 外挂模式：把桥接放在既有系统之外（试行）

> **试行**（2026-10-30 新增）：尚未在实际系统上验证（PoC）。会根据验证结果调整。发布条件（52 / 52、`knownGaps` 为空、无 skip）
> 不变。判断依据见 [EXTERNAL_LAYER_FEASIBILITY.md](EXTERNAL_LAYER_FEASIBILITY.md)（中文）。

不改动既有系统的代码，而在其外部放置一个**桥接专用的服务**（外挂桥接），调用既有系统的 API 并对外提供 Bridge v1 的形式。
外挂桥接构建在 server-kit 之上，`bridge_*` 表放在外挂桥接自己的 DB 中。从 DSH 来看，外挂桥接就是业务系统，因此
DSH、插件和 IM 一侧都不变。

```mermaid
flowchart LR
  D["DSH<br/>（不变）"] -- "Bridge v1" --> X["外挂桥接<br/>server-kit、bridge_* 表<br/>已导入的变更 ID"]
  X -- "API（以本人身份）" --> L["既有系统<br/>（代码不变）"]
  L -- "webhook / CDC<br/>（commit 之后）" --> X
  L -. "登录（IdP）" .- X
```

**是否适合：由既有系统的 4 项能力决定**

| 能力 | 使用的项目（开头的表） | 没有时 |
|---|---|---|
| 能从外部确认登录（OIDC / SAML 的 IdP，或返回“这个会话是谁”的接口） | 3（SNS 绑定）、8（会话） | 无法满足 3。不另建登录（3 的 MUST），因此不能使用外挂模式 |
| 能以本人身份调用 API（按用户的 OAuth 令牌、令牌交换〔RFC 8693〕、受信任的代理身份） | 1（读取）、6、7 | 需要把按记录的权限复制到外挂桥接中。读取仅限于只由角色决定的范围，不使用审批和写入 |
| 能通知变更（满足下列条件的 webhook，或读取 DB 的事务日志） | 5 | 无法发出审批等需要准确性的 event。只能通过轮询发出状态通知（下文导入的第 4 条） |
| 审批与写入的 API | 1（提案的 `apply`）、7 | 无法采纳提案，也无法在聊天中审批 |

- **A 型**（4 项都具备；多数 SaaS 和近年的 Web 系统）：外挂即可满足开头表中的全部项目。
- **B 型**（有 API 但不能以本人身份调用，或没有变更通知）：仅限状态通知、定时报告和读取类提问。若无法满足 7（审批），则达不到 52 / 52
  （A1～A4 为 skip），因此发布前要么为既有系统补上缺少的部分，要么按 b.0 重建。
- **C 型**（只有画面：仅服务器端渲染、桌面客户端、终端）：不使用外挂模式。通过画面自动操作（RPA）写入既脆弱，
  又无法审计。请为既有系统增加 API，或按 b.0 构建。

**在外挂模式下满足方式不同的项目**（开头表中的编号；其他项目照 b.1～b.9）

| # | 外挂模式下的满足方式 |
|---|---|
| 1 | 读取工具是外挂桥接的路由，内部**以本人身份**调用既有系统的读取 API。提案放在外挂桥接中，只有在人采纳时，`proposalKinds[kind].apply` 才以采纳者的身份调用既有系统的写入 API |
| 3 | SNS 绑定的画面（web-kit）由外挂桥接提供。登录作为既有系统 IdP 的 OIDC / SAML 依赖方进行，或通过返回“是谁”的接口确认既有系统的会话。`authenticate(req)` 返回**既有系统的员工 ID**。**MUST** 不另建密码，也不另建 ID 体系 |
| 4 | `recipientsFor` 从既有系统的 API 获取负责人、审批人和所属部门来决定。**MUST** 获取不到时不在外挂桥接中自造分配规则（会与既有的运作方式脱节）。该 event 不发通知 |
| 5 | 下文的**试行规则：event 的导入** |
| 6 | `employees.get / list` 来自既有系统的员工 API（包括有效、无效）。**MUST** 不缓存 `employees.get`（被停用的员工要立即失去所有令牌：D7、S5）。**MUST** 不用万能的服务账号调用读取 API 再在外挂桥接中过滤（按记录的权限判断会分散在两处，破坏 4 中“与 Web 授权相同的判断”） |
| 7 | `approvals.mayDecide / decide` 以本人身份调用既有系统的审批 API。**MUST** 不把审批规则复制到外挂桥接中。在既有系统做出决定之后，在外挂桥接的事务中写入 `approval.decided`，并用 `t.revokeApprovalDeliveries` 使 IM 中的卡片失效。在既有系统画面上做出决定的审批，也通过导入（下文）做同样处理。仅对既有系统中没有审批的业务，可以在外挂桥接中放置最小限度的审批（没有可复制的规则，因此不会重复） |
| 8 | `isSessionLive` 调用确认既有系统会话的接口 |

**试行规则：event 的导入（开头表中第 5 项的变形）**

开头表中的第 5 项和 b.3 的“同一事务”之所以存在，是因为事后再拾取差异会导致“通知了没有 commit 的变更、漏掉了已 commit 的变更”。
外挂桥接不在既有系统的事务之内，因此无法按字面满足。仅限外挂模式，允许使用以下能够**只导入已 commit 的变更、且不遗漏
不重复**的来源。

1. **来源**为以下之一。
   - **(a) 同一事务**（b.3）。能在既有系统内部编写时使用。不是外挂模式的主要形式。
   - **(b) DB 的事务日志（CDC）**：PostgreSQL 的逻辑复制、MySQL 的 binlog、SQL Server 的 CDC 等。只有已 commit 的变更按 commit 顺序流出。
     需要既有系统 DB 的读取权限（既有系统的代码不变）。
   - **(c) 满足以下全部条件的 webhook**：① 在 commit 之后发送　② 每个变更都有唯一且不变的 ID（变更 ID）　③ 在接收方返回 2xx 之前
     持续重发　④ 能通过签名等方式确认发送方　⑤ 有事后补齐遗漏的手段（按变更 ID 或时间重新获取的 API）。
2. **MUST** 导入在外挂桥接的**一个事务**中写入“已导入变更 ID 的记录”和 `kit.emitEvent`。同一变更 ID 从第 2 次起
   不做任何处理（以唯一约束判断）。这样从既有系统的 commit 到 Bridge 的 event 就做到了“不遗漏、不重复”。

   ```js
   // 外挂桥接自己的表（不是 bridge_*）：create table legacy_change (source text, change_id text, primary key (source, change_id))
   export async function ingest(kit, change) {        // change = 从 webhook / CDC 的一条记录中只取出变更 ID、ID、日期、状态后的内容
     return kit.tx(async (t) => {
       const { rowCount } = await t.db.query(
         'insert into legacy_change (source, change_id) values ($1, $2) on conflict do nothing', ['billing', change.id])
       if (rowCount === 0) return { duplicate: true }    // 第 2 次起：不做任何处理
       await kit.emitEvent(t, {
         type: 'invoice.submitted', aggregateType: 'invoice', aggregateId: change.invoiceId,
         payload: { invoiceId: change.invoiceId, submittedOn: change.date },   // 只用允许列表中的键
       })
       return { duplicate: false }
     })
   }
   ```

   - 需要 PostgreSQL 的 store（`createPostgresStore`）（`t.db` 是该事务的连接；memory store 的 `t.db` 为 null）。
   - 对 webhook，要在导入 commit 之后再返回 2xx（先返回的话，导入失败时就会漏掉该变更）。
   - 若 manifest 拒绝（`EventRejected`），变更 ID 的记录也不会留下，重发会一直持续。这是配置错误，因此要监控失败件数以便察觉。
3. **MUST** 从既有系统的值中只组装 manifest 允许列表中的键，再传给 `emitEvent`（不传姓名、自由文本、健康信息；d.2）。
4. **MUST** 轮询（定期按 `updated_at` 等读取差异）只用于不需要准确性的状态通知（例如“有 N 件未处理”）。它会漏掉中间状态和删除，
   因此不要用于审批（`approval.requested` / `approval.decided`）、期限、金额变化等一旦遗漏就会出问题的 event。哪些类型通过轮询发出，要写在
   外挂桥接的 README 中。
5. **SHOULD** 测量从既有系统的 commit 到 Bridge event 的延迟，确定上限（例如 1 分钟）并进行监控。CDC 位置的滞后和 webhook 的失败只输出件数（不输出内容）。
6. **SHOULD** 注意 webhook 往往不保证顺序。同一聚合（`aggregateId`）的旧变更后到达时，先重新读取既有系统的当前状态再发出
   （CDC 按 commit 顺序，因此不需要）。

**conformance（b.4）**

- 原样使用 52 个项目。`BRIDGE_BASE_URL` 为外挂桥接。发布条件也相同。
- fixtures 在既有系统的 TEST 环境中触发业务，**等到导入完成之后**再返回（`produceEvents`、`emitNotifiableEvent`、`createPendingApproval`）。
  `newEmployee`、`deactivateEmployee`、`revokeSession` 在既有系统一侧执行。
- 52 个项目不检查导入的“不遗漏、不重复”。至少要在外挂桥接的测试中确认：同一变更发送 2 次，event 只有 1 个／在 commit 之前中止导入，
  重发后 event 为 1 个／2xx 在 commit 之后返回／通过轮询发出的类型中没有审批、期限、金额的 event。

**之后：逐个迁移业务**（Strangler Fig）

先以外挂方式让 AI 员工运行起来，再把业务逐个迁移到按 b.0 构建的新系统（server-kit 之上）。对已迁移的业务，把 hooks 的内部从既有系统的 API
换成新的表，event 回到 b.3 的同一事务。Bridge v1 是接缝，因此无论处于哪个阶段 DSH 一侧都不变，每次都可以重新跑通 52 个项目。

**试行期间的注意事项**

- server-kit 中还没有外挂专用的组件（既有系统 API 的客户端、导入组件、OIDC / SAML 的 `authenticate`）。如上例所示，
  目前可以用 `kit.tx`、`kit.emitEvent` 和 hooks 来编写。调用既有系统 API 时的防护（仅限允许的主机、超时、次数上限）按与 `createConnectorRunner`（b.9）
  相同的思路自行实现。是否做成组件，在 PoC 之后决定。
- 对外说明时可以说的只到“既有系统具备 SSO、API 和变更通知时，无需修改既有系统的代码即可接入”为止。不要说“任何系统
  都无需修改即可接入”（B 型和 C 型做不到）。

### 检查清单

- [ ] `bridge-validate manifest --strict` 返回 exit 0（无警告）
- [ ] 所有状态变化都使用 `kit.tx` + `emitEvent`（payload 只含允许列表）。若为外挂模式（试行），则使用 b.10 的来源与导入（变更 ID 与 event 在同一事务中，轮询只用于状态通知）
- [ ] 若为新系统：位置与依赖采用 b.0 中的某一种方式，且没有改写 framework 内部（packages、plugins、vendor、profile/template）
- [ ] manifest 中已按 b.1 的 payload 声明 `approval.requested` / `approval.decided` / `sns_identity.unlinked`
- [ ] conformance 52 / 52、`knownGaps` 为空、无 skip（报告、审批、个人机器人、2 种提案、fixtures 中角色的映射都已齐备；b.4）
- [ ] 注册表：`system.id` = 应用 id，工具为 `<namespace>_*`，列出全部机器人（`strict: true`），令牌只写环境变量名
- [ ] 文案：所有模板都有 `intent`，action / urgent 有 `action`
- [ ] DSH 侧的代码（toolModules、templateModules、自有插件）不接触业务 DB 和业务系统的密钥，只使用 `kit.requestJson` / `kit.proposeTool`（d.1）
- [ ] 业务 Web：SNS 绑定、通知设置、审批、提案的画面（提案使用 `GET /bridge/v1/proposals`、`…/{id}/accept`、`…/{id}/reject`；b.6）。BFF 只在自己的调用（票据、附件转换、createOnly 之后的个人机器人登记）上附加 `x-bff-secret`，不带密钥中继浏览器的请求（b.6）
- [ ] 自动任务：已确定委托类别与员工（或 `<class>=each`）（非默认应用手写在 `bridge-tools.applications.<id>` 中，check.mjs 使用 `--allow unattendedPolicy` 并附理由注释；b.7），已在 playbook 中写明禁止事项，已在产品 profile 中定义 playbook 的 `agent` 对应的预设
- [ ] 接收人：对所有需要通知的 event，由 `recipientsFor` 确定范围并在关口处检查。范围无法确定时不发送（d.8）
- [ ] 发送设置：保留了模板中关闭的值（d.8 的“产品的值”）（没有固定投递目标、邮件、由模型指定收件人、启动回复的抄写）。开放的设置均为显式 opt-in 并写明了理由
- [ ] payload 和模板参数中没有放入姓名、自由文本、健康信息、日语句子（d.2）
- [ ] 若使用个人机器人：本人用 RPC、`createOnly`、从管理员的列表中排除。查询的所有者规则在 server-kit 中（自行实现时为必须；d.9）
- [ ] 链接检查：所有应用都有 `linkGuard.webUrl`（默认应用）或 `linkGuard.webUrls.<id>`（check.mjs 的 `link_guard`）**以及** manifest 中的 `web.routes`（两者齐备才生效；b.5、b.8）
- [ ] 应用有 2 个以上时：每个非默认应用都有 `bridge-notify` / `bridge-approvals` 的 `applications.<id>.webUrl`（及 `bots`）、`bridge-assistant` 的 `agents[].application`、`linkGuard.webUrls.<id>`、自动任务的委托（b.5 的 10）
- [ ] 若在 SNS 中回答使用方法：操作手册的 CI（索引为最新、`check*` 为空），manifest 的 `help.tool` 与 `web.routes`，persona 中的 `helpRules` 文本（b.8）
- [ ] 长期记忆（bridge-memory，profile 模板中默认包含）：有 `POST /bridge/v1/pii-scan`（server-kit 默认具备）。持有姓名的系统已实现名册检查 `hooks.piiScan`。已确定组织记忆的分类和期限。AI 员工预设可以使用 `memory_*` 工具（d.10）
- [ ] AI 员工资料（bridge-persona，模板中默认包含）：具备 `GET /bridge/v1/ai-profile` 和管理路由（server-kit 默认具备；自行实现时用 `validateAiProfile` 做检查、版本和审计）。业务 Web 中已放置仅管理员可用的“AI 员工设置”（web-kit `AiProfilePage`，默认一个昵称）（d.11）
- [ ] 向 AI 助手添加文件附件（可选）：具备 `/bridge/v1/assistant/attachments/prepare`、`attachment-settings` 和管理路由（server-kit 默认具备；自行实现时用 `@dsh-bridge/server-kit/extract` 检查、转换），已确定扫描 PDF 的处理方式（`attachments.ocr`：OCR 引擎 / 以图像交给默认模型 / `false`），BFF 使用 `prepareAssistantAttachments`，面板中有 `AssistantAttachmentPicker` 和说明发送目标的一句话，回答使用 `AssistantMarkdown`，管理员使用 `AttachmentSettingsCard`（d.12）
- [ ] 外部连接（可选）：`connectors.secretKey` 来自环境变量，write 需要审批（`connector_write`、`onApprovalNeeded`），规则的 task（`kit.connectors.tick()`），管理员使用 `ExternalConnectorsPage`（b.9、d.13）

### 完成条件（用命令确认）

检查清单中可以用命令确认的项目。**每一项都是 framework 现有的命令，或业务系统自己编写的测试**。用真实 DSH 端到端确认 DSH 一侧的
framework e2e（`pnpm run e2e`，a.3）**目前专用于 equipment-inspection**（应用 id 固定在 `packages/testing/e2e/run.mjs` 中），因此
新系统和接入的系统是否完成，由 conformance（2）和业务系统自己的测试（3～6）来判定。

| # | 内容 | 命令 | 合格 |
|---|---|---|---|
| 1 | manifest | `node <framework>/packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict` | exit 0（`--strict` 下警告也为 exit 1。不加的话有警告也是 exit 0，因此不能作为合格判定） |
| 2 | conformance | 启动 TEST 环境，执行 `BRIDGE_BASE_URL=… BRIDGE_SERVICE_TOKEN=… BRIDGE_BFF_SECRET=… BRIDGE_FIXTURES=./test/fixtures.mjs BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml node --test <framework>/packages/protocol/conformance/http.test.mjs`（与 `bridge-validate conformance` 相同）。CI 中采用 equipment-inspection 的 `test/conformance.test.mjs` 的形式（启动、临时 DB、清理都在一个测试中） | 汇总为 `52 passed, 0 known gaps, 0 skipped` |
| 3 | 业务系统自己的测试 | `node --test test/*.test.mjs`（Windows 下加 `--test-isolation=none`） | 全部 pass。至少包括：状态变化与 event 在同一事务中（manifest 拒绝的 payload 时业务行也不会留下）、`recipientsFor` 的关口（范围外的员工不会进入，情况变化时为 `stale`）、Web 审批使用 `mayDecide` 且只决定一次、用委托令牌进行业务写入返回 403 `delegation_not_permitted`、BFF 不带密钥中继浏览器的 `POST /bridge/v1/me/personal-bots`、`hooks.piiScan` 对名册中的姓名返回类别 |
| 4 | 操作手册（若使用） | 在业务系统的测试中 `checkAnchors`、`checkSectionPaths`、`checkCoverage`、`checkRoleText`、`checkLinks` 为空；若采用提交索引的形式，`serializeIndex(buildHelpIndex(...))` 与已提交的索引相同（示例 `examples/equipment-inspection/test/help.test.mjs` 只检查 `check*`，是在启动时生成索引的简易形式；b.8） | 为空、相同 |
| 5 | 产品 profile | `node <framework>/profile/scripts/install.mjs --source <产品的 profile> --home <临时目录> --profile <名称> --skip-install`（个人的 `~/.dsh` 会被拒绝） | 不出现 `template placeholders left` 警告 |
| 6 | 发送设置是关闭的 | `node <framework>/profile/scripts/check.mjs <自己的 profile>/cordis.patch.yml`（关闭的值、开放的值、同捆的编码 preset 已禁用、残留的 `<placeholder>`；注册表中所有应用都有 linkGuard 的 URL〔规则 `link_guard`〕。只对有意的 opt-in 使用 `--allow <rule>`；手写的自动任务委托用 `--allow unattendedPolicy`，b.7）。链接检查的另一半（manifest 的 `web.routes`）在 1 的 manifest 一侧编写 | exit 0 |
| 7 | 拒绝固定的投递目标 | 在 5 的命令中加上 `--auto-task-target x` | exit 2 |
| 8 | 业务 Web（web-kit） | 业务 Web 的 `tsc --noEmit`（web-kit 以 `.ts` 形式分发） | 无错误 |
| 9 | framework 本身（仅在修改了 framework 时） | 在 framework 根目录执行 `pnpm validate`、`pnpm test` | ok、fail 0 |

在真实 IM 和模型上的确认为手动进行（e、g）。

---

## c. 扩展点

| 扩展点 | 位置 | 添加什么 |
|---|---|---|
| `toolModules` | `bridge-tools` 的设置（或 `ctx.bridgeTools.register(appId, factory)`） | 手写的工具。`export default (kit) => [kit.defineTool(...), kit.proposeTool(...)]`、`export const application = '<id>'` |
| `templateModules` | `bridge-notify` 的设置（或 `ctx.bridgeNotify.registerTemplates(appId, module)`） | 通知的文案：`types`（manifest 中没有的类型）、`templates[<template>]`（事实句、intent、ask、due、note）、`render(input)`（整条消息） |
| `aiReportPrompt` / `aiReportRoles` / `aiReportCommand` | `bridge-notify`（可按 `applications.<id>` 覆盖） | 定时报告给 AI 的指示、可使用的角色、关键词（默认「定時報告」（定时报告）） |
| `messages` / `unlinkedReply` | `bridge-identity` 的设置、注册表的 `applications[].messages`（优先） | 对未绑定者的引导、绑定完成等回复 |
| `linkKeywords` / `switchWords` / `switchMessages` | `bridge-identity` | 绑定的关键词（默认 `連携`）、共用机器人切换命令的词（`list` / `current` / `help`） |
| `replyWords` | `bridge-approvals` | 通过回复做决定的词（默认 `{ approve: [承認], reject: [差戻] }`）。按钮名称和引导也使用相同的词 |
| 卡片的 `wording` | 业务系统（`approvals.card` 的返回值，Bridge v1 的 `Card.wording`） | 每种审批的文句：问候之后的一句（`lead`）、请求（`ask`）、按钮说明、决定后的回复和正文（各最多 300 字。不写姓名、金额） |
| `groupChat` / `messages.groupChat` | `bridge-identity` / `bridge-tools`、注册表 `applications[].groupChat` | 群聊的方针（`deny` 默认 / `allow`）和引导文案（默认「業務の内容は個別チャットでお尋ねください。」（业务相关内容请在单聊中询问。）） |
| `audienceText` / `audienceLink` / `aiReportGuard` / `aiReportLink` | `bridge-notify`（`applications.<id>`） | 自动任务报告、定时报告的固定文案及其链接（d.8） |
| `contextIds` / `roleLabels` / `agents` | `bridge-assistant` | 助手画面的上下文 ID（追加到 manifest `entities` 的 `<entity>Id`）、角色的显示名、每个应用的 AI 员工 |
| `pathProfiles` / `compat` | `bridge-apps` | 不走 `/bridge/v1` 的系统的路径（`{ base?, identity, link, delegations, … }`）。`compat: [care-billing-paths]` 是 CareBilling 的旧路径 |
| `platformPriority` / `bots` / `webUrl` | `bridge-notify` / `bridge-approvals`（`applications.<id>`） | 投递平台的优先顺序、发送机器人、加在相对链接前的源（origin）、审批画面的 URL（`{id}`） |
| `digestTypes` / `digestWindows` / `digestMinutes` / `realtimeSettleSeconds` / `realtimeDigestSeconds` | `bridge-notify` | 汇总（digest）发送的设置 |
| `notifyTypes` / `manifestNotify` / `deployPlaybooks` | `bridge-events` / `bridge-notify` | manifest 以外的通知类型；使用 manifest 通知和 playbook 的应用范围（`all` / `others` / `none`） |
| `strings` / `platformLabels` / `notify.types` | web-kit 的 `WebKitProvider` / `SnsLinkPage` | 画面文字、平台的显示名、通知类型的说明和分组 |
| `toolKind` / `denyHints` / `unattendedTools` | `bridge-tools`（`applications.<id>`）、dsh-core 的 tools-sdk | 拒绝时的文案；自动任务可使用的提案工具的上限 |
| `connectorTools` / `connectorRefreshSeconds` | `bridge-tools` | 是否根据外部连接的操作生成 `<namespace>_ext_*`（默认 true）、重新获取列表的间隔（默认 60 秒。b.9） |
| `linkGuard.webUrl` / `webUrls` / `allowHosts` | `bridge-identity` | AI 回答中链接的检查：默认应用 / 各应用的业务 Web 的 URL、允许保留的其他主机（b.8、d.8） |
| `imageCleanup` / `imageCleanupMinutes` / `dshHome` | `bridge-assistant` | 清理从面板发送的图片（d.12） |
| `hooks.piiScan` / `connectors` / `attachments.ocr` | server-kit 的 `createBridgeApp` | 名册的个人信息检查（d.10）、外部连接（b.9）、扫描 PDF 的处理（d.12） |
| `stateDomain` / `actionPrefix` / `aiReportTargetPrefix` / `switchStatePath` / `rpcName` / `errorCodes` / `apiErrorPrefix` / `audienceSource` | `bridge-events` / `-notify` / `-approvals` / `-identity` / `-assistant` | 接管既有的部署（以自有插件运行的 DSH_HOME）：存储的 domain 名、已发送卡片的按钮 ID、dsh-im 的投递目标 ID、共用机器人的状态文件、管理 RPC 的名称和错误码、报告的 errorCode、自动任务报告接收人的确定方式。新部署保持默认值即可 |
| `messages` / `aiReportMessages` / `switchMessages.helpExample` / `agents[].sessionTitle` | `bridge-approvals` / `-notify` / `-identity` / `-assistant` | 错误和定时报告的回复、使用示例、DSH 会话的标题 |

工具模块的示例（业务数据只通过 `kit.requestJson` 读取，写入只通过 `kit.proposeTool` 的提案。不接触业务 DB 和秘密。d.1）：

```js
// my-app-tools.js
export const application = 'my-app'
export default (kit) => [
  kit.defineTool({ name: 'myapp_count_open', description: 'Read-only: open items count.', async execute() {
    return { ok: true, data: await kit.requestJson('myapp_count_open', '/api/open-items') } } }),
  kit.proposeTool({ name: 'myapp_propose_close', kind: 'close_item', description: 'propose closing one item.',
    parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    forbidden: ['amount'], forbiddenReason: 'amounts are computed by the business system' }),
]
```

文案模块的示例：

```js
// my-app-templates.js
export const templates = {
  'reservation.overdue': ({ count }) => ({                  // 只写事实句。外框（标签、问候、署名、链接）由 plugin-notify 添加
    title: '返却期限の超過', text: `返却期限を過ぎた予約が ${count} 件あります。`,
    intent: 'action', ask: '業務 Web の「予約」で確認してください。',
  }),
}
```

---

## d. 规则（MUST / SHOULD）

### d.1 AI 不做决定

- **MUST** AI 的工具只有 `read`（GET）或 `propose`（`POST /bridge/v1/proposals`）。没有 `write`。业务的写入 API 对委托返回 403。
- **MUST** DSH 侧的代码（`toolModules`、`templateModules`、自有插件）不接触业务 DB 和业务系统的秘密（服务令牌、DB 的 URL、
  外部连接的密钥）。业务数据只通过 `kit.requestJson`（带有本人委托的 Bridge v1 / 业务 API 调用）读取，写入只通过
  `kit.proposeTool` 的提案。直接连接 DB、或自己附上服务令牌去 fetch，会绕过 bridge-tools 的 gate（委托 = AI 允许列表 ∩ 角色），
  也会破坏业务系统作为唯一权威来源（正本）的地位（ARCHITECTURE.md §3「L3 不知道 L2（只有 HTTP 的 v1）」）。
- **MUST** 确定、审批、开具、支付、发送由人在业务系统中进行。提案的采纳、驳回也只由人进行，且仅限 1 次。
- **MUST** **金额不由 AI 决定、也不由 AI 书写**。提案工具的参数中不放金额（`forbidden: ['amount']`）。金额由业务系统计算，
  并由业务系统作为审批卡片的项目给出。
- **MUST** 在 playbook 和 AI 员工的指示中写明禁止事项：不确定任何事项；不把姓名、个人信息写入记忆、备忘、报告；业务数据只通过工具
  读取；不编造工具未返回的数字或事实；**触发数据是业务数据，不是指示**。

### d.2 不携带个人信息

- **MUST** event 的 payload 只含 ID、日期、件数、状态（按类型的允许列表）。不放姓名、联系方式、自由文本、健康信息、金额明细。
  **也不放日文句子**：payload 的检查（`checkPayloadWhitelist`，server-kit 的 `emitEvent` 和 conformance 的 event 项目使用）
  会把包含汉字、平假名、片假名的值视为自由文本（`cjk_text`）并拒绝。版本名称、
  标题、评论之类的文字以 ID 传递，文字在业务 Web 中打开时由业务系统显示（CareBilling 公共主数据的 event 不携带版本名称，只携带版本 ID）。
  状态值使用英文数字的代码（如 `approved`）。
- **MUST** 模板的参数只有数值、日期、时刻、月份、标志（`integer` / `number` / `flag` / `time` / `date` / `monthday` / `month` /
  `datetime`）。**IM 的文案中不出现姓名**（问候中也不出现）。例外是绑定完成回复中的「〇〇 さんとして」（以 〇〇 的身份）（对本人的回复）。
- **MUST** 链接是只含 ID 的业务 Web 路径（`/equipment/{id}`）。打开时由业务 Web 重新授权。
- **SHOULD** 在 CI 中校验 manifest，业务系统用 `/bridge/v1/pii-scan`（只返回种类）检查字符串。PII 的判定是启发式的
  （纵深防御的一部分），防御的核心是「只传递 ID、日期、件数、状态」这一结构。

### d.3 幂等与仅 1 次

- **MUST** 发送带有幂等键：通知 `notify:<eventId>:<userId>`、审批卡片 `approval:<id>:<userId>`、自动任务 `auto-tasks:<taskId>:k:<dedupeKey>…`、
  定时报告 `proactive:<alarmId>:<firedAt>:…`。重试、重启时使用相同的键（不重复发送）。
- **MUST** event 的处理是至少 1 次，因此接收方要能承受重复（`dedupeKey`、通知的 `<eventId>:<userId>`、`recipientsFor` 的 `dedupeKey`）。
- **MUST** 审批**由任意 1 人的决定即确定**，其他卡片全部失效。在 Web 上做出决定时也使卡片失效。
- **MUST** 绑定码、卡片的 token、回复码仅限使用 1 次。错误次数会被计数并锁定。

### d.4 免打扰时段与发送时刻

- **MUST** 遵守本人的免打扰时段（`quietHours`）。夜间可以送达的只有在 manifest 中设为 `notify.quiet: exempt` 的类型（如安否确认）。
  `honorQuietHours: false` 仅用于验证。
- **SHOULD** 频繁发生的类型使用汇总（digest）发送（`digestMinutes` / `digestTypes`），合成 1 条「N 件まとめてお知らせします。」（汇总通知 N 件。）。

### d.5 AI 秘书的文案

格式（在智能手机上 4〜6 行，不用表情符号。「▶」和署名的「—」是符号）：

```
【ラベル】件名                        ← 第 1 行：【标签】标题（卡片中为标题）
<あいさつ><事実の文>                  ← <问候><事实句>：只写件数、月份、日期。汇总发送时为「N 件まとめてお知らせします。」
▶ お願いしたいこと（目安）：…         ← 请求处理、紧急（做什么、在哪里）
ご対応は不要です。…                   ← 报告
こちらから開けます：<URL>             ← 有链接时（卡片中为按钮）
— <アプリ名> AI 秘書                  ← 署名：— <应用名> AI 秘书（没有应用名时为「— AI 秘書」）
```

| 标签 | intent | 使用场景 |
|---|---|---|
| 【ご報告】（报告） | `info` | 仅告知信息。结尾为「ご対応は不要です。…」（无需处理。…） |
| 【対応のお願い】（请求处理） | `action` | 需要某人的判断或操作。「▶ お願いしたいこと：何を・どこで（画面名）」（▶ 请您处理：做什么、在哪里（画面名）），目标日期只用 params 中有的日期 |
| 【至急】（紧急） | `urgent` | 安否、未开始、严重事故等 |
| 【承認のお願い】（请求审批） | （审批卡片）／`approval` | plugin-approvals 的审批卡片。只有存在 `expiresAt` 时才写期限。没有按钮的文字通知（例如能审批的人只有本人，因此转给其他人等，判断在业务 Web 中进行）使用 `approval` |
| 【ご相談】（商量） | `consult` | 希望一起考虑判断的事项（超过期限仍未解决的处理通知、判断材料的确认等）。结尾与 action 相同，为「▶ お願いしたいこと」 |
| 【定時のご報告】（定时报告） | （定时报告） | 分为「■ 対応が必要なこと」（■ 需要处理的事项）和「■ ご参考」（■ 供参考） |
| 【ご案内】（指引） | （AI 的回答）／`info` | 对系统使用方法提问的回答（画面位置、步骤）。依据只有业务系统的操作手册检索工具，链接只用工具返回的画面（bridge-identity 的链接检查会去掉 `web.routes` 以外的链接） |

- 问候按发送时刻（system 的 timezone）决定：5:00〜9:59「おはようございます。」（早上好。），10:00〜20:59「お疲れさまです。」（辛苦了。），21:00〜4:59「夜分に失礼します。」（深夜打扰了。）。
- **不编造日期**：目标日期、期限只用 params 中有的。没有日期但在业务上明确的处理，才写「本日中」（今天之内）。
- 在共用机器人（个人微信）中，前面会加上【アプリ名】（应用名）（`【設備点検】【対応のお願い】…`）。
- 外框使用 `@dsh-bridge/dsh-core` 的 `frameMessage` / `frameAiText` / `noticeCard`，不要自己拼装。

示例（info、汇总发送）：

```
【ご報告】点検の完了
お疲れさまです。3 件まとめてお知らせします。
本日の点検が 3 件完了しました。
ご対応は不要です。業務 Web の「点検記録」でご確認いただけます。
こちらから開けます：https://inspection.example.jp/inspections
— 設備点検 AI 秘書
```

示例（action。来自 manifest 的模板 `inspection.overdue`）：

```
【対応のお願い】点検期限の超過
おはようございます。点検期限を 3 日過ぎた設備があります（期限 2026-10-24）。あなたの確認対象の未点検は 2 件です。
▶ お願いしたいこと：担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。
こちらから開けます：https://inspection.example.jp/equipment/e1
— 設備点検 AI 秘書
```

示例（审批卡片在纯文字 IM 中的显示效果。项目由业务系统决定）：

```
【承認のお願い】修理依頼
依頼ID: 3f2a9c1d
設備コード: EXT-012
見積額: 18000円
期限: 2026-10-30
お疲れさまです。修理依頼の承認をお願いします。
▶ お願いしたいこと（期限 10/30 17:00）：内容を確認し、「承認」か「差戻」を選んでください。
文字で返信する場合：「承認 123456」／「差戻 123456 理由」
— 設備点検 AI 秘書
```

**链接的检查**：在 manifest 中写入 `web.routes`（业务 Web 画面路径的模式），并把 bridge-identity 的 `linkGuard.webUrl` 设为业务 Web 的 URL，则 AI 回答（IM 的回合）中的业务 Web 链接只会指向实际存在的画面（其他主机用 `linkGuard.allowHosts`）。AI 把 URL 写错哪怕 1 个字符，该链接也不会送达。

自动任务的报告（AI 写的 summary）以「【対応のお願い】」（needsDecision）或「【ご報告】」开头，【対応のお願い】的下一行为
「▶ お願いしたいこと：誰が（役割名）・どこで・何を」（▶ 请您处理：谁（角色名）、在哪里、做什么）。ID 只写前 8 个字符，只写件数和日期。

### d.6 各平台的注意事项

| 平台 | 注意 |
|---|---|
| 个人微信（iLink） | 1 个账号 1 个机器人（用 `multiApp` 共用，用 `#一覧` 切换）。主动发送使用最后一次从对方收到的会话上下文，iLink 只在对方最后一次发言后的一定时间内受理（一般认为是 **24 小时**，但**未验证**）。超过后会因 `weixin_context_missing` 立即变为 undeliverable。为了重要通知，请对方也绑定其他平台 |
| Microsoft Teams | 只有对方**先与 bot 进行过 1:1 对话**、存在会话引用时才能主动发送（没有则为 `invalid_target`）。绑定时请对方发送 1 条消息 |
| LINE | 有每月发送上限（HTTP 429 monthly limit → `line_quota`）。在换月或升级套餐之前不会恢复，因此稍后重试，并用汇总发送减少条数。`updateCard` 会变成新发送 |
| email | **仅用于通知**。无法验证发件人，因此不能用于绑定、审批和 AI 使用。不放入默认的投递优先顺序（如要使用，在 `platformPriority` 中明确写出） |
| Lark（飞书） | open_id **按应用（bot）各不相同**。即使是同一个人也要按应用分别绑定，通知从此人绑定的应用发送 |
| Slack | 既有的 App 为了 interactivity 和 `im:write` 需要更新 manifest 并重新安装。退回理由的输入模态框（`openReasonDialog`）仅限 Slack |
| WeCom（企业微信） | 用自建应用（`wecom-app`）按应用分开窗口。回调为 `/wecom-app-callback/<botId>/<secret>`（网关的 `publicPrefixes`） |

### d.7 秘密与环境

- **MUST** 不把令牌、秘密写入 yml、代码仓库、日志。注册表中只写环境变量的**名称**（`apiUrlEnv` / `serviceTokenEnv`）。
  例外只有开发用的默认值（不是真正秘密的固定值，在生产环境〔`NODE_ENV=production`〕中拒绝启动。equipment-inspection 的 `src/config.mjs`。b.0）。
- **MUST** DSH 在隔离的 home 中运行（不使用个人的 `~/.dsh`）。launch token 不暴露给浏览器。
- **MUST** 测试只使用虚构的数据和测试用的值，只用回环地址，不使用演示环境、生产环境的端口和 DB。

### d.8 接收人的保证与发送设置

原则：**每个角色、每个账号在 SNS 上只接收与自己相关的业务通知、联络和请求**。发给谁由业务系统决定，既不让 AI 决定，也不让
DSH 的设置决定（ARCHITECTURE.md §7）。

- **MUST** 接收人由业务系统决定（`recipientsFor` / for-event）。只有当该 event 确实涉及整个法人
  （请款结算、工资、定时报告等）时，才发给某角色的全体成员。其他情况收窄到对象（服务使用者、事业所、负责人）的范围，并在关口确认「此人能否在业务 Web 中看到
  同一对象」（b.2）。不清楚范围就不发送。
- **MUST** 不让 AI 选择收件目标。模型可调用的工具中，不保留能指定收件目标（机器人、会话、邮件地址）的工具
  （`modelTools: reclaim`、`mail: false`）。自动任务的报告只发给 event 的接收人，接收人无法确定就不发送（`audienceFallback: none`、
  `restrictDelivery: true`）。运维人员的固定投递目标（`--auto-task-session / --auto-task-bot / --auto-task-target`）会被 install.mjs 拒绝。
- **MUST** 群聊中不处理业务（`groupChat: deny`，默认）。即使以发言者本人的权限回答，回答也会被群里的其他人看到。
  只有在业务系统一方能够确认全员都可以看到相同范围时，才设为 `allow`。
- **MUST** 没有发起人的回合（自动任务）的委托，按工作种类选择权限窄的员工（`<class>`），或使用触发 event 的本人（`<class>=each`）。
  不要让管理员成为所有任务的委托对象（在 `unattendedWarnRoles` 中写入宽泛的角色来检测。模板中没有写，由部署方写入）。
- **MUST** 不把 AI 的自由文本发给本人以外的人。自动任务的报告使用固定的文案（`audienceText: template`）。定时报告只发到本人的 1:1
  （`deliveryGuard: required`），正文为 `aiReportGuard: screen`（命中则全文替换为固定文案）或 `template`。
- **SHOULD** 不要过度依赖 `screenOutboundText`。它基于词表和模式推测，只用平假名写的人名、特定的病名、换个说法都会漏过。防御的核心是
  「AI 读取的只有件数、发送的只有本人的 1:1」这一结构。如果业务用语被误判为健康信息用语，用 `healthWords` 替换词表
  （插件的设置中尚未提供。由直接调用 dsh-core 的一方传入）。

设置一览（插件和 fork 的「默认」中有些与上游行为相同。**framework 的 profile 模板会把可关闭的发送设置〔表中
从 `groupChat` 到 `forwardPluginSources`〕以「产品的值」写好后出厂**，因此由模板生成的 profile 在这一点上是关闭的。只有在产品的 patch 中
显式修改才能打开（b.5）。表下方的 4 行〔`unattendedPolicy` 及以后〕是每个部署各自的值，因此模板中没有写：`unattendedWarnRoles` 和
`linkGuard` 由部署方写入〔不写就没有检测和检查〕。`unlinkedPolicy` 保持默认即可）：

| 设置 | 位置 | 默认 | 产品的值 | 不关闭会怎样 |
|---|---|---|---|---|
| `groupChat` | bridge-identity、bridge-tools、注册表 `applications[].groupChat` | `deny` | `deny` | 在群聊中，以发言者权限给出的回答会被所有人看到 |
| `audienceFallback` | bridge-notify（所有应用。可按 `applications.<id>` 覆盖） | `channels` | `none` | 无法确定接收人的报告会转到 auto-tasks 的固定投递目标 |
| `audienceText` / `audienceLink` | bridge-notify（所有应用。可按 `applications.<id>` 覆盖） / `applications.<id>` | `summary` / `/` | `template` / 业务 Web 的画面 | 以被委托员工的权限写出的 AI 文本，会送达其他接收人 |
| `aiReportGuard` / `aiReportLink` | bridge-notify（可按 `applications.<id>` 覆盖） | `screen` / `/` | `screen` 或 `template` | 设为 `off` 时不检查定时报告的正文 |
| `proactiveDelivery` | bridge-notify | `allow` | `deny` | 定时报告以外的 business 闹钟会发送到 IM |
| `modelTools` | dsh-proactive（fork #13） | `all` | `reclaim` | 任何会话中的 AI 都能用 `deliver_to` 发到任意收件目标，并能修改他人会话的闹钟 |
| `deliveryGuard` | dsh-proactive（fork #14） | `optional` | `required` | 没有 bridge-notify 的发送防护时，business 触发的回答会被原样发送 |
| `restrictDelivery` | dsh-auto-tasks（fork #16） | `false` | `true` | 可以使用固定投递目标、测试发送和来自其他会话的 `auto_task_report` |
| `mail` | dsh-auto-tasks（fork #16） | `true` | `false` | 可以使用 `auto_task_mail`（向任意地址发送 SMTP）以及邮件的巡查和汇总 |
| `forwardPluginSources` | dsh-im（`xmanrui-dsh-im`） | `[]` | `[]` | 触发的回答不经检查就被复制到会话的 IM |
| `unattendedPolicy` / `unattendedDelegates` | bridge-tools、注册表 `applications[].delegation` | `deny` / 无 | 按类别指定权限窄的员工、`each`（默认应用由 `install.mjs --auto-task-delegate` 写入安装目标。在产品的 patch 中手写的 `unattendedPolicy: delegate` 属于 opt-in：check.mjs 需要 `--allow unattendedPolicy`，并在注释中写明理由。b.7） | 所有自动任务都以 1 个人（宽泛角色）的委托运行 |
| `unattendedWarnRoles` | bridge-tools | `[]` | `[admin]` 等 | 无法察觉对宽泛角色的委托 |
| `unlinkedPolicy` | bridge-tools | `deny` | `deny` | 设为 `ai-readonly` 时，未绑定的发起人也能以 AI 自身的权限读取 |
| `linkGuard.webUrl` / `webUrls.<id>` | bridge-identity | 无 | 所有应用的业务 Web 的 URL（默认应用用 `webUrl`，其他用 `webUrls.<id>`。check.mjs 的 `link_guard`）＋ manifest 的 `web.routes`（两者齐备才生效） | 没有 URL 或 `web.routes` 的应用不检查 AI 回答中的链接（AI 编造或写错的 URL 会原样送达。如有 `web.routes`，在第一次 AI 回答时警告 1 次） |

### d.9 个人机器人（本人的 SNS）

- **MUST** 每位员工只设置自己的连接。不制作查看、创建、解除他人连接的画面或 API（包括管理员）。管理员的「IM ボット接続」（IM 机器人连接）中
  不显示员工的个人机器人（`excludeBotIds`）。
- **MUST** 个人机器人的创建和变更经由业务 Web 的 BFF 中供本人使用的 RPC。按渠道的允许列表（不允许修改工作文件夹、模型、预设、上下文增强、
  访问方针的方法）；含有 `botId` 的请求只限本人的机器人（每次都向业务系统查询）；把响应中的 `bots[]` 收窄到本人的部分；
  创建使用 `createOnly: true`（若是已有的机器人，则为 `bot-exists`，不做任何修改）；用 `POST /bridge/v1/me/personal-bots` 把新增的 botId 登记给本人，
  失败时删除该机器人以回滚。web-kit 的本人模式只是隐藏部件，不能起到防护作用。
- **MUST** 只有在通过本人用 RPC 成功完成 `createOnly` 创建之后的 BFF，才能给 `POST /bridge/v1/me/personal-bots` 附上 `x-bff-secret`。不要把浏览器的请求
  附上秘密后转发（一旦转发，本人就能把组织机器人的 botId 登记为自己的个人机器人，并且由于查询的所有者规则，用该机器人对话的其他
  员工全都会变成「未绑定」。b.6）。
- **MUST** 业务系统的身份查询（`GET /bridge/v1/identity?…&botId=`）在 `botId` 是已登记的个人机器人时，只有绑定对象是其所有者才返回
  已绑定（同一工作区的其他员工向他人的个人机器人发消息也不放行）。已撤销的个人机器人对谁都不放行。
  server-kit 具备此规则（`identityOf`：在 `GET /identity`、`POST /delegations`、IM 审批的决定中都会检查 `botId`。`wechat` 与
  `weixin` 视为相同）。绑定码的所有者规则（`personal_bot_owner_mismatch`）和解除绑定时的撤销也在 server-kit 中。不使用 server-kit 的
  业务系统需自行实现相同的规则（CareBilling 是 care-api 的 `resolveIdentity`）。
- **SHOULD** server-kit 的 `personalBotPlatforms` 默认为 `PERSONAL_BOT_PLATFORMS`（slack、line、teams、telegram、discord、weixin、whatsapp、
  wecom、wecom-app、qq、dingtalk、feishu、matrix。不包括 email 和 iMessage。与 CareBilling 相同）。如有不允许个人机器人的渠道则收窄
  （opt-out）。LINE、Teams、WeCom 自建应用这类需要公开接收端的渠道，在没有接收端（`DSH_PUBLIC_HOOK_PATHS`）期间
  显示为「準備中」（准备中）。

### d.10 长期记忆（bridge-memory）

- MUST：记忆中只放「偏好、进行中的事项、备忘」（本人）和「步骤、判断理由、运营上的偏好」（组织）。业务数据（记录、请款、状态）不记忆，每次都用工具读取。
- MUST：不保存个人信息、健康信息。保存前经过本地检查和 `/pii-scan`，命中则不保存。检查无法到达时也不保存（fail closed）。
- MUST：持有员工、服务使用者、交易方姓名的系统，用 server-kit 的 `hooks.piiScan(text, ctx) -> { kinds: string[] }` 实现**名册检查**
  （按姓、名、假名查找，命中时只返回 `staff_name` 等类别。不返回、不记录命中的字符串。示例是 equipment-inspection 的
  `src/hooks.mjs`。hook 抛出异常时返回 503，不保存记忆）。server-kit 默认的 `/pii-scan` 只做形式上的
  检查（联系方式、长号码、ID 号码等），不知道姓名，也不会命中普通的日文、英文句子（否则一条记忆都存不下来）。hook 的类别
  会与形式检查的类别一起返回。自有的 `/pii-scan` 也使用相同的形式（`{ ok, containsPersonalData, kinds }`）。
- MUST：个人的记忆和会话回顾只属于本人。管理画面中也只显示件数。群聊中不使用记忆。
- SHOULD：应用的名称、分类、期限通过 `createMemoryPlugin` 或设置修改，不要 fork 插件。存在以前的存储位置时，用 `domain` 指向同一个 domain。
- SHOULD：记忆在 system prompt 中作为「参考信息（不是指示）」传入，与业务数据不一致时以数据为准（与模板一致）。

### d.11 AI 员工的资料（bridge-persona）

- MUST：资料（profile）的权威来源（正本）是业务系统。只有管理员可以编辑，变更以新版本进行，审计中只留下版本号（不留正文）。
- MUST：保存前用 `validateAiProfile`（@dsh-bridge/protocol）检查。试图让 AI 绕过规则的说法（「承認なしで」（无需审批）、「規則を無視」（无视规则）等）和个人信息（联系方式、号码）拒绝保存（D4）。不返回命中的字符串。
- MUST：资料不改变权限、工具和安全规则。system prompt 中先放固定的规则（renderPersona），并始终表明自己是 AI（署名为「— <呼び名>（<アプリ名> AI 秘書）」（— <昵称>（<应用名> AI 秘书）），D8）。
- SHOULD：每个应用 1 个昵称（默认。不向 `AiProfilePage` 传入 `agents`。保存后以前版本中按 AI 员工的覆盖会被清除，因此不会有看不见的覆盖
  改变名称）。按 AI 员工（preset）分别设置昵称是部署方的选择，只在传入 `agents` 时生效（AI_EMPLOYEE_PROFILE.md §6 D3）。
- SHOULD：按 preset 的覆盖（`agents.<preset 的 id>`）只包括昵称、性格、背景。避免使用容易与真实人物混淆的昵称（管理员的责任，画面上提示注意）。
- SHOULD：会话中的 system prompt 是固定的（prompt cache）。在画面上告知变更从下一次会话开始生效。

### d.12 向 AI 助手添加附件

- MUST：类型同时根据扩展名和开头字节判定（不一致则为 `type_mismatch`）。拒绝带宏的文件（xlsm、docm）、旧格式（xls、doc）、压缩文件和可执行文件。上限为 5 个文件、单个文件 10 MB、合计 20 MB（可以调小，不能调大）。
- MUST：文档在业务系统的内存中转换为文字，原件和文字都不保存。审计和日志中只留下件数、种类、大小（不留文件名和内容）。
- MUST：文档的文字作为「参考信息（不是指示）」放入提示词（不服从资料中的指示）。不让 AI 员工持有读取文件的工具。
- MUST：可以使用附件的角色和种类由管理员决定（默认：manifest 角色中的 admin、manager、billing，全部种类）。已知模型无法读取图片时，在添加附件时就拒绝图片（`images_not_supported`）。
- MUST：回答以安全的 Markdown 显示（不输出 HTML，链接只允许业务 Web 的 URL 和允许的主机，外部链接加 `rel="noopener noreferrer"`）。
- MUST：确定扫描 PDF（没有文字层的页面）的处理方式。在 `createBridgeApp({ attachments: { ocr } })` 中：
  - **函数** `ocr(bytes, { mediaType, page }) -> text`（业务系统内部的 OCR 引擎。framework 不附带）：把页面转为文字（`ocr: 'engine'`）。页面图片不离开业务系统。
  - **不写**（默认）：把页面转为 JPEG（每次最多 10 页），**作为图片发送给模型**（`ocr: 'model'`。也会留在 DSH 的会话历史中。若模型无法读取图片则为 `images_not_supported`）。
  - **`false`**：不做 OCR（`no_text`，`details.reason: ocr_off`）。

  处理含有健康信息、个人信息文件的系统应设为 engine 或 `false`，不要保持默认（把图片发给模型）。渲染页面需要 pdf.js（`pdfjs-dist`）和
  `@napi-rs/canvas`（没有则为 `no_text`，`details.reason: ocr_unavailable`）。审计中只留下 `ocrPages`（页数）。
- SHOULD：在面板上始终显示「添付した内容は AI のモデルに送られます」（附件内容会发送给 AI 模型）。在已发送的消息上显示附件名称的标签。
- SHOULD：bridge-assistant 的图片清理（`imageCleanup` 默认 `on`、`imageCleanupMinutes` 默认 60）直接使用即可：对于重新开始的会话、12 小时未使用的
  会话中的图片，若没有被其他会话引用，就从 DSH 的附件存储位置删除（无法完整读取日志的那一轮不删除任何内容）。`dshHome`（默认为环境变量 `DSH_HOME`，
  没有则为 `~/.dsh`）必须指向运行 DSH 的隔离的 home（d.7）。

#### 业务文档的导入（由 AI 读取扫描 PDF 和图片，docs/DOCUMENT_READS.md）

- 如果有导入图片或无文字层 PDF 的画面，实现 server-kit 的 `hooks.documentReads = { claim({ limit }, ctx), answer(readId, body, ctx) }`，启用 `GET /bridge/v1/document-reads` / `POST /bridge/v1/document-reads/{readId}/result`（可选功能，服务令牌），提供页面图片（JPEG / PNG，最多 10 页。PDF 用 `createPdfTextExtractor` 的 `ocrPages`）。DSH 的 bridge-reader 让能读取图片的模型每页转写 1 次并返回文字（不创建会话）。
- MUST：由返回的文字生成的项目，**全部设为需要人工确认**的状态（不自动确定 AI 读取的值）。业务判断（导入哪位服务使用者、哪些值）由业务系统和人进行。
- MUST：页面图片会发送给模型的提供方。要有停止该功能的设置，并在画面上说明。日志和审计只留下件数、ID 和错误码（不留图片和读取的文字）。
- `hint`（表单格式的名称）中不放人名。claim 可在 10 分钟后重新发放（对旧 claim 的回答返回 409 `read_not_claimed`）。

### d.13 外部连接（连接对象、操作、规则）

- MUST：秘密（API 密钥、密码、客户端密钥）只由业务系统持有。管理员从业务 Web 发送 1 次，由 server-kit 加封保存
  （画面上只显示末尾 4 个字符）。加封的密钥（`connectors.secretKey`）通过环境变量传入。不写入 DSH 的 profile、manifest、提示词、日志、代码仓库。
- MUST：AI 能执行的只有 read（被委托员工的角色 ∈ `operation.roles`）。write 走 `connector_write` 的提案 → 有权限的人审批 → 由业务系统执行。
  规则的 `auto` 只适用于 read 和管理员写明理由后允许的幂等 write。
- MUST：连接对象只限 https 和允许的主机（开发用的 localhost 通过 `allowLocalhost`，生产环境中不使用）。发送的项目只限操作输入的 JSON Schema 中的项目，返回给 AI 的只限
  `responseFields` 的允许列表。个人信息类别高的操作，只有在管理员用 `allowPii` 明确允许时才能在规则中使用。
- MUST：执行记录、审计和 IM 的通知只含 ID、件数、状态（不把输入和响应的正文输出到 IM 和日志）。
- SHOULD：先从 1〜2 个 read 开始。向运维人员告知紧急停止（`/admin/connector-settings`）以及按连接对象、按规则停止的位置。

## e. 测试方针

| 层 | 用什么 | 验证什么 |
|---|---|---|
| 单元 | 各包的 `node --test`（`pnpm test`） | 组件的契约。业务 API 用 `node:http` 模拟，数据为虚构 |
| 一致性（conformance） | `packages/protocol/conformance`（52 项） | 业务系统遵守协议的不变条件。还通过 mutation test（`test/conformance-mutants.test.mjs`）确认：破坏不变条件时相应检查项会失败 |
| manifest | `bridge-validate manifest` / `pnpm validate` | Schema、交叉引用、疑似 PII 的键 |
| e2e（mock） | `pnpm run e2e`（`packages/testing/e2e/run.mjs`） | 用 mock 的 LLM / LINE 端到端运行真实的 DSH + vendor fork + 插件 + gateway（a 绑定 → b 提问 → c 通知 → d 审批 → e 自动任务 → f 隔离。15 / 15 步，约 70 秒。a.3）。**目前仅限 equipment-inspection**（新系统请用 `@dsh-bridge/testing` 的组件编写自己的场景，或按完成条件的第 2、3 项判定） |
| 全流程（构想） | full-flow runner | 同时启动业务系统（TEST DB）、DSH 和 mock IM，用一个场景验证从业务 Web 的操作到送达 IM 的全过程。各业务的场景放在各业务系统的仓库中 |
| 实机 | 手动 | 在真实 IM 中确认（g 节、路线图） |

- e2e 的规则：只用测试值（每次生成），只用回环地址，使用隔离的 DSH home，演示环境和生产环境的端口由 `assertPortsUsable(ports, { forbidden })`
  拒绝。`sanitizedEnv` 会去掉真实的 API 密钥、令牌、DB URL 以及已有的 `DSH_*` `BRIDGE_*` `CARE_*`。
- **Windows 注意事项**
  - `node --test` 以 `--test-isolation=none` 运行（与各包的 script 一致）。
  - vendor/dsh-im 以 **LF** 检出（`core.autocrlf=true` 时字符串常量会混入 CR，导致构建结果和 i18n 测试发生变化）。
  - Windows 对被其他句柄打开的文件执行 `rename` 会返回 `EPERM`：fork 会短暂重试（`renameReplacing`）。
  - dsh-im 的部分上游测试因 Windows 特有原因被 skip / 失败（`FORK.md`）。在 `esbuild` 无法写入 `%TEMP%` 的环境中，请将 `TEMP` / `TMP`
    指向其他目录。
  - 子进程不要通过 shell 启动 `.cmd`（停止 shell 后本体仍会残留）。使用 `killTree`。
  - 负载较高时（同时运行多个测试），依赖时序的测试可能失败。请单独重新运行。

---

## f. 版本管理（protocol / manifest）

| 对象 | 版本的表示方式 | 规则 |
|---|---|---|
| 协议 | 路径 `/bridge/v1`、请求头 `bridge-protocol: 1`、manifest 的 `bridge: 1`、OpenAPI 的 `info.version`（1.0.0） | v1 内**只做增加**（可选字段、新的 operation、新的错误码）。改变含义、删除字段、增加必填项属于 v2（`/bridge/v2`）。修改协议时同时修改 conformance suite |
| 错误码 | `x-error-codes` 中的 lower snake case | 稳定的标识符。不要嵌入字段名（`required` + `details.field`）。面向人的 `message` 可以变化 |
| manifest | `version`（SemVer 或日期），etag 由内容生成 | 内容变化则 etag 变化，DSH 通过 `If-None-Match` 重新获取（`manifestRefreshSeconds`，默认 600 秒）。无效或无法获取的 manifest 不会替换最后一个有效的 manifest |
| event 类型 | `<aggregate>.<fact>` | 不再发出的类型不删除，而是标记 `deprecated: true`（使过去的 event 保持有效）。删除 payload 的键属于类型含义的变更 |
| playbook | 仅在 manifest 版本变化时重新部署 | 只覆盖模板所拥有的字段（name、instruction、trigger、approval、source、applicationId、audience、sessionPreset），保留运维字段（enabled、delivery、guard、执行状态）。从 manifest 中消失的 playbook 会被停用（不删除） |
| 包 | `@dsh-bridge/*` 0.1.0（private），fork 为 `<上游>-care.N` | 公开阶段采用 SemVer。许可证未定（`LICENSE`） |

dsh-core 也接受没有 `bridge-protocol` 请求头的响应（与旧系统兼容）。值不为 1 时抛出 `BridgeProtocolError`。

---

## g. FAQ 与故障排查

**通知一直处于「pending」，没有送达**
1. 处于汇总发送（短时 / 定期）的等待时间内（`realtimeSettleSeconds` 15 秒 / `realtimeDigestSeconds` 2 分钟 / `digestMinutes`）。使用 `ctx.bridgeNotify.flushNow()`，或在
   验证时设 `digestMinutes: 0`。
2. 接收人的免打扰时段（保留到结束为止）。只有 `notify.quiet: exempt` 的类别不保留。
3. 送达对象的优先级：发送到已绑定平台中优先级最高的一个。若该平台的机器人未连接（`bot_offline`），会持续重试。在 `status()` 的 reports 中查看原因
   （errorCode）。
4. 机器人：只从该应用的机器人发送。确认注册表的 `bots` 以及绑定时使用的机器人。

**收不到通知（也没有错误）**
- `recipientsFor` 返回了 `{ stale }`（情况已变化：已点检、已停用等）→ 不发送才是正确的。旧的 event 按设计会被丢弃。
- 本人的通知设置为关闭（manifest 中 `notify.default: off` 的类别默认关闭），或已经通知过（`sent` 是终态）。
- 通知的接收方（plugin-notify）刚启动、尚未注册期间，按失败处理并重试（`notifyGraceSeconds` 120 秒）。

**通知只送达部分人（应收到的人没收到）**
- 业务系统的关卡把人过滤掉了（此人在业务 Web 中看不到该对象，或不具备规则中的角色）。查看业务系统审计中留下的原因代码
  （CareBilling 中为 `notification.recipient_denied`）。正确做法是修正所属 / 负责范围，而不是去掉关卡。
- 自动任务的报告：未能确定接收人（cron 触发、不通知的类别）。`audienceFallback: none` 时不发送（`status().audienceSuppressed`）。

**AI 在群聊中不回答**
- 这是正确的行为（`groupChat: deny`）。只返回固定的提示。业务问题请在 1:1 会话中提出。

**定时报告变成了固定文案（「業務 Web のダッシュボードで確認」（请在业务 Web 的仪表板中确认））**
- 发送防护在正文中发现了金额、人名、联系方式、外部 URL、长文本或健康信息相关的词（`aiReportGuard: screen`）。原因代码会输出到 DSH 的日志。
  若业务用语命中了健康信息的词表，请重新审视该词表（d.8）。
- 被启动防护拦下：本人已停用、未绑定、处于其他会话、或角色不被允许。该会话的定时报告会停止，需要本人再次发送「定時報告 オン」（定时报告 开启）。

**AI 说「无法读取业务数据」**
- 未绑定（`linked: false`）。在业务 Web 中发放绑定码，并发送给**该应用的机器人**。
- 自动任务 / 定时报告：委托**默认拒绝**（`unattendedPolicy: deny`）。按 b.7 设置 delegate。定时报告仅在本人于该会话中设为「定時報告 オン」时运行。
- 会话的应用与工具的应用不一致（在共用机器人上选择了其他应用）。用 `#いま`（当前）确认，用 `#<アプリ名>`（`#<应用名>`）切换。
- 工具的 roles 中没有该员工的角色（委托 = AI 允许列表 ∩ 角色）。确认 manifest 的 `tools[].roles`。

**自动任务（playbook）不运行**
- 已部署的 playbook 保持停用状态：执行 `install.mjs --enable-auto-tasks pb_<application-id>_<playbook>` 并**显式指定 id**（不指定 id 不会启用）。
  需在 DSH 启动过一次、plugin-events 完成部署之后执行。
- playbook 的 `agent` 预设不在产品 profile 中 → 无法开启专用会话（任务的 `lastError` 为 `no_session`）。
- 没有 delegate（`unattendedPolicy: deny`），或 delegate 员工的角色无法使用该 playbook 的工具。
- playbook 为 `<class>=each`，但未通过 `--auto-task-delegate <class>=each` 同意（install.mjs 会警告），或业务系统不为该 event
  发出委托（404 / 422 / 409 / 403：event 不存在、不发委托的类别、已过时、本人不是对象）。不会用默认员工代替。
- 同一 event 只运行一次（dedupe）。要再试一次，请产生新的 event。

**`delegation_not_permitted` / `role_not_permitted`**
在委托下调用了写入 API（委托只允许读取和提案），或是该角色无法处理的提案类别。这是正确的行为。

**无法绑定**
404 / 410（无效、已过期）、409（已绑定）、429（尝试过多，等待 10 分钟）。群聊中不受理。不能通过 email 绑定。
个人机器人只能由注册该机器人的本人绑定（他人的绑定码会因 `personal_bot_owner_mismatch` 无效）。

**创建个人机器人时被 `bot-exists` 拒绝**
已存在相同认证信息（相同令牌、相同账号）的机器人（组织机器人或他人的个人机器人）。`createOnly` 不做任何更改直接拒绝。
请创建另一个机器人（另一个令牌）。

**DSH 启动慢 / 第一个请求失败**
首次运行时安装 profile 的 bundle（`dsh plugin --profile <name> install`）。manifest 在启动时从 `manifestUrl` 获取，获取不到时
使用 `manifestFile`。gateway 在收到 DSH 的 401（重启、过期）时重新获取 launch token，并只重发一次 GET / HEAD / upgrade。
e2e 中 `startDsh` 会等待 launch token 那一行。`dsh --version` 与 profile 的 `dshBridge.expectedDsh` 不一致时，`install.mjs` 会警告。

**同一通知 / 报告收到了两次**
幂等键是「成功后记录」，因此若 IM 侧刚受理后进程就崩溃，可能会重发恰好一条（dsh-im 的已知限制）。其他情况下出现时，
请确认幂等键的生成方式（重试时是否为同一个键）。

**在共用机器人上，回复跑到了别的应用**
引用后回复，或在通知后 10 分钟内回复，则会回到通知所属的应用。其他情况则发往「当前应用」。用 `#一覧`（列表）确认。

**昵称没有出现在签名 / 面板中，或修改了资料（profile）但说话方式没变**
- 业务系统没有 `GET /bridge/v1/ai-profile`（404），或注册表的 `paths.aiProfile` 为空：在没有资料（profile）的情况下运行（签名「— <アプリ名> AI 秘書」（— <应用名> AI 秘书））。
- DSH 仅在启动时和每隔 `aiProfileRefreshSeconds`（默认 60 秒）重新获取。获取失败或校验不通过的值保持原值（`app.aiProfileInfo().lastError`）。
- system prompt 的段落按会话固定：变更**从下一个会话起**生效（`/new`）。签名和面板标题从下一次成功获取时起生效。

**AI 不保存「记住这个」**
- 内容含有个人信息（带敬称的人名、联系方式、长号码、健康相关的词），业务系统的 `/pii-scan` 返回了分类（例如名册 hook `hooks.piiScan` 发现了姓名
  等），或无法访问 `/pii-scan`（fail closed）。群聊和未绑定的会话中也不使用（d.10）。如果连普通句子都无法保存，请确认业务系统的
  `/pii-scan` 是否把句子本身（`cjk_text` / `free_text`）判定为命中（server-kit 默认不判定）。

**AI 回答中的链接未被检查（DSH 日志中出现一次 link guard 警告）**
- 缺少该应用的业务 Web URL：默认应用为 `linkGuard.webUrl`，其他应用为 `linkGuard.webUrls.<application-id>`（b.8）。

**日志与机密**
launch token 在日志中会被遮盖（`redactToken`）。不要把令牌、密码贴到 issue 或日志中。

---

## h. 参考实现：CareBilling

CareBilling（care-billing，仓库 `care-ai-native`）是 framework 的首个引入案例，在 framework 出现之前就自行拥有同样的组件。
[examples/care-billing](../examples/care-billing/README.md) 中放有以下内容（不含业务代码）：

- [manifest](../examples/care-billing/manifest/README.md)：system id `care-billing`、命名空间 `care`、角色 5 个（admin、manager、billing、staff、care_manager）、
  event 71 个（其中弃用 1 个、发送通知的 65 个）、模板 92 个、接收人规则 46 条、工具 27 个（含操作手册检索 `care_help_search`）、playbook 5 个、
  报告 `daily_status`、`help`、`web.routes` 131 个（version 2026-10-29。数量于 2026-10-30 根据 manifest 重新统计）。
- care-api 的 route ↔ v1 对应表（`care-api-v1-aliases.md` / `.json`）：care-api 以**别名**方式在既有的 `/api/ai/*` 等路由上提供 v1（b.2'）。
- [registry/bridge-apps.yaml](../examples/care-billing/registry/bridge-apps.yaml)：注册表条目（Slack、LINE、WeCom、共用的个人 WeChat）和扩展模块。
- [extensions/README.md](../examples/care-billing/extensions/README.md)：模板意图表（92）、`care_*` 工具（29 = manifest 27 + 插件专用 2）、playbook 与委托类别、预设。
- 「framework 组件 → CareBilling 中的实现位置」对应表（server-kit 的各 hook、DSH 的各插件、web-kit 的各画面分别位于 CareBilling 的哪个文件）。

拿不准时，可以对比 equipment-inspection（基于 server-kit 的最小实现）和 CareBilling（在大型系统的既有 API 上以别名方式提供的实现）
两者。CareBilling 也是以下内容的示例：接收人的确定方式（`services/care-api/src/repo/notifications.mjs` 的 `decideRecipients`，关卡在
`repo/notify-scope.mjs`）、本人用 RPC（`apps/care-web/me-im-rpc.mjs`）、按事件的委托（`repo/identity.mjs`）、发送设置（`dsh/runtime-profile/cordis.patch.yml`）。
设计理由见 care-ai-native 的 `docs/design/NOTIFY_RECIPIENTS.md`、`IM_PERSONAL_BOTS.md`、`ROLE_MODEL.md`（U10）。

2026-10-29 新增的内容（CareBilling 中的位置）：

- 操作手册与通过 SNS 提出的使用方法的提问：`docs/manual`（164 节），索引与 CI `tools/manual-index.mjs`、`services/care-api/test/help-manual.test.mjs`，
  检索 `GET /api/help/search`（v1 别名），工具 `care_help_search`（`plugins/care-tools/src/help.js`），帮助画面 `apps/care-web/src/pages/Help.tsx`。
  设计见 `docs/design/SNS_HELP_QA.md`。
- 长期记忆：`plugins/care-memory`（只是 `createMemoryPlugin` 的设置：沿用以前的工具名 `care_memory_*`、存储位置 `care_memory`、省略 scope 时
  为事业所的记忆），检查 `POST /api/ai/pii-scan`。
- AI 员工的资料（profile）：`services/care-api/sql/096_ai_profile.sql`（`ai_profile_version`）、`src/routes/ai-profile.mjs`
  （`GET /api/ai/ai-profile` 及管理用 `/api/ai-profile`，v1 别名），画面「管理 › AI 社員の設定」（管理 › AI 员工设置）`/settings/ai-profile`
  （`apps/care-web/src/pages/settings/AiProfile.tsx`，web-kit `AiProfilePage`），签名「— さくら（ケアビリング AI 秘書）」（— 樱（CareBilling AI 秘书））（care-notify）。
  设计见 `docs/design/AI_PROFILE_CARE.md`。
