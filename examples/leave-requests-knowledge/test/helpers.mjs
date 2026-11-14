// Shared by the knowledge tests: a running instance, fictional employees, their web sessions and their AI delegations.
// Delegations are made the way the web AI assistant makes them (no shortcut into the store):
//   the employee's session → POST /bridge/v1/assistant/tickets (BFF) → the AI plane: POST /bridge/v1/assistant/delegations { ticket }
import { loadManifest } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE, startServer } from '../src/app.mjs'

export const SERVICE = 'leave-test-service-token-0000000000'
export const BFF = 'leave-test-bff-secret-00000000000000'
export const S = Object.freeze({ 'x-service-token': SERVICE })

export function caller(base) {
  return async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    return { status: res.status, body: parsed, headers: res.headers }
  }
}

/** The manifest with the knowledge tool's roles changed (delegation × role tests). */
export function manifestWithKnowledgeRoles(roles) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const copy = structuredClone(manifest)
  copy.tools.find((t) => t.http === 'GET /bridge/v1/knowledge/search').roles = roles
  return { manifest: copy }
}

/** A running instance with admin / manager / staff1 / staff2 (fictional), their web headers and AI delegation headers. */
export async function startWithPeople(options = {}) {
  const srv = await startServer({ serviceToken: SERVICE, bffSecret: BFF, ...options })
  const call = caller(srv.base)
  const people = {}
  for (const [loginId, role] of [['admin', 'admin'], ['manager', 'manager'], ['staff1', 'staff'], ['staff2', 'staff']]) {
    const u = await srv.app.createUser({ loginId, password: 'password-1234', role, displayName: `Test ${loginId}` })
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
  return { srv, call, people, delegated }
}
