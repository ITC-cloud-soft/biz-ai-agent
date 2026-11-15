# The `graph` capability (Bridge v1, optional) — week 4 interface

Status: implemented here as an add-on (`@dsh-bridge/graph` + `bridge-graph`), with **no change to the framework**.

## Two halves

| half | where | what |
|---|---|---|
| skeleton | generated from the manifest (business side and AI side alike) | `role`, `entity`, `event`, `audience`, `tool`, `playbook`, `report` nodes; edges `about`, `notifies`, `audience`, `includes`, `triggers`, `uses`, `reports_to`, `available_to`, `reads` / `proposes` (inferred from paths), `delivered_to` |
| instances | `GET /bridge/v1/graph/neighbors?entity=&id=` on the business system | the direct relations of ONE object: IDs and types only, the asker's rights |

## Route

| principal | answer |
|---|---|
| nothing valid | 401 |
| `x-service-token` alone | 403 `human_required` |
| employee (web session) | 200 when `canRead(object, employee)`, else 404 `not_found` (the same body as a missing object) |
| delegation | as the employee, when the manifest declares a read tool on `GET /bridge/v1/graph/neighbors` for their role; else 403 `delegation_not_permitted` |
| entity not in the manifest / malformed id | 400 `invalid_entity` / `invalid_id` |

```jsonc
// 200
{ "ok": true, "entity": "approval", "id": "…", "viewer": { "role": "manager" },
  "neighbors": [
    { "relation": "subject", "entity": "leave_request", "id": "…" },
    { "relation": "requested_by", "entity": "employee", "id": "…" },        // "you": true when it is the asker
    { "relation": "required_role", "entity": "role", "id": "manager" } ] }
```

- `entity` of a neighbor: a manifest entity (checked again with `canRead` — a neighbor the asker may not read is dropped),
  `employee` (an ID, never a name) or `role` (a declared role).
- At most 50 neighbors; relations `^[a-z][a-z0-9_]{0,40}$`; IDs `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.

## Conformance (`@dsh-bridge/graph/conformance`)

| id | check |
|---|---|
| G-01 | no credentials → 401 |
| G-02 | the service principal alone → 403 |
| G-03 | undeclared entity → 400 `invalid_entity`; malformed id → 400 `invalid_id` |
| G-04 | an asker who may read the probe gets its neighbors (web session and delegation) |
| G-05 | only the documented fields |
| G-06 | an asker who may not read the probe gets exactly the answer for a missing object (404) |
| G-07 | a delegation of a role the manifest's graph tool does not list → 403 |

The pilot passes G-01…G-06 with the tool for every role, and G-01…G-07 with the tool for managers only.

## Better made upstream

1. protocol: a manifest key `graph: { tool }` (today found through the tool's `http`), the route in `openapi/`, G-01…G-07 in
   the suite as optional checks.
2. server-kit: a `graph` option with `hooks.graph = { canRead, neighbors }`, so the route passes the gate before a 404.
3. dsh-core: hand the manifest to tool modules at registration (today the tool reads `application().manifest()` at call time).
