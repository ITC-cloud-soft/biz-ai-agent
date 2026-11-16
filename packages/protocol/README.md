# @dsh-bridge/protocol

Bridge protocol **v1** (L1 in `docs/ARCHITECTURE.md`): what a business system provides so the AI plane (DSH) and
SNS (Slack / LINE / WeChat / WeCom / Teams ...) can work with it, plus the tools to prove it.

| | |
|---|---|
| `openapi/bridge-v1.yaml` | OpenAPI 3.1 for every endpoint group (identity, me, delegations, events, notifications, approvals, assistant, reports, proposals, manifest; optional: `pii-scan` (checked by long-term memory before saving), the manual search `help/search` · `help/public` · `help/sections/{sectionId}` (`@dsh-bridge/help`), the AI employee's profile `ai-profile` and its administration `admin/ai-profile*`, the files attached in the assistant panel `assistant/attachments/prepare`, `assistant/attachment-settings` and `admin/assistant/attachment-settings`, the AI employee's external connectors `connectors/catalog`, `connectors/{connectorId}/operations/{operationId}/run` and their administration `admin/connectors*`, `admin/connector-rules*`, `admin/connector-runs`, `admin/connector-settings`). Auth schemes, the `bridge-protocol: 1` header, the error envelope and code catalog. |
| `schema/manifest.schema.json` | JSON Schema of the business manifest. |
| `schema/event-envelope.schema.json` | JSON Schema of one event. |
| `manifests/example.manifest.yaml` | A small generic manifest (日報 / daily reports: roles, events, templates, tools, a playbook, a report). Start here. |
| `manifests/equipment-inspection.manifest.yaml` | Reference copy of the equipment-inspection example's manifest (`examples/equipment-inspection`, system id `equipment-inspection`). |
| `manifests/helpdesk.manifest.yaml` | English example: an IT helpdesk (tickets, response-time breaches, escalation proposals, paid vendor work approved in chat). |
| `manifests/inventory.manifest.yaml` | English example: inventory and purchase orders (low stock, reorder proposals, purchase-order approval). |
| `manifests/attendance.manifest.yaml` | English example: attendance and timesheets (missing clock-in, late timesheets, overtime approval). |
| `src/` | Zero-dependency library: `validateManifest`, `validateEvent`, `validateEventPage`, `checkPayloadWhitelist`, `checkNotificationParams`, `validateAiProfile` / `normalizeAiProfile` / `aiProfileFor` with `AI_PROFILE_LIMITS`, `AI_PROFILE_TONES`, `RULE_OVERRIDE_PATTERNS` (the AI employee's profile: limits, tone presets, per-agent overrides, rule-override wording and personal data refused, the matched text never returned), `validateConnector` / `validateOperation` / `validateRule` with `CONNECTOR_LIMITS`, `evaluateWhen`, `renderRuleInput`, `checkOperationInput`, `buildOperationRequest`, `pickResponseFields`, `parseCron` / `cronMatches`, `connectorToolName` (the external connectors of docs/AI_EMPLOYEE_PROFILE.md §3: https and allowed hosts, operations with an input schema / response allow-list / PII class / read or write / idempotent / roles / auto-run with a reason, rules with eq / contains / gt / lt / exists conditions and `{payload.x}` templates; errors are `{ field, code }` only), `findPiiInString` / `scanJson` (PII probes), a YAML-subset parser, a JSON-Schema-subset validator, OpenAPI helpers. |
| `bin/bridge-validate.mjs` | CLI over the library. |
| `conformance/` | The conformance suite, the generic HTTP adapter (`adapters/http.mjs`) and an example application adapter (`adapters/example-adapter.mjs`). |
| `test/` | Unit tests and mutation tests of the suite (an in-memory mock Bridge). |

Private, ESM, **no dependencies** (the YAML and JSON Schema support is a deliberate subset, see "Limits").
The manifest of the first user (ケアビリング) lives in `examples/care-billing/manifest/` together with its v1 → care-api route table.

## Integrating a new business system

1. **Write the manifest** (`bridge.manifest.yaml`, or serve it at `GET /bridge/v1/manifest`).
   It is the self introduction Bridge reads: roles and their AI delegation ceiling, entities with a personal-information class,
   events (payload whitelist, severity, audience, notify template, playbook), notification templates with typed parameters
   (and an optional `intent: info | action | urgent | approval | consult` + `action` text, rendered as 【ご報告】/【対応のお願い】/【至急】/【承認のお願い】/【ご相談】),
   tools (HTTP endpoint, `read` | `propose`, roles, input), playbooks (agent, trigger = events | cron | condition, instructions,
   tools, audience, delivery, approval), reports, glossary, optionally `help` (`tool`: the read tool on `GET /bridge/v1/help/search` that the
   DSH generates as the manual search, `@dsh-bridge/help`) and `web.routes` (the path patterns of the business web's screens:
   the AI's answers may link only these, bridge-identity's link guard drops other links). Start from `manifests/example.manifest.yaml`.
   ```
   node packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml     # in CI
   ```
   It checks the schema, every cross reference (a tool's roles exist, a playbook's tools exist, a notified event has an
   audience and a declared template, ...) and refuses payload keys / template parameter names that look like personal data
   (`residentName`, `comment`, `memo` ... an `...Id` key is fine).
2. **Implement the v1 endpoints** from `openapi/bridge-v1.yaml` under `/bridge/v1` (any language), or use `@dsh-bridge/server-kit`
   (Node) which provides tables, repositories and routes. The invariants are the contract:
   - link yourself only; the code binds the employee who issued it; single use; short lived; throttled
   - delegation = AI allow-list intersected with the employee role; an unlinked sender gets nothing; <= 5 minutes; ends with the link / session
   - the AI reads and proposes; a person decides (approval cards, `im-decision`, proposals accept / reject)
   - events and IM text carry no personal data (whitelisted IDs / dates / counts / status; template parameters are numbers and times)
   - identity comes from the business system only; a `userId` in a body is never trusted
   - every response carries `bridge-protocol: 1`; errors are `{ ok: false, error: <lower_snake_case> }`; a code never embeds a field
     name (`required` / `invalid_value` + `details.field`, not `botId_required` / `invalid_quietHours.start`)
3. **Run the conformance suite** against a TEST instance (below). Nothing may be left in `knownGaps` for a release.

## Running the conformance suite

### Generic HTTP adapter (a system that serves `/bridge/v1` at a base URL)

```
BRIDGE_BASE_URL=https://staging.biz.example.com \
BRIDGE_SERVICE_TOKEN=... BRIDGE_BFF_SECRET=... \
BRIDGE_FIXTURES=./my-fixtures.mjs \
BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml \
node --test packages/protocol/conformance/http.test.mjs          # or: bridge-validate conformance
```

The fixtures module gives the suite what the protocol cannot: logged-in employees per role, a way to create more, and optional hooks
(expire a link code / delegation, end a session, deactivate an employee, emit a notifiable event, create a pending approval ...).
`conformance/fixtures.example.mjs` documents every field; a missing optional hook **skips** the checks that need it and the summary
says so (a system is not proven for a behaviour it did not let the suite exercise). Without `BRIDGE_BASE_URL` the test file is skipped
(that is what `pnpm test` shows).

### Plugging in an application adapter

A system that needs more than fixtures (start itself on a free port with a throw-away database, map v1 onto routes it still serves
under older paths, adapt a documented response shape, use its own test helpers for the hooks) ships an **application adapter** in
its own repository and points `BRIDGE_ADAPTER` at it:

```
BRIDGE_ADAPTER=./conformance/my-app.adapter.mjs node --test node_modules/@dsh-bridge/protocol/conformance/http.test.mjs
```

```js
// my-app.adapter.mjs
import { createTarget as createSuiteTarget } from '@dsh-bridge/protocol/conformance/target'
export const enabled = (env) => Boolean(env.MY_APP_TEST_DATABASE_URL)          // optional; false skips with skipReason
export const skipReason = 'MY_APP_TEST_DATABASE_URL is not set'
export async function createTarget(env) {
  return createSuiteTarget({
    name: 'my-app', baseUrl, serviceToken, bffSecret,
    start, stop,                       // lifecycle of the system under test
    rewrite(req, target) { ... },      // optional: v1 path -> the system's alias (aliasTable / pickAlias / fillTemplate)
    normalize(res, req, target) { ... },  // optional: documented `status: shape` aliases
    knownGaps: {},                     // { checkId: 'why' } strict expected failures
    loadFixtures: async (target) => ({ platform, roles, employees, newEmployee, hooks }),
    // loadManifest: async (target) => ({ manifest, source })   default: GET /bridge/v1/manifest, then manifestFile
  })
}
```

`conformance/adapters/example-adapter.mjs` is a commented skeleton. Route aliases are documented per operation in an annotated copy of
`bridge-v1.yaml` (`x-alias: [{ method, path, status: exact | shape | missing, note?, for?: [service|delegated|user|anon], query? }]`);
`lintOpenApi(doc, { aliasExtension, requireAliases })` checks such a copy and `bridge-validate aliases <file> --extension x-alias
--label my-app` prints the table. The same data can instead be kept as a JSON table in the shape `aliasTable()` returns
(`[{ method, v1, operationId, aliases }]`): `applyAliasTable(loadOpenApi(), table, { extension })` gives the annotated copy (it
refuses a row whose operation, method or v1 path no longer matches the document), and `bridge-validate aliases --table
aliases.json --label my-app` lints it (every operation mapped) and prints the table. The bundled document carries no aliases. ケアビリング's care-api adapter is an example of this
mechanism and stays in its own repository (`examples/care-billing/manifest/README.md` describes how it plugs in).

## What the conformance suite checks

Every check derives from the protocol invariants. The suite also validates every success body against the response schema in
`bridge-v1.yaml`, every event against the manifest whitelist, and every IM parameter against the manifest template types.

| invariant | checks |
|---|---|
| 1 link yourself only | L2 L3 L4 L5 L6 L7 L8 L9, B1-B4 (personal-bot owner rule), N3 (own preferences) |
| 2 delegation = AI allow-list intersected with the role; unlinked gets nothing | L1, D1-D7, S1-S5 (assistant tickets bound to the session), R2 |
| 3 AI reads / proposes, people decide | D3 D5, PR1-PR3, A2-A4 (IM decisions), R3 |
| 4 events and IM carry no personal data | E1-E4, N1 N2, A1 (cards), R2, L10 |
| 5 identity only from the business system | L3 D1 D2 S2 A2 N3 (a `userId` in a body is refused or ignored) |
| protocol hygiene | P1-P6 (header, envelope, service-token auth on every service-only operation, strict snake_case codes), M1-M3 |

<!-- check-catalog:start -->
| id | check | needs |
|---|---|---|
| P1 | GET /health is unauthenticated and announces protocol 1 (body and bridge-protocol header) | - |
| P2 | errors use the envelope { ok:false, error:<snake_case> } (401, 404, 405) | - |
| P3 | every service-only operation refuses: no credentials (401), a wrong service token (401), an employee session (403) | - |
| P4 | a delegation token needs the service token; a forged or foreign delegation token is refused | - |
| L1 | an SNS account that is not linked is answered linked:false and nothing else (no user, no hint) | - |
| L2 | link codes are issued only by a logged-in employee: anonymous 401, service principal 403, delegation 403 | - |
| L3 | a link code binds the employee who ISSUED it; a userId in the request body changes nothing | - |
| L4 | a link code is single use; issuing a new code revokes the previous unused one; the link body takes only code and source | - |
| L5 | link codes expire (410) and an expired code cannot be retried | `hook:expireLinkCode` |
| L6 | guessing link codes is throttled per source (429) and a locked source cannot consume a valid code | - |
| L7 | an employee sees and unlinks only their own links; admin cannot see or unlink anyone else's (404) | - |
| L8 | there is no operation that binds an SNS account on behalf of an employee (admin included) | - |
| L9 | unlinking ends the delegation tokens of that account at once and emits sns_identity.unlinked | - |
| L10 | identity statistics are counts only (no personal data) | - |
| B1 | registering a personal bot needs the employee session AND the BFF secret; nobody else can register one | `capability:personalBots`, `fixture:personalBotPlatform` |
| B2 | a bot registered by someone else is 409 (admin included); only the allowed platform; own list only | `capability:personalBots`, `fixture:personalBotPlatform` |
| B3 | owner rule: another employee's link code sent through my personal bot is refused (403) and burnt; my own code links | `capability:personalBots`, `fixture:personalBotPlatform` |
| B4 | unlinking the account linked through my personal bot retires the bot; a retired bot accepts nobody | `capability:personalBots`, `fixture:personalBotPlatform` |
| D1 | a sender that is not linked gets NO delegation token and no business data (404 identity_not_linked) | - |
| D2 | delegations are minted only by the service principal, live at most 5 minutes and carry the employee's own role | - |
| D3 | a delegation token never reaches service-only or employee-only operations (403 delegation_not_permitted) | - |
| D4 | the tools of the manifest are exactly as open as declared: a delegation of role R may call a tool iff R is in tool.roles | `manifest` |
| D5 | a delegation token cannot write: every declared write probe is refused with 403 delegation_not_permitted | `hook:writeProbes` |
| D6 | delegation tokens expire: an expired token is refused (401 invalid_delegation_token) | `hook:expireDelegation` |
| D7 | an inactive employee's delegation is refused | `hook:deactivateEmployee` |
| S1 | tickets are minted only through the BFF (employee session AND BFF secret), for the logged-in employee, and expire | - |
| S2 | a ticket is exchanged for the issuer's own delegation: service principal only, no way to name another employee | - |
| S3 | a delegation from a ticket has the same ceiling as any delegation (employee role, read and propose only) | - |
| S4 | tickets are bound to the web session: ending the session kills the ticket and every delegation made from it | `hook:revokeSession` |
| S5 | a deactivated employee cannot exchange a ticket | `hook:deactivateEmployee` |
| PR1 | a delegation can create a proposal for an employee role that may act on it: result pending_review | `hook:proposalSample` |
| PR2 | the AI can neither accept nor reject its own proposal; a person can, once | `hook:proposalSample` |
| PR3 | a delegation cannot propose what the employee's role could not do (403 role_not_permitted) | `hook:proposalForbiddenSample` |
| A1 | approval cards: service-only, one card per eligible approver, tokens and codes shaped, no personal data in the card, idempotent | `hook:createPendingApproval`, `capability:approvals` |
| A2 | IM decisions: unlinked source, wrong employee, delegation and employee sessions are refused; the right person decides once; every other card dies | `hook:createPendingApproval`, `capability:approvals` |
| A3 | wrong reply codes are counted and lock the card (429); a locked card is never re-issued and the right code no longer works | `hook:createPendingApproval`, `capability:approvals` |
| A4 | a person can decide by reply code alone (no approval id): the approval is found among their own cards | `hook:createPendingApproval`, `capability:approvals` |
| N1 | recipients are resolved by the business system; params are typed numbers / times, links carry no personal data | `hook:emitNotifiableEvent` |
| N2 | delivery results: sent is terminal and deduplicates the next resolution; other employees' rows are unknown | `hook:emitNotifiableEvent` |
| N3 | preferences are the employee's own and are honoured at resolution time; a userId in the body is refused | `hook:emitNotifiableEvent` |
| R1 | the latest report: managers / admins read it, staff and anonymous cannot; the service principal alone cannot | - |
| R2 | a delegation reads the report scoped to the employee role: counts only, never more sections than the role may see | `manifest` |
| R3 | running a report now is admin-only (a human session): staff, manager, delegation, service principal and anonymous are refused | - |
| E1 | GET /events: envelope, strictly increasing ids, nextAfter = last id, repeatable reads, bounded paging, input validation | - |
| E2 | every event is declared in the manifest, carries only its whitelisted payload keys and no personal data | `manifest` |
| E3 | the system refuses to write an event with a non-whitelisted payload key or an undeclared type | `hook:tryEmitEvent`, `manifest` |
| E4 | the payload whitelist is PER EVENT TYPE: a key that is declared for another type but not for this one is refused too | `hook:tryEmitEvent`, `manifest` |
| M1 | GET /manifest (service token) returns a valid manifest with an etag; If-None-Match answers 304 | - |
| M2 | the manifest (served or from file) is valid: schema, cross references, no personal-data payload keys | `manifest` |
| M3 | the fixtures cover every role the manifest declares (so every delegation ceiling is probed) | `manifest` |
| P5 | every response of this run (errors included) carried the header bridge-protocol: 1 | - |
| P6 | every error code seen in this run is lower snake case ([a-z0-9_]+): codes are stable identifiers, not field names | - |
<!-- check-catalog:end -->

Mutation tests (`test/conformance-mutants.test.mjs`) prove the checks bite: against an in-memory mock the checks pass, and flip to
failing when one invariant is deliberately broken (code bound from the body, code reusable, unlinked hint, delegation for a stranger,
a name in an event payload).

## Library

```js
import { validateManifest, validateEvent, validateEventPage, checkPayloadWhitelist, checkNotificationParams, loadManifestFile } from '@dsh-bridge/protocol'

const manifest = loadManifestFile('bridge.manifest.yaml')
validateManifest(manifest)                                   // { valid, errors: [{ path, message, code }], warnings }
validateEvent(event, { manifest, probes: ['Taro Yamada'] })  // envelope + declared type + whitelist + no personal data
checkPayloadWhitelist('report.submitted', payload, manifest)
checkNotificationParams('report.submitted', params, { manifest })
```

CLI: `bridge-validate manifest|event|openapi|aliases|all|readme|conformance` (exit 0 valid, 1 invalid, 2 usage). `--strict` (manifest / all): a warning
fails too (exit 1) — use it in CI, where only the exit code is read.

`validateManifest` warns (`event.internal_missing` / `event.internal_payload` / `event.internal_owner`) when one of `INTERNAL_EVENTS` —
`approval.requested`, `approval.decided` (internal `approvals_im`), `sns_identity.unlinked` (internal `identity`) — is missing, lacks its fixed
payload keys, or names another internal owner: the manifest is otherwise valid, but unlinking and approvals fail at run time. A system
may notify `approval.decided` instead of marking it internal (the requester's notice); the payload keys stay required.
`bridge-validate all [extra manifests...]` lints the OpenAPI and validates every bundled manifest; `bridge-validate readme --write`
regenerates the check catalog above (a test fails when it is stale).

## Limits

- YAML: a subset (block / flow collections, quoted and plain scalars, `|` `>` block scalars, comments). Dates and times stay strings; no anchors,
  tags, multi-document streams, duplicate keys or multi-line plain scalars. JSON manifests are fine. `test/yaml.test.mjs` compares the parser
  with the reference `yaml` package on every bundled file whenever that package is installed.
- JSON Schema: draft 2020-12 subset (see `src/jsonschema.mjs`); keywords needing annotation tracking (`unevaluated*`) are rejected, not ignored.
- The PII checks are heuristics (defence in depth). The protection is structural: events and templates only carry IDs, dates, counts and status values.
