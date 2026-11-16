// 1 つの DSH に 2 つの業務アプリケーション（設備点検＋備品予約。架空）。ツールはアプリケーションごとの名前空間・API・委託トークンで動き、
// 別のアプリケーションのボットの会話からは使えない（委託トークンも取らない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSource } from './helpers.mjs'
import { equipmentApi, exec, load, registryFor } from './env.mjs'

const bookingTools = (kit) => [
  kit.defineTool({
    name: 'booking_list_reservations',
    description: 'Read-only: reservations of shared equipment.',
    async execute() {
      return { ok: true, data: await kit.requestJson('booking_list_reservations', '/api/reservations') }
    },
  }),
  kit.proposeTool({
    name: 'booking_propose_cancel',
    kind: 'reservation_cancel',
    description: 'propose cancelling one reservation.',
    parameters: { type: 'object', properties: { reservationId: { type: 'string' } }, required: ['reservationId'] },
  }),
]

async function setup({ config = {} } = {}) {
  const eq = await equipmentApi({ token: 'svc' })
  const booking = await equipmentApi({
    token: 'svc-booking', tag: 'booking',
    extra: (req) => (req.path === '/api/reservations' ? { body: { ok: true, reservations: [{ id: 'r1' }] } } : null),
  })
  const registry = registryFor(eq, {}, [
    { id: 'facility-booking', name: '備品予約', namespace: 'booking', apiUrl: booking.url, serviceToken: 'svc-booking', bots: [{ platform: 'slack', botId: 'S2' }] },
  ])
  const sessions = new Map()
  const unlinkListeners = []
  // bridge-identity と同じ形：会話 → {source, linked, applicationId}（アプリケーションはボットから）
  const identity = {
    forSession: async (sid) => {
      const source = sessions.get(sid)
      if (!source) return null
      return { source, linked: true, user: { id: 'x' }, applicationId: registry.resolveApplication(source)?.id ?? null }
    },
    invalidate() {},
    onUnlinked: (fn) => { unlinkListeners.push(fn); return () => {} },
  }
  const env = await load({ registry, identity, config })
  await env.service.register('facility-booking', bookingTools)
  return { eq, booking, sessions, unlinkListeners, ...env, close: async () => { await eq.close(); await booking.close() } }
}

test('each application gets its own tools, API, service token and delegation; the list says which', async () => {
  const env = await setup()
  try {
    assert.deepEqual(env.service.list().map((t) => [t.application, t.name, t.access, t.generated]).sort(), [
      ['equipment-inspection', 'facility_get_equipment', 'read', true],
      ['equipment-inspection', 'facility_health', 'open', true],
      ['equipment-inspection', 'facility_list_equipment', 'read', true],
      ['equipment-inspection', 'facility_list_overdue', 'read', true],
      ['equipment-inspection', 'facility_propose_reschedule', 'propose', false],
      ['facility-booking', 'booking_list_reservations', 'read', false],
      ['facility-booking', 'booking_propose_cancel', 'propose', false],
    ], 'the manifest tool of another namespace (booking_list_reservations in the equipment manifest) is not generated for equipment')
    env.sessions.set('s-eq', makeSource({ botId: 'B1', userId: 'U100' }))
    env.sessions.set('s-booking', makeSource({ botId: 'S2', userId: 'U100' }))
    await env.tools.get('facility_list_equipment').execute({}, exec('s-eq'))
    const res = await env.tools.get('booking_list_reservations').execute({}, exec('s-booking'))
    assert.deepEqual(res.data.reservations, [{ id: 'r1' }])
    assert.equal(env.eq.callsTo('/api/equipment')[0].headers['x-delegation-token'], 'dlg-eq-U100-1')
    assert.equal(env.booking.callsTo('/api/reservations')[0].headers['x-delegation-token'], 'dlg-booking-U100-1')
    assert.equal(env.booking.callsTo('/api/reservations')[0].headers['x-service-token'], 'svc-booking')
    assert.ok(env.eq.calls.every((c) => !String(c.headers['x-delegation-token'] ?? '').startsWith('dlg-booking')))
  } finally {
    await env.close()
  }
})

test('a conversation of the other application\'s bot cannot use the tools (no delegation is minted anywhere)', async () => {
  const env = await setup()
  try {
    env.sessions.set('s-booking', makeSource({ botId: 'S2', userId: 'U100' }))
    await assert.rejects(
      env.tools.get('facility_list_equipment').execute({}, exec('s-booking')),
      /facility_list_equipment: not allowed — this conversation belongs to application "facility-booking", not "equipment-inspection"/,
    )
    await assert.rejects(env.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-1', dueOn: '2026-11-05' }, exec('s-booking')), /facility-booking/)
    const business = (m) => m.calls.filter((c) => c.path !== '/bridge/v1/connectors/catalog') // the catalog is read with the service token only
    assert.equal(business(env.eq).length + business(env.booking).length, 0)
  } finally {
    await env.close()
  }
})

test('unlink notices carry the application: another application\'s unlink does not drop this one\'s tokens', async () => {
  const env = await setup()
  try {
    env.sessions.set('s-eq', makeSource({ botId: 'B1', userId: 'U100' }))
    await env.tools.get('facility_list_equipment').execute({}, exec('s-eq'))
    env.unlinkListeners[0]({ userId: 'emp-U100', platform: 'slack', applicationId: 'facility-booking' })
    await env.tools.get('facility_list_equipment').execute({}, exec('s-eq'))
    assert.equal(env.eq.callsTo('/bridge/v1/delegations').length, 1)
    env.unlinkListeners[0]({ userId: 'emp-U100', platform: 'slack', applicationId: 'equipment-inspection' })
    await env.tools.get('facility_list_equipment').execute({}, exec('s-eq'))
    assert.equal(env.eq.callsTo('/bridge/v1/delegations').length, 2)
  } finally {
    await env.close()
  }
})

test('config.only limits the applications; generate:false keeps only hand-written tools', async () => {
  const only = await setup({ config: { only: ['facility-booking'] } })
  try {
    assert.deepEqual(only.service.list().map((t) => t.name).sort(), ['booking_list_reservations', 'booking_propose_cancel'])
  } finally {
    await only.close()
  }
  const manual = await setup({ config: { generate: false } })
  try {
    assert.deepEqual(manual.service.list().filter((t) => t.application === 'equipment-inspection').map((t) => t.name), ['facility_propose_reschedule'])
  } finally {
    await manual.close()
  }
})
