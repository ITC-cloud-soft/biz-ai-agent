// 業務 Web の AI アシスタント（bridge-assistant）の会話：ツールは ctx.bridgeAssistant が出す本人の委託 token だけで動く。
// IM の発信者・未連携ポリシー・自動タスクの分岐には落ちない。アシスタントの会話のアプリケーションのツールだけ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSource } from './helpers.mjs'
import { equipmentApi, exec, identityFor, linked, load, registryFor } from './env.mjs'

function assistantMock({ sessions = ['as-1'], tokens = ['dlg-alice'], applicationId = 'equipment-inspection' } = {}) {
  const state = { calls: [], invalidated: [], deny: null, tokens: [...tokens] }
  return {
    state,
    isAssistantSession: (id) => sessions.includes(id),
    applicationIdForSession: (id) => (sessions.includes(id) ? applicationId : null),
    async delegationForSession(id, run) {
      state.calls.push({ id, exec: run })
      if (state.deny) throw new Error(state.deny)
      return { token: state.tokens.length > 1 ? state.tokens.shift() : state.tokens[0], userId: 'emp-alice', expiresAt: Date.now() + 60_000 }
    },
    invalidate: (id) => state.invalidated.push(id),
  }
}

const PROPOSE = { equipmentId: 'eq-2', dueOn: '2026-11-05' }

test('assistant session: the employee’s delegation token is used (read + propose); exec is passed for the live-turn check', async () => {
  const api = await equipmentApi()
  try {
    const assistant = assistantMock()
    const { tools } = await load({ registry: registryFor(api), assistant })
    const run = exec('as-1')
    await tools.get('facility_list_equipment').execute({}, run)
    await tools.get('facility_propose_reschedule').execute(PROPOSE, run)
    for (const call of [...api.callsTo('/api/equipment'), ...api.callsTo('/bridge/v1/proposals')]) {
      assert.equal(call.headers['x-service-token'], 'svc')
      assert.equal(call.headers['x-delegation-token'], 'dlg-alice')
    }
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 0, 'no IM delegation lookup for assistant sessions')
    assert.equal(assistant.state.calls[0].exec, run)
  } finally {
    await api.close()
  }
})

test('assistant session outside the employee’s turn: denied, even with ai-readonly or a linked IM identity', async () => {
  const api = await equipmentApi()
  try {
    const assistant = assistantMock()
    assistant.state.deny = 'this turn was not sent by the employee through the assistant panel'
    const identity = identityFor({ 'im-1': linked('U100'), 'as-1': linked('U100') })
    const { tools } = await load({ registry: registryFor(api), assistant, identity, config: { unlinkedPolicy: 'ai-readonly' } })
    await assert.rejects(tools.get('facility_list_equipment').execute({}, exec('as-1')), /facility_list_equipment: not allowed — this turn was not sent by the employee/)
    assert.equal(api.callsTo('/api/equipment').length, 0)
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 0)
    // other sessions keep the IM rules
    await tools.get('facility_list_equipment').execute({}, exec('im-1'))
    assert.equal(api.callsTo('/api/equipment').at(-1).headers['x-delegation-token'], 'dlg-eq-U100-1')
  } finally {
    await api.close()
  }
})

test('assistant session: a 401 from the business API drops the cached delegation once and retries', async () => {
  const api = await equipmentApi({
    extra: (req) => (req.path === '/api/equipment' && req.headers['x-delegation-token'] === 'dlg-expired' ? { status: 401, body: { error: 'invalid_delegation_token' } } : null),
  })
  try {
    const assistant = assistantMock({ tokens: ['dlg-expired', 'dlg-fresh'] })
    const { tools } = await load({ registry: registryFor(api), assistant })
    const result = await tools.get('facility_list_equipment').execute({}, exec('as-1'))
    assert.equal(result.ok, true)
    assert.deepEqual(assistant.state.invalidated, ['as-1'])
    assert.deepEqual(api.callsTo('/api/equipment').map((c) => c.headers['x-delegation-token']), ['dlg-expired', 'dlg-fresh'])
  } finally {
    await api.close()
  }
})

test('an assistant conversation of another application cannot use these tools', async () => {
  const api = await equipmentApi()
  try {
    const assistant = assistantMock({ applicationId: 'facility-booking' })
    const { tools } = await load({ registry: registryFor(api), assistant, identity: identityFor({ 'as-1': { source: makeSource(), linked: true } }) })
    await assert.rejects(tools.get('facility_list_equipment').execute({}, exec('as-1')),
      /this assistant conversation belongs to application "facility-booking", not "equipment-inspection"/)
    assert.equal(assistant.state.calls.length, 0)
  } finally {
    await api.close()
  }
})
