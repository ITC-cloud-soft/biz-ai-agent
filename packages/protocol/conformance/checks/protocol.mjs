// P: protocol basics (headers, error envelope, authentication of the service principal).
import assert from 'node:assert/strict'

// integer path parameters of bridge-v1.yaml (eventId, the AI profile version) get 1; the slug ids of the external connectors
// (connectorId, operationId, ruleId: ^[a-z][a-z0-9-]*$) get a fresh slug; the others a fresh UUID
const INTEGER_PARAMS = new Set(['eventId', 'version'])
const SLUG_PARAMS = new Set(['connectorId', 'operationId', 'ruleId'])
const dummy = (name, c) => (INTEGER_PARAMS.has(name) ? '1' : SLUG_PARAMS.has(name) ? `conformance-${c.uuid().slice(0, 8)}` : c.uuid())
export const fill = (template, c) => template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => dummy(n, c))

export function register(s) {
  s.check('P1', 'GET /health is unauthenticated and announces protocol 1 (body and bridge-protocol header)', async (c) => {
    const r = await c.api.get(c.v1('/health'), c.as.anon())
    c.ok(r, 200, 'health')
    assert.equal(r.body?.ok, true)
    assert.equal(r.headers.get('bridge-protocol'), '1', 'bridge-protocol header')
    assert.equal(r.body?.protocol, 1, 'health body must say protocol: 1')
    c.shape('getHealth', 200, r)
  })

  s.check('P2', 'errors use the envelope { ok:false, error:<snake_case> } (401, 404, 405)', async (c) => {
    c.err(await c.api.get(c.v1('/events'), c.as.anon()), 401, ['authentication_required', 'invalid_service_token'], 'no credentials')
    c.err(await c.api.get(c.v1('/__no_such_operation__'), c.as.service()), 404, ['not_found'], 'unknown path')
    c.err(await c.api.post(c.v1('/events'), c.as.service(), {}), 405, ['method_not_allowed'], 'wrong method')
  })

  s.check('P3', 'every service-only operation refuses: no credentials (401), a wrong service token (401), an employee session (403)', async (c) => {
    const serviceOnly = c.target.ops.filter((o) => o.op.security.length === 1 && Object.keys(o.op.security[0]).join() === 'serviceToken'
      && !c.target.unmapped.has(o.operationId))
    assert.ok(serviceOnly.length >= 10, `expected many service-only operations, found ${serviceOnly.length}`)
    const emp = c.fx.employees[c.fx.roles.includes('admin') ? 'admin' : c.fx.roles[0]]
    for (const o of serviceOnly) {
      const path = c.v1(fill(o.path, c))
      const send = (headers) => c.api[o.method === 'GET' ? 'get' : 'post'](path, headers, ...(o.method === 'GET' ? [] : [{}]))
      c.err(await send(c.as.anon()), 401, ['authentication_required', 'invalid_service_token'], `${o.operationId} anonymous`)
      c.err(await send(c.as.service('wrong-service-token-0000000000000000')), 401, ['invalid_service_token'], `${o.operationId} wrong token`)
      c.err(await send(c.as.user(emp)), 403, null, `${o.operationId} employee session`)
    }
  })

  s.check('P4', 'a delegation token needs the service token; a forged or foreign delegation token is refused', async (c) => {
    const path = c.v1('/reports/latest')
    c.err(await c.api.get(path, { 'x-delegation-token': 'cdt_forged-forged-forged-forged-forged' }), 401, ['service_token_required'], 'delegation alone')
    c.err(await c.api.get(path, c.as.delegated('cdt_forged-forged-forged-forged-forged')), 401, ['invalid_delegation_token'], 'forged delegation')
    c.err(await c.api.get(path, { 'x-service-token': 'wrong-service-token-0000000000000000', 'x-delegation-token': 'cdt_forged-forged-forged-forged-forged' }), 401,
      ['invalid_service_token'], 'wrong service token with a delegation')
  })
}
