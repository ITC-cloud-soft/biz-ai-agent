// S: the web AI assistant. A ticket identifies the logged-in employee to the AI plane; it is minted only through the BFF,
// bound to the web session, and exchanged (by the service principal only) for the same kind of delegation an IM sender gets.
import assert from 'node:assert/strict'
import { probeableTools } from './delegation.mjs'

export function register(s) {
  const ticketFor = async (c, emp) => {
    const r = await c.api.post(c.v1('/assistant/tickets'), c.as.bff(emp), {})
    c.ok(r, 201, 'issue ticket')
    return r
  }
  const exchange = (c, ticket, extra = {}) => c.api.post(c.v1('/assistant/delegations'), c.as.service(), { ticket, ...extra })

  s.check('S1', 'tickets are minted only through the BFF (employee session AND BFF secret), for the logged-in employee, and expire', async (c) => {
    const emp = await c.fx.newEmployee('staff')
    const path = c.v1('/assistant/tickets')
    c.err(await c.api.post(path, c.as.user(emp), {}), 403, ['bff_only'], 'browser alone')
    c.err(await c.api.post(path, c.as.bff(emp, `${c.target.bffSecret}-wrong`), {}), 403, ['bff_only'], 'wrong BFF secret')
    c.err(await c.api.post(path, { 'x-bff-secret': c.target.bffSecret }, {}), 401, null, 'BFF secret without a session')
    c.err(await c.api.post(path, c.as.service(), {}), 403, null, 'service principal')
    const d = await c.linkedDelegation('staff')
    c.err(await c.api.post(path, c.as.delegated(d.token), {}), 403, ['delegation_not_permitted'], 'delegation token')
    const r = await ticketFor(c, emp)
    c.shape('issueAssistantTicket', 201, r)
    assert.equal(r.body.user.id, emp.id)
    assert.equal(r.body.user.role, emp.role)
    const ttl = Date.parse(r.body.expiresAt) - Date.now()
    assert.ok(ttl > 0 && ttl <= 60 * 60_000, `ticket lifetime must be at most 1 hour (got ${Math.round(ttl / 1000)} s)`)
  })

  s.check('S2', 'a ticket is exchanged for the issuer\'s own delegation: service principal only, no way to name another employee', async (c) => {
    const emp = await c.fx.newEmployee('staff')
    const t = await ticketFor(c, emp)
    const path = c.v1('/assistant/delegations')
    c.err(await c.api.post(path, c.as.user(emp), { ticket: t.body.ticket }), 403, null, 'an employee cannot exchange tickets')
    c.err(await c.api.post(path, c.as.anon(), { ticket: t.body.ticket }), 401, null, 'anonymous')
    c.err(await exchange(c, 'cat_forged-forged-forged-forged-forged'), 401, ['invalid_assistant_ticket'], 'forged ticket')
    c.err(await exchange(c, t.body.ticket, { userId: c.fx.employees.admin.id }), 400, null, 'a userId next to the ticket')
    c.err(await exchange(c, t.body.ticket, { role: 'admin' }), 400, null, 'a role next to the ticket')
    const d = await exchange(c, t.body.ticket)
    c.ok(d, 201, 'exchange')
    c.shape('exchangeAssistantTicket', 201, d)
    assert.equal(d.body.user.id, emp.id, 'the delegation is for the ticket\'s employee')
    assert.equal(d.body.user.role, emp.role, 'the role is not escalated')
    const ttl = Date.parse(d.body.expiresAt) - Date.now()
    assert.ok(ttl > 0 && ttl <= 5 * 60_000 + 5_000, `delegation lifetime must be at most 5 minutes (got ${Math.round(ttl / 1000)} s)`)
    c.ok(await c.delegatedProbe(d.body.token), 200, 'the delegation works')
    c.ok(await exchange(c, t.body.ticket), 201, 'the same ticket can be exchanged again until it expires')
  })

  s.check('S3', 'a delegation from a ticket has the same ceiling as any delegation (employee role, read and propose only)', async (c) => {
    const emp = await c.fx.newEmployee('staff')
    const d = await exchange(c, (await ticketFor(c, emp)).body.ticket)
    c.ok(d, 201)
    const token = d.body.token
    // service-only / employee-only protocol operations stay closed
    c.err(await c.api.post(c.v1('/delegations'), c.as.delegated(token), { source: c.newSource() }), 403, ['delegation_not_permitted'], 'mint another delegation')
    c.err(await c.api.post(c.v1('/me/link-codes'), c.as.delegated(token), {}), 403, ['delegation_not_permitted'], 'issue a link code')
    // tools outside the employee role stay closed
    const outside = probeableTools(c.manifest()).find((t) => !t.roles.includes(emp.role))
    if (outside) c.err(await c.api.get(outside.http.split(' ')[1], c.as.delegated(token)), 403, ['delegation_not_permitted', 'role_not_permitted', 'insufficient_role'], `${outside.name} is not for ${emp.role}`)
    for (const p of c.fx.hooks?.writeProbes ?? []) {
      const res = await c.target.send({ method: p.method, path: p.path.replace(/\{[A-Za-z0-9_]+\}/g, () => c.uuid()), headers: c.as.delegated(token), body: p.method === 'GET' ? undefined : (p.body ?? {}) })
      c.err(res, 403, ['delegation_not_permitted'], `write ${p.method} ${p.path} through an assistant delegation`)
    }
    assert.ok(outside || (c.fx.hooks?.writeProbes ?? []).length, 'neither a manifest tool outside the role nor a write probe was available to prove the ceiling')
  })

  s.check('S4', 'tickets are bound to the web session: ending the session kills the ticket and every delegation made from it', async (c) => {
    const emp = await c.fx.newEmployee('manager')
    const t = await ticketFor(c, emp)
    const d = await exchange(c, t.body.ticket)
    c.ok(d, 201)
    c.ok(await c.delegatedProbe(d.body.token), 200, 'delegation works while the session lives')
    await c.fx.hooks.revokeSession(emp)
    c.err(await c.delegatedProbe(d.body.token), 401, ['invalid_delegation_token'], 'delegation after logout')
    c.err(await exchange(c, t.body.ticket), 401, ['invalid_assistant_ticket'], 'ticket after logout')
    c.err(await c.api.post(c.v1('/assistant/tickets'), c.as.bff(emp), {}), 401, null, 'a new ticket needs a live session')
  }, { requires: ['hook:revokeSession'] })

  s.check('S5', 'a deactivated employee cannot exchange a ticket', async (c) => {
    const emp = await c.fx.newEmployee('billing')
    const t = await ticketFor(c, emp)
    await c.fx.hooks.deactivateEmployee(emp)
    c.err(await exchange(c, t.body.ticket), 401, ['invalid_assistant_ticket'], 'ticket of a deactivated employee')
  }, { requires: ['hook:deactivateEmployee'] })
}
