// R: scheduled business reports (invariants 2 and 4): counts only, scoped to the reader's role, no one but admin runs them.
import assert from 'node:assert/strict'
import { delegationForRole } from './delegation.mjs'

const NON_ASCII_STRING = /"[^"]*[^\x00-\x7f][^"]*"/g

export function register(s) {
  s.check('R1', 'the latest report: managers / admins read it, staff and anonymous cannot; the service principal alone cannot', async (c) => {
    const path = c.v1('/reports/latest')
    const r = await c.api.get(path, c.as.user(c.fx.employees.admin))
    c.ok(r, 200, 'admin')
    c.shape('getLatestReport', 200, r)
    c.ok(await c.api.get(path, c.as.user(c.fx.employees.manager)), 200, 'manager')
    c.err(await c.api.get(path, c.as.user(c.fx.employees.staff)), 403, null, 'staff session')
    c.err(await c.api.get(path, c.as.anon()), 401, null, 'anonymous')
    c.err(await c.api.get(path, c.as.service()), [401, 403], null, 'service principal without a delegation')
  })

  s.check('R2', 'a delegation reads the report scoped to the employee role: counts only, never more sections than the role may see', async (c) => {
    const reportDecl = Object.values(c.manifest()?.reports ?? {}).find((x) => x.sectionsByRole)
    for (const role of ['staff', 'manager']) {
      const d = await delegationForRole(c, role)
      const r = await c.api.get(c.v1('/reports/latest'), c.as.delegated(d.token))
      c.ok(r, 200, `${role} delegation`)
      c.shape('getLatestReport', 200, r)
      if (r.body.report && reportDecl?.sectionsByRole?.[role]) {
        const extra = Object.keys(r.body.report.sections ?? {}).filter((k) => !reportDecl.sectionsByRole[role].includes(k))
        assert.deepEqual(extra, [], `${role} may only see ${reportDecl.sectionsByRole[role].join(', ')}; got extra sections ${extra}`)
      }
      // counts only: no text with non-ASCII characters (names, free text) anywhere in the sections
      const leaks = JSON.stringify(r.body.report?.sections ?? {}).match(NON_ASCII_STRING)
      assert.equal(leaks, null, 'report sections must hold numbers and dates only (no free text)')
    }
  }, { requires: ['manifest'] })

  s.check('R3', 'running a report now is admin-only (a human session): staff, manager, delegation, service principal and anonymous are refused', async (c) => {
    const path = c.v1('/reports/run')
    c.err(await c.api.post(path, c.as.user(c.fx.employees.staff), {}), 403, null, 'staff')
    c.err(await c.api.post(path, c.as.user(c.fx.employees.manager), {}), 403, null, 'manager')
    const d = await delegationForRole(c, 'manager')
    c.err(await c.api.post(path, c.as.delegated(d.token), {}), 403, ['delegation_not_permitted'], 'delegation')
    c.err(await c.api.post(path, c.as.service(), {}), 403, null, 'service principal')
    c.err(await c.api.post(path, c.as.anon(), {}), 401, null, 'anonymous')
    c.err(await c.api.post(path, c.as.user(c.fx.employees.admin), { to: 'everyone' }), 400, null, 'invalid recipient selector')
  })
}
