# Agent plan: <system-id>

Based on: biz-ai-agent <commit> (framework synced from <framework commit in framework.sync.json>).
Baseline before this work: `npm test` → <tests> tests, <fail> fail.

## Decisions (step 1)

| # | decision | options | recommendation | status (decided by / to confirm) |
|---|---|---|---|---|
| 1 | who the agent works for, what it reads (tools × roles), what it proposes, who decides | | read + propose for every role, writes by people | |
| 2 | document owners; audience of each document and section | | narrowest reasonable audience | |
| 3 | what a correct answer is (eval expected sources) | | drafted, to confirm by the owners | |
| 4 | models (base / embedding) | none (BM25F) / a model the owner names | none until decided | |
| 5 | SNS: events that notify and their recipients; document approver roles; report roles | | admin roles; managers too when there is one admin | |
| 6 | languages served | | | |
| 7 | outbound settings opened (opt-in) and why | none / … | none | |

## Parts

| part | status | evidence (command → result) |
|---|---|---|
| IT system (hooks, routes, outbox, approvals, reports) | | |
| manifest (strict) | | |
| conformance 52 / 52 | | |
| business rules (tests; each rule broken once on purpose) | | |
| knowledge (documents, index, route, handbook screen, K-01…K-08) | | |
| graph (canRead, neighbors, route, G-01…G-07, why test) | | |
| evals (first run → final; leaks) | | |
| settings plugin (/agent-settings, /me/sns, /login, approvals, reports) | | |
| AI plane profile (dsh-profile/, check.mjs) | | |
| whole repository (`npm test`) | | |

## Not verified / remaining

-
