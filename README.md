# biz-ai-agent

A complete **AI agent framework**: the whole **Biz Assistant Framework** (`@dsh-bridge/*`: DSH core, the dsh-im fork for 13 SNS,
memory, approvals, notify, identity, tools, events, assistant, persona, reader, the gateway, server-kit, web-kit, the DSH profile)
is in this repository, plus the agent layer on top of it (knowledge, graph, settings). Upstream is the private `assistanted-it`
repository (public snapshot [ITC-cloud-soft/biz-ai](https://github.com/ITC-cloud-soft/biz-ai)); `npm run sync-framework` copies
it in again (see below).

The Biz Assistant Framework already gives an agent four of its five layers: the manifest is the schema (ontology), the business
system is the data (system of record), proposals and approvals are the governed actions, and DSH runs the agents, with bridge-memory
as their memory. What is missing is a **knowledge layer** (RAG and a semantic graph) that keeps the framework's rules:

- retrieval with the employee's **own rights** (delegation × role);
- sources that are **business screens**;
- **no personal data** in the indexes.

The plan is [`docs/GENERAL_AGENT_FRAMEWORK.md`](docs/GENERAL_AGENT_FRAMEWORK.md): §5 is the design, §7 the roadmap by week. Next (draft, under review): [`docs/MULTI_AGENT_PLATFORM.md`](docs/MULTI_AGENT_PLATFORM.md), Agent Hub, a control plane that manages every agent of the company (manager / user accounts, start and stop, per-agent knowledge, sandbox, debugging). Where
things stand is in [`docs/STATUS.md`](docs/STATUS.md).

An agent is first an IT system: no drag-and-drop flow editor. Flows are code, written with coding agents, guarded by the manifest, the
conformance suite, tests, evals and traces.

**Start here: the manual [`docs/MANUAL.md`](docs/MANUAL.md)** (Chinese; slides: [`docs/MANUAL.pptx`](docs/MANUAL.pptx)). To build an agent with a coding agent: [`skills/agent-builder`](skills/agent-builder/SKILL.md).

## What is here (MVP, weeks 1–5)

| path | what |
|---|---|
| [`packages/knowledge`](packages/knowledge) | `@dsh-bridge/knowledge`, the business side of the knowledge layer: documents with per-chunk visibility (roles / employees), the /pii-scan screen before indexing, search with the asker's rights (BM25F; an optional embedder fused by RRF and an optional reranker, both on the asker's visible chunks only), `GET /bridge/v1/knowledge/search`, conformance K-01…K-08, and the evals runner. |
| [`plugins/knowledge`](plugins/knowledge) | `@dsh-bridge/plugin-knowledge` (`bridge-knowledge`): the search as the AI employee's tool (a bridge-tools tool module, run as the asking employee; answers cite `[n]` with the source screens), and `/guard`, the citation guard as a dsh-im answer filter next to the link guard. No index on the AI side. |
| [`packages/graph`](packages/graph) | `@dsh-bridge/graph`: the semantic graph's skeleton generated from the manifest (no model), `GET /bridge/v1/graph/neighbors` (IDs and types only, the asker's rights), `explainReach` ("why did this reach me?"), conformance G-01…G-07. |
| [`plugins/graph`](plugins/graph) | `@dsh-bridge/plugin-graph` (`bridge-graph`): `<namespace>_graph_why`, run with the employee's own delegation. |
| [`packages/agent-settings`](packages/agent-settings) | `@dsh-bridge/agent-settings` v0.1: the settings plugin and its screen `/agent-settings` (ja / en / zh): models (base / embedding), knowledge documents and the search method (BM25F / RAG with a vector store / a semantic knowledge graph as JSON), SNS approvals and reports through the framework. Design: [`docs/AGENT_SETTINGS.md`](docs/AGENT_SETTINGS.md). |
| [`skills/agent-builder`](skills/agent-builder) | The `agent-builder` skill (English): an IT system first (Bridge v1, 52 / 52), then knowledge, graph, evals and the plugin configuration. |
| [`examples/leave-requests-knowledge`](examples/leave-requests-knowledge) | The pilot (a copy of `framework/examples/leave-requests`): six fictional documents in English, Japanese and Chinese, the handbook screen, the graph hooks, 60 eval questions. |
| [`examples/equipment-loans`](examples/equipment-loans) | A new example built from scratch by a coding agent that followed only the skill (week 5). |
| [`docs/KNOWLEDGE_API.md`](docs/KNOWLEDGE_API.md), [`docs/GRAPH_API.md`](docs/GRAPH_API.md) | The two capabilities: routes, rules, conformance checks, and the framework changes better made upstream. |

```sh
npm install
npm run vendor:install   # once: the vendor forks' own dependencies
npm test                 # every package, plugin and example (about 900 tests)
cd examples/leave-requests-knowledge && npm run evals    # the retrieval evals as a Markdown table
npm run e2e     # the pilot on a REAL DSH (pinned CLI in .dsh-cli, mock model and LINE; no database; needs npm run vendor:install once)
```

## The framework in this repository

| path | what |
|---|---|
| `packages/` dsh-core, gateway, help, protocol, server-kit, telemetry, testing, web-kit | the protocol (Bridge v1 + conformance), the business-side kit, the DSH core, the DSH gateway, the screens' kit, the test harness |
| `plugins/` approvals, assistant, events, identity, memory, notify, persona, reader, tools | the DSH plugins: approvals on IM, the web assistant, business events, SNS identity and link codes, memory, notifications, persona, document reader, the business tools |
| `profile/` | the DSH product profile template and its installer |
| `vendor/` dsh-im, dsh-auto-tasks, dsh-proactive | the forks (MIT; own npm setup each: `npm run vendor:install` once) — dsh-im is the IM gateway for the 13 SNS |
| `examples/` care-billing, equipment-inspection, leave-requests | the framework's reference business systems |

These are **copies** of the framework's committed files at the commit in [`framework.sync.json`](framework.sync.json), made by
[`scripts/sync-framework.mjs`](scripts/sync-framework.mjs) (`npm run sync-framework`, from `../framework` or `--from <checkout>`;
pnpm's `workspace:` ranges become plain versions for npm workspaces). Fix framework code in the framework and sync again: a
local edit to a copied file is overwritten by the next sync. Everything links inside this repository (no `@dsh-bridge/*` from
npm). The DSH CLI the e2e pins goes to `.dsh-cli/` (git-ignored; about 900 MB on first use).

All data in the documents, tests and evals is fictional. No embedding model is chosen (BM25F by default; the embedder interface
takes any OpenAI-compatible endpoint once the owner picks one).

Licence: Apache-2.0 (like the framework).
