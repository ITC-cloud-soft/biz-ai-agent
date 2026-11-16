# 设置插件 `@dsh-bridge/agent-settings`（v0.1 设计）

biz-ai-agent 的设置界面。和 knowledge、graph 一样，它是**挂到任意 Bridge v1 业务系统上的插件**（`createAgentSettings` → `register(bridge)`），
不改 framework。v0.1 有四组设置：模型、知识（文档上传 + 检索方式）、SNS（审批和报告）、AI 面的模型配置。以后按需要加组（版本升级）。

## 1. 放在哪里：业务系统一侧

| 设置 | 放在 | 为什么 |
|---|---|---|
| 知识文档、可见范围、检索方式 | **业务系统**（这个插件） | 文档和「谁能看」是业务数据，索引本来就在业务系统里建（framework 的原则：业务系统是 SoR） |
| embedding 模型、知识图谱抽取用的模型 | **业务系统**（这个插件） | 建索引、抽取图谱都在业务系统里做；文档不经过 AI 面 |
| 基础模型（AI 员工对话用） | **AI 面（DSH profile）** | 对话在 DSH 里跑。插件只**生成** DSH 的 overlay（`llm-pi-ai` provider，密钥只写环境变量名），由 install / 重启生效；v0.1 不直接改 DSH |
| SNS：谁审批、谁收报告 | **业务系统**（这个插件），送达用 framework | 审批卡片和报告走 framework 原有的路径：`approval.requested` → bridge-approvals，`knowledge.updated` → bridge-notify。员工的 SNS 连携也是 framework 原有的（连携码） |

画面：`GET /agent-settings`（只给管理员角色，默认 `admin`）。日文 / 英文 / 中文三种语言（跟随浏览器，`?lang=` 可以切换），浅色 / 深色跟随系统，手机宽度可用。

**画面的做法（2026-11-16 重做）**：React 应用（`packages/agent-settings/web/`），用 framework 的 **web-kit** 的设计令牌和组件，和 framework 的业务网页（care-web 等）是同一套外观。左侧导航分四页：概要、模型、知识、SNS。
- **SNS 页的「组织的 IM 机器人」= web-kit 的 `ImBotsShell`**，里面是 **dsh-im 自己的设置组件**（framework 的 `vendor/dsh-im/plugin-src/client`），和 DSH 的 IM 机器人画面、care-web 的「IM ボット接続」完全一样。13 种可以连携的 SNS（Slack、LINE、Teams、Telegram、企业微信应用、企业微信、钉钉、飞书、QQ、Discord、Matrix、WhatsApp、iMessage）加邮箱，各自原有的接入方式都照样能用：填凭据、扫二维码、手动设置。
- 这些组件通过业务系统的 **DSH 网关**（`@dsh-bridge/gateway`，挂在 `/dsh`，只给管理员）调用 dsh-im 的管理 RPC（`/dsh/api/dsh-im/<channel>`）。系统在 `register(bridge, { gateway: { rpcBase } })` 里告诉插件有网关；没有网关时，SNS 页会说明怎么接。
- 构建：`npm run build -w @dsh-bridge/agent-settings`（esbuild；构建时需要 framework 的 checkout：web-kit 和 dsh-im 组件；日文用 dsh-lang-ja 语言包）。产物 `dist/` 会提交，使用这个插件的系统不需要构建工具。

## 2. 设置项（v0.1）

### 2.1 模型

| 项 | 内容 |
|---|---|
| 基础模型 | 种类（OpenAI 兼容 / Azure OpenAI）、Base URL、模型名（Azure 用 deployment 名）、API key |
| embedding 模型 | 「不用（BM25F）」或 种类 / Base URL / 模型 / 维度（可选）/ API key |
| 连接测试 | 各一个按钮：只回 OK / 错误码和耗时，不回显 key，也不回显对方的响应正文 |
| AI 面 | 「DSH 用的 overlay」按钮：生成 `llm-pi-ai` + `agent-default-model` 的 YAML（`apiKeyEnv` 只写变量名） |

**API key 的处理**（密钥不进 git、不进日志、不进聊天）：
- 推荐：只填**环境变量名**（如 `AZURE_OPENAI_KEY`），值由运维放到环境里。
- 也可以在画面上直接填 key：只有在设置了主密钥 `AGENT_SETTINGS_KEY`（32 字节）时才允许，用 AES-256-GCM 加密后存在数据目录；没有主密钥时画面只允许填变量名。
- key 只能写不能读：API 只返回「已设置 / 来源（环境变量 / 已保存）/ 末尾 4 位」。

### 2.2 知识

| 项 | 内容 |
|---|---|
| 检索方式 | **BM25F**（默认，不用模型）/ **RAG**：BM25F + 向量（embedding 模型），向量存在**向量库** / **知识图谱**：用基础模型把文档抽成语义知识图谱（实体、关系），存成 **JSON 文件**，检索时 BM25F + 图谱 |
| 文档上传 | Markdown / 纯文本（`.md` `.txt`，≤ 200 KB）；标题、可见角色（勾选，至少一个）、关键词。Markdown 里的 `## 标题 {#anchor roles=…}` 照样可以把某一节收窄 |
| 文档列表 | 状态：等待审批 / 已发布 / 驳回 / 含个人信息（建索引被拒） / 已撤下 |
| 重建 | 「重建索引」按钮；结果（文档数、块数、被拒块数）也作为报告发到 SNS |

不管哪种方式，**权限优先**的规则都不变：
- RAG：向量只和提问者能看的块比较（第 3 周已经做好、测过）。
- 知识图谱：实体和关系都记着它们出自哪些块；检索时，只用提问者能看的块所支撑的实体和关系。图谱 JSON 里不存正文，只存名字、类型和块 ID。
- 抽取图谱时，模型的输入是**已经过个人信息检查的块**；抽出来的实体名也会再查一遍，查出来的就丢掉。
- 用 RAG 或图谱时，文档正文会发给你选的模型（embedding / 基础模型）。画面上会明确写出这一点。

### 2.3 SNS

| 项 | 内容 |
|---|---|
| 文档发布要审批 | 开 / 关（默认开）。开的时候，上传后生成一个审批（`approval.requested`），审批卡片通过 framework 发到审批人的 SNS（LINE / Slack / Teams …），在 SNS 上按按钮或回复审批码就能决定；网页上也能决定。批准后才进索引 |
| 审批人角色 | 默认 `admin`；上传的人自己不能批（framework 的规则） |
| 报告 | 收报告的角色（默认 `admin`）；报告时机：重建完成 / 图谱生成完成 / 失败。报告是 manifest 的事件 `knowledge.updated`，由 bridge-notify 发送，内容只有数字（文档数、块数、被拒数、失败数） |
| 我的 SNS 连携 | 「发行连携码」按钮（framework 的 `POST /bridge/v1/me/link-codes`），把「连携 123456」发给机器人就完成了。连携只能本人做 |

## 3. 存储（v0.1）

| 什么 | 存在哪里 |
|---|---|
| 设置（不含密钥） | 数据目录的 `agent-settings.json` |
| 保存的 key（只有设置了主密钥时） | 同一个文件里，加密存放（AES-256-GCM） |
| 上传的文档 | 数据目录的 `documents/<id>.md` + `documents/<id>.json`（元数据、状态） |
| **向量库** | **PostgreSQL + pgvector**（2026-11-16 决定，v0.2）：表 `agent_vectors`（模型、正文的 SHA-256、维度、向量；不存正文）。检索在 SQL 里做，**只在提问者能看的块里搜**（`WHERE digest = ANY(可见块)`）。连接：业务系统把自己的连接池传进来（`vectorDb`），或者设置 `AGENT_VECTOR_DB_URL`（连接串只放在环境变量里，不写进设置文件）。没有数据库时退回**文件型**（`vectors.json`，单进程） |
| 知识图谱 | 数据目录的 `knowledge-graph.json`（以「模型 + 块正文的 SHA-256」缓存每块的抽取结果，正文不变就不重新抽取） |

向量库是一个接口（`cache()` / `save()` / `search()`）：pgvector 和文件型两种实现。v0.2 是精确检索（不建 ANN 索引），几千个块没有问题；块数多了以后，固定维度时可以加 HNSW 索引（`packages/agent-settings/src/pgvector.mjs` 的注释里有 SQL）。

## 4. 接口（业务系统一侧，都只给人，管理员角色）

| 路由 | 用途 |
|---|---|
| `GET /agent-settings` | 设置画面 |
| `GET` / `PUT /api/agent/settings` | 读写设置（key 只能写；未知的键 400） |
| `POST /api/agent/settings/test` | 连接测试 `{ target: 'base' \| 'embedding' }` |
| `GET /api/agent/settings/dsh-overlay` | DSH 用的 overlay（YAML 文本） |
| `GET` / `POST /api/agent/documents` | 文档列表 / 上传 |
| `POST /api/agent/documents/:id/decision` | 网页上的审批（审批人角色，不能是上传的人） |
| `DELETE /api/agent/documents/:id` | 撤下 |
| `POST /api/agent/knowledge/rebuild`、`GET /api/agent/knowledge/status` | 重建，以及最近一次的结果 |

AI（委托）不能调用其中任何一个：都是 `{ allow: ['user'] }`。

## 5. 业务系统要加的（以试点为例）

- `createAgentSettings({ dataDir, … })` 在 `createBridgeApp` 之前创建，用它的 `approvals` / `recipientsFor` 包住业务系统自己的钩子（文档的审批和报告由插件处理，其余交给原来的钩子）。
- `createBridgeApp` 之后调用 `agent.register(bridge, { baseDocuments, … })`：插件接管知识服务（按检索方式切换）和上面的路由。
- manifest：实体 `knowledge_document`、事件 `knowledge.updated`（带 `notify` 模板）、`web.routes` 加 `/agent-settings`。

## 6. 以后的版本（候选）

- 正式的向量库适配器（pgvector 等）、增量更新
- 附件 / 扫描件 OCR 作为文档来源
- 直接修改 DSH 的模型设置（需要 DSH 或 framework 那边提供接口）
- 评测（evals）的界面：在画面上看每种检索方式的命中率
- playbook 的开关和委托设置、报告模板的编辑
