// 1 つの DSH に 2 つの業務アプリケーション（備品予約＋設備点検。架空）。イベントの取り込みはアプリケーションごと（カーソル・
// dead letter・dedupeKey）、配るイベントには取り込んだアプリケーションの applicationId が付く。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createApplicationRegistry, registryService } from '@dsh-bridge/dsh-core'
import { apply, createDispatcher } from '../src/index.js'
import { makeCtx, mockStorageDomain, startFakeApi, silentLogger } from './helpers.mjs'

const EQ_MANIFEST = fileURLToPath(new URL('./fixtures/equipment-inspection.manifest.yaml', import.meta.url))
const BOOKING_EVENTS = '/api/bridge/events'

function ev(id, type, payload = {}, extra = {}) {
  return { id, type, aggregateType: type.split('.')[0], aggregateId: `agg-${id}`, payload, at: '2026-10-27T00:00:00.000Z', ...extra }
}

function eventsApi({ token, path, events }) {
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== token) return { status: 401, body: { error: 'invalid_service_token' } }
    if (req.path !== path) return { status: 404, body: { error: 'not_found' } }
    const after = req.query.after === undefined ? 0 : Number(req.query.after)
    const page = events.filter((e) => e.id > after).slice(0, Number(req.query.limit ?? 100))
    return { body: { ok: true, events: page, nextAfter: page.length ? page.at(-1).id : after } }
  })
}

function autoTasksSpy() {
  const emitted = []
  const deployed = []
  return {
    emitted,
    deployed,
    autoTasks: {
      async emit(type, payload, dedupeKey, scope) { emitted.push({ type, payload, dedupeKey, scope }); return { triggered: [] } },
      list: async () => [],
      async deployPlaybooks(applicationId, playbooks, opts) { deployed.push({ applicationId, playbooks: Object.keys(playbooks), opts }); return { created: Object.keys(playbooks), updated: [], skipped: [] } },
    },
  }
}

async function setup({ bookingEvents, eqEvents, storage = mockStorageDomain(), config = {}, eqDefault = false }) {
  const booking = await eventsApi({ token: 'svc-booking', path: BOOKING_EVENTS, events: bookingEvents })
  const eq = await eventsApi({ token: 'svc-eq', path: '/bridge/v1/events', events: eqEvents })
  const registry = createApplicationRegistry({
    logger: silentLogger(),
    applications: [
      { id: 'facility-booking', name: '備品予約', default: !eqDefault, paths: { events: BOOKING_EVENTS }, apiUrl: booking.url, serviceToken: 'svc-booking',
        ...(eqDefault ? { bots: [{ platform: 'slack', botId: 'S9' }] } : {}) },
      { id: 'equipment-inspection', name: '設備点検', default: eqDefault, apiUrl: eq.url, serviceToken: 'svc-eq', manifestFile: EQ_MANIFEST,
        ...(eqDefault ? {} : { bots: [{ platform: 'wecom-app', botId: 'W2' }] }) },
    ],
  })
  await registry.ensureManifests()
  const tasks = autoTasksSpy()
  const ctx = makeCtx({ storageDomain: storage, autoTasks: tasks.autoTasks, bridgeApps: registryService(registry) })
  const service = apply(ctx, { apiUrl: 'http://127.0.0.1:1', serviceToken: 'wrong', enabled: false, ...config })
  return { booking, eq, registry, tasks, ctx, service, storage, close: async () => { await ctx.dispose(); await booking.close(); await eq.close() } }
}

test('one cursor per application; events are tagged with their application (body values are not trusted); dedupe keys do not collide', async () => {
  const env = await setup({
    bookingEvents: [ev(1, 'approval.requested', { approvalId: 'a1' }), ev(2, 'reservation.created', { reservationId: 'r1' })],
    eqEvents: [
      ev(1, 'approval.requested', { approvalId: 'r1' }, { applicationId: 'facility-booking' }), // claims another application: overwritten
      ev(2, 'proposal.reviewed', { proposalId: 'x1' }),
      ev(3, 'inspection.overdue', { equipmentId: 'e1', daysOverdue: 3 }),
    ],
  })
  try {
    const approvals = []
    env.service.subscribe(['approval.requested'], async (e) => { approvals.push([e.applicationId, e.payload.approvalId]) })
    const manifestNotified = []
    env.service.subscribeManifestNotify(async (e) => { manifestNotified.push([e.applicationId, e.type, e.id]) })
    const result = await env.service.pollAll()
    assert.deepEqual(result, { 'facility-booking': { fetched: 2, more: false }, 'equipment-inspection': { fetched: 3, more: false } })
    assert.deepEqual(approvals.sort(), [['equipment-inspection', 'r1'], ['facility-booking', 'a1']])
    // only the manifest's notified event goes to the manifest-notify subscriber
    assert.deepEqual(manifestNotified, [['equipment-inspection', 'inspection.overdue', 3]])
    assert.deepEqual(env.tasks.emitted.map((e) => [e.type, e.dedupeKey, e.scope]), [
      ['reservation.created', '2', { applicationId: 'facility-booking', eventId: '2', matchUnscoped: true }],
      ['proposal.reviewed', 'equipment-inspection:2', { applicationId: 'equipment-inspection', eventId: '2', matchUnscoped: false }],
      ['inspection.overdue', 'equipment-inspection:3', { applicationId: 'equipment-inspection', eventId: '3', matchUnscoped: false }],
    ])
    assert.equal(env.tasks.emitted.find((e) => e.type === 'reservation.created').payload.applicationId, 'facility-booking')
    // service tokens per application, each application's own events path
    assert.ok(env.booking.calls.every((c) => c.headers['x-service-token'] === 'svc-booking' && c.path === BOOKING_EVENTS))
    assert.ok(env.eq.calls.every((c) => c.headers['x-service-token'] === 'svc-eq'))
    // cursors: the default application at the top level, others under applications
    const global = env.storage.units.get('bridge_events').global
    assert.equal(global.cursor, 2)
    assert.equal(global.applications['equipment-inspection'].cursor, 3)
    assert.equal(env.service.status().cursor, 2)
    assert.equal(env.service.status().applications['equipment-inspection'].processed, 3)
    // the manifest playbooks are deployed as auto tasks (the booking application has no manifest)
    assert.deepEqual(env.tasks.deployed.map((d) => [d.applicationId, d.playbooks, d.opts.applicationName]),
      [['equipment-inspection', ['overdue_followup', 'daily_report'], '設備点検']])
  } finally {
    await env.close()
  }
})

test('manifest notify and playbook deployment of the default application follow manifestNotify / deployPlaybooks', async () => {
  const eqEvents = [ev(1, 'inspection.overdue', { equipmentId: 'e1' })]
  const all = await setup({ bookingEvents: [], eqEvents, eqDefault: true })
  try {
    const got = []
    all.service.subscribeManifestNotify(async (e) => got.push(e.type))
    await all.service.pollNow('equipment-inspection')
    assert.deepEqual(got, ['inspection.overdue'], 'manifestNotify all: the default application too')
    assert.deepEqual(all.tasks.deployed.map((d) => d.applicationId), ['equipment-inspection'])
  } finally {
    await all.close()
  }
  const others = await setup({ bookingEvents: [], eqEvents, eqDefault: true, config: { manifestNotify: 'others', deployPlaybooks: 'others', notifyGraceSeconds: 0 } })
  try {
    const got = []
    others.service.subscribeManifestNotify(async (e) => got.push(e.type))
    await others.service.pollNow('equipment-inspection')
    assert.deepEqual(got, [], 'others: the default application keeps its own list (notifyEvents)')
    assert.equal(others.tasks.deployed.length, 0)
    assert.equal(others.tasks.emitted[0].dedupeKey, '1')
  } finally {
    await others.close()
  }
})

test('restart resumes each application from its own cursor', async () => {
  const storage = mockStorageDomain()
  const bookingEvents = [ev(1, 'reservation.created'), ev(2, 'reservation.created')]
  const eqEvents = [ev(1, 'proposal.reviewed')]
  const first = await setup({ bookingEvents, eqEvents, storage })
  await first.service.pollAll()
  await first.close()
  eqEvents.push(ev(2, 'proposal.reviewed'))
  const second = await setup({ bookingEvents, eqEvents, storage })
  try {
    await second.service.pollAll()
    assert.deepEqual(second.tasks.emitted.map((e) => e.dedupeKey), ['equipment-inspection:2'])
    assert.equal(second.booking.calls.at(-1).query.after, '2')
    assert.equal(second.eq.calls.at(-1).query.after, '1')
    assert.equal(await second.service.pollNow('equipment-inspection').then((r) => r.fetched), 0)
    await assert.rejects(() => second.service.pollNow('nope'), /unknown application/)
  } finally {
    await second.close()
  }
})

test('a failing application does not stop the other one', async () => {
  const env = await setup({ bookingEvents: [ev(1, 'reservation.created')], eqEvents: [] })
  try {
    await env.eq.close() // the equipment API is down
    const result = await env.service.pollAll()
    assert.deepEqual(result['facility-booking'], { fetched: 1, more: false })
    assert.match(result['equipment-inspection'].error, /could not reach equipment-inspection API/)
    assert.equal(env.service.status().applications['equipment-inspection'].consecutiveFailures, 1)
  } finally {
    await env.ctx.dispose()
    await env.booking.close()
  }
})

test('a notifier subscribed by type AND by manifest notify (same handler) gets the event once', async () => {
  const env = await setup({ bookingEvents: [], eqEvents: [ev(1, 'inspection.overdue', { equipmentId: 'e1' })] })
  try {
    const got = []
    const handler = async (e) => { got.push(e.id) }
    env.service.subscribe(['inspection.overdue'], handler)
    env.service.subscribeManifestNotify(handler)
    await env.service.pollNow('equipment-inspection')
    assert.deepEqual(got, [1])
    assert.equal(env.service.status().dispatch.notified, 1)
  } finally {
    await env.close()
  }
})

test('dispatcher: events without applicationId keep the single-application behaviour (3-argument emit)', async () => {
  const emitted = []
  const dispatcher = createDispatcher({ getAutoTasks: () => ({ emit: async (...args) => { emitted.push(args) } }), logger: silentLogger() })
  await dispatcher.dispatch(ev(5, 'proposal.reviewed'))
  assert.equal(emitted[0].length, 3)
  assert.equal(emitted[0][2], '5')
})
