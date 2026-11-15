# biz-ai-agent

Exploring a **general AI agent framework** on top of the **Biz Assistant Framework** (`@dsh-bridge/*`, the private
`assistanted-it` repository, public snapshot [ITC-cloud-soft/biz-ai](https://github.com/ITC-cloud-soft/biz-ai)).

The Biz Assistant Framework already gives an agent four of its five layers: the manifest is the schema (ontology), the business
system is the data (system of record), proposals and approvals are the governed actions, and DSH runs the agents, with bridge-memory
as their memory. What is missing is a **knowledge layer** (RAG and a semantic graph) that keeps the framework's rules:

- retrieval with the employee's **own rights** (delegation × role);
- sources that are **business screens**;
- **no personal data** in the indexes.

The plan is [`docs/GENERAL_AGENT_FRAMEWORK.md`](docs/GENERAL_AGENT_FRAMEWORK.md): §5 is the design, §7 the roadmap by week. Where
things stand is in [`docs/STATUS.md`](docs/STATUS.md).

An agent is first an IT system: no drag-and-drop flow editor. Flows are code, written with coding agents, guarded by the manifest, the
conformance suite, tests, evals and traces.

## What is here (MVP, weeks 1–5)

| path | what |
|---|---|
| [`packages/knowledge`](packages/knowledge) | `@dsh-bridge/knowledge`, the business side of the knowledge layer: documents with per-chunk visibility (roles / employees), the /pii-scan screen before indexing, search with the asker's rights (BM25F; an optional embedder fused by RRF and an optional reranker, both on the asker's visible chunks only), `GET /bridge/v1/knowledge/search`, conformance K-01…K-08, and the evals runner. |
| [`plugins/knowledge`](plugins/knowledge) | `@dsh-bridge/plugin-knowledge` (`bridge-knowledge`): the search as the AI employee's tool (a bridge-tools tool module, run as the asking employee; answers cite `[n]` with the source screens), and `/guard`, the citation guard as a dsh-im answer filter next to the link guard. No index on the AI side. |
| [`packages/graph`](packages/graph) | `@dsh-bridge/graph`: the semantic graph's skeleton generated from the manifest (no model), `GET /bridge/v1/graph/neighbors` (IDs and types only, the asker's rights), `explainReach` ("why did this reach me?"), conformance G-01…G-07. |
| [`plugins/graph`](plugins/graph) | `@dsh-bridge/plugin-graph` (`bridge-graph`): `<namespace>_graph_why`, run with the employee's own delegation. |
| [`skills/agent-builder`](skills/agent-builder) | The `agent-builder` skill (English): an IT system first (Bridge v1, 52 / 52), then knowledge, graph, evals and the plugin configuration. |
| [`examples/leave-requests-knowledge`](examples/leave-requests-knowledge) | The pilot (a copy of `framework/examples/leave-requests`): six fictional documents in English, Japanese and Chinese, the handbook screen, the graph hooks, 60 eval questions. |
| [`examples/equipment-loans`](examples/equipment-loans) | A new example built from scratch by a coding agent that followed only the skill (week 5). |
| [`docs/KNOWLEDGE_API.md`](docs/KNOWLEDGE_API.md), [`docs/GRAPH_API.md`](docs/GRAPH_API.md) | The two capabilities: routes, rules, conformance checks, and the framework changes better made upstream. |

```sh
npm install
npm test
cd examples/leave-requests-knowledge && npm run evals    # the retrieval evals as a Markdown table
npm run e2e -- --patch-dsh-im   # the pilot on a REAL DSH (pinned CLI from ../framework/.dsh-cli, mock model and LINE; no database)
```

The packages come from npm (`@dsh-bridge/protocol` and `server-kit` 0.1.1, `help` / `dsh-core` / `plugin-tools` 0.1.0). Nothing
here changes the framework. The new packages are `private` and have not been published.

All data in the documents, tests and evals is fictional. No embedding model is chosen (BM25F by default; the embedder interface
takes any OpenAI-compatible endpoint once the owner picks one).

Licence: Apache-2.0 (like the framework).
