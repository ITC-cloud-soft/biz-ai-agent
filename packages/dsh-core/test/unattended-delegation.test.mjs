// Automatic tasks (no IM sender): whose delegation runs a turn.
//  - the playbook's delegation class (source.delegation of the task of the active run, else of the conversation's tasks):
//    `<class>` → the delegate configured for that class (unattendedDelegates), else the default (unattendedOnBehalfOf)
//  - `<class>=each` → a delegation the business system issues for the person of the run's triggering event
//    (POST delegations { event: { id } }), only when the operator opted the class in (unattendedDelegates.<class> = 'each'),
//    only during a triggered run that has an event; cached per event
//  - unattendedWarnRoles: one warning when an automatic task acts for an employee of such a role
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoTaskRunResolver, createApplicationRegistry, createDelegationCache, createDelegationGate, createToolRequester, eventDelegationKey,
  eventIdForRequest, guardTool, parseDelegationSpec,
} from '../src/index.js'
import { makeSource, silentLogger, startFakeApi } from './helpers.mjs'

const EMPLOYEES = { U100: { id: 'emp-default', role: 'manager' }, U200: { id: 'emp-billing', role: 'billing' }, U900: { id: 'emp-admin', role: 'admin' } }
const EVENTS = { 41: { id: 'emp-rep-1', role: 'sales_rep' }, 42: { id: 'emp-rep-2', role: 'sales_rep' } }

function fakeApi({ expireAfter = 300_000 } = {}) {
  let n = 0
  const state = { refusedEvents: new Set(), revoked: new Set() }
  const api = startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { ok: false, error: 'invalid_service_token' } }
    if (req.path === '/bridge/v1/delegations') {
      n += 1
      if (req.body?.event) {
        const user = EVENTS[req.body.event.id]
        if (!user) return { status: 404, body: { ok: false, error: 'event_not_found' } }
        if (state.refusedEvents.has(req.body.event.id)) return { status: 403, body: { ok: false, error: 'event_delegation_refused' } }
        return { status: 201, body: { ok: true, token: `dlg-ev${req.body.event.id}-${n}`, user, expiresAt: new Date(Date.now() + expireAfter).toISOString() } }
      }
      const user = EMPLOYEES[req.body?.source?.userId]
      if (!user) return { status: 404, body: { ok: false, error: 'identity_not_linked' } }
      return { status: 201, body: { ok: true, token: `dlg-${req.body.source.userId}-${n}`, user, expiresAt: new Date(Date.now() + expireAfter).toISOString() } }
    }
    if (req.path === '/api/ping') {
      const token = req.headers['x-delegation-token']
      if (state.revoked.has(token)) return { status: 401, body: { ok: false, error: 'invalid_delegation_token' } }
      return { body: { ok: true, token } }
    }
    return null
  })
  return api.then((a) => Object.assign(a, { state }))
}

async function setup(extra = {}) {
  const api = await fakeApi()
  const registry = createApplicationRegistry({
    applications: [{ id: 'shop-orders', default: true, apiUrl: api.url, serviceToken: 'svc', namespace: 'shop', label: 'shop-api' }],
    logger: silentLogger,
  })
  const application = () => registry.get('shop-orders')
  const requester = createToolRequester({ application })
  const warnings = []
  const logger = { ...silentLogger, warn: (...a) => warnings.push(a) }
  const run = { current: null }
  const sessionTasks = { current: [] }
  const gate = createDelegationGate({
    application,
    registry: () => registry,
    identity: () => ({ forSession: async () => null, invalidate() {} }),
    isAutoTaskSession: async (sid) => sid === 'auto-1',
    activeRun: (sid) => (sid === 'auto-1' ? run.current : null),
    sessionDelegations: async (sid) => (sid === 'auto-1' ? sessionTasks.current : []),
    requestJson: requester.requestJson,
    logger,
    ...extra,
  })
  return { api, gate, requester, run, sessionTasks, warnings, close: () => api.close() }
}
const exec = (id) => ({ agent: { session: { id } } })
const delegationCalls = (api) => api.callsTo('/bridge/v1/delegations')

test('parseDelegationSpec / eventIdForRequest / eventDelegationKey', () => {
  assert.deepEqual(parseDelegationSpec('sales'), { class: 'sales', each: false })
  assert.deepEqual(parseDelegationSpec('sales_rep=each'), { class: 'sales_rep', each: true })
  for (const bad of [undefined, null, '', 'Care', 'care=all', '=each', 'a b', 42]) assert.equal(parseDelegationSpec(bad), null, String(bad))
  assert.equal(eventIdForRequest('42'), 42)
  assert.equal(eventIdForRequest(7), 7)
  for (const bad of ['0', '-1', 'abc', '1.5', '', null, '99999999999999999']) assert.equal(eventIdForRequest(bad), null, String(bad))
  assert.notEqual(eventDelegationKey('shop-orders', 42), eventDelegationKey('equipment-inspection', 42))
})

test('delegation class: the class delegate, else the default; no delegation configured at all → refused as before', async () => {
  const env = await setup({
    unattended: () => makeSource({ userId: 'U100' }),
    unattendedDelegates: () => ({ billing: makeSource({ userId: 'U200' }), sales_rep: 'each' }),
  })
  try {
    env.run.current = { runId: 'r1', taskId: 'at_invoice', eventId: '9', delegation: 'billing' }
    const billing = await env.gate.authorize('shop_list_invoices', exec('auto-1'))
    assert.deepEqual([billing.unattended, billing.delegationClass, billing.userId, billing.delegationToken.startsWith('dlg-U200-')], [true, 'billing', 'emp-billing', true])
    assert.deepEqual(delegationCalls(env.api).at(-1).body, { source: { platform: 'slack', teamId: 'T1', userId: 'U200' } })
    env.run.current = { runId: 'r2', taskId: 'at_plan', eventId: '10', delegation: 'sales' }
    const sales = await env.gate.authorize('shop_list_customers', exec('auto-1'))
    assert.deepEqual([sales.userId, sales.delegationClass], ['emp-default', undefined], 'no delegate for sales: the default one')
    env.run.current = { runId: 'r3', taskId: 'at_old', eventId: '11' }
    assert.equal((await env.gate.authorize('shop_list_customers', exec('auto-1'))).userId, 'emp-default', 'a task without a class: the default')
    // not an automatic-task conversation: never
    await assert.rejects(env.gate.authorize('shop_list_invoices', exec('owner-web')), /not allowed — this conversation has no IM sender/)
  } finally {
    await env.close()
  }
  const none = await setup()
  try {
    none.run.current = { runId: 'r1', taskId: 'at_invoice', eventId: '9', delegation: 'billing' }
    await assert.rejects(none.gate.authorize('shop_list_invoices', exec('auto-1')), /not allowed — this conversation has no IM sender/)
    assert.equal(delegationCalls(none.api).length, 0)
  } finally {
    await none.close()
  }
})

test('<class>=each: a delegation per triggering event, issued by the business system for the person of that event; cached per event', async () => {
  const env = await setup({ unattendedDelegates: () => ({ sales_rep: 'each' }) })
  try {
    env.run.current = { runId: 'r1', taskId: 'at_mon', eventId: '41', eventType: 'order.review_requested', applicationId: 'shop-orders', delegation: 'sales_rep=each' }
    const p1 = await env.gate.authorize('shop_list_orders', exec('auto-1'))
    assert.deepEqual([p1.mode, p1.unattended, p1.perEvent, p1.delegationClass, p1.userId], ['delegated', true, true, 'sales_rep', 'emp-rep-1'])
    assert.deepEqual(delegationCalls(env.api).map((c) => c.body), [{ event: { id: 41 } }], 'only the event id: the caller never names the person')
    // the same run (same event): cached
    const again = await env.gate.authorize('shop_get_order', exec('auto-1'))
    assert.equal(again.delegationToken, p1.delegationToken)
    assert.equal(delegationCalls(env.api).length, 1)
    // the next run (another sales rep's event): another person's delegation
    env.run.current = { ...env.run.current, runId: 'r2', eventId: '42' }
    const p2 = await env.gate.authorize('shop_propose_reply', exec('auto-1'), { write: false })
    assert.deepEqual([p2.userId, delegationCalls(env.api).at(-1).body], ['emp-rep-2', { event: { id: 42 } }])
    assert.notEqual(p2.delegationToken, p1.delegationToken)
    // the business system refuses (setting off, stale request, ...): the tool is refused, no token
    env.api.state.refusedEvents.add(42)
    env.gate.forget(p2.cacheKey)
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /shop-api issues no delegation for the event that started this automatic task \(event_delegation_refused\)/)
    env.run.current = { ...env.run.current, runId: 'r3', eventId: '77' }
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /\(event_not_found\)/)
  } finally {
    await env.close()
  }
})

test('<class>=each is refused: not opted in, outside of a run, a run without an event, a run of another application', async () => {
  const off = await setup({ unattended: () => makeSource({ userId: 'U100' }), unattendedDelegates: () => ({ billing: makeSource({ userId: 'U200' }) }) })
  try {
    off.run.current = { runId: 'r1', taskId: 'at_mon', eventId: '41', delegation: 'sales_rep=each' }
    await assert.rejects(off.gate.authorize('shop_list_orders', exec('auto-1')), /per-person delegation of "sales_rep" is not enabled .*--auto-task-delegate sales_rep=each/)
    assert.equal(delegationCalls(off.api).length, 0, 'never the default delegate instead')
  } finally {
    await off.close()
  }
  const env = await setup({ unattendedDelegates: () => ({ sales_rep: 'each' }) })
  try {
    env.sessionTasks.current = ['sales_rep=each']
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /acts only during one of its triggered runs/)
    env.run.current = { runId: 'r1', taskId: 'at_mon', delegation: 'sales_rep=each' }
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /no business event to be delegated by/)
    env.run.current = { runId: 'r1', taskId: 'at_mon', eventId: 'not-a-number', delegation: 'sales_rep=each' }
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /no business event/)
    env.run.current = { runId: 'r1', taskId: 'pb_x', eventId: '41', applicationId: 'equipment-inspection', delegation: 'sales_rep=each' }
    await assert.rejects(env.gate.authorize('shop_list_orders', exec('auto-1')), /belongs to application "equipment-inspection"/)
    assert.equal(delegationCalls(env.api).length, 0)
  } finally {
    await env.close()
  }
})

test('outside of a run: the class of the conversation\'s tasks when there is exactly one', async () => {
  const env = await setup({ unattended: () => makeSource({ userId: 'U100' }), unattendedDelegates: () => ({ billing: makeSource({ userId: 'U200' }), sales_rep: 'each' }) })
  try {
    env.sessionTasks.current = ['billing', 'billing']
    assert.equal((await env.gate.authorize('shop_list_invoices', exec('auto-1'))).userId, 'emp-billing')
    env.sessionTasks.current = ['billing', 'sales']
    assert.equal((await env.gate.authorize('shop_list_invoices', exec('auto-1'))).userId, 'emp-default', 'several classes: the default')
    env.sessionTasks.current = ['sales_rep=each', 'billing']
    assert.equal((await env.gate.authorize('shop_list_invoices', exec('auto-1'))).userId, 'emp-default')
  } finally {
    await env.close()
  }
})

test('a per-event token that stops working (401) is dropped and asked again once (guardTool); the business system then refuses', async () => {
  const env = await setup({ unattendedDelegates: () => ({ sales_rep: 'each' }) })
  try {
    env.run.current = { runId: 'r1', taskId: 'at_mon', eventId: '41', delegation: 'sales_rep=each' }
    const ping = guardTool(env.gate, { name: 'shop_ping', execute: async () => env.requester.requestJson('shop_ping', '/api/ping') })
    const first = await ping.execute({}, exec('auto-1'))
    assert.match(first.token, /^dlg-ev41-/)
    // the sales rep turned their opt-in off: the token is refused (401) and a new one is not issued
    env.api.state.revoked.add(first.token)
    env.api.state.refusedEvents.add(41)
    await assert.rejects(ping.execute({}, exec('auto-1')), /issues no delegation for the event/)
    assert.equal(delegationCalls(env.api).length, 2)
  } finally {
    await env.close()
  }
})

test('unattendedWarnRoles: one warning per delegate when an automatic task acts for an employee of such a role', async () => {
  const env = await setup({ unattended: () => makeSource({ userId: 'U900' }), unattendedWarnRoles: () => ['admin'] })
  try {
    env.run.current = { runId: 'r1', taskId: 'at_plan', eventId: '9', delegation: 'sales' }
    await env.gate.authorize('shop_list_customers', exec('auto-1'))
    await env.gate.authorize('shop_list_customers', exec('auto-1'))
    assert.equal(env.warnings.length, 1)
    assert.match(env.warnings[0][0], /run on behalf of an employee with the role/)
    assert.deepEqual(env.warnings[0].slice(1), ['shop-orders', '', 'admin'])
  } finally {
    await env.close()
  }
})

test('autoTaskRunResolver: activeRun from ctx.autoTasks (same session only); the delegation classes of the conversation\'s enabled tasks', async () => {
  let current = { runId: 'r1', taskId: 'at_mon', sessionId: 'auto-1', eventId: '41', delegation: 'sales_rep=each' }
  const tasks = [
    { id: 'a', sessionId: 'auto-1', enabled: true, applicationId: 'shop-orders', source: { delegation: 'sales' } },
    { id: 'b', sessionId: 'auto-1', enabled: false, applicationId: 'shop-orders', source: { delegation: 'billing' } },
    { id: 'c', sessionId: 'auto-1', enabled: true, applicationId: 'equipment-inspection', source: { delegation: 'inspector' } },
    { id: 'd', sessionId: 'auto-1', enabled: true, source: {} },
    { id: 'e', sessionId: 'auto-2', enabled: true, source: { delegation: 'other' } },
  ]
  const service = { activeRun: (sid) => (sid === current?.sessionId ? current : null), list: async ({ sessionId }) => tasks.filter((t) => t.sessionId === sessionId) }
  const r = autoTaskRunResolver(() => service)
  assert.equal((await r.activeRun('auto-1')).eventId, '41')
  assert.equal(await r.activeRun('auto-2'), null)
  current = { ...current, sessionId: 'auto-2' }
  assert.equal(await r.activeRun('auto-1'), null)
  assert.deepEqual(await r.sessionDelegations('auto-1', 'shop-orders'), ['sales'])
  const none = autoTaskRunResolver(() => ({ list: async () => { throw new Error('down') } }))
  assert.equal(await none.activeRun('auto-1'), null, 'an auto-tasks without activeRun')
  assert.deepEqual(await none.sessionDelegations('auto-1'), [])
  assert.equal(await autoTaskRunResolver(() => null).activeRun('auto-1'), null)
})

test('the delegation cache keeps per-event entries apart from IM sources and forgets them by key', async () => {
  const cache = createDelegationCache()
  const minted = []
  const mint = async (body) => { minted.push(body); return { token: `t${minted.length}`, user: { id: 'u', role: 'sales_rep' }, expiresAt: new Date(Date.now() + 60_000).toISOString() } }
  const a = await cache.getForEvent('shop-orders', '41', mint)
  assert.deepEqual([a.token, a.role, a.key], ['t1', 'sales_rep', eventDelegationKey('shop-orders', 41)])
  assert.equal((await cache.getForEvent('shop-orders', 41, mint)).token, 't1')
  assert.equal((await cache.getForEvent('equipment-inspection', 41, mint)).token, 't2', 'per application')
  await assert.rejects(cache.getForEvent('shop-orders', 'x', mint), /no business event/)
  assert.equal(cache.forget(a.key), true)
  assert.equal((await cache.getForEvent('shop-orders', 41, mint)).token, 't3')
  assert.deepEqual(minted, [{ event: { id: 41 } }, { event: { id: 41 } }, { event: { id: 41 } }])
})
