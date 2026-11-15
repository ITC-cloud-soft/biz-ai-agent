# @dsh-bridge/knowledge

The business side of the knowledge layer: permission-aware search over the business system's own documents. It is an
optional Bridge v1 capability, `GET /bridge/v1/knowledge/search` (see [docs/KNOWLEDGE_API.md](../../docs/KNOWLEDGE_API.md)).

- **Documents with visibility.** Each document declares `roles` and / or `users` (employee IDs). A section can only narrow that
  (`## Heading {#anchor roles=admin,manager}`). There is no "visible to everyone" default. Unknown roles, sections wider than
  their document, and links that are not screens of `web.routes` all stop the build.
- **Personal data never enters the index.** Every chunk is checked before indexing: the local shape check (e-mail, phone numbers,
  long numbers) plus the business system's own `screen` (for example `hooks.piiScan`, which knows the names in the roster). By
  default the build fails, listing chunk IDs and kinds but never the text. With `onPersonalData: 'skip'`, those chunks are left
  out and listed in `index.rejected`.
- **Search with the asker's rights.** Chunks the asker may not read are removed **before** any statistic is computed (df, average
  length, N). A hidden chunk therefore changes neither the results nor their scores. Ranking is BM25F (title ×3, keywords ×3,
  heading ×2, body ×1) over the character bigrams of `@dsh-bridge/help` for Japanese / Chinese, plus words and numbers for Latin text.
- **Sources are screens.** Each result's `source` is the document's screen link plus the section anchor, on the business web
  (`webBase`).
- **The route.** It is registered on server-kit's router (`registerKnowledge(bridge, service)`), behind `kit.readToolPolicy`. A
  web employee of any role may search. A delegation may search only when the manifest declares a read tool on
  `GET /bridge/v1/knowledge/search` for the employee's role. The service alone gets 403.

```js
import { bridgePiiScreen, buildKnowledgeIndex, createKnowledgeService, readKnowledgeDir, registerKnowledge } from '@dsh-bridge/knowledge'

const bridge = await createBridgeApp({ /* … */ hooks })
const index = await buildKnowledgeIndex(await readKnowledgeDir('knowledge'), {
  roles: bridge.kit.declaredRoles, routes: bridge.kit.manifest.web?.routes, screen: bridgePiiScreen({ hooks, ctx: () => bridge.kit.ctx() }),
})
const knowledge = createKnowledgeService(index, { webBase: 'https://leave.example.com' })
registerKnowledge(bridge, knowledge)
// later: knowledge.setIndex(await buildKnowledgeIndex(...))   — a rebuilt index, swapped at once
```

A document file looks like this:

```md
---
id: leave-policy
title: Leave policy
link: /handbook/leave-policy
roles: [admin, manager, staff]
keywords: [annual leave, carry over]
---
Introduction.

## Carry-over {#carry-over}
Up to 5 unused days carry over …

## Approval rules for managers {#approval-rules roles=admin,manager}
A manager may approve up to 10 consecutive working days …
```

Conformance (`@dsh-bridge/knowledge/conformance`): `runKnowledgeChecks({ baseUrl, serviceToken, fixtures })` runs K-01…K-08
over HTTP. See the pilot's `test/knowledge.test.mjs`.

Tests: `npm test` (no server).

## Week 3 additions

- **The /pii-scan screen.** `bridgePiiScreen({ hooks, ctx })` is the same check as server-kit's `POST /bridge/v1/pii-scan`
  (protocol shapes with the prose kinds skipped, plus `hooks.piiScan`). A failing hook fails the build: nothing is indexed.
- **"Found" uses content terms.** Coverage is computed over the question's content: Japanese hiragana runs (particles,
  okurigana), Chinese question words (`ZH_FILLERS`) and English stop words are left out; the default minimum is 0.25 (tuned on
  the pilot's evals and said so in docs/STATUS.md).
- **Optional embedder.** `createKnowledgeService(index, { embedder })` with any `{ id, embed(texts) }` fuses BM25F and cosine
  similarity by RRF (`minSimilarity`, default 0.8). The vector side compares only the asker's visible chunks. `httpEmbedder({ url,
  model?, headers? })` speaks the OpenAI-compatible `/embeddings` API (OpenAI, Azure OpenAI deployments, local servers). No model
  is chosen here. An embedder that fails falls back to BM25F (`onError` is told). `setIndex` then resolves once the new chunks
  are embedded (vectors are cached by text).
- **Optional reranker.** `rerank(question, candidates)` may reorder or drop the asker's permitted candidates (at most 20), never
  add one.
- **Evals.** `runKnowledgeEvals(service, suite)` / `formatEvalReport(report)` (also `@dsh-bridge/knowledge/evals`): hit@k per
  language, "nothing found" cases, and a leak check of every result against its chunk's visibility.
