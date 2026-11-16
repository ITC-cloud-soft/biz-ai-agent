# 在现有系统之外追加「Bizアシスタント」业务层：可行性评估

> 2026-10-30。内部讨论用。
> 问题：不改（或尽量少改）现有业务系统，在它外面追加一层「Bizアシスタント」业务层，由这一层调用现有系统的 endpoint，
> 来实现框架的目标（AI 员工在 IM 里看、提醒、追、起草，人来决定）。这样做可行吗？
> 写法：每个判断都标出依据——框架的代码、协议、规则（本仓库的文件），或业界公开的模式与标准（文末）。
> 没有依据的地方写明「需要验证」。

---

## 0. 结论

**有条件地可行。** 它不是“永远可行”，也不是“不可行”。

1. **框架的代码本身允许这样部署。** server-kit 的业务知识全部通过 hooks 注入，hooks 是普通的 async 函数，
   可以在里面调用现有系统的 HTTP API；`bridge_*` 表可以放在外置层自己的 PostgreSQL 里；`createBridgeApp` 返回的是独立的
   `node:http` handler。也就是说，从 DSH 看，外置层就是“业务系统”，Bridge v1、DSH 的 9 个插件、IM 渠道**一行都不用改**（§2）。
2. **但框架现行的几条 MUST 规则，是以“桥接层就在业务系统里面”为前提写的**，外置后必须换一种方式满足：
   - 事件要和业务行在**同一个事务**里写入（GUIDELINE 表第 5 项）→ 外置层做不到，要换成“提交后捕获”（webhook 或数据库日志 CDC）；
   - AI 必须以**员工本人的权限**读取（第 6 项）→ 外置层要能“以本人身份”调用现有系统，否则只能自己复制一套权限规则；
   - SNS 绑定必须用**系统自己的登录**、不另建身份（第 3 项）→ 外置层要能验证现有系统的登录（SSO 或会话验证接口）；
   - 承认的规则要**只有一处**、Web 和聊天共用（第 7 项）→ 只要外置层通过现有系统的承认 API 以本人身份去承认，规则仍在现有系统里，可以满足。
3. **能不能做成，取决于现有系统有没有下面 4 种能力**（§4 给出判定表）：
   ① 外部可验证的登录（OIDC / SAML / 会话验证接口）；② 以员工本人身份调用 API（用户级 OAuth 令牌、令牌交换、受信任的代理身份头）；
   ③ 变化的通知（webhook，或允许读数据库的事务日志）；④ 承认、写入用的 API。
   - 四项都有（多数现代 SaaS、近年的 Web 系统）：**几乎全部功能可以外置，现有系统的代码不改**，只改配置（SSO、API 用户、webhook）。
   - 只有服务账号的 API、没有变化通知：**通知、定时报告、只读问答可以做**；承认与写入要么受限，要么在外置层复制权限规则（有风险）。
   - 没有 API、只有画面（桌面客户端、主机终端）：**不建议**。只能读数据库副本做只读通知；写入靠 RPA 操作画面，脆弱且难以审计。
4. **它和“用 AI 重构现有系统”不矛盾，反而是最稳的第一步。** 外置层对 DSH 暴露的是稳定的 Bridge v1；之后可以用 AI 开发工具
   把现有系统的功能一块块搬到外置层后面的新系统里（server-kit 上新建，GUIDELINE b.0），DSH 侧完全不受影响。
   这就是业界成熟的 Strangler Fig（绞杀者无花果）与 Anti-corruption Layer（防腐层）模式（§6）。

---

## 1. 设想的结构

在现有的全体像（業務面 ↔ L1 Bridge v1 ↔ AI 面）里，把「业务系统里的 L2 server-kit + L5 hooks」**搬到现有系统外面**，成为一个独立的服务：

```
                     ┌──────────────── Bizアシスタント 业务层（新，外置） ────────────────┐
现有业务系统（SoR）     │  L2 server-kit  /bridge/v1                                       │      AI 面（DSH，不变）
 ・业务 API /api/*  ◀──┤  L5 hooks：把每个 hook 实现成“调用现有系统的 API”                  ├──▶  L1 Bridge v1 ──▶ L3 dsh-core / 插件 ×9 ──▶ IM
 ・登录（SSO/会话） ◀──┤  身份桥：OIDC/SAML 的依赖方，或调用会话验证接口                      │
 ・webhook / DB 日志 ──▶  变化捕获：webhook 接收 / CDC 消费 → kit.emitEvent（去重）          │
 ・现有的画面          │  自己的 PostgreSQL：bridge_* 表 + 对照表（不存业务数据的副本）       │
                     │  L4 web-kit 的门户：SNS 绑定・通知设置・AI 员工的人设・外部连携         │
                     └───────────────────────────────────────────────────────────────┘
```

- 现有系统仍是唯一的正本。外置层只保存桥接自己的状态（绑定码、委托、事件游标、承认卡片、提案），以及“现有系统的变化 ID ↔ Bridge 事件”的对照。
- 现有系统需要做的，理想情况下只有**配置**：给外置层发 SSO 客户端、API 的客户端或用户、开 webhook（或数据库日志的只读权限）。

---

## 2. 依据一：框架的代码允许外置

| 事实 | 依据（本仓库） | 对外置的意义 |
|---|---|---|
| 业务知识全部经 hooks 注入：`employees.get/list`、`authenticate(req)`、`isSessionLive`、`recipientsFor`、`approvals.{get,approvers,card,mayDecide,decide}`、`proposalKinds[kind].{validate,apply}`、`reports.compute` 等 | `packages/server-kit/README.md`「Hooks」 | hooks 是 async 函数，可以在里面调用现有系统的 HTTP API |
| `bridge_*` 表由 `createPostgresStore({ pool })` 建在传入的连接池里 | 同 README「Parts」`store/postgres` | 可以放在外置层**自己的数据库**里，不碰现有系统的数据库 |
| `createBridgeApp` 返回 `node:http` 的 handler（或 express 中间件） | 同 README「Parts」`app` | 外置层可以作为独立服务运行 |
| 已有“调用外部 API”的部件：`createConnectorRunner`（只允许 https 的许可主机、拒绝重定向、超时 ≤ 10 秒、每分钟次数、响应大小上限、幂等调用重试一次）、秘密的 AES-256-GCM 封存 | 同 README `routes/connectors`；`src/connectors/runner.mjs` | 调用现有系统 API 的安全措施可以直接复用 |
| 已有“把 v1 挂在现有 API 上”的别名机制 `registerAliasRoutes`（ケアビリング 的做法） | GUIDELINE b.2' | 说明框架本来就不要求从零实现 v1 |
| 一致性测试 52 项通过 HTTP 对“业务系统”测试，有通用的 HTTP adapter | GUIDELINE b.4；`conformance/adapters/` | 外置层 + 现有系统的组合可以**用同样的 52 项验收**，完成标准不变 |
| DSH 只认 Bridge v1（manifest、identity、delegations、events、notifications、approvals、proposals、reports 等） | `packages/protocol/openapi/bridge-v1.yaml` | 外置后，AI 面（DSH、插件、IM）不需要任何改动 |

**结论**：从代码结构看，外置是可以做的。难点不在框架代码，而在“外置层能不能从现有系统拿到 hooks 需要的东西”。

---

## 3. 依据二：逐项对照框架的接入清单

对象是 GUIDELINE「既存の業務システムをつなぐ：チェックリスト」的 13 项（MUST 规则在其中）。
「外置的做法」一栏写外置层用什么满足；「现有系统需要的能力」一栏写前提。

| # | 清单项（区分） | 外置的做法 | 现有系统需要的能力 | 判断 |
|---|---|---|---|---|
| 1 | 读取 API 与接收提案的口（必须） | 外置层提供 `/bridge/v1` 和读取工具；读取工具内部调用现有系统的读取 API；提案存外置层，人采纳时 `apply` 调用现有系统的写入 API | 读取 API；写入 API（用于 `apply`） | 有 API 就可行 |
| 2 | manifest（必须） | 外置层持有。描述的是现有系统的角色、事件、工具 | 无（只需了解业务） | 可行 |
| 3 | SNS 绑定页用**系统自己的登录**（必须，禁止另建身份） | 外置层的门户作为现有系统 IdP 的 OIDC / SAML 依赖方登录；或把现有系统的会话 cookie 转给其“我是谁”接口验证。`authenticate(req)` 返回同一个员工 ID | SSO（OIDC / SAML）**或**会话验证接口，且门户能和现有系统共用登录 | **有 SSO 或会话验证接口才可行**。都没有就要另建登录，这违反第 3 项（GUIDELINE 明说会造成双重管理和冒充漏洞），不应这样做 |
| 4 | 收件人由业务系统决定（必须） | `recipientsFor` 从现有系统的 API 取负责人、承认人、所属等字段来决定 | API 能返回“谁负责 / 谁能批”的数据 | 数据可取就可行；取不到就意味着外置层要自己维护一套分配规则（与现有系统不一致的风险） |
| 5 | 事件与业务行在**同一事务**写入（必须，transactional outbox） | **字面上做不到**（外置层不在现有系统的事务里）。替代：现有系统的 webhook（带变化 ID、可重送），或数据库事务日志的 CDC。外置层在**自己的事务**里写“已处理的变化 ID + Bridge 事件”（幂等接收，见 §5） | webhook **或**数据库日志的只读权限；最差是带 `updated_at` 的 API 轮询 | webhook / CDC：可行（需改写这条规则）；仅轮询：只适合“状态”类通知，会漏掉中间状态和删除，不适合承认等需要准确的事件 |
| 6 | 员工与角色可经 API 获取（必须）；AI 权限 = 许可清单 ∩ 本人角色 | `employees.get/list` 调用现有系统的员工 API（或 SCIM、或定时同步）。角色层面的检查在外置层做 | 员工 API / SCIM | 可行。**但记录级的权限**（“只能看自己负责的利用者”）在现有系统里——见下行 |
| 6' | （同上的延伸）AI 以本人的权限读取 | 外置层**以本人身份**调用现有系统：用户级 OAuth 令牌（员工首次绑定时授权一次）、OAuth 令牌交换（RFC 8693）、或现有系统信任的代理身份头。这样记录级权限仍由现有系统判断 | 用户级令牌、令牌交换或代理身份三者之一 | **有就完全可行**。只有服务账号时，外置层只能自己按负责范围过滤——等于复制权限规则，规则变了就会不一致，敏感行业不建议 |
| 7 | 承认的规则只有一处，Web 与聊天共用（必须） | `approvals.decide` 以**决定者本人的身份**调用现有系统的承认 API，规则由现有系统判断；`mayDecide` 只做预判，最终以现有系统的结果（例如 403）为准；成功后外置层发 `approval.decided` 并作废其他卡片 | 承认 API + 以本人身份调用（6'） | 可行；只有服务账号时，“谁能批”的规则会被复制到外置层，违背这一项的本意 |
| 8 | 按用户确认 Web 会话是否有效（必须） | SSO 时用外置层门户自己的会话；会话验证接口时转问现有系统 | 同第 3 项 | 与第 3 项同条件 |
| 9 | 手册与问答（任意） | 外置层持有手册与索引，链接指向现有系统的画面 URL | 画面的 URL 规律、各画面可用的角色 | 可行（画面角色若无法从代码读取，需要人整理） |
| 10 | 个人信息检查（任意） | `piiScan` 调用现有系统的名册 API 做姓名匹配 | 名册 API | 可行 |
| 11 | AI 员工的人设（任意） | 外置层自己存（server-kit 默认就有） | 无 | 可行 |
| 12 | 定时报告（必须） | `reports.compute` 调用现有系统的 API 统计件数 | 能按条件计数的 API（或可分页的列表） | 可行（量大时注意 API 的调用次数限制） |
| 13 | 外部连携（任意） | server-kit 现有的 connectors 原样使用 | 无 | 可行 |

**Web 画面怎么办**（L4 web-kit、AI 助手面板）：现有系统的画面不改，就无法把 SNS 绑定页、助手面板嵌进去。可行的做法是
**外置层自己的门户**（同一个 SSO，从现有系统的菜单放一个链接即可）。助手面板若要出现在现有画面里，至少需要在现有页面加一个
脚本标签，或者用浏览器扩展——这属于“小改动”，需要和客户确认。

---

## 4. 判定：先看现有系统具备哪几种能力

| 现有系统的能力 | A 型（多数现代 SaaS、近年的 Web 系统） | B 型（有 API，但只有服务账号、无变化通知） | C 型（无 API：桌面客户端、主机、只有画面） |
|---|---|---|---|
| ① 外部可验证的登录 | OIDC / SAML | 有时有 | 通常没有 |
| ② 以本人身份调用 API | 用户级 OAuth / 令牌交换 | 没有 | 没有 |
| ③ 变化通知 | webhook | 没有（只能轮询或读数据库） | 只能读数据库（若允许） |
| ④ 承认、写入 API | 有 | 部分有 | 没有 |
| **可外置的范围** | 清单 13 项基本都能满足；**现有系统的代码不改**，只改配置 | 通知、定时报告、只读问答、提案（人到现有画面去执行）可以做；承认与写入需复制权限规则，或补 ②③ | 只读通知（从数据库副本）；**写入不建议**（RPA 操作画面，脆弱、难审计） |
| **一致性 52 项** | 可以 52 / 52（需验证） | 承认（A1〜A4）、委托相关项目要看能否以本人身份调用 | 不现实 |
| **建议** | 采用外置 | 外置 + 请现有系统补 ②③（通常比在内部改造小得多） | 走“新建 + 逐步迁移”（§6），不要硬做外置 |

> A/B/C 只是判断用的分类。实际系统要在最初的诊断里逐项确认这 4 种能力（各自的 API 文档、认证方式、webhook 的可靠性、调用次数限制）。

---

## 5. 外置必须改写的规则：事件怎么保证准确

GUIDELINE 第 5 项的原文意思是：事后用差分或触发器去捕获，会“通知了没有提交的变化、漏掉已经提交的变化”，所以要在同一事务里写事件。
这条规则对**轮询差分**完全成立。但业界还有两种做法，在“只捕获已提交的变化、不漏”这一点上，与同一事务写入等效：

| 方式 | 准确性 | 前提 | 依据 |
|---|---|---|---|
| 同一事务写 outbox（现行规则） | 最准确 | 能改现有系统的代码 | microservices.io「Transactional outbox」 |
| **读数据库事务日志（CDC）** | 只读到**已提交**的变化，按提交顺序，不漏 | 数据库允许逻辑复制 / binlog 的只读权限；要把“表的变化”翻译成“业务事件” | microservices.io「Transaction log tailing」；Debezium 文档 |
| **现有系统的 webhook** | 取决于现有系统：要求“提交后发送、带唯一 ID、失败重送” | 现有系统有可靠的 webhook | 各 SaaS 的 webhook 规格（需逐个确认） |
| API 轮询（`updated_at`） | 漏中间状态、漏删除、有延迟 | 只要有列表 API | 同上（microservices.io 的 Polling publisher 依赖 outbox 表，不等于轮询业务表） |

外置层的写法（幂等接收）：收到变化 → 在**外置层自己的事务**里，同时写“已处理的变化 ID”和 `kit.emitEvent(...)`；
同一个变化 ID 再来就忽略。这样“现有系统已提交的变化”到“Bridge 事件”之间是不重复、不遗漏的。

**因此建议框架增加一个“外置模式”的规则变体**：事件来源允许“同一事务 outbox”、“CDC”、“满足条件的 webhook”三种；
轮询只允许用于不要求准确的状态类通知，不能用于承认。

> 2026-10-30 更新：已作为**试行**规则写进 GUIDELINE b.10「外付けモード：既存システムの外にブリッジを置く（試行）」
> （日文里「外置」写作「外付け」）。试行的意思是：还没有用真实系统验证，PoC 之后按结果修改；发布条件（52 / 52）不变。

---

## 6. 与“用 AI 重构现有系统”的关系：先外置，再逐步替换

外置层不是重构本身，但它是让重构变得安全的前提：

1. **先外置**：外置层对 DSH 暴露 Bridge v1，内部调用现有系统。AI 员工先上线，业务价值先出来。
2. **再逐块替换**：用 AI 开发工具（Claude Code / Codex 按 GUIDELINE）在 server-kit 上新建功能（b.0），一个业务一个业务地从现有系统
   迁到新系统；外置层的 hooks 从“调用现有系统”改成“查新系统的表”，最终事件可以回到同一事务的 outbox。
3. **DSH 侧从头到尾不变**：Bridge v1 是稳定的接缝；manifest 只在业务变化时更新；一致性 52 项在每个阶段都能重跑验收。

这就是 Martin Fowler 提出、Microsoft 架构中心也收录的 **Strangler Fig 模式**（在旧系统外围建新层，逐步替换，最后退役旧系统），
外置层同时承担 **Anti-corruption Layer**（把旧系统的模型翻译成新模型，避免旧模型污染新系统）的角色。
相反，“一次性用 AI 重写整个现有系统”风险最高，也正是 Gartner 所说 Agent 项目失败的常见原因之一（与遗留系统集成复杂、需要高成本改造）。

---

## 7. 外置的代价与风险（不要只看好处）

| 项目 | 内容 | 对策 |
|---|---|---|
| 外置层成为高价值目标 | 它持有现有系统的 API 凭据、SSO 客户端秘密、（可能的）用户级令牌 | 秘密用 server-kit 的封存（AES-256-GCM）；最小权限的 API 用户；用户级令牌加密保存、解除绑定时吊销 |
| 权限规则被复制（B 型） | 只有服务账号时，外置层自己判断“能看哪些记录、谁能批” | 优先请现有系统补“以本人身份调用”；做不到时把复制的规则限定在只读、低敏感的业务 |
| 性能与调用次数 | AI 的每次读取、每次报告都变成对现有系统的 API 调用 | 只缓存短时间（不长期保存业务数据）；报告用计数 API；遵守限流 |
| 现有系统的 API 变更 | 供应商升级 API 会让外置层失效 | 外置层的“现有系统客户端”单独封装并有契约测试；一致性 52 项定期跑 |
| 事件的准确性 | 只有轮询时会漏 | 见 §5，承认类事件必须用 CDC 或可靠 webhook |
| 画面体验 | SNS 绑定、助手面板在另一个门户 | 同一 SSO + 现有菜单里的链接；面板嵌入需要小改动 |
| 合同与条款 | SaaS 的 API 使用条款、调用量的计费 | 诊断阶段确认 |

---

## 8. 建议的下一步（用事实验证，而不是凭推测）

1. **选一个 A 型的现有系统做 PoC**（例如带 OIDC、用户级 OAuth、webhook 的 SaaS，或客户的现代 Web 系统），只做一个业务
   （例如承认待办的提醒 + 聊天承认）。完成标准：外置层 + 该系统通过一致性 52 项（或明确列出不能通过的项目及原因）。
2. **把 4 种能力做成诊断表**，放进“AI 员工化诊断”（营销策略里的入口产品）：每个客户系统先判定 A / B / C。
3. **框架侧要做的事**（PoC 证明可行后）：
   - GUIDELINE 增加“外置模式”的章节，以及 §5 的事件来源规则变体（**已先以试行写入 GUIDELINE b.10**，PoC 后转正或修改）；
   - server-kit 增加外置用的部件：现有系统 API 的客户端模板（以本人身份调用、限流、契约测试）、幂等接收的事件写入
     （变化 ID 去重）、OIDC / SAML 依赖方的 `authenticate` 实现；
   - 一致性测试增加“外置模式”的说明（哪些项目以现有系统的结果为准）。
4. **营销上的说法**：可以说“现有系统具备 SSO、API、变化通知时，**不改现有系统的代码**就能接入”；
   不能说“任何系统都不用改”（B、C 型做不到）。

---

## 参考资料

本仓库：

- `docs/GUIDELINE.md`「既存の業務システムをつなぐ：チェックリスト」（13 项与 MUST 规则）、b.0（新建系统）、b.2'（别名）、b.4（一致性 52 项）
- `packages/server-kit/README.md`（Parts、Hooks、Bridge v1 endpoints）、`packages/server-kit/src/connectors/runner.mjs`
- `packages/protocol/openapi/bridge-v1.yaml`（Bridge v1 的全部操作，必须 / 任意）
- `docs/ARCHITECTURE.md`（业务面是唯一正本、收件人的保证）

外部（公开的模式与标准）：

- Martin Fowler, "StranglerFigApplication"：https://martinfowler.com/bliki/StranglerFigApplication.html
- Microsoft Azure Architecture Center, "Strangler Fig pattern"：https://learn.microsoft.com/azure/architecture/patterns/strangler-fig
- Microsoft Azure Architecture Center, "Anti-corruption Layer pattern"：https://learn.microsoft.com/azure/architecture/patterns/anti-corruption-layer
- microservices.io, "Transactional outbox"：https://microservices.io/patterns/data/transactional-outbox.html
- microservices.io, "Transaction log tailing"：https://microservices.io/patterns/data/transaction-log-tailing.html
- Debezium documentation（基于事务日志的 CDC）：https://debezium.io/documentation/
- RFC 8693, "OAuth 2.0 Token Exchange"：https://www.rfc-editor.org/rfc/rfc8693
- Gartner, "Gartner Predicts Over 40% of Agentic AI Projects Will Be Canceled by End of 2027"（2025-06-25，提到与遗留系统集成的复杂性）
