# leave-requests — the smallest business system with AI employees

How little does a business system need to work with AI employees? This example answers with **one source file
(`src/app.mjs`, about 300 lines) and one manifest**, on [`@dsh-bridge/server-kit`](../../packages/server-kit), with **no database**
(the kit's memory store) — and it passes the Bridge v1 conformance suite: **52 / 52 checks, 0 skipped, 0 known gaps**.

| | |
|---|---|
| domain | employees request leave; a manager approves it on the web or with the approval card in their own chat |
| roles | `admin`, `manager`, `staff` (staff see their own requests only) |
| domain event | `leave.unanswered` — a request pending for 2 days (once per request), to the requester and the managers |
| approval subject | `leave_request` (approver: a manager or admin, never the requester; one decision closes every card) |
| AI proposals | `leave_new_dates` (any role; staff for their own requests), `leave_cancel` (managers only) — a person accepts or rejects |
| report | `daily_leave` (sections `pending`, `approved_upcoming`; staff see their own `pending`) |
| storage | memory: nothing to install, **nothing survives a restart** |
| data | fictional only |

## Run it

```sh
pnpm install                                               # at the framework root
pnpm --filter @dsh-bridge/example-leave-requests start     # http://127.0.0.1:19750
pnpm --filter @dsh-bridge/example-leave-requests test      # the business rules + the conformance suite (52 / 52)
```

It starts with four fictional employees (`admin`, `manager`, `staff1`, `staff2`; password `leave-dev`, or `LEAVE_SEED_PASSWORD`)
and one request that has already waited 3 days. Try it with curl:

```sh
curl -c jar -H 'content-type: application/json' -d '{"loginId":"manager","password":"leave-dev"}' http://127.0.0.1:19750/api/auth/login
curl -b jar -H 'content-type: application/json' -d '{}' http://127.0.0.1:19750/api/admin/unanswered-scan     # emits leave.unanswered
curl -H 'x-service-token: leave-dev-service-token-000000000000' 'http://127.0.0.1:19750/bridge/v1/events?after=0'
```

## Use it as the start of your own system

The folder works on its own, outside this repository, with the packages from npm:

```sh
cp -r examples/leave-requests ../my-system && cd ../my-system
npm pkg set dependencies.@dsh-bridge/protocol=^0.1.1 dependencies.@dsh-bridge/server-kit=^0.1.1
npm install
npm test            # 52 / 52 conformance + the business rules
npm start           # http://127.0.0.1:19750
```

(Checked on 2026-11-14 by installing the packed packages into a copy of this folder outside the workspace: 57 tests pass,
conformance 52 / 52, `npm run validate` and `npm start` work.) Then rename the system in `bridge.manifest.yaml`, change the domain in
`src/app.mjs`, and keep `npm test` green: the conformance suite tells you when a hook breaks a Bridge rule.

This is the **business side** only. AI employees need the AI plane as well — a DeepSeek Harness home with the framework's plugins,
a model key and a chat bot. To see AI employees talk to people about it, connect it to a DeepSeek Harness home the way `pnpm demo` does for
`examples/equipment-inspection` (`packages/testing/e2e/run.mjs`), or follow the integration skill (`docs/skill`).

| variable | default | |
|---|---|---|
| `LEAVE_PORT` / `LEAVE_HOST` | `19750` / `127.0.0.1` | |
| `LEAVE_SERVICE_TOKEN` / `LEAVE_BFF_SECRET` | dev values | the DSH's `x-service-token` and the BFF's `x-bff-secret`. Required with `NODE_ENV=production` |
| `LEAVE_SEED_PASSWORD` | `leave-dev` | password of the fictional employees |

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
