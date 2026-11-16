import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createEventPump, createDispatcher, inject, name, APPROVAL_EVENT_TYPES } from '../src/index.js'
import { createBusinessApi } from '@dsh-bridge/dsh-core'
import { makeCtx, mockAutoTasks, mockStorageDomain, startFakeApi, silentLogger } from './helpers.mjs'

function ev(id, type, payload = {}) {
  return { id, type, aggregateType: type.split('.')[0], aggregateId: `agg-${id}`, payload, at: '2026-10-25T00:00:00.000Z' }
}

/** 偽 events API（Bridge v1）。after より後を返す（id は数値の連番）。 */
function eventsApi(events) {
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { error: 'service_token_required' } }
    if (req.path !== '/bridge/v1/events') return { status: 404 }
    const after = req.query.after === undefined ? 0 : Number(req.query.after)
    const limit = Number(req.query.limit ?? 100)
    const page = events.filter((e) => e.id > after).slice(0, limit)
    return { body: { events: page, nextAfter: page.length ? page[page.length - 1].id : after } }
  })
}

function pumpFor(api, { dispatch, store, maxAttempts = 3, batchSize = 100 } = {}) {
  let value = null
  const s = store ?? { get: () => value, set: async (v) => { value = v } }
  return {
    store: s,
    pump: createEventPump({
      api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc', label: 'test API' }),
      store: s,
      dispatch,
      logger: silentLogger(),
      maxAttempts: () => maxAttempts,
      batchSize: () => batchSize,
    }),
  }
}

test('metadata', () => {
  assert.equal(name, 'bridge-events')
  assert.deepEqual(inject, ['storageDomain'])
  assert.deepEqual([...APPROVAL_EVENT_TYPES], ['approval.requested', 'approval.decided', 'approval.expired'])
})

test('dispatches approval events to subscribers and others to autoTasks.emit(dedupeKey=event.id); cursor persists', async () => {
  const events = [
    ev(1, 'approval.requested', { approvalId: 'a1' }),
    ev(2, 'proposal.reviewed', { proposalId: 'p1', decision: 'accepted' }),
    ev(3, 'approval.decided', { approvalId: 'a1', status: 'approved' }),
    ev(4, 'inspection.completed', { count: 3 }),
  ]
  const api = await eventsApi(events)
  const storage = mockStorageDomain()
  const tasks = mockAutoTasks()
  const ctx = makeCtx({ storageDomain: storage, autoTasks: tasks.autoTasks })
  try {
    const service = apply(ctx, { apiUrl: api.url, serviceToken: 'svc', enabled: false })
    assert.equal(ctx.bridgeEvents, service)
    const seen = []
    service.subscribe(['approval.requested', 'approval.decided', 'approval.expired'], async (e) => { seen.push(e.id) })
    await service.ready
    const result = await service.pollNow()
    assert.equal(result.fetched, 4)
    assert.deepEqual(seen, [1, 3])
    assert.deepEqual(tasks.emitted.map((e) => [e.type, e.dedupeKey]), [['proposal.reviewed', '2'], ['inspection.completed', '4']])
    assert.deepEqual(tasks.emitted[0].payload.payload, { proposalId: 'p1', decision: 'accepted' })
    assert.equal(storage.units.get('bridge_events').global.cursor, 4)
    assert.equal(service.status().processed, 4)

    await service.pollNow()
    assert.equal(api.calls.at(-1).query.after, '4', 'next poll continues after the saved cursor')
    assert.equal(api.calls[0].query.after, undefined)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('restart resumes from the persisted cursor (no re-delivery of finished events)', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed'), ev(2, 'proposal.reviewed')])
  const storage = mockStorageDomain()
  try {
    const t1 = mockAutoTasks()
    const ctx1 = makeCtx({ storageDomain: storage, autoTasks: t1.autoTasks })
    await apply(ctx1, { apiUrl: api.url, serviceToken: 'svc', enabled: false }).pollNow()
    await ctx1.dispose()
    const t2 = mockAutoTasks()
    const ctx2 = makeCtx({ storageDomain: storage, autoTasks: t2.autoTasks })
    await apply(ctx2, { apiUrl: api.url, serviceToken: 'svc', enabled: false }).pollNow()
    assert.equal(t1.emitted.length, 2)
    assert.equal(t2.emitted.length, 0)
    assert.equal(api.calls.at(-1).query.after, '2')
    await ctx2.dispose()
  } finally {
    await api.close()
  }
})

test('handler failure stops the cursor before the failing event; retry delivers it again (at-least-once)', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed'), ev(2, 'proposal.reviewed'), ev(3, 'proposal.reviewed')])
  try {
    const delivered = []
    let failOnce = true
    const { pump, store } = pumpFor(api, {
      dispatch: async (e) => {
        if (e.id === 2 && failOnce) { failOnce = false; throw new Error('IM down') }
        delivered.push(e.id)
      },
    })
    await assert.rejects(() => pump.cycle(), /event 2 \(proposal.reviewed\) failed \[1\/3\]: IM down/)
    assert.equal(store.get().cursor, 1)
    assert.match(store.get().lastError, /IM down/)
    assert.equal(pump.status().consecutiveFailures, 1)
    await pump.cycle()
    assert.deepEqual(delivered, [1, 2, 3])
    assert.equal(store.get().cursor, 3)
    assert.equal(pump.status().consecutiveFailures, 0)
  } finally {
    await api.close()
  }
})

test('a poison event is dead-lettered after maxAttempts and the cursor moves on', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed'), ev(2, 'proposal.reviewed')])
  try {
    const delivered = []
    const { pump, store } = pumpFor(api, {
      maxAttempts: 2,
      dispatch: async (e) => {
        if (e.id === 1) throw new Error('bad payload')
        delivered.push(e.id)
      },
    })
    await assert.rejects(() => pump.cycle())
    await pump.cycle()
    assert.deepEqual(delivered, [2])
    assert.equal(store.get().cursor, 2)
    assert.equal(store.get().skipped, 1)
    assert.deepEqual(store.get().deadLetters.map((d) => [d.id, d.type]), [['1', 'proposal.reviewed']])
  } finally {
    await api.close()
  }
})

test('missing autoTasks: logged and skipped, cursor advances; approval events without a subscriber are retried', async () => {
  const dispatcher = createDispatcher({ getAutoTasks: () => null, logger: silentLogger() })
  await dispatcher.dispatch(ev(1, 'proposal.reviewed'))
  assert.equal(dispatcher.stats().skippedNoAutoTasks, 1)
  await assert.rejects(() => dispatcher.dispatch(ev(2, 'approval.requested')), /no subscriber for approval.requested yet \(is bridge-approvals loaded\?\)/)
  const got = []
  const off = dispatcher.subscribe(['approval.requested'], async (e) => got.push(e.id))
  await dispatcher.dispatch(ev(2, 'approval.requested'))
  off()
  assert.deepEqual(got, [2])
})

test('large backlogs are drained in batches', async () => {
  const events = Array.from({ length: 5 }, (_, i) => ev(i + 1, 'proposal.reviewed'))
  const api = await eventsApi(events)
  try {
    const seen = []
    const { pump } = pumpFor(api, { batchSize: 2, dispatch: async (e) => seen.push(e.id) })
    assert.deepEqual(await pump.cycle(), { fetched: 2, more: true })
    await pump.cycle()
    assert.deepEqual(await pump.cycle(), { fetched: 1, more: false })
    assert.deepEqual(seen, [1, 2, 3, 4, 5])
  } finally {
    await api.close()
  }
})

test('poll failures back off exponentially up to the cap', async () => {
  const delays = []
  let pending = null
  let value = null
  const pump = createEventPump({
    api: { get: async () => { throw new Error('ECONNREFUSED') } },
    store: { get: () => value, set: async (v) => { value = v } },
    dispatch: async () => {},
    logger: silentLogger(),
    intervalMs: () => 1000,
    maxBackoffMs: () => 8000,
    setTimer: (fn, ms) => { delays.push(ms); pending = fn; return 1 },
    clearTimer: () => {},
  })
  pump.start(0)
  for (let i = 0; i < 6; i += 1) await pending()
  await pump.stop()
  const backoffs = delays.slice(1)
  const caps = [1000, 2000, 4000, 8000, 8000, 8000]
  backoffs.forEach((ms, i) => {
    assert.ok(ms >= caps[i] / 2 && ms <= caps[i], `attempt ${i + 1}: ${ms} within [${caps[i] / 2}, ${caps[i]}]`)
  })
  assert.match(pump.status().lastError, /ECONNREFUSED/)
  assert.equal(pump.status().consecutiveFailures, 6)
})

test('apply() without storage keeps the cursor in memory and reports it', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed')])
  const ctx = makeCtx({})
  try {
    const service = apply(ctx, { apiUrl: api.url, serviceToken: 'svc', enabled: false })
    await service.pollNow()
    const status = service.status()
    assert.equal(status.persistent, false)
    assert.equal(status.cursor, 1)
    assert.equal(status.autoTasksAvailable, false)
    assert.equal(status.dispatch.skippedNoAutoTasks, 1)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('the timer loop polls on its own when enabled', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed')])
  const tasks = mockAutoTasks()
  const ctx = makeCtx({ storageDomain: mockStorageDomain(), autoTasks: tasks.autoTasks })
  try {
    apply(ctx, { apiUrl: api.url, serviceToken: 'svc', pollIntervalSeconds: 1, startDelayMs: 0 })
    const start = Date.now()
    while (tasks.emitted.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10))
    assert.equal(tasks.emitted.length, 1)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('sns_identity.unlinked goes to its subscriber (bridge-identity), never to autoTasks; retried until subscribed', async () => {
  const tasks = mockAutoTasks()
  const dispatcher = createDispatcher({ getAutoTasks: () => tasks.autoTasks, logger: silentLogger() })
  const event = ev(5, 'sns_identity.unlinked', { identityId: 'sid-1', userId: 'e42', platform: 'slack' })
  await assert.rejects(() => dispatcher.dispatch(event), /no subscriber for sns_identity.unlinked yet \(is bridge-identity loaded\?\)/)
  const got = []
  dispatcher.subscribe(['sns_identity.unlinked'], async (e) => got.push(e.payload))
  await dispatcher.dispatch(event)
  assert.deepEqual(got, [{ identityId: 'sid-1', userId: 'e42', platform: 'slack' }])
  assert.equal(tasks.emitted.length, 0)
})

test('configured notification events go to the notifier AND autoTasks; without a notifier they are retried during the grace period only', async () => {
  let clock = 1_000_000
  const tasks = mockAutoTasks()
  const dispatcher = createDispatcher({
    getAutoTasks: () => tasks.autoTasks, logger: silentLogger(), notifyGraceMs: () => 60_000, now: () => clock,
    notifyTypes: () => ['repair.requested', 'equipment.failure_reported', 'inspection.overdue'],
  })
  const requested = ev(7, 'repair.requested', { repairRequestId: 'r1' })
  await assert.rejects(() => dispatcher.dispatch(requested), /no subscriber for repair.requested yet \(is bridge-notify loaded\?\)/)
  assert.equal(tasks.emitted.length, 0, 'nothing forwarded while waiting for the notifier')

  const got = []
  const off = dispatcher.subscribe(['repair.requested', 'equipment.failure_reported'], async (e) => got.push(e.id))
  await dispatcher.dispatch(requested)
  await dispatcher.dispatch(ev(8, 'equipment.failure_reported', { equipmentId: 'eq-1' }))
  assert.deepEqual(got, [7, 8])
  assert.deepEqual(tasks.emitted.map((e) => [e.type, e.dedupeKey]), [['repair.requested', '7'], ['equipment.failure_reported', '8']])
  assert.equal(dispatcher.stats().notified, 2)
  off()

  clock += 60_001 // the notifier is not part of this profile: stop waiting, keep the event stream moving
  await dispatcher.dispatch(ev(9, 'inspection.overdue', { equipmentId: 'eq-2' }))
  assert.equal(tasks.emitted.at(-1).type, 'inspection.overdue')
  assert.equal(dispatcher.stats().notifySkippedNoSubscriber, 1)
  // a type that is neither configured nor declared is just forwarded (no waiting)
  await dispatcher.dispatch(ev(10, 'proposal.reviewed'))
  assert.equal(tasks.emitted.at(-1).type, 'proposal.reviewed')
})

test('stateDomain: the cursor lives in the named domain (keeps the state of a deployment that used another name)', async () => {
  const api = await eventsApi([ev(1, 'proposal.reviewed'), ev(2, 'proposal.reviewed')])
  const storage = mockStorageDomain()
  try {
    // a deployment that ran under another domain name: its cursor is already at 1
    storage.units.set('legacy_events', { tables: new Map(), global: { cursor: 1, processed: 1, skipped: 0, deadLetters: [], lastSuccessAt: null, lastError: null, lastErrorAt: null } })
    const tasks = mockAutoTasks()
    const ctx = makeCtx({ storageDomain: storage, autoTasks: tasks.autoTasks })
    await apply(ctx, { apiUrl: api.url, serviceToken: 'svc', enabled: false, stateDomain: 'legacy_events' }).pollNow()
    assert.equal(api.calls.at(-1).query.after, '1', 'continues after the cursor of the named domain')
    assert.deepEqual(tasks.emitted.map((e) => e.dedupeKey), ['2'])
    assert.equal(storage.units.get('legacy_events').global.cursor, 2)
    assert.equal(storage.units.has('bridge_events'), false, 'the default domain is not opened')
    await ctx.dispose()
  } finally {
    await api.close()
  }
})
