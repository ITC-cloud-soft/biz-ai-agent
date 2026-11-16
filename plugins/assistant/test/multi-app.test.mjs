// 1 つの DSH に 2 つの業務アプリケーション（設備点検＋備品予約。架空）。アシスタントの会話は RPC の application（省略時は既定）に結び付き、
// チケットはそのアプリケーションの API でだけ交換する。tools-sdk の委託 gate は別のアプリケーションのツールに使わせない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APPLICATION_ID, createApplicationRegistry, createDelegationGate } from '@dsh-bridge/dsh-core'
import { createAssistantService } from '../src/service.js'
import { apply } from '../src/index.js'
import { mockHarness, startFakeApi } from './helpers.mjs'

const TICKET = `tkt_${'m'.repeat(43)}`
const BOOKING_PATHS = { assistantDelegations: '/api/bridge/assistant/delegations' }
const silent = { warn() {}, info() {}, debug() {} }

function ticketApi({ token, path, user }) {
  let n = 0
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== token) return { status: 401, body: { error: 'invalid_service_token' } }
    if (req.path === path && req.method === 'POST') {
      if (req.body?.ticket !== TICKET) return { status: 401, body: { error: 'invalid_assistant_ticket' } }
      n += 1
      return { status: 201, body: { token: `dlg-${token}-${n}`, user, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    }
    return { status: 404, body: { error: 'not_found' } }
  })
}

async function setup() {
  const eq = await ticketApi({ token: 'svc-eq', path: '/bridge/v1/assistant/delegations', user: { id: 'eq-user-0001', role: 'inspector' } })
  const booking = await ticketApi({ token: 'svc-booking', path: BOOKING_PATHS.assistantDelegations, user: { id: 'booking-user-0001', role: 'staff' } })
  const registry = createApplicationRegistry({
    logger: silent,
    applications: [
      { id: 'equipment-inspection', name: '設備点検', default: true, apiUrl: eq.url, serviceToken: 'svc-eq' },
      { id: 'facility-booking', name: '備品予約', apiUrl: booking.url, serviceToken: 'svc-booking', paths: BOOKING_PATHS },
    ],
  })
  const harness = mockHarness()
  const service = createAssistantService({
    registry,
    harness,
    logger: silent,
    agents: () => [
      { id: 'inspection-assistant', preset: 'facility-inspection', name: '点検アシスタント' },
      { id: 'booking-assistant', preset: 'facility-booking', name: '予約アシスタント', application: 'facility-booking' },
    ],
  })
  harness.onEvent((sessionId, event) => service.onSessionEvent(sessionId, event))
  return { eq, booking, registry, harness, service, close: async () => { await eq.close(); await booking.close() } }
}

test('the application of the RPC (default: the default application) exchanges the ticket and owns the conversation', async () => {
  const env = await setup()
  try {
    const eqList = await env.service.handleRpc('agents.list', { ticket: TICKET })
    assert.deepEqual(eqList.value.agents.map((a) => a.id), ['inspection-assistant'])
    const bookingList = await env.service.handleRpc('agents.list', { ticket: TICKET, application: 'facility-booking' })
    assert.deepEqual(bookingList.value.agents.map((a) => a.id), ['booking-assistant'])
    assert.equal(bookingList.value.user.id, 'booking-user-0001')
    assert.equal(env.booking.callsTo(BOOKING_PATHS.assistantDelegations).length, 1)
    assert.equal(env.eq.callsTo('/bridge/v1/assistant/delegations').length, 1)
    // agents of another application are not reachable; unknown applications are refused
    assert.equal((await env.service.handleRpc('conversation.get', { ticket: TICKET, agent: 'inspection-assistant', application: 'facility-booking' })).error.code, 'agent-unknown')
    assert.equal((await env.service.handleRpc('agents.list', { ticket: TICKET, application: 'nope' })).error.code, 'application-unknown')
    assert.equal((await env.service.handleRpc('agents.list', { ticket: TICKET, application: 'Bad App' })).error.code, 'application-unknown')

    const sent = await env.service.handleRpc('message.send', { ticket: TICKET, agent: 'booking-assistant', text: '明日の予約は？', application: 'facility-booking' })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    const bookingSession = env.harness.state.created[0].sessionId
    assert.equal(env.harness.state.created[0].agentPreset, 'facility-booking', 'agents[].preset of booking-assistant')
    assert.match(env.harness.state.created[0].title, /備品予約/)
    await env.service.handleRpc('message.send', { ticket: TICKET, agent: 'inspection-assistant', text: '期限切れの点検は？' })
    const eqSession = env.harness.state.created[1].sessionId
    assert.equal(env.service.applicationIdForSession(bookingSession), 'facility-booking')
    assert.equal(env.service.applicationIdForSession(eqSession), 'equipment-inspection')
    assert.equal(env.service.applicationIdForSession('not-an-assistant-session'), null)
    // bridge-memory（会話の振り返り）：パネルの会話の職員（読み取りだけ）
    assert.deepEqual(env.service.userForSession(bookingSession), { userId: 'booking-user-0001', applicationId: 'facility-booking', role: env.service.userForSession(bookingSession).role })
    assert.equal(env.service.userForSession('not-an-assistant-session'), null)

    // the delegation of the booking conversation is minted at the booking API only
    const turn = env.harness.startTurn(bookingSession, env.harness.state.prompts[0].requestId)
    const d = await env.service.delegationForSession(bookingSession, { agent: { session: env.harness.liveSession(bookingSession) } })
    assert.match(d.token, /^dlg-svc-booking-/)
    env.harness.endTurn(bookingSession, turn)
  } finally {
    await env.close()
  }
})

test('tools-sdk gate: an assistant conversation of the booking application cannot use the equipment tools (and vice versa)', async () => {
  const env = await setup()
  try {
    await env.service.handleRpc('message.send', { ticket: TICKET, agent: 'booking-assistant', text: 'x', application: 'facility-booking' })
    const bookingSession = env.harness.state.created[0].sessionId
    const turn = env.harness.startTurn(bookingSession, env.harness.state.prompts[0].requestId)
    const gateFor = (id) => createDelegationGate({
      application: () => env.registry.get(id),
      registry: () => env.registry,
      identity: () => null,
      assistant: () => env.service,
      requestJson: async () => { throw new Error('no mint expected') },
    })
    const exec = { agent: { session: env.harness.liveSession(bookingSession) } }
    await assert.rejects(() => gateFor('equipment-inspection').authorize('facility_list_overdue', exec), /belongs to application "facility-booking", not "equipment-inspection"/)
    const principal = await gateFor('facility-booking').authorize('booking_list_reservations', exec)
    assert.equal(principal.applicationId, 'facility-booking')
    assert.match(principal.delegationToken, /^dlg-svc-booking-/)
    env.harness.endTurn(bookingSession, turn)
  } finally {
    await env.close()
  }
})

test('apply(): ctx.bridgeAssistant exposes applicationIdForSession and the default application', async () => {
  const env = await setup()
  const ctx = { logger: () => silent, provide(n, v) { ctx[n] = v }, on() { return () => {} }, bridgeApps: null }
  try {
    const { publicService } = apply(ctx, { apiUrl: env.eq.url, serviceToken: 'svc-eq' })
    assert.equal(typeof publicService.applicationIdForSession, 'function')
    assert.equal(publicService.applicationId, DEFAULT_APPLICATION_ID)
    assert.equal(ctx.bridgeAssistant, publicService)
    assert.equal(publicService.applicationIdForSession('nope'), null)
    assert.equal(publicService.userForSession('nope'), null)
  } finally {
    await env.close()
  }
})
