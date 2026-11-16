---
name: agent-builder
description: >-
  Builds an AI agent from a business need on top of the Biz Assistant Framework (@dsh-bridge/*): first an ordinary IT system that
  works with AI employees (Bridge v1, manifest, conformance 52 / 52), then its knowledge (permission-aware document search with
  sources), its graph ("why did this reach me?"), a fixed set of retrieval evals, and the plugin configuration for the AI plane.
  Use it for requests such as "build an agent for X", "make an AI assistant for our <business>", "an agent that answers from our
  documents with each employee's rights", "add knowledge / RAG to a Bridge system", "add a graph / why-explanations", "write
  evals for an agent", "make a new example system with knowledge". For connecting an EXISTING system's Bridge part, this skill
  hands over to the biz-assistant-integration skill and comes back for knowledge, graph and evals.
---

# Building an agent: an IT system first, then knowledge, graph and evals

An agent here is **an ordinary business system plus ordinary plugin configuration, all in git** — not a flow drawn in an editor.
The business system is the system of record: it owns the data, the roles, who sees what and who decides. The AI employee reads
(with the asking employee's own delegation) and proposes; people decide.

What you produce:

| part | what it is | done when |
|---|---|---|
| IT system | a server-kit app: business data, login, hooks, `/api/*`, events in the transaction (outbox), approvals | `bridge-validate manifest --strict` exits 0, **conformance 52 / 52** (no skip, no known gap), business tests pass |
| ontology | `bridge.manifest.yaml`: roles, entities (with screen links), events, audience rules, tools, playbooks (off), reports, glossary | strict validation; the graph skeleton is generated from it |
| knowledge | `knowledge/*.md` with per-section visibility, indexed at start, `GET /bridge/v1/knowledge/search`, the handbook screen | the permission property, no side channel, K-01…K-08 |
| graph | `canRead` + `neighbors` hooks, `GET /bridge/v1/graph/neighbors` | G-01…G-07, the "why did this reach me?" e2e |
| evals | `evals/knowledge.evals.json`: fixed questions, askers, expected sources | written BEFORE tuning, run on every change, a floor test |
| settings | `@dsh-bridge/agent-settings` on the system: the screen `/agent-settings` (models, documents and the search method BM25F / RAG on pgvector / knowledge graph, SNS approvals and reports) | admins only, the document approval through the framework's cards, the report to the report roles; its tests |
| AI plane | bridge-tools `toolModules`: `@dsh-bridge/plugin-knowledge`, `@dsh-bridge/plugin-graph` | listed in the README (a real DSH run is a separate step) |

**The reference implementations are in this repository**: `examples/leave-requests-knowledge` (one-file app, every part above)
and `examples/equipment-loans` (built from scratch with this skill; a time-based event, a catalog entity, three languages). Read
`src/app.mjs`, `bridge.manifest.yaml`, `knowledge/`, `evals/` and `test/` of one of them before you write anything; copy and
adapt rather than invent. Interfaces: `docs/KNOWLEDGE_API.md`, `docs/GRAPH_API.md`. Framework rules: the framework repository
(private `ITC-cloud-soft/assistanted-it`, public snapshot `ITC-cloud-soft/biz-ai`; ask where the local checkout is) —
`docs/GUIDELINE.en.md` and its skill `docs/skill/biz-assistant-integration` (cited below as *integration skill*).

Words used below: **`<ns>`** is the application's namespace — the prefix of every manifest tool name (`leave_...`, `loan_...`)
and the `namespace` of the application in bridge-tools; the plugins name their tools `<ns>_knowledge_search` and
`<ns>_graph_why`.

## 0. Ask first — and write down what you did not ask

These are decisions for people, not for you. Write the options and your recommendation in the plan (copy
`templates/agent-plan.md` to `examples/<system-id>/AGENT_PLAN.md`) and wait. When nobody can be asked (an unattended run), take the recommended default, mark it **"to confirm"**, and go on.

1. **Who the agent works for and what it may do**: which roles talk to it; what it reads (each tool and its roles); what it may
   propose; who decides each proposal and approval. Default: read + propose for every role, writes by people only.
2. **Documents**: who owns them; which sections are for which roles or for one employee (`users`). Default: the narrowest
   reasonable audience; never "everyone" by default (the build refuses a document without visibility).
3. **What a correct answer is**: the evals' expected sources are a business decision. Default: you draft them, mark them "to
   confirm by the document owners".
4. **Embedding model**: none (BM25F) unless the owner chose one. Never pick a model or an endpoint yourself.

## 1. Build the IT system

- Existing system → follow the *integration skill* for the Bridge part, then continue here at step 3.
- New system → start from the reference implementation:
  1. Copy `examples/leave-requests-knowledge` to `examples/<system-id>/` (package name `@biz-ai-agent/example-<system-id>`).
     Workspaces resolve `@dsh-bridge/knowledge`, `@dsh-bridge/graph` and the plugins; run `npm install` at the repository root.
  2. Replace the business: the data maps, the state changes (`kit.tx` + `kit.emitEvent` **in the same transaction**), the
     approval rule (`mayDecide`, one function used by the web route AND the chat card; never the requester), the scheduled scan
     that emits the "waiting too long" event, the `/api/*` routes.
  3. Keep the hooks' shape: `employees`, `authenticate`, `isSessionLive`, `recipientsFor` (who is told — the system decides,
     IDs and typed params only), `approvals` (get / approvers / card / mayDecide / decide), `proposalKinds` (validate + apply),
     `reports.compute` (counts, scoped by role), `piiScan` (names in the roster).
  4. AI reads use `kit.readToolPolicy('<METHOD> <path>', roles)`; every write is `{ allow: ['user'] }` (people only).
  5. Rename everything (cookie name, token prefixes, labels). No real names, addresses, phone numbers or e-mails anywhere —
     fictional data only, in documents and tests too. In the copied tests rename as well: the factory name and the
     `globalThis.__<app>` handle in `conformance.test.mjs` / `fixtures.mjs`, the test service token and BFF secret, the
     application id and `<ns>` in the plugin and graph tests, and every hard-coded chunk id, document count, case count and eval
     floor in the knowledge and evals tests.
  6. A time-based event ("waiting too long", "overdue"): the conformance fixtures must make it happen without waiting. Either
     give the scan a parameter (the pilot's `minDays`) or move the object's dates back on the running instance from the
     fixtures (`examples/equipment-loans/test/fixtures.mjs`); time passes directly on the instance, never through the API.
  7. Declare `@dsh-bridge/dsh-core` as a devDependency (the plugin and graph tests import it).

## 2. Write the ontology (manifest)

Start from the reference manifest. For each part, keep the reference's style:

- `system`, `web.routes` (every screen a source or a notification may link to, including `/handbook/:docId`), `roles`
  (label, scope, `delegation: propose`), `entities` (each with `pii` and, when it has a screen, `link: "/<things>/{id}"` — the
  graph builds its screen links from it), `audienceRules` (`includes: [author]` when the requester is told too).
- `events`: the three framework events (`approval.requested`, `approval.decided`, `sns_identity.unlinked`) plus your business
  events. Payloads are IDs, dates, counts and states only.
- `tools`: one read tool per `/api/*` GET the AI may call, **plus** `<ns>_knowledge_search` (`GET /bridge/v1/knowledge/search`,
  input `{ question, limit }`) and `<ns>_graph_neighbors` (`GET /bridge/v1/graph/neighbors`, input `{ entity, id }`), and the
  propose tool(s). Roles per tool = what step 0 decided.
- `playbooks`: `enabled: false`, `approval: none` or stricter, instructions that only check and report.
- Validate: `npx bridge-validate manifest bridge.manifest.yaml --strict` must print `ok`.

## 3. Connect knowledge

1. Documents in `knowledge/*.md` (format: `packages/knowledge/README.md`):
   ```markdown
   ---
   id: lending-rules            # [a-z0-9-], unique
   title: Lending rules
   link: /handbook/lending-rules   # must match a web.routes entry
   roles: [admin, manager, staff]  # and/or users: [<employee id>]
   keywords: [loan, borrow, return]
   ---
   Introduction (fictional company).

   ## Returning equipment {#returning}
   ...
   ## Approval limits {#approval-limits roles=admin,manager}   # sections may only NARROW the document's visibility
   ```
   One document per language you serve; each language needs enough sections for its evals.
2. In `createXxxApp`: `readKnowledgeDir` → `buildKnowledgeIndex(docs, { roles: kit.declaredRoles, routes: kit.manifest.web.routes,
   screen: bridgePiiScreen({ hooks, ctx: () => kit.ctx() }) })` → `createKnowledgeService(index, { webBase, ...knowledgeOptions })`
   → `await knowledge.ready()` → `registerKnowledge(bridge, knowledge)`; `rebuildKnowledge` awaits `setIndex`.
3. The handbook screen `GET /handbook/:docId` (people only) renders only the sections the employee may read and answers 404 for
   a hidden and a missing document alike (copy the reference).
4. The build fails on personal data (protocol shapes + roster names): fix the document, never switch the check off.

## 4. Connect the graph

`registerGraph(bridge, { canRead, neighbors })`:

- `canRead({ entity, id }, asker)` = **the same rule as the screen** (staff: their own objects; managers: all — whatever your
  web authorization says). Unknown entity → false.
- `neighbors({ entity, id }, asker)` = the object's direct relations: `{ relation, entity, id }` with `entity` a manifest entity,
  `employee` (an ID, never a name) or `role`. Typical: `subject`, `requested_by`, `required_role`, `decided_by`, `assigned_to`.
  The route re-checks every entity neighbor with `canRead`; you still return only what exists.
- Use exactly the relation names `requested_by` (or `author`) / `assigned_to` / `required_role`, **even when the business word
  differs** (a borrower is `requested_by`): `explainReach` turns only these into the reasons "You made it", "It is assigned to
  you", "It waits for a decision by your role", and into the audience-rule reason for the requester. Other relations (`subject`,
  `item`, `decided_by` ...) are walked for their events but give no reason of their own.
- The reason kinds an e2e can expect (`packages/graph/src/explain.mjs`): `required_role`, `author`, `assignee`,
  `event_audience`, `related_event` (an event about a neighbor), `audience_rule`, `playbook`, and `none` when no rule sends it.

## 5. Write the evals — before tuning

- `evals/knowledge.evals.json` (copy the reference's shape): `askers` (fictional ids and roles) and `cases`
  `{ id, lang, asker, q, expect: ['<doc>#<anchor>'] | [], forbid?: [...] }`. **At least 20 per language you serve**, written the
  way employees ask (not copied headings), including:
  - questions for each restricted section, asked by a role that may read it (`expect: ['<doc>#<restricted>']`);
  - the same asked by a role that may not: `expect: [], forbid: ['<doc>#<restricted>']`. It passes when the restricted section
    is not returned, even if a public section on the same topic is (that is a right answer, not a failure). Use plain
    `expect: []` only when NO section the asker may read is relevant;
  - 1–2 out-of-scope questions per language (`expect: []`).
- `evals/run.mjs` (copy) prints the report: `npm run evals`. Record the FIRST run's numbers before you change anything.
- **One options object.** Export the knowledge options (synonyms, fillers, stopWords, embedder ...) from `src/app.mjs` and use
  the same object in the app and in `evals/run.mjs`; otherwise the evals measure a configuration that does not run.
- Legitimate tuning: document keywords and headings (owners' wording); `synonyms` (`[[documentsWord, otherWord, ...], ...]`: the
  other word then counts as the documents' word, so it can turn "nothing found" into found); `fillers` (question words of a
  language) and `stopWords` (a Set of English words) through `createKnowledgeService`. A question word missing for a whole
  language (not just your documents) belongs in `packages/knowledge`: report it. Not legitimate: editing a case so it passes,
  or tuning a threshold on the eval set without saying so in the report.
- Done: every language ≥ 80 % hit@3, **0 leaks** (a leak fails the case and the test). `test/evals.test.mjs` (copy) asserts the
  measured floor so a later change cannot lower it silently.

## 5b. Add the settings plugin

`@dsh-bridge/agent-settings` gives the administrators one screen for the models, the knowledge documents (upload, approval,
search method) and the SNS approvals and reports. Copy the wiring of the reference (`src/app.mjs`, search `createAgentSettings`):

1. Before `createBridgeApp`: `const agent = createAgentSettings({ dataDir, env, fetch, now, log, vectorDb })`, then
   `hooks.approvals = agent.approvals(hooks.approvals)` and `hooks.recipientsFor = agent.recipientsFor(hooks.recipientsFor)`
   (the documents' approvals and the `knowledge.updated` report first, everything else to the system's own hooks).
2. After it: `await agent.register(bridge, { baseDocuments, buildIndex, webBase, knowledgeOptions, screen })` and
   `registerKnowledge(bridge, agent.knowledge)` — the plugin builds the knowledge service; do not create your own.
   `knowledgeOptions` is the ONE options object (synonyms …) that `evals/run.mjs` uses too.
3. Manifest: entity `knowledge_document` (`link: "/handbook/{id}"`), event `knowledge.updated` (aggregate `knowledge_document`,
   payload `[buildId, documents, chunks, rejected, failed]`, `notify: { template: knowledge.updated }`), the template with four
   integer params, and `/agent-settings` in `web.routes`. Copy them from the reference manifest.
4. `dataDir` holds settings and uploaded documents: git-ignore it. Keys: environment variable NAMES; a key typed on the screen
   is stored only with `AGENT_SETTINGS_KEY`. pgvector: pass the system's own pg pool as `vectorDb`, or set
   `AGENT_VECTOR_DB_URL` — never a connection string in a file in git.
5. The screens: `/agent-settings` (administrators: overview, models, knowledge, SNS) and `/me/sns` (every employee: their own SNS
   links, link code, notifications). Add both to `web.routes`. The app is prebuilt in the plugin's `dist/`; rebuild only when you
   change `packages/agent-settings/web/` (`npm run build -w @dsh-bridge/agent-settings`, needs the framework checkout).
6. The SNS page's IM bots are dsh-im's own settings screens through a **DSH gateway** (`@dsh-bridge/gateway`, mounted at `/dsh`,
   `isAllowed` = administrators, `getSessionUser` = your own session): wrap your handler with `gateway.handleRequest` and pass
   `gateway: { rpcBase: '/dsh/api/dsh-im' }` to `register`. Copy the reference's `dsh` option. Without it the page says DSH is
   not connected (everything else works).
   No sign-in screen of your own yet? Serve `signInPage(...)` at `/login` and call `redirectToSignIn(req, res, { authenticate })`
   first in your handler (copy the reference). It posts to YOUR login API; a system with its own sign-in screen keeps it.
7. Approvals need a second person: the uploader never approves. With one administrator, managers must be approver roles
   (`sns.approverRoles`), or nobody can publish — write that down as a "to confirm" decision.

## 6. Verify — the definition of done

Run each and report the command with a summary of its output. Write "not verified" for anything you did not run.

| check | how |
|---|---|
| manifest | `npx bridge-validate manifest bridge.manifest.yaml --strict` → `ok` |
| conformance | `test/conformance.test.mjs` + `test/fixtures.mjs` adapted → `# conformance: 52 / 52 checks passed` |
| business rules | `test/app.test.mjs` adapted: requests, approvals (not the requester), the waiting scan, proposals, reports. **Conformance does not prove your business rules**: letting the requester decide their own approval still passes 52 / 52; only these tests catch it. Break each rule once on purpose and see a test fail |
| knowledge permission property | every role × web and delegation × every generated question: each result readable by the asker |
| no side channel | an employee's results and scores equal those from an index that never had the hidden sections |
| K-01…K-08, G-01…G-07 | `runKnowledgeChecks`, `runGraphChecks` (the second run with the tool for managers only, so K-08 / G-07 run). The knowledge probe works **per document**: the denied askers must not get ANY chunk of it, so pick a document they may not read at all (a managers-only handbook, an admin runbook); a document with public sections cannot be the probe. If every document has public sections, add a small fully restricted one |
| why e2e | the bridge-graph tool through dsh-core `guardTool` with real delegations: the decider, the requester, another employee (`found: false`) |
| plugin e2e | the bridge-knowledge tool the same way; delegation × role refused with 403 |
| evals | `npm run evals` meets the floor; `test/evals.test.mjs` passes |
| settings plugin | `test/agent-settings.test.mjs` (copy): admins only and no delegation; upload → approval card for another person (never the uploader) → published → found by its roles only → `knowledge.updated` to the report roles; other events still reach the system's own `recipientsFor` |
| whole repo | `npm test` at the repository root |

## 7. Rules

- **Never** real personal data (documents, tests, fixtures, eval questions). **Never** secrets in git, logs or chat.
- Do not change `packages/*` or `plugins/*` to make your system pass; if something is missing there, write it in the report.
- The AI only reads and proposes. No write endpoint accepts a delegation.
- Permissions come first in every search and every graph answer; a test that proves it is part of done, not an extra.
- Report honestly: the numbers of the first eval run, what you tuned, what failed, what you assumed ("to confirm").

## 8. Finishing

Write `examples/<system-id>/README.md`: what the system does, the roles and documents, the decisions marked "to confirm",
the eval numbers (first run and final), the test count, and the AI plane configuration:

```yaml
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    toolModules:
      - { module: '@dsh-bridge/plugin-knowledge', application: <system-id> }
      - { module: '@dsh-bridge/plugin-graph', application: <system-id> }
```

and the citation guard through the plugin-knowledge bundle (`dsh.profile.bundles` after `@dsh-bridge/plugin-identity`; see
`plugins/knowledge/README.md` and `e2e/run.mjs`).
