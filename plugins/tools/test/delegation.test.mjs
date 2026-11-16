// 委託 gate：各呼び出しは、そのターンの IM 発信者（連携済み職員）の委託トークンで行う（発信元ごとにキャッシュ・期限前に取り直し）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inject, name, sessionIdOf } from '../src/index.js'
import { makeSource, startFakeApi } from './helpers.mjs'
import { equipmentApi, exec, identityFor, linked, load, registryFor } from './env.mjs'

const PROPOSE = { equipmentId: 'eq-2', dueOn: '2026-11-05' }

test('metadata and the DSH tool run context', () => {
  assert.equal(name, 'bridge-tools')
  assert.deepEqual(inject, ['tools'])
  assert.equal(sessionIdOf({ agent: { session: { id: 's1' } } }), 's1')
  assert.equal(sessionIdOf({ agent: { session: { header: { id: 's2' } } } }), 's2')
  assert.equal(sessionIdOf(undefined), null)
})

test('linked sender: delegation token fetched once, cached, and sent with the service token', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    const list = tools.get('facility_list_equipment')
    const result = await list.execute({}, exec('s1'))
    await list.execute({ status: 'active' }, exec('s1'))
    assert.equal(JSON.stringify(result).includes('dlg-'), false, 'token never leaks into tool output')

    const delegations = api.callsTo('/bridge/v1/delegations')
    assert.equal(delegations.length, 1, 'cached within its validity')
    assert.deepEqual(delegations[0].body, { source: { platform: 'slack', teamId: 'T1', userId: 'U100' } })
    assert.equal(delegations[0].headers['x-delegation-token'], undefined)

    const business = api.callsTo('/api/equipment')
    assert.equal(business.length, 2)
    assert.deepEqual(business[1].query, { status: 'active' })
    for (const call of business) {
      assert.equal(call.headers['x-service-token'], 'svc')
      assert.equal(call.headers['x-delegation-token'], 'dlg-eq-U100-1')
    }
  } finally {
    await api.close()
  }
})

test('token close to expiry is refreshed', async () => {
  const api = await equipmentApi({ expiresInMs: 10_000 }) // < 30s margin
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    await tools.get('facility_list_equipment').execute({}, exec('s1'))
    await tools.get('facility_list_equipment').execute({}, exec('s1'))
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 2)
    const tokens = api.callsTo('/api/equipment').map((c) => c.headers['x-delegation-token'])
    assert.deepEqual(tokens, ['dlg-eq-U100-1', 'dlg-eq-U100-2'])
  } finally {
    await api.close()
  }
})

test('each turn uses its own sender (group chat: per-message identity)', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ a: linked('U100'), b: linked('U200') }) })
    await tools.get('facility_list_equipment').execute({}, exec('a'))
    await tools.get('facility_list_equipment').execute({}, exec('b'))
    const tokens = api.callsTo('/api/equipment').map((c) => c.headers['x-delegation-token'])
    assert.equal(tokens[0].startsWith('dlg-eq-U100'), true)
    assert.equal(tokens[1].startsWith('dlg-eq-U200'), true)
  } finally {
    await api.close()
  }
})

test('unlinked sender and owner session are denied by default (no business call)', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ unlinked: { source: makeSource({ userId: 'U9' }), linked: false } }) })
    await assert.rejects(
      () => tools.get('facility_list_equipment').execute({}, exec('unlinked')),
      /facility_list_equipment: not allowed — the sender of this conversation is not linked/,
    )
    await assert.rejects(
      () => tools.get('facility_list_equipment').execute({}, exec('owner-web')),
      /no IM sender.*linking an account does not enable this conversation/,
    )
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}), /not allowed/)
    assert.equal(api.callsTo('/api/equipment').length, 0)
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 0)
  } finally {
    await api.close()
  }
})

test('unlinkedPolicy ai-readonly: reads run as the ai principal, proposals stay denied', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({}), config: { unlinkedPolicy: 'ai-readonly' } })
    const result = await tools.get('facility_list_equipment').execute({}, exec('owner-web'))
    assert.equal(result.data.equipment.length, 1)
    const call = api.callsTo('/api/equipment')[0]
    assert.equal(call.headers['x-service-token'], 'svc')
    assert.equal(call.headers['x-delegation-token'], undefined)
    await assert.rejects(() => tools.get('facility_propose_reschedule').execute(PROPOSE, exec('owner-web')), /not allowed/)
    assert.equal(api.callsTo('/bridge/v1/proposals').length, 0)
  } finally {
    await api.close()
  }
})

test('linked sender may propose; the proposal carries the delegation token', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    const res = await tools.get('facility_propose_reschedule').execute(PROPOSE, exec('s1'))
    assert.deepEqual(res, { ok: true, proposal: { id: 'p-inspection_reschedule', kind: 'inspection_reschedule', status: 'pending_review' } })
    const call = api.callsTo('/bridge/v1/proposals')[0]
    assert.equal(call.headers['x-delegation-token'], 'dlg-eq-U100-1')
    assert.deepEqual(call.body, { kind: 'inspection_reschedule', payload: { equipmentId: 'eq-2', dueOn: '2026-11-05' } })
  } finally {
    await api.close()
  }
})

test('delegation 404 identity_not_linked invalidates the cached identity and denies', async () => {
  const api = await equipmentApi({ linkedUsers: new Set() })
  try {
    const identity = identityFor({ s1: linked('U100') })
    const { tools } = await load({ registry: registryFor(api), identity })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('s1')), /no longer linked/)
    assert.deepEqual(identity.invalidated, ['U100'])
    assert.equal(api.callsTo('/api/equipment').length, 0)
  } finally {
    await api.close()
  }
})

test('an open tool (health) needs no identity; a missing bridge-identity service means deny', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api) })
    assert.deepEqual((await tools.get('facility_health').execute({}, exec('x'))).data, { ok: true, protocol: 1, version: '1.0.0' })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('x')), /not allowed/)
  } finally {
    await api.close()
  }
})

test('identity lookup failure is a clear tool error', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: { forSession: async () => { throw new Error('business API down') } } })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('s1')), /could not verify the sender.*business API down/)
  } finally {
    await api.close()
  }
})

test('401 invalid_delegation_token → drop cached token, re-delegate once, retry', async () => {
  let n = 0
  const api = await startFakeApi((req) => {
    if (req.path === '/bridge/v1/delegations') {
      n += 1
      return { status: 201, body: { ok: true, token: `dt_${n}`, user: { id: 'emp-U100', role: 'inspector' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    }
    if (req.path === '/api/equipment') {
      if (req.headers['x-delegation-token'] === 'dt_1') return { status: 401, body: { ok: false, error: 'invalid_delegation_token' } }
      return { body: { ok: true, equipment: [] } }
    }
    return { status: 404, body: { error: 'not_found' } }
  })
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    assert.deepEqual(await tools.get('facility_list_equipment').execute({}, exec('s1')), { ok: true, data: { ok: true, equipment: [] } })
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 2)
    assert.deepEqual(api.callsTo('/api/equipment').map((c) => c.headers['x-delegation-token']), ['dt_1', 'dt_2'])
  } finally {
    await api.close()
  }
})

test('role-limited proposals: 403 delegation_not_permitted surfaces clearly (no retry)', async () => {
  const api = await startFakeApi((req) => {
    if (req.path === '/bridge/v1/delegations') return { status: 201, body: { ok: true, token: 'dt_a', user: { id: 'e5', role: 'viewer' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    if (req.path === '/bridge/v1/proposals') return { status: 403, body: { ok: false, error: 'delegation_not_permitted' } }
    return { status: 404 }
  })
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    await assert.rejects(() => tools.get('facility_propose_reschedule').execute(PROPOSE, exec('s1')), /HTTP 403 \(delegation_not_permitted\)/)
    assert.equal(api.callsTo('/bridge/v1/proposals').length, 1)
  } finally {
    await api.close()
  }
})

test('sns_identity.unlinked: bridge-identity notifies and the cached delegation token of that employee is dropped', async () => {
  const api = await equipmentApi()
  try {
    let current = linked('U100')
    const identity = identityFor(() => current)
    const { tools } = await load({ registry: registryFor(api), identity })
    const list = tools.get('facility_list_equipment')
    await list.execute({}, exec('s1'))
    await list.execute({}, exec('s1'))
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 1)
    assert.equal(identity.listeners.length, 1)

    // 他の職員・他のプラットフォームの解除では捨てない
    identity.listeners[0]({ userId: 'emp-U200', platform: 'slack' })
    identity.listeners[0]({ userId: 'emp-U100', platform: 'weixin' })
    await list.execute({}, exec('s1'))
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 1)

    // 本人の解除 → token を捨て、以後は bridge-identity の判定（未連携）で拒否
    identity.listeners[0]({ userId: 'emp-U100', platform: 'slack', sources: [] })
    current = { source: makeSource({ userId: 'U100' }), linked: false }
    await assert.rejects(() => list.execute({}, exec('s1')), /not linked/)
    // 再連携後は新しい token を取り直す（古い token を使い回さない）
    current = linked('U100')
    await list.execute({}, exec('s1'))
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 2)
    assert.equal(api.callsTo('/api/equipment').at(-1).headers['x-delegation-token'], 'dlg-eq-U100-2')
  } finally {
    await api.close()
  }
})

test('without bridge-apps: the plugin config is one application (v1 paths); hand-written tools come from register()', async () => {
  const api = await equipmentApi()
  try {
    const { tools, service } = await load({ identity: identityFor({ s1: linked('U100') }), config: { apiUrl: api.url, serviceToken: 'svc', namespace: 'facility' } })
    assert.equal(tools.size, 0, 'no manifest, and the example module targets equipment-inspection (not registered here)')
    const names = await service.register(null, (kit) => [kit.defineTool({
      name: 'facility_count_overdue',
      description: 'Read-only: number of overdue equipment.',
      async execute() {
        const body = await kit.requestJson('facility_count_overdue', '/api/inspections/overdue')
        return { ok: true, count: body.overdue.length }
      },
    })])
    assert.deepEqual(names, ['facility_count_overdue'])
    assert.deepEqual(await tools.get('facility_count_overdue').execute({}, exec('s1')), { ok: true, count: 1 })
    assert.equal(api.callsTo('/api/inspections/overdue')[0].headers['x-delegation-token'], 'dlg-eq-U100-1')
    await assert.rejects(service.register(null, () => [{ name: 'other_tool', description: 'x', execute: async () => ({}) }]).then((n) => {
      if (!n.length) throw new Error('outside the namespace: not registered')
    }), /not registered/)
  } finally {
    await api.close()
  }
})

test('toolKind / denyHints: the wording of a refusal is configurable (top level or applications.<id>)', async () => {
  const api = await equipmentApi()
  try {
    const identity = identityFor({ unlinked: { source: makeSource({ userId: 'U9' }), linked: false } })
    const top = await load({ registry: registryFor(api), identity, config: { toolKind: 'facility tools', denyHints: { linked: 'link in the facility web (設定).' } } })
    await assert.rejects(() => top.tools.get('facility_list_equipment').execute({}, exec('unlinked')),
      /not allowed — the sender of this conversation is not linked to an employee\. facility tools run only on behalf of a linked employee; link in the facility web \(設定\)\.$/)
    const perApp = await load({ registry: registryFor(api), identity, config: { applications: { 'equipment-inspection': { toolKind: 'inspection tools', denyHints: { noSender: 'ask from IM.' } } } } })
    await assert.rejects(() => perApp.tools.get('facility_list_equipment').execute({}, exec('owner-web')), /inspection tools run only on behalf of a linked employee; ask from IM\.$/)
    const byDefault = await load({ registry: registryFor(api), identity })
    await assert.rejects(() => byDefault.tools.get('facility_list_equipment').execute({}, exec('unlinked')), /設備点検 tools run only on behalf of a linked employee; the employee can link/)
  } finally {
    await api.close()
  }
})
