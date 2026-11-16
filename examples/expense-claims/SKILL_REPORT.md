# Skill report: building examples/expense-claims with skills/agent-builder

An unattended trial: an agent built a new AI agent system (expense claims, 経費精算) from `skills/agent-builder/SKILL.md` alone, on
branch `trial/expense-claims` of biz-ai-agent a569a34 (Windows 11, Node 24.19.0, npm 11.17.0, Git for Windows with
`core.autocrlf=true`). Nobody could be asked: every "ask" took the skill's default and is marked "to confirm" in `AGENT_PLAN.md`.
No real DSH was started; no real personal data or secrets were used; nothing was pushed.

## 1. What was built, and the verification results

`examples/expense-claims/` (package `@biz-ai-agent/example-expense-claims`, `system.id` expense-claims, `<ns>` expense):

- `src/app.mjs` — the business system on server-kit's memory store: login, claims (date, category, amount in yen, note), one approval
  per claim (up to 30,000 yen the claimant's own manager — `assignedTo` —, above it an administrator; never the claimant; one rule
  `mayDecide` for the web route, the chat card and the reminder), the "waiting more than 3 days" scan (`expense.claim_waiting`, once,
  to the approver only), visibility (staff own / manager own + team / admin all), two proposal kinds (`expense_correct_claim`: date /
  category / note, never the amount, accepted only by the claimant through the system's own route; `expense_audit_sample`: admins),
  the report, `piiScan`, knowledge (4 documents, en + ja), the handbook screen, the graph, the settings plugin, `/login`, the DSH gateway
  option. `src/server.mjs` — dev server with fictional seed data (port 19770).
- `bridge.manifest.yaml`, `knowledge/*.md` (expense policy / 経費精算規程 for every role with two admin + manager sections each; audit
  procedure / 経費監査の手順 for admins only), `evals/` (58 cases), `test/` (7 files, 90 tests), `dsh-profile/` (the AI plane),
  `AGENT_PLAN.md`, `README.md`.

| check | command | result |
|---|---|---|
| baseline | `git log -1` → a569a34 2026-11-16; `npm install`; `npm run vendor:install`; `npm test` | install / vendor ok; **899 tests, 888 pass, 4 fail, 7 skipped** — the 4 failures are CRLF line endings of this Windows checkout (see problem P1) |
| manifest | `npx bridge-validate manifest bridge.manifest.yaml --strict` (in examples/expense-claims) | `ok   bridge.manifest.yaml (5 events, 6 tools, 1 playbooks)` — first try |
| conformance | `node --test test/conformance.test.mjs` | `# conformance: 52 / 52 checks passed` (53 / 53 tests, no skip, no known gap) — first try |
| business rules | `node --test test/app.test.mjs` | 10 / 10 pass |
| rules broken on purpose | a scratch script replaced one line of `src/app.mjs` at a time (backup restored after each) and ran `test/app.test.mjs` | 10 / 10 breaks caught (claimant decides own claim; limit `>=`; any manager decides; a manager decides a large claim; reminder at ≤ 3 days; reminder twice; claimant reminded; AI may propose an amount; someone else accepts a correction; a manager sees all claims). The amount break was **missed** on the first try (the test passed for another reason) and the test was fixed. With the claimant allowed to decide, `test/conformance.test.mjs` still printed 52 / 52 (as the skill warns) |
| knowledge permission property | `test/knowledge.test.mjs` "EVERY answer …" | pass: 7 employees × web + delegation × 66 questions, > 300 results each checked against visibility |
| no side channel | `test/knowledge.test.mjs` | pass for staff and for a manager (same results and scores as an index without the hidden sections) |
| K-01…K-08 | `runKnowledgeChecks` (probe: the admin-only audit procedure) | pass; K-08 skipped in the first run (every role has the tool) and passes in the managers-only run |
| G-01…G-07 | `runGraphChecks` | G-01…G-06 pass, G-07 skip in the first run; all 7 pass in the managers-only run |
| why e2e | `test/graph.test.mjs` through dsh-core `guardTool` | the claimant's manager: reasons `required_role, assignee, event_audience, related_event`; an administrator on a large claim: `required_role`; the claimant: `author`; another staff member and another team's manager: `{ found: false }` like a missing approval |
| plugin e2e | `test/plugin.test.mjs` | 5 / 5: the tool runs as the asker, cites, refuses `role` / `documentId` / `url`, 403 for delegation × role |
| evals | `npm run evals` | first: en 22 / 29 (76 %), ja 23 / 29 (79 %), 0 leaks; final: en 27 / 29 (93 %), ja 27 / 29 (93 %), 0 leaks. `test/evals.test.mjs` 3 / 3 (floor en 27, ja 27, leaks 0; ≥ 80 %) |
| settings plugin | `node --test test/agent-settings.test.mjs` | 5 / 5: admins only, no delegation; upload → approval for the other admin only → published → found by its roles only → `knowledge.updated` to admin; `/me/sns` for staff and managers; `/login` and the redirect; the system's own events still reach its own hooks |
| example as a whole | `npm test -w @biz-ai-agent/example-expense-claims` | **90 tests, 90 pass, 0 fail** |
| AI plane profile | `node profile/scripts/check.mjs examples/expense-claims/dsh-profile/cordis.patch.yml` | `ok   examples/expense-claims/dsh-profile/cordis.patch.yml (closed product values)` |
| whole repository | `npm test` at the root | **989 tests, 978 pass, 4 fail, 7 skipped** = baseline 899 + this example's 90; the same 4 line-ending failures as the baseline, no new failure |
| dev server | `node src/server.mjs` on 127.0.0.1:19770 (data dir in the scratchpad), curl login / knowledge search (ja) / claims / waiting scan, then stopped | all answered as expected |
| real DSH (optional) | `profile/scripts/install.mjs`, `npm run e2e`, an adapted `e2e/run.mjs` | **not verified** (not run, by instruction) |

## 2. Where the skill was wrong, missing, ambiguous or in the wrong order

Effort is the extra time it cost compared with following a correct instruction (rough).

| # | step | what I expected | what happened | how I got past it | effort |
|---|---|---|---|---|---|
| P1 | 0 Baseline | "0 fail is the starting point"; "if the baseline fails, stop" | On this Windows checkout `npm test` fails 4 tests: `packages/protocol/test/readme.test.mjs` and 3 in `profile/scripts` (`template.test.mjs` ×2, `install.test.mjs`). Cause: `core.autocrlf=true` (system git config) checks files out with CRLF; the tests and `check.mjs`'s link-guard regex expect LF. The skill has no word on line endings or on what to do with an environment-caused red baseline | Diagnosed (`git ls-files --eol`), recorded, continued (unattended rule); "done" = the same 4 failures | 15 min |
| P2 | 0 / 8 | — | `npm install` rewrote `packages/protocol/bin/bridge-validate.mjs`, `profile/scripts/check.mjs`, `profile/scripts/install.mjs` (they show as modified, no content diff — line endings of the bin links). The skill does not warn; a careless `git add -A` would commit framework files it says never to change | Left them out of the commit | 5 min |
| P3 | 8.1 | copying `profile/template/` gives a usable profile | On this checkout the copy is CRLF, and `check.mjs` then reports "application … has no link-guard URL" even when `linkGuard.webUrl` is set (its regex is `\n`-only; the same bug fails the baseline test). The skill does not mention it | Converted the copied files to LF | 10 min |
| P4 | "Where things are" | the reference `examples/leave-requests-knowledge` has "every part above" | It has no `AGENT_PLAN.md` and no `dsh-profile/` (neither has `equipment-loans`); it does NOT follow the skill's own "one options object" rule (`knowledgeOptions = {}` in the app, `evals/run.mjs` passes no options) — `equipment-loans` does. It carries `test/pgvector.test.mjs`, `dev/mock-model.mjs` and pglite / pg devDependencies the skill never mentions. The two examples' `agent-settings.test.mjs` differ a lot (mock model, RAG, KG vs. a short one); "(copy)" does not say which | Took the app shape from the pilot, the options object and `manifestWithToolRoles` helper from `equipment-loans`, the profile from `e2e/run.mjs`; dropped pgvector / mock model; wrote a focused settings test with exactly the items of step 9 | 20 min |
| P5 | 2.2 / 9 conformance | "the approval rule (`mayDecide`) … never the requester" is all a system needs | The need has a **person-specific** approver (the claimant's own manager). Conformance A1–A4 decide with a FRESH employee of `approverRole` (`newEmployee(pending.approverRole)`), and N1–N3 create a FRESH manager and expect that person to be a recipient of the notifying event. A rule like "the claimant's manager" fails both unless the fixtures are built for it. The skill says nothing about these fixture contracts (`fixtures.example.mjs` documents them) | Read `packages/protocol/conformance/checks/{approvals,notifications,proposals}.mjs`, `lib/context.mjs`. `createPendingApproval` returns a claim over 30,000 yen (`approverRole: admin`: any admin decides); `emitNotifiableEvent({ employee })` creates a staff member reporting to that fresh manager (or a large claim for an admin) | 25 min |
| P6 | 2.3 proposals | "proposalKinds (validate + apply)" — and the need says "the claimant then accepts or rejects it" | server-kit reviews proposals by **role only** (`roles.proposalReviewers`), there is no per-proposal reviewer hook, and `GET /bridge/v1/proposals` lists ALL proposals (with payloads) to any reviewer role — making staff reviewers would show every staff member every claim's correction. The skill does not mention who reviews a proposal or how | Read `packages/server-kit/src/routes/misc.mjs`. `proposalReviewers: [admin]`; `apply` refuses anyone but the claimant; the claimant's own routes `GET /api/expense-claims/:id/corrections` and `POST …/corrections/:proposalId/decision` built on the store's `tx` / `getProposal` / `decideProposal` / `audit` (store internals not documented as an API) | 30 min |
| P7 | 9 conformance 52 / 52 | one proposal kind (the need's correction, every role) is enough | PR1's delegation is a FRESH employee of `sample.role` (so only a role that sees every claim — admin — works for a claim it did not make), PR2's reviewer is the fixed `employees[reviewerRole]`, and **PR3 needs `proposalForbiddenSample`**: a kind some role may not propose. With one kind open to every role, 52 / 52 without skip is impossible. Not in the skill | Added `expense_audit_sample` (admin only, fits the audit procedure) — a feature the need did not ask for, marked "to confirm" | 15 min |
| P8 | 3 tools + 8.2 | follow both | Step 3 puts `<ns>_knowledge_search` into the manifest; step 8.3 loads `@dsh-bridge/plugin-knowledge`, whose tool has the SAME name; step 8.2 recommends `generateTools: true`. Together they clash — the pitfall "set generateTools: false or rename" is the only hint, and the pilot's `e2e/run.mjs` uses `false` with a cryptic comment | Read `plugins/tools/src/index.js` (bridge-tools generates the manifest tools AFTER the tool modules and skips taken names) and `packages/dsh-core/src/plugin.js`; set `generateTools: false` | 10 min |
| P9 | 8 | the profile is complete after `cordis.patch.yml` | `proactive.config.json` of the template also has a `<namespace>_*` placeholder, which `check.mjs` does not check; `bridge-approvals.webUrl` points at `/approvals?id={id}` ("the approval screen of your web") but neither reference has such a screen; a playbook's `agent` must be a preset id of the profile (template comment) while the pilot uses `leave-assistant` with no preset; the skill says "`file:` dependencies on this repository's `plugins/…`" but the template uses `file:{{FRAMEWORK_ROOT}}/…` and the e2e absolute paths; it says `module: '@dsh-bridge/plugin-knowledge'` while the e2e loads file URLs (whether the bare name resolves in an installed profile is unverified) | Filled `proactive.config.json`; left the approvals URL with a "to confirm" comment; pointed the playbook at the existing `business-assistant` preset; used `{{FRAMEWORK_ROOT}}`; kept the bare module names (not verified) | 15 min |
| P10 | 8 propose tools | the manifest's propose tools reach the AI on DSH | bridge-tools generates READ tools only; a hand-written tool module is needed for `expense_propose_*`. The skill never says who provides propose tools on DSH | Recorded as "not verified / remaining" | 5 min |
| P11 | 7.5 sign-in | "a browser without a session on a screen goes to /login" | `redirectToSignIn` redirects only the exact paths `/agent-settings` and `/me/sns`; the handbook screen the AI's sources link to answers 401 JSON to a browser without a session. My test expecting a redirect for a business screen failed | Read `packages/agent-settings/src/sign-in.mjs`; the test now asserts the actual behaviour; recorded | 10 min |
| P12 | 6 tuning | "`synonyms` (`[[documentsWord, otherWord, ...], ...]`)" | A synonym matches as a substring of the question with its spaces removed (`packages/help/src/search.mjs` `expandQuery`), so a multi-word entry ("money back", "team party") never matches; the first word is added as an extra term. `packages/knowledge/README.md` does not document `synonyms`, `fillers` or `stopWords` at all (only code comments in `service.mjs` / `search.mjs`) | Read the code; used single words | 10 min |
| P13 | 6 / 2.1 order | copy the reference, then write evals with one options object | The copied `evals/run.mjs` (from the pilot) imports no options; a builder who runs the first eval before replacing it measures a configuration without the app's options (harmless here because the synonyms were still empty) | Replaced it with the `equipment-loans` form (`KNOWLEDGE_OPTIONS`) | 5 min |
| P14 | 3 manifest | the skill's words are enough to write the roles and entities | Role `scope` must be `all | assigned | own` (schema) — a manager's team needs `assigned`, not mentioned; no guidance on the `pii` class of an entity / tool that carries amounts and a free-text note (`personal`? `financial`?) — the runtime ignores tool `pii` anyway | Read `packages/protocol/schema/manifest.schema.json`; chose `assigned` and `pii: personal` (to confirm) | 5 min |
| P15 | 5 graph | reason kinds a test can expect include `playbook` | With the playbook's `audience: { rule: … }` (instead of roles) no `playbook` reason appeared for the approver. Not investigated further | Asserted the observed list | 5 min |
| P16 | 9 "break each rule" | breaking a rule makes a test fail | One break (allowing `amountYen` in a correction) was not caught: the test's payload had no other field, so it was refused for "nothing to correct". The skill could say: check that the failure is the assertion of that rule | Fixed the test, re-ran all breaks | 5 min |
| P17 | 9 whole repository | "0 fail, and the counts = baseline + your tests" | Impossible on this checkout (P1). Also `npm install` changes the root `package-lock.json` (the new workspace) — the skill does not say to commit it | Compared with the baseline; committed the lockfile | 2 min |
| P18 | 0 → plan | "copy `templates/agent-plan.md` to `examples/<system-id>/AGENT_PLAN.md`" in step 0 | The directory is created only in step 2.1 (copy the reference); the template's table heading says "Decisions (step 1)" while `equipment-loans`' plan says "step 0" | Created the plan after the copy | 1 min |
| P19 | 1 / need | — | Details the need leaves open and the skill has no default for: who decides when the claimant has no (active) manager, whether exactly 30,000 yen is the manager's, the approval card's lifetime, amount limits, a submission deadline, what "never decides an amount" means for a correction (I read it as: a correction may not touch the amount) | Chose and marked "to confirm" | 5 min |
| P20 | general | a reference to copy for a 2-level approval | Both references have one approver role; nothing on approval levels by amount, `requiredRole` per approval, or an `assigned_to` relation for a named approver (the graph section lists it, which helped) | Designed it; the graph's `assigned_to` gives the "It is assigned to you" reason | — |

### Places where I had to read code because the skill did not say enough

- `packages/protocol/conformance/checks/approvals.mjs`, `notifications.mjs`, `proposals.mjs`, `delegation.mjs`, `lib/context.mjs` — what each fixture hook must produce (P5, P7).
- `packages/server-kit/src/routes/misc.mjs`, `src/app.mjs` (`roles.proposalReviewers`), `src/store/memory.mjs` — proposal review and the store methods (P6).
- `plugins/tools/src/index.js`, `packages/dsh-core/src/plugin.js` — `generateTools` and tool name clashes (P8).
- `packages/agent-settings/src/sign-in.mjs` — what `redirectToSignIn` covers (P11).
- `packages/knowledge/src/search.mjs`, `service.mjs`, `packages/help/src/search.mjs` — synonyms / fillers / stop words (P12); `src/evals.mjs` — `expect: []` with and without `forbid`.
- `packages/protocol/schema/manifest.schema.json` — role scopes, pii classes (P14).
- `profile/scripts/check.mjs`, `e2e/run.mjs` (`makeProductProfile`), `profile/template/*` — the profile (P3, P9).
- `scripts/sync-framework.mjs` — to make sure a later `npm run sync-framework` does not delete `examples/expense-claims` (it does not: it removes only files it synced before).

What worked well: the manifest validated and conformance passed 52 / 52 on the first run of each; the knowledge, graph, plugin and
settings tests carried over with renames only; the pitfalls about the fully restricted probe document, relation names and the time-based
event (moving dates on the instance) were exactly right and saved time.

## 3. Eval numbers

`node evals/run.mjs` (BM25F, top 3; 29 cases per language, of which 6 per language "nothing / forbidden must not be found"):

| | en hit@3 | ja hit@3 | top 1 en / ja | "nothing found" correct en / ja | leaks |
|---|---|---|---|---|---|
| first run (written before tuning) | 22 / 29 (76 %) | 23 / 29 (79 %) | 22 / 22 | 4 / 6, 5 / 6 | 0 |
| final | 27 / 29 (93 %) | 27 / 29 (93 %) | 25 / 26 | 4 / 6, 5 / 6 | 0 |

Tuning: 12 synonym groups in `KNOWLEDGE_OPTIONS` (the object the app and `evals/run.mjs` share), chosen by looking at the first run's
failed cases — so the final numbers are measured on the set they were tuned on. No case, threshold, filler or stop word was changed.
Still failing: en-28 "working from home" and en-29 "book a meeting room" (out of scope, but a section is found), ja-28 在宅勤務の規程 (the
same), ja-04 毎日会社に通う電車代 (the eligible section ranks first).
