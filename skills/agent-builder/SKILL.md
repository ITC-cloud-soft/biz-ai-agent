---
name: agent-builder
description: >-
  Builds a complete AI agent (an AI employee on LINE, Slack, Teams and other SNS) with the biz-ai-agent framework: the business
  system and its manifest (Bridge v1, conformance 52 / 52), permission-aware knowledge, the "why did this reach me?" graph,
  evals, the settings screens and SNS approvals, and the DSH profile, all in git and verified by commands. Use it for "build
  an agent for X", "make an AI assistant for our <business>", "an agent that answers from our documents with each employee's
  rights", "add knowledge / RAG / a graph / evals to a Bridge system". For an EXISTING system's Bridge part it uses the
  biz-assistant-integration skill in this repository and comes back here after it.
---

# Building an AI agent with biz-ai-agent

An agent here is **an ordinary business system plus ordinary plugin configuration, all in git** — not a flow drawn in an
editor. The business system is the system of record: it owns the data, the roles, who sees what and who decides. The AI
employee reads (with the asking employee's own delegation) and proposes; people decide, in the web app or on a chat card.

What you produce, and when each part is done:

| part | what it is | done when |
|---|---|---|
| plan | `examples/<system-id>/AGENT_PLAN.md`: the decisions, their status, the evidence | every decision is "decided by …" or "to confirm" |
| IT system + ontology | a server-kit app (data, login, hooks, `/api/*`, events in the transaction, approvals, proposals, reports) and its `bridge.manifest.yaml` | `bridge-validate manifest --strict` prints `ok`; business tests pass; **conformance 52 / 52** (no skip, no known gap) |
| knowledge | `knowledge/*.md` with per-section visibility, `GET /bridge/v1/knowledge/search`, the handbook screen | the permission property, no side channel, K-01…K-08 |
| graph | `canRead` + `neighbors`, `GET /bridge/v1/graph/neighbors` | G-01…G-07, the "why did this reach me?" test |
| evals | `evals/knowledge.evals.json`: fixed questions, askers, expected and forbidden sources | written BEFORE tuning; ≥ 80 % hit@3 per language, 0 leaks, a floor test |
| settings | `@dsh-bridge/agent-settings`: `/agent-settings` (admins), `/me/sns` (every employee), `/login`, document approvals and reports over SNS, the DSH gateway | its tests: admins only, the uploader never approves, found by roles only, the report |
| AI plane | `examples/<system-id>/dsh-profile/`: the product profile (bridge-apps, the knowledge and graph tool modules, the citation guard, linkGuard, closed outbound settings) | `profile/scripts/check.mjs` passes; the tool modules' tests through dsh-core `guardTool` pass |

## Where things are — this repository IS the framework

| what | where |
|---|---|
| **reference implementations (copy them)** | `examples/leave-requests-knowledge` (the pilot: one-file app `src/app.mjs`, every part above) and `examples/equipment-loans` (built from scratch with this skill; **the better model for proposals and for the shared knowledge options**, see steps 2 and 6) |
| framework (synced copies, read-only here) | `packages/{protocol,server-kit,dsh-core,gateway,web-kit,help,telemetry,testing}`, `plugins/{identity,tools,events,notify,approvals,assistant,memory,persona,reader}`, `profile/`, `vendor/{dsh-im,dsh-auto-tasks,dsh-proactive}`, `examples/{care-billing,equipment-inspection,leave-requests}`, `skills/biz-assistant-integration/`, `docs/GUIDELINE*.md`, `docs/ARCHITECTURE.md` and the other framework documents (`scripts/sync-framework.mjs` lists them) |
| agent layer (this repository's own) | `packages/{knowledge,graph,agent-settings}`, `plugins/{knowledge,graph}` |
| framework rules | `docs/GUIDELINE.en.md` (ja: `GUIDELINE.md`, zh: `GUIDELINE.zh-CN.md`), `docs/ARCHITECTURE.md`, `skills/biz-assistant-integration/` (cited below as *integration skill*) |
| agent-layer interfaces | `docs/KNOWLEDGE_API.md`, `docs/GRAPH_API.md`, `packages/*/README.md`, `plugins/*/README.md` (the settings plugin's current interface is `packages/agent-settings/README.md`; `docs/AGENT_SETTINGS.md` is its first, v0.1 design) |
| human manual | `docs/MANUAL.md` (Chinese) |

Facts that differ from the integration skill and the GUIDELINE (they were written for the framework's own repository):

- **Do not clone the framework.** It is already here (`framework.sync.json` names the commit). This repository's workspaces use
  **npm**: `npm install` at the root; every `@dsh-bridge/*` resolves to the copy in this repository. Node.js 22.19+ is enough for
  `npm install` / `npm test`; anything that runs the DSH CLI (`npm run e2e`, `profile/scripts/install.mjs` in step 7) needs
  **Node.js 24.9+** (the pinned `@deepseek-ai/dsh` requires it) and **pnpm on PATH** (DSH installs the profile's plugins with it).
- **Never edit the framework copies** (the second row above): a later `npm run sync-framework` overwrites them. Do not edit the
  agent-layer packages to make your system pass either. If something is missing, write it in the report.
- Put the new system in `examples/<system-id>/` (package name `@biz-ai-agent/example-<system-id>`); the root `package.json`
  lists `examples/*` as workspaces. Choose a `<system-id>` the framework does not use.

Words used below: **`<ns>`** is the application's namespace — the prefix of every manifest tool name (`leave_...`, `loan_...`)
and the `namespace` of the application in bridge-apps; the plugins name their tools `<ns>_knowledge_search` and `<ns>_graph_why`.
**`<system-id>`** is the manifest's `system.id` (= the DSH application id). "From the example" means with
`examples/<system-id>` as the working directory.

## 0. Baseline — before you write anything

```sh
git log -1 --format='%h %cs'          # record it in the plan
npm install
npm run vendor:install                # once: the vendor forks' own dependencies
npm test                              # record the counts: 0 fail is the starting point
```

If the baseline fails, stop and report it; do not build on a red repository. On Windows, failures in
`packages/protocol/test/readme.test.mjs` or `profile/scripts/*.test.mjs` mean the checkout has CRLF line endings: the repository's
`.gitattributes` forces LF, so clone again (or, in a clean clone, `git rm --cached -r -q . && git reset --hard`); check with
`git ls-files --eol`. `npm install` may mark a few framework bin files as modified (file mode): never commit them — commit only
`examples/<system-id>/` and the root `package-lock.json`.

Read both references' `src/app.mjs`, `bridge.manifest.yaml`, `knowledge/`, `evals/` and `test/` before you write code. Write the
step-1 decisions down now; they go into `examples/<system-id>/AGENT_PLAN.md` (from `skills/agent-builder/templates/agent-plan.md`)
as soon as step 2 creates the directory. Keep the plan current.

## 1. Ask first — and write down what you did not ask

These are decisions for people, not for you. Write the options and your recommendation in the plan and wait. When nobody can be
asked (an unattended run), take the recommended default, mark it **"to confirm"**, and go on.

1. **Who the agent works for and what it may do**: which roles talk to it; what it reads (each tool and its roles); what it may
   propose; who decides each proposal and approval. Default: read + propose for every role, writes by people only.
2. **Documents**: who owns them; which sections are for which roles or for one employee (`users`). Default: the narrowest
   reasonable audience; never "everyone" by default (the build refuses a document without visibility).
3. **What a correct answer is**: the evals' expected sources are a business decision. Default: you draft them, marked "to
   confirm by the document owners".
4. **Models**: none — BM25F. Never pick a model, an endpoint or a key yourself; administrators set them on the settings screen.
5. **SNS**: which events notify whom (your `recipientsFor`), who approves uploaded documents and who gets the knowledge reports.
   The plugin's default for both is its `adminRoles` option (default `['admin']`); administrators change them later on the
   `/agent-settings` SNS page (`sns.approverRoles`, `sns.reportRoles`, stored in the git-ignored data directory, not in code).
   With ONE administrator, the uploader can never approve: managers must become approvers on that page or nobody can publish —
   a "to confirm" decision.
6. **Languages** served (one document per language, ≥ 20 eval questions per language).

## 2. Build the IT system and its manifest — together

The manifest is part of the IT system: `kit.readToolPolicy` and conformance read it (without a manifest tool for a route, no role
may use it through delegation). So write the business code and the manifest in the same step.

- **Existing system** → follow the *integration skill* for the Bridge part (its assessment, paths and rules apply; its
  "clone + pnpm" step does not, see above). Then continue here at step 3.
- **New system** → start from the pilot:
  1. Copy `examples/leave-requests-knowledge` to `examples/<system-id>/`; rename the package; `npm install` at the root.
  2. **Trim the copied `test` script** in `package.json` to `test/app.test.mjs test/conformance.test.mjs` for now: the other
     test files assert the pilot's documents, counts and eval floor. Add each one back when its step is done (3 knowledge +
     plugin, 4 graph, 5 evals, 6 agent-settings). Delete `test/pgvector.test.mjs` unless you keep pgvector tests (it needs the
     `@electric-sql/pglite` devDependency).
  3. Replace the business: the data maps, the state changes (`kit.tx` + `kit.emitEvent` **in the same transaction**), the
     approval rule (`mayDecide`: ONE function used by the web route AND the chat card; never the requester), the scheduled scan
     that emits the "waiting too long" event, the `/api/*` routes, the proposal kinds (`proposalKinds`: validate + apply; see
     `examples/equipment-loans/src/app.mjs` and its test `test/app.test.mjs`).
  4. Keep the hooks' shape: `employees` (with `active`), `authenticate`, `isSessionLive`, `recipientsFor` (who is told — the
     system decides, IDs and typed params only, each person checked with the same rule as the web screen), `approvals`
     (get / approvers / card / mayDecide / decide), `proposalKinds`, `reports.compute` (counts, scoped by role), `piiScan` (names
     from the roster; return kinds only).
  5. AI reads use `kit.readToolPolicy('<METHOD> <path>', roles)` — the first argument must be exactly the manifest tool's `http`
     string (it is the allow-list key); every write is `{ allow: ['user'] }` (people only).
  6. Rename everything (cookie name, token prefixes, labels). **Fictional data only** — no real names, addresses, phone numbers
     or e-mails, in documents and tests too. In the copied tests (all of `test/`, including `helpers.mjs`, which every test
     imports: its `SERVICE`, `BFF` and `manifestWithKnowledgeRoles`) rename: the factory name and the `globalThis.__<app>` handle
     in `conformance.test.mjs` / `fixtures.mjs`, the test service token and BFF secret, the application id and `<ns>`, and every
     hard-coded chunk id, document count, case count and eval floor.
  7. **The conformance fixtures' contracts** (`packages/protocol/conformance/fixtures.example.mjs` documents every hook; the
     checks are in `packages/protocol/conformance/checks/`). Design the business so they can be met:
     - Approvals A1–A4 decide with a FRESH employee of the approval's `approverRole`, and notifications N1–N3 create a FRESH manager
       and expect that person among the recipients. A **person-specific** approver ("the requester's own manager") passes only
       if `createPendingApproval` returns an approval any holder of its role may decide (e.g. one that needs an administrator) and
       `emitNotifiableEvent({ employee })` creates a requester who reports to that fresh manager.
     - Proposals PR1–PR3: PR3 needs `proposalForbiddenSample`, a proposal kind some role may NOT propose. With a single kind open
       to every role, 52 / 52 is impossible: decide a second, role-restricted kind in step 1 (mark it "to confirm").
  8. **Proposals are reviewed by role.** server-kit lets the roles in `roles.proposalReviewers` accept or reject proposals
     (`GET /bridge/v1/proposals` lists them all to those roles); there is no per-person reviewer. When the business wants one
     person to accept ("the claimant accepts the AI's correction"), keep the reviewers a role that may see every object, make
     `apply` re-check the person, write the owner's own decision as a normal business route through your domain functions (not
     through the store's internal methods), and report the framework gap in the plan.
  9. A time-based event ("waiting too long", "overdue"): the conformance fixtures must make it happen without waiting. Give the
     scan a parameter (the pilot's `minDays`) or move the object's dates back on the running instance from the fixtures
     (`examples/equipment-loans/test/fixtures.mjs`); time passes on the instance, never through the API.
  10. Dependencies: copy the pilot's `package.json` (`@dsh-bridge/knowledge`, `graph`, `agent-settings`, `gateway`, `server-kit`,
     `protocol`, `help`; devDependencies `@dsh-bridge/dsh-core`, `plugin-knowledge`, `plugin-graph` — the tool-module tests use
     them).
- The manifest (start from the pilot's; keep its style):
  - `bridge: 1`, `system` (`id` = `<system-id>`, `timezone` — quiet hours use it, UTC when missing), `web.routes` (every screen a source or a notification may link to, including
    `/handbook/:docId`, `/agent-settings`, `/me/sns`), `roles` (label, `scope: all | assigned | own` — a manager who sees a team
    is `assigned`, `delegation: none | read | propose`).
  - Approvals in levels ("up to X by the manager, above X by an administrator"): each approval carries its own `approverRole`
    (and, for a named approver, an `assigned_to` relation in the graph); the references have one level only.
  - `entities`: your business entities (each with `pii` and, when it has a screen, `link: "/<things>/{id}"` — the graph builds
    screen links from it; `pii` is `none | personal | financial | sensitive | health` — amounts are `financial`, free-text notes at
    least `personal`) **plus the framework's**: `approval`, `proposal`, `sns_identity` (`pii: personal`) and, for the settings
    plugin, `knowledge_document` (`link: "/handbook/{id}"`). Copy them.
  - `events`: the three framework events (`approval.requested`, `approval.decided`, `sns_identity.unlinked`), `knowledge.updated`
    (aggregate `knowledge_document`, payload `[buildId, documents, chunks, rejected, failed]`, `notify: { template:
    knowledge.updated }`, with its template of four integer params) and your business events. Payloads are IDs, dates, counts
    and states only (never an amount, a name or a note); give each notifying event a `label` and a `description` (the employee's
    notification settings show them). `audienceRules` with `includes: [author]` when the requester is told too.
  - `tools`: one read tool per `/api/*` GET the AI may call, **plus** `<ns>_knowledge_search` (`GET /bridge/v1/knowledge/search`,
    input `{ question, limit }`) and `<ns>_graph_neighbors` (`GET /bridge/v1/graph/neighbors`, input `{ entity, id }`), and the
    propose tool(s). Roles per tool = what step 1 decided.
  - `playbooks`: `enabled: false`, `approval: none` or stricter, instructions that only check and report. `reports`, `glossary`.
  - From the example: `npx bridge-validate manifest bridge.manifest.yaml --strict` must print `ok`.
- From the example: `node --test --test-concurrency=1 test/app.test.mjs test/conformance.test.mjs` passes, with
  `# conformance: 52 / 52 checks passed`, before you go on.

## 3. Connect knowledge

1. Documents in `knowledge/*.md` (format: `packages/knowledge/README.md`). **No comments on the front matter lines and nothing
   after `{…}` on a heading line.** A comment after a front matter value becomes part of the value (the build then fails on the
   id or the roles); text after a heading's `{…}` makes the `{…}` unrecognised, so it becomes heading text and the section
   **silently** loses its restriction (it gets the whole document's audience). A complete document:
   ```markdown
   ---
   id: lending-rules
   title: Lending rules
   link: /handbook/lending-rules
   roles: [admin, manager, staff]
   keywords: [loan, borrow, return]
   ---
   Introduction (fictional company).

   ## Returning equipment {#returning}

   Text everyone in the document's roles may read.

   ## Approval limits {#approval-limits roles=admin,manager}

   Text only administrators and managers may read.
   ```
   - `id` (and a section's `#anchor`): `^[a-z0-9][a-z0-9-]{0,62}$`, unique. `link`: must match a `web.routes` entry. `roles`
     and/or `users: [<employee id>]`. Only `##` and `###` headings start a section; files whose name starts with `_` are skipped.
   - A section's `roles=` / `users=` may only **narrow** the document's visibility.
   - One document per language you serve; each language needs enough sections for its evals. Include at least one document some
     role may not read **at all** (the knowledge conformance probe needs it, step 8).
2. The settings plugin builds the knowledge service (step 6); you give it `baseDocuments` (`await readKnowledgeDir(dir)`) and
   `buildIndex` (`(docs, opts) => buildKnowledgeIndex(docs, { roles: kit.declaredRoles, routes: kit.manifest.web.routes, screen,
   ...opts })`), where `screen = bridgePiiScreen({ hooks, ctx: () => kit.ctx() })` — all three from `@dsh-bridge/knowledge`. Copy
   the pilot's code. Do not create a second knowledge service.
3. The handbook screen `GET /handbook/:docId` (people only) renders only the sections the employee may read and answers 404 for
   a hidden and a missing document alike (copy the pilot's). The settings plugin links uploaded documents to `/handbook/<id>` too.
4. Personal data: a chunk with personal data (protocol shapes + roster names) is **dropped and counted as `rejected`** when the
   running app builds the index (the plugin builds with `onPersonalData: 'skip'`); a direct `buildKnowledgeIndex` call in a test
   **fails** (the default). Keep `rejected` at 0 for your own documents (`GET /api/agent/knowledge/status` as an admin), keep the
   knowledge test that builds with the screen, and fix a document instead of switching the check off.
5. Add `test/knowledge.test.mjs` and `test/plugin.test.mjs` (copied, adapted) back to the `test` script.

## 4. Connect the graph

`registerGraph(bridge, { canRead, neighbors })` (`@dsh-bridge/graph`):

- `canRead({ entity, id }, asker)` = **the same rule as the screen** (staff: their own objects; managers: all — whatever your
  web authorization says). Unknown entity → false.
- `neighbors({ entity, id }, asker)` = the object's direct relations: `{ relation, entity, id }` with `entity` a manifest entity,
  `employee` (an ID, never a name) or `role`. The route re-checks every entity neighbor with `canRead`; return only what exists.
- Use exactly the relation names `requested_by` (or `author`) / `assigned_to` / `required_role`, **even when the business word
  differs** (a borrower, a claimant is `requested_by`): `explainReach` turns only these into the reasons "You made it", "It is
  assigned to you", "It waits for a decision by your role". Other relations (`subject`, `item`, `decided_by` …) are walked for
  their events but give no reason of their own.
- Reason kinds a test can expect (`packages/graph/src/explain.mjs`): `required_role`, `author`, `assignee`, `event_audience`,
  `related_event`, `audience_rule`, `playbook`, and `none`.
- Add `test/graph.test.mjs` (copied, adapted) back to the `test` script.

## 5. Write the evals — before tuning

- `evals/knowledge.evals.json` (copy a reference's shape): `askers` (fictional ids and roles) and `cases`
  `{ id, lang, asker, q, expect: ['<doc>#<anchor>'] | [], forbid?: [...] }`. **At least 20 per language**, written the way
  employees ask (not copied headings), including:
  - questions for each restricted section, asked by a role that may read it;
  - the same asked by a role that may not — the `forbid` form (no reference has one yet; it looks like this):
    `{ "id": "en-12", "lang": "en", "asker": "staff1", "q": "Up to what amount can a manager approve?", "expect": [], "forbid":
    ["expense-rules#approval-limits"] }`. It passes when the restricted section is not returned, even if a public section on the
    same topic is. Plain `expect: []` only when NO readable section is relevant;
  - 1–2 out-of-scope questions per language (`expect: []`).
- **One options object.** Export the knowledge options from `src/app.mjs` and use the same object in the app (`knowledgeOptions`
  of `agent.register`) and in `evals/run.mjs` — copy this from `examples/equipment-loans` (`KNOWLEDGE_SYNONYMS` in `src/app.mjs`,
  imported by `evals/run.mjs`), not from the pilot, whose `evals/run.mjs` has no shared options.
- Run from the example: `npm run evals` (or `npm run evals -w @biz-ai-agent/example-<system-id>` from the root). **Record the
  FIRST run's numbers before you change anything.**
- Legitimate tuning: document keywords and headings (owners' wording); `synonyms` (`[[documentsWord, otherWord, ...], ...]`,
  **single words only**, see `packages/knowledge/README.md` "Search options");
  `fillers` and `stopWords` — these **replace** the defaults, so extend them: `fillers: [...KNOWLEDGE_FILLERS, 'word']`,
  `stopWords: new Set([...STOP_WORDS, 'word'])` (both exported by `@dsh-bridge/knowledge`). A question word missing for a whole
  language belongs in `packages/knowledge`: report it. Not legitimate: editing a case so it passes, or tuning a threshold on the
  eval set without saying so.
- Done: every language ≥ 80 % hit@3, **0 leaks**. Add `test/evals.test.mjs` (copied) with the measured floor to the `test` script;
  the copied test also asserts the exact number of cases per language — set it to yours (and update it when you add cases).

## 6. Add the settings plugin, the screens and the SNS paths

Copy the wiring of the pilot (`src/app.mjs`: search `createAgentSettings`, `createDshGateway`, `signInPage`, `redirectToSignIn`):

1. **Before** `createBridgeApp`: `const agent = createAgentSettings({ dataDir, env, fetch, now, log, vectorDb, adminRoles })` (`dataDir` is required)
   (`adminRoles` defaults to `['admin']`: pass your administrator role names if they differ — only they reach `/agent-settings`,
   and they are the default approvers and report readers), then `hooks.approvals = agent.approvals(hooks.approvals)` and
   `hooks.recipientsFor = agent.recipientsFor(hooks.recipientsFor)` (the documents' approvals and the `knowledge.updated` report
   first, everything else to your own hooks).
2. **After** it: `await agent.register(bridge, { baseDocuments, buildIndex, webBase, knowledgeOptions, screen, gateway })` and
   `registerKnowledge(bridge, agent.knowledge)`.
3. **DSH gateway** (the SNS page shows dsh-im's own bot screens for the 13 SNS through it): an app option
   `dsh: { target, launchToken }` → `createDshGateway({ target, mountPath: '/dsh', getSessionUser: async (req) => (await
   hooks.authenticate(req))?.user ?? null, isAllowed: (u) => <u has an admin role>, launchToken })` and
   `gateway: { rpcBase: '/dsh/api/dsh-im' }` to `register` (an object with `rpcBase`, not the gateway itself). **`launchToken` is a
   function** returning DSH's launch token: in production `fromEnv` / `fromFile` / `supervise` from `@dsh-bridge/gateway`, or
   `gatewayOptionsFromEnv(env)` for the whole option set (`packages/gateway/README.md`); `fromValue(token)` is for tests only (the
   e2e uses it). IM webhooks (LINE, Teams …) reach DSH through the gateway's `publicPaths`. Without DSH the SNS page shows
   "DSH is not connected"; everything else works.
4. **Sign-in**: no sign-in screen of your own yet → serve `signInPage(...)` at `GET /login`. It posts `{ loginId, password }` as
   JSON to `endpoint` (default `/api/auth/login`): your login API must accept exactly that (or pass `endpoint`). The handler order
   is `redirectToSignIn(req, res, { authenticate, paths })` → `gateway.handleRequest` → `bridge.handler` (copy the pilot's
   `handler`). `paths` lists the screens a browser may open without a session: strings and RegExps — include the handbook
   (`/^\/handbook\/[a-z0-9-]+$/`, the knowledge sources link there) and your own screens. A system with its own sign-in screen
   keeps it.
5. `dataDir` (settings, uploaded documents, vectors, graph JSON) is git-ignored. Keys are environment variable NAMES; a key typed on
   the screen is stored only with `AGENT_SETTINGS_KEY`. pgvector: the system's own pg pool as `vectorDb`, or
   `AGENT_VECTOR_DB_URL` — never a connection string in git.
6. The screens are prebuilt in `packages/agent-settings/dist/`; do not rebuild them for your system.
7. Add `test/agent-settings.test.mjs` (copied, adapted) back to the `test` script. To test approvals with one administrator,
   change the approver roles the way an administrator would: `PUT /api/agent/settings` (see
   `examples/equipment-loans/test/agent-settings.test.mjs`).

## 7. Write the AI plane (DSH product profile)

There is **no ready-made product profile to copy**: `e2e/run.mjs` → `makeProductProfile()` generates one for the pilot at run time.
Write yours in `examples/<system-id>/dsh-profile/` (GUIDELINE b.5, `profile/README.md`, `plugins/knowledge/README.md`):

1. Copy `profile/template/` there. Fill every `<placeholder>` of `cordis.patch.yml` (`check.mjs` does not report the `<…>` inside
   the persona text after a full-width `：`, nor `proactive.config.json`'s `<namespace>`, step 5); delete the template's example auto
   task `auto-tasks/example-report-overdue.json`.
2. `bridge-apps` → `applications`: `id: <system-id>`, `name`, `namespace: <ns>`, `default: true`, `paths: v1`, `apiUrlEnv`,
   `serviceTokenEnv` (variable NAMES), `manifestUrl: /bridge/v1/manifest`, **`generateTools: false`** — the template says `true`, change
   it (bridge-apps would otherwise
   generate `<ns>_knowledge_search` from the manifest and clash with the knowledge tool module; with `false`, bridge-tools
   generates the manifest's read tools after the modules' tools and skips names already taken), `bots: []` until the owner
   creates the bots in dsh-im.
3. `bridge-tools` → `toolModules`:
   - `{ module: '@dsh-bridge/plugin-knowledge', application: <system-id> }`, with `"@dsh-bridge/plugin-knowledge":
     "file:{{FRAMEWORK_ROOT}}/plugins/knowledge"` in `dsh-profile/package.json` `dependencies` and `@dsh-bridge/plugin-knowledge`
     pushed to `dsh.profile.bundles` **after** `@dsh-bridge/plugin-identity` (its bundle inserts the citation guard
     `bridge-knowledge-guard`; a plain `cordis.patch.yml` entry is not enough).
   - The tool module and the citation guard **must load the same copy** of plugin-knowledge: they share the source ledger, and a
     guard on a second copy never sees the sources. The package name resolves to the copy installed in the profile (the template
     uses `nodeLinker: hoisted`), the one the guard loads; the e2e writes that copy's file URL explicitly
     (`<home>/profiles/<name>/node_modules/@dsh-bridge/plugin-knowledge/src/index.js`). The package-name form is not exercised by
     the e2e: say so in the report. Never point the module at this repository's `plugins/knowledge`.
   - `{ module: 'file:///<absolute path of this repository>/plugins/graph/src/index.js', application: <system-id> }` — the graph
     module by file URL, as the e2e loads it (it needs `@dsh-bridge/graph`, which is not published, so it is not a profile
     dependency).
4. `bridge-identity` → `linkGuard: { webUrl: <business web URL> }` (every application needs one; the template has `linkGuard`
   commented out — uncomment it).
5. `bridge-approvals` → `webUrl: <business web URL>/<your approval screen>?id={id}` (the template's default points at port 3010).
   The references have no approval web screen (they decide through `/api/*` and the chat card): if yours has none either, leave a
   "to confirm" comment. Also fill `proactive.config.json` (it has a `<namespace>` placeholder `check.mjs` does not report).
6. **Propose tools**: bridge-tools generates READ tools only. A manifest tool with `access: propose` reaches the AI only through a
   hand-written tool module (`kit.proposeTool(...)`; model: `plugins/tools/src/examples/equipment-inspection.js` and the README of
   `plugins/tools`). Write it in `examples/<system-id>/dsh-tools/` and add it to `toolModules`, or record "propose tools on DSH: not
   verified".
7. The AI employee preset's persona: add the text of `knowledgeRules('<ns>_knowledge_search')` (from
   `@dsh-bridge/plugin-knowledge`; print it once with node and paste it, YAML cannot call functions). A playbook's `agent` needs a
   preset of that id before the playbook is ever enabled.
8. **Keep the outbound settings at the template's closed values.** `check.mjs` requires all of them (`CLOSED_VALUES` in
   `profile/scripts/check.mjs`): xmanrui-dsh-im `forwardPluginSources: []`; dsh-proactive `modelTools: reclaim`,
   `deliveryGuard: required`; dsh-auto-tasks `restrictDelivery: true`, `mail: false`; bridge-identity `groupChat: deny` and its
   `messages.groupChat` guide; bridge-tools `groupChat: deny`; bridge-notify `audienceFallback: none`, `audienceText: template`,
   `proactiveDelivery: deny`, `aiReportGuard: screen`. Opening one is an explicit opt-in: change that line, write the reason in a
   comment, list it in the plan, and run `check.mjs` with `--allow <rule>[,<rule>…]` (the rule names are the keys of
   `OPEN_VALUES` in the same file).
9. From the repository root: `node profile/scripts/check.mjs examples/<system-id>/dsh-profile/cordis.patch.yml` must pass.
10. Do not copy the e2e-only settings of `makeProductProfile()` (`digestMinutes: 0`, `honorQuietHours: false`, the 1-second
   bridge-events polling, absolute paths to an e2e home).
11. Installing and starting a real DSH is a separate, optional step (`profile/README.md` "Starting"; Node.js 24.9+ and pnpm, see
   above): `node profile/scripts/install.mjs --source examples/<system-id>/dsh-profile --home <isolated home> --profile <name>
   --framework-root .`. It runs the DSH CLI: `dsh` on PATH, or `DSH_BIN=<path to @deepseek-ai/dsh/lib/bin.js>` (the pinned copy is
   `.dsh-cli/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js` after `npm run e2e`; `DSH_BIN` is a JavaScript file — start it as
   `node "$DSH_BIN" …`, not as `dsh`). Start DSH from `cd <home>` (it reads a `.env` in its cwd) with `DSH_HOME`,
   `DSH_AGENTS_HOME=<home>/agents`, `BRIDGE_DSH_WORKSPACE=<home>/workspace`, `<APP>_API_URL`, `<APP>_SERVICE_TOKEN`,
   `BRIDGE_WEB_PUBLIC_URL` and the model key variable, and `--profile <name> --no-open --host 127.0.0.1 --port <port> --public-url
   <web>/dsh/ --patch <overlay.yml>` (the overlay: settings screen → Models → "Conversation model of the AI employees (DSH)" → "Show YAML"). Only
   an isolated home and free loopback ports — never your personal `~/.dsh`, never production or demo ports.

## 8. Verify — the definition of done

Run each and report the command with a summary of its output. Write **"not verified"** for anything you did not run.

| check | how (from the example unless noted) |
|---|---|
| manifest | `npx bridge-validate manifest bridge.manifest.yaml --strict` → `ok` |
| conformance | `test/conformance.test.mjs` + `test/fixtures.mjs` adapted → `# conformance: 52 / 52 checks passed` |
| business rules | `test/app.test.mjs` adapted: requests, approvals (not the requester), the waiting scan, proposals (equipment-loans has a proposals test), reports. **Conformance does not prove your business rules**: letting the requester decide their own approval still passes 52 / 52; only these tests catch it. Break each rule once on purpose (back the file up, restore it after) and see a test fail — **on that rule's assertion**, not on an unrelated one (a payload with nothing else to change fails for the wrong reason) |
| knowledge | `test/knowledge.test.mjs`: the permission property (every role × web and delegation × every generated question: each result readable by the asker), no side channel (results and scores equal those of an index that never had the hidden sections), and `runKnowledgeChecks` from `@dsh-bridge/knowledge/conformance` (K-01…K-08; a second run with the tool for managers only via `manifestWithKnowledgeRoles`, so K-08 runs). The probe works **per document**: pick one the denied askers may not read at all |
| graph | `test/graph.test.mjs`: `runGraphChecks` from `@dsh-bridge/graph/conformance` (G-01…G-07) and the why test — the bridge-graph tool through dsh-core `guardTool` with real delegations: the decider, the requester, another employee (`found: false`) |
| tool modules | `test/plugin.test.mjs`: the bridge-knowledge tool the same way; delegation × role refused with 403 |
| evals | `npm run evals` meets the floor; `test/evals.test.mjs` passes |
| settings plugin | `test/agent-settings.test.mjs`: admins only, no delegation; upload → approval card for another person (never the uploader) → published → found by its roles only → `knowledge.updated` to the report roles; `/me/sns` for every employee; `/login` and the sign-in redirect; other events still reach your own `recipientsFor` |
| AI plane profile | from the root: `node profile/scripts/check.mjs examples/<system-id>/dsh-profile/cordis.patch.yml` passes |
| whole repository | from the root: `npm test` — 0 fail (or exactly the baseline's failures, reported), and the counts = baseline + your tests |
| real DSH (optional) | `npm run e2e` (from the root; Node.js 24.9+ and pnpm) still passes for the pilot, 15 / 15; your system on a real DSH needs an adapted copy of `e2e/run.mjs` — otherwise "not verified" |

## 9. Rules

- **Never** real personal data (documents, tests, fixtures, eval questions). **Never** secrets in git, logs or chat.
- Do not change the framework copies or the agent-layer packages to make your system pass; write what is missing in the report.
- The AI only reads and proposes. No write endpoint accepts a delegation. The AI never decides amounts.
- The business system decides who is told; each person is checked with the web screen's rule; when unsure, do not send.
- Permissions come first in every search and every graph answer; a test that proves it is part of done, not an extra.
- Outbound settings stay closed unless the plan records an explicit opt-in.
- Report honestly: the first eval run's numbers, what you tuned, what failed, what you assumed ("to confirm").

## 10. Pitfalls seen in earlier builds

- A comment after a front matter value (the build fails) or after a heading's `{…}` (the section's restriction silently disappears).
- `generateTools: true` (the template's value) together with the knowledge tool module: two tools with the same name.
- The knowledge tool module and the citation guard loaded from two different copies of plugin-knowledge: the guard never adds
  sources.
- A conformance knowledge probe on a document with public sections never fails — use a fully restricted document.
- Relation names other than `requested_by` / `assigned_to` / `required_role` give no "why" reason.
- The app and the evals using different knowledge options: the evals then measure a configuration that does not run.
- Copied tests that still carry the pilot's ids, counts or eval floor: they pass for the wrong reason or fail for no reason —
  that is why the `test` script is trimmed in step 2 and grown back step by step.
- Only one administrator: nobody can approve their documents until managers are approvers.
- A time-based event the fixtures cannot trigger: the conformance checks that need it cannot run — and 52 / 52 allows no skip.
- Replacing `fillers` / `stopWords` instead of extending the defaults: other languages' question words stop being ignored.
- Multi-word synonyms: they never match.
- A person-specific approver or a single all-roles proposal kind: conformance cannot reach 52 / 52 without the fixture design of
  step 2.7.
- `redirectToSignIn` without the handbook in `paths`: an employee who opens a knowledge source without a session reads a JSON 401.

## 11. Finishing

Write `examples/<system-id>/README.md`: what the system does, the roles and documents, the decisions marked "to confirm", the eval
numbers (first run and final), the test counts, how to start it (`node src/server.mjs`; its port and dev seed password variables —
pick a port that no other example uses), and the AI plane (`dsh-profile/`). Update `AGENT_PLAN.md` with the evidence of every
part. Report: what was built, the commands and their results, what is "not verified", and the decisions still to confirm.
