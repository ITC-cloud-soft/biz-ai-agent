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

## What is here (MVP, weeks 1–2)

| path | what |
|---|---|
| [`packages/knowledge`](packages/knowledge) | `@dsh-bridge/knowledge`, the business side. It indexes documents with per-chunk visibility (roles / employees) and searches with the asker's rights (BM25F over the character bigrams of `@dsh-bridge/help`, plus words for Latin text). It serves `GET /bridge/v1/knowledge/search` on server-kit's router and ships the knowledge conformance checks K-01…K-08. |
| [`plugins/knowledge`](plugins/knowledge) | `@dsh-bridge/plugin-knowledge` (`bridge-knowledge`), the DSH side. It is a bridge-tools tool module: the search becomes the AI employee's tool, run as the asking employee. Answers must cite `[n]` with the source screens. The plugin keeps no index. |
| [`examples/leave-requests-knowledge`](examples/leave-requests-knowledge) | The pilot: a copy of `framework/examples/leave-requests` with four fictional documents and a handbook screen. Its tests prove that a role never retrieves a chunk it may not see, also through a delegation. |
| [`docs/KNOWLEDGE_API.md`](docs/KNOWLEDGE_API.md) | The capability: route, rules, OpenAPI fragment, conformance checks, and the framework changes better made upstream. |

```sh
npm install
npm test        # knowledge 9 · plugin 3 · pilot 72 (business rules, Bridge v1 conformance 52 / 52, knowledge, plugin end to end)
```

The packages come from npm (`@dsh-bridge/protocol` and `server-kit` 0.1.1, `help` / `dsh-core` / `plugin-tools` 0.1.0). Nothing
here changes the framework. The two new packages are `private` and have not been published.

All data in the documents and tests is fictional. Embeddings are not used yet (BM25F only). The choice of model, Azure OpenAI or a
local one, is still open.

Licence: Apache-2.0 (like the framework).
