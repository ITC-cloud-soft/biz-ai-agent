# Agent plan: equipment-loans

Based on: biz-ai-agent 03baccf (uncommitted work on top), framework packages @dsh-bridge/protocol 0.1.1, server-kit 0.1.x,
knowledge 0.0.1, graph 0.0.1, plugin-knowledge 0.0.1, plugin-graph 0.0.1. Unattended run: every decision below is the skill's
default, **to confirm**. Details in the README ("Decisions taken without asking").

## Decisions (step 0)

| # | decision | options | recommendation | status (decided by / to confirm) |
|---|---|---|---|---|
| 1 | who the agent works for, what it reads, what it proposes, who decides | every role / managers only; read only / read + propose | every role; read + propose; people decide (approvals: admin / manager, never the borrower) | to confirm |
| 2 | document owners; audience of each document and section | everyone / per section | lending rules for every role, 2 sections per language for admin / manager; runbook admin only | to confirm |
| 3 | what a correct answer is (eval expected sources) | — | drafted by the builder (72 cases) | to confirm by the document owners |
| 4 | embedding model | none (BM25F) / Azure OpenAI / local | none until decided | to confirm (none) |
| 5 | business thresholds | — | high value = catalog flag; > 7 days inclusive; max 30 days; 90 days ahead; approval TTL 7 days; overdue = day after due date; follow-up once to borrower + managers | to confirm |

## Parts

| part | status | evidence (command → result) |
|---|---|---|
| IT system (hooks, routes, outbox, approvals) | done | `node --test test/app.test.mjs` → 8 / 8 |
| manifest (strict) | done | `npx bridge-validate manifest bridge.manifest.yaml --strict` → `ok … (4 events, 6 tools, 1 playbooks)` |
| conformance 52 / 52 | done | `node --test test/conformance.test.mjs` → `# conformance: 52 / 52 checks passed` |
| knowledge (documents, index, route, handbook screen) | done | `test/knowledge.test.mjs` → 10 / 10 (K-01…K-08 pass in the managers-only run) |
| graph (canRead, neighbors, route) | done | `test/graph.test.mjs` → 5 / 5 (G-01…G-07 pass in the managers-only run) |
| evals (first run → final) | done | en 20→22 / 26, ja 18→20 / 23, zh 16→19 / 23, 0 leaks |
| plugin configuration (README) | done | `test/plugin.test.mjs` → 5 / 5 |

## Not verified / remaining

- The plugins in a real DSH home (bridge-tools' `createDelegationGate`, IM delivery of the approval card and of `loan.overdue`).
- Web screens `/loans`, `/equipment` are declared routes only (no HTML), as in the reference.
