# @dsh-bridge/agent-settings (v0.3)

The settings of biz-ai-agent, as a plugin for any Bridge v1 business system built on server-kit. Design and rationale:
[`docs/AGENT_SETTINGS.md`](../../docs/AGENT_SETTINGS.md) (Chinese).

**The screen** (`GET /agent-settings`, admins only) is a React app (`web/`, built into `dist/` by `npm run build`) on the
framework's **web-kit** (its design tokens and parts, the same look as the framework's business webs): overview, models, knowledge,
SNS; Japanese / English / Chinese, light / dark, phone widths. The SNS page's organisation IM bots are web-kit's `ImBotsShell` with
**dsh-im's own settings components** — the same screen as DSH and care-web: the 13 SNS an employee can link plus e-mail, each with
its own connect flow (credentials, QR, manual). They reach dsh-im through the system's **DSH gateway** (`@dsh-bridge/gateway` at
`/dsh`, admins only): pass `gateway: { rpcBase: '/dsh/api/dsh-im' }` to `register`. Every employee also gets `/me/sns`
(web-kit's `SnsLinkPage`: their own links only, the link code, unlink, notification preferences — server-kit's Bridge v1 `/me/*`). For a system without a sign-in screen of its own, `signInPage({ system, next, lang })` is one in
the same look (it posts to the system's own login API and never sees a session) and `redirectToSignIn(req, res, { authenticate })`
sends a browser without a session from a screen to it and back. The build needs a framework checkout
(web-kit and the dsh-im client from this repository's synced framework, or `BIZ_AI_FRAMEWORK`); `dist/` is committed, so a system serving it needs no bundler.

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
