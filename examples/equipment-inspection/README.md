# equipment-inspection — an example business system on `@dsh-bridge/server-kit` (備品・設備点検)

A deliberately small business system — a facility's equipment inspection app (消火器・非常灯・AED・給湯器 …) — that
integrates with DSH **through the Bridge protocol v1 only**, built on [`@dsh-bridge/server-kit`](../../packages/server-kit).
It is the `examples/bridge-demo` system of care-ai-native rebuilt on the kit: the business keeps its own tables, users and
rules; every Bridge endpoint, the gate, link codes, delegations, the event outbox, notification resolution, approval cards,
reports, proposals and the manifest endpoint come from the kit.

It passes the conformance suite of `@dsh-bridge/protocol` through the **generic HTTP adapter**:
**52 / 52 checks pass, 0 skipped, 0 known gaps** (`test/conformance.test.mjs`).

| | |
|---|---|
| domain | equipment (設備・備品), inspections (点検記録), the overdue scan, repair requests (修理依頼) with one approval |
| roles | `admin` 施設管理者, `manager` 設備責任者, `inspector` 点検員 (scope: own assigned equipment) |
| domain events | `inspection.overdue` (notified + AI playbook), `inspection.completed` |
| approval subject | `repair_request` (approver: manager or admin, never the requester; one approval decides) |
| report | `daily_inspection` (sections `equipment`, `overdue`, `inspections`, `repairs`; inspector sees `overdue`, `inspections`, own only) |
| storage | PostgreSQL database `equipment_inspection` (created on first start). Business tables + the kit's `bridge_*` tables |
| stack | Node 24 ESM, `node:http` (through the kit), `pg` |
| data | **fictional only**: the seed creates four placeholder employees and five pieces of equipment |

## Start it

```
docker ps                                                     # PostgreSQL on 127.0.0.1:5432
pnpm install                                                  # at the framework root
export EQUIPMENT_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/equipment_inspection
pnpm --filter @dsh-bridge/example-equipment-inspection start  # http://127.0.0.1:19730
```

On an empty database it seeds four fictional employees (`admin`, `manager`, `inspector1`, `inspector2`, password
`EQUIPMENT_SEED_PASSWORD`, dev default `equipment-dev`) and five pieces of equipment, one of them overdue, so the first
overdue scan (every 5 minutes, in-process) writes an `inspection.overdue` event, and the 08:30 report is stored.

Open **http://127.0.0.1:19730/** to try self-service SNS linking: log in, press 「連携コードを発行」, send `連携 123456` to
the bot, see the link in 「連携中の SNS」, unlink it, switch the overdue notification off and on.

| variable | default | |
|---|---|---|
| `EQUIPMENT_PORT` / `EQUIPMENT_HOST` | `19730` / `127.0.0.1` | |
| `EQUIPMENT_DATABASE_URL` | (required) | e.g. `postgres://<user>:<password>@127.0.0.1:5432/equipment_inspection` (created on first start). `DATABASE_URL` is deliberately NOT read. The databases of other systems (`care`, `care_ui`, `care_test`, `care_joint`, `bridge_demo`) are refused. |
| `EQUIPMENT_SERVICE_TOKEN` | a dev token | the DSH `x-service-token`. Required with `NODE_ENV=production`. |
| `EQUIPMENT_BFF_SECRET` | a dev secret | the BFF `x-bff-secret`. Required with `NODE_ENV=production`. |
| `EQUIPMENT_PERSONAL_BOT_PLATFORMS` | the kit default (every personal-bot channel: slack, line, teams, telegram, discord, weixin, whatsapp, wecom, wecom-app, qq, dingtalk, feishu, matrix) | platforms that have personal bots (comma separated; narrow it to opt out) |
| `EQUIPMENT_SCHEDULER` / `EQUIPMENT_SEED` | on / on | `0` disables |
| `EQUIPMENT_SEED_PASSWORD` | `equipment-dev` | password of the fictional seed users |
| `EQUIPMENT_LINK_GLOBAL_MAX_FAILURES` | `1000` | global wrong-link-code budget per 10 minutes |
| `EQUIPMENT_CONNECTOR_KEY` | dev value (refused in production) | key material (32+ characters) that seals the external connectors' API keys (docs/AI_EMPLOYEE_PROFILE.md §3; the rules run in the scheduler every minute) |
| `EQUIPMENT_CONNECTOR_ALLOW_LOCALHOST` | unset | `1` lets external connectors call http://localhost (development only) |

## What the business wrote vs. what the kit gives

```mermaid
flowchart LR
  subgraph APP["equipment-inspection (this directory)"]
    WEB["public/ link page<br/>(employee session only)"]
    BIZ["src/routes.mjs  /api/*<br/>equipment · inspections · repair requests · approvals · admin"]
    DOM["src/domain.mjs<br/>business rules; events in the same transaction"]
    HK["src/hooks.mjs<br/>employees · recipientsFor · approvals · proposalKinds · reports"]
    AUTH["src/auth.mjs<br/>users · sessions"]
  end
  subgraph KIT["@dsh-bridge/server-kit"]
    V1["/bridge/v1/* routes<br/>identity · me · delegations · events · notifications<br/>approvals · assistant · reports · proposals · manifest · pii-scan · help · ai-profile"]
    GATE["principals + gate<br/>delegation = manifest read tools ∩ role"]
    STORE["PostgreSQL store (bridge_* tables)<br/>bridge_event = transactional outbox"]
  end
  PG[("PostgreSQL equipment_inspection")]
  WEB --> BIZ
  BIZ --> GATE
  V1 --> GATE
  V1 --> HK
  HK --> DOM
  BIZ --> DOM
  DOM --> STORE
  STORE --> PG
  DOM --> PG
  DSH["DSH + @dsh-bridge/dsh-core"] -->|x-service-token (+ x-delegation-token)| V1
  DSH -->|delegated read tools| BIZ
```

```
src/
  server.mjs      entry (pnpm start): start, fictional seed, scheduler (overdue scan + manifest report slots)
  app.mjs         createEquipmentApp(): kit (createBridgeApp + createPostgresStore) + hooks + business routes; startServer()
  config.mjs      environment (no secrets in the repo; protected database names)
  auth.mjs        app_user / app_session: authenticate(req), isSessionLive(), login, logout   (kit hooks)
  domain.mjs      the business: equipment, inspections, overdue scan, repair request + approval, report counts
  hooks.mjs       the kit hooks: employees, recipientsFor, approvals, proposalKinds, reports
  routes.mjs      /api/* business API and the static page, on the kit's router (same gate)
  help.mjs        createHelp(): the manual index (@dsh-bridge/help buildHelpIndex over manual/*.md and the app's route table) → kit option help
  seed.mjs        fictional data on an empty database
  migrations/     001_business.sql (the kit applies its own 001_bridge.sql, 002_event_delegation.sql, 003_ai_profile.sql)
manual/           01-basics.md  02-inspections.md  _synonyms.yml   (5 sections, fictional; how-to answers on SNS)
public/           index.html  app.js  style.css   (plain HTML, CSP script-src 'self')
test/             domain.test.mjs  conformance.test.mjs  help.test.mjs  fixtures.mjs  helpers.mjs
bridge.manifest.yaml   (help.tool: facility_help_search, web.routes)
```

The kit's optional parts are on: `GET /bridge/v1/help/*` (the manual above, per role), `POST /bridge/v1/pii-scan` (checked by
bridge-memory before saving) and the AI employee's profile (`GET /bridge/v1/ai-profile`, administrators: `GET / PUT
/bridge/v1/admin/ai-profile` and restore; `admin` is the administrator role). The page has no profile screen; use the API or web-kit
`AiProfilePage` in a business web.

The whole Bridge side of the system is `hooks.mjs` (~140 lines) and two calls in `domain.mjs`:
`kit.tx(async (t) => { ...business SQL on t.db...; await kit.emitEvent(t, { type, aggregateType, aggregateId, payload }) })`
for every state change DSH should hear about, and `t.revokeApprovalDeliveries({ approvalId })` when an approval is decided
on the web.

## Endpoints

Every `/bridge/v1/*` endpoint is served by the kit (exactly `packages/protocol/openapi/bridge-v1.yaml`); see the
[server-kit README](../../packages/server-kit/README.md#bridge-v1-endpoints) for the table.

Business API (`/api/*`, not part of the protocol): `POST /api/auth/login | logout`, `GET /api/me`,
`GET /api/equipment` (tool `facility_list_equipment`), `GET /api/inspections/overdue` (tool `facility_list_overdue`),
`POST /api/equipment`, `POST /api/inspections`, `POST /api/repair-requests`, `GET /api/approvals`,
`POST /api/approvals/{id}/decision`, `POST /api/admin/users`, `PATCH /api/admin/users/{id}`, `POST /api/admin/overdue-scan`.
The two GET endpoints accept a delegation iff the manifest lists them as read tools for that role
(`kit.readToolPolicy('GET /api/equipment', roles)`); every write refuses a delegation with `403 delegation_not_permitted`.

```
T=<EQUIPMENT_SERVICE_TOKEN>
# an employee issues a code for themselves (session cookie from POST /api/auth/login)
curl -s -X POST -H "cookie: eq_session=…" localhost:19730/bridge/v1/me/link-codes
{"ok":true,"code":"457639","expiresAt":"…"}
# DSH links the account the code was sent from
curl -s -H "x-service-token: $T" -H 'content-type: application/json' localhost:19730/bridge/v1/identities/link \
  -d '{"code":"457639","source":{"platform":"slack","teamId":"T01","userId":"U02"}}'
# a delegation for that sender, then a read tool as that employee
curl -s -H "x-service-token: $T" -H 'content-type: application/json' localhost:19730/bridge/v1/delegations \
  -d '{"source":{"platform":"slack","teamId":"T01","userId":"U02"}}'
curl -s -H "x-service-token: $T" -H "x-delegation-token: bdg_…" "localhost:19730/api/equipment?overdueOnly=true"
```

## The manifest (`bridge.manifest.yaml`)

`node packages/protocol/bin/bridge-validate.mjs manifest examples/equipment-inspection/bridge.manifest.yaml` → ok, no warnings
(also checked at every start-up by the kit and by `test/domain.test.mjs`).

- **system** `equipment-inspection` (= the application id in the DSH registry), time zone `Asia/Tokyo`
- **roles** `admin` / `manager` / `inspector` (all `delegation: propose`; inspector `scope: assigned`)
- **tools** (namespace `facility`) `facility_list_equipment` (read, all roles), `facility_list_overdue` (read, admin / manager),
  `facility_propose_reschedule` (propose → `POST /bridge/v1/proposals` kind `inspection_reschedule`)
- **events** `inspection.overdue` (audience `assignee_and_managers`, notify `inspection.overdue` with digest 60 min,
  playbook `overdue_followup`), `inspection.completed`, `approval.requested` / `approval.decided` (internal `approvals_im`),
  `sns_identity.unlinked` (internal `identity`)
- **template** `inspection.overdue` with typed params `count` (integer), `daysOverdue` (integer), `dueOn` (date)
- **playbook** `overdue_followup` (agent `facility-inspection`, `only_if_actionable`, disabled until an operator enables it)
- **report** `daily_inspection` at `30 8 * * *` for admin / manager, `sectionsByRole` (inspector: `overdue`, `inspections`)

Proposal kinds (hooks): `inspection_reschedule` (admin, manager, inspector; accepting sets the next due date) and
`equipment_retire` (admin, manager; an inspector delegation gets `403 role_not_permitted`).

## Tests and conformance

```
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres pnpm --filter @dsh-bridge/example-equipment-inspection test
#   test/domain.test.mjs       16 business-flow tests (temporary database fw_equipment_unit_test)
#   test/conformance.test.mjs  52 conformance checks + "all passed" (temporary database fw_equipment_test)
```

Each file starts its own in-process instance on an ephemeral port with a temporary database that is dropped and recreated at
the start and **dropped at the end** (only `*_test` databases are ever dropped; the protected names are refused). They never
use a running instance. The tests read the server from `FW_TEST_DATABASE_URL` (`postgres://<user>:<password>@<host>:5432/<any database>`; only the
server and credentials are used, the database names are the two above) and are **skipped with a message when it is unset**.

`test/conformance.test.mjs` runs the suite of `@dsh-bridge/protocol` (`conformance/suite.mjs`) through
`conformance/adapters/http.mjs` — the generic adapter any system uses (`BRIDGE_BASE_URL` + `BRIDGE_FIXTURES`), no rewrite, no
normalisation — and asserts that every check ran and passed (P1–P6, L1–L10, B1–B4, D1–D7, S1–S5, PR1–PR3, A1–A4, N1–N3,
R1–R3, E1–E4, M1–M3). The manifest comes from `GET /bridge/v1/manifest`, not from the file.

`test/fixtures.mjs` is a regular `BRIDGE_FIXTURES` module: employees and data are created through the system's own business
API (an admin session); only the bootstrap admin, "time passes" (`store.expireLinkCodes` / `store.expireDelegation`) and the
event-writer probe (`emitEvent` in a rolled-back `store.tx`) touch the test database. The suite uses generic role names in a
few checks (`staff`, `billing`); the fixtures map both to `inspector`. Against a running TEST instance:

```
EQUIPMENT_DATABASE_URL=postgres://…/fw_equipment_test EQUIPMENT_SEED=0 EQUIPMENT_SCHEDULER=0 pnpm --filter @dsh-bridge/example-equipment-inspection start
BRIDGE_BASE_URL=http://127.0.0.1:19730 BRIDGE_SERVICE_TOKEN=<token> BRIDGE_BFF_SECRET=<secret> \
BRIDGE_FIXTURES=examples/equipment-inspection/test/fixtures.mjs EQUIPMENT_DATABASE_URL=postgres://…/fw_equipment_test \
node --test packages/protocol/conformance/http.test.mjs
```

## Register it in a DSH profile (`bridge-apps` of `@dsh-bridge/dsh-core`)

The product profile's `cordis.patch.yml` (see [`profile/`](../../profile)) lists the applications of one DSH. Bots come from
configuration only; one bot belongs to exactly one application — except a personal WeChat bot, which can carry several
applications with `multiApp: true` in **every** listing (in-window switching).

```yaml
- id: bridge-apps
  name: '@dsh-bridge/dsh-core'
  config:
    strict: true                               # with several applications: a bot nobody lists is served by nobody
    applications:
      - id: care-billing                       # an existing application (examples/care-billing)
        # ... unchanged ...
      - id: equipment-inspection               # = manifest system.id
        name: 設備点検
        aliases: [点検]                         # extra names for 「#点検」 on a shared bot
        namespace: facility                    # the manifest tools are facility_*
        apiUrlEnv: INSPECTION_API_URL          # e.g. http://127.0.0.1:19730 (read per call; falls back to apiUrl)
        apiUrl: http://127.0.0.1:19730
        serviceTokenEnv: INSPECTION_SERVICE_TOKEN   # the same value the system was started with (EQUIPMENT_SERVICE_TOKEN)
        manifestUrl: /bridge/v1/manifest       # etag / 304
        manifestFile: pkg:@dsh-bridge/example-equipment-inspection/bridge.manifest.yaml   # fallback when the URL is unreachable
        paths: v1                              # native /bridge/v1
        generateTools: true                    # facility_list_equipment, facility_list_overdue (read, delegation gate)
        agents: [facility-inspection]
        delegation: { unattendedPolicy: deny } # automatic tasks without an IM sender get no business data
        bots:
          - { platform: slack, botId: <bot id of the 設備点検 Slack app> }
          - { platform: wecom-app, botId: <dsh-im bot id of the 設備点検 WeCom self-built app> }
          - { platform: weixin, botId: <personal WeChat bot>, multiApp: true }   # shared with care-billing (also multiApp there)
```

- `facility_propose_reschedule` is a propose tool, so it is not generated: `@dsh-bridge/plugin-tools` ships it as the
  hand-written tool module `@dsh-bridge/plugin-tools/examples/equipment-inspection` (`plugins/tools/src/examples/`), which
  posts `{ kind: 'inspection_reschedule', payload: { equipmentId, dueOn } }` to `/bridge/v1/proposals` with the delegation:
  ```yaml
  - id: bridge-tools
    name: '@dsh-bridge/plugin-tools'
    config:
      toolModules:
        - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: equipment-inspection }
  ```
- The playbook `overdue_followup` is deployed by `@dsh-bridge/plugin-events` from the manifest (disabled until an operator
  enables it); its agent preset `facility-inspection` lists the generated tools.
- Two applications, two links: the employee issues a code in each system's web UI and sends it to that system's bot (each
  system has its own `bridge_identity`). A delegation of one application is never usable in the other (different service
  token, different database). On the shared personal WeChat bot, `#設備点検` / `#点検` / `#一覧` switch the current
  application, replies carry 【設備点検】, and `連携 123456` goes to the CURRENT application.

## Scaling and limits

- Stateless HTTP: sessions, throttles, codes, delegations and events all live in PostgreSQL; instances can be added behind a
  load balancer. The scheduler is idempotent (unique overdue notices / report slots) and can run on every instance.
- The kit's event writer takes a transaction-scoped advisory lock so ids commit in order (a cursor never skips an event);
  that serialises event inserts — fine at this scale.
- Example only: no password reset, no admin UI beyond the API, no HTTPS termination (`Secure` cookies only with
  `NODE_ENV=production`), quiet hours are reported to the IM side but not computed here, approvals do not expire by a job
  (an expired one answers 410).
