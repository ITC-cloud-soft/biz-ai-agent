// N1b: グループ会話（1:1 でない IM 会話）のターンでは業務ツールを使わせない（既定 deny。発言者が連携済みでも、委託トークンも取らない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_CHAT_GUIDE } from '@dsh-bridge/dsh-core'
import { equipmentApi, exec, identityFor, linked, load, registryFor } from './env.mjs'

const groupOf = (userId) => linked(userId, { conversationId: 'C-team', conversationKind: 'group' })

test('group turn: read and propose tools are denied before any delegation; the 1:1 turn of the same sender works', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ g: groupOf('U100'), d: linked('U100') }) })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('g')),
      (error) => /facility_list_equipment: not allowed — .*group conversation/.test(error.message) && error.message.includes(GROUP_CHAT_GUIDE))
    await assert.rejects(() => tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05' }, exec('g')), /group conversation/)
    assert.equal(api.callsTo('/bridge/v1/delegations').length, 0, 'no delegation token for a group turn')
    assert.equal(api.callsTo('/api/equipment').length, 0)
    const ok = await tools.get('facility_list_equipment').execute({}, exec('d'))
    assert.equal(ok.data.equipment.length, 1)
  } finally {
    await api.close()
  }
})

test('group turn: unlinkedPolicy ai-readonly does not open group conversations either', async () => {
  const api = await equipmentApi()
  try {
    const unlinkedGroup = { source: { ...groupOf('U9').source }, linked: false }
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ g: unlinkedGroup }), config: { unlinkedPolicy: 'ai-readonly' } })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('g')), /group conversation/)
    assert.equal(api.callsTo('/api/equipment').length, 0)
  } finally {
    await api.close()
  }
})

test('group turn: groupChat allow (plugin, per application, registry) restores the per-sender delegation', async () => {
  for (const [label, registryEntry, config] of [
    ['plugin', {}, { groupChat: 'allow' }],
    ['applications.<id>', {}, { applications: { 'equipment-inspection': { groupChat: 'allow' } } }],
    ['registry', { groupChat: 'allow' }, {}],
  ]) {
    const api = await equipmentApi()
    try {
      const { tools } = await load({ registry: registryFor(api, registryEntry), identity: identityFor({ g: groupOf('U100') }), config })
      const ok = await tools.get('facility_list_equipment').execute({}, exec('g'))
      assert.equal(ok.data.equipment.length, 1, label)
      assert.equal(api.callsTo('/bridge/v1/delegations').length, 1, label)
    } finally {
      await api.close()
    }
  }
  // 明示の deny は registry の allow より優先（applications.<id> → registry → plugin の順）
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api, { groupChat: 'allow' }), identity: identityFor({ g: groupOf('U100') }),
      config: { applications: { 'equipment-inspection': { groupChat: 'deny' } } } })
    await assert.rejects(() => tools.get('facility_list_equipment').execute({}, exec('g')), /group conversation/)
  } finally {
    await api.close()
  }
})
