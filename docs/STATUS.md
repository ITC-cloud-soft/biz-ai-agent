# 状态（2026-11-14）

计划见 [`GENERAL_AGENT_FRAMEWORK.md`](GENERAL_AGENT_FRAMEWORK.md)：§5 设计，§7 按周的路线图。接口见 [`KNOWLEDGE_API.md`](KNOWLEDGE_API.md)。

## 已完成：第 1、2 周的 MVP

| 项 | 内容 | 判据 |
|---|---|---|
| 仓库 | `C:\work\deepseek-im\biz-ai-agent`（git init，**没有建 GitHub 仓库、没有 push**）。设计文档从 framework 移来：framework 提交 `ad942f0`（`git rm` 并从 `publish/exclude.txt` 删去那一行），已 push 到 assistanted-it main | — |
| 第 1 周：接口 | `GET /bridge/v1/knowledge/search` 作为 Bridge v1 的可选能力：规则、可见范围模型、OpenAPI 片段、一致性检查 K-01…K-08（`@dsh-bridge/knowledge/conformance`） | 试点通过 K-01…K-07（所有角色都有工具时 K-08 跳过）；工具只给管理职时 K-01…K-08 全部通过 |
| 第 2 周：业务一侧 | `packages/knowledge`：文档 → 分块，可见范围按块（roles / users，节只能收窄），索引前查个人信息（本地形状检查 + 业务系统的 `piiScan`），**先按权限过滤再算统计量**的 BM25F（复用 help 的 normalize / 字符 bigram / 去掉提问词；拉丁文字按词、数字单独成词），来源 = 业务画面的链接。用 server-kit 的 `router.add` + `kit.readToolPolicy` 挂路由，**framework 没有改动** | 单元测试 9 个 |
| 第 2 周：DSH 一侧 | `plugins/knowledge`（`bridge-knowledge`）：bridge-tools 的 tool module，以提问的员工本人的委托运行；结果编号 `[n]` 带来源 URL，要求回答带引用；`checkCitations` / `ensureCitations`；不存索引，也不存正文（ledger 只在内存里存 10 分钟的来源） | 单元测试 3 个 |
| 试点 | `examples/leave-requests-knowledge`：复制 leave-requests，加 4 份虚构文档（英文 3 份、日文 1 份，各有只给管理职的节）、`/handbook/:docId` 画面（同样的可见范围；看不到的和不存在的都是 404） | 72 个测试：原有业务规则 + **一致性 52 / 52** + knowledge 10 个 + 插件端到端 5 个 |

测试证明了什么：

- **每个回答只含提问者能看的块。** 从文档的标题、小标题、关键词生成全部问题，再加一些问法。admin、manager 和两名 staff 分别在网页上、以及通过委托各问一遍，每个结果都对照块的可见范围检查。委托走网页助手的真实流程（ticket → `/assistant/delegations`），没有直接写 store。
- **没有旁路。** staff 得到的结果和分数，与用「从来没有那些隐藏块」的索引得到的完全相同。
- **只给本人的文档**（`users: [id]`）：同组的其他 staff、管理职、他们的委托都拿不到。
- **委托 × 角色**：manifest 的工具只给管理职时，staff 的 AI 得到 403，staff 本人在网页上照常能检索；员工停用后，其委托得到 401。
- **构建时 fail closed**：未知角色、比文档更宽的节、不是画面的链接、没有可见范围、含个人信息（邮箱、电话、名册里的姓名），都会让构建失败，错误里不出现原文。
- **变异检查**：故意去掉权限过滤，有 5 个测试失败；故意用全部块算统计量，「没有旁路」那个测试失败。

## 没做的、要知道的限制

- **插件还没在真正的 DSH home 里跑过。** 端到端测试用的是 dsh-core 的 `defineTool` / `guardTool` / `createToolRequester` / `createBusinessApi`，加真实的委托，但 gate 是测试用的（真正的是 bridge-tools 的 `createDelegationGate`）。
- **引用的检查还没接到发送前的过滤器。** 还没确认 bridge-identity 用的 dsh-im `setAnswerFilter` 能不能挂多个，怕覆盖 link guard，所以只做了 `ensureCitations` + ledger。现在靠工具输出和 persona 规则让模型带引用。
- **没有公开的知识**：只有服务主体、没有员工的请求得到 403，给未连携的发信者用的 `knowledge/public` 没做。
- **索引在内存里**，变更后整体重建（`setIndex` 一次替换）。没有持久化，没有增量更新，文档只有 Markdown 一种来源（附件、connectors、扫描件 OCR 还没接）。
- **检索质量没有评测。** 阈值（coverage 0.5、score 1）和提问词表是看 4 份文档调的；「How many days of annual leave」的第一条结果是「Carry-over」而不是「Annual leave」，分数几乎一样。这要等第 3 周的 evals。
- 两个新包都是 `private`，**没有发布到 npm**。

## 最好在 framework 上游改的（详见 KNOWLEDGE_API.md 末尾）

1. protocol：manifest 加 `knowledge: { tool }`（schema 现在不允许未知键），openapi 加这条路由，一致性套件加 K-01…K-08（作为可选检查）。
2. server-kit：加 `knowledge` 选项，让路由像 help 一样先过 gate，没有这个能力时再回 404。
3. dsh-core `manifestTools`：像 `help.tool` 那样，从 manifest 直接生成知识工具，就不需要配置 `toolModules`。
4. bridge-identity / dsh-im：回答过滤器支持多个（串在 link guard 后面），这样才能接上引用检查。
5. help：把通用的 BM25F 抽出来导出，英文手册也可以考虑按词切分。
6. examples/leave-requests：`createLeaveApp` 加 `manifest` 选项。

## 第 3–5 周需要的东西

| 周 | 内容 | 需要先定的 / 先准备的 |
|---|---|---|
| 3 | 可选 embedding + RRF 融合 + 重排；`/pii-scan` 正式接入索引（现在用 `hooks.piiScan` 直接调）；**evals**：中、日、英各 20 题，期望的来源，记录命中率 | **embedding 模型由你决定**（Azure OpenAI 日本东部 / 本地模型 / 继续只用 BM25F）。evals 的题目和「什么算答对」需要业务一侧的人来定。官网 biz-ai-web 的手册和咨询内容可以作为第二个试点（要先确认里面没有个人信息） |
| 4 | `bridge-graph`：从 manifest 生成图的骨架（实体、角色、事件、工具、playbook），加 `GET /bridge/v1/graph/neighbors`（只返回 ID 和类型，按权限过滤）；「这个审批为什么到了我这里」在 e2e 里通过 | 需要一个 DSH home 跑 e2e（`pnpm demo` 的方式），同时把本周的插件放进真正的 bridge-tools 里验证 |
| 5 | `agent-builder` skill（英文）：用它从零造一个新示例，要求一致性 52 / 52、evals 达标 | 选一个新示例的题目（建议是一个也有文档的小业务，例如设备借用或问询台） |

## 需要你决定的

1. embedding 的模型（同上，推荐：先 BM25F，再接 Azure OpenAI）。
2. 要不要给 biz-ai-agent 建 GitHub 仓库、push 到哪里（现在只是本地仓库）。
3. 这两个包最后是并入 framework（`packages/knowledge`、`plugins/knowledge`，加上上面的上游改动），还是保持在这里单独发布 `@dsh-bridge/knowledge`、`@dsh-bridge/plugin-knowledge`。我推荐并入 framework：路由、manifest 的键、一致性检查本来就属于 Bridge v1。
