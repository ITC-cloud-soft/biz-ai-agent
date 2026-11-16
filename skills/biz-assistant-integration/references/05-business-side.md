# 05 Implementing the business side: hooks, events, recipients, approvals, proposals, reports

Source of truth: `docs/GUIDELINE.en.md` b.2, b.3, d.1, d.3, d.8, `packages/server-kit/README.md` "Hooks", sample `examples/equipment-inspection/src/hooks.mjs`, `src/domain.mjs`, `src/routes.mjs`.

## 1. The hooks contract

Every hook receives `ctx = { db, t, emitEvent, now, lock? }` (`ctx.db` is the client of the current transaction).

| hook | Required | What it returns / what it must observe |
|---|---|---|
| `employees.get(id, ctx)` / `employees.list({ roles }, ctx)` | Required | `{ id, role, active }` (`list` returns active employees only). Checked on every delegation use, link and decision. A deactivated employee loses all tokens immediately. `getMany` is optional |
| `authenticate(req)` | Required for `/me/*` | Existing session (cookie / bearer) → `{ user: { id, role }, sessionId }` |
| `isSessionLive(sessionId, ctx)` | Effectively required for conformance S4 | Ends web assistant tickets and delegations together with the web session |
| `recipientsFor(event, ctx)` | Required for notifications | `null` (do not notify) / `{ stale: 'reason' }` (the situation changed; no longer needed) / `{ users, paramsFor(user), link, dedupeKey, template? }` |
| `approvals.{get, approvers, card, mayDecide, decide}` | Required (52 / 52) | The rule is **the same function** as on the web. `get` is **camelCase** (`expiresAt`, `requestedBy`; do not return raw DB rows; `FOR UPDATE` when `ctx.lock`). `card` holds only IDs, amounts and deadlines (optionally `wording`). `decide` writes the decision inside `ctx.t` and emits `approval.decided`. If you use your own state names, map them to `'pending'` with `state(a)` |
| `proposalKinds[kind]` | Required for proposals | `{ roles, validate(payload, ctx, principal), apply(payload, actor, ctx, proposal) }`. `apply` runs only when a human adopts it, inside the kit's transaction. **Business writes go through `ctx.db`**. `connector_write` is the name used by external connectors |
| `reports` | Required (52 / 52) | `{ kind?, compute(viewer, ctx) }` → `{ sections: { <name>: object of counts }, attention, date? }`. The kit keeps only `viewer.sections` |
| `piiScan(text, ctx)` | Required for systems that hold names | `{ kinds: string[] }` (categories only; do not return the matched strings). An exception yields 503 `pii_scan_failed` (the memory is not saved) |
| `eventDelegations[type]` | Required for `<class>=each` | `{ eligible(event, user, ctx), personOf?(event), maxAgeHours? }`. Checked on issue and on every use |

Other options: `roles: { reportReaders, reportRunners, proposalReviewers, admins }` (by default, those who can adopt proposals are the report readers), `aiProfile: false`, `attachments`, `connectors`, `help`, `personalBotPlatforms`.

## 2. APIs the AI reads, and writes for humans only

```js
bridge.router.add('GET', '/api/orders/overdue', bridge.kit.readToolPolicy('GET /api/orders/overdue', ['admin', 'manager']), handler)
bridge.router.add('POST', '/api/orders', { allow: ['user'] }, handler)   // writes only from a human session (delegation gets 403)
```

- Make the roles in `readToolPolicy` match the `roles` of the same tool in the manifest (conformance D4).
- List every business write API in conformance's `writeProbes` (D5).
- Amounts are computed by the business system. Do not put amounts in proposal input (for a hand-written proposal tool, `forbidden: ['amount']`).

## 3. Writing events in the transaction (outbox)

```js
return kit.tx(async (t) => {
  const { rows } = await t.db.query('insert into shipment (...) values (...) returning id', [...])
  await kit.emitEvent(t, {
    type: 'shipment.completed', aggregateType: 'shipment', aggregateId: rows[0].id,
    payload: { shipmentId: rows[0].id, orderId, shippedOn },     // only keys in the manifest's allow-list
  })
  return { status: 201, body: { ok: true, id: rows[0].id } }
})
```

- **MUST** be the same transaction as the business change (picking up differences later notifies changes that were never committed and drops committed ones).
- **MUST** use only the keys in that type's allow-list in the payload. A violation raises `EventRejected` (and the business row is not kept either).
- When an approval is decided on the web, invalidate the chat card with `t.revokeApprovalDeliveries({ approvalId })`.
- Periodic business processing (scanning for overdue items, etc.) uses `startScheduler({ kit, tasks: [{ name, everyMinutes, run }] })`. Make it idempotent (once per deadline / date).
  If you use external connector rules, add `{ name: 'connector-rules', everyMinutes: 1, run: () => kit.connectors.tick() }`.

## 4. How recipients are decided (the d.8 MUST)

```js
async function recipientsFor(event, ctx) {
  if (event.type !== 'order.overdue') return null
  const { orderId, dueDate } = event.payload
  const o = (await ctx.db.query('select status, due_date, branch_id, owner_user_id from orders where id = $1', [orderId])).rows[0]
  if (!o || o.status === 'cancelled') return { stale: 'order_closed' }
  if (o.due_date > dueDate) return { stale: 'rescheduled' }
  const candidates = /* the assignee + that branch's managers (active employees only) */ []
  const users = []
  for (const u of candidates) if (await mayViewOrder(u, o, ctx)) users.push(u)   // gate: the same function as the web authorization
  if (users.length === 0) return { stale: 'no_scope' }
  return {
    users, template: 'order.overdue', dedupeKey: `order.overdue:${orderId}:${dueDate}`,
    link: `/orders/${orderId}`,                                     // an ID-only path; the business web app re-authorizes on open
    paramsFor: (u) => ({ count: /* count within what that person can see */ 0, dueDate }),   // numbers and dates only
  }
}
```

1. Give each event's rules (roles, addressed to the person, people excluded) the event's **subject** (customer, branch, department, whole organization…).
2. Role-based recipients are limited to employees within the subject's scope.
3. **Gate**: for each person, check "can this person see the same subject in the business web app" with the same function as the web authorization. Do not send to those dropped; leave only their ID and a reason code in the audit.
4. Count within the scope each recipient can see. Escalation (`audience.fallback`) only when there are 0 recipients.
5. If the scope cannot be determined, send to no one. Send to everyone in a role only when the event truly concerns the whole organization.

## 5. What to confirm in business tests (minimum)

- The state change and the event are in the same transaction (if the manifest rejects the payload, the business row is not kept either)
- The `recipientsFor` gate (employees outside the scope are not included; `stale` when the situation changes)
- Web approval uses `mayDecide` and is decided once
- Business writes with a delegation token give 403 `delegation_not_permitted`
- `hooks.piiScan` returns categories for names on the roster
- (If there is a BFF) the browser's `POST /bridge/v1/me/personal-bots` is not relayed with the secret attached
