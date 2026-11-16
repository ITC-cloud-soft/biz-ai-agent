// D: invariant 2 (delegation = AI allow-list intersected with the employee role; an unlinked sender gets nothing)
// and invariant 3 (the AI reads and proposes, never confirms).
import assert from 'node:assert/strict'
import { fill } from './protocol.mjs'

/** Per-role delegation cache (tokens live 5 minutes: renewed after 3). */
const cache = new Map()
export async function delegationForRole(c, role) {
  const hit = cache.get(`${c.target.name}:${role}`)
  if (hit && Date.now() - hit.at < 180_000) return hit
  const d = await c.linkedDelegation(role)
  const entry = { ...d, at: Date.now() }
  cache.set(`${c.target.name}:${role}`, entry)
  return entry
}

/** GET tools of the manifest that can be called without path parameters. */
export function probeableTools(manifest) {
  return (manifest?.tools ?? []).filter((t) => t.access === 'read' && !t.open && t.http.startsWith('GET ') && !/\{/.test(t.http))
}

export function register(s) {
  s.check('D1', 'a sender that is not linked gets NO delegation token and no business data (404 identity_not_linked)', async (c) => {
    const source = c.newSource()
    const r = await c.api.post(c.v1('/delegations'), c.as.service(), { source })
    c.err(r, 404, ['identity_not_linked'], 'delegation for an unlinked account')
    assert.ok(!('token' in r.body), 'no token in the refusal')
    c.err(await c.api.post(c.v1('/delegations'), c.as.service(), { source: { platform: source.platform } }), 400, null, 'source without userId')
    c.err(await c.api.post(c.v1('/delegations'), c.as.service(), { source, userId: c.fx.employees.admin.id }), 400, null, 'a userId in the body is never trusted')
    c.err(await c.api.post(c.v1('/delegations'), c.as.service(), { source, employee: { id: c.fx.employees.admin.id, role: 'admin' } }), 400, null, 'an employee object in the body is never trusted')
    // the stranger's lookup stays empty too
    assert.equal((await c.lookup(source)).body.linked, false)
  })

  s.check('D2', 'delegations are minted only by the service principal, live at most 5 minutes and carry the employee\'s own role', async (c) => {
    const emp = await c.fx.newEmployee('billing')
    const { source } = await c.linkEmployee(emp)
    c.err(await c.api.post(c.v1('/delegations'), c.as.anon(), { source }), 401, null, 'anonymous')
    c.err(await c.api.post(c.v1('/delegations'), c.as.user(emp), { source }), 403, null, 'the employee themselves')
    const r = await c.api.post(c.v1('/delegations'), c.as.service(), { source })
    c.ok(r, 201)
    c.shape('issueDelegation', 201, r)
    assert.equal(r.body.user.id, emp.id)
    assert.equal(r.body.user.role, emp.role, 'role comes from the business system')
    const ttl = Date.parse(r.body.expiresAt) - Date.now()
    assert.ok(ttl > 0 && ttl <= 5 * 60_000 + 5_000, `delegation lifetime must be at most 5 minutes (got ${Math.round(ttl / 1000)} s)`)
    c.err(await c.api.post(c.v1('/delegations'), c.as.delegated(r.body.token), { source }), 403, ['delegation_not_permitted'], 'a delegation cannot mint another')
    c.noSecrets(await c.lookup(source), [r.body.token], 'identity lookup')
  })

  s.check('D3', 'a delegation token never reaches service-only or employee-only operations (403 delegation_not_permitted)', async (c) => {
    const d = await delegationForRole(c, 'staff')
    const blocked = c.target.ops.filter((o) => o.op.security.length > 0 && !o.op.security.some((req) => 'delegationToken' in req) && !c.target.unmapped.has(o.operationId))
    assert.ok(blocked.length >= 15, `expected many operations without delegation access, found ${blocked.length}`)
    for (const o of blocked) {
      const path = c.v1(fill(o.path, c))
      const res = o.method === 'GET' ? await c.api.get(path, c.as.delegated(d.token))
        : o.method === 'DELETE' ? await c.api.del(path, c.as.delegated(d.token))
          : await c.api[o.method === 'PUT' ? 'put' : 'post'](path, c.as.delegated(d.token), {})
      c.err(res, 403, ['delegation_not_permitted'], `${o.operationId} with a delegation token`)
    }
  })

  s.check('D4', 'the tools of the manifest are exactly as open as declared: a delegation of role R may call a tool iff R is in tool.roles', async (c) => {
    const tools = probeableTools(c.manifest())
    assert.ok(tools.length >= 1, 'the manifest declares no parameter-free read tool to probe')
    const roles = Object.keys(c.manifest().roles)
    for (const role of roles) {
      const d = await delegationForRole(c, role)
      for (const tool of tools) {
        const [, path] = tool.http.split(' ')
        const res = await c.api.get(path, c.as.delegated(d.token))
        if (tool.roles.includes(role)) {
          assert.ok(![401, 403].includes(res.status) && res.status < 500, `${tool.name}: role ${role} is declared allowed but got ${res.status} ${res.text.slice(0, 160)}`)
        } else {
          c.err(res, 403, ['delegation_not_permitted', 'role_not_permitted', 'insufficient_role'], `${tool.name}: role ${role} is NOT in tool.roles`)
        }
      }
    }
  }, { requires: ['manifest'] })

  s.check('D5', 'a delegation token cannot write: every declared write probe is refused with 403 delegation_not_permitted', async (c) => {
    const probes = c.fx.hooks.writeProbes
    assert.ok(Array.isArray(probes) && probes.length >= 1, 'fixtures.hooks.writeProbes must list at least one business write endpoint')
    for (const role of ['admin', 'staff']) {
      const d = await delegationForRole(c, role)
      for (const p of probes) {
        const res = await c.target.send({ method: p.method, path: p.path.replace(/{[A-Za-z0-9_]+}/g, () => c.uuid()), headers: c.as.delegated(d.token), body: p.method === 'GET' ? undefined : (p.body ?? {}) })
        c.err(res, 403, ['delegation_not_permitted'], `${role} delegation on ${p.method} ${p.path}`)
      }
    }
  }, { requires: ['hook:writeProbes'] })

  s.check('D6', 'delegation tokens expire: an expired token is refused (401 invalid_delegation_token)', async (c) => {
    const d = await c.linkedDelegation('staff')
    c.ok(await c.delegatedProbe(d.token), 200, 'token valid before expiry')
    await c.fx.hooks.expireDelegation(d.token)
    c.err(await c.delegatedProbe(d.token), 401, ['invalid_delegation_token'], 'expired token')
    const fresh = await c.delegationFor(d.source)
    c.ok(await c.delegatedProbe(fresh.token), 200, 'a new token for the same link works')
  }, { requires: ['hook:expireDelegation'] })

  s.check('D7', 'an inactive employee\'s delegation is refused', async (c) => {
    const d = await c.linkedDelegation('staff')
    await c.fx.hooks.deactivateEmployee(d.emp)
    c.err(await c.delegatedProbe(d.token), 401, ['invalid_delegation_token'], 'token of a deactivated employee')
    c.err(await c.api.post(c.v1('/delegations'), c.as.service(), { source: d.source }), 404, ['identity_not_linked'], 'new delegation for a deactivated employee')
    assert.equal((await c.lookup(d.source)).body.linked, false, 'a deactivated employee\'s account resolves as not linked')
  }, { requires: ['hook:deactivateEmployee'] })
}
