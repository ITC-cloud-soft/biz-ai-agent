// External connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3): the runner against a fake upstream API on localhost,
// the secret sealing, and the routes / proposal kind / rule engine on the toy system (memory store). Data and hosts are fictional.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { validateConnector } from '@dsh-bridge/protocol'
import { checkSecret, connectorSecretKey, createConnectorRunner, createRuleEngine, minuteKey, openSecret, sealSecret, secretHint } from '../src/connectors/index.mjs'
import { createMemoryStore, listen } from '../src/index.mjs'
import { client, createToy, SERVICE_TOKEN } from './toy.mjs'

const S = { 'x-service-token': SERVICE_TOKEN }
const D = (token) => ({ ...S, 'x-delegation-token': token })
const KEY = 'test-only-connector-key-0123456789abcdef'

/** A fake upstream API: records what it received (method, path, query, auth header, body). */
async function upstream() {
  const seen = []
  let failNext = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'] ?? null, auth: req.headers.authorization ?? null, body: body ? (() => { try { return JSON.parse(body) } catch { return body } })() : null })
      if (failNext > 0) { failNext -= 1; res.writeHead(503); res.end(); return }
      if (url.pathname === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 })); return }
      if (url.pathname === '/redirect') { res.writeHead(302, { location: 'https://elsewhere.example.test/' }); res.end(); return }
      if (url.pathname === '/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ x: 'y'.repeat(4000) })); return }
      if (url.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}') }, 1500); return }
      if (url.pathname === '/boom') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"secret detail"}'); return }
      if (url.pathname.startsWith('/v1/imports/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'done', counts: { total: 3, hidden: 9 }, residentName: '架空 太郎', items: [{ id: 'a', name: '架空' }] }))
        return
      }
      if (url.pathname.startsWith('/v1/residents/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"accepted":true}'); return }
      res.writeHead(404); res.end()
    })
  })
  const srv = await listen((req, res) => server.emit('request', req, res))
  return { ...srv, seen, failOnce: (n = 1) => { failNext = n } }
}

const OPS = [
  {
    id: 'import-status', name: '取込状況の照会', method: 'GET', path: '/v1/imports/{month}', description: '月の取込状況',
    input: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } } }, responseFields: ['status', 'counts.total', 'items[].id'], roles: ['admin', 'manager'],
  },
  {
    id: 'update-level', name: '区分の送信', method: 'PUT', path: '/v1/residents/{externalId}/level', idempotent: true, pii: 'health', roles: ['manager'],
    input: { type: 'object', properties: { externalId: { type: 'string' }, level: { type: 'integer', minimum: 1, maximum: 7 } }, required: ['level'] }, responseFields: ['accepted'],
  },
]
const def = (base, extra = {}) => validateConnector({ id: 'billing-software', name: '請求ソフト（架空）', baseUrl: base, auth: { type: 'api_key' }, operations: OPS, ...extra }, { allowLocalhost: true })

describe('runner and secrets', () => {
  let up
  before(async () => { up = await upstream() })
  after(async () => { await up?.stop() })

  test('a read: the allow-listed fields only, the key header, the path variable encoded', async () => {
    const c = def(up.base)
    assert.ok(c.ok, JSON.stringify(c.errors))
    const runner = createConnectorRunner({ allowLocalhost: true })
    const r = await runner.run({ connector: c.connector, operation: c.connector.operations[0], input: { month: '2026-10' }, secret: { token: 'k-123456789' } })
    assert.deepEqual([r.ok, r.status, r.attempts], [true, 200, 1])
    assert.deepEqual(r.data, { status: 'done', counts: { total: 3 }, items: [{ id: 'a' }] }, 'the resident name and hidden counts never pass')
    assert.deepEqual([up.seen.at(-1).path, up.seen.at(-1).key], ['/v1/imports/2026-10', 'k-123456789'])
    assert.equal((await runner.run({ connector: c.connector, operation: c.connector.operations[0], input: { month: 'x' }, secret: { token: 'k' } })).code, 'invalid_input')
    assert.equal((await runner.run({ connector: c.connector, operation: c.connector.operations[0], input: { month: '2026-10' }, secret: null })).code, 'secret_missing')
    assert.equal((await createConnectorRunner().run({ connector: c.connector, operation: c.connector.operations[0], input: { month: '2026-10' }, secret: { token: 'k' } })).code, 'host_not_allowed', 'http to localhost only in development')
    assert.equal((await runner.run({ connector: { ...c.connector, enabled: false }, operation: c.connector.operations[0], input: { month: '2026-10' } })).code, 'connector_disabled')
  })

  test('guards: redirect refused, size cap, timeout, upstream error without its body, retry of an idempotent call, rate limit', async () => {
    const extra = (id, path, method = 'GET', idempotent = true) => ({ id, name: id, method, path, idempotent, effect: method === 'GET' ? 'read' : 'write' })
    const c = def(up.base, {
      auth: { type: 'bearer' }, maxResponseBytes: 1024, timeoutMs: 1000, ratePerMinute: 30,
      operations: [extra('redirect', '/redirect'), extra('big', '/big'), extra('slow', '/slow'), extra('boom', '/boom'), extra('put', '/v1/residents/x/level', 'PUT', true), extra('post', '/v1/residents/x/level', 'POST', false)],
    }).connector
    const runner = createConnectorRunner({ allowLocalhost: true, sleep: async () => {} })
    const op = (id) => c.operations.find((o) => o.id === id)
    const secret = { token: 'bearer-token-1' }
    assert.equal((await runner.run({ connector: c, operation: op('redirect'), secret })).code, 'redirect_refused')
    assert.equal((await runner.run({ connector: c, operation: op('big'), secret })).code, 'response_too_large')
    const slow = await runner.run({ connector: c, operation: op('slow'), secret })
    assert.deepEqual([slow.code, slow.attempts], ['timeout', 2], 'an idempotent read is retried once')
    const boom = await runner.run({ connector: c, operation: op('boom'), secret })
    assert.deepEqual([boom.code, boom.status], ['upstream_error', 500])
    assert.ok(!JSON.stringify(boom).includes('secret detail'), 'the upstream body never travels')
    assert.equal(up.seen.at(-1).auth, 'Bearer bearer-token-1')
    up.failOnce(1)
    const retried = await runner.run({ connector: c, operation: op('put'), secret })
    assert.deepEqual([retried.ok, retried.attempts], [true, 2])
    up.failOnce(1)
    const once = await runner.run({ connector: c, operation: op('post'), secret })
    assert.deepEqual([once.ok, once.code, once.attempts], [false, 'upstream_error', 1], 'a non-idempotent write is never retried')
    const limited = createConnectorRunner({ allowLocalhost: true })
    const one = { ...c, ratePerMinute: 1 }
    assert.ok((await limited.run({ connector: one, operation: op('put'), secret })).ok)
    assert.equal((await limited.run({ connector: one, operation: op('put'), secret })).code, 'rate_limited')
  })

  test('oauth2 client credentials: the token host must be allowed; the token is cached', async () => {
    const host = new URL(up.base).host
    const c = def(up.base, { allowedHosts: [host], auth: { type: 'oauth2_client', clientId: 'cid', tokenUrl: `${up.base}/token` } }).connector
    const runner = createConnectorRunner({ allowLocalhost: true })
    const before = up.seen.length
    for (let i = 0; i < 2; i += 1) assert.ok((await runner.run({ connector: c, operation: c.operations[0], input: { month: '2026-10' }, secret: { clientSecret: 'cs-0123456789' } })).ok)
    const calls = up.seen.slice(before)
    assert.deepEqual(calls.map((x) => x.path), ['/token', '/v1/imports/2026-10', '/v1/imports/2026-10'])
    assert.equal(calls[1].auth, 'Bearer tok-1')
  })

  test('secrets: sealed per connector, the hint is the last 4 characters, checked per auth type', () => {
    const key = connectorSecretKey(KEY)
    assert.throws(() => connectorSecretKey('short'), /32/)
    const sealed = sealSecret(key, 'a', { token: 'abcdefgh1234' })
    assert.ok(!sealed.includes('abcdefgh1234'))
    assert.deepEqual(openSecret(key, 'a', sealed), { token: 'abcdefgh1234' })
    assert.equal(openSecret(key, 'b', sealed), null, 'cannot be moved to another connector')
    assert.equal(openSecret(connectorSecretKey(`${KEY}-other`), 'a', sealed), null)
    assert.equal(secretHint({ token: 'abcdefgh1234' }), '…1234')
    assert.equal(secretHint({ token: 'short' }), '…')
    assert.deepEqual(checkSecret('basic', { password: 'p' }).secret, { password: 'p' })
    assert.deepEqual(checkSecret('api_key', { password: 'p' }).errors.map((e) => `${e.field}:${e.code}`), ['secret.password:unknown_field', 'secret.token:required'])
    assert.equal(checkSecret('none', {}).errors[0].code, 'not_needed')
  })

  test('the rule engine: conditions, auto / approval / propose-by-ai, the stop switch, cron once per minute', async () => {
    const connector = def('https://billing.example.test').connector
    const runs = []
    const rules = [
      { id: 'r-auto', enabled: true, trigger: { event: 'x.done' }, when: { all: [{ field: 'payload.n', op: 'gt', value: 1 }] }, action: { connector: connector.id, operation: 'import-status', input: { month: '{payload.month}' } }, mode: 'auto', approvers: null, notify: { onSuccess: 'info', onFailure: 'action' } },
      { id: 'r-write', enabled: true, trigger: { event: 'x.done' }, when: null, action: { connector: connector.id, operation: 'update-level', input: { externalId: '{payload.id}', level: '{payload.level}' } }, mode: 'auto', approvers: { role: 'manager' }, notify: { onSuccess: 'none', onFailure: 'none' } },
      { id: 'r-ai', enabled: true, trigger: { cron: '0 9 * * *' }, when: null, action: { connector: connector.id, operation: 'import-status', input: { month: '{now.month}' } }, mode: 'propose-by-ai', approvers: { role: 'manager' }, notify: { onSuccess: 'none', onFailure: 'none' } },
    ]
    let stopped = false
    const notes = []
    const engine = createRuleEngine({
      timeZone: 'Asia/Tokyo',
      listRules: async () => rules,
      connectorOf: async () => connector,
      isStopped: async () => stopped,
      runOperation: async ({ input }) => ({ ok: true, status: 200, durationMs: 5, data: {}, input }),
      requestApproval: async () => ({ proposalId: 'p-1' }),
      proposeByAi: async ({ inputKeys }) => ({ started: inputKeys.includes('month') }),
      recordRun: async (r) => { runs.push(r) },
      notify: async (n) => { notes.push(`${n.rule.id}:${n.status}:${n.level}`) },
    })
    const out = await engine.onEvent({ id: 5, type: 'x.done', payload: { n: 2, month: '2026-10', id: 'R-1', level: 3 } })
    assert.deepEqual(out.map((o) => `${o.ruleId}:${o.status}`), ['r-auto:succeeded', 'r-write:pending_approval'], 'a write without the auto permission goes to approval')
    assert.deepEqual(runs.map((r) => [r.ruleId, r.trigger.eventId, r.proposalId ?? null]), [['r-auto', 5, null], ['r-write', 5, 'p-1']])
    assert.deepEqual(notes, ['r-auto:succeeded:info'])
    assert.deepEqual(await engine.onEvent({ id: 6, type: 'x.done', payload: { n: 1, id: 'R-1', level: 9 } }).then((o) => o.map((x) => `${x.ruleId}:${x.status}:${x.code ?? ''}`)), ['r-write:failed:invalid_input'])
    stopped = true
    assert.deepEqual((await engine.onEvent({ id: 7, type: 'x.done', payload: { n: 2, month: '2026-10', id: 'R', level: 1 } })).map((o) => o.code), ['stopped', 'stopped'])
    stopped = false
    const nine = new Date('2026-10-30T00:00:00Z') // 09:00 in Tokyo
    assert.deepEqual((await engine.onMinute(nine)).map((o) => `${o.ruleId}:${o.status}`), ['r-ai:proposed'])
    assert.deepEqual(await engine.onMinute(new Date('2026-10-30T00:01:00Z')), [])
    assert.equal(minuteKey(nine, 'Asia/Tokyo'), '2026-10-30T09:00')
  })
})

describe('routes on the toy system', () => {
  let up
  let toy
  let srv
  let call
  let admin
  let manager
  let staff
  const cards = []
  async function link(emp) {
    const code = await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })
    const source = { platform: 'slack', teamId: 'T1', userId: `U-${emp.id.slice(0, 8)}` }
    await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: code.body.code, source } })
    const d = await call('POST', '/bridge/v1/delegations', { headers: S, body: { source } })
    return d.body.token
  }
  before(async () => {
    up = await upstream()
    toy = await createToy({
      store: createMemoryStore(),
      connectors: { secretKey: KEY, allowLocalhost: true, onApprovalNeeded: async (a) => { cards.push(`${a.proposal.kind}:${a.approverRole ?? '-'}`) } },
    })
    srv = await listen(toy.bridge.handler)
    call = client(srv.base)
    admin = toy.addUser('admin')
    manager = toy.addUser('manager')
    staff = toy.addUser('staff')
  })
  after(async () => { await srv?.stop(); await up?.stop() })

  const connectorBody = () => ({ connector: { name: '請求ソフト（架空）', baseUrl: up.base, auth: { type: 'api_key' }, operations: OPS } })

  test('administrators only; save → 422 with field / code; the secret answers with the hint only', async () => {
    assert.equal((await call('GET', '/bridge/v1/admin/connectors', { headers: staff.headers })).status, 403)
    assert.equal((await call('GET', '/bridge/v1/admin/connectors', { headers: S })).body.error, 'human_required')
    const bad = await call('PUT', '/bridge/v1/admin/connectors/billing-software', { headers: admin.headers, body: { connector: { ...connectorBody().connector, baseUrl: 'ftp://x' } } })
    assert.deepEqual([bad.status, bad.body.error, bad.body.details.errors], [422, 'invalid_connector', [{ field: 'baseUrl', code: 'not_https' }]])
    const ok = await call('PUT', '/bridge/v1/admin/connectors/billing-software', { headers: admin.headers, body: connectorBody() })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual([ok.body.connector.id, ok.body.connector.hasSecret], ['billing-software', false])
    const sec = await call('PUT', '/bridge/v1/admin/connectors/billing-software/secret', { headers: admin.headers, body: { secret: { token: 'key-abcdef-9876' } } })
    assert.deepEqual(sec.body, { ok: true, hasSecret: true, secretHint: '…9876' })
    const list = await call('GET', '/bridge/v1/admin/connectors', { headers: admin.headers })
    assert.ok(!list.text.includes('key-abcdef-9876') && !list.text.includes('v1.'), 'neither the secret nor the sealed value is shown')
    assert.equal(list.body.connectors[0].secretHint, '…9876')
    const audits = await toy.store.listAudit({ limit: 50 })
    assert.ok(!JSON.stringify(audits).includes('key-abcdef'), 'audits never hold the secret')
    const t = await call('POST', '/bridge/v1/admin/connectors/billing-software/test', { headers: admin.headers, body: { operationId: 'import-status', input: { month: '2026-10' } } })
    assert.deepEqual([t.body.result.ok, t.body.result.status, t.body.result.fields], [true, 200, ['status', 'counts', 'items']])
    assert.equal((await call('POST', '/bridge/v1/admin/connectors/billing-software/test', { headers: admin.headers, body: { operationId: 'update-level' } })).status, 422, 'a write is never tested')
  })

  test('the AI: the catalog for the service; a read as the employee (role ∈ operation.roles); a write only as a proposal', async () => {
    const cat = await call('GET', '/bridge/v1/connectors/catalog', { headers: S })
    assert.deepEqual(cat.body.operations.map((o) => `${o.operationId}:${o.effect}`), ['import-status:read', 'update-level:write'])
    assert.equal((await call('GET', '/bridge/v1/connectors/catalog', { headers: { ...S, 'if-none-match': cat.headers.get('etag') } })).status, 304)
    const dMgr = await link(manager)
    const dStaff = await link(staff)
    const r = await call('POST', '/bridge/v1/connectors/billing-software/operations/import-status/run', { headers: D(dMgr), body: { input: { month: '2026-10' } } })
    assert.deepEqual([r.status, r.body.data], [200, { status: 'done', counts: { total: 3 }, items: [{ id: 'a' }] }])
    assert.equal((await call('POST', '/bridge/v1/connectors/billing-software/operations/import-status/run', { headers: D(dStaff), body: { input: { month: '2026-10' } } })).body.error, 'role_not_permitted')
    assert.equal((await call('POST', '/bridge/v1/connectors/billing-software/operations/update-level/run', { headers: D(dMgr), body: { input: { externalId: 'R-1', level: 3 } } })).body.error, 'write_requires_approval')
    assert.equal((await call('POST', '/bridge/v1/connectors/billing-software/operations/import-status/run', { headers: S, body: {} })).body.error, 'human_required')
    const bad = await call('POST', '/bridge/v1/connectors/billing-software/operations/import-status/run', { headers: D(dMgr), body: { input: { month: 'x' } } })
    assert.deepEqual([bad.status, bad.body.details.errors], [400, [{ field: 'input.month', code: 'invalid' }]])

    const p = await call('POST', '/bridge/v1/proposals', { headers: D(dMgr), body: { kind: 'connector_write', payload: { connectorId: 'billing-software', operationId: 'update-level', input: { externalId: 'R-1', level: 3 } } } })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.ok(!p.text.includes('R-1'), 'the input is sealed in the proposal')
    assert.deepEqual(p.body.proposal.payload.inputKeys, ['externalId', 'level'])
    assert.equal((await call('POST', '/bridge/v1/proposals', { headers: D(dStaff), body: { kind: 'connector_write', payload: { connectorId: 'billing-software', operationId: 'update-level', input: { level: 3, externalId: 'R' } } } })).body.error, 'role_not_permitted')
    const before = up.seen.length
    const acc = await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: admin.headers, body: {} })
    assert.equal(acc.status, 200, JSON.stringify(acc.body))
    assert.deepEqual(up.seen.slice(before).map((x) => [x.method, x.path, x.body]), [['PUT', '/v1/residents/R-1/level', { level: 3 }]])
    const runs = await call('GET', '/bridge/v1/admin/connector-runs', { headers: admin.headers })
    assert.deepEqual(runs.body.runs.slice(0, 2).map((x) => `${x.trigger}:${x.status}`), ['approval:succeeded', 'ai:succeeded'])
    assert.ok(!runs.text.includes('R-1') && !runs.text.includes('done'), 'the run log keeps no input and no response')
  })

  test('rules: an event triggers an auto read and an approval write (card requested); the global stop empties the catalog', async () => {
    const auto = await call('PUT', '/bridge/v1/admin/connector-rules/nightly-status', { headers: admin.headers, body: { rule: { name: '期限超過で照会', trigger: { event: 'task.overdue' }, action: { connector: 'billing-software', operation: 'import-status', input: { month: '2026-10' } }, mode: 'auto' } } })
    assert.equal(auto.status, 200, JSON.stringify(auto.body))
    const approval = await call('PUT', '/bridge/v1/admin/connector-rules/send-level', { headers: admin.headers, body: { rule: { name: '区分の送信', trigger: { event: 'task.overdue' }, when: { all: [{ field: 'payload.daysOverdue', op: 'gt', value: 1 }] }, action: { connector: 'billing-software', operation: 'update-level', input: { externalId: '{payload.taskId}', level: 2 } }, approvers: { role: 'manager' }, allowPii: true } } })
    assert.equal(approval.status, 200, JSON.stringify(approval.body))
    const bad = await call('PUT', '/bridge/v1/admin/connector-rules/bad-one', { headers: admin.headers, body: { rule: { name: 'x', trigger: { event: 'no.such' }, action: { connector: 'billing-software', operation: 'update-level', input: { level: 1, externalId: 'x' } }, mode: 'auto' } } })
    assert.deepEqual(bad.body.details.errors.map((e) => `${e.field}:${e.code}`), ['trigger.event:unknown_event', 'mode:auto_not_allowed', 'allowPii:pii_not_allowed'])
    assert.equal((await call('DELETE', '/bridge/v1/admin/connectors/billing-software', { headers: admin.headers })).body.error, 'connector_in_use')

    const task = await toy.addTask()
    await toy.markOverdue(task)
    const result = await toy.kit.connectors.tick()
    assert.equal(result.events, 2)
    const runs = (await call('GET', '/bridge/v1/admin/connector-runs?ruleId=send-level', { headers: admin.headers })).body.runs
    assert.deepEqual(runs.map((r) => `${r.trigger}:${r.status}`), ['event:pending_approval'])
    assert.deepEqual(cards, ['connector_write:manager'])
    const pending = await call('GET', '/bridge/v1/proposals', { headers: admin.headers, query: { kind: 'connector_write', status: 'pending_review' } })
    assert.equal(pending.body.proposals.length, 1)
    assert.ok(!pending.text.includes(task.id), 'the rule input is sealed too')
    assert.equal((await call('POST', `/bridge/v1/proposals/${pending.body.proposals[0].id}/accept`, { headers: staff.headers, body: {} })).status, 403)
    assert.equal((await toy.kit.connectors.tick()).events, 0, 'each event once')

    const stop = await call('PUT', '/bridge/v1/admin/connector-settings', { headers: admin.headers, body: { stopped: true, reason: '点検' } })
    assert.equal(stop.body.state.stopped, true)
    assert.deepEqual((await call('GET', '/bridge/v1/connectors/catalog', { headers: S })).body.operations, [])
    const dMgr = await link(toy.addUser('manager'))
    assert.equal((await call('POST', '/bridge/v1/connectors/billing-software/operations/import-status/run', { headers: D(dMgr), body: { input: { month: '2026-10' } } })).body.error, 'connector_stopped')
    await call('PUT', '/bridge/v1/admin/connector-settings', { headers: admin.headers, body: { stopped: false } })
    assert.equal((await call('DELETE', '/bridge/v1/admin/connector-rules/send-level', { headers: admin.headers })).status, 200)
    assert.equal((await call('DELETE', '/bridge/v1/admin/connector-rules/nightly-status', { headers: admin.headers })).status, 200)
    assert.equal((await call('DELETE', '/bridge/v1/admin/connectors/billing-software/secret', { headers: admin.headers })).body.hasSecret, false)
    assert.equal((await call('DELETE', '/bridge/v1/admin/connectors/billing-software', { headers: admin.headers })).status, 200)
    assert.equal((await call('GET', '/bridge/v1/admin/connectors', { headers: admin.headers })).body.connectors.length, 0)
  })

  test('without the capability: 404 after the gate', async () => {
    const plain = await createToy({ store: createMemoryStore() })
    const s2 = await listen(plain.bridge.handler)
    try {
      assert.equal((await client(s2.base)('GET', '/bridge/v1/connectors/catalog', { headers: S })).status, 404)
      assert.equal((await client(s2.base)('GET', '/bridge/v1/connectors/catalog')).status, 401) // the gate first
    } finally { await s2.stop() }
  })
})
