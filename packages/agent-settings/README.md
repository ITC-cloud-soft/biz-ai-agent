# @dsh-bridge/agent-settings (v0.2)

The settings of biz-ai-agent, as a plugin for any Bridge v1 business system built on server-kit. Design and rationale:
[`docs/AGENT_SETTINGS.md`](../../docs/AGENT_SETTINGS.md) (Chinese).

| tab | settings |
|---|---|
| Models | base model (knowledge-graph extraction) and embedding model (RAG): OpenAI-compatible or Azure OpenAI, base URL, model / deployment, API key as an **environment variable name** (recommended) or stored sealed (AES-256-GCM, only with `AGENT_SETTINGS_KEY`). Keys are write-only. Connection test (codes only). The DSH overlay for the AI plane's conversation model (variable names only) |
| Knowledge | search method **BM25F** (default, no model) / **RAG** (BM25F + vectors in the vector store: **PostgreSQL + pgvector** when the system passes a database (`vectorDb`) or `AGENT_VECTOR_DB_URL` is set — the vector search runs in SQL among the asker's visible chunks only; otherwise a file, `vectors.json`) / **semantic knowledge graph** (the base model extracts entities and relations per chunk into `knowledge-graph.json`: names, types, chunk IDs — no text). Document upload (Markdown / text, roles, keywords), status, withdraw, rebuild |
| SNS | publishing needs an approval (the framework's approval cards on SNS; the uploader never approves), approver roles, report roles (`knowledge.updated`, counts only, through bridge-notify), report triggers, the employee's own link code |

```js
import { createAgentSettings } from '@dsh-bridge/agent-settings'
import { bridgePiiScreen, registerKnowledge } from '@dsh-bridge/knowledge'

const agent = createAgentSettings({ dataDir: '/var/lib/my-system/agent' })     // before createBridgeApp
hooks.approvals = agent.approvals(hooks.approvals)                               // documents first, then the system's own
hooks.recipientsFor = agent.recipientsFor(hooks.recipientsFor)                   // the knowledge.updated report, then the system's own
const bridge = await createBridgeApp({ manifest, store, hooks, /* … */ })
await agent.register(bridge, { baseDocuments, buildIndex, webBase, screen: bridgePiiScreen({ hooks, ctx: () => bridge.kit.ctx() }) })
registerKnowledge(bridge, agent.knowledge)
```

The manifest needs the entity `knowledge_document`, the event `knowledge.updated` (with a `notify` template of the integer params
`documents`, `chunks`, `rejected`, `failed`) and `/agent-settings` in `web.routes` — see `examples/leave-requests-knowledge`.

Rules it keeps: everything is for people of the admin roles (no delegation reaches it); permissions first in every search method;
a document with personal data is refused and its text is not kept; graph names flagged by the screen are dropped; a failing model
falls back to BM25F and the failure is reported; keys never appear in an answer, a log or a file in clear.
