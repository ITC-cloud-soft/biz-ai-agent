# Agent plan: expense-claims

Based on: biz-ai-agent a569a34 (2026-11-16) (framework synced from 9a86b0f8ac4426c75c5da626d23e8d6e9328af72 in framework.sync.json).
Baseline before this work: `npm test` → 899 tests, 888 pass, **4 fail**, 7 skipped. The 4 failures are Windows line endings of this
checkout (`core.autocrlf=true` in the system git config turns LF into CRLF on checkout): `packages/protocol/test/readme.test.mjs`
(README table) and three `profile/scripts` tests that read `profile/template/*` with CRLF. They are unrelated to this work; nobody
could be asked (unattended run), so the build went on and "done" means the same 4 failures and nothing else — **to confirm**.

Unattended run: every decision below is the skill's recommended default or the builder's reading of the business need,
**to confirm**.

## Decisions (step 1)

| # | decision | options | recommendation | status (decided by / to confirm) |
|---|---|---|---|---|
| 1 | who the agent works for, what it reads (tools × roles), what it proposes, who decides | every role / managers only; read only / read + propose | every role talks to it. Reads: `expense_list_claims` (all roles, each sees what the web shows them), `expense_list_waiting` (admin, manager), knowledge and graph (all roles). Proposes: `expense_correct_claim` (all roles; date / category / note only, never the amount; **the claimant** accepts or rejects on the web), `expense_audit_sample` (admin only; an administrator accepts — added so the AI can support the audit procedure and so a role-restricted proposal exists). Decides: people only — up to 30,000 yen the claimant's own manager, above it an administrator, never the claimant | to confirm |
| 1a | approval details the need does not state | — | a claimant without an (active) manager → an administrator decides; an assigned manager who is deactivated → an administrator decides; exactly 30,000 yen → the manager; approval card valid 14 days; amount 1 – 1,000,000 yen; a claim within 30 days of the expense; note ≤ 200 characters; categories transport / lodging / meals / supplies / communication / other | to confirm |
| 1b | the kit's proposal reviewers | admin / managers / everyone | `proposalReviewers: [admin]` (an administrator may reject a stale correction through `/bridge/v1/proposals/:id/reject`; accepting a correction is refused for anyone but the claimant) | to confirm |
| 2 | document owners; audience of each document and section | — | expense policy (en) and 経費精算規程 (ja): every role, the sections "approval limits" and "how to check a claim" admin + manager; audit procedure (en) and 経費監査の手順 (ja): admin only (fully restricted — the knowledge probe). Owners: the administrators | to confirm |
| 3 | what a correct answer is (eval expected sources) | — | drafted by the builder (58 cases) | to confirm by the document owners |
| 4 | models (base / embedding) | none (BM25F) / a model the owner names | none (BM25F) | to confirm (none) |
| 5 | SNS: events that notify and their recipients; document approver roles; report roles | — | `expense.claim_waiting` → the claim's approver(s) only (the same rule as the web, `mayDecide`), once per claim; the claimant is not told. `sns.approverRoles` = admin (the default: there are two administrators, so the uploader is never the only approver); `sns.reportRoles` = admin (default) | to confirm |
| 6 | languages served | — | Japanese and English (one document per language and audience; 29 eval questions each) | to confirm |
| 7 | outbound settings opened (opt-in) and why | none / … | none | to confirm (none) |

## Parts

| part | status | evidence (command → result) |
|---|---|---|
| IT system (hooks, routes, outbox, approvals, reports) | done | `node --test test/app.test.mjs` → 10 / 10 |
| manifest (strict) | done | `npx bridge-validate manifest bridge.manifest.yaml --strict` → `ok   bridge.manifest.yaml (5 events, 6 tools, 1 playbooks)` |
| conformance 52 / 52 | done | `node --test test/conformance.test.mjs` → `# conformance: 52 / 52 checks passed` (53 / 53 tests) |
| business rules (tests; each rule broken once on purpose) | done | 10 rules broken one at a time (claimant decides own, limit `>=`, any manager, manager decides large, reminder ≤ 3 days, reminder twice, claimant reminded, AI proposes an amount, someone else accepts a correction, a manager sees all) → each makes `test/app.test.mjs` fail; `src/app.mjs` restored. With the claimant allowed to decide, conformance still passes 52 / 52 |
| knowledge (documents, index, route, handbook screen, K-01…K-08) | done | `node --test test/knowledge.test.mjs` → 10 / 10 (K-01…K-08 pass in the managers-only run) |
| graph (canRead, neighbors, route, G-01…G-07, why test) | done | `node --test test/graph.test.mjs` → 4 / 4 (G-01…G-07 pass in the managers-only run; the manager's reasons: required_role, assignee, event_audience, related_event) |
| evals (first run → final; leaks) | done | first: en 22 / 29 (76 %), ja 23 / 29 (79 %), 0 leaks → final: en 27 / 29 (93 %), ja 27 / 29 (93 %), 0 leaks; `test/evals.test.mjs` 3 / 3 |
| settings plugin (/agent-settings, /me/sns, /login, approvals, reports) | done | `node --test test/agent-settings.test.mjs` → 5 / 5 |
| plugin e2e (bridge-knowledge through guardTool) | done | `node --test test/plugin.test.mjs` → 5 / 5 |
| AI plane profile (dsh-profile/, check.mjs) | done | `node profile/scripts/check.mjs examples/expense-claims/dsh-profile/cordis.patch.yml` → `ok … (closed product values)` |
| whole repository (`npm test`) | done | `npm test` at the root → 989 tests, 978 pass, 4 fail, 7 skipped (baseline 899 / 888 / 4 / 7 + 90 of this example; the same 4 line-ending failures) |
| dev server | done | `node src/server.mjs` on 127.0.0.1:19770 → login, knowledge search (ja), claims list, waiting scan answered; stopped |

## Not verified / remaining

- Real DSH (`profile/scripts/install.mjs` into an isolated home, `npm run e2e`, an adapted `e2e/run.mjs` for this system): **not verified**
  (not run in this trial by instruction). In particular: whether bridge-tools resolves the bare module names
  `@dsh-bridge/plugin-knowledge` / `@dsh-bridge/plugin-graph` of `toolModules` from the installed profile (the pilot's e2e uses file URLs).
- Propose tools on a real DSH: the manifest declares `expense_propose_correction` / `expense_propose_audit_sample`, but bridge-tools only
  generates read tools; a hand-written tool module for them does not exist yet.
- Web screens `/expense-claims`, `/expense-claims/:id` (with the claimant's accept / reject buttons) and an approval screen are declared
  routes and JSON APIs only (no HTML), as in the reference; the `bridge-approvals` `webUrl` still points at the template's `/approvals?id={id}`.
- A browser without a session that opens a handbook source link gets a 401 (redirectToSignIn knows only `/agent-settings` and `/me/sns`).
- Eval failures left: two English and one Japanese out-of-scope question still find a section ("working from home", "meeting room",
  在宅勤務), and ja-04 (通勤 asked as 毎日会社に通う電車代) ranks the eligible section first.
