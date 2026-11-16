// Shared by the tests: a running instance, fictional employees (with their managers), their web sessions and their AI delegations.
// Delegations are made the way the web AI assistant makes them (no shortcut into the store):
//   the employee's session → POST /bridge/v1/assistant/tickets (BFF) → the AI plane: POST /bridge/v1/assistant/delegations { ticket }
import { addDays, loadManifest, todayIn } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE, startServer, TIME_ZONE } from '../src/app.mjs'

export const SERVICE = 'expense-test-service-token-00000000'
export const BFF = 'expense-test-bff-secret-000000000000'
export const S = Object.freeze({ 'x-service-token': SERVICE })
export const day = (n) => addDays(todayIn(TIME_ZONE), n)

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

/** The fictional organisation of the tests: login id, role, manager's login id. */
export const ORG = Object.freeze([
  ['admin', 'admin', null], ['admin2', 'admin', null],
  ['manager', 'manager', 'admin'], ['manager2', 'manager', 'admin'],
  ['staff1', 'staff', 'manager'], ['staff2', 'staff', 'manager'], ['staff3', 'staff', 'manager2'],
])

/**
 * A running instance with the employees of ORG (fictional; staff1 and staff2 report to manager, staff3 to manager2, the
 * managers to admin), their web headers and AI delegation headers.
 */
export async function startWithPeople(options = {}) {
  const srv = await startServer({ serviceToken: SERVICE, bffSecret: BFF, ...options })
  const call = caller(srv.base)
  const people = {}
  for (const [loginId, role, manager] of ORG) {
    const u = await srv.app.createUser({ loginId, password: 'password-1234', role, displayName: `Test ${loginId}`, managerId: manager ? people[manager].id : null })
    const r = await call('POST', '/api/auth/login', { body: { loginId, password: 'password-1234' } })
    people[loginId] = { id: u.id, role, web: { cookie: r.headers.get('set-cookie').split(';')[0] } }
  }
  /** A fresh delegation of this person (the AI acting as them), as request headers. */
  async function delegated(person) {
    const t = await call('POST', '/bridge/v1/assistant/tickets', { headers: { ...person.web, 'x-bff-secret': BFF } })
    if (t.status !== 201) throw new Error(`ticket: ${t.status} ${JSON.stringify(t.body)}`)
    const d = await call('POST', '/bridge/v1/assistant/delegations', { headers: S, body: { ticket: t.body.ticket } })
    if (d.status !== 201) throw new Error(`delegation: ${d.status} ${JSON.stringify(d.body)}`)
    return { ...S, 'x-delegation-token': d.body.token }
  }
  /** A claim submitted on the web by this person. */
  async function claim(person, { amountYen = 4_800, category = 'transport', spentOn = day(-5), note = 'Train to a client (test)' } = {}) {
    const r = await call('POST', '/api/expense-claims', { headers: person.web, body: { spentOn, category, amountYen, note } })
    if (r.status !== 201) throw new Error(`claim: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  /** Time passes on the instance (never through the API): the claim was submitted `days` days ago. */
  function age(claimId, days) {
    Object.assign(srv.app.data.claims.get(claimId), { createdAt: new Date(Date.now() - days * 86_400_000), submittedOn: day(-days) })
  }
  return { srv, call, people, delegated, claim, age }
}
