# Biz Assistant Framework — Development Guideline

The packages are `@dsh-bridge/*` (the prefix of the original name, DSH Business Bridge, kept as is).

## Summary (English)

How to connect a business system to AI employees with the Biz Assistant Framework (packages `@dsh-bridge/*`) — the main use is an **existing** system; a
new system is built on the same parts (b.0: where it lives, how it depends on the framework, and that it never modifies the framework itself). (a) quick
start — install, test, run the `equipment-inspection` example, run the e2e scenarios; the integration checklist (what the system adds: the Bridge v1
endpoints, a manifest, SNS linking on its own login, recipient rules it decides, events in its own transactions, its approval rules, a session check, the
report that the conformance suite needs); (b) connecting step by step — a new system (b.0), the manifest with the three internal events (b.1), the
server-kit hooks with their full signatures (or `x-alias` aliases of an existing API like CareBilling), events inside the business transaction, the
conformance suite and what 52 / 52 makes mandatory (reports, approvals, personal bots, the role mapping of the fixtures), the DSH product profile with the
closed outbound settings and a link-guard URL for every application, the web-kit screens and the BFF (which never relays a browser request with the BFF
secret), automatic tasks with delegation classes (non-default applications need their own entry), the staff manual (b.8), external connectors (b.9), external mode — a separate bridge service in front of an
unchanged system, with events taken from CDC or a qualifying webhook instead of the same transaction (b.10, trial), the
checklist and a Definition of Done made of commands; (c) extension points; (d) MUST / SHOULD rules (the AI never decides or sets amounts, parameters are
counts and dates, no names or health text in IM or events, idempotency keys, one approval decides, quiet hours, the AI-secretary voice, per-platform
notes, **recipients decided by the business system only**, group chats denied, unattended delegation classes, outbound screening, the config switches
and their safe values, personal bots, long-term memory with the business system's own name check `hooks.piiScan`, the AI employee's profile — one nickname
by default, files attached in the assistant panel with the OCR choice and the image cleanup, external connectors whose secrets stay in the business
system); (e) testing strategy; (f) versioning; (g) FAQ and troubleshooting; (h) CareBilling as the reference implementation. The architecture itself is in
[ARCHITECTURE.md](ARCHITECTURE.md).

---

In this document, "MUST" marks a rule that fails the conformance suite or review if it is not followed, and "SHOULD" marks a recommendation you may depart from when you have a reason.
Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the structure (layers, event flow, conversation isolation, safety commitments).

## Contents

- [Connecting an existing business system: checklist](#connecting-an-existing-business-system-checklist)
- [a. Quick start](#a-quick-start)
- [b. Connecting a business system to AI employees (steps)](#b-connecting-a-business-system-to-the-ai-employee-steps)
  - [b.0 Building a new business system](#b0-building-a-new-business-system) · [b.1 Writing the manifest](#b1-writing-the-manifest) · [b.2 Implementing the business side](#b2-implementing-the-business-side-server-kit-hooks) · [b.2' Mounting on an existing API under aliases](#b2-mounting-on-existing-apis-with-aliases-the-carebilling-approach)
  - [b.3 Writing events in the business transaction](#b3-writing-events-in-business-transactions) · [b.4 Passing the conformance suite](#b4-passing-the-conformance-suite) · [b.5 Registering in the DSH product profile](#b5-register-in-the-dsh-product-profile)
  - [b.6 Business web app screens (web-kit) and the BFF](#b6-business-web-app-screens-web-kit-and-the-bff) · [b.7 Enabling automatic tasks (delegate)](#b7-enable-automatic-tasks-delegate)
  - [b.8 The manual and how-to questions over SNS (help)](#b8-the-manual-and-how-to-questions-over-chat-help) · [b.9 External connectors (connections, operations, rules)](#b9-external-connectors-connections-operations-rules)
  - [b.10 External mode (trial)](#b10-external-mode-put-the-bridge-outside-the-existing-system-trial)
  - [Checklist](#checklist) · [Definition of Done (checked by commands)](#definition-of-done-verified-by-commands)
- [c. Extension points](#c-extension-points)
- [d. Rules (MUST / SHOULD)](#d-rules-must--should)
  - [d.8 Recipient guarantees and outbound settings](#d8-recipient-guarantees-and-outbound-settings) · [d.9 Personal bots](#d9-personal-bots-the-persons-own-sns)
  - [d.10 Long-term memory (bridge-memory)](#d10-long-term-memory-bridge-memory) · [d.11 The AI employee's profile (bridge-persona)](#d11-ai-employee-profile-bridge-persona)
  - [d.12 Attaching files to the AI assistant](#d12-file-attachments-to-the-ai-assistant) · [d.13 External connectors (connections, operations, rules)](#d13-external-connectors-connections-operations-rules)
- [e. Testing strategy](#e-testing-policy)
- [f. Versioning (protocol / manifest)](#f-versioning-protocol--manifest)
- [g. FAQ and troubleshooting](#g-faq-and-troubleshooting)
- [h. Reference implementation: CareBilling](#h-reference-implementation-carebilling)

---

## Connecting an existing business system: checklist

The main use of this framework is to **turn the business system you already use into one that works with AI employees (an AI assistant for each staff member)**.
Instead of people opening screens to enter data, check it and chase the person in charge, AI employees watch, notify, ask the right person and draft, and people decide in chat.
The business system adds only the "bridge" (the Bridge v1 endpoints, the manifest, SNS linking on the system's own login, recipient rules and so on — the table below);
the DSH runtime, the IM connections, the plugins, the outbound safeguards, the machinery for automatic tasks and scheduled reports, and the test tools belong to the framework.
You can also build a new business system on the same parts (the sample equipment-inspection was built from scratch on server-kit).

CareBilling (the first user, a care-billing system; repository `care-ai-native`) is a business system built with AI employees in mind, and the framework was extracted from it. It had
APIs doing the same job before the framework existed, so v1 is mounted on those APIs under aliases (b.2'). Every item can be verified as described in "where to check" in the table below.

| # | What the business system adds | Type | Framework contract (where to check) | How to add it if it is missing |
|---|---|---|---|---|
| 1 | An entry point for reading business data over an HTTP API, and an entry point for receiving AI proposals (the Bridge v1 endpoints) | Required | Implement Bridge v1 (`packages/protocol/openapi/bridge-v1.yaml`), or mount it on an existing API under aliases (b.2'). AI reads are the GETs listed in the manifest's `tools[].http` (`readToolPolicy`); writes go `POST /bridge/v1/proposals` → `proposalKinds[kind].apply` only when a person accepts (conformance: P1–P6, M1–M3, D5, PR1–PR3) | If the screens and the business logic are one piece (server rendering only, a desktop client, direct DB access), add a read API covering what the AI should read and an entry point for proposals. In Node use server-kit; in other languages implement the OpenAPI |
| 2 | The manifest (the system's self-description) | Required | Roles and delegation limits, the allow-list of events and payloads, notification wording, tools, playbooks, reports (b.1). `bridge-validate manifest --strict` passes (no warnings) | Write down the existing roles, the business changes and what you want to notify, and turn them into the manifest. The business code is not changed |
| 3 | A screen where staff members link their own SNS accounts (the business web app's 「SNS 連携」 (SNS linking)), running on **the system's own login** | Required | web-kit's `SnsLinkPage` calls `/bridge/v1/me/*` on the same origin with the employee's own session. The business web app's BFF checks the existing login (the gateway's `getSessionUser`) and forwards browser requests for `/bridge/v1/me/*` to the business system with the employee's own cookie, **without attaching the secret**. **MUST** attach `x-bff-secret` only to calls the BFF itself builds on the server side (`POST /bridge/v1/assistant/tickets`, `POST /bridge/v1/assistant/attachments/prepare`, and `POST /bridge/v1/me/personal-bots` right after a successful `createOnly` creation through the employee's own RPC), and **never relay a browser request with the secret** (if it does, a browser can register the organisation bot's botId as its own personal bot, and every other staff member talking to that bot becomes 「未連携」 (not linked) — a bypass of the owner rule in d.9; b.6). server-kit's `authenticate(req)` returns `{ user: { id, role }, sessionId }` from the existing session (cookie / bearer). BFF-only operations (web assistant tickets, personal bot registration) need both the employee's session **and** `x-bff-secret`. A link code is bound to the employee who issued it, and `/me/identities` shows only that employee's own links (conformance: L2–L9, B1–B4, S1, S2). For personal bots, see d.9 | If the login cannot be verified from outside (a separate ID scheme, an SSO that cannot be shared), add an entry point to the BFF that verifies the existing session. Do not build a separate identity check: it means double management and becomes a hole for impersonation |
| 4 | Rules by which **the business system decides** the recipients of notifications | Required | `recipientsFor(event, ctx)` → `null` / `{ stale }` / `{ users, paramsFor, link, dedupeKey }`. Decide by role, affiliation and scope of responsibility, and verify with the same check as web authorization (d.8). The employee's own notification settings, exclusion of people already notified, quiet hours and the priority of delivery channels are applied by the kit and the plugins (conformance: N1–N3) | If "who to notify" exists only in people's day-to-day practice, write a rule per event (CareBilling's `decideRecipients` is the sample). Do not let DSH decide recipients |
| 5 | Record business state changes as events in **the same transaction** as the business rows (transactional outbox) | Required | `kit.tx` + `kit.emitEvent` (b.3). The payload follows the manifest's `events.<type>.payload` (**a per-type allow-list**: IDs, dates, counts and states only). Violations raise `EventRejected`. DSH pulls events with `GET /bridge/v1/events?after=` (conformance: E1–E4) | Add one line that writes the event to each process that changes state (picking changes up later by diff or trigger notifies changes that were never committed and drops committed ones). To stay outside without changing the existing system's code, ingest from CDC or a qualifying webhook (b.10, trial) |
| 6 | Staff members and their roles (including active / inactive) can be looked up via the API | Required | `employees.get / list` → `{ id, role, active }`, the manifest's `roles` (`delegation: none \| read \| propose`). **The AI's permissions = the AI allow-list (the manifest's `tools[].roles`) ∩ that staff member's role**. A deactivated staff member loses all tokens immediately (conformance: D1–D7, S5, M3) | Write a hook that returns them from the existing staff table |
| 7 | The approval rules live inside the system (as a function, in one place), and approvals from chat can use the same rules | Required (for 52 / 52; even a business with no approvals keeps one minimal kind) | `approvals.{get, approvers, card, mayDecide, decide}` (shape in b.2). Without approvals, A1–A4 are skipped and the release condition (no skips) is not met. Deciding on the web also uses the same `mayDecide`; `decide` writes the decision inside `ctx.t` and emits `approval.decided`. One approval decides, and the other cards become invalid (`t.revokeApprovalDeliveries`) (conformance: A1–A4) | Gather the rules in the screen code into one function and call it from both the web and chat |
| 8 | Whether a web session is alive can be checked per user | Required | `isSessionLive(sessionId, ctx)`: ends web assistant tickets (30 minutes) and delegations together with the web session. In server-kit it is an optional hook, but conformance S4 (`hook:revokeSession`) requires it, and the release condition is no skips | Write a hook that looks up the session table |
| 9 | A manual for staff (1 screen = 1 section) with its index and search (the grounds for answering how-to questions over SNS) | Optional (recommended) | `@dsh-bridge/help`: checks the manual against the table of screen routes in CI and builds the index. server-kit's `help` (`GET /bridge/v1/help/*`) answers with the asker's role and attaches no URL for screens the asker cannot open. The manifest's `help.tool` and `web.routes` (b.8) | Write one section per screen (URL, menu, allowed roles, keywords, steps, FAQ). Roles are taken mechanically from each screen's Guard, so make the route table (router) readable |
| 10 | A personal-data check before anything goes into long-term memory (against the business system's own name lists) | Optional (recommended) | `POST /bridge/v1/pii-scan` (an optional Bridge v1 operation). server-kit has it by default: it returns the pattern check (contact details, long numbers, ID numbers and so on; ordinary Japanese and English sentences do not match) combined with the categories from the optional hook `hooks.piiScan(text, ctx) -> { kinds: string[] }` (the name-list check). The default pattern check **does not know names**, so a system that holds names of staff, service users or business partners implements `hooks.piiScan`. bridge-memory stores only text that passes both the local check and this check, and stores nothing if the check cannot be reached (fail closed). Applications without it use the local check only (d.10) | Write a `hooks.piiScan` that searches the name lists (service users, business partners, staff and so on) for names (family name, given name, kana) and, on a match, returns only the category (e.g. `staff_name`) (never the matched string; the sample is equipment-inspection's `src/hooks.mjs`) |
| 11 | The AI employee's profile (nickname, tone, company introduction, personality, background), edited by administrators in the business web app and kept in versions | Optional (recommended) | `GET /bridge/v1/ai-profile` (service, etag / 304) and the admin `GET / PUT /bridge/v1/admin/ai-profile` and `POST …/versions/{version}/restore`. server-kit has it by default (`roles.admins`; disable with `aiProfile: false`). If you build your own, validate with `validateAiProfile` and keep versions and an audit trail (version numbers only). The screen is web-kit `AiProfilePage` (d.11) | Add a version table and an admin screen. Without them, DSH runs with no profile (signature 「— <アプリ名> AI 秘書」 (— <app name> AI secretary)) |
| 12 | Scheduled reports (count-only reports: the manifest's `reports` and `hooks.reports.compute`) | Required (for 52 / 52) | Without reports, 10 of the 52 items fail: besides R1–R3, P4, L9, D6, D7, S2 and S4 use `GET /bridge/v1/reports/latest` as their delegation probe, and D3 checks that the report route also returns 403 under delegation. The default set of people who can accept proposals (`roles.proposalReviewers`) is also the report readers (b.2) | Decide 1–4 sections of about the size of "today's counts", and write which sections each role sees (`sectionsByRole`) |
| 13 | External connectors (AI employees use the company's other APIs or third-party APIs; connections, operations, rules) | Optional | server-kit's `createBridgeApp({ connectors: { secretKey } })`: `GET /bridge/v1/connectors/catalog`, `POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run` (read only, delegation), the admin `/bridge/v1/admin/connectors*` and so on, plus the proposal kind `connector_write`. Both the secrets and the calls stay in the business system (b.9, d.13) | An administrator registers connections and operations in the business web app (web-kit `ExternalConnectorsPage`). Start with one or two read operations |

**Verification**: once everything is in place, pass the **52-item conformance suite** (b.4) against the TEST environment. The release condition is 52 / 52, an empty `knownGaps`, and no skips.
Because no skips are allowed, **keep 7 (approvals), 12 (reports) and personal-bot registration (B1–B4; server-kit has it by default) in a minimal form even if the business has no plans to use them** (b.4).
On the DSH side, close the outbound settings in the product profile and set a link-guard URL for every application (b.5, d.8). Completion is judged by commands ([Definition of Done](#definition-of-done-verified-by-commands)).

**How to proceed**

- Start with one business process (e.g. invoice approval, inspection deadlines), run it alongside the existing screens to confirm it works, then widen the scope.
- Items 1 and 3 of the table (the read API and the login) go to the roots of the system's design, so how much you have to add varies greatly from system to system. Estimate it first. When the amount is large,
  another path is to build a new business system on the same framework (you only write the server-kit hooks; the kit owns the Bridge part). Where it lives, its dependencies and
  what must not be changed are in b.0.
- If you do not want to change the existing system's code, use **external mode** (b.10, trial), which places a dedicated bridge service outside it. Whether it can be used depends on whether the existing system has a login check,
  APIs that can be called as the employee, change notifications (webhook or CDC), and approval and write APIs.
- An explanation for executives (the same items in plain words) is on slide 18, 「つなぐために、業務システムに足すもの」 (What to add to the business system to connect it), of `docs/slides/marketing/biz-assistant-for-executives.pptx`.

---

## a. Quick start

### a.1 Setup and tests

Node 22.19 or later (verified on 24), pnpm 10.

```sh
cd framework
pnpm install
pnpm test                    # all workspace packages (excluding vendor/)
pnpm test:protocol           # individually: test:core / test:gateway / test:testing / test:kits / test:plugins / test:profile / test:examples
pnpm validate                # OpenAPI lint and validation of the bundled manifests
```

- Tests that need PostgreSQL (server-kit's PostgreSQL store, equipment-inspection's business tests and conformance) run only when
  `FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres` is set; otherwise they print the reason and skip.
  They create temporary DBs (`fw_serverkit_test`, `fw_equipment_unit_test`, `fw_equipment_test`) and drop them at the end (nothing other than `*_test` is dropped).
- As of 2026-10-30 (including external connectors; recounted with `pnpm test` and **without** `FW_TEST_DATABASE_URL`): **582 tests, 576 pass, 0 fail, 6 skip**
  (the skips are the PostgreSQL-dependent tests skipped with a reason, `packages/protocol/conformance/http.test.mjs` [runs only when `BRIDGE_BASE_URL` is set], and
  the YAML parser comparison test when the reference `yaml` package is absent).
  With `FW_TEST_DATABASE_URL` set, the DB-dependent tests (server-kit's PostgreSQL store, equipment-inspection's business tests and conformance) also run,
  and the DB-related skips disappear (measured 2026-10-29: 514 tests, 513 pass, 1 skip [http.test.mjs]; recount the with-DB numbers when the environment has a DB). `pnpm validate` is also ok (OpenAPI 46 paths). The count is the sum of `tests` from each package's `node --test`
  (lines from packages run with `pnpm -r` are prefixed with the package name, so do not miss them when counting). The counts change, so count them on the spot instead of copying them.
- The forks are outside the workspace: `cd vendor/dsh-im && npm ci && npm test` (the same for `dsh-auto-tasks` and `dsh-proactive`).

### a.2 Running the sample business system (equipment-inspection)

A small business system for facility equipment inspection (fire extinguishers, emergency lights, AEDs…). Built on server-kit; conformance 52 / 52.

```sh
# PostgreSQL must be running at 127.0.0.1:5432
export EQUIPMENT_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/equipment_inspection   # created on first run
pnpm --filter @dsh-bridge/example-equipment-inspection start                                      # http://127.0.0.1:19730
```

An empty DB is seeded with 4 fictitious staff members and 5 pieces of equipment (1 of them overdue). Open http://127.0.0.1:19730/ in a browser, log in, and try:
「連携コードを発行」 (Issue link code) → send 「連携 123456」 (Link 123456) to the bot → it appears under 「連携中の SNS」 (Linked SNS) → unlink → turn the overdue notification on / off.
The login password is set by `EQUIPMENT_SEED_PASSWORD` (for the development default, see the repository's `src/config.mjs`; never use it in production).

```sh
# business tests (16) and conformance (52 items)
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres \
  pnpm --filter @dsh-bridge/example-equipment-inspection test
```

### a.3 e2e (mock IM and LLM)

```sh
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres pnpm run e2e   # packages/testing/e2e/run.mjs
#   -- --keep (no cleanup) / -- --reuse-home (reuse the profile's dependencies) / -- --json-only
```

Runs the sample business system (equipment-inspection) + a product profile made from the profile template (name `fw-e2e`) + the framework plugins
on **the real DSH**, connected to a mock LLM, mock LINE and `@dsh-bridge/gateway` (`@dsh-bridge/testing`). It never connects to a real IM
or model, and secrets are generated on every run. It uses the temporary DB `fw_equipment_e2e_test` and the isolated home `.dsh-home-e2e` (the personal `~/.dsh` is not used),
and does not use the ports of the demo environment and the like (changeable with `FW_E2E_PORTS="app=…,dsh=…,llm=…,line=…,gateway=…,other=…"`). It takes about 70 seconds, and
when it finishes it cleans up the processes, DB and home it started (`--keep` leaves them). **15 / 15 steps, scenarios a–f all PASS**.
The e2e product profile is made from the template, so it runs with the closed settings of d.8 (the product values). It goes as far as checking that automatic-task reports arrive only as fixed wording and that the AI's summary does not
appear in IM (fixed delivery targets and the mail route are closed, so they do not appear in e2e).
The e2e and `pnpm demo` run a local copy of the pinned DSH CLI (`profile/template/package.json` `dshBridge.expectedDsh`, 0.2.2-rc.1)
in `.dsh-cli/<version>/`, installed with npm on the first run (`packages/testing/src/dsh-cli.mjs`); the global DSH is neither used nor changed.
`DSH_BIN=<…/@deepseek-ai/dsh/lib/bin.js>` runs another CLI. For your own BFF, `resolveDshBin()` (`@dsh-bridge/gateway`) looks in the order
`DSH_BIN` → `pnpm root -g` → `npm root -g`.

| Scenario | What it checks |
|---|---|
| a | An unlinked LINE user gets guidance only (no LLM call) → link code in the business web app → linked with 「連携 123456」 |
| b | Question → the AI calls the read tool generated from the manifest (`facility_list_overdue`) under the employee's own delegation |
| c | `inspection.overdue` → plugin-events → plugin-notify → AI-secretary wording on the linked staff member's LINE (【対応のお願い】 (Request for action), the ▶ lines, 「— 設備点検 AI 秘書」 (— Equipment Inspection AI secretary)) |
| d | Repair request → approval card on the approver's LINE → approve with the button → the card updates to 【ご報告】 (Report). The second one is returned with a reply code (「差戻 <code> 理由」 (Return <code> reason)) |
| e | The manifest's playbook (`pb_equipment-inspection_overdue_followup`, enabled with `install.mjs --enable-auto-tasks <id>`) runs only once per event (dedupe), makes a proposal with `facility_propose_reschedule`, and reports to the audience in the AI secretary's fixed wording (`audienceText: template`). The AI's summary does not appear in IM |
| f | Isolation: another app's tools are rejected (no token is sent), read tools outside the role are rejected, a delegation token cannot write — a service token is required — and the call is rejected for another app |

The results are PASS / FAIL per scenario and `packages/testing/e2e/.work/result.json`.

### a.4 Running DSH in an isolated home

```sh
node profile/scripts/install.mjs --home .dsh-home-trial --skip-install     # the personal ~/.dsh is rejected
cd .dsh-home-trial
DSH_HOME=$PWD DSH_AGENTS_HOME=$PWD/agents BRIDGE_DSH_WORKSPACE=$PWD/workspace \
INSPECTION_API_URL=http://127.0.0.1:19730 INSPECTION_SERVICE_TOKEN=<from the secret store> \
dsh --profile bridge --no-open --host 127.0.0.1 --port 3280 --public-url http://127.0.0.1:3290/dsh/
```

The ports are examples (3280 = DSH, 3290 = the business web app's BFF). Do not use the ports used by the demo environment and production (3010, 3080, 3180, 8790 and so on; the list that e2e's `assertPortsUsable` rejects
is at the top of `packages/testing/e2e/run.mjs`) (d.7).

The `dsh web: …?token=…` that DSH prints is the DSH owner's credential. Do not pass it to the browser; only `@dsh-bridge/gateway` uses it.
DSH also reads `.env` in its working directory, so do not start it at the repository root.

---

## b. Connecting a business system to the AI employee (steps)

The overall flow (sample: `examples/equipment-inspection`; the same for an existing system and a new one).

```mermaid
flowchart LR
  N["0 For a new system<br/>location and dependencies"] -.-> M
  M["1 Write and validate<br/>the manifest"] --> H["2 Implement hooks<br/>(or aliases of existing APIs)<br/>recipient rules"]
  H --> E["3 Write events in<br/>business transactions"]
  E --> C["4 conformance<br/>52 items"]
  C --> R["5 Register in the DSH profile<br/>bridge-apps, bots<br/>close the outbound settings"]
  R --> W["6 web-kit screens<br/>in the business web app<br/>(personal bot)"]
  W --> A["7 Enable automatic tasks<br/>with a delegation class"]
  A -.-> O["8 Manual, 9 external connectors<br/>(optional)"]
  O -.-> D["Definition of Done<br/>(commands)"]
```

### b.0 Building a new business system

When you build a new business system on top of the framework instead of adding to an existing one (sample: `examples/equipment-inspection`). server-kit owns the Bridge part;
the business system writes only the business itself, hooks, the manifest, the manual, tests, the product profile, and the business web app and BFF (using web-kit and gateway).

**Location and dependencies** (`@dsh-bridge/*` is published on npm since 0.1.0, https://www.npmjs.com/org/dsh-bridge. Inside the framework, dependencies between packages use `workspace:*`):

| Location | How to declare dependencies | Suited for |
|---|---|---|
| Inside the framework workspace: `examples/<system-id>/` (`pnpm-workspace.yaml` includes `examples/*`) | `"@dsh-bridge/server-kit": "workspace:*"` and so on. Run `pnpm install` at the framework root | Samples, validation, trying things together with the framework |
| A separate repository (product) | `npm install @dsh-bridge/server-kit` (or `pnpm add`), pinning the version you verified with | Product repositories |
| A separate repository that needs an unreleased framework change | First run `pnpm install` in the framework checkout, then write `"@dsh-bridge/server-kit": "file:<framework>/packages/server-kit"` etc. in the business system's `package.json` and install with **npm** (`npm install`. npm only creates links, and the `workspace:*` inside the packages is resolved from the `node_modules` of the framework checkout). pnpm's `file:` cannot resolve `workspace:*` and stops with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. Use this only until the change is released | Trying unreleased changes |

`pg` is a peer of server-kit (add it to the business system's dependencies if you use the PostgreSQL store). web-kit is distributed as `.ts`, so load it with the business web app's bundler (Vite, etc.).

**File layout** (split the same way as equipment-inspection; only the final `web/` and `bff/` are not in the sample):

```
bridge.manifest.yaml      b.1 (system.id = the DSH app id)
src/config.mjs            environment variables only (secret defaults are for development only and required in production; rejects other systems' DB names. d.7)
src/auth.mjs              your own login and sessions: authenticate(req), isSessionLive (b.2)
src/domain.mjs            business rules. State changes use kit.tx + kit.emitEvent (b.3); approval rules (mayDecide) live in one place
src/hooks.mjs             employees, recipientsFor (scope and the per-person gate: d.8, b.2; the sample uses mayViewEquipment, the same rule as the web list), approvals, proposalKinds, reports, piiScan (, eventDelegations)
src/routes.mjs            business API (/api/*) on the kit router: AI reads use kit.readToolPolicy, writes use { allow: ['user'] }
src/help.mjs              manual → index → createHelpService (b.8)
src/app.mjs, server.mjs   createBridgeApp + store.migrate() + business migrations (migrate / readMigrations), startScheduler (b.3)
src/migrations/*.sql      business tables (the kit creates bridge_*)
manual/NN-*.md            1 screen = 1 section (b.8)
test/fixtures.mjs         conformance fixtures (b.4)
test/conformance.test.mjs the suite with the generic HTTP adapter (the file of the same name in equipment-inspection is the sample)
test/*.test.mjs           business tests (item 3 of the Definition of Done)
<product>/dsh-profile/    a copy of profile/template (b.5), and hand-written tool and message-wording modules (c)
web/                      business web app (React + web-kit; a bundler such as Vite, tsc. b.6): chat (SNS) linking, notification settings, approvals, AI proposals, AI employee settings, etc.
bff/                      BFF of the business web app (same origin. b.6, d.9): @dsh-bridge/gateway (/dsh/*, rpcAllowlist); forwards browser calls such as /bridge/v1/me/*
                          without the secret; x-bff-secret only for the BFF's own calls (tickets, attachment conversion, personal bot registration); for personal bots, the RPC for the person themself
```

- **There is no sample of web/ and bff/ inside the framework** (equipment-inspection only serves a single screen from `public/` [plain JS] from the business system itself, uses neither a BFF
  nor web-kit, and does not expose the BFF-only operations [web assistant, personal bot registration]). All rules for building them are in b.6 (screens, forwarding, `x-bff-secret`) and
  d.9 (the RPC for the person themself). The business system may also serve the screens without a BFF, but then the BFF-only operations are not available (do not substitute for them by
  exposing the secret to the browser).

- **MUST NOT** modify anything inside the framework (`packages/*`, `plugins/*`, `vendor/*`, `profile/template`, `profile/scripts`) for your own system
  (the same applies when you place it in `examples/<id>`). Fill gaps with hooks (b.2), `toolModules` / `templateModules` (c), plugin and profile settings (c, d.8),
  and the product's copy of the profile (b.5). Anything still not possible becomes an issue against the framework and is fixed as a framework change, together with tests and documentation.
- Role names are free (map them to the suite's generic roles in the conformance fixtures; b.4).
- The final check is the [Definition of Done](#definition-of-done-verified-by-commands).

### b.1 Writing the manifest

The manifest is the business system's "self-introduction". DSH reads it to assemble the AI employee's vocabulary, tools, event classification, notification message wording and playbooks.
Start from `packages/protocol/manifests/example.manifest.yaml` (daily report) or `examples/equipment-inspection/bridge.manifest.yaml`
(`packages/protocol/manifests/equipment-inspection.manifest.yaml` is a copy for validation and does not include the manual tools. Start from the one in examples).

```yaml
bridge: 1                         # protocol major (constant)
version: 2026-10-26               # manifest version (SemVer or a date). The etag is derived from the content
system: { id: equipment-inspection, name: 設備点検, locale: ja-JP, timezone: Asia/Tokyo }

roles:                            # roles and the upper limit of AI delegation (delegation: none | read | propose)
  admin:     { label: 施設管理者, scope: all,      delegation: propose }
  manager:   { label: 設備責任者, scope: all,      delegation: propose }
  inspector: { label: 点検員,     scope: assigned, delegation: propose }

entities:                         # data types and personal data classification (none < personal < financial < sensitive < health)
  equipment:    { label: 設備・備品, pii: none, link: "/equipment/{id}" }
  approval:     { label: 承認,       pii: none }      # aggregate of approval.* below
  sns_identity: { label: SNS 連携,   pii: personal }

audienceRules:                    # names and descriptions of recipient rules (resolved by the business system's recipientsFor; DSH does not create recipients)
  assignee_and_managers: { description: 設備の担当点検員と、施設管理者・設備責任者。, roles: [admin, manager], includes: [assignee] }

events:
  inspection.overdue:
    label: 点検期限の超過
    aggregate: equipment
    payload: [equipmentId, dueOn, daysOverdue, assigneeUserId]   # allow list for this type: IDs, dates, counts and states only
    severity: warning
    audience: { rule: assignee_and_managers }                    # optional: include: [<rule>] (additional recipients), fallback: { roles: [admin] } (routed only when there are 0 recipients)
    notify: { template: inspection.overdue, digestMinutes: 60 }  # rule-based notification (quiet: exempt / default: off can also be written)
    playbook: overdue_followup                                   # also passed to the AI procedure

templates:
  inspection.overdue:
    intent: action                # info【ご報告】/ action【対応のお願い】/ urgent【至急】/ approval【承認のお願い】(no buttons) / consult【ご相談】
    action: 担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。
    description: 点検期限を {daysOverdue} 日過ぎた設備があります（期限 {dueOn}）。あなたの確認対象の未点検は {count} 件です。
    params: { count: { type: integer }, daysOverdue: { type: integer }, dueOn: { type: date } }   # there is no free-text string type

tools:                            # the AI employee's business tools (names are <namespace>_*)
  - { name: facility_list_overdue, http: GET /api/inspections/overdue, access: read, roles: [admin, manager], pii: none }
  - { name: facility_list_equipment, http: GET /api/equipment, access: read, roles: [admin, manager, inspector], pii: none }
  - name: facility_propose_reschedule
    http: POST /bridge/v1/proposals
    access: propose               # writes are always proposals (applied only after a person accepts)
    roles: [admin, manager, inspector]
    input: { type: object, required: [equipmentId, dueOn], additionalProperties: false,
             properties: { equipmentId: { type: string }, dueOn: { type: string } } }

playbooks:                        # the AI employee's procedures (= automatic task templates)
  overdue_followup:
    agent: facility-inspection
    trigger: { events: [inspection.overdue] }      # or { cron: "30 8 * * *" } / { condition: ... }
    instructions: |-
      … (procedure, how to write the report, prohibitions. See d.6 below and "Instruction rules" in profile/template/auto-tasks/README.md)
    tools: [facility_list_overdue, facility_list_equipment, facility_propose_reschedule]
    audience: { rule: assignee_and_managers }
    delegation: inspection        # optional: whose delegation it runs under. <class> (staff members of that class) or <class>=each (the person of the triggering event; b.7)
    delivery: only_if_actionable
    approval: none
    guard: { maxRunsPerDay: 20, maxConsecutiveFailures: 5, dedupe: event }
    enabled: false                # disabled at deploy time. The operator enables it

reports:
  daily_inspection:
    cron: ["30 8 * * *"]
    audience: { roles: [admin, manager] }
    sections: [equipment, overdue, inspections, repairs]
    sectionsByRole: { inspector: [overdue, inspections] }      # sections shown per role when read via delegation
```

**MUST** declare the approval and unlinking events in the manifest (their content is handled by internal plugins: `internal: approvals_im` / `internal: identity`).
server-kit and business code write them **with these payload keys**, so without them unlinking and approval creation fail, and conformance L9, A1–A4 and E2 fail.
bridge-validate warns when these 3 are missing (`event.internal_missing`), when payload keys are missing (`event.internal_payload`), or when a different `internal` is written
(`event.internal_owner`) (no warnings is the requirement, so in practice these are errors. With `--strict`, warnings also exit 1. The list is `INTERNAL_EVENTS` in `@dsh-bridge/protocol`).
Because `aggregate: approval` is used, also declare `approval: { label: 承認, pii: none }` in `entities` (otherwise a `ref.entity` error).
`approval.decided` may also be made a notification event without `internal` (same payload):

```yaml
events:
  approval.requested:             # emitted by business code in the transaction that creates the approval (b.3)
    { label: …の承認依頼, aggregate: approval, severity: info, internal: approvals_im, audience: { rule: <approver rule> },
      payload: [approvalId, subjectType, subjectId, requiredRole, expiresAt] }
  approval.decided:               # emitted by hooks.approvals.decide and by decisions on the web
    { label: …の承認の決定, aggregate: approval, severity: info, internal: approvals_im,
      payload: [approvalId, subjectType, subjectId, decision, status, channel, decidedByUserId] }
  sns_identity.unlinked:          # emitted by server-kit on unlinking
    { label: SNS 連携の解除, aggregate: sns_identity, severity: info, internal: identity, payload: [identityId, userId, platform] }
```

Validation (put it in CI):

```sh
node packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict
```

Without `--strict`, it prints `ok` and exits 0 even if there are warnings (`warn` lines). Always use `--strict` in CI
(you may also check in business tests that `validateManifest(m).warnings` is empty; the sample is `test/domain.test.mjs` in equipment-inspection).

In addition to the schema, it checks all cross-references (tool roles exist, playbook tools exist, notifying events have an audience and a declared
template, the rules, roles and templates of `audience.include` / `fallback` exist, `<class>=each` playbooks are triggered by an event …),
and rejects payload keys and template parameter names that look like personal data (`residentName`, `comment`, `memo`, etc.; `…Id` is allowed).

### b.2 Implementing the business side (server-kit hooks)

```js
import { createServer } from 'node:http'
import { createBridgeApp, createPool, createPostgresStore } from '@dsh-bridge/server-kit'

const pool = await createPool(process.env.MY_DATABASE_URL)
const store = createPostgresStore({ pool })
await store.migrate()                                    // bridge_* tables (idempotent)

const bridge = await createBridgeApp({
  manifest: { file: './bridge.manifest.yaml' },          // validated at startup; served with an etag at GET /bridge/v1/manifest
  store,
  serviceToken: process.env.MY_SERVICE_TOKEN,            // DSH's x-service-token
  bffSecret: process.env.MY_BFF_SECRET,                  // x-bff-secret of the business web app's BFF
  orgId: 'my-org', service: 'my-system', version: '1.0.0',
  hooks: { employees, authenticate, isSessionLive, recipientsFor, approvals, proposalKinds, reports, piiScan },
  // optional: help (b.8), connectors: { secretKey } (b.9), attachments (d.12), roles (below)
})
createServer(bridge.handler).listen(8080)                // with express, bridge.middleware
```

| hook | Required | What to write |
|---|---|---|
| `employees.get(id, ctx)` / `employees.list({ roles }, ctx)` | Required | `{ id, role, active }` (`list` returns active staff members only). Checked on every delegation use, linking and decision (a deactivated staff member loses all tokens immediately). The batch lookup `employees.getMany(ids, ctx)` is optional |
| `authenticate(req)` | Required for `/me/*` | The business system's own session (cookie / bearer) → `{ user: { id, role }, sessionId }`. The kit never sees passwords |
| `isSessionLive(sessionId, ctx)` | Optional | Ends web assistant tickets and delegations together with the web session |
| `recipientsFor(event, ctx)` | Required for notifications | `null` (do not notify) / `{ stale: 'reason' }` (the situation has changed and the notification is no longer needed) / `{ users, paramsFor(user), link, dedupeKey, template? }`. The kit applies the person's own settings, exclusion of those already notified, delivery-channel priority and quiet hours |
| `approvals.{get, approvers, card, mayDecide, decide}` | Required for approvals (and for 52 / 52) | Approval rules are **the same function** as on the web. `get(id, ctx)` → `{ id, status, expiresAt, requestedBy, … }` or null (**camelCase**: the kit uses `expiresAt` for the deadline and `requestedBy` to exclude the requester from the recipients. Do not return the raw DB row [`expires_at`]. With `ctx.lock`, use `FOR UPDATE`), `approvers(approval, ctx)` → `[{ id, role }]`, `card(approval, ctx)` → `{ title, fields: [{ label, value }], body, wording? }` (IDs, amounts and deadlines only), `mayDecide(approval, user, ctx)`, `decide(approval, { action, actor, channel, comment, deliveryId }, ctx)` (writes the decision inside `ctx.t` and emits `approval.decided`). With custom state names, map them to `'pending'` with `state(a)` |
| `proposalKinds[kind]` | Required for proposals | `{ roles, validate(payload, ctx, principal), apply(payload, actor, ctx, proposal) }`. `apply` runs only when a person accepts, inside the kit's transaction: **write business data with `ctx.db`** (writing with the pool puts it in a different transaction from the acceptance record). `connector_write` is the name used by external connectors (b.9) |
| `reports` | Required for reports (and for 52 / 52) | `{ kind?, compute(viewer, ctx) }`. `viewer = { id?, role?, sections }` → `{ sections: { <section name>: object of counts }, attention, date? }`. The kit keeps only `viewer.sections` (the manifest's `sectionsByRole`). If the manifest has several reports, select with `kind` |
| `piiScan(text, ctx)` | Required for systems that hold names (d.10) | `{ kinds: string[] }` (categories only, such as `staff_name`; never return the matched strings). `POST /bridge/v1/pii-scan` returns them together with the categories of the kit's format checks. If the hook throws, 503 `pii_scan_failed` (the memory is not saved). Sample: equipment-inspection (a roster of display names) |
| `eventDelegations[type]` | Required for `<class>=each` | `{ eligible(event, user, ctx), personOf?(event), maxAgeHours? }`. On `POST /delegations { event: { id } }`, issues a delegation of the person of that event (default `payload.userId`). `eligible` is the person's own setting (e.g. 「AI に下書きを任せる」 (Let the AI draft for me)). Checked at issue and on **every use**; once it no longer holds, the token is invalidated immediately. Unknown type → 422, old event → 409 (default 12 hours), person no longer eligible → 403 (without saying who). Without the hook, `event` → 400 |

Every hook receives `ctx = { db, t, emitEvent, now, lock? }` (`ctx.db` is the client of the current transaction). Other options besides hooks:
`roles: { reportReaders, reportRunners, proposalReviewers, admins }` (defaults: the roles in the report audience, `admin`, the report readers, `admin`. **By default, those who can accept
proposals are the report readers**; `admins` are those who manage AI employee settings, attachment settings and external connectors), `aiProfile: false`, `attachments` (d.12), `connectors` (b.9),
`help` (b.8), `personalBotPlatforms`. For details not in the table, see "Hooks" in the server-kit README.

Example of `recipientsFor` (from `src/hooks.mjs` in equipment-inspection):

```js
async function recipientsFor(event, ctx) {
  if (event.type !== 'inspection.overdue') return null
  const { equipmentId, dueOn, daysOverdue } = event.payload
  const e = (await ctx.db.query('select active, next_due_on, assignee_user_id from equipment where id = $1', [equipmentId])).rows[0]
  if (!e || !e.active) return { stale: 'equipment_retired' }
  if (e.next_due_on > dueOn) return { stale: 'inspected' }        // already inspected: do not notify
  const users = /* assigned inspector + active admin / manager */ []
  return {
    users,
    template: 'inspection.overdue',
    dedupeKey: `inspection.overdue:${equipmentId}:${dueOn}`,
    link: `/equipment/${equipmentId}`,                            // the business web app authorizes again when opening it
    paramsFor: (u) => ({ count: /* number of items this person is responsible for checking */ 0, daysOverdue, dueOn }),   // numbers and dates only
  }
}
```

How to decide recipients (MUST in d.8): `users` may contain only people to whom the event **is relevant** (role, affiliation, assigned scope). In large systems,
CareBilling's `decideRecipients` pattern can be used — give the rule (roles, addressed to the person, people to exclude) the event's **subject** (a care recipient, an office, the whole corporation …),
narrow role-based recipients to staff members within the subject's scope, and finally, at a **gate**, check one person at a time "can this person see the same subject in the business web app" with the same function as the web authorization;
people dropped are not sent anything and are recorded in the audit (IDs and reason codes only). Counts (`paramsFor`) are counted within the scope the recipient can see. When the scope cannot be determined,
send to no one (`{ stale: 'no_scope' }`, etc.).

Among business API GETs that the AI reads, only those listed as read tools in the manifest accept delegations:

```js
bridge.router.add('GET', '/api/inspections/overdue', bridge.kit.readToolPolicy('GET /api/inspections/overdue', ['admin', 'manager']), handler)
bridge.router.add('POST', '/api/inspections', { allow: ['user'] }, handler)   // writes only from human sessions (delegations get 403)
```

### b.2' Mounting on existing APIs with aliases (the CareBilling approach)

A system that already has routes with the same function can mount `/bridge/v1` as **aliases** without rebuilding (make a mapping table of the routes that correspond to each item
of the checklist at the beginning; for items that do not exist, add them first and then alias them).

```js
import { aliasTableFromOpenApi, camelRows, registerAliasRoutes } from '@dsh-bridge/server-kit'
const table = [
  { operationId: 'lookupIdentity', method: 'GET', path: '/identity', aliases: [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] },
  { operationId: 'listMyIdentities', method: 'GET', path: '/me/identities', aliases: [{ method: 'GET', path: '/api/sns-identities', status: 'shape' }] },
]   // or aliasTableFromOpenApi(annotated bridge-v1.yaml, { key: 'x-alias' })
registerAliasRoutes(router, { table, from: legacyRouter, adapters: { listMyIdentities: camelRows('identities') } })
```

- `status`: `exact` (same shape), `shape` (shape conversion needed: `adapters`), `missing` (does not exist yet). If the route differs per caller type (principal),
  use `for: ['service' | 'delegated' | 'user']`. Aliases that cannot be resolved are reported in `skipped` and are not silently served.
- If you write the mapping table in `x-alias` of an annotated `bridge-v1.yaml`, you can list it with `bridge-validate aliases <file> --extension x-alias --label my-app` and
  check it with `lintOpenApi(doc, { aliasExtension, requireAliases })`. CareBilling's table: `examples/care-billing/manifest/care-api-v1-aliases.md`.
- For languages other than Node, implement `packages/protocol/openapi/bridge-v1.yaml` as is and verify with the conformance suite.

### b.3 Writing events in business transactions

```js
return kit.tx(async (t) => {                                    // business rows and the event in one transaction (outbox)
  const { rows } = await t.db.query('insert into inspection (...) values (...) returning id', [...])
  await kit.emitEvent(t, {
    type: 'inspection.completed', aggregateType: 'inspection', aggregateId: rows[0].id,
    payload: { inspectionId: rows[0].id, equipmentId, result: 'ok', inspectedOn, inspectorUserId },   // allow-listed keys only
  })
  return { status: 201, body: { ok: true, id: rows[0].id } }
})
```

- **MUST** write in the same transaction as the business change (do not tell DSH about changes that were not committed; do not drop changes that were committed).
  In external mode, which sits outside the existing system, the ingestion in b.10 (trial) replaces this.
- **MUST** the payload contains only the keys in the manifest's allow list for that type. Violations raise `EventRejected` (values are not included in the error).
- When an approval is decided on the web, invalidate the IM cards with `t.revokeApprovalDeliveries({ approvalId })`.
- Periodic business processing (scanning for overdue items, etc.) uses `startScheduler({ kit, tasks: [{ name, everyMinutes, run }] })` (the same scheduler also stores
  the manifest's `reports.*.cron`). Make it idempotent (once per deadline / date). If you use external connector rules, add `{ name: 'connector-rules', everyMinutes: 1, run: () => kit.connectors.tick() }` (b.9).

### b.4 Passing the conformance suite

```sh
# generic HTTP adapter (systems serving /bridge/v1 at a base URL)
BRIDGE_BASE_URL=https://staging.biz.example.com \
BRIDGE_SERVICE_TOKEN=... BRIDGE_BFF_SECRET=... \
BRIDGE_FIXTURES=./my-fixtures.mjs BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml \
node --test packages/protocol/conformance/http.test.mjs
```

- Run it against a **TEST environment** (never point it at production or demo environments). The fixtures (`conformance/fixtures.example.mjs`) provide logged-in
  staff members per role and optional hooks (expired link code, expired delegation, session end, staff member deactivation, notifying event, pending approval …).
  Items without a hook are **skipped** and appear in the summary (behaviour that was not exercised is not verified).
- Systems that want to start themselves and prepare the DB, or rewrite to old paths, use an **application adapter** (`BRIDGE_ADAPTER=./my-app.adapter.mjs`,
  sample `conformance/adapters/example-adapter.mjs`).
- **MUST** for a release, all 52 items pass, `knownGaps` is empty, and there are no skips. Because no skips are allowed, the following are **effectively required**:
  - Reports (the manifest's `reports` and `hooks.reports`). Without them 10 items fail (R1–R3; P4, L9, D6, D7, S2, S4, which use `GET /bridge/v1/reports/latest` as a probe; and D3, which also checks the report path).
  - Approvals (`hooks.approvals`, plus `capabilities.approvals: true` and `createPendingApproval` in the fixtures). With `false`, A1–A4 are skipped.
  - Personal bots (`personalBotPlatform` in the fixtures; server-kit owns registration and the owner rules). With `capabilities.personalBots: false`, B1–B4 are skipped.
  - Two proposal kinds: one the delegated role can create (`proposalSample`: PR1, PR2) and one that role cannot create (`proposalForbiddenSample`: PR3).
  - Fixture hooks: `expireLinkCode`, `expireDelegation`, `revokeSession`, `deactivateEmployee`, `emitNotifiableEvent`, `createPendingApproval`,
    `produceEvents`, `tryEmitEvent`, `writeProbes` (listed in `conformance/fixtures.example.mjs`; list every business write API in `writeProbes`).
- **Role mapping**: the suite creates staff members with generic role names (`admin`, `manager`, `staff`, `billing`) (e.g. `fx.newEmployee('staff')`). The fixtures' `employees`
  hold 3 people, `admin`, `manager` and `staff`, and `newEmployee(role)` maps these 4 names to your own roles. Map them to: `admin` = an administrator who can run reports immediately
  (but still cannot see other people's links), `manager` = a role that reads reports and can decide approvals and accept proposals, `staff` / `billing` = ordinary roles that cannot read reports
  (equipment-inspection maps `staff` / `billing` → `inspector`). List every role of the manifest in `roles` (M3).
- `emitNotifiableEvent({ employee })` creates an event **whose recipients include that `employee`** (if the recipient rule is like "the person who booked", create business data
  with that person as the person themself). The fixtures sample is `conformance/fixtures.example.mjs`; the real one is `examples/equipment-inspection/test/fixtures.mjs`.

### b.5 Register in the DSH product profile

1. Copy `profile/template/` into your product and fill in every `<placeholder>` in `cordis.patch.yml` (`install.mjs` warns about any that are left; `<…>` inside
   YAML comments is not counted). Delete the template's `auto-tasks/example-report-overdue.json` (a task of `example-app`, the sample daily-report app) or replace it with your own task
   (if you leave it, it goes into `tasks.json` disabled).
2. Create the **app bot** in dsh-im and note its `botId` (a WeCom self-built app, Slack App, LINE Official Account, Teams Bot or Lark app.
   Personal WeChat allows one bot per account, so put it on several apps with `multiApp: true`).
3. Write the `bridge-apps` registry:

```yaml
- id: bridge-apps
  name: '@dsh-bridge/dsh-core'
  config:
    strict: true                                  # two or more apps: a bot that belongs to no app is handled by nobody
    aiProfileRefreshSeconds: 60                   # interval for re-fetching the AI employee profile (paths.aiProfile, etag / 304)
    applications:
      - id: equipment-inspection                  # = system.id in the manifest
        name: 設備点検                             # 【設備点検】 and the signature 「— 設備点検 AI 秘書」 (with a nickname: 「— はると（設備点検 AI 秘書）」)
        aliases: [点検]                            # 「#点検」 on a shared bot
        namespace: facility                       # tools are facility_*
        paths: v1
        apiUrlEnv: INSPECTION_API_URL             # read on every call (falls back to apiUrl)
        apiUrl: http://127.0.0.1:19730
        serviceTokenEnv: INSPECTION_SERVICE_TOKEN # never write the token itself in the yml
        manifestUrl: /bridge/v1/manifest          # etag / 304
        manifestFile: pkg:@dsh-bridge/example-equipment-inspection/bridge.manifest.yaml   # fallback when the URL is unreachable
        generateTools: true                       # generate read tools from the manifest
        agents: [facility-inspection]
        delegation: { unattendedPolicy: deny }    # automatic tasks get no business data by default
        bots:
          - { platform: slack,     botId: <bot id of the equipment-inspection Slack App> }
          - { platform: wecom-app, botId: <dsh-im bot id of the equipment-inspection WeCom self-built app> }
          - { platform: weixin,    botId: <personal WeChat bot>, multiApp: true }   # multiApp: true in the other apps' entries too
```

   - `delegation: { unattendedPolicy: deny }` is the registry value. The value that `--auto-task-delegate` in b.7 writes applies only to the **default application** (`default: true`,
     or the only app). When you list several apps with `strict: true` and no `default`, as in the example above, see "non-default apps" in b.7.
   - `manifestFile: pkg:…` works only for a package that the DSH profile can resolve. For a system in another repository, use an absolute path, or omit it and keep only `manifestUrl`.
4. Hand-written tools (proposal tools and so on; tools with `access: propose` in the manifest are not generated) go in `toolModules` of `bridge-tools`; message wording goes in
   `templateModules` of `bridge-notify` (section c). The `module` of `toolModules` is a package name or a path.
5. **Outbound settings are closed in the template** ("product values" in the table in d.8). `profile/template/cordis.patch.yml` ships with the following values
   (the same values as CareBilling's `dsh/runtime-profile/cordis.patch.yml`. `node profile/scripts/check.mjs <cordis.patch.yml>` 〔bin `dsh-bridge-profile-check`〕 verifies them; the template itself is checked with `--template`).
   Use them without deleting them (below is an excerpt of the relevant part of the template; other lines are omitted). check.mjs checks **the textual form**, so keep the same block style as the template
   (one value per line, keep the `name:` lines too), and do not rewrite it into the one-line form `config: { … }` (if you do, it fails with `closed_value`):

```yaml
- id: xmanrui-dsh-im
  name: '@care/dsh-im'
  config:
    forwardPluginSources: []                # do not copy launch replies into the conversation
- id: dsh-proactive
  name: '@care/dsh-proactive'
  config:
    modelTools: reclaim
    deliveryGuard: required
- id: dsh-auto-tasks
  name: '@care/dsh-auto-tasks'
  config:
    restrictDelivery: true
    mail: false
- id: bridge-identity
  name: '@dsh-bridge/plugin-identity'
  config:
    groupChat: deny
    messages:
      groupChat: '業務の内容は個別チャットでお尋ねください。'   # GROUP_CHAT_GUIDE
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    groupChat: deny                         # toolModules also goes in this entry
- id: bridge-notify
  name: '@dsh-bridge/plugin-notify'
  config:
    aiReportGuard: screen                   # with template, always fixed wording
    proactiveDelivery: deny
    audienceFallback: none                  # all apps; override with applications.<id>
    audienceText: template
```

   **Opening a setting is explicit opt-in only**: change that line in the product patch and leave the reason in a comment (e.g. per app
   `applications: { equipment-inspection: { audienceLink: /equipment } }`; to open it, `audienceText: summary`). For an entry that already exists, only add the
   values (do not create two entries with the same id). `install.mjs` rejects `--auto-task-session / --auto-task-bot / --auto-task-target` (fixed delivery targets) (exit 2).
6. Install with `node profile/scripts/install.mjs --home <dir>` and restart DSH.
7. The template bundle includes long-term memory `@dsh-bridge/plugin-memory` (bridge-memory, d.10), the AI employee profile `@dsh-bridge/plugin-persona`
   (bridge-persona, d.11), and `@dsh-bridge/plugin-reader` (bridge-reader, d.12), which lets the AI read scanned documents. If the business system has no `pii-scan`, `ai-profile` or
   `document-reads`, memory runs with local checks only, there is no profile, and document reading does nothing.
   Keep the persona text (fixed rules) of the AI employee presets as it is (bridge-persona prepends the same rules).
8. **AI employee presets**: adapt the template's `business-assistant` to your product, and add a preset of the same shape for each `agent` of the manifest's playbooks (sample in the template comments;
   b.7). If you use the manual, **paste as is** the text returned by `helpRules('<ns>_help_search')` (`@dsh-bridge/dsh-core`) into the persona `prefix`
   (YAML cannot call functions, so print it once with node and copy it; b.8).
9. **Link checking**: in bridge-identity, set `linkGuard: { webUrl: <business web app URL of the default app>, webUrls: { <application-id>: <URL of that business web app> } }`
   (sample in the template comments). **Write it for every app**: for an app with no URL, links in AI answers are not checked (fail open. For an app that has `web.routes` but no URL,
   bridge-identity warns once, at that app's first AI answer; b.8, d.8). `check.mjs` verifies that each app in the registry has a URL
   (rule `link_guard`: the default app needs `linkGuard.webUrl` or `webUrls.<id>`; other apps need `webUrls.<id>`).
   **Link checking works only when there is both a URL and `web.routes` (the path patterns of the business web app's screens) in the manifest**. Without `web.routes`, nothing is checked even with a URL,
   and no warning appears. Systems that do not use the manual (b.8) still write `web.routes` in the manifest (you may generate it from the route table with `setManifestWebRoutes` of `@dsh-bridge/help`).
10. **With two or more apps** (several apps in one DSH; ARCHITECTURE.md §6): for the default app, the plugin-wide values are enough, but **for a non-default
    app, unless you write its per-app fields, not even the default app's values are used** (it runs empty). For each non-default app:
    - `applications.<id>.webUrl` of `bridge-notify` (the origin prepended to relative links in notifications; without it, that app's notification links are empty) and, if needed, `bots`
    - `applications.<id>.webUrl` of `bridge-approvals` (the URL of the approval screen, with `{id}` replaced by the approval ID) and, if needed, `bots`. The template's global `webUrl`
      (`BRIDGE_WEB_PUBLIC_URL` or `http://127.0.0.1:3010` plus `/approvals?id={id}`) is not a `<placeholder>`, so check.mjs does not count it. Change the default app's value
      to your own approval screen as well
    - `application: <id>` in `agents[]` of `bridge-assistant` (an AI employee without it belongs to the default app, and the business web app's panel would point at another app)
    - `linkGuard.webUrls.<id>` of `bridge-identity` (9), and delegation for automatic tasks ("non-default apps" in b.7)

### b.6 Business web app screens (web-kit) and the BFF

| Screen | Component | Who |
|---|---|---|
| IM bot connection (Settings › IM bots) | `ImBotsShell mode="admin"` (shows dsh-im's settings components with the `--dbw-*` CSS variables. `channels` is required: `channelDefs(DEFAULT_CHANNELS, loaders)`. dsh-im's client components are loaded by the business web app's bundler through `createImRuntime({ loadVendor, loadWeixin })` 〔web-kit README "Use it"〕. Use `excludeBotIds` to leave out staff members' personal bots) | Administrators (organisation bots only) |
| Chat (SNS) linking (Settings › SNS linking) | `SnsLinkPage`: ① own bots (`ImBotsShell` in self mode with `personalChannels` + `personalRpc`; all channels) ② link codes for organisation bots ③ own links and unlinking ④ notification settings | All staff members (**only their own links and their own bots**) |
| Notification settings | `NotifyPrefsCard` (types come from the server = the notification events in the manifest; descriptions come from the business side; hours in which notifications are held back). `labels` are `events.<type>.label` from the manifest (the manifest can only be fetched with the service token, so build them from the manifest when the business web app is built) | All staff members |
| AI employee settings (Admin › AI employee settings) | `AiProfilePage` (nickname, first-person pronoun, tone, company introduction, personality, background, speech examples, preview of the signature and sections, version list and 「この版に戻す」 (Restore this version); `endpoint` defaults to `/bridge/v1/admin/ai-profile`). **By default, do not pass `agents`: there is one nickname** (saving removes the per-AI-employee overrides of earlier versions). Only when each AI employee 〔preset〕 gets its own nickname, use `agents={[{ id: <preset id>, name }]}` (d.11) | Administrators only |
| Attachment settings | `AttachmentSettingsCard` (the roles and file types that may be attached; `endpoint` defaults to `/bridge/v1/admin/assistant/attachment-settings`; d.12) | Administrators only |
| External connectors (Admin › External connectors) | `ExternalConnectorsPage` (emergency stop, connections, templates, secrets 〔sent once; the list shows the last 4 characters〕, connection test, rules, run log; `base` defaults to `/bridge/v1/admin`; b.9) | Administrators only |
| Help (manual) | web-kit core's `manualChapters` / `parseMarkdown` (renders the same Markdown without injecting HTML; the target of `manualUrl` in AI answers, b.8) | All staff members |
| Approval, AI proposal and AI assistant panels | Not in the framework; build them per business. The **AI proposal** screen uses server-kit's routes: list `GET /bridge/v1/proposals` (`?status=pending_review` and so on; the person's own session), accept `POST /bridge/v1/proposals/{proposalId}/accept`, reject `POST /bridge/v1/proposals/{proposalId}/reject` (`{ comment }`). Only people in `roles.proposalReviewers` (by default, the readers of the report) can accept or reject, only once, and only on accept does the kit call `proposalKinds[kind].apply` in the same transaction. The **approval** screen uses the business system's own `/api/*` (`mayDecide` and `decide`, `t.revokeApprovalDeliveries`; b.2, b.3) | — |

```tsx
<WebKitProvider runtime={runtime}
  meIm={createMeImClient({ base: '/bridge/v1', weixinBase: '/api/me/im/weixin' })}   // same origin, the person's own session
  adminRpc={createAdminRpc('/dsh/api/dsh-im')}                                         // the BFF's DSH gateway
  strings={{ 'sns.title': '外部アカウント連携' }}>
  <SnsLinkPage isAdmin={user.role === 'admin'} notify={{ role: user.role, labels: manifestEventLabels }} />
</WebKitProvider>
```

**BFF rules** (enforced by the BFF and the business system; web-kit only hides components the person cannot change):

- Put `@dsh-bridge/gateway` **before** the `/api/*` proxy (`gateway.handleRequest(req, res)`; for WebSocket, `handleUpgrade`). `getSessionUser` calls the business API's
  login check (e.g. `GET /api/auth/me`) with the req's cookie. `isAllowed` is normally admins only (the DSH settings screens `/dsh/*`).
- Forward browser requests to the business system only for the routes that web-kit components call on the same origin and for the business `/api/*`: `/bridge/v1/me/*` (SnsLinkPage,
  NotifyPrefsCard), `/bridge/v1/admin/ai-profile*` (AiProfilePage), `/bridge/v1/assistant/attachment-settings` and `/bridge/v1/admin/assistant/attachment-settings`
  (attachments), `/bridge/v1/admin/connector*` (ExternalConnectorsPage), `/bridge/v1/proposals` and `/bridge/v1/proposals/*/accept|reject` (the AI proposal screen
  you build per business). Pass the person's cookie through as is, and **do not add `x-bff-secret`** (the business system authorises by the person's session and role).
- **MUST** add `x-bff-secret` only to calls the BFF itself builds on the server side: the web assistant ticket (`POST /bridge/v1/assistant/tickets`),
  attachment conversion (`POST /bridge/v1/assistant/attachments/prepare`, `callPrepare` of `prepareAssistantAttachments`), and registering a personal bot right after a `createOnly` creation
  through the self-service RPC has succeeded (`POST /bridge/v1/me/personal-bots`, d.9). Do not forward these requests when they come from the browser (if they were relayed with the secret,
  a browser could register an organisation bot's botId as its own personal bot, and every other staff member who talks to that bot would become "unlinked").
- AI assistant in the business web app: the BFF obtains a ticket, runs any attachments through `prepareAssistantAttachments`, and calls
  `gateway.rpc('/assistant', 'message.send', { ticket, agent, text, attachments }, { plugin: 'bridge-assistant' })` (`POST /api/bridge-assistant/assistant`).
  Never expose the ticket, the DSH cookie or the launch token to the browser. The personal WeChat QR uses `gateway.rpc('/weixin', 'provision.begin' | …)` (`begin | poll | verify | cancel` under
  `weixinBase` of `createMeImClient` are routes the BFF builds; if you do not use them, set `weixinBase: null`). In both cases, only what you list in `rpcAllowlist` gets through.
- If you offer personal bots, build a self-service RPC in the BFF (`POST /api/me/im/rpc/<channel>`). It is not a framework component, and there is no sample in the framework either
  (what to enforce is all of the MUSTs in d.9: a per-channel allowlist, `botId` only the person's own, narrowing the response's `bots[]` to the person's own, creating with `createOnly: true`,
  registering the new botId and deleting it on failure. CareBilling keeps it in `apps/care-web/me-im-rpc.mjs`). Before `bot.delete`, the BFF
  checks with the business API (`GET /bridge/v1/me/personal-bots`) that the bot belongs to the person.

### b.7 Enable automatic tasks (delegate)

An automatic-task turn has no IM sender, so by default it cannot read business data (`unattendedPolicy: deny`).
The operator chooses **one staff member** (linked via IM, with a role that can do the reads and proposals the task needs), and the tasks run under that staff member's delegation.

```sh
node profile/scripts/install.mjs --home <home> --enable-auto-tasks --auto-task-delegate <platform>:<userId>[:<teamId>]
node profile/scripts/install.mjs --home <home> --disable-auto-tasks [ids]
node profile/scripts/install.mjs --home <home> --auto-task-delegate off          # back to deny
# manifest playbooks (after DSH has started once and plugin-events has deployed them): specify the ids
node profile/scripts/install.mjs --home <home> --skip-install --enable-auto-tasks pb_equipment-inspection_overdue_followup
```

To use different delegates for different kinds of work, write a class in the playbook's `delegation` (`source.delegation` in templates) and choose a staff member per class:

```sh
node profile/scripts/install.mjs --home <home> --auto-task-delegate planning=line:<userId>,billing=line:<userId>,inspector=each[,default=line:<userId>]
```

- `<class>=<platform>:<userId>`: playbooks of that class run under that staff member's delegation (`unattendedDelegates` of bridge-tools).
- `<class>=each`: playbooks of that class (`delegation: <class>=each`) run **on each run under the delegation of the person themself named by the triggering event**. The business system
  answers `POST /bridge/v1/delegations { event: { id } }` by issuing a short-lived delegation to the person written in its own event (the business system decides which event types, how recent, and
  which personal settings qualify; in server-kit, `hooks.eventDelegations` (b.2). The DSH side cannot choose the staff member.
- A class with no staff member assigned uses `default` (= the former `unattendedOnBehalfOf`). Templates with `<class>=each` are not enabled by `--enable-auto-tasks` (ids omitted),
  only when named by id. While a class is not `each`, install.mjs warns that "tools will be rejected".
- Do not choose a broad role (such as administrator) as the delegate. If you list roles in `unattendedWarnRoles` of bridge-tools, a warning is logged once when a task runs under the delegation of such a role.

- `--auto-task-delegate` writes `unattendedPolicy: delegate` and `unattendedOnBehalfOf` (`unattendedDelegates` when classes are used) into the **product's own `bridge-tools` entry** of the installed `cordis.patch.yml`
  (`toolModules` and the rest stay unchanged; if the entry is missing, it is appended at the end). It survives reinstalls, and `off` restores the original.
- **This value applies only to the default application** (`default: true` in the registry, or the only app). For a non-default app, write by hand in the product patch's
  `bridge-tools` `applications: { <application-id>: { unattendedPolicy: delegate, unattendedOnBehalfOf: …, unattendedDelegates: … } }`
  (install.mjs does not write this field; sample in the template comments), or write it in the registry's `applications[].delegation`. Precedence: `bridge-tools.applications.<id>` → for the default app,
  the plugin-wide `bridge-tools` values → the registry. If you list several apps with `strict: true` and no `default`, `--auto-task-delegate` applies to no app,
  and automatic tasks silently stay without delegation (rejected) (`unattendedPolicy` in the plugins/tools README).
- Hand-written delegation (`unattendedPolicy: delegate` in `bridge-tools.applications.<id>` or in the registry's `delegation`) is treated by check.mjs as an **explicit opt-in**
  (rule `unattendedPolicy`; writing it alone makes Definition of Done 6 fail). Run Definition of Done 6 with `--allow unattendedPolicy`, and leave the reason
  (which class is entrusted to a staff member with which narrow role) in a comment above that line of the patch. The value that `--auto-task-delegate` writes into the install target
  does not go into the product patch (source), so it does not need this treatment.
- plugin-events deploys manifest playbooks as `pb_<application-id>_<playbook>` (new ones are disabled). `--enable-auto-tasks <ids>` /
  `--disable-auto-tasks <ids>` also work on deployed playbooks, but **only when the ids are given explicitly**.
- **A playbook's `agent` (e.g. `facility-inspection`) becomes a dedicated conversation preset**. Define that preset in the product profile.
- Only reads and the proposals listed in the task's `source.tools` (the playbook's `tools`) are allowed. Proposals and audit records are in that staff member's name.
  If bridge-tools is loaded, the read tools that bridge-apps generates from the manifest are also authorised through `ctx.bridgeTools.gate(<appId>)`, so
  automatic-task delegation (and the subject of scheduled reports) applies in the same way to generated tools and hand-written tools.
- Tasks owned by the deployment are `profile/template/auto-tasks/*.json` (format in `profile/template/auto-tasks/README.md`).
- auto-tasks re-reads `tasks.json` on every event (enabling needs no restart). Changes to delegation (patch) and to plugin code need a DSH restart.

### b.8 The manual and how-to questions over chat (help)

When a staff member asks over chat "Where is X?" or "How do I do X?", the AI secretary answers based **only on the business system's manual**, with **the URL of a screen that person
can open**. Accuracy is kept by "the manual does not drift from the screens (CI)" and "the AI never makes up URLs (only paths from the index, checked before sending)".

1. **Manual**: `docs/manual/NN-*.md` (the location is up to you; equipment-inspection uses `manual/`). One screen = one section (`## Screen name`, `<a id="manual-…"></a>`, a table: URL, menu, roles that can use it, related screens,
   keywords; body: what you can do, steps, cautions, FAQ). The format is in `packages/help/README.md`. Synonyms go in `_synonyms.yml`,
   and routes without a section go in `_exclude.txt` (write the reason).
2. **Index and CI**: a script reads the manual and **the business system's route table** (`[{ path, roles }]`, from the router and Guards),
   runs `buildHelpIndex` → commit the JSON. In CI, compare it with `serializeIndex(buildHelpIndex(...))` and check that `check*` (routes, coverage, roles, menu names, anchors,
   links, notification links) is empty. The same script writes the manifest's `web.routes` (`setManifestWebRoutes(text, routes)`: if the manifest has
   `web:`, it replaces the `routes` inside it; otherwise it adds `web:` before `roles:`). Keep the routes listed in `_exclude.txt` in the route table too (removing them from the table makes
   `check*` fail with "exclusion … is no route any more").
   The sample equipment-inspection uses a simplified form: it has one screen (`/`), so the index is built at startup in `src/help.mjs` (neither committed nor compared with `serializeIndex`), and
   `test/help.test.mjs` only checks that `check*` is empty and checks the answers. The manifest's `web.routes` is written by hand with the same value as the screen table (`/` only) (b.5 item 9).
   Systems with many screens commit and compare the index and write `web.routes` (CareBilling uses `tools/manual-index.mjs`).
3. **API**: with server-kit, `createBridgeApp({ help: createHelpService(index, { webBase, roleLabels, manualPage }) })`.
   If you log questions with `help.onQuestion`, do not keep personal data (CareBilling keeps only text that passed the PII check, for 90 days).
4. **manifest**: `help: { tool: <ns>_help_search }`, and that tool (`GET /bridge/v1/help/search`, read, all roles) in `tools`.
   DSH generates this tool as the manual search. Paste the text returned by `helpRules('<ns>_help_search')`
   (`@dsh-bridge/dsh-core`) into the AI employee persona (the `prefix` of the preset in the product profile) (YAML cannot call functions, so print it once with node and copy it; b.5).
5. **DSH**: put the business web app URL (the same value as on the side that builds the answer URLs) in bridge-identity's `linkGuard`: `webUrl` for the default app, **`webUrls.<application-id>`
   for the other apps**. For an app with no URL, link checking does nothing (fail open. For an app that has `web.routes` but no URL,
   bridge-identity warns once, at that app's first AI answer), so
   write it for every app (`link_guard` in check.mjs verifies this). Checking works only when there is both a URL and `web.routes` (2) in the manifest.
   Answers from public sections to unlinked senders (`publicHelp`) are enabled when the manifest has `help`.
6. **Business web app**: put the help screen at `manualPage` (default `/help/{chapter}#{id}`) (render the same Markdown with web-kit core's `manualChapters`).
   That route also goes into `web.routes`.

**Rules**: write answers only from the returned sections (if found=false, say that nothing was found and do not invent steps). Use the returned URLs as they are. For screens the person cannot open,
do not give the URL; tell them to ask a role listed in `alt`. Answer questions about business data with the business tools.

### b.9 External connectors (connections, operations, rules)

A mechanism for AI employees to use your company's other APIs and third-party APIs (accounting, attendance, maps, CRM and so on) (optional; the design and decisions are in docs/AI_EMPLOYEE_PROFILE.md §3 and
"Implementation record (P2, P3)"). **Both the secrets and the calls live in the business system**: the AI and DSH do not know the connection URLs or API keys; they only call the business system's routes under delegation.

1. **server-kit**: `createBridgeApp({ connectors: { secretKey, allowLocalhost?, onApprovalNeeded?, onProposeByAi?, onRunResult? } })`.
   `secretKey` is key material of 32 characters or more (API keys are sealed with AES-256-GCM and stored). Pass it from an environment variable; never write it in the repository or yml (equipment-inspection uses
   `EQUIPMENT_CONNECTOR_KEY` and rejects the default value in production). `allowLocalhost` is for development only. The tables are `bridge_connector*` (`store.migrate()`).
   Routes: `GET /bridge/v1/connectors/catalog` (service, etag; no URLs or secrets), `POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run`
   (delegation, **read only**; role ∈ `operation.roles`; a write gets 403 `write_requires_approval`), and for administrators (`roles.admins`) `/bridge/v1/admin/connectors*`
   (connections, secrets, connection test), `/admin/connector-rules*`, `/admin/connector-runs` and `/admin/connector-settings` (emergency stop).
   A proposal kind `connector_write` is added (do not use the same name in your own `proposalKinds`).
2. **Rules**: add `kit.connectors.tick()` to a `startScheduler` task (every minute; b.3). A trigger is a manifest event or cron; conditions are only equals, contains, greater/less than and exists;
   `mode` is `approval` (default) / `auto` (only reads, and idempotent writes that an administrator has allowed with a written reason) / `propose-by-ai`. Events from before the feature was enabled are ignored.
3. **Write operations need human approval**: AI tools do not execute writes; they create a `connector_write` proposal (the business system executes it on accept; on failure, 502 `connector_failed`, and the proposal stays pending).
   A rule's `approval` hands off to the business system's approval mechanism (approvals and recipient rules in b.2) through `onApprovalNeeded({ proposal, connector, operation, rule, approverRole }, ctx)`.
   `propose-by-ai` starts a business-system automatic task through `onProposeByAi` (if absent, it is treated as approval). Results go to `onRunResult` (status and category only).
4. **DSH**: with `paths: v1`, the routes `connectorCatalog` / `connectorRun` / `connectorPropose` stay at their defaults. bridge-tools builds `<namespace>_ext_<connection>_<operation>`
   from the catalog (read runs under the person's delegation, write becomes a proposal; `connectorTools` / `connectorRefreshSeconds`). Never write connection URLs or secrets in the DSH profile.
5. **Business web app**: web-kit `ExternalConnectorsPage` for the admin-only "External connectors" screen. The BFF forwards `/bridge/v1/admin/connector*` with the person's cookie as is and without the secret (b.6).
6. The rules are in d.13. Start with one or two reads.

### b.10 External mode: put the bridge outside the existing system (trial)

> **Trial** (added 2026-10-30): not yet validated on a real system (PoC). It will change based on the validation results. The release conditions (52 / 52, empty `knownGaps`, no skips)
> do not change. The rationale is in [EXTERNAL_LAYER_FEASIBILITY.md](EXTERNAL_LAYER_FEASIBILITY.md) (in Chinese).

In this form you do not touch the existing system's code; instead you put a **bridge-only service** (the external bridge) outside it, which calls the existing system's API and exposes Bridge v1.
The external bridge is built on server-kit, and the `bridge_*` tables live in the external bridge's own DB. From DSH's point of view the external bridge is the business system, so
the DSH, plugin and IM sides do not change.

```mermaid
flowchart LR
  D["DSH<br/>(unchanged)"] -- "Bridge v1" --> X["External bridge<br/>server-kit, bridge_* tables<br/>ingested change IDs"]
  X -- "API (as the person)" --> L["Existing system<br/>(code unchanged)"]
  L -- "webhook / CDC<br/>(after commit)" --> X
  L -. "Login (IdP)" .- X
```

**Is it a fit? Decide by four capabilities of the existing system**

| Capability | Items used (table at the top) | If missing |
|---|---|---|
| Login can be verified from outside (an OIDC / SAML IdP, or an endpoint that returns "who this session is") | 3 (chat linking), 8 (session) | 3 cannot be met. No separate login may be built (the MUST in 3), so external mode cannot be used |
| The API can be called as the person (per-user OAuth tokens, token exchange 〔RFC 8693〕, a trusted delegated identity) | 1 (reads), 6, 7 | Per-record permissions would have to be copied into the external bridge. Limit reads to the scope determined by role alone, and do not use approvals or writes |
| Change notification (a webhook meeting the conditions below, or reading the DB transaction log) | 5 | Events that need accuracy, such as approvals, cannot be emitted. Only status notices by polling (item 4 of ingestion below) |
| Approval and write APIs | 1 (the proposal's `apply`), 7 | Accepting proposals and approving in chat are not possible |

- **Type A** (all four; most SaaS and recent web systems): external mode can meet every item in the table at the top.
- **Type B** (has an API but it cannot be called as the person, or there is no change notification): up to status notices, scheduled reports and read questions. If 7 (approval) cannot be met, you do not reach 52 / 52
  (A1–A4 are skipped), so for a release either add what is missing to the existing system or rebuild with b.0.
- **Type C** (screens only: server rendering only, desktop clients, terminals): do not use external mode. Writing through screen automation (RPA) is fragile
  and cannot be audited. Add an API to the existing system, or build with b.0.

**Items met differently in external mode** (numbers of the table at the top; the other items stay as in b.1–b.9)

| # | How it is met in external mode |
|---|---|
| 1 | Read tools are external-bridge routes that internally call the existing system's read API **as the person**. Proposals live in the external bridge, and only when a person accepts does `proposalKinds[kind].apply` call the existing system's write API as the person who accepted |
| 3 | The external bridge serves the chat-linking screen (web-kit). Login is done as a relying party of the existing system's IdP via OIDC / SAML, or by verifying the existing system's session through the "who" endpoint. `authenticate(req)` returns **the existing system's staff ID**. **MUST** not create a separate password or a separate ID scheme |
| 4 | `recipientsFor` decides by fetching the person in charge, approvers and affiliation from the existing system's API. **MUST** not invent assignment rules in the external bridge when these cannot be fetched (they would drift from existing operations). Do not notify for that event |
| 5 | **Trial rule: event ingestion** below |
| 6 | `employees.get / list` come from the existing system's staff API (including active/inactive). **MUST** not cache `employees.get` (a deactivated staff member must lose all tokens immediately: D7, S5). **MUST** not call read APIs with an all-powerful service account and filter in the external bridge (the per-record permission check would live in two places, breaking "the same check as the web authorisation" in 4) |
| 7 | `approvals.mayDecide / decide` call the existing system's approval API as the person. **MUST** not copy approval rules into the external bridge. Once the existing system has decided, write `approval.decided` in an external-bridge transaction and invalidate the IM card with `t.revokeApprovalDeliveries`. For approvals decided on the existing system's screens, do the same through ingestion (below). Only for business that has no approval in the existing system may a minimal approval live in the external bridge (there are no rules to copy, so nothing is duplicated) |
| 8 | `isSessionLive` calls the existing system's session-check endpoint |

**Trial rule: event ingestion (a variant of item 5 in the table at the top)**

Item 5 in the table at the top and the "same transaction" of b.3 exist because picking up differences afterwards leads to "notifying changes that were never committed and dropping changes that were committed".
The external bridge is not inside the existing system's transaction, so it cannot meet them literally. In external mode only, the following sources are allowed, because they can ingest **only committed changes, without dropping
or duplicating any**.

1. The **source** is one of the following.
   - **(a) Same transaction** (b.3), when you can write inside the existing system. Not the main form of external mode.
   - **(b) DB transaction log (CDC)**: PostgreSQL logical replication, MySQL binlog, SQL Server CDC and so on. Only committed changes flow, in commit order.
     Needs read permission on the existing system's DB (the existing system's code does not change).
   - **(c) A webhook meeting all of the following**: ① sent after commit　② each change has a unique, immutable ID (change ID)　③ resent until the receiver
     returns 2xx　④ the sender can be verified, e.g. by a signature　⑤ there is a way to fill gaps later (an API to re-fetch by change ID or by time).
2. **MUST** ingestion writes "the record of the ingested change ID" and `kit.emitEvent` in **one transaction** of the external bridge. From the second time for the same change ID onwards,
   it does nothing (decided by a unique constraint). This makes the path from the existing system's commit to the Bridge event "no drops, no duplicates".

   ```js
   // the external bridge's own table (not bridge_*): create table legacy_change (source text, change_id text, primary key (source, change_id))
   export async function ingest(kit, change) {        // change = only the change ID, IDs, date and status extracted from one webhook / CDC item
     return kit.tx(async (t) => {
       const { rowCount } = await t.db.query(
         'insert into legacy_change (source, change_id) values ($1, $2) on conflict do nothing', ['billing', change.id])
       if (rowCount === 0) return { duplicate: true }    // second time onwards: do nothing
       await kit.emitEvent(t, {
         type: 'invoice.submitted', aggregateType: 'invoice', aggregateId: change.invoiceId,
         payload: { invoiceId: change.invoiceId, submittedOn: change.date },   // allowlisted keys only
       })
       return { duplicate: false }
     })
   }
   ```

   - Needs the PostgreSQL store (`createPostgresStore`) (`t.db` is the connection of that transaction; in the memory store, `t.db` is null).
   - For a webhook, return 2xx only after ingestion has committed (returning first drops the change if ingestion fails).
   - If the manifest rejects the event (`EventRejected`), no change-ID record remains either, and the resends keep coming. This is a configuration error, so monitor the failure count so that you notice it.
3. **MUST** build only the manifest's allowlisted keys from the existing system's values and pass them to `emitEvent` (no names, free text or health data; d.2).
4. **MUST** use polling (periodically reading differences by `updated_at` and the like) only for status notices that do not need accuracy (e.g. "there are N unprocessed items"). It drops intermediate states and deletions,
   so do not use it for events where a drop hurts, such as approvals (`approval.requested` / `approval.decided`), deadlines and changes of amounts. Write in the external bridge's README which types
   are emitted by polling.
5. **SHOULD** measure the delay from the existing system's commit to the Bridge event, set an upper limit (e.g. 1 minute) and monitor it. For CDC position lag and webhook failures, output counts only (not contents).
6. **SHOULD** keep in mind that webhooks often do not guarantee order. If an older change for the same aggregate (`aggregateId`) arrives later, re-read the existing system's current state before emitting
   (not needed for CDC, which is in commit order).

**conformance (b.4)**

- Use the 52 items as they are. `BRIDGE_BASE_URL` is the external bridge. The release conditions are the same.
- The fixtures create business activity in the existing system's TEST environment and return **after waiting until ingestion has finished** (`produceEvents`, `emitNotifiableEvent`, `createPendingApproval`).
  `newEmployee`, `deactivateEmployee` and `revokeSession` are done on the existing system's side.
- The 52 items do not check ingestion's "no drops, no duplicates". At a minimum, check it in the external bridge's tests: the same change sent twice gives one event / ingestion
  stopped before commit gives one event after the resend / 2xx comes after commit / the types emitted by polling include no approval, deadline or amount events.

**Afterwards: migrate the business one piece at a time** (Strangler Fig)

Run the AI employee first in external mode, then move the business one piece at a time to a new system per b.0 (on server-kit). For each migrated piece, switch the internals of the hooks from the existing system's API
to the new tables, and bring the events back into the same transaction as in b.3. Bridge v1 is the seam, so the DSH side stays unchanged at every stage, and the 52 items can be re-run each time.

**Cautions during the trial**

- server-kit has no external-mode-specific components yet (a client for the existing system's API, an ingestion component, an OIDC / SAML `authenticate`). As in the example above,
  you can write them today with `kit.tx`, `kit.emitEvent` and hooks. Keep safeguards for calling the existing system's API (allowed hosts only, timeouts, rate limits) along the same lines as
  `createConnectorRunner` (b.9). Whether to turn these into components will be decided after the PoC.
- In external communication, you may say only as much as "if the existing system has SSO, an API and change notification, it can be connected without changing the existing system's code". Do not say "any system
  can be connected without changes" (types B and C cannot).

### Checklist

- [ ] `bridge-validate manifest --strict` exits 0 (no warnings)
- [ ] Every state change uses `kit.tx` + `emitEvent` (payload allowlist only). In external mode (trial), the sources and ingestion of b.10 (change ID and event in one transaction, polling only for status notices)
- [ ] For a new system: the location and dependencies follow one of the options in b.0, and nothing inside the framework (packages, plugins, vendor, profile/template) has been rewritten
- [ ] The manifest declares `approval.requested` / `approval.decided` / `sns_identity.unlinked` with the payloads of b.1
- [ ] conformance 52 / 52, empty `knownGaps`, no skips (reports, approvals, personal bots, both proposal kinds and the fixtures' copy of the roles are all in place; b.4)
- [ ] Registry: `system.id` = app id, tools are `<namespace>_*`, all bots listed (`strict: true`), tokens only as environment variable names
- [ ] Message wording: `intent` on every template, `action` for action / urgent
- [ ] DSH-side code (toolModules, templateModules, custom plugins) does not touch the business DB or the business system's secrets, and uses only `kit.requestJson` / `kit.proposeTool` (d.1)
- [ ] Business web app: screens for chat linking, notification settings, approvals and proposals (proposals use `GET /bridge/v1/proposals`, `…/{id}/accept`, `…/{id}/reject`; b.6). The BFF adds `x-bff-secret` only to its own calls (ticket, attachment conversion, personal-bot registration after createOnly) and does not relay browser requests with the secret (b.6)
- [ ] Automatic tasks: delegation classes and staff members (or `<class>=each`) decided (non-default apps written by hand in `bridge-tools.applications.<id>`, with `--allow unattendedPolicy` and a reason comment for check.mjs; b.7), prohibitions written in the playbooks, presets for the playbooks' `agent` defined in the product profile
- [ ] Recipients: for every notifiable event, `recipientsFor` decides the scope and the gate checks it. If the scope cannot be decided, nothing is sent (d.8)
- [ ] Outbound settings: the template's closed values ("product values" in d.8) are kept (no fixed delivery targets, mail, model-chosen recipients or copies of launch replies). Every opened setting is an explicit opt-in with its reason written down
- [ ] No names, free text, health data or Japanese sentences in payloads or template arguments (d.2)
- [ ] If personal bots are used: self-service RPC, `createOnly`, excluded from the admin list. The owner rules for lookups are in server-kit (mandatory for your own implementation; d.9)
- [ ] Link checking: `linkGuard.webUrl` (default app) or `linkGuard.webUrls.<id>` for every app (`link_guard` in check.mjs) **and** `web.routes` in the manifest (it works only when both are present; b.5, b.8)
- [ ] With two or more apps: for each non-default app, `applications.<id>.webUrl` (and `bots`) of `bridge-notify` / `bridge-approvals`, `agents[].application` of `bridge-assistant`, `linkGuard.webUrls.<id>`, and automatic-task delegation (b.5 item 10)
- [ ] If how-to questions are answered over chat: manual CI (index up to date, `check*` empty), `help.tool` and `web.routes` in the manifest, the `helpRules` text in the persona (b.8)
- [ ] Long-term memory (bridge-memory, included by default in the profile template): `POST /bridge/v1/pii-scan` exists (server-kit has it by default). Systems that hold names implement the roster check `hooks.piiScan`. Organisation memory classes and retention periods decided. The AI employee presets can use the `memory_*` tools (d.10)
- [ ] AI employee profile (bridge-persona, included by default in the template): `GET /bridge/v1/ai-profile` and the admin routes exist (server-kit has them by default; your own implementation validates, versions and audits with `validateAiProfile`). The business web app has an admin-only "AI employee settings" screen (web-kit `AiProfilePage`, one nickname by default) (d.11)
- [ ] File attachments to the AI assistant (optional): `/bridge/v1/assistant/attachments/prepare`, `attachment-settings` and the admin routes exist (server-kit has them by default; your own implementation checks and converts with `@dsh-bridge/server-kit/extract`), the handling of scanned PDFs decided (`attachments.ocr`: OCR engine / images to the default model / `false`), the BFF uses `prepareAssistantAttachments`, the panel has `AssistantAttachmentPicker` and a one-line note on where files are sent, answers use `AssistantMarkdown`, administrators get `AttachmentSettingsCard` (d.12)
- [ ] External connectors (optional): `connectors.secretKey` from an environment variable, writes need approval (`connector_write`, `onApprovalNeeded`), the rules task (`kit.connectors.tick()`), `ExternalConnectorsPage` for administrators (b.9, d.13)

### Definition of Done (verified by commands)

The checklist items that can be verified by commands. **Each is either a command the framework has today or a test the business system writes itself**. The framework's e2e, which checks the DSH side end to end
with a real DSH (`pnpm run e2e`, a.3), is **currently specific to equipment-inspection** (the app id is hard-coded in `packages/testing/e2e/run.mjs`), so
the completion of a new system or a connected system is judged by conformance (2) and the business system's own tests (3–6).

| # | What | Command | Pass |
|---|---|---|---|
| 1 | manifest | `node <framework>/packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict` | exit 0 (with `--strict`, warnings also give exit 1. Without it, warnings still give exit 0, so it does not count as passing) |
| 2 | conformance | Start the TEST environment, then `BRIDGE_BASE_URL=… BRIDGE_SERVICE_TOKEN=… BRIDGE_BFF_SECRET=… BRIDGE_FIXTURES=./test/fixtures.mjs BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml node --test <framework>/packages/protocol/conformance/http.test.mjs` (the same as `bridge-validate conformance`). In CI, follow the form of equipment-inspection's `test/conformance.test.mjs` (startup, temporary DB and cleanup in one test) | The summary is `52 passed, 0 known gaps, 0 skipped` |
| 3 | The business system's own tests | `node --test test/*.test.mjs` (on Windows, `--test-isolation=none`) | All pass. At a minimum: state change and event in the same transaction (if the manifest rejects the payload, the business row does not remain either), the `recipientsFor` gate (staff outside the scope are not included; `stale` when the situation changes), web approval uses `mayDecide` and is decided exactly once, business writes with a delegation token get 403 `delegation_not_permitted`, the BFF does not relay the browser's `POST /bridge/v1/me/personal-bots` with the secret, `hooks.piiScan` returns a category for names on the roster |
| 4 | Manual (if used) | In the business system's tests, `checkAnchors`, `checkSectionPaths`, `checkCoverage`, `checkRoleText` and `checkLinks` are empty; if the index is committed, `serializeIndex(buildHelpIndex(...))` equals the committed index (the sample `examples/equipment-inspection/test/help.test.mjs` checks only `check*`; it is the simplified form that builds the index at startup; b.8) | Empty, equal |
| 5 | Product profile | `node <framework>/profile/scripts/install.mjs --source <product profile> --home <temporary directory> --profile <name> --skip-install` (a personal `~/.dsh` is rejected) | No `template placeholders left` warning |
| 6 | Outbound settings are closed | `node <framework>/profile/scripts/check.mjs <your profile>/cordis.patch.yml` (closed values, opened values, bundled coding presets disabled, leftover `<placeholder>`; every app in the registry has a linkGuard URL 〔rule `link_guard`〕. Use `--allow <rule>` only for intended opt-ins; hand-written automatic-task delegation needs `--allow unattendedPolicy`, b.7). The other half of link checking (the manifest's `web.routes`) is written on the manifest side in 1 | exit 0 |
| 7 | Fixed delivery targets are rejected | Add `--auto-task-target x` to the command in 5 | exit 2 |
| 8 | Business web app (web-kit) | `tsc --noEmit` for the business web app (web-kit ships as `.ts`) | No errors |
| 9 | The framework itself (only when you changed the framework) | `pnpm validate` and `pnpm test` at the framework root | ok, fail 0 |

Checks with a real IM and real models are manual (e, g).

---

## c. Extension points

| Extension point | Where | What you add |
|---|---|---|
| `toolModules` | `bridge-tools` settings (or `ctx.bridgeTools.register(appId, factory)`) | Hand-written tools. `export default (kit) => [kit.defineTool(...), kit.proposeTool(...)]`, `export const application = '<id>'` |
| `templateModules` | `bridge-notify` settings (or `ctx.bridgeNotify.registerTemplates(appId, module)`) | Notification message wording: `types` (types not in the manifest), `templates[<template>]` (fact sentence, intent, ask, due, note), `render(input)` (a whole message) |
| `aiReportPrompt` / `aiReportRoles` / `aiReportCommand` | `bridge-notify` (overridden per `applications.<id>`) | Instructions to the AI for the scheduled report, the roles that may use it, the keyword (default 「定時報告」 (scheduled report)) |
| `messages` / `unlinkedReply` | `bridge-identity` settings, registry `applications[].messages` (takes precedence) | Replies such as the guidance to unlinked users and the linking-complete reply |
| `linkKeywords` / `switchWords` / `switchMessages` | `bridge-identity` | Linking keyword (default `連携`), words for the shared bot's switch commands (`list` / `current` / `help`) |
| `replyWords` | `bridge-approvals` | Words that decide by reply (default `{ approve: [承認], reject: [差戻] }`). Button names and guidance use the same words |
| Card `wording` | business system (return value of `approvals.card`, Bridge v1 `Card.wording`) | Sentences per approval type: the sentence after the greeting (`lead`), the request (`ask`), button descriptions, the reply and body after the decision (up to 300 characters each; no names or amounts) |
| `groupChat` / `messages.groupChat` | `bridge-identity` / `bridge-tools`, registry `applications[].groupChat` | Group conversation policy (`deny` default / `allow`) and the guidance text (default 「業務の内容は個別チャットでお尋ねください。」 (Please ask about business matters in a one-to-one chat.)) |
| `audienceText` / `audienceLink` / `aiReportGuard` / `aiReportLink` | `bridge-notify` (`applications.<id>`) | Fixed message wording and its link for automatic task reports and scheduled reports (d.8) |
| `contextIds` / `roleLabels` / `agents` | `bridge-assistant` | Context IDs of the assistant screen (added to the `<entity>Id` of the manifest `entities`), role display names, per-app AI employees |
| `pathProfiles` / `compat` | `bridge-apps` | Paths for systems not on `/bridge/v1` (`{ base?, identity, link, delegations, … }`). `compat: [care-billing-paths]` is CareBilling's legacy paths |
| `platformPriority` / `bots` / `webUrl` | `bridge-notify` / `bridge-approvals` (`applications.<id>`) | Delivery platform priority, sending bot, origin added to relative links, approval screen URL (`{id}`) |
| `digestTypes` / `digestWindows` / `digestMinutes` / `realtimeSettleSeconds` / `realtimeDigestSeconds` | `bridge-notify` | Digest sending settings |
| `notifyTypes` / `manifestNotify` / `deployPlaybooks` | `bridge-events` / `bridge-notify` | Notification types outside the manifest; the range of apps that use manifest notifications and playbooks (`all` / `others` / `none`) |
| `strings` / `platformLabels` / `notify.types` | web-kit `WebKitProvider` / `SnsLinkPage` | Screen text, platform display names, descriptions and groups of notification types |
| `toolKind` / `denyHints` / `unattendedTools` | `bridge-tools` (`applications.<id>`), dsh-core tools-sdk | Denial wording; the upper bound of proposal tools that automatic tasks may use |
| `connectorTools` / `connectorRefreshSeconds` | `bridge-tools` | Whether to build `<namespace>_ext_*` from external connector operations (default true), interval for re-fetching the list (default 60 seconds; b.9) |
| `linkGuard.webUrl` / `webUrls` / `allowHosts` | `bridge-identity` | Checking links in AI answers: business web app URL of the default app / of each app, other hosts that may be kept (b.8, d.8) |
| `imageCleanup` / `imageCleanupMinutes` / `dshHome` | `bridge-assistant` | Cleanup of images sent from the panel (d.12) |
| `hooks.piiScan` / `connectors` / `attachments.ocr` | server-kit `createBridgeApp` | Roster check for personal data (d.10), external connectors (b.9), handling of scanned PDFs (d.12) |
| `stateDomain` / `actionPrefix` / `aiReportTargetPrefix` / `switchStatePath` / `rpcName` / `errorCodes` / `apiErrorPrefix` / `audienceSource` | `bridge-events` / `-notify` / `-approvals` / `-identity` / `-assistant` | Take over an existing deployment (a DSH_HOME that ran on its own plugins): storage domain name, button IDs of already-sent cards, dsh-im delivery target ID, shared-bot state file, admin RPC name and error codes, report errorCode, how recipients of automatic task reports are determined. Keep the defaults for new deployments |
| `messages` / `aiReportMessages` / `switchMessages.helpExample` / `agents[].sessionTitle` | `bridge-approvals` / `-notify` / `-identity` / `-assistant` | Error and scheduled-report replies, usage example, DSH conversation title |

Example tool module (business data is read only with `kit.requestJson`, and writes are only `kit.proposeTool` proposals. It does not touch the business DB or secrets. d.1):

```js
// my-app-tools.js
export const application = 'my-app'
export default (kit) => [
  kit.defineTool({ name: 'myapp_count_open', description: 'Read-only: open items count.', async execute() {
    return { ok: true, data: await kit.requestJson('myapp_count_open', '/api/open-items') } } }),
  kit.proposeTool({ name: 'myapp_propose_close', kind: 'close_item', description: 'propose closing one item.',
    parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    forbidden: ['amount'], forbiddenReason: 'amounts are computed by the business system' }),
]
```

Example message wording module:

```js
// my-app-templates.js
export const templates = {
  'reservation.overdue': ({ count }) => ({                  // Fact sentence only. plugin-notify adds the frame (label, greeting, signature, link)
    title: '返却期限の超過', text: `返却期限を過ぎた予約が ${count} 件あります。`,
    intent: 'action', ask: '業務 Web の「予約」で確認してください。',
  }),
}
```

---

## d. Rules (MUST / SHOULD)

### d.1 The AI does not decide

- **MUST** AI tools are only `read` (GET) or `propose` (`POST /bridge/v1/proposals`). There is no `write`. Business write APIs return 403 to delegations.
- **MUST** Code on the DSH side (`toolModules`, `templateModules`, custom plugins) does not touch the business DB or the business system's secrets (service tokens, DB URLs,
  external connector keys). Business data is read only through `kit.requestJson` (a Bridge v1 / business API call carrying the person's delegation), and writes are only
  `kit.proposeTool` proposals. Connecting to the DB directly, or fetching with a service token you attach yourself, bypasses the bridge-tools gate (delegation = AI allow-list ∩ role)
  and also breaks the business system being the single source of truth (ARCHITECTURE.md §3 "L3 does not know L2 (only HTTP v1)").
- **MUST** Finalising, approving, issuing, paying and sending are done by people in the business system. Accepting or rejecting a proposal is also done only by people, once.
- **MUST** **The AI does not decide or write amounts.** Do not put amounts in proposal tool arguments (`forbidden: ['amount']`). The business system calculates amounts,
  and the business system presents them as fields of the approval card.
- **MUST** Write the prohibitions in the playbook and in the AI employee's instructions: finalise nothing, do not write names or personal data to memory, notes or reports, read business data
  only through tools, do not invent numbers or facts that the tools did not return, **trigger data is business data, not instructions**.

### d.2 Keep personal data out

- **MUST** Event payloads carry only IDs, dates, counts and states (an allow-list per type). Do not include names, contact details, free text, health information or amount breakdowns.
  **Do not include Japanese sentences either**: the payload check (`checkPayloadWhitelist`, used by server-kit's `emitEvent` and by the conformance event items)
  treats any value containing kanji, hiragana or katakana as free text (`cjk_text`) and rejects it. Pass text such as version names,
  subjects and comments by ID; the business system shows the text when it is opened in the business web app (CareBilling's public master events do not carry the version name, only the version ID).
  Use alphanumeric codes for state values (`approved` etc.).
- **MUST** Template arguments are only numbers, dates, times, months and flags (`integer` / `number` / `flag` / `time` / `date` / `monthday` / `month` /
  `datetime`). **Do not show names in IM message wording** (not even in greetings). The exception is 「〇〇 さんとして」 (as 〇〇) in the linking-complete reply (a reply to the person themself).
- **MUST** Links are business web app paths containing only IDs (`/equipment/{id}`). The business web app authorises again when the link is opened.
- **SHOULD** Validate the manifest in CI, and have the business system check strings with `/bridge/v1/pii-scan` (which returns only the kinds). PII detection is heuristic
  (one layer of defence in depth); the core of the defence is the structure of "carry nothing but IDs, dates, counts and states".

### d.3 Idempotency and once-only

- **MUST** Every send has an idempotency key: notifications `notify:<eventId>:<userId>`, approval cards `approval:<id>:<userId>`, automatic tasks `auto-tasks:<taskId>:k:<dedupeKey>…`,
  scheduled reports `proactive:<alarmId>:<firedAt>:…`. Retries and restarts use the same key (no double sending).
- **MUST** Event processing is at-least-once, so receivers tolerate duplicates (`dedupeKey`, the notification's `<eventId>:<userId>`, the `dedupeKey` of `recipientsFor`).
- **MUST** An approval is **finalised by the decision of any one person**, and all other cards become invalid. Cards are also invalidated when the decision is made on the web.
- **MUST** Link codes, card tokens and reply codes are single-use. Wrong attempts are counted and lead to a lock.

### d.4 Quiet hours and send times

- **MUST** Respect the person's quiet hours (`quietHours`). Only types marked `notify.quiet: exempt` in the manifest (such as safety checks) may be delivered at night.
  `honorQuietHours: false` is for verification only.
- **SHOULD** Send frequent types as digests (`digestMinutes` / `digestTypes`): one message saying 「N 件まとめてお知らせします。」 (Here are N items together.).

### d.5 AI secretary message wording

Shape (4–6 lines on a smartphone, no emoji; "▶" and the "—" of the signature are symbols):

```
【ラベル】件名                        ← line 1: [label] subject (on a card: the subject)
<あいさつ><事実の文>                  ← <greeting><fact sentence>: counts, months, dates only. In a digest: 「N 件まとめてお知らせします。」
▶ お願いしたいこと（目安）：…         ← action request / urgent (what, where)
ご対応は不要です。…                   ← report
こちらから開けます：<URL>             ← when there is a link (a button on a card)
— <アプリ名> AI 秘書                  ← signature: — <app name> AI secretary (without an app name: 「— AI 秘書」)
```

| Label | intent | When to use |
|---|---|---|
| 【ご報告】 (Report) | `info` | Information only. Closes with 「ご対応は不要です。…」 (No action is needed. …) |
| 【対応のお願い】 (Action requested) | `action` | Someone's judgement or operation is needed. 「▶ お願いしたいこと：何を・どこで（画面名）」 (▶ What we ask: what, where (screen name)); a target date only if it is in params |
| 【至急】 (Urgent) | `urgent` | Safety checks, visits not started, serious incidents, etc. |
| 【承認のお願い】 (Approval requested) | (approval card) / `approval` | The plugin-approvals approval card. A deadline only when `expiresAt` exists. A text notification without buttons (e.g. handing over to another person because the only possible approver is the person themself; the decision is made in the business web app) uses `approval` |
| 【ご相談】 (Consultation) | `consult` | Matters where you want help thinking through a decision (notices of actions still unresolved past their deadline, checking decision material, etc.). Closes with the same 「▶ お願いしたいこと」 as action |
| 【定時のご報告】 (Scheduled report) | (scheduled report) | Split into 「■ 対応が必要なこと」 (■ Needs action) and 「■ ご参考」 (■ For reference) |
| 【ご案内】 (Guidance) | (AI answer) / `info` | Answers to how-to questions about the system (where a screen is, steps). The only basis is the business system's manual search tool, and links go only to screens the tool returned (bridge-identity's link check drops anything not in `web.routes`) |

- The greeting depends on the send time (system timezone): 5:00–9:59 「おはようございます。」 (Good morning.), 10:00–20:59 「お疲れさまです。」 (Thank you for your work.), 21:00–4:59 「夜分に失礼します。」 (Sorry to disturb you so late.).
- **Do not invent dates**: target dates and deadlines only when they are in params. 「本日中」 (by the end of today) only for undated actions where it is clear in business terms.
- On a shared bot (personal WeChat), 【アプリ名】 (app name) is prefixed (`【設備点検】【対応のお願い】…`).
- Use `frameMessage` / `frameAiText` / `noticeCard` from `@dsh-bridge/dsh-core` for the frame; do not assemble it yourself.

Sample (info, digest):

```
【ご報告】点検の完了
お疲れさまです。3 件まとめてお知らせします。
本日の点検が 3 件完了しました。
ご対応は不要です。業務 Web の「点検記録」でご確認いただけます。
こちらから開けます：https://inspection.example.jp/inspections
— 設備点検 AI 秘書
```

Sample (action, from the manifest template `inspection.overdue`):

```
【対応のお願い】点検期限の超過
おはようございます。点検期限を 3 日過ぎた設備があります（期限 2026-10-24）。あなたの確認対象の未点検は 2 件です。
▶ お願いしたいこと：担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。
こちらから開けます：https://inspection.example.jp/equipment/e1
— 設備点検 AI 秘書
```

Sample (approval card as seen in a text-only IM; the business system decides the fields):

```
【承認のお願い】修理依頼
依頼ID: 3f2a9c1d
設備コード: EXT-012
見積額: 18000円
期限: 2026-10-30
お疲れさまです。修理依頼の承認をお願いします。
▶ お願いしたいこと（期限 10/30 17:00）：内容を確認し、「承認」か「差戻」を選んでください。
文字で返信する場合：「承認 123456」／「差戻 123456 理由」
— 設備点検 AI 秘書
```

**Link check**: put `web.routes` (path patterns of the business web app's screens) in the manifest and set bridge-identity's `linkGuard.webUrl` to the business web app URL; business web app links in AI answers (IM turns) then point only to screens that exist (other hosts: `linkGuard.allowHosts`). A link whose URL the AI got wrong by even one character is not delivered.

Automatic task reports (the summary the AI writes) start with 「【対応のお願い】」 (needsDecision) or 「【ご報告】」; with 【対応のお願い】 the next line is
「▶ お願いしたいこと：誰が（役割名）・どこで・何を」 (▶ What we ask: who (role name), where, what). IDs as the first 8 characters; counts and dates only.

### d.6 Platform notes

| Platform | Notes |
|---|---|
| Personal WeChat (iLink) | One bot per account (shared with `multiApp`, switched with `#一覧`). Proactive sends use the conversation context last received from the user, and iLink accepts them only for a certain time after the user's last message (generally said to be **24 hours**, but **unverified**). After that, `weixin_context_missing` makes the send undeliverable at once. Ask users to link another platform as well for important notifications |
| Microsoft Teams | Proactive sends work only if the user has **first talked 1:1 with the bot** and a conversation reference exists (otherwise `invalid_target`). Ask users to send one message when linking |
| LINE | Monthly send limit (HTTP 429 monthly limit → `line_quota`). It does not recover until the month changes or the plan is upgraded, so retry later and reduce the number of messages with digests. `updateCard` becomes a new send |
| email | **Notifications only**. The sender cannot be verified, so linking, approval and AI use are not possible. Not in the default delivery priority (to use it, list it explicitly in `platformPriority`) |
| Lark (Feishu) | The open_id is **different for each app (bot)**. The same person links each app separately, and notifications are sent from the app that person linked |
| Slack | An existing App needs a manifest update and reinstall for interactivity and `im:write`. The modal for entering a send-back reason (`openReasonDialog`) is Slack-only |
| WeCom | Use self-built apps (`wecom-app`) to give each app its own contact point. The callback is `/wecom-app-callback/<botId>/<secret>` (the gateway's `publicPrefixes`) |

### d.7 Secrets and environment

- **MUST** Do not write tokens or secrets in yml, the repository or logs. The registry holds only the **names** of environment variables (`apiUrlEnv` / `serviceTokenEnv`).
  The only exception is development defaults (fixed values that are not real secrets; startup is refused in production [`NODE_ENV=production`]. equipment-inspection's `src/config.mjs`. b.0).
- **MUST** Run DSH in an isolated home (do not use a personal `~/.dsh`). Do not expose the launch token to the browser.
- **MUST** Tests use only fictitious data and test values, loopback only, and never the demo environment or production ports and DBs.

### d.8 Recipient guarantees and outbound settings

Principle: **each role and each account receives over SNS only the business notices, messages and requests that concern them**. The business system decides who receives what; neither the AI nor
the DSH settings decide it (ARCHITECTURE.md §7).

- **MUST** The business system decides the recipients (`recipientsFor` / for-event). Send to everyone in a role only when the event really concerns the whole organisation
  (billing close, payroll, scheduled reports, etc.). Otherwise narrow it to the scope of the target (service user, office, person in charge), and at the gate check "whether that person can see the same target
  in the business web app" (b.2). If the scope is unknown, do not send.
- **MUST** Do not let the AI choose destinations. Leave no model-callable tool that can specify a destination (bot, conversation, email address)
  (`modelTools: reclaim`, `mail: false`). Automatic task reports go only to the event's recipients; if no recipient is determined, nothing is sent (`audienceFallback: none`,
  `restrictDelivery: true`). install.mjs rejects fixed operator delivery targets (`--auto-task-session / --auto-task-bot / --auto-task-target`).
- **MUST** Do not handle business in group conversations (`groupChat: deny`, the default). Even when the answer uses the speaker's own permissions, it is visible to the other people in the group.
  Use `allow` only when the business system side can say that everyone may see the same scope.
- **MUST** For delegation in turns with no sender (automatic tasks), choose a narrow staff member for each kind of work (`<class>`) or use the person in the triggering event (`<class>=each`).
  Do not make an administrator the delegate for all tasks (detect it by listing broad roles in `unattendedWarnRoles`; the template does not list them, so the deployment does).
- **MUST** Do not send AI free text to anyone other than the person themself. Automatic task reports use fixed message wording (`audienceText: template`). Scheduled reports go only to the person's 1:1
  (`deliveryGuard: required`), and the body is `aiReportGuard: screen` (on a hit, the whole text becomes the fixed wording) or `template`.
- **SHOULD** Do not rely too much on `screenOutboundText`. It works from word lists and pattern guesses, so names written only in hiragana, specific disease names and paraphrases get through. The core of the defence is
  the structure of "the AI reads only counts, and sends only to the person's 1:1". If business terms are wrongly matched as health terms, replace the list with `healthWords`
  (not yet in the plugin settings; pass it from the side that calls dsh-core directly).

List of settings (some plugin and fork "defaults" behave the same as upstream. **The framework's profile template ships the closable outbound settings [from `groupChat` to `forwardPluginSources` in
the table] written with the "product value"**, so a profile made from the template is closed in that respect. They can be opened only by an explicit change in the product patch
(b.5). The bottom 4 rows of the table [from `unattendedPolicy` on] are per-deployment values, so the template does not include them: `unattendedWarnRoles` and
`linkGuard` are written by the deployment [without them there is no detection or check]. `unlinkedPolicy` can stay at the default):

| Setting | Where | Default | Product value | What happens if it is not closed |
|---|---|---|---|---|
| `groupChat` | bridge-identity, bridge-tools, registry `applications[].groupChat` | `deny` | `deny` | In group conversations, answers given under the speaker's permissions are visible to everyone |
| `audienceFallback` | bridge-notify (all apps; overridden per `applications.<id>`) | `channels` | `none` | Reports with no determined recipient go to the fixed delivery targets of auto-tasks |
| `audienceText` / `audienceLink` | bridge-notify (all apps; overridden per `applications.<id>`) / `applications.<id>` | `summary` / `/` | `template` / a business web app screen | AI text written under the delegated staff member's permissions reaches other recipients |
| `aiReportGuard` / `aiReportLink` | bridge-notify (overridden per `applications.<id>`) | `screen` / `/` | `screen` or `template` | With `off`, the scheduled report body is not checked |
| `proactiveDelivery` | bridge-notify | `allow` | `deny` | Business alarms other than scheduled reports are sent to IM |
| `modelTools` | dsh-proactive (fork #13) | `all` | `reclaim` | The AI in any conversation can send to any destination with `deliver_to` and can change alarms in other people's conversations |
| `deliveryGuard` | dsh-proactive (fork #14) | `optional` | `required` | When bridge-notify's outbound guard is absent, answers to business triggers are sent as they are |
| `restrictDelivery` | dsh-auto-tasks (fork #16) | `false` | `true` | Fixed delivery targets, test sends and `auto_task_report` from other conversations can be used |
| `mail` | dsh-auto-tasks (fork #16) | `true` | `false` | `auto_task_mail` (SMTP to any address) and mail polling and digests can be used |
| `forwardPluginSources` | dsh-im (`xmanrui-dsh-im`) | `[]` | `[]` | Trigger answers are copied to the conversation's IM without any check |
| `unattendedPolicy` / `unattendedDelegates` | bridge-tools, registry `applications[].delegation` | `deny` / none | A narrow staff member per class, `each` (for the default app, `install.mjs --auto-task-delegate` writes it to the installation; `unattendedPolicy: delegate` written by hand in a product patch is opt-in: check.mjs needs `--allow unattendedPolicy`, with the reason in a comment. b.7) | All automatic tasks run under the delegation of one person (a broad role) |
| `unattendedWarnRoles` | bridge-tools | `[]` | `[admin]` etc. | Delegation to broad roles goes unnoticed |
| `unlinkedPolicy` | bridge-tools | `deny` | `deny` | With `ai-readonly`, even unlinked senders get reads under the AI's own permissions |
| `linkGuard.webUrl` / `webUrls.<id>` | bridge-identity | none | The business web app URL of every app (the default app in `webUrl`, others in `webUrls.<id>`; check.mjs `link_guard`) + the manifest `web.routes` (works only when both are present) | Apps without a URL or `web.routes` get no link check on AI answers (URLs the AI made up or mistyped are delivered as they are; if `web.routes` exists, one warning on the first AI answer) |

### d.9 Personal bots (the person's own SNS)

- **MUST** Each staff member configures only their own connections. Do not build screens or APIs that view, create or remove other people's connections (administrators included). The administrator's 「IM ボット接続」 (IM bot connections)
  does not show staff members' personal bots (`excludeBotIds`).
- **MUST** Personal bots are created and changed through the self-service RPC of the business web app's BFF. A per-channel allow-list (no means of changing the working folder, model, preset, context enrichment or
  access policy is allowed); requests containing a `botId` only for the person's own bots (ask the business system every time); narrow the response `bots[]` to the person's own;
  create with `createOnly: true` (for an existing bot, `bot-exists` and nothing changes); register the new botId to the person with `POST /bridge/v1/me/personal-bots`,
  and on failure delete the bot to roll back. web-kit's self mode only hides components; it is not a safeguard.
- **MUST** Only the BFF, right after a successful `createOnly` creation through the self-service RPC, attaches `x-bff-secret` to `POST /bridge/v1/me/personal-bots`. Do not relay browser requests
  with the secret (if you do, a person can register an organisation bot's botId as their own personal bot, and because of the lookup's owner rule every other
  staff member who talks to that bot becomes "unlinked". b.6).
- **MUST** The business system's identity lookup (`GET /bridge/v1/identity?…&botId=`) returns linked for a `botId` that is a registered personal bot only when the link belongs to its owner
  (another staff member in the same workspace who talks to someone else's personal bot is not let through). A revoked personal bot lets no one through.
  server-kit has this rule (`identityOf`: `botId` is checked in `GET /identity`, `POST /delegations` and IM approval decisions alike; `wechat` is treated the same as
  `weixin`). The link code owner rule (`personal_bot_owner_mismatch`) and revocation on unlinking are also in server-kit. A business system that does not use server-kit
  implements the same rules itself (CareBilling: care-api's `resolveIdentity`).
- **SHOULD** server-kit's `personalBotPlatforms` defaults to `PERSONAL_BOT_PLATFORMS` (slack, line, teams, telegram, discord, weixin, whatsapp,
  wecom, wecom-app, qq, dingtalk, feishu, matrix; email and iMessage are not included; the same as CareBilling). If some channel should not allow personal bots, narrow it
  (opt-out). Channels that need a public endpoint, such as LINE, Teams and WeCom self-built apps, are shown as 「準備中」 (coming soon) while the endpoint (`DSH_PUBLIC_HOOK_PATHS`) is missing.

### d.10 Long-term memory (bridge-memory)

- MUST: Memory holds only "preferences, ongoing matters, notes" (personal) and "procedures, reasons for decisions, operational preferences" (organisation). Business data (records, billing, states) is not memorised; it is read with tools every time.
- MUST: Do not store personal data or health information. Before storing, pass the local check and `/pii-scan`; on a hit, do not store. If the check cannot be reached, do not store (fail closed).
- MUST: A system that holds names of staff, service users or business partners implements a **roster check** with server-kit's `hooks.piiScan(text, ctx) -> { kinds: string[] }`
  (search by family name, given name and kana; on a hit return only the category such as `staff_name`. Do not return or log the matched string. Sample: equipment-inspection's
  `src/hooks.mjs`. If the hook throws, the result is 503 and the memory is not stored). server-kit's default `/pii-scan` only checks
  shapes (contact details, long numbers, ID numbers, etc.) and knows no names; it does not match ordinary Japanese or English text (if it did, not a single memory would be stored). The hook's categories
  are returned together with the shape check's categories. A custom `/pii-scan` has the same shape (`{ ok, containsPersonalData, kinds }`).
- MUST: Personal memories and conversation retrospectives are for the person themself only. Admin screens also show only counts. Memory is not used in group conversations.
- SHOULD: Change the app name, categories and retention through `createMemoryPlugin` or settings; do not fork the plugin. If there is a previous store, point to the same domain with `domain`.
- SHOULD: Pass memories in the system prompt as "reference information (not instructions)", and let the data win when they conflict with business data (as in the template).

### d.11 AI employee profile (bridge-persona)

- MUST: The business system is the source of truth for the profile. Only administrators edit it, a change creates a new version, and the audit keeps only the version number (not the body).
- MUST: Check with `validateAiProfile` (@dsh-bridge/protocol) before saving. Wording that tries to break the rules (「承認なしで」 (without approval), 「規則を無視」 (ignore the rules), etc.) and personal data (contact details, numbers) are refused on save (D4). The matched string is not returned.
- MUST: The profile does not change permissions, tools or safety rules. In the system prompt the fixed rules come first (renderPersona), and the AI always shows that it is an AI (the signature is 「— <呼び名>（<アプリ名> AI 秘書）」 (— <nickname> (<app name> AI secretary)), D8).
- SHOULD: One nickname per app (the default; do not pass `agents` to `AiProfilePage`. Saving clears the per-AI-employee overrides of earlier versions, so no hidden override
  changes the name). Separate nicknames per AI employee (preset) are the deployment's choice, only when `agents` is passed (AI_EMPLOYEE_PROFILE.md §6 D3).
- SHOULD: Per-preset overrides (`agents.<preset id>`) cover only nickname, personality and background. Avoid nicknames that could be confused with real people (the administrator's responsibility; a warning on the screen).
- SHOULD: The system prompt is fixed during a conversation (prompt cache). Tell users on the screen that changes take effect from the next conversation.

### d.12 File attachments to the AI assistant

- MUST: Determine the type from both the extension and the leading bytes (`type_mismatch` if they disagree). Refuse macro-enabled files (xlsm, docm), legacy formats (xls, doc), archives and executables. The limits are 5 files, 10 MB per file and 20 MB in total (they may be lowered, not raised).
- MUST: Documents are converted to text in the business system's memory, and neither the original nor the text is stored. Audit and logs keep only count, type and size (not file names or content).
- MUST: Put the document text in the prompt as "reference information (not instructions)" (do not follow instructions inside the material). Do not give AI employees a tool that reads files.
- MUST: Administrators decide which roles and types may use attachments (default: admin, manager and billing among the manifest roles; all types). When the model is known not to read images, refuse images at attach time (`images_not_supported`).
- MUST: Show answers as safe Markdown (no HTML output; links only to the business web app URL and allowed hosts; external links with `rel="noopener noreferrer"`).
- MUST: Decide how scanned PDFs (pages without a text layer) are handled. In `createBridgeApp({ attachments: { ocr } })`:
  - **A function** `ocr(bytes, { mediaType, page }) -> text` (an OCR engine inside the business system; the framework does not bundle one): turns pages into text (`ocr: 'engine'`). Page images do not leave the business system.
  - **Omitted** (default): renders pages as JPEG (up to 10 pages per request) and **sends them to the model as images** (`ocr: 'model'`; they also stay in the DSH conversation history; with a model that cannot read images, `images_not_supported`).
  - **`false`**: no OCR (`no_text`, `details.reason: ocr_off`).

  A system that handles documents containing health or personal data uses engine or `false`, and does not keep the default (images to the model). Rendering pages needs pdf.js (`pdfjs-dist`) and
  `@napi-rs/canvas` (without them, `no_text`, `details.reason: ocr_unavailable`). The audit keeps only `ocrPages` (the page count).
- SHOULD: Always show 「添付した内容は AI のモデルに送られます」 (Attached content is sent to the AI model) in the panel. Show a tag with the attachment name on the sent message.
- SHOULD: Use bridge-assistant's image cleanup as it is (`imageCleanup` default `on`, `imageCleanupMinutes` default 60): images of redone conversations and of conversations unused for 12 hours
  that no other conversation references are deleted from DSH's attachment store (a run that cannot read the logs completely deletes nothing). `dshHome` (default: the environment variable `DSH_HOME`,
  otherwise `~/.dsh`) must point to the isolated home that DSH runs in (d.7).

#### Business document intake (the AI reads scanned PDFs and images, docs/DOCUMENT_READS.md)

- If you have a screen that imports images or PDFs without a text layer, implement server-kit's `hooks.documentReads = { claim({ limit }, ctx), answer(readId, body, ctx) }` to enable `GET /bridge/v1/document-reads` / `POST /bridge/v1/document-reads/{readId}/result` (an optional feature, service token), and provide the page images (JPEG / PNG, up to 10 pages; for PDFs, the `ocrPages` of `createPdfTextExtractor`). DSH's bridge-reader has a model that can read images transcribe each page once and returns the text (no conversation is created).
- MUST: Every field built from the returned text is put in a state that **needs human confirmation** (values the AI read are never finalised automatically). Business decisions (which service user, which values to import) belong to the business system and people.
- MUST: Page images are sent to the model provider. Provide a setting to stop this and explain it on the screen. Logs and audit keep only counts, IDs and error codes (no images or read text).
- Do not put person names in `hint` (the form name). A claim may be handed out again after 10 minutes (an answer to an old claim gets 409 `read_not_claimed`).

### d.13 External connectors (connections, operations, rules)

- MUST: Secrets (API keys, passwords, client secrets) are held only by the business system. An administrator sends them once from the business web app, and server-kit seals and stores them
  (the screen shows only the last 4 characters). The sealing key (`connectors.secretKey`) is passed from an environment variable. Do not write it in the DSH profile, manifest, prompts, logs or repository.
- MUST: The AI can execute only reads (the delegated staff member's role ∈ `operation.roles`). A write goes `connector_write` proposal → approval by an authorised person → executed by the business system.
  A rule's `auto` covers only reads and idempotent writes that an administrator allowed with a written reason.
- MUST: Connections are https and allowed hosts only (localhost for development via `allowLocalhost`, never in production). Only the fields in the operation input's JSON Schema are sent, and only
  the `responseFields` allow-list is returned to the AI. Operations with a high personal-data category are used in rules only when an administrator explicitly sets `allowPii`.
- MUST: Execution records, audit and IM notices contain only IDs, counts and states (input and response bodies are not output to IM or logs).
- SHOULD: Start with one or two reads. Tell operators where the emergency stop (`/admin/connector-settings`) and the per-connection and per-rule stops are.

## e. Testing policy

| Layer | With what | What it verifies |
|---|---|---|
| Unit | `node --test` in each package (`pnpm test`) | Component contracts. Business APIs are mocked with `node:http`; data is fictitious |
| Conformance | `packages/protocol/conformance` (52 checks) | That the business system keeps the protocol's invariants. A mutation test (`test/conformance-mutants.test.mjs`) also confirms that breaking an invariant makes the check fail |
| manifest | `bridge-validate manifest` / `pnpm validate` | Schema, cross-references, keys that look like PII |
| e2e (mock) | `pnpm run e2e` (`packages/testing/e2e/run.mjs`) | Runs the real DSH + vendor fork + plugins + gateway end to end with a mock LLM / LINE (a linking → b question → c notification → d approval → e automatic task → f isolation; 15 / 15 steps, about 70 seconds; a.3). **Currently equipment-inspection only** (for a new system, write your own scenario with the components of `@dsh-bridge/testing`, or judge by items 2 and 3 of the Definition of Done) |
| Full flow (planned) | full-flow runner | Starts the business system (TEST DB), DSH and a mock IM together, and verifies in one scenario everything from an operation in the business web app to delivery in the IM. Per-business scenarios live in each business system's repository |
| Real devices | Manual | Checks in a real IM (section g, roadmap) |

- e2e rules: test values only (generated every run), loopback only, an isolated DSH home, and the ports of the demo environment and production are
  rejected with `assertPortsUsable(ports, { forbidden })`. `sanitizedEnv` drops real API keys, tokens, DB URLs and any existing `DSH_*` `BRIDGE_*` `CARE_*`.
- **Windows notes**
  - Run `node --test` with `--test-isolation=none` (as in each package's script).
  - Check out vendor/dsh-im with **LF** (with `core.autocrlf=true`, CRs get into string constants and change the build output and the i18n tests).
  - Windows fails `rename` with `EPERM` on a file that another handle has open: the fork retries briefly (`renameReplacing`).
  - Some upstream tests of dsh-im skip / fail for Windows-specific reasons (`FORK.md`). In environments where `esbuild` cannot write to `%TEMP%`, point `TEMP` / `TMP`
    to another directory.
  - Do not start child processes by running a `.cmd` through a shell (stopping the shell leaves the actual process running). Use `killTree`.
  - Under heavy load (several test runs at once), timing-dependent tests can fail. Re-run them on their own.

---

## f. Versioning (protocol / manifest)

| Target | How the version is expressed | Rules |
|---|---|---|
| Protocol | Path `/bridge/v1`, header `bridge-protocol: 1`, `bridge: 1` in the manifest, OpenAPI `info.version` (1.0.0) | Within v1, **additions only** (optional fields, new operations, new error codes). Changing meaning, removing fields or adding required ones means v2 (`/bridge/v2`). When the protocol changes, change the conformance suite at the same time |
| Error codes | lower snake case in `x-error-codes` | Stable identifiers. Do not embed field names (`required` + `details.field`). The human-readable `message` may change |
| manifest | `version` (SemVer or a date); the etag comes from the content | When the content changes, the etag changes and DSH re-fetches with `If-None-Match` (`manifestRefreshSeconds`, default 600 seconds). An invalid or unreachable manifest does not replace the last valid one |
| Event types | `<aggregate>.<fact>` | A type no longer emitted is not removed but marked `deprecated: true` (so past events stay valid). Removing a payload key is a change in the type's meaning |
| playbook | Redeployed only when the manifest version changes | Only the fields the template owns (name, instruction, trigger, approval, source, applicationId, audience, sessionPreset) are overwritten; operational fields (enabled, delivery, guard, run state) are kept. A playbook removed from the manifest is disabled (not deleted) |
| Packages | `@dsh-bridge/*` 0.1.0 (private); the fork is `<upstream>-care.N` | SemVer once published. The licence is undecided (`LICENSE`) |

dsh-core also accepts responses without the `bridge-protocol` header (compatibility with older systems). If the value is not 1, it raises `BridgeProtocolError`.

---

## g. FAQ and troubleshooting

**A notification stays "pending" and is not delivered**
1. It is within the wait of a digest send (short-window or periodic) (`realtimeSettleSeconds` 15 seconds / `realtimeDigestSeconds` 2 minutes / `digestMinutes`). Use `ctx.bridgeNotify.flushNow()` or,
   for verification, `digestMinutes: 0`.
2. The recipient's quiet hours (held until they end). Only kinds with `notify.quiet: exempt` are not held.
3. Delivery priority: it is sent to the highest-priority linked platform. If that platform's bot is not connected (`bot_offline`), retries continue. See the reason
   (errorCode) in the reports of `status()`.
4. Bot: messages are sent only from that app's bot. Check `bots` in the registry and the bot used for linking.

**No notification arrives (and no error either)**
- `recipientsFor` returned `{ stale }` (the situation changed: already inspected, out of use, etc.) → not sending is correct. Old events are dropped by design.
- The person's notification setting is off (kinds with `notify.default: off` in the manifest are off by default), or it was already notified (`sent` is terminal).
- While the notification receiver (plugin-notify) has just started and is not yet registered, sends are treated as failures and retried (`notifyGraceSeconds` 120 seconds).

**A notification reaches only some people (someone who should get it does not)**
- The business system's gate dropped them (the person cannot see the target in the business web app, or does not hold a role in the rule). Look at the reason code left in the business system's audit log
  (`notification.recipient_denied` in CareBilling). The right fix is to correct the affiliation / assignment scope; do not remove the gate.
- Automatic task reports: no recipient was determined (cron-triggered, or a kind that does not notify). With `audienceFallback: none` nothing is sent (`status().audienceSuppressed`).

**The AI does not answer in a group conversation**
- This is the correct behaviour (`groupChat: deny`). It returns only a fixed notice. Ask business questions in a 1:1 conversation.

**The scheduled report became fixed wording (「業務 Web のダッシュボードで確認」 (Check the dashboard in the business web app))**
- The send guard found amounts, personal names, contact details, external URLs, long text or health-related words in the body (`aiReportGuard: screen`). The reason code appears in the DSH log.
  If business terms match the health-related word list, review the list (d.8).
- The trigger guard stopped it: the person is disabled, not linked, in a different conversation, or in a role that is not allowed. Scheduled reports for that conversation stop, so the person sends 「定時報告 オン」 (Scheduled report on) again.

**The AI says it "cannot read business data"**
- Not linked (`linked: false`). Issue a link code in the business web app and send it to **that app's bot**.
- Automatic tasks / scheduled reports: delegation is **denied by default** (`unattendedPolicy: deny`). Configure the delegate in b.7. Scheduled reports run only when the person has turned on 「定時報告 オン」 in that conversation.
- The conversation's app differs from the tool's app (another app is selected on a shared bot). Check with `#いま` (now) and switch with `#<アプリ名>` (`#<app name>`).
- The tool's roles do not include the staff member's role (delegation = AI allow list ∩ role). Check `tools[].roles` in the manifest.

**An automatic task (playbook) does not run**
- Deployed playbooks stay disabled: run `install.mjs --enable-auto-tasks pb_<application-id>_<playbook>` with the **id given explicitly** (without an id nothing is enabled).
  Do this after DSH has started once and plugin-events has deployed them.
- The playbook's `agent` preset is not in the product profile → the dedicated conversation cannot be opened (`no_session` in the task's `lastError`).
- There is no delegate (`unattendedPolicy: deny`), or the delegate staff member's role cannot use the playbook's tools.
- The playbook is `<class>=each` but consent was not given with `--auto-task-delegate <class>=each` (install.mjs warns), or the business system does not issue a
  delegation for that event (404 / 422 / 409 / 403: no such event, a kind that does not get delegation, stale, or the person is not a subject). A default staff member is not substituted.
- It runs only once per event (dedupe). To try again, raise a new event.

**`delegation_not_permitted` / `role_not_permitted`**
A write API was called under delegation (delegation allows read and proposal only), or the proposal kind is one the role cannot handle. This is the correct behaviour.

**Linking fails**
404 / 410 (invalid / expired), 409 (already linked), 429 (too many attempts; wait 10 minutes). Group conversations are not accepted. Linking is not possible via email.
With a personal bot, only the person who registered that bot can link (someone else's code is rejected with `personal_bot_owner_mismatch`).

**Creating a personal bot is refused with `bot-exists`**
A bot with the same credentials (same token, same account) already exists (the organisation bot, or someone else's personal bot). `createOnly` refuses without changing anything.
Create a different bot (a different token).

**DSH starts slowly / the first request fails**
On first run, install the profile's bundle (`dsh plugin --profile <name> install`). The manifest is fetched from `manifestUrl` at startup; if unreachable,
`manifestFile` is used. The gateway re-acquires the launch token on a DSH 401 (restart, expiry) and resends GET / HEAD / upgrade only once.
In e2e, `startDsh` waits for the launch token line. If `dsh --version` differs from the profile's `dshBridge.expectedDsh`, `install.mjs` warns.

**The same notification / report arrived twice**
The idempotency key is "recorded after success", so if the process dies right after the IM side accepted the message, exactly one message may be resent (a known limitation of dsh-im). If it happens in any other case,
check how the idempotency key is built (whether retries use the same key).

**On a shared bot, a reply went to a different app**
Reply by quoting, or reply within 10 minutes of the notification, and it goes back to the notification's app. Otherwise it goes to the "current app". Check with `#一覧` (list).

**The nickname does not appear in the signature / panel, or the way of speaking does not change after editing the profile**
- The business system has no `GET /bridge/v1/ai-profile` (404), or `paths.aiProfile` in the registry is empty: it runs without a profile (signature 「— <アプリ名> AI 秘書」 (— <app name> AI secretary)).
- DSH re-fetches only at startup and every `aiProfileRefreshSeconds` (default 60 seconds). If the fetch fails or a value fails validation, the previous value is kept (`app.aiProfileInfo().lastError`).
- The system prompt section is fixed per conversation: changes apply **from the next conversation** (`/new`). The signature and panel heading change from the next successful fetch.

**The AI does not save "remember this"**
- It contains personal data (personal names with honorifics, contact details, long numbers, health-related words), the business system's `/pii-scan` returned a category (for example the roster hook `hooks.piiScan` found a name),
  or `/pii-scan` is unreachable (fail closed). It is also not used in group conversations or unlinked conversations (d.10). If even ordinary sentences are not saved, check whether the business system's
  `/pii-scan` flags the text itself (`cjk_text` / `free_text`) (the server-kit default does not).

**Links in AI answers are not checked (one link guard warning in the DSH log)**
- The app's business web app URL is missing: `linkGuard.webUrl` for the default app, `linkGuard.webUrls.<application-id>` for other apps (b.8).

**Logs and secrets**
The launch token is masked in logs (`redactToken`). Do not paste tokens or passwords into issues or logs.

---

## h. Reference implementation: CareBilling

CareBilling (care-billing, repository `care-ai-native`) is the first adopter of the framework, and had its own versions of the same components before the framework existed.
[examples/care-billing](../examples/care-billing/README.md) contains the following (no business code):

- [manifest](../examples/care-billing/manifest/README.md): system id `care-billing`, namespace `care`, 5 roles (admin, manager, billing, staff, care_manager),
  71 events (1 deprecated, 65 that notify), 92 templates, 46 recipient rules, 27 tools (including the manual search `care_help_search`), 5 playbooks,
  report `daily_status`, `help`, 131 `web.routes` (version 2026-10-29; counts re-taken from the manifest on 2026-10-30).
- The mapping table of care-api routes ↔ v1 (`care-api-v1-aliases.md` / `.json`): care-api exposes v1 as **aliases** on its existing `/api/ai/*` and other routes (b.2').
- [registry/bridge-apps.yaml](../examples/care-billing/registry/bridge-apps.yaml): registry entries (Slack, LINE, WeCom, a shared personal WeChat) and extension modules.
- [extensions/README.md](../examples/care-billing/extensions/README.md): the table of template intents (92), the `care_*` tools (29 = 27 in the manifest + 2 plugin-only), playbooks and delegation classes, presets.
- The mapping table "framework component → where CareBilling implements it" (which CareBilling file holds each server-kit hook, each DSH plugin and each web-kit screen).

When in doubt, compare both equipment-inspection (the minimal implementation on top of server-kit) and CareBilling (an implementation that puts aliases on the existing API of a large system).
CareBilling is also a sample for how recipients are decided (`decideRecipients` in `services/care-api/src/repo/notifications.mjs`, with the gate in
`repo/notify-scope.mjs`), the RPC for the person themself (`apps/care-web/me-im-rpc.mjs`), per-event delegation (`repo/identity.mjs`) and outbound settings (`dsh/runtime-profile/cordis.patch.yml`).
The design rationale is in care-ai-native's `docs/design/NOTIFY_RECIPIENTS.md`, `IM_PERSONAL_BOTS.md` and `ROLE_MODEL.md` (U10).

Added on 2026-10-29 (location in CareBilling):

- Manual and how-to questions over SNS: `docs/manual` (164 sections), the index and CI `tools/manual-index.mjs` and `services/care-api/test/help-manual.test.mjs`,
  search `GET /api/help/search` (v1 alias), tool `care_help_search` (`plugins/care-tools/src/help.js`), help screen `apps/care-web/src/pages/Help.tsx`.
  Design: `docs/design/SNS_HELP_QA.md`.
- Long-term memory: `plugins/care-memory` (only `createMemoryPlugin` configuration: the former tool names `care_memory_*`, storage `care_memory`, and omitting scope means
  facility memory), check `POST /api/ai/pii-scan`.
- AI employee profile: `services/care-api/sql/096_ai_profile.sql` (`ai_profile_version`), `src/routes/ai-profile.mjs`
  (`GET /api/ai/ai-profile` and the admin `/api/ai-profile`, v1 aliases), screen 「管理 › AI 社員の設定」 (Admin › AI employee settings) `/settings/ai-profile`
  (`apps/care-web/src/pages/settings/AiProfile.tsx`, web-kit `AiProfilePage`), signature 「— さくら（ケアビリング AI 秘書）」 (— Sakura (CareBilling AI secretary)) (care-notify).
  Design: `docs/design/AI_PROFILE_CARE.md`.
