# @dsh-bridge/server-kit

L2 of the Biz Assistant Framework (packages `@dsh-bridge/*`): the Node parts a **business system** uses to implement Bridge protocol v1
(`packages/protocol/openapi/bridge-v1.yaml`). Generalized from `examples/bridge-demo` of care-ai-native (the native v1
implementation) and from care-api `src/routes/bridge.mjs` (v1 as aliases of an existing API).

The business keeps its own tables, users, sessions and rules. The kit gives it every `/bridge/v1` endpoint, the access gate,
link codes, delegations, the transactional event outbox with the manifest's per-type payload whitelist, notification
resolution and delivery records, approval cards with one-time tokens / reply codes, reports, proposals, the manifest
endpoint with an etag, the PII scan, the `bridge-protocol: 1` header and the `{ ok:false, error }` envelope. What only the
business knows comes in through **hooks**.

```
pnpm add @dsh-bridge/server-kit @dsh-bridge/protocol pg      # pg only for the PostgreSQL store
pnpm add @dsh-bridge/server-kit @dsh-bridge/protocol mysql2  # mysql2 only for the MySQL 8 / TiDB store
```

ESM, Node >= 22.19, no runtime dependency besides `@dsh-bridge/protocol` (and the optional peers `pg` / `mysql2`). The first complete user
is [`examples/equipment-inspection`](../../examples/equipment-inspection) (52 / 52 conformance checks).

## Parts

| module | exports | what it does |
|---|---|---|
| `app` | `createBridgeApp(options)`, `listen(handler, { port, host })` | wires manifest + store + gate + v1 routes + hooks → `{ handler, middleware, router, kit }`. `handler` is a `node:http` listener (404 for unknown paths); `middleware(req, res, next)` mounts it in express / connect (unknown paths → `next()`; an already parsed `req.body` is accepted) |
| `http` | `createRouter`, `HttpError`, `fail`, `sendJson`, `sendError`, `readBody`, `baseHeaders`, `strictKeys`, `parseSource`, `PLATFORM_RE`, `UUID_RE`, `DATE_RE`, `TIME_RE` | router (404 / 405 + `allow`), JSON-object bodies only (64 KiB), error envelope, `bridge-protocol: 1` on every response |
| `gate` | `gate(principal, policy, req, { bffSecret })`, `createPrincipalResolver`, `POLICY` (`PUBLIC` / `SERVICE` / `USER` / `BFF`), `readToolPolicy`, `userRef` | principals `service` / `delegated` / `user` / `anon`; a route policy `{ allow, roles?, delegatedRoles?, bff?, public? }` is checked **before** any lookup |
| `manifest` | `loadManifest({ file } \| { manifest })`, `etagMatches`, `notifiableTypes`, `aiAllowlist`, `reportDecl`, `cronToSlot` | load + validate (fail fast), strong etag, the AI allow-list from manifest `tools` (read tools only) |
| `events` | `createEventWriter(manifest)`, `checkEvent`, `EventRejected`, `eventJson` | `emitEvent(t, { type, aggregateType, aggregateId, payload })` inside a store transaction; undeclared type / key not whitelisted for THAT type / PII-looking key or value → `EventRejected` (values never echoed) |
| `store/memory` | `createMemoryStore({ now?, serverKey? })` | in-memory store (tests, prototypes): serialised transactions with snapshot rollback, injectable clock |
| `store/postgres` | `createPostgresStore({ pool })` → `store.migrate()` | the `bridge_*` tables (`store/migrations/001_bridge.sql`, `002_event_delegation.sql`, `003_ai_profile.sql`: `bridge_ai_profile_version`, `004_assistant_attachments.sql`: `bridge_assistant_attachment_settings`, one row, `005_connectors.sql`: `bridge_connector` (definition + sealed secret + hint), `bridge_connector_rule`, `bridge_connector_run` (ids, status, code, timing only), `bridge_connector_state` (the emergency stop, the event cursor, the last cron minute)); `store.tx(fn)` gives `fn(t)` with `t.db` = the transaction's pg client so business rows and events commit together; event ids commit in order (advisory lock) |
| `store/pg` | `createPool`, `ensureDatabase`, `dropDatabase` (only `*_test` by default), `databaseName`, `migrate(pool, { migrations, table })`, `readMigrations(dir)`, `withTransaction`, `bridgeMigrations` | database lifecycle with protected names, an ordered advisory-locked migration runner for the app's own SQL too |
| `store/mysql` | `createMysqlStore({ pool })` → `store.migrate()` (`kind: 'mysql'`) | the same `bridge_*` tables on MySQL 8.0.16+ / TiDB (`store/migrations-mysql/001`–`005`, same ids as the PostgreSQL ones), the same contract (`test/store-contract.mjs`); `store.tx(fn)` gives `fn(t)` with `t.db` = the transaction's mysql2 connection (business SQL runs on it); duplicate keys (1062) → `StoreConflict(<index name>)`; event ids from a locked counter (see "MySQL / TiDB") |
| `store/mysqldb` | `createMysqlPool(url, { max })`, `mysqlConnectionOptions(url)`, `ensureMysqlDatabase`, `dropMysqlDatabase` (only `*_test` by default; never `mysql`, `information_schema`, `performance_schema`, `sys`, `test`, `metrics_schema`), `migrateMysql(pool, { migrations, table })`, `splitSqlStatements`, `withMysqlTransaction`, `bridgeMysqlMigrations`, `loadMysql`, `MYSQL_SYSTEM_DATABASES` | `mysql2/promise` loaded lazily; TLS unless local, UTC sessions; an ordered migration runner serialised across processes with `GET_LOCK` (per database and table), for the app's own SQL too |
| `alias` | `registerAliasRoutes(router, { table, from, adapters })`, `aliasTableFromOpenApi(doc, { key })`, `pickAlias`, `camelRows` | serve `/bridge/v1` as aliases of an **existing** API: same handler, the existing route's policy re-checked for the principal, `shape` adapters |
| `routes/help` | option `help` of `createBridgeApp` | optional: `GET /bridge/v1/help/search` (employee / delegation / service = public sections only), `/help/public` (service only), `/help/sections/:sectionId`, answered by the help service you pass (`@dsh-bridge/help` `createHelpService`) for the asker's role; `help.onQuestion(entry, ctx)` for your own log |
| `routes/ai-profile` | `aiProfileEtag`, `AI_PROFILE_REASON_MAX` (200), `AI_PROFILE_VERSIONS_SHOWN` (20); option `aiProfile` (false: off), `roles.admins` | optional: the AI employee's profile (`GET /bridge/v1/ai-profile` for the DSH, the administrators' `GET / PUT /admin/ai-profile` and restore; versions in `bridge_ai_profile_version`, audit `ai_profile.updated` with the version number only). Endpoints below |
| `routes/connectors`, `@dsh-bridge/server-kit/connectors` | `createConnectorService`, `registerConnectors`, `CONNECTOR_WRITE_KIND` (`connector_write`); storage-free parts: `createConnectorRunner` (https to allowed hosts only, http to localhost with `allowLocalhost`, redirects refused, timeout ≤ 10 s, calls per minute, response size cap, one retry of an idempotent call, `test()`), `connectorSecretKey` / `sealSecret` / `openSecret` / `secretHint` / `checkSecret` (AES-256-GCM, the connector id as additional data, the hint = the last 4 characters), `createRuleEngine` / `ruleData` / `minuteKey` (event / cron → auto / approval / propose-by-ai, the stop switch, every outcome recorded) | optional: the AI employee's external connectors (docs/AI_EMPLOYEE_PROFILE.md §3). `createBridgeApp({ connectors: { secretKey, allowLocalhost?, fetch?, onApprovalNeeded?, onProposeByAi?, onRunResult? } })` adds the routes, the proposal kind `connector_write` (the input sealed; accepting it runs the write; a failure keeps it pending, 502 `connector_failed`) and `kit.connectors.tick()` (the rules: a scheduler task). Endpoints below |
| `extract` (`@dsh-bridge/server-kit/extract`) | `detectAttachmentType(name, mediaType, bytes?)`, `checkAttachments(files, limits?, settings?)`, `extractDocument({ name, mediaType, bytes }, limits?, { pdfText?, ocr?, ocrPages? })`, `prepareAttachments(files, { limits, settings, pdfText, ocr })`, `attachmentSummary`, `createPdfTextExtractor({ resolveFrom })`, `resolveLimits`, `decodeText`, `parseCsv`, `markdownTable`, `ATTACHMENT_LIMITS`, `ATTACHMENT_TYPES`, `DEFAULT_ATTACHMENT_ROLES`, `ATTACHMENT_ERRORS`, `AttachmentError` | files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md), pure and in memory: the type by extension AND leading bytes (PNG / JPEG / WebP / GIF, PDF, docx, xlsx, CSV, Markdown, text; macro-enabled / xls / doc / archives refused), the limits (5 files, 10 MB, 20 MB, 30,000 / 60,000 characters), documents → Markdown (txt / md / csv with UTF-8 / Shift_JIS detection, docx paragraphs / headings / lists / tables, xlsx one table per visible sheet with display-like values and 2,000 rows, pdf text layer with `--- p.N ---` through pdf.js in a child process when `pdfjs-dist` can be found — server-kit does not depend on it; pass `pdfText` or `createPdfTextExtractor({ resolveFrom: import.meta.url })` of the app's own copy); OCR of scanned pages (no text layer, blank pages skipped): rendered to JPEG in the same child process with the canvas module next to pdf.js (`@napi-rs/canvas`), up to `maxOcrPages` (10) per prepare, then read by the app's `ocr(bytes, { mediaType, page }) -> text` engine when given (`ocr: 'engine'`, nothing leaves) or returned as `pageImages` for a model that reads images (`ocr: 'model'`); `settings.ocr: false` turns it off; `no_text` reasons `ocr_unavailable` / `ocr_off`; the audit summary adds `ocrPages` |
| `scheduler` | `startScheduler({ kit, tasks, everyMs })` | the manifest's daily report slots (`cron: ["30 8 * * *"]`, unique per date / slot) + periodic business tasks (an overdue scan) |
| `crypto` | `sha256`, `safeEqual`, `newToken`, `hashPassword`, `verifyPassword`, `DUMMY_PASSWORD_HASH`, `linkCodeHash`, `cardToken`, `cardReplyCode` | opaque tokens stored as hashes only; link codes keyed per database; card token / reply code derived from the delivery id (idempotent re-delivery without storing them) |
| `time` | `localParts`, `todayIn`, `addDays`, `daysBetween`, `isValidDate` | dates in the manifest's time zone |

## Minimal system

```js
import { createServer } from 'node:http'
import { createBridgeApp, createPool, createPostgresStore } from '@dsh-bridge/server-kit'

const pool = await createPool(process.env.MY_DATABASE_URL)
const store = createPostgresStore({ pool })
await store.migrate()                                  // bridge_* tables (idempotent)

const bridge = await createBridgeApp({
  manifest: { file: './bridge.manifest.yaml' },        // validated now; served at GET /bridge/v1/manifest with an etag
  store,
  serviceToken: process.env.MY_SERVICE_TOKEN,          // DSH's x-service-token
  bffSecret: process.env.MY_BFF_SECRET,                // the business web BFF's x-bff-secret
  orgId: 'my-org', service: 'my-system', version: '1.0.0',
  hooks: {
    employees: {
      get: async (id, ctx) => /* { id, role, active } | null */ null,
      list: async ({ roles }, ctx) => /* active employees with one of the roles */ [],
    },
    authenticate: async (req) => /* { user: { id, role }, sessionId } from YOUR session cookie / bearer */ null,
    isSessionLive: async (sessionId, ctx) => true,
    recipientsFor: async (event, ctx) => null,          // see "Hooks"
  },
})

// the business API behind the same gate; a read endpoint the AI may call iff the manifest lists it as a read tool
bridge.router.add('GET', '/api/things', bridge.kit.readToolPolicy('GET /api/things', ['admin', 'staff']), async ({ principal }) => ({
  status: 200, body: { ok: true, things: [] },
}))
bridge.router.add('POST', '/api/things', { allow: ['user'] }, async ({ principal, body }) => {
  return bridge.kit.tx(async (t) => {                  // business rows and the event: one transaction (outbox)
    const { rows } = await t.db.query('insert into thing (name) values ($1) returning id', [body.name])
    await bridge.kit.emitEvent(t, { type: 'thing.created', aggregateType: 'thing', aggregateId: rows[0].id, payload: { thingId: rows[0].id } })
    return { status: 201, body: { ok: true, id: rows[0].id } }
  })
})

createServer(bridge.handler).listen(8080)
```

## MySQL / TiDB

```js
import { createMysqlPool, createMysqlStore } from '@dsh-bridge/server-kit'

const pool = await createMysqlPool(process.env.MY_DATABASE_URL, { max: 10 })   // mysql://user:password@host:4000/db
const store = createMysqlStore({ pool })
await store.migrate()
// in a transaction: const [res] = await t.db.query('insert into thing (name) values (?)', [name]); res.insertId
```

- **TLS**: `createMysqlPool` connects with TLS 1.2+ and verifies the server certificate (TiDB Cloud requires it) unless the
  host is `localhost` / `127.0.0.1` / `::1`. `?ssl=false` turns it off (a plain MySQL on a private network), `?ssl=true`
  forces it on localhost. Size `max` to the plan's connection limit.
- **UTC**: every connection of `createMysqlPool` runs `set time_zone = '+00:00'` and uses `timezone: 'Z'`; times are
  `DATETIME(6)` holding UTC. The store itself writes `UTC_TIMESTAMP(6)`, formats Date parameters in UTC and reads times as
  UTC, so it also works on a pool of the business's own (keep mysql2's default `FOUND_ROWS` flag: update counts are rows
  matched, as in PostgreSQL).
- **Event ids**: TiDB's `AUTO_INCREMENT` is handed out in batches per TiDB server, so it is not monotonic, and the cursor of
  `GET /events?after` needs ids that commit in increasing order. `insertEvent` takes the next id from the one-row counter
  `bridge_event_seq` (`update … set last_id = last_insert_id(last_id + 1)`: the row stays locked until the transaction
  ends, like `SELECT … FOR UPDATE`), so event writers are serialised and a rolled-back id is never seen. Outside a
  transaction it opens its own. Use the default pessimistic transactions of TiDB. The audit log, throttle hits and
  connector runs keep `AUTO_INCREMENT` with TiDB's `AUTO_ID_CACHE=1` (increasing allocation, for "newest first").
- **Dialect**: no `RETURNING` (UUIDs are made in JS, rows read back), `ON DUPLICATE KEY UPDATE` for upserts, partial unique
  indexes as unique indexes on a "live" virtual column (same index names), `utf8mb4_bin` (exact comparisons, as in
  PostgreSQL), `report_date` back as `YYYY-MM-DD`, booleans and JSON normalised. DDL is not transactional: a migration that
  stopped half-way is run again, skipping objects that already exist.
- **Tests**: `FW_TEST_MYSQL_URL=mysql://<user>:<password>@<host>:<port>/<db>` runs the store contract in a temporary
  `fw_serverkit_test` database (created and dropped by the test); unset → skipped.

## Hooks

Every hook receives `ctx = { db, t, emitEvent, now, lock? }`: `t` is the store transaction the kit is in (`t.db` the pg client),
`ctx.emitEvent(event)` writes an event in it, `ctx.lock` is true where the kit expects a `FOR UPDATE`.

| hook | required | contract |
|---|---|---|
| `employees.get(id, ctx)` | yes | `{ id, role, active }` or null. Every delegation use, link and decision re-checks it (a deactivated employee loses every token at once) |
| `employees.list({ roles }, ctx)` | yes | active employees having one of the roles (report recipients) |
| `employees.getMany(ids, ctx)` | no | batch form of `get` (identity statistics) |
| `authenticate(req)` | for `/me/*` | the employee's OWN session → `{ user: { id, role }, sessionId }` or null. The kit never sees passwords |
| `isSessionLive(sessionId, ctx)` | no | web-assistant tickets and their delegations die with the web session |
| `recipientsFor(event, ctx)` | for notifications | `null` (not notified) · `{ stale: 'reason' }` (no longer true) · `{ users: [{ id, role }], paramsFor(user) → typed params, link, dedupeKey, template? }`. The kit applies each employee's preference, the already-notified rule, the order of the requested `platforms` and quiet hours |
| `approvals.get(id, ctx)` | for approvals | `{ id, status, expiresAt, requestedBy, ... }` or null (`ctx.lock`: lock the row). `approvals.state(a)` maps your statuses to `'pending'` when they differ |
| `approvals.approvers(approval, ctx)` | 〃 | eligible approvers `[{ id, role }]` (the requester is always removed by the kit) |
| `approvals.card(approval, ctx)` | 〃 | `{ title, fields: [{ label, value }], body }` — IDs, amounts, deadlines only |
| `approvals.mayDecide(approval, user, ctx)` | 〃 | THE rule your web UI uses too |
| `approvals.decide(approval, { action, actor, channel: 'im', comment, deliveryId }, ctx)` | 〃 | apply the decision in `ctx.t` (emit `approval.decided`); the kit marks the card used and revokes every other card. A web decision calls `t.revokeApprovalDeliveries({ approvalId })` itself |
| `proposalKinds[kind]` | for proposals | `{ roles, validate(payload, ctx, principal), apply(payload, actor, ctx, proposal) }` — a delegation may propose only kinds its role has; `apply` runs only when a reviewer accepts |
| `reports.compute(viewer, ctx)` | for reports | `viewer = { id?, role?, sections }` → `{ sections: { <name>: counts }, attention, date? }`; the kit keeps only `viewer.sections` (`sectionsByRole` of the manifest) |
| `documentReads` | when the system takes in images / PDFs without a text layer | `{ claim({ limit }, ctx) -> { reads: [{ id, purpose?, language?, hint?, pages: [{ page, mediaType, data }] }] }, answer(readId, { pages: [{ page, text }] } | { error }, ctx) }` — `GET /bridge/v1/document-reads` / `POST .../:readId/result` (service only; docs/DOCUMENT_READS.md). The system keeps the reads, claims them (10 minutes), turns the text into its own fields and has a person confirm every value; `answer` throws `fail(404, 'read_not_found')` / `fail(409, 'read_not_claimed')`. Without it both routes are 404 after the gate |
| `piiScan(text, ctx)` | when the texts may carry names (bridge-memory) | `-> { kinds: string[] }` — the business system's own check (staff / client names from the roster, ...), added to `POST /pii-scan`'s shape check. Throwing → 503 `pii_scan_failed` (the caller keeps nothing). Without it only the shape check runs (no names) |
| `eventDelegations[eventType]` | for playbooks with `delegation: <class>=each` | `{ eligible(event, user, ctx) -> boolean, personOf?(event) -> employee id, maxAgeHours? }` — opt-in per declared event type: `POST /delegations { event: { id } }` issues a delegation for the person the business's OWN event names (`personOf`, default `event.payload.userId`), only while the event is fresh (default 12 h, `EVENT_DELEGATION_MAX_AGE_HOURS`) and the person is active and `eligible` (their own setting). Checked at issue AND on every use: when the setting is turned off or the event goes stale, the token stops at once. Without the hook `{ event }` is 400 |

Options besides hooks: `roles: { reportReaders, reportRunners, proposalReviewers, admins }` (defaults: the report audience,
`admin`, the report readers, `admin`; `admins` edit the AI employee's profile), `aiProfile` (false: no profile routes), `attachments` (false: no attachment routes; `{ defaultRoles, limits, pdfText, ocr }`), `personalBotPlatforms` (default `PERSONAL_BOT_PLATFORMS`: every dsh-im channel whose bots can be
created per employee — slack, line, teams, telegram, discord, weixin, whatsapp, wecom, wecom-app, qq, dingtalk, feishu, matrix; not email
(notify-only), not iMessage; the same list as ケアビリング's care-api. Pass a narrower list to opt a channel out; `wechat` is read as
`weixin`), `linkGlobalMaxFailures` (1000 / 10 min), `now` (tests), `log`.

The `kit` object (also passed to every route handler as `kit`): `store`, `manifest`, `emitEvent(t, event)`, `tx(fn)`,
`readToolPolicy(endpoint, roles)`, `identityOf(source)` (with the personal-bot owner rule), `employeesById(ids)`, `reports.{ compute, generate, latest }`,
`today()`, `timeZone`, `serverKey`, `resolvePrincipal(req)`, `eventDelegations.{ enabled, check(event, t) }`.

## Bridge v1 endpoints

| v1 | principal | notes |
|---|---|---|
| `GET /bridge/v1/health` (and `/health`) | anyone | `{ ok, protocol: 1, service, version }` |
| `GET /bridge/v1/manifest` | service | the manifest as JSON, strong `etag`, `If-None-Match` (weak or strong, `*`) → 304 |
| `GET /bridge/v1/identity` | service | active employee behind `platform/teamId/userId`; unlinked → `{ ok, linked:false, orgId }` only. **Personal-bot owner rule** (`botId` = the bot the message came through): through a registered personal bot the account resolves only to the bot's registrant — another employee writing to someone's personal bot is `linked:false` there; a retired bot resolves nobody; organisation bots and no `botId`: unchanged. The same rule applies to `POST /delegations` and the IM approval decisions (`identityOf`) |
| `POST /bridge/v1/identities/link` | service | `{ code, source }` only; binds the ISSUER; single use; 10 min; 5 failures / source / 10 min → 429; personal-bot owner rule |
| `GET /bridge/v1/identities/stats` | service | counts only |
| `POST /bridge/v1/me/link-codes` | employee | for myself (body ignored); a new code revokes the old one; 20 / 10 min |
| `GET /bridge/v1/me/identities`, `DELETE …/{id}`, `GET …/{id}/bot` | employee | own links only (someone else's = 404, admin too). Unlink ends delegations and cards, retires a personal bot, emits `sns_identity.unlinked` |
| `GET /bridge/v1/me/personal-bots` · `POST` (BFF secret) | employee | own bots; `bff_only` refusals are audited; someone else's bot → 409 |
| `GET / PUT /bridge/v1/me/notification-preferences` | employee | own; `userId` in the body → 400; types = the manifest's notified events |
| `POST /bridge/v1/delegations` | service | `{ source }` (unlinked or not the owner of the personal bot → 404, no token) or `{ event: { id } }` (per-event delegation, `hooks.eventDelegations`: unknown event 404 `event_not_found`, type not delegable 422 `event_not_delegable`, stale 409 `event_stale`, person not eligible 403 `event_delegation_refused`, both keys 400 `source_or_event`; without the hook `event` is 400). ≤ 5 min; audited (`delegation.issued` / `delegation.refused`) |
| `GET /bridge/v1/events?after&limit` | service | cursor; ids commit in order; payload whitelisted per type |
| `GET /bridge/v1/notifications/for-event/{eventId}?platforms=` | service | recipients from `hooks.recipientsFor` only (the DSH side never adds anyone), own preference, already-notified excluded, `stale` |
| `POST /bridge/v1/notifications/deliveries` | service | `sent` / `skipped` terminal; unresolved pairs → `unknown` |
| `POST /bridge/v1/approvals/{id}/deliveries` · `…/{deliveryId}/sent` | service | one card per eligible approver; idempotent; a locked card is never re-issued |
| `POST /bridge/v1/approvals/{id}/im-decision` · `POST /bridge/v1/approvals/im-decisions` | service | token or reply code bound to one employee; same rule as the web; 5 wrong codes lock the card; reply code alone among the employee's own live cards |
| `POST /bridge/v1/assistant/tickets` (BFF secret) · `POST /bridge/v1/assistant/delegations` | employee · service | 30 min ticket bound to the web session; delegation ≤ 5 min and ≤ the ticket |
| `GET /bridge/v1/reports/latest` · `POST /bridge/v1/reports/run` | readers or a delegation · runners | delegation: live snapshot scoped to the role; run: 5 / 10 min, `{ to: recipients \| me }` |
| `GET / POST /bridge/v1/proposals`, `POST …/{id}/accept \| reject` | employee or delegation (own) · service or delegation · reviewers | the AI proposes, a person decides |
| `POST /bridge/v1/pii-scan` | service | categories only (bridge-memory checks every text before saving; no answer = not saved). The shape check (phone, e-mail, postal code, long numbers, …) skips the prose kinds `cjk_text` / `free_text` (`PROSE_KINDS`) — a sentence is not personal data by itself; names need `hooks.piiScan` |
| `GET /bridge/v1/help/search?q&limit` · `GET /bridge/v1/help/public` · `GET /bridge/v1/help/sections/{sectionId}` | employee or delegation (the asker's role) · service (public sections only) | only with the option `help` (`@dsh-bridge/help` `createHelpService`; without it: the gate, then 404): a screen the asker cannot open has no `url`, only whom to ask (`alt`); `help.onQuestion(entry, ctx)` |
| `GET /bridge/v1/ai-profile` | service | the AI employee's profile (optional capability, docs/AI_EMPLOYEE_PROFILE.md): `{ ok, profile | null, version, updatedAt }`, strong `etag` from the version, `If-None-Match` → 304 |
| `GET / PUT /bridge/v1/admin/ai-profile`, `POST …/versions/{version}/restore` | employee in `roles.admins` | GET: profile + versions (newest first, ≤ 20, no text of older versions). PUT `{ profile, reason? ≤ 200 }`: `validateAiProfile` → 422 `invalid_profile` `details.errors: [{ field, code, kinds? }]` (never the matched text) or a new version. Restore: that content as a new version (checked again; unknown 404 `version_not_found`). Audited `ai_profile.updated` with the version number only. `aiProfile: false` turns the four routes off |
| `GET /bridge/v1/connectors/catalog` · `POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run` | service · delegated | optional (docs/AI_EMPLOYEE_PROFILE.md §3). The catalog: the enabled connectors' operations with roles (ids, names, read / write, roles, the input schema; never a URL or a secret; empty while stopped; etag / 304). run: a READ as the employee (role ∈ `operation.roles`, 403 `role_not_permitted` / `write_requires_approval`, 409 `connector_stopped`, 400 `invalid_value` with `details.errors`) → `{ ok, data }` (the allow-listed fields only); 429 / 502 `connector_failed` (`details.code`). Logged as a run and audited `connector.run` (status and code only) |
| `/bridge/v1/admin/connectors*` · `/admin/connector-rules*` · `/admin/connector-runs` · `/admin/connector-settings` | employee in `roles.admins` | connectors (PUT `validateConnector` → 422 `invalid_connector`; 409 `connector_in_use` when a rule would break), the secret (PUT `{ secret }` → `{ hasSecret, secretHint }` only; 422 `invalid_secret`), the connection test (a read; status, timing and the field names), rules (PUT `validateRule` against the manifest events and roles → 422 `invalid_rule`), the run log (newest first, ≤ 200), the emergency stop `{ stopped, reason? }`. Audited with ids and counts only |
| `POST /bridge/v1/assistant/attachments/prepare` (BFF secret) · `GET /bridge/v1/assistant/attachment-settings` | employee | optional (docs/ASSISTANT_ATTACHMENTS.md). prepare `{ files: [{ name, mediaType, size?, data? }] }` (documents with base64 data, images without): role and types from the settings (403 `attachments_not_allowed`), limits / type / contents (422 `too_many_files` `file_too_large` `total_too_large` `unsupported_type` `type_mismatch` `no_text` `invalid_attachment`, `details: { index, name, reason? }`) → `{ ok, documents: [{ name, kind, text, chars, truncated, pages?, sheets? }], images: [{ name, mediaType, size }] }`; nothing stored; audited `assistant.attachments` (count, types, total size: never names or contents). The JSON limit of this route is raised to the base64 of 20 MB. settings → `{ ok, enabled, roles, types, limits }` |
| `GET / PUT /bridge/v1/admin/assistant/attachment-settings` | employee in `roles.admins` | `{ roles (manifest roles), types (image / pdf / docx / xlsx / csv / markdown / text) }`; before a save: `DEFAULT_ATTACHMENT_ROLES` (admin, manager, billing) within the manifest roles and every type. Audited `assistant.attachment_settings.updated`. `attachments: false` turns the four routes off |

## An existing API: aliases instead of a rewrite

A system that already serves the Bridge operations under other paths maps them (the care-api way):

```js
import { aliasTableFromOpenApi, camelRows, registerAliasRoutes } from '@dsh-bridge/server-kit'
const table = [
  { operationId: 'getIdentity', method: 'GET', path: '/identity', aliases: [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] },
  { operationId: 'listMyIdentities', method: 'GET', path: '/me/identities', aliases: [{ method: 'GET', path: '/api/sns-identities', status: 'shape' }] },
]                                                     // or aliasTableFromOpenApi(openapiDoc) (extension x-alias), or the rows of examples/care-billing/manifest/care-api-v1-aliases.json
registerAliasRoutes(router, { table, from: legacyRouter, adapters: { listMyIdentities: camelRows('identities') } })
```

Each alias entry may say `for: ['service' | 'delegated' | 'user']` (a different existing route per principal) and
`query: { … }` (defaults added to the query). Unresolvable aliases are reported in `skipped`, never silently served.

## Tests

```
pnpm --filter @dsh-bridge/server-kit test
```

`test/app.test.mjs` (end-to-end over HTTP on the memory store with a fictional "toy tasks" system), `store-memory` /
`store-postgres` / `store-mysql` (the same store contract on all three; PostgreSQL and MySQL / TiDB each in a temporary `fw_serverkit_test` database that is dropped at
the end; the servers come from `FW_TEST_DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>` and `FW_TEST_MYSQL_URL=mysql://<user>:<password>@<host>:<port>/<db>`, each skipped when unset or unreachable), `http`, `events-gate`,
`crypto-manifest-time`, `alias-scheduler`, `help` (the help routes per principal and role), `owner-rule-event-delegation`, `ai-profile` (the profile routes on the memory store and on PostgreSQL in its own `fw_p1w1_test`; ports 20181–20183).
