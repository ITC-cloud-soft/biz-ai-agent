// Shared by the tests: a running instance, fictional employees, a small catalog, their web sessions and their AI delegations.
// Delegations are made the way the web AI assistant makes them (no shortcut into the store):
//   the employee's session → POST /bridge/v1/assistant/tickets (BFF) → the AI plane: POST /bridge/v1/assistant/delegations { ticket }
import { addDays, loadManifest, todayIn } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE, startServer } from '../src/app.mjs'

export const SERVICE = 'loans-test-service-token-0000000000'
export const BFF = 'loans-test-bff-secret-00000000000000'
export const S = Object.freeze({ 'x-service-token': SERVICE })
export const day = (n) => addDays(todayIn('UTC'), n)

export function caller(base) {
  return async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    return { status: res.status, body: parsed, headers: res.headers }
  }
}

/** The manifest with the roles of the tool on `http` changed (delegation × role tests). */
export function manifestWithToolRoles(http, roles) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const copy = structuredClone(manifest)
  copy.tools.find((t) => t.http === http).roles = roles
  return { manifest: copy }
}
export const manifestWithKnowledgeRoles = (roles) => manifestWithToolRoles('GET /bridge/v1/knowledge/search', roles)
export const manifestWithGraphRoles = (roles) => manifestWithToolRoles('GET /bridge/v1/graph/neighbors', roles)

/**
 * A running instance with admin / manager / manager2 / staff1 / staff2 (fictional), their web headers and AI delegation
 * headers, and a catalog: two standard laptops, a high-value laptop, a projector and a (high-value) camera.
 */
export async function startWithPeople(options = {}) {
  const srv = await startServer({ serviceToken: SERVICE, bffSecret: BFF, ...options })
  const call = caller(srv.base)
  const people = {}
  for (const [loginId, role] of [['admin', 'admin'], ['manager', 'manager'], ['manager2', 'manager'], ['staff1', 'staff'], ['staff2', 'staff']]) {
    const u = await srv.app.createUser({ loginId, password: 'password-1234', role, displayName: `Test ${loginId}` })
    const r = await call('POST', '/api/auth/login', { body: { loginId, password: 'password-1234' } })
    people[loginId] = { id: u.id, role, web: { cookie: r.headers.get('set-cookie').split(';')[0] } }
  }
  const items = {}
  for (const [tag, kind, highValue] of [['LAP-001', 'laptop', false], ['LAP-002', 'laptop', false], ['LAP-900', 'laptop', true], ['PRJ-001', 'projector', false], ['CAM-001', 'camera', true]]) {
    const r = await call('POST', '/api/admin/equipment', { headers: people.admin.web, body: { assetTag: tag, kind, highValue } })
    if (r.status !== 201) throw new Error(`item ${tag}: ${r.status} ${JSON.stringify(r.body)}`)
    items[tag] = r.body.item
  }
  /** A fresh delegation of this person (the AI acting as them), as request headers. */
  async function delegated(person) {
    const t = await call('POST', '/bridge/v1/assistant/tickets', { headers: { ...person.web, 'x-bff-secret': BFF } })
    if (t.status !== 201) throw new Error(`ticket: ${t.status} ${JSON.stringify(t.body)}`)
    const d = await call('POST', '/bridge/v1/assistant/delegations', { headers: S, body: { ticket: t.body.ticket } })
    if (d.status !== 201) throw new Error(`delegation: ${d.status} ${JSON.stringify(d.body)}`)
    return { ...S, 'x-delegation-token': d.body.token }
  }
  return { srv, call, people, items, delegated }
}
