# Agent plan: <system-id>

Based on: biz-ai-agent <commit>, framework packages @dsh-bridge/* <versions>.

## Decisions (step 0)

| # | decision | options | recommendation | status (decided by / to confirm) |
|---|---|---|---|---|
| 1 | who the agent works for, what it reads, what it proposes, who decides | | | |
| 2 | document owners; audience of each document and section | | | |
| 3 | what a correct answer is (eval expected sources) | | | |
| 4 | embedding model | none (BM25F) / Azure OpenAI / local | none until decided | |

## Parts

| part | status | evidence (command → result) |
|---|---|---|
| IT system (hooks, routes, outbox, approvals) | | |
| manifest (strict) | | |
| conformance 52 / 52 | | |
| knowledge (documents, index, route, handbook screen) | | |
| graph (canRead, neighbors, route) | | |
| evals (first run → final) | | |
| plugin configuration (README) | | |

## Not verified / remaining

-
