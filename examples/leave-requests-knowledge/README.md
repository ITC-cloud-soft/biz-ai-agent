# leave-requests-knowledge: the pilot of the knowledge capability

This is a copy of `framework/examples/leave-requests`, the smallest business system with AI employees (one file, a memory store,
Bridge v1 conformance **52 / 52**). The copy adds the **knowledge** capability of biz-ai-agent: company documents searched with
the asker's own rights.

| | |
|---|---|
| documents | `knowledge/*.md`, all fictional: leave policy (every role; the section "Approval rules for managers" for admin / manager only), manager handbook (admin / manager), administrator runbook (admin), 休暇のよくある質問 (every role; 「管理職の承認上限」 for admin / manager only) |
| route | `GET /bridge/v1/knowledge/search?q=` (`@dsh-bridge/knowledge`, registered on server-kit's router) |
| AI tool | `leave_knowledge_search` in the manifest (`roles: [admin, manager, staff]`), served by `bridge-knowledge` |
| screen | `/handbook/:docId`: the sources link here, and it shows a person only the sections they may read (404 for hidden and unknown alike) |
| personal data | every chunk passes `hooks.piiScan` (names of the roster) and the shape check before it is indexed |

```sh
npm install                      # at the biz-ai-agent root
npm test -w @biz-ai-agent/example-leave-requests-knowledge   # 79 tests: business rules, conformance 52 / 52, knowledge, plugin and graph end to end, evals
npm start -w @biz-ai-agent/example-leave-requests-knowledge  # http://127.0.0.1:19750 (LEAVE_WEB_URL: the web base in sources)
```

```sh
curl -c jar -H 'content-type: application/json' -d '{"loginId":"manager","password":"leave-dev"}' http://127.0.0.1:19750/api/auth/login
curl -b jar 'http://127.0.0.1:19750/bridge/v1/knowledge/search?q=how%20many%20consecutive%20days%20can%20a%20manager%20approve'
curl -b jar http://127.0.0.1:19750/handbook/leave-policy
```

What the tests prove (`test/knowledge.test.mjs`, `test/plugin.test.mjs`):

- **Every answer holds only what its asker may read.** Every question built from the documents' titles, headings and keywords, plus
  some phrasings, is asked by admin, manager and two staff members, each on the web and through a delegation made by the web
  assistant's ticket flow. Every result is checked against the chunk's visibility.
- **No side channel.** A staff member gets exactly the same results and scores as from an index that never had the hidden chunks.
- **Scope "own".** A document for one employee (`users: [id]`) reaches only that employee, not the other staff, not the managers.
- **Delegation × role.** With the manifest tool for managers only, a staff member's AI gets 403 while the staff member still searches
  on the web. A deactivated employee's delegation gets 401.
- The knowledge conformance checks K-01…K-08, the personal-data refusal, and the build's fail-closed errors.
- **bridge-knowledge end to end.** The tool runs through dsh-core's `guardTool` / `createToolRequester` / `createBusinessApi` with
  real delegations, cites `[n]` with the source screens, and refuses `role` / `documentId` / `url` arguments.

---

The rest is the original README of leave-requests (the business system itself).

## What is in `src/app.mjs`

Everything Bridge v1 needs — the gate, chat linking and link codes, delegations, the event outbox and `/events`, notification
resolution, approval cards and reply codes, proposals, reports, the manifest endpoint — comes from `createBridgeApp`. The file holds only
what knows the business:

1. **Its data and login** — plain maps, password hashing and sessions (the kit never sees a password).
2. **The hooks** — `employees` (who exists, which role, active), `authenticate` / `isSessionLive` (the employee's own session),
   `recipientsFor` (who is told about `leave.unanswered`, with numbers and dates only), `approvals` (who decides, what the chat card
   shows, how a decision is applied), `proposalKinds` (what the AI may propose, for which roles), `reports.compute`, `piiScan`
   (names live only in the roster).
3. **Its web API** — the AI's read tools are business endpoints behind `kit.readToolPolicy` (the manifest's allow-list intersected with
   the employee's role); every write is people only, so a delegation gets `403 delegation_not_permitted`.
4. **Business change + event in one transaction** — `kit.tx` + `kit.emitEvent` (the outbox).

## From here to a real system

Keep the manifest and the hooks; replace the maps with your tables and the memory store with `createPostgresStore` or
`createMysqlStore` (TiDB works too), run `unanswered-scan` from a scheduler, and add the web screens (`@dsh-bridge/web-kit`).
`examples/equipment-inspection` is the same shape on PostgreSQL, with a manual, a web page and the end-to-end demo.
