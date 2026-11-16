# 03 Connecting to an existing business system

Source of truth: `docs/GUIDELINE.en.md` b.2, b.2', b.10, `packages/server-kit/README.md`, `packages/protocol/README.md`, `packages/protocol/openapi/bridge-v1.yaml`.

## A. Mounting server-kit on a Node.js system

Add `createBridgeApp` to the existing server and wire the hooks to the existing tables and functions. The Bridge part (link codes, delegation, outbox, recipient resolution, approval cards, reports, proposals, manifest serving,
personal bot registration, profile, attachments, pii-scan) is handled by the kit.

```js
import { createBridgeApp, createPool, createPostgresStore } from '@dsh-bridge/server-kit'
const store = createPostgresStore({ pool: await createPool(process.env.MY_DATABASE_URL) })
await store.migrate()                                   // bridge_* tables (idempotent)
const bridge = await createBridgeApp({
  manifest: { file: './bridge.manifest.yaml' },
  store,
  serviceToken: process.env.MY_SERVICE_TOKEN,           // DSH's x-service-token
  bffSecret: process.env.MY_BFF_SECRET,                 // x-bff-secret of the business web app's BFF
  orgId: 'my-org', service: 'my-system', version: '1.0.0',
  hooks: { employees, authenticate, isSessionLive, recipientsFor, approvals, proposalKinds, reports, piiScan },
})
// with node:http, plug bridge.handler into the existing server; with express, bridge.middleware
```

- `bridge_*` tables are added to the existing DB (business tables are not changed). The DB connection can be the same as the existing one.
- `authenticate(req)` returns `{ user: { id, role }, sessionId }` from the **existing session** (cookie / bearer). The kit never sees passwords.
- Add `kit.emitEvent` in the same transaction to each existing state-changing process (check whether the existing transaction's connection can be passed to the kit;
  if it cannot, move that process inside `kit.tx`). Details in `05-business-side.md`.
- Attach `readToolPolicy` to the existing GETs the AI is to read, so they accept delegation. Write APIs return 403 for delegation (`delegation_not_permitted`).

## B. APIs with the same function exist: mount as aliases

```js
import { aliasTableFromOpenApi, camelRows, registerAliasRoutes } from '@dsh-bridge/server-kit'
const table = [
  { operationId: 'lookupIdentity', method: 'GET', path: '/identity', aliases: [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] },
  { operationId: 'listMyIdentities', method: 'GET', path: '/me/identities', aliases: [{ method: 'GET', path: '/api/sns-identities', status: 'shape' }] },
]   // or aliasTableFromOpenApi(annotated bridge-v1.yaml, { key: 'x-alias' })
registerAliasRoutes(router, { table, from: legacyRouter, adapters: { listMyIdentities: camelRows('identities') } })
```

- `status`: `exact` (same shape), `shape` (needs conversion: `adapters`), `missing` (not there yet → add it, then attach the alias). If each principal has a separate route, use `for: ['service' | 'delegated' | 'user']`.
- Aliases that cannot be resolved are reported in `skipped` and are not served silently.
- If you write the mapping into `x-alias` of an annotated `bridge-v1.yaml`, you can list it with `bridge-validate aliases <file> --extension x-alias --label my-app` and check it with `lintOpenApi`.
- The DSH side can also adapt with `pathProfiles` (routes other than `/bridge/v1`) (`06-dsh-profile.md`, GUIDELINE section c).

## C. Languages other than Node.js

- Implement `packages/protocol/openapi/bridge-v1.yaml` as is. Every response carries `bridge-protocol: 1`; errors are `{ ok: false, error: <lower_snake_case> }`.
- Implement yourself the rules that server-kit holds (link codes are single-use with attempt limits, delegation ≤ 5 minutes and "AI allow-list ∩ role", the payload allow-list, approvals decided once, the personal bot ownership rules,
  the equivalent of the profile's `validateAiProfile`, etc.). When in doubt, read the corresponding part of server-kit.
- Verify with the conformance suite (generic HTTP adapter) at 52 / 52 (`10-verification.md`).

## D. External mode (trial)

Without touching the existing system's code, place a **bridge-only service** outside it (on server-kit, with `bridge_*` in its own DB) that calls the existing system's APIs and exposes Bridge v1.
Judge it by the 4 capabilities in `01-assessment.md`. Items whose way of being met changes:

| # | How it is met in external mode |
|---|---|
| 1 | Read tools are on the external bridge's routes and internally call the existing read APIs **as the person**. Proposals live in the external bridge; only on adoption does `apply` call the existing write API as the person who adopted it |
| 3 | The external bridge serves the chat link screen. Login is OIDC / SAML via the existing IdP, or an entry point that verifies the existing session. `authenticate` returns the existing employee ID. Do not create a separate ID scheme |
| 4 | `recipientsFor` decides by fetching assignees, approvers and affiliations from the existing APIs. If they cannot be fetched, do not notify (do not create assignment rules in the external bridge) |
| 5 | Ingestion: from CDC or a webhook that meets the conditions, write "the record of the ingested change ID" and `kit.emitEvent` in **one transaction** (the second time for the same change ID does nothing). Polling is for status notices only |
| 6 | `employees` comes from the existing employee API. Do not cache. Do not read with an all-powerful service account and filter in the external bridge |
| 7 | Approvals call the existing approval API as the person. Do not copy the rules into the external bridge |
| 8 | `isSessionLive` calls the entry point that verifies the existing session |

- For ingestion code examples, the 5 webhook conditions, lag monitoring and ordering, follow GUIDELINE b.10 "Trial rule: event ingestion" exactly.
- In the external bridge's own tests, confirm "sending the same change twice yields one event", "stopping before commit and resending yields one", and "2xx comes after commit" (the 52 items do not check this).
- In explanations, you may say only as much as "if the existing system has SSO, APIs and change notifications, it can be connected without changing its code". Do not say "without changing any system".
- Later, businesses can be moved one at a time to a new system (server-kit) (Bridge v1 is the seam, so the DSH side does not change).
