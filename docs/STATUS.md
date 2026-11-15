# 状态（2026-11-15）：MVP 5 周的内容已完成

计划见 [`GENERAL_AGENT_FRAMEWORK.md`](GENERAL_AGENT_FRAMEWORK.md)：§5 设计，§7 按周的路线图。接口见 [`KNOWLEDGE_API.md`](KNOWLEDGE_API.md)、[`GRAPH_API.md`](GRAPH_API.md)。
仓库：私有 [ITC-cloud-soft/biz-ai-agent](https://github.com/ITC-cloud-soft/biz-ai-agent)（main）。**framework 没有改动**，新包都是 `private`，没有发布到 npm。

## 路线图的判据，逐项对照

| 周 | 判据（§7） | 结果 |
|---|---|---|
| 1 | knowledge 接口：可选能力、OpenAPI、一致性检查（越权检索必须为空） | K-01…K-08（`@dsh-bridge/knowledge/conformance`）；两个示例都通过。protocol 本身还没有加（见「上游」） |
| 2 | 按角色检索的测试通过 | 试点：每个角色 × 网页 / 委托 × 全部生成的问题，结果都在可见范围内；没有旁路；变异检查能抓到 |
| 3 | 可选 embedding + RRF + 重排；`/pii-scan` 接入索引；中日英各 20 题 evals，记录命中率 | 见下面「第 3 周」。evals：试点 50/60，0 泄露 |
| 4 | 「为什么到我这里」的问答在 e2e 里通过 | 通过（经理 / 申请人 / 其他员工三种情况，真实委托）；G-01…G-07 |
| 5 | coding agent 按 skill 造出的系统 52/52 通过，evals 达标 | 另起一个只拿到 skill 和一段需求的 coding agent，从零造出 `examples/equipment-loans`：52/52、84 个测试、evals 每种语言 ≥ 83%，0 泄露 |

测试：全仓库 193 个全部通过（knowledge 18、plugin-knowledge 5、graph 5、plugin-graph 2、试点 79、equipment-loans 84），两个示例都是一致性 52 / 52（无 skip，无 known gap）。

## 第 3 周：检索质量、PII、可选 embedding

- **`/pii-scan` 接入**：`bridgePiiScreen` = server-kit `POST /bridge/v1/pii-scan` 的同一套检查（protocol 的形状检查 + `hooks.piiScan`）。hook 出错时构建失败，什么都不进索引。
- **可选 embedding**：接口 `{ id, embed(texts) }`，与 BM25F 用 RRF 融合；`httpEmbedder` 对应 OpenAI 兼容的 `/embeddings`（OpenAI、Azure OpenAI、本地服务）。**没有选模型。** 向量一侧只比较提问者能看的块。变异检查：故意让向量一侧看全部块，有 3 个测试失败。embedder 出错时退回 BM25F。
- **可选重排**：`rerank(question, candidates)` 只能重排或去掉提问者有权限的候选，不能加。
- **evals**（`runKnowledgeEvals`）：hit@3、按语言统计、「什么都没找到」的题、每个结果对照可见范围的泄露检查，加上 `forbid`（「不能返回这一节」）的写法。

试点的 evals（60 题，题目在调整之前写好）：

| | en | ja | zh | 合计 |
|---|---|---|---|---|
| 基线（覆盖率 0.5，按全部 bigram 算） | 10 | 8 | 5 | 23 / 60（38%） |
| 改成按内容词算覆盖率（去掉平假名、中文提问词、英文停用词） | 12 | 14 | 9 | 35 / 60（58%） |
| 覆盖率阈值 0.5 → 0.25 | **16** | **18** | **16** | **50 / 60（83%）**，0 泄露 |

**要知道的**：0.25 是在同一套题上调出来的（没有另外留一套检验题）。equipment-loans 的 72 题是另一个 agent 写的、事先没看过这个阈值，它的首轮是 75%，所以不算严重过拟合，但业务方应该另出一套检验题。

剩下的 10 个失败：3 个是「无权限的人问只给管理职的内容」，得到的是相关的公开节（**不是泄露**），现在的题写的是「什么都不能找到」；其余是问法和文档用词不同（「五年」对「5 年」、「提前」对「之前」等），要靠同义词或 embedding。

## 第 4 周：bridge-graph

- **骨架 = manifest**（`buildManifestGraph`，不用大模型）：角色、实体、事件、受众规则、工具、playbook、报告，以及它们之间的边。
- **`GET /bridge/v1/graph/neighbors`**：只返回 ID 和类型；对象本身和每个邻居都按提问者的权限检查；看不到的和不存在的都是同样的 404。
- **`explainReach`**：把骨架和邻居合成理由，每条理由都写明出自 manifest 的哪条规则；没有规则时只说「没有」，不编理由。
- **`bridge-graph` 插件**：工具 `<ns>_graph_why`，以提问的员工本人的委托运行。
- 试点的 e2e：经理得到「审批需要你的角色」「approval.requested 发给你的角色」等 4 条理由；申请人得到「是你提的」和受众规则；其他员工得到 `found: false`（和不存在的 ID 一样）。

## 第 5 周：agent-builder skill，以及用它造的新示例

- `skills/agent-builder/SKILL.md`（英文）：先造 IT 系统（52/52），再接知识、图谱、evals，最后写插件配置。
- **验证方法**：另起一个全新的 coding agent，只给 skill 和一段需求（设备借用：贵重物品或超过 7 天要经理批准，逾期跟进一次，中日英文档），不给这边的对话。它造出了 `examples/equipment-loans`：
  - manifest strict ok，一致性 52 / 52（首次就通过），84 个测试；
  - evals 72 题：首轮 54（75%）→ 只改了 8 个小标题后 61（85%）→ 后来包里补了中文提问词之后 63（88%）；0 泄露；
  - 它自己做了 4 次变异检查（让借用人自己审批、图谱忽略 scope own 等），每次都有测试失败。
- **我核对过**：重跑了 manifest、测试、一致性和 evals，数字一致；没有真实的个人信息。
- **它发现的 skill 和包的问题，已经修了**：
  - 包：`createKnowledgeService` 加了 `fillers`、`stopWords` 选项；同义词现在也算「内容词」（能把「没找到」变成找到）；中文提问词补了 哪些 / 有没有 / 怎么知道 / 怎么办；evals 加了 `forbid`。
  - skill：定义了 `<ns>`；知识的一致性检查 probe 要用「整份都看不到」的文档；关系名必须用 `requested_by` 等（即使业务上叫「借用人」）；复制测试时要改名的清单；时间类事件在一致性 fixture 里怎么处理；**一致性 52/52 证明不了业务规则**（让借用人自己审批照样 52/52，只有业务测试抓得到）；app 和 evals 必须共用同一个选项对象。

## 第 2 周遗留的问题

- **引用检查已接上**：确认了 dsh-im 的 `setAnswerFilter` 会保留多个过滤器、按注册顺序串联（vendor/dsh-im `im-extensions.mjs`），所以加了 `@dsh-bridge/plugin-knowledge/guard`（cordis 插件），和 link guard 并行，不会覆盖它。只在本轮调用过知识工具时才检查，用完就清掉。

## 没做的、要知道的限制

- **没有在真正的 DSH 上跑过。** 所有 e2e 都是业务系统走 HTTP + 真实委托 + dsh-core 的 `defineTool` / `guardTool` / `createToolRequester`，gate 是测试用的（真正的是 bridge-tools 的 `createDelegationGate`）。真正的 DSH e2e（framework 的 `pnpm e2e` 方式）需要 PostgreSQL 和 DSH CLI，而 Docker 现在还没起来。
- **索引在内存里**，变更后整体重建；文档只有 Markdown（附件、connectors、扫描件 OCR 还没接）。
- **没有公开的知识**（未连携的发信者用的 `knowledge/public`）。
- embedding 只测了接口和权限（用一个确定性的假 embedder），**真实模型的质量没测**（模型还没定）。
- 两个示例的 `/loans`、`/equipment` 等画面只在 manifest 里声明了路由，没有 HTML（和原来的 leave-requests 一样）。

## 最好在 framework 上游改的

详见 KNOWLEDGE_API.md、GRAPH_API.md 末尾。
1. protocol：manifest 加 `knowledge: { tool }`、`graph: { tool }`，openapi 加两条路由，一致性套件加 K-01…K-08、G-01…G-07（可选检查）。
2. server-kit：加 `knowledge`、`graph` 选项，路由先过 gate 再回 404。
3. dsh-core：`manifestTools` 从 manifest 直接生成知识工具；把 manifest 在注册时交给 tool module。
4. help：导出通用的 BM25F，英文手册也按词切分。
5. examples/leave-requests：`createLeaveApp` 加 `manifest` 选项。

## 需要你决定的

1. **embedding 的模型**（推荐：先 BM25F，再接 Azure OpenAI 日本东部）。接口已经备好，定了之后只需要配置。
2. **evals 的标准答案**：两套题都是 AI 起草的，「什么算答对」需要文档负责人确认，最好再出一套没参与调整的检验题。
3. 这些包最后是**并入 framework**，还是在这里单独发布。推荐并入：路由、manifest 的键、一致性检查本来就属于 Bridge v1。
4. 下一步是否在真正的 DSH 上跑 e2e（要先把 Docker / PostgreSQL 起来）。
5. 是否把「通用 AI agent 框架」写进官网和 README（计划 §8.3 说等第 5 周有事实后再定，现在有了）。
