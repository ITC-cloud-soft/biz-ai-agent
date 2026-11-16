---
name: agent-builder
description: >-
  Builds a complete AI agent (an "AI employee" that works in SNS such as LINE, Slack and Teams) from a business need with the
  biz-ai-agent framework, which contains the whole Biz Assistant Framework (@dsh-bridge/*: Bridge v1, server-kit, DSH core and
  plugins, dsh-im for 13 SNS, web-kit, profile) plus the agent layer (permission-aware knowledge, the "why did this reach me?"
  graph, the agent-settings plugin with its screens). The result is an ordinary IT system first (manifest, hooks, outbox,
  approvals, conformance 52 / 52), then its knowledge, graph, evals, settings screens, SNS approvals and reports, and the DSH
  profile of its AI plane — all in git, all verified by commands. Use it for requests such as "build an agent for X", "make an
  AI assistant for our <business>", "an agent that answers from our documents with each employee's rights", "add knowledge /
  RAG to a Bridge system", "add a graph / why-explanations", "write evals for an agent", "make a new example system with
  knowledge", "set up the agent's SNS approvals / settings screen". For connecting an EXISTING system's Bridge part it uses
  the biz-assistant-integration skill in this repository and comes back here for everything after it.
---

# Building an AI agent with biz-ai-agent

An agent here is **an ordinary business system plus ordinary plugin configuration, all in git** — not a flow drawn in an
editor. The business system is the system of record: it owns the data, the roles, who sees what and who decides. The AI
employee reads (with the asking employee's own delegation) and proposes; people decide, in the web app or on a chat card.

What you produce, and when each part is done:

| part | what it is | done when |
|---|---|---|
| plan | `examples/<system-id>/AGENT_PLAN.md`: the decisions, their status, the evidence | every decision is "decided by …" or "to confirm" |
| IT system | a server-kit app: data, login, hooks, `/api/*`, events in the transaction (outbox), approvals, reports | business tests pass; **conformance 52 / 52** (no skip, no known gap) |
| ontology | `bridge.manifest.yaml`: roles, entities (screen links), events, audience rules, tools, playbooks (off), reports, templates, glossary | `bridge-validate manifest --strict` prints `ok` |
| knowledge | `knowledge/*.md` with per-section visibility, `GET /bridge/v1/knowledge/search`, the handbook screen | the permission property, no side channel, K-01…K-08 |
| graph | `canRead` + `neighbors`, `GET /bridge/v1/graph/neighbors` | G-01…G-07, the "why did this reach me?" test |
| evals | `evals/knowledge.evals.json`: fixed questions, askers, expected and forbidden sources | written BEFORE tuning; ≥ 80 % hit@3 per language, 0 leaks, a floor test |
| settings | `@dsh-bridge/agent-settings`: `/agent-settings` (admins), `/me/sns` (every employee), `/login`, document approvals and reports over SNS, the DSH gateway | its tests: admins only, the uploader never approves, found by roles only, the report |
| AI plane | `examples/<system-id>/dsh-profile/`: the product profile (bridge-apps, toolModules for knowledge and graph, the citation guard, linkGuard, closed outbound settings) | `profile/scripts/check.mjs` passes; the plugin tests through dsh-core `guardTool` pass |

## Where things are — this repository IS the framework

| what | where |
|---|---|
| **reference implementation (copy it)** | `examples/leave-requests-knowledge` — one-file app (`src/app.mjs`) with every part above; `examples/equipment-loans` — built from scratch with this skill |
| framework packages (synced copies) | `packages/{protocol,server-kit,dsh-core,gateway,web-kit,help,telemetry,testing}`, `plugins/{identity,tools,events,notify,approvals,assistant,memory,persona,reader}`, `profile/`, `vendor/{dsh-im,dsh-auto-tasks,dsh-proactive}` |
| agent layer | `packages/{knowledge,graph,agent-settings}`, `plugins/{knowledge,graph}` |
| framework rules | `docs/GUIDELINE.en.md` (also `.md` ja, `.zh-CN.md` zh), `docs/ARCHITECTURE.md`, `skills/biz-assistant-integration/` (cited below as *integration skill*) |
| agent-layer interfaces | `docs/KNOWLEDGE_API.md`, `docs/GRAPH_API.md`, `docs/AGENT_SETTINGS.md`, `packages/*/README.md` |
| human manual | `docs/MANUAL.md` (Chinese) |

Facts that differ from the integration skill and the GUIDELINE (they were written for the framework's own repository):

- **Do not clone the framework and do not use pnpm.** It is already here (`framework.sync.json` names the commit). This
  repository uses **npm workspaces**: `npm install` at the root; every `@dsh-bridge/*` resolves to the copy in this repository.
- The framework parts are **copies**: never edit `packages/{protocol,server-kit,dsh-core,gateway,web-kit,help,telemetry,testing}`,
  the framework plugins, `profile/` or `vendor/` here (a later `npm run sync-framework` overwrites them), and do not edit the agent
  layer packages to make your system pass either. If something is missing, write it in the report.
- Put the new system in `examples/<system-id>/` (package name `@biz-ai-agent/example-<system-id>`); the root `package.json`
  already lists `examples/*` as workspaces.

Words used below: **`<ns>`** is the application's namespace — the prefix of every manifest tool name (`leave_...`, `loan_...`)
and the `namespace` of the application in bridge-apps; the plugins name their tools `<ns>_knowledge_search` and `<ns>_graph_why`.
**`<system-id>`** is the manifest's `system.id` (= the DSH application id).

## 0. Baseline — before you write anything

```sh
git log -1 --format='%h %cs'          # record it in the plan
npm install
npm run vendor:install                # once: the vendor forks' own dependencies
npm test                              # record the counts: 0 fail is the starting point
```

If the baseline fails, stop and report it; do not start building on a red repository. Then copy
`skills/agent-builder/templates/agent-plan.md` to `examples/<system-id>/AGENT_PLAN.md` and keep it current at every step.
Read the reference's `src/app.mjs`, `bridge.manifest.yaml`, `knowledge/`, `evals/` and `test/` before you write code.

## 1. Ask first — and write down what you did not ask

These are decisions for people, not for you. Write the options and your recommendation in the plan and wait. When nobody can be
asked (an unattended run), take the recommended default, mark it **"to confirm"**, and go on.

1. **Who the agent works for and what it may do**: which roles talk to it; what it reads (each tool and its roles); what it may
   propose; who decides each proposal and approval. Default: read + propose for every role, writes by people only.
2. **Documents**: who owns them; which sections are for which roles or for one employee (`users`). Default: the narrowest
   reasonable audience; never "everyone" by default (the build refuses a document without visibility).
3. **What a correct answer is**: the evals' expected sources are a business decision. Default: you draft them, marked "to
   confirm by the document owners".
4. **Models**: none — BM25F. Never pick a model, an endpoint or a key yourself; the settings screen takes them later.
5. **SNS**: which events notify whom (the system's `recipientsFor`), who approves documents (`sns.approverRoles`, default the
   admin roles) and who gets the knowledge reports (`sns.reportRoles`). With ONE administrator, the uploader can never approve:
   make managers approvers or nobody can publish — a "to confirm" decision.
6. **Languages** served (one document per language, ≥ 20 eval questions per language).

## 2. Build the IT system

- **Existing system** → follow the *integration skill* for the Bridge part (its assessment, paths and rules apply; its
  "clone + pnpm" step does not, see above). Then continue here at step 4.
- **New system** → start from the reference:
  1. Copy `examples/leave-requests-knowledge` to `examples/<system-id>/`; rename the package; `npm install` at the root.
  2. Replace the business: the data maps, the state changes (`kit.tx` + `kit.emitEvent` **in the same transaction**), the
     approval rule (`mayDecide`: ONE function used by the web route AND the chat card; never the requester), the scheduled scan
     that emits the "waiting too long" event, the `/api/*` routes.
  3. Keep the hooks' shape: `employees` (with `active`), `authenticate`, `isSessionLive`, `recipientsFor` (who is told — the
     system decides, IDs and typed params only, and each person is checked with the same rule as the web screen), `approvals`
     (get / approvers / card / mayDecide / decide), `proposalKinds` (validate + apply), `reports.compute` (counts, scoped by
     role), `piiScan` (names from the roster; return kinds only).
  4. AI reads use `kit.readToolPolicy('<METHOD> <path>', roles)`; every write is `{ allow: ['user'] }` (people only).
  5. Rename everything (cookie name, token prefixes, labels). **Fictional data only** — no real names, addresses, phone numbers
     or e-mails, in documents and tests too. In the copied tests rename as well: the factory name and the `globalThis.__<app>`
     handle in `conformance.test.mjs` / `fixtures.mjs`, the test service token and BFF secret, the application id and `<ns>` in
     the plugin and graph tests, and every hard-coded chunk id, document count, case count and eval floor.
  6. A time-based event ("waiting too long", "overdue"): the conformance fixtures must make it happen without waiting. Give the
     scan a parameter (the pilot's `minDays`) or move the object's dates back on the running instance from the fixtures
     (`examples/equipment-loans/test/fixtures.mjs`); time passes on the instance, never through the API.
  7. `@dsh-bridge/dsh-core` is a devDependency (the plugin and graph tests import it); `@dsh-bridge/agent-settings` and
     `@dsh-bridge/gateway` are dependencies. Copy the reference's `package.json` and adapt it.
- Run the business tests and conformance now (`npm test -w @biz-ai-agent/example-<system-id>`) and fix before going on.

## 3. Write the ontology (manifest)

Start from the reference manifest; keep its style:

- `system` (`id` = `<system-id>`), `web.routes` (every screen a source or a notification may link to, including
  `/handbook/:docId`, `/agent-settings`, `/me/sns`), `roles` (label, scope, `delegation: none | read | propose`), `entities`
  (each with `pii` and, when it has a screen, `link: "/<things>/{id}"` — the graph builds screen links from it),
  `audienceRules` (`includes: [author]` when the requester is told too).
- `events`: the three framework events (`approval.requested`, `approval.decided`, `sns_identity.unlinked`), `knowledge.updated`
  (for the settings plugin, copy it with its template) and your business events. Payloads are IDs, dates, counts and states
  only; give each notifying event a `label` and a `description` (the employee's notification settings show them).
- `tools`: one read tool per `/api/*` GET the AI may call, **plus** `<ns>_knowledge_search` (`GET /bridge/v1/knowledge/search`,
  input `{ question, limit }`) and `<ns>_graph_neighbors` (`GET /bridge/v1/graph/neighbors`, input `{ entity, id }`), and the
  propose tool(s). Roles per tool = what step 1 decided.
- `playbooks`: `enabled: false`, `approval: none` or stricter, instructions that only check and report.
- `npx bridge-validate manifest bridge.manifest.yaml --strict` (from `examples/<system-id>`) must print `ok`.

## 4. Connect knowledge

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
   One document per language you serve; each language needs enough sections for its evals. Include at least one document
   that some role may not read **at all** (the knowledge conformance probe needs it, see step 9).
2. The settings plugin builds the knowledge service (step 7); you give it `baseDocuments` (`readKnowledgeDir`) and
   `buildIndex` (`buildKnowledgeIndex(docs, { roles: kit.declaredRoles, routes: kit.manifest.web.routes, screen })`) — copy the
   reference. Do not create a second knowledge service.
3. The handbook screen `GET /handbook/:docId` (people only) renders only the sections the employee may read and answers 404 for
   a hidden and a missing document alike (copy the reference).
4. The build fails on personal data (protocol shapes + roster names): fix the document, never switch the check off.

## 5. Connect the graph

`registerGraph(bridge, { canRead, neighbors })`:

- `canRead({ entity, id }, asker)` = **the same rule as the screen** (staff: their own objects; managers: all — whatever your
  web authorization says). Unknown entity → false.
- `neighbors({ entity, id }, asker)` = the object's direct relations: `{ relation, entity, id }` with `entity` a manifest entity,
  `employee` (an ID, never a name) or `role`. The route re-checks every entity neighbor with `canRead`; return only what exists.
- Use exactly the relation names `requested_by` (or `author`) / `assigned_to` / `required_role`, **even when the business word
  differs** (a borrower is `requested_by`): `explainReach` turns only these into the reasons "You made it", "It is assigned to
  you", "It waits for a decision by your role". Other relations (`subject`, `item`, `decided_by` …) are walked for their events
  but give no reason of their own.
- Reason kinds a test can expect (`packages/graph/src/explain.mjs`): `required_role`, `author`, `assignee`, `event_audience`,
  `related_event`, `audience_rule`, `playbook`, and `none`.

## 6. Write the evals — before tuning

- `evals/knowledge.evals.json` (copy the reference's shape): `askers` (fictional ids and roles) and `cases`
  `{ id, lang, asker, q, expect: ['<doc>#<anchor>'] | [], forbid?: [...] }`. **At least 20 per language**, written the way
  employees ask (not copied headings), including:
  - questions for each restricted section, asked by a role that may read it;
  - the same asked by a role that may not: `expect: [], forbid: ['<doc>#<restricted>']` (passes when the restricted section is
    not returned, even if a public section on the same topic is). Plain `expect: []` only when NO readable section is relevant;
  - 1–2 out-of-scope questions per language (`expect: []`).
- `evals/run.mjs` (copy) prints the report: `npm run evals`. **Record the FIRST run's numbers before you change anything.**
- **One options object.** Export the knowledge options (synonyms, fillers, stopWords …) from `src/app.mjs` and use the same object
  in the app (`knowledgeOptions` of `agent.register`) and in `evals/run.mjs`; otherwise the evals measure a configuration that
  does not run.
- Legitimate tuning: document keywords and headings (owners' wording); `synonyms` (`[[documentsWord, otherWord, ...], ...]`);
  `fillers` and `stopWords`. A question word missing for a whole language belongs in `packages/knowledge`: report it. Not
  legitimate: editing a case so it passes, or tuning a threshold on the eval set without saying so.
- Done: every language ≥ 80 % hit@3, **0 leaks**. `test/evals.test.mjs` (copy) asserts the measured floor.

## 7. Add the settings plugin, the screens and the SNS paths

Copy the wiring of the reference (`src/app.mjs`: search `createAgentSettings`, `createDshGateway`, `signInPage`,
`redirectToSignIn`):

1. **Before** `createBridgeApp`: `const agent = createAgentSettings({ dataDir, env, fetch, now, log, vectorDb })`, then
   `hooks.approvals = agent.approvals(hooks.approvals)` and `hooks.recipientsFor = agent.recipientsFor(hooks.recipientsFor)` (the
   documents' approvals and the `knowledge.updated` report first, everything else to your own hooks).
2. **After** it: `await agent.register(bridge, { baseDocuments, buildIndex, webBase, knowledgeOptions, screen, gateway })` and
   `registerKnowledge(bridge, agent.knowledge)`.
3. Manifest: entity `knowledge_document` (`link: "/handbook/{id}"`), event `knowledge.updated` (aggregate `knowledge_document`,
   payload `[buildId, documents, chunks, rejected, failed]`, `notify: { template: knowledge.updated }`) and its template (four
   integer params), routes `/agent-settings` and `/me/sns`. Copy them from the reference manifest.
4. **DSH gateway** (the SNS page shows dsh-im's own bot screens for the 13 SNS through it): an option `dsh: { target, launchToken }`
   → `createDshGateway({ target, mountPath: '/dsh', getSessionUser: async (req) => (await hooks.authenticate(req))?.user ?? null,
   isAllowed: (u) => <an admin role>, launchToken })`, and `gateway: { rpcBase: '/dsh/api/dsh-im' }` to `register`. Without DSH the page says so; everything
   else works.
5. **Sign-in**: no sign-in screen of your own yet → serve `signInPage(...)` at `GET /login` (it posts to YOUR login API). The
   handler order is `redirectToSignIn(req, res, { authenticate })` → `gateway.handleRequest` → `bridge.handler` (copy the
   reference's `handler`). A system with its own sign-in screen keeps it.
6. `dataDir` (settings, uploaded documents, vectors, graph JSON) is git-ignored. Keys are environment variable NAMES; a key typed on
   the screen is stored only with `AGENT_SETTINGS_KEY`. pgvector: the system's own pg pool as `vectorDb`, or
   `AGENT_VECTOR_DB_URL` — never a connection string in git.
7. The screens are prebuilt in `packages/agent-settings/dist/`; do not rebuild them for your system.

## 8. Write the AI plane (DSH product profile)

In `examples/<system-id>/dsh-profile/` (GUIDELINE b.5 and `profile/README.md`; `e2e/run.mjs` → `makeProductProfile()` does the
same for the pilot — read it):

1. Copy `profile/template/` there. Fill every `<placeholder>` of `cordis.patch.yml`; delete the template's example auto task.
2. `bridge-apps` → `applications`: `id: <system-id>`, `name`, `namespace: <ns>`, `paths: v1`, `apiUrlEnv`, `serviceTokenEnv`
   (variable NAMES), `manifestUrl: /bridge/v1/manifest`, `generateTools: true` (or `false` when hand-written tools would clash),
   `bots: []` until the owner creates the bots in dsh-im.
3. `bridge-tools` → `toolModules`: `{ module: '@dsh-bridge/plugin-knowledge', application: <system-id> }` and
   `{ module: '@dsh-bridge/plugin-graph', application: <system-id> }`. In `dsh-profile/package.json` add
   `@dsh-bridge/plugin-knowledge` (and `@dsh-bridge/plugin-graph`) as `file:` dependencies on this repository's `plugins/…`, and
   push `@dsh-bridge/plugin-knowledge` to `dsh.profile.bundles` (its bundle inserts the citation guard after bridge-identity).
4. `bridge-identity` → `linkGuard: { webUrl: <business web URL> }` (every application needs one).
5. **Keep the outbound settings at the template's closed values** (`forwardPluginSources: []`, `deliveryGuard: required`,
   `restrictDelivery: true`, `groupChat: deny`, `audienceFallback: none`, `audienceText: template` …). Opening one is an explicit
   opt-in: change that line and write the reason in a comment, and list it in the plan.
6. `node profile/scripts/check.mjs examples/<system-id>/dsh-profile/cordis.patch.yml` must pass. Installing it into a real DSH
   (`profile/scripts/install.mjs --home <isolated home> --framework-root <this repository>`) is a separate, optional step: run
   DSH only in an isolated home and on free loopback ports, never your personal `~/.dsh`, never production or demo ports.

## 9. Verify — the definition of done

Run each and report the command with a summary of its output. Write **"not verified"** for anything you did not run.

| check | how |
|---|---|
| manifest | `npx bridge-validate manifest bridge.manifest.yaml --strict` → `ok` |
| conformance | `test/conformance.test.mjs` + `test/fixtures.mjs` adapted → `# conformance: 52 / 52 checks passed` |
| business rules | `test/app.test.mjs` adapted: requests, approvals (not the requester), the waiting scan, proposals, reports. **Conformance does not prove your business rules**: letting the requester decide their own approval still passes 52 / 52; only these tests catch it. Break each rule once on purpose (back the file up first, restore it after) and see a test fail |
| knowledge permission property | every role × web and delegation × every generated question: each result readable by the asker |
| no side channel | an employee's results and scores equal those from an index that never had the hidden sections |
| K-01…K-08, G-01…G-07 | `runKnowledgeChecks`, `runGraphChecks` (a second run with the tool for managers only, so K-08 / G-07 run). The knowledge probe works **per document**: pick one the denied askers may not read at all |
| why e2e | the bridge-graph tool through dsh-core `guardTool` with real delegations: the decider, the requester, another employee (`found: false`) |
| plugin e2e | the bridge-knowledge tool the same way; delegation × role refused with 403 |
| evals | `npm run evals` meets the floor; `test/evals.test.mjs` passes |
| settings plugin | `test/agent-settings.test.mjs` (copy): admins only, no delegation; upload → approval card for another person (never the uploader) → published → found by its roles only → `knowledge.updated` to the report roles; `/me/sns` for every employee; `/login` and the sign-in redirect; other events still reach your own `recipientsFor` |
| AI plane profile | `node profile/scripts/check.mjs …/cordis.patch.yml` passes |
| whole repository | `npm test` at the root: 0 fail, and the counts = baseline + your tests |
| real DSH (optional) | `npm run e2e` still passes (the pilot); your system on a real DSH needs an adapted copy of `e2e/run.mjs` — otherwise "not verified" |

## 10. Rules

- **Never** real personal data (documents, tests, fixtures, eval questions). **Never** secrets in git, logs or chat.
- Do not change the framework parts or the agent-layer packages to make your system pass; write what is missing in the report.
- The AI only reads and proposes. No write endpoint accepts a delegation. The AI never decides amounts.
- The business system decides who is told; each person is checked with the web screen's rule; when unsure, do not send.
- Permissions come first in every search and every graph answer; a test that proves it is part of done, not an extra.
- Outbound settings stay closed unless the plan records an explicit opt-in.
- Report honestly: the first eval run's numbers, what you tuned, what failed, what you assumed ("to confirm").

## 11. Pitfalls seen in earlier builds

- A conformance knowledge probe on a document with public sections never fails — use a fully restricted document.
- Relation names other than `requested_by` / `assigned_to` / `required_role` give no "why" reason.
- The app and the evals using different knowledge options: the evals then measure a configuration that does not run.
- Copied tests that still carry the reference's ids, counts or eval floor: they pass for the wrong reason or fail for no reason.
- Only one administrator: nobody can approve their documents. Decide approver roles in step 1.
- A time-based event the fixtures cannot trigger: the conformance checks that need it cannot run — and 52 / 52 allows no skip.
- Hand-written tools with the same names as generated ones: set `generateTools: false` or rename.

## 12. Finishing

Write `examples/<system-id>/README.md`: what the system does, the roles and documents, the decisions marked "to confirm", the eval
numbers (first run and final), the test counts, how to start it (`node src/server.mjs`, the dev seed password variable), and the
AI plane (`dsh-profile/`). Update `AGENT_PLAN.md` with the evidence of every part. Report: what was built, the commands and their
results, what is "not verified", and the decisions still to confirm.
