// The optional Bridge v1 capability `graph`, registered on server-kit's router (no change to server-kit).
//
//   GET /bridge/v1/graph/neighbors?entity=<manifest entity>&id=<object id>
//     -> 200 { ok, entity, id, viewer: { role }, neighbors: [{ relation, entity, id, you? }] }
//
// IDs and types only — never names, never business text. The business system decides through two hooks:
//   canRead({ entity, id }, asker) -> boolean        may this employee see this object at all?
//   neighbors({ entity, id }, asker) -> [{ relation, entity, id }]   its direct relations (entity: a manifest entity, `employee`
//                                                    or `role`)
// The route answers 404 not_found for an object the asker may not read AND for one that does not exist (the same body), and
// drops every neighbor of a manifest entity the asker may not read. `you: true` marks the asker's own employee id.
// Who may call it: like every business read tool (kit.readToolPolicy) — an employee on the web; a delegation only when the
// manifest declares a read tool on `GET /bridge/v1/graph/neighbors` for the employee's role.
import { fail } from '@dsh-bridge/server-kit'

export const GRAPH_NEIGHBORS_PATH = '/bridge/v1/graph/neighbors'
export const GRAPH_ENDPOINT = `GET ${GRAPH_NEIGHBORS_PATH}`
export const MAX_NEIGHBORS = 50
const RELATION_RE = /^[a-z][a-z0-9_]{0,40}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const SPECIAL_TYPES = Object.freeze(['employee', 'role'])

export function registerGraph(bridge, { canRead, neighbors } = {}) {
  const { router, kit } = bridge ?? {}
  if (!router || !kit) throw new TypeError('registerGraph: pass the result of createBridgeApp ({ router, kit })')
  if (typeof canRead !== 'function' || typeof neighbors !== 'function') throw new TypeError('registerGraph: canRead and neighbors hooks are required')
  const entities = new Set(Object.keys(kit.manifest.entities ?? {}))
  const roles = new Set(kit.declaredRoles)
  const delegatedRoles = kit.allowlist[GRAPH_ENDPOINT] ?? []
  if (!delegatedRoles.length) kit.log?.(`[graph] the manifest declares no read tool "${GRAPH_ENDPOINT}": the AI (delegations) cannot read the graph`)

  router.add('GET', GRAPH_NEIGHBORS_PATH, kit.readToolPolicy(GRAPH_ENDPOINT, [...kit.declaredRoles]), async ({ principal, query }) => {
    const entity = String(query.get('entity') ?? '')
    const id = String(query.get('id') ?? '')
    if (!entities.has(entity)) fail(400, 'invalid_entity')
    if (!ID_RE.test(id)) fail(400, 'invalid_id')
    const asker = { id: String(principal.user.id), role: principal.user.role }
    const ref = { entity, id }
    if (!(await canRead(ref, asker))) fail(404, 'not_found')
    const out = []
    for (const n of (await neighbors(ref, asker)) ?? []) {
      if (out.length >= MAX_NEIGHBORS) break
      const relation = String(n?.relation ?? '')
      const type = String(n?.entity ?? '')
      const nid = String(n?.id ?? '')
      if (!RELATION_RE.test(relation) || !ID_RE.test(nid)) continue
      if (type === 'role') { if (roles.has(nid)) out.push({ relation, entity: type, id: nid }); continue }
      if (type === 'employee') { out.push({ relation, entity: type, id: nid, ...(nid === asker.id ? { you: true } : {}) }); continue }
      if (!entities.has(type)) continue
      if (await canRead({ entity: type, id: nid }, asker)) out.push({ relation, entity: type, id: nid }) // the asker's rights, again
    }
    return { status: 200, body: { ok: true, entity, id, viewer: { role: asker.role }, neighbors: out } }
  })
  return { path: GRAPH_NEIGHBORS_PATH, delegatedRoles: [...delegatedRoles] }
}
