import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi } from '@dsh-bridge/dsh-core'
import { buildPrompt, cleanContext, contextIdsOf, createAssistantService, ownsOpenTurn, roleLabelsOf } from '../src/service.js'
import { apply, createRpcHandler, RPC_PATH } from '../src/index.js'
import { mockHarness, startFakeApi } from './helpers.mjs'

// bridge-assistant：職員の特定は業務システムのチケット照会だけ、職員 × AI 社員ごとの会話、
// 委託はその会話で本人が送ったターンの間だけ、文脈は画面名と UUID だけ（ID の種類は manifest の entities と設定）。データは架空。

const T_ALICE = `tkt_${'a'.repeat(43)}`
const T_BOB = `tkt_${'b'.repeat(43)}`
const EQUIPMENT = '11111111-1111-4111-8111-111111111111'
const USERS = { [T_ALICE]: { id: 'u-alice-0000-0000', role: 'inspector', displayName: 'Alice' }, [T_BOB]: { id: 'u-bob-00000-0000', role: 'manager', displayName: 'Bob' } }
const MANIFEST = { entities: { equipment: { label: '設備・備品' }, repair_request: { label: '修理依頼' } }, roles: { inspector: { label: '点検員' }, manager: { label: '設備責任者' } } }

async function fakeApi({ expiresInMs = 300_000, revoked = new Set() } = {}) {
  let n = 0
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { error: 'invalid_service_token' } }
    if (req.path === '/bridge/v1/assistant/delegations' && req.method === 'POST') {
      const user = USERS[req.body?.ticket]
      if (!user || revoked.has(req.body.ticket)) return { status: 401, body: { error: 'invalid_assistant_ticket' } }
      n += 1
      return { status: 201, body: { token: `dlg-${user.id}-${n}`, user, expiresAt: new Date(Date.now() + expiresInMs).toISOString() } }
    }
    return { status: 404, body: { error: 'not_found' } }
  })
}

function setup(api, opts = {}) {
  const harness = mockHarness()
  const service = createAssistantService({
    api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc', label: 'test API' }),
    harness,
    logger: { warn() {}, info() {}, debug() {} },
    ...opts,
  })
  harness.onEvent((sessionId, event) => service.onSessionEvent(sessionId, event))
  return { harness, service }
}

const exec = (harness, sessionId) => ({ agent: { session: harness.liveSession(sessionId) } })

test('context: page name + label + UUIDs only (id kinds from the manifest entities / config); prompt carries the role label and the context block', () => {
  const ids = contextIdsOf(MANIFEST, { workOrderId: '作業指示ID', 'bad key': 'x' })
  assert.deepEqual(ids, { approvalId: '承認ID', proposalId: '提案ID', employeeId: '社員ID', equipmentId: '設備・備品ID', repairRequestId: '修理依頼ID', workOrderId: '作業指示ID' })
  assert.deepEqual(roleLabelsOf(MANIFEST, { manager: '責任者' }), { inspector: '点検員', manager: '責任者' })
  assert.deepEqual(cleanContext({ page: 'equipment/detail', label: '設備詳細', ids: { equipmentId: EQUIPMENT.toUpperCase() } }, { ids }),
    { page: 'equipment/detail', label: '設備詳細', ids: { equipmentId: EQUIPMENT } })
  assert.equal(cleanContext(null), null)
  assert.throws(() => cleanContext({ page: 'x', ids: { equipmentId: EQUIPMENT } }), (e) => e.code === 'bad-request', 'not an id kind of this application')
  for (const bad of [
    { page: 'a b' }, { page: 'x', ids: { equipmentId: '消火器' } }, { page: 'x', ids: { name: EQUIPMENT } }, { page: 'x', label: 'a\nb' },
    { page: 'x', label: 'x'.repeat(41) }, { page: 'x', extra: 1 }, { page: 'x', ids: Object.fromEntries(Object.keys(ids).map((k) => [k, EQUIPMENT])) },
  ]) assert.throws(() => cleanContext(bad, { ids }), (e) => e.code === 'bad-request', JSON.stringify(bad))
  const prompt = buildPrompt('この設備の次回点検日は？', { role: 'inspector', roleLabels: roleLabelsOf(MANIFEST), idLabels: ids, context: { page: 'equipment/detail', label: '設備詳細', ids: { equipmentId: EQUIPMENT } } })
  assert.match(prompt, /^この設備の次回点検日は？\n\n---\n\[業務画面の AI アシスタントから\]/)
  assert.match(prompt, /質問者の役割: 点検員/)
  assert.match(prompt, new RegExp(`設備・備品ID: ${EQUIPMENT}`))
  assert.match(buildPrompt('q', { role: 'unknown-role' }), /質問者の役割: unknown-role/)
})

test('rpc: the employee comes only from the business API (ticket); payload userId and unknown methods are refused', async () => {
  const api = await fakeApi()
  try {
    const { service } = setup(api)
    const r = await service.handleRpc('agents.list', { ticket: T_ALICE })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.value.user, { id: USERS[T_ALICE].id, displayName: 'Alice' })
    assert.equal(r.value.agents[0].id, 'assistant')
    assert.equal(JSON.stringify(r.value).includes('preset'), false)
    const [call] = api.callsTo('/bridge/v1/assistant/delegations')
    assert.deepEqual(call.body, { ticket: T_ALICE })
    assert.equal(call.headers['x-service-token'], 'svc')

    assert.deepEqual((await service.handleRpc('agents.list', { ticket: T_ALICE, userId: USERS[T_BOB].id })).error.code, 'bad-request')
    assert.equal((await service.handleRpc('agents.list', { ticket: 'tkt_forged-forged-forged-forged-forged' })).error.code, 'ticket-invalid')
    assert.equal((await service.handleRpc('agents.list', {})).error.code, 'ticket-invalid')
    assert.equal((await service.handleRpc('session.create', { ticket: T_ALICE })).error.code, 'bad-request')
    assert.equal((await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'billing-bot' })).error.code, 'agent-unknown')
    // verification is cached per ticket while its delegation is valid
    await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })
    assert.equal(api.callsTo('/bridge/v1/assistant/delegations').filter((c) => c.body?.ticket === T_ALICE).length, 1)
  } finally {
    await api.close()
  }
})

test('send → one DSH session per employee × agent; reply collected from session events; busy while running', async () => {
  const api = await fakeApi()
  try {
    const { harness, service } = setup(api)
    const sent = await service.handleRpc('message.send', {
      ticket: T_ALICE, agent: 'assistant', text: '  今日の点検は？  ', context: { page: 'dashboard', label: 'ダッシュボード' },
    })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    assert.equal(sent.value.seq, 1)
    const [created] = harness.state.created
    assert.equal(created.agentPreset, 'bridge-assistant')
    assert.ok(!created.title.includes('Alice'), 'no names in the DSH session title')
    const [prompt] = harness.state.prompts
    assert.equal(prompt.sessionId, created.sessionId)
    assert.match(prompt.text, /^今日の点検は？\n/)
    assert.equal((await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: 'もう一つ' })).error.code, 'agent-busy')

    const turn = harness.startTurn(created.sessionId, prompt.requestId)
    harness.toolCall(created.sessionId, turn, 'facility_list_overdue')
    let conv = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })).value
    assert.equal(conv.running, true)
    assert.deepEqual(conv.activity, { tool: 'facility_list_overdue' })
    assert.deepEqual(conv.messages.map((m) => [m.role, m.text]), [['user', '今日の点検は？']], 'user text stored trimmed')
    assert.deepEqual(conv.messages[0].context, { page: 'dashboard', label: 'ダッシュボード' })
    harness.answer(created.sessionId, turn, '今日の点検は 3 件です。')
    harness.endTurn(created.sessionId, turn)
    conv = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant', after: 1 })).value
    assert.equal(conv.running, false)
    assert.deepEqual(conv.messages.map((m) => [m.seq, m.role, m.text]), [[2, 'assistant', '今日の点検は 3 件です。']])
    assert.equal(conv.lastSeq, 2)

    // Bob gets his own session and never sees Alice's conversation
    const bobView = (await service.handleRpc('conversation.get', { ticket: T_BOB, agent: 'assistant' })).value
    assert.deepEqual(bobView.messages, [])
    await service.handleRpc('message.send', { ticket: T_BOB, agent: 'assistant', text: '承認待ちは？' })
    assert.equal(harness.state.created.length, 2)
    assert.notEqual(harness.state.created[1].sessionId, created.sessionId)
    // the second message of Alice reuses her session
    await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: 'ありがとう' })
    assert.equal(harness.state.prompts.at(-1).sessionId, created.sessionId)
  } finally {
    await api.close()
  }
})

test('delegation: only during the employee’s own turn in their assistant session; never for outside turns', async () => {
  const api = await fakeApi()
  try {
    const { harness, service } = setup(api)
    assert.equal(await service.delegationForSession('im-session', {}), null, 'not an assistant session → bridge-tools keeps its IM rules')
    await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: '点検の抜けは？' })
    const { sessionId, } = harness.state.created[0]
    const { requestId } = harness.state.prompts[0]
    assert.equal(service.isAssistantSession(sessionId), true)
    await assert.rejects(service.delegationForSession(sessionId, exec(harness, sessionId)), /not sent by the employee/, 'before the turn starts')

    const turn = harness.startTurn(sessionId, requestId)
    const d = await service.delegationForSession(sessionId, exec(harness, sessionId))
    assert.equal(d.userId, USERS[T_ALICE].id)
    assert.match(d.token, /^dlg-u-alice/)
    // tracked state also works when the live session is not available
    assert.equal((await service.delegationForSession(sessionId, {})).userId, USERS[T_ALICE].id)
    harness.answer(sessionId, turn, '抜けはありません。')
    harness.endTurn(sessionId, turn)
    await assert.rejects(service.delegationForSession(sessionId, exec(harness, sessionId)), /no active request/)

    // the DSH owner types into the same session (no assistant request id) while a new assistant request is pending
    await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: '次の質問' })
    const outside = harness.startTurn(sessionId, null)
    await assert.rejects(service.delegationForSession(sessionId, exec(harness, sessionId)), /not sent by the employee/)
    await assert.rejects(service.delegationForSession(sessionId, {}), /not sent by the employee/)
    harness.endTurn(sessionId, outside)
    assert.equal(ownsOpenTurn(harness.liveSession(sessionId), harness.state.prompts.at(-1).requestId), false)
    assert.equal(ownsOpenTurn(undefined, 'x'), null)
  } finally {
    await api.close()
  }
})

test('delegation: an expired / logged-out ticket stops the tools with guidance; invalidate forces a re-check', async () => {
  const revoked = new Set()
  const api = await fakeApi({ expiresInMs: 31_000, revoked })
  try {
    let clock = Date.now()
    const { harness, service } = setup(api, { now: () => clock })
    await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: '質問' })
    const { sessionId } = harness.state.created[0]
    harness.startTurn(sessionId, harness.state.prompts[0].requestId)
    await service.delegationForSession(sessionId, exec(harness, sessionId))
    const before = api.callsTo('/bridge/v1/assistant/delegations').length
    service.invalidate(sessionId)
    await service.delegationForSession(sessionId, exec(harness, sessionId))
    assert.equal(api.callsTo('/bridge/v1/assistant/delegations').length, before + 1, 'invalidate drops the cached token')
    revoked.add(T_ALICE) // the employee logged out
    clock += 60_000
    await assert.rejects(service.delegationForSession(sessionId, exec(harness, sessionId)), /logged out or timed out/)
  } finally {
    await api.close()
  }
})

test('validation, cancel, reset, rate limit, harness failure', async () => {
  const api = await fakeApi()
  try {
    const { harness, service } = setup(api, { limits: { sendsPerMinute: 3 } })
    const send = (text, extra = {}) => service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text, ...extra })
    assert.equal((await send('')).error.code, 'bad-request')
    assert.equal((await send('x'.repeat(4001))).error.code, 'text-too-long')
    assert.equal((await send('q', { context: { page: 'x', ids: { approvalId: 'not-a-uuid' } } })).error.code, 'bad-request')
    assert.equal(harness.state.prompts.length, 0)

    await send('1')
    assert.equal((await service.handleRpc('message.cancel', { ticket: T_ALICE, agent: 'assistant' })).value.cancelled, true)
    assert.deepEqual(harness.state.cancelled, ['sess-1'])
    let view = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })).value
    assert.equal(view.running, false)
    assert.equal(view.messages.at(-1).role, 'error')

    assert.equal((await service.handleRpc('conversation.reset', { ticket: T_ALICE, agent: 'assistant' })).value.reset, true)
    assert.equal(service.isAssistantSession('sess-1'), false)
    view = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })).value
    assert.deepEqual(view.messages, [])
    harness.state.failPrompt = true
    const failed = await send('2')
    assert.equal(failed.error.code, 'harness-unavailable')
    assert.equal(harness.state.created.length, 2, 'a new session after reset')
    view = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })).value
    assert.equal(view.running, false, 'a failed send does not leave the conversation busy')
    harness.state.failPrompt = false
    assert.equal((await send('3')).ok, true)
    harness.endTurn('sess-2', 999) // unrelated turn end is ignored
    assert.equal((await service.handleRpc('message.cancel', { ticket: T_ALICE, agent: 'assistant' })).ok, true)
    assert.equal((await send('4')).error.code, 'rate-limited')
  } finally {
    await api.close()
  }
})

test('failed turn: the employee sees an error, the partial preamble is not shown as an answer', async () => {
  const api = await fakeApi()
  try {
    const { harness, service } = setup(api)
    await service.handleRpc('message.send', { ticket: T_ALICE, agent: 'assistant', text: '質問' })
    const { sessionId } = harness.state.created[0]
    const turn = harness.startTurn(sessionId, harness.state.prompts[0].requestId)
    harness.answer(sessionId, turn, '確認します。')
    harness.toolCall(sessionId, turn, 'facility_list_equipment')
    harness.endTurn(sessionId, turn, { kind: 'error' })
    const view = (await service.handleRpc('conversation.get', { ticket: T_ALICE, agent: 'assistant' })).value
    assert.deepEqual(view.messages.map((m) => m.role), ['user', 'error'])
  } finally {
    await api.close()
  }
})

// ------------------------------------------------------------------ DSH wiring
function request(body, { host = '127.0.0.1:3180', origin = null, contentType = 'application/json', method = 'POST' } = {}) {
  const headers = new Headers({ host, 'content-type': contentType })
  if (origin) headers.set('origin', origin)
  return { method, headers, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) }
}

test('management RPC: envelope, loopback only (gateway), stable error results', async () => {
  const calls = []
  const handler = createRpcHandler({ handleRpc: async (m, p) => { calls.push([m, p]); return { ok: true, value: { echoed: m } } } })
  const ok = await handler(request({ type: 'client-request', rpcId: 'r1', method: 'bridge-assistant/assistant', payload: { method: 'agents.list', payload: { ticket: T_ALICE } } }))
  assert.deepEqual(await ok.json(), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { echoed: 'agents.list' } } })
  assert.equal((await handler(request({}, { host: 'app.example.test' }))).status, 403)
  assert.equal((await handler(request({}, { origin: 'https://app.example.test' }))).status, 403)
  assert.equal((await handler(request({}, { contentType: 'text/plain' }))).status, 415)
  assert.equal((await handler(request({}, { method: 'GET' }))).status, 405)
  const bad = await (await handler(request({ type: 'client-request', rpcId: 'r2', method: 'dsh-im/weixin', payload: { method: 'agents.list', payload: {} } }))).json()
  assert.equal(bad.result.ok, false)
  assert.equal(bad.result.error.code, 'bad-request')
  assert.deepEqual(bad.result.error.details, {})
  assert.equal(calls.length, 1)
  const trusted = createRpcHandler({ handleRpc: async () => ({ ok: true, value: {} }) }, { authority: () => 'trusted-host' })
  assert.equal((await trusted(request({ type: 'client-request', rpcId: 'r3', method: 'bridge-assistant/assistant', payload: { method: 'x', payload: {} } }, { host: 'app.example.test' }))).status, 200)
})

test('apply: registers the RPC route, follows session/event and provides ctx.bridgeAssistant', async () => {
  const api = await fakeApi()
  try {
    const registered = []
    let eventListener = null
    const invoked = []
    const ctx = {
      connection: { fetch: { register: (route) => { registered.push(route); return () => {} } }, createPeer: () => ({ dispose() {} }) },
      on: (name, fn, opts) => { if (name === 'session/event') { eventListener = fn; assert.equal(opts.global, true) } return () => {} },
      typertGateway: {
        async invoke(req) {
          invoked.push(req)
          if (req.namespace === 'workspace' && req.method === 'create') return { workspace: { workspaceId: 'ws-1' } }
          if (req.namespace === 'session' && req.method === 'create') return { sessionId: 'host-sess-1' }
          return {}
        },
        async stream() { return (async function* gen() { yield { type: 'baseline', value: { items: [] } } })() },
      },
    }
    const { publicService } = apply(ctx, { apiUrl: api.url, serviceToken: 'svc', workspace: 'C:/tmp/ws' })
    assert.equal(ctx.bridgeAssistant, publicService)
    assert.equal(registered[0].path, RPC_PATH)
    assert.deepEqual(registered[0].methods, ['POST'])
    const res = await registered[0].fetch(request({ type: 'client-request', rpcId: 'r', method: 'bridge-assistant/assistant',
      payload: { method: 'message.send', payload: { ticket: T_ALICE, agent: 'assistant', text: 'こんにちは' } } }))
    const body = await res.json()
    assert.equal(body.result.ok, true, JSON.stringify(body))
    const create = invoked.find((r) => r.namespace === 'session' && r.method === 'create')
    assert.deepEqual(create.args, { request: { workspaceId: 'ws-1', agentPreset: 'bridge-assistant' } })
    const prompt = invoked.find((r) => r.method === 'prompt')
    assert.equal(prompt.args.request.sessionId, 'host-sess-1')
    assert.equal(prompt.args.request.mode, 'queue')
    assert.equal(prompt.args.request.content[0].type, 'text')
    assert.equal(prompt.args.request.clientTimeZone, 'Asia/Tokyo')
    assert.ok(prompt.peer, 'owner peer')
    // host events reach the service
    const requestId = prompt.args.request.requestId
    eventListener({ id: 'host-sess-1' }, { type: 'turn/start', data: { turn: 1 } })
    eventListener({ id: 'host-sess-1' }, { type: 'user/message', data: { turn: 1, source: { rpcId: requestId } } })
    const d = await publicService.delegationForSession('host-sess-1', {})
    assert.equal(d.userId, USERS[T_ALICE].id)
  } finally {
    await api.close()
  }
})

test('deployment options: rpcName (route and envelope method), agents[].sessionTitle, errorCodes', async () => {
  const api = await fakeApi()
  try {
    const registered = []
    const invoked = []
    const ctx = {
      connection: { fetch: { register: (route) => { registered.push(route); return () => {} } }, createPeer: () => ({ dispose() {} }) },
      on: () => () => {},
      typertGateway: {
        async invoke(req) {
          invoked.push(req)
          if (req.namespace === 'workspace' && req.method === 'create') return { workspace: { workspaceId: 'ws-1' } }
          if (req.namespace === 'session' && req.method === 'create') return { sessionId: 'host-sess-1' }
          return {}
        },
        async stream() { return (async function* gen() { yield { type: 'baseline', value: { items: [] } } })() },
      },
    }
    apply(ctx, {
      apiUrl: api.url, serviceToken: 'svc', workspace: 'C:/tmp/ws', rpcName: 'legacy-assistant',
      agents: [{ id: 'assistant', preset: 'bridge-assistant', name: 'AI アシスタント', sessionTitle: 'アシスタント（職員 {user}）' }],
      errorCodes: { 'ticket-invalid': 'legacy-ticket-invalid' },
    })
    assert.equal(registered[0].path, '/api/legacy-assistant/assistant')
    const call = (method, payload, envelope = 'legacy-assistant/assistant') => registered[0].fetch(request({ type: 'client-request', rpcId: 'r', method: envelope, payload: { method, payload } })).then((r) => r.json())
    assert.equal((await call('agents.list', { ticket: T_ALICE }, RPC_PATH.slice(5))).result.error.code, 'bad-request', 'the default envelope method is not accepted')
    assert.equal((await call('agents.list', { ticket: `tkt_${'z'.repeat(43)}` })).result.error.code, 'legacy-ticket-invalid', 'renamed error code')
    const sent = await call('message.send', { ticket: T_ALICE, agent: 'assistant', text: 'こんにちは' })
    assert.equal(sent.result.ok, true, JSON.stringify(sent))
    const rename = invoked.find((r) => r.namespace === 'session' && r.method === 'rename')
    assert.equal(rename.args.request.title, `アシスタント（職員 ${USERS[T_ALICE].id.slice(0, 8)}）`)
    assert.throws(() => apply({ ...ctx }, { rpcName: 'Bad Name' }), /invalid rpcName/)
  } finally {
    await api.close()
  }
})
