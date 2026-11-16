// The external connectors page's client against a real @dsh-bridge/server-kit system (the toy, memory store): list, the billing
// software template, the secret answered as the hint only, rules, runs, the emergency stop, the field errors of 422, and 404 =
// 「準備中」. Hosts and data are fictional (no external call is made: the template host is never contacted here).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BILLING_SOFTWARE_TEMPLATE, CONNECTOR_AUTH_TYPES, ConnectorsError, RULE_MODES, STRINGS_JA, createConnectorsClient, emptyRule, hostOf, isConnectorsUnavailable, parseJsonField, triggerText,
} from '../src/core/index.ts'
import { CONNECTOR_AUTH_TYPES as PROTOCOL_AUTH, RULE_MODES as PROTOCOL_MODES, validateConnector } from '../../protocol/src/index.mjs'
import { createMemoryStore, listen } from '../../server-kit/src/index.mjs'
import { createToy } from '../../server-kit/test/toy.mjs'

let srv
let plain
let admin
const fetchAs = (headers) => (url, init) => fetch(new URL(url, srv.base), { ...init, headers: { ...init.headers, ...headers } })

before(async () => {
  const toy = await createToy({ store: createMemoryStore(), connectors: { secretKey: 'test-only-connector-key-0123456789abcdef' } })
  srv = await listen(toy.bridge.handler)
  admin = toy.addUser('admin')
  const p = await createToy({ store: createMemoryStore() })
  plain = await listen(p.bridge.handler)
  plain.admin = p.addUser('admin')
})
after(async () => { await srv?.stop(); await plain?.stop() })

test('the template passes the protocol check; auth types and modes = the protocol', () => {
  assert.ok(validateConnector(BILLING_SOFTWARE_TEMPLATE.connector).ok, JSON.stringify(validateConnector(BILLING_SOFTWARE_TEMPLATE.connector).errors))
  assert.deepEqual([...CONNECTOR_AUTH_TYPES], [...PROTOCOL_AUTH])
  assert.deepEqual([...RULE_MODES], [...PROTOCOL_MODES])
  for (const code of ['required', 'invalid', 'not_https', 'host_not_allowed', 'auto_not_allowed', 'pii_not_allowed', 'unknown_event']) assert.ok(STRINGS_JA[`conn.err.${code}`], code)
  assert.equal(hostOf('https://a.example:8443/x'), 'a.example:8443')
  assert.equal(hostOf('nope'), '')
  assert.deepEqual(parseJsonField('{"a":1}'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseJsonField('{'), { ok: false })
})

test('client: save, secret hint only, rules, runs, the stop switch, 422 field errors', async () => {
  const c = createConnectorsClient({ fetch: fetchAs(admin.headers) })
  const empty = await c.list()
  assert.deepEqual([empty.connectors, empty.state.stopped], [[], false])
  assert.ok(empty.roles.includes('admin') && empty.events.includes('task.overdue'))
  const saved = await c.save(BILLING_SOFTWARE_TEMPLATE.connector, '初回')
  assert.deepEqual([saved.id, saved.hasSecret], ['billing-software', false])
  const hint = await c.setSecret('billing-software', { token: 'fictional-key-1234' })
  assert.deepEqual(hint, { hasSecret: true, secretHint: '…1234' })
  const rule = { ...emptyRule(), id: 'monthly', name: '月初の照会', trigger: { cron: '0 9 1 * *' }, action: { connector: 'billing-software', operation: 'import-status', input: { month: '{now.month}' } }, mode: 'auto' }
  const r = await c.saveRule(rule)
  assert.equal(triggerText(r), 'cron 0 9 1 * *')
  assert.equal((await c.rules()).length, 1)
  await assert.rejects(c.save({ ...BILLING_SOFTWARE_TEMPLATE.connector, baseUrl: 'http://billing-software.example' }), (e) => e instanceof ConnectorsError && e.status === 422 && e.errors[0].code === 'not_https')
  await assert.rejects(c.remove('billing-software'), (e) => e instanceof ConnectorsError && e.code === 'connector_in_use' && e.details.rules[0] === 'monthly')
  assert.equal((await c.setStopped(true, '点検')).stopped, true)
  assert.equal((await c.list()).state.stopped, true)
  await c.setStopped(false)
  assert.deepEqual(await c.runs({ limit: 10 }), [])
  await c.removeRule('monthly')
  assert.equal((await c.clearSecret('billing-software')).hasSecret, false)
  await c.remove('billing-software')
  assert.equal((await c.list()).connectors.length, 0)
})

test('a system without external connectors: 404 → unavailable', async () => {
  const c = createConnectorsClient({ fetch: (url, init) => fetch(new URL(url, plain.base), { ...init, headers: { ...init.headers, ...plain.admin.headers } }) })
  await assert.rejects(c.list(), (e) => isConnectorsUnavailable(e))
})

