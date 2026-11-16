# equipment-loans: an agent for lending shared equipment

A new example system built from scratch with [`skills/agent-builder`](../../skills/agent-builder/SKILL.md), starting from
`examples/leave-requests-knowledge`. Employees of a fictional company (Example Co.) borrow shared laptops, projectors and cameras.

- A loan of a **high-value** item, or a loan **longer than 7 days**, waits for a manager's approval — on the web or with the
  approval card in the manager's own chat — and never the borrower's own (a manager who borrows is decided by another manager or
  an administrator). Every other loan is booked at once.
- A loan not returned by its due date is **followed up once** (`loan.overdue` → the borrower and the managers).
- Staff see their own loans only; managers and administrators see all.
- The AI answers questions about the lending rules from the company documents **with the asking employee's own rights**, and
  explains **why a loan or an approval reached someone** (the graph). It only reads and proposes; people decide.

One file (`src/app.mjs`), the kit's memory store, fictional data only.

| part | what | evidence |
|---|---|---|
| IT system | items, loans, approvals (`mayDecide`: active admin / manager, never the borrower — the web route and the chat card), outbox (`kit.tx` + `kit.emitEvent`), the overdue scan, `/api/*` | `test/app.test.mjs` (8), conformance **52 / 52** |
| ontology | `bridge.manifest.yaml`: roles, entities `equipment_item` / `loan` (with screen links), `loan.overdue`, the audience rule `borrower_and_managers`, 6 tools, the playbook `overdue_followup` (off), the report `daily_loans`, glossary | `bridge-validate manifest --strict` → `ok` |
| knowledge | `knowledge/*.md`: `lending-rules` (en), `kashidashi-kitei` 備品貸出のきまり (ja), `jieyong-zhinan` 设备借用指南 (zh) — every role, two sections each for admin / manager only; `equipment-admin-runbook` (en, admin only) | `test/knowledge.test.mjs` (10): permission property, no side channel, scope own, PII refusal, fail-closed build, K-01…K-08 |
| graph | `canRead` (the screens' rule) + `neighbors` (`requested_by`, `item`, `approval`, `subject`, `required_role`, `decided_by`, `loan`) | `test/graph.test.mjs` (5): G-01…G-07, "why did this approval / loan reach me?" through dsh-core `guardTool` |
| evals | `evals/knowledge.evals.json`: 26 en, 23 ja, 23 zh questions | `npm run evals`, `test/evals.test.mjs` (3) |
| AI plane | `bridge-tools` tool modules (below) | `test/plugin.test.mjs` (5); a real DSH run is a separate step (**not verified**) |

```sh
npm install                                                   # at the biz-ai-agent root
npm run validate -w @biz-ai-agent/example-equipment-loans     # ok
npm test -w @biz-ai-agent/example-equipment-loans             # 84 tests (conformance 52 / 52)
npm run evals -w @biz-ai-agent/example-equipment-loans        # the eval report
npm start -w @biz-ai-agent/example-equipment-loans            # http://127.0.0.1:19760 (LOANS_WEB_URL: the web base in sources)
```

```sh
curl -c jar -H 'content-type: application/json' -d '{"loginId":"manager","password":"loans-dev"}' http://127.0.0.1:19760/api/auth/login
curl -b jar 'http://127.0.0.1:19760/bridge/v1/knowledge/search?q=how%20many%20high-value%20items%20at%20a%20time'
curl -b jar http://127.0.0.1:19760/api/loans/overdue
```

## Roles, reads and proposals

| role | scope | AI reads (manifest tools) | AI may propose | decides |
|---|---|---|---|---|
| admin | all | loans, overdue loans, catalog, knowledge, graph | `loan_new_dates`, `loan_cancel` | approvals (not their own loans), proposals |
| manager | all | loans, overdue loans, catalog, knowledge, graph | `loan_new_dates`, `loan_cancel` | approvals (not their own loans), proposals |
| staff | own | their own loans, catalog, knowledge, graph (their own objects) | `loan_new_dates` (their own waiting loans) | nothing |

Every write (`POST /api/loans`, returns, decisions, the catalog, users, the overdue scan) is people only: a delegation gets
`403 delegation_not_permitted`.

## Decisions taken without asking — **to confirm**

Nobody could be asked when this was built; each is the skill's recommended default or the narrowest reasonable reading.

1. **Who the agent works for**: every role talks to it; read + propose for every role, writes by people only (the table above).
   `loan_cancel` is a proposal kind for managers without its own manifest propose tool (as in the reference).
2. **High value** = a flag an administrator sets on the catalog item (the documents say: all cameras and the workstation
   laptops, a purchase price of 300,000 yen or more — fictional figures).
3. **Longer than 7 days** = more than 7 calendar days from the first day to the due date, both included (7 days: no approval).
4. A loan lasts **at most 30 days**, is booked **at most 90 days ahead**, and an item is booked **once per day** (overlaps → 409).
5. An approval expires after **7 days** (the reference's value). A manager who borrows is decided by another manager or an admin.
6. **Overdue** = still out on the day after the due date. The scan (`POST /api/admin/overdue-scan`, managers / admins; a
   scheduler in a real system) emits `loan.overdue` **once per loan**; it goes to **the borrower and every active manager and
   administrator**; it is stale once the loan is returned or cancelled.
7. A return is recorded by the borrower or a manager / admin, once the loan has started. A loan booked at once and a return emit
   no event (nobody needs to be told).
8. New dates proposed for a waiting loan keep it waiting for its approval, even when the new dates would not need one.
9. **The catalog is for everyone** (graph: any role may read an `equipment_item`), but an item's loans are dropped from its
   neighbors unless the asker may read the loan.
10. **Documents**: owner = the (fictional) equipment desk and administrators. Lending rules for every role; in each language
    "approval guidance" and "handling overdue loans" for admin / manager only; the administrator runbook for admin only
    (English only).
11. **The evals' expected sources** were drafted by the builder: to confirm by the document owners.
12. **No embedding model** (BM25F only).
13. Report `daily_loans` at 08:00 on weekdays for admin / manager (staff sections: overdue, due soon); the playbook
    `overdue_followup` is switched off; timezone UTC.

## Evals

Written before any tuning (2026-11-15). A case passes when an expected source is among the first 3 results; `expect: []` cases
pass only when nothing is found. Each language has questions for every manager-only section asked by a manager, the same asked by
staff (`expect: []`), and out-of-scope questions.

First run (before any change):

| lang | cases | passed (hit@3) | top 1 correct | "nothing found" correct | leaks |
|---|---|---|---|---|---|
| en | 26 | 20 (77%) | 17 | 2 / 5 | 0 |
| ja | 23 | 18 (78%) | 17 | 2 / 4 | 0 |
| zh | 23 | 16 (70%) | 15 | 3 / 4 | 0 |
| all | 72 | 54 (75%) | 49 | 7 / 13 | 0 |

Final (the floor in `test/evals.test.mjs`):

| lang | cases | passed (hit@3) | top 1 correct | "nothing found" correct | leaks |
|---|---|---|---|---|---|
| en | 26 | 22 (85%) | 19 | 2 / 5 | 0 |
| ja | 23 | 20 (87%) | 19 | 2 / 4 | 0 |
| zh | 23 | 19 (83%) | 18 | 3 / 4 | 0 |
| all | 72 | 61 (85%) | 56 | 7 / 13 | 0 |

After the build, the package's Chinese question words gained 哪些 / 有没有 / 怎么知道 / 怎么办 (the gap this build found;
a change in `packages/knowledge`, not here): zh 21 (91%), all 63 (88%). The floor is now zh 21. The leave-requests pilot's
numbers did not change.

What was tuned — **section headings only** (8 of 33), worded as an owner would title the section; no case, keyword, threshold
or synonym was changed (`KNOWLEDGE_SYNONYMS` is empty):

| document | before | after |
|---|---|---|
| lending-rules `#what-to-borrow` | What you can borrow | Company equipment you can borrow |
| equipment-admin-runbook `#retire` | Retiring an item | Retiring old equipment |
| kashidashi-kitei `#bihin` | 借りられる備品 | 会社の備品で借りられるもの |
| kashidashi-kitei `#encho` | 貸出の延長 | 貸出期間の延長 |
| jieyong-zhinan `#shebei` | 可以借用的设备 | 公司可以借用的设备 |
| jieyong-zhinan `#shenpi` | 需要审批的借用 | 需要经理批准的借用 |
| jieyong-zhinan `#sunhuai` | 损坏和丢失 | 设备摔坏、损坏或丢失 |
| jieyong-zhinan `#yanchang` | 延长借用 | 借用延期 |

Still failing (11): staff asking a manager-only question get the related public section (en-22, en-23, en-24, ja-20, ja-21,
zh-21: **not leaks** — the public "when a loan needs approval" / "late returns" sections — but the suite says nothing may be
found); "nothing found" under the coverage threshold for en-14 ("I broke the projector lens": no word in common with "Damage and
loss"), ja-05 (何日 / 最長), zh-01…zh-03 (Chinese question words such as 哪些 / 有没有 / 怎么知道 are not in the package's filler
list, which a system cannot extend — see the skill report).

## AI plane configuration

```yaml
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    toolModules:
      - { module: '@dsh-bridge/plugin-knowledge', application: equipment-loans }
      - { module: '@dsh-bridge/plugin-graph', application: equipment-loans }
```

The tools then appear as `loan_knowledge_search` and `loan_graph_why` (namespace `loan`). Not run in a real DSH home yet.

## Settings plugin (added 2026-11-16)

`@dsh-bridge/agent-settings` is wired in the same way as in the leave-requests pilot: the screen `/agent-settings` (admins only), document
upload with an approval through the framework's cards, the search method (BM25F / RAG on pgvector / knowledge graph), the
`knowledge.updated` report. With only one administrator, managers must be approver roles before an admin's upload can be
published (`test/agent-settings.test.mjs`).
