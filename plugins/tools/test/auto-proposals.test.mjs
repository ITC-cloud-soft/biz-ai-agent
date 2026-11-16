// 自動タスク（IM 発信者のいない event / schedule のターン）の委託：設定した職員の委託で読み取りと、その会話のタスクの
// source.tools（playbook の tools）に挙がった提案だけを許す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unattendedAllowedTools } from '../src/index.js'
import { equipmentApi, exec, identityFor, load, registryFor } from './env.mjs'

const auto = exec('auto-1')
const task = (id, tools, over = {}) => ({ id, sessionId: 'auto-1', enabled: true, source: { kind: 'playbook', tools }, ...over })

/** 2 つ目の手書き提案ツール（修理依頼の起票の提案）。 */
const repairTool = (kit) => [kit.proposeTool({
  name: 'facility_propose_repair',
  kind: 'repair_request',
  description: 'propose a repair request for one piece of equipment.',
  parameters: { type: 'object', properties: { equipmentId: { type: 'string' } }, required: ['equipmentId'] },
})]

async function setup(tasks, { config = {}, entry = {} } = {}) {
  const api = await equipmentApi()
  const autoTasks = { list: async ({ sessionId } = {}) => tasks.filter((t) => t.sessionId === sessionId) }
  const env = await load({
    registry: registryFor(api, entry),
    identity: identityFor({}),
    autoTasks,
    config: { unattendedPolicy: 'delegate', unattendedOnBehalfOf: { platform: 'feishu', userId: 'U200' }, ...config },
  })
  await env.service.register('equipment-inspection', repairTool)
  return { api, ...env }
}

test('automatic tasks may only use the proposals their playbook lists (source.tools); reads are all allowed', async () => {
  const env = await setup([task('pb_overdue_followup', ['facility_list_overdue', 'facility_propose_reschedule'])])
  try {
    const read = await env.tools.get('facility_list_overdue').execute({}, auto)
    assert.equal(read.data.overdue.length, 1)
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations')[0].body, { source: { platform: 'feishu', userId: 'U200' } }, 'on behalf of the configured employee')
    const ok = await env.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05', reason: '部品の入荷待ち' }, auto)
    assert.equal(ok.proposal.id, 'p-inspection_reschedule')
    assert.equal(env.api.callsTo('/bridge/v1/proposals', 'POST').at(-1).headers['x-delegation-token'], 'dlg-eq-U200-1')
    await assert.rejects(env.tools.get('facility_propose_repair').execute({ equipmentId: 'eq-2' }, auto),
      /facility_propose_repair: not allowed in an automatic task — only facility_propose_reschedule may propose there/)
    assert.equal(env.api.callsTo('/bridge/v1/proposals').length, 1)
  } finally {
    await env.api.close()
  }
})

test('a task without source.tools gets the fallback (none by default; unattendedDefaultTools); disabled tasks and other applications do not count', async () => {
  const none = await setup([{ id: 'screen-made', sessionId: 'auto-1', enabled: true }])
  try {
    await assert.rejects(none.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05' }, auto), /only \(none\) may propose there/)
  } finally {
    await none.api.close()
  }
  const fallback = await setup([{ id: 'screen-made', sessionId: 'auto-1', enabled: true }], { config: { unattendedDefaultTools: ['facility_propose_repair'] } })
  try {
    assert.equal((await fallback.tools.get('facility_propose_repair').execute({ equipmentId: 'eq-2' }, auto)).ok, true)
  } finally {
    await fallback.api.close()
  }
  const upper = ['facility_propose_reschedule', 'facility_propose_repair']
  assert.deepEqual([...await unattendedAllowedTools({ list: async () => [task('a', ['facility_propose_repair'], { enabled: false }), { id: 'b', sessionId: 'auto-1', enabled: true }] }, 'auto-1', { upper })], [])
  assert.deepEqual([...await unattendedAllowedTools({ list: async () => [task('a', ['facility_propose_repair'], { applicationId: 'facility-booking' })] }, 'auto-1', { upper, applicationId: 'equipment-inspection' })], [])
  assert.deepEqual([...await unattendedAllowedTools(null, 'auto-1', { upper, fallback: ['facility_propose_repair'] })], ['facility_propose_repair'])
  // 上限（このアプリケーションの提案ツール）の外は playbook に書いても許さない
  assert.deepEqual([...await unattendedAllowedTools({ list: async () => [task('x', ['booking_propose_cancel', 'facility_list_overdue'])] }, 'auto-1', { upper })], [])
})

test('unattended delegation can come from the registry entry (delegation.unattendedPolicy); other sessions stay denied', async () => {
  const tasks = [{ sessionId: 'auto-1', enabled: true }, { sessionId: 'auto-other', enabled: true, applicationId: 'facility-booking' }]
  const env = await setup(tasks, {
    config: { unattendedPolicy: 'deny' },
    entry: { delegation: { unattendedPolicy: 'delegate', unattendedOnBehalfOf: { platform: 'line', userId: 'U100' } } },
  })
  try {
    assert.equal((await env.tools.get('facility_list_equipment').execute({}, auto)).ok, true)
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations')[0].body, { source: { platform: 'line', userId: 'U100' } })
    await assert.rejects(env.tools.get('facility_list_equipment').execute({}, exec('auto-other')), /no IM sender/)
    await assert.rejects(env.tools.get('facility_list_equipment').execute({}, exec('not-a-task')), /no IM sender/)
  } finally {
    await env.api.close()
  }
})

test('unattendedTools caps the proposals of automatic tasks (in its order); a propose tool outside it is refused even if the playbook lists it', async () => {
  const env = await setup([task('pb_overdue_followup', ['facility_propose_reschedule', 'facility_propose_repair'])], {
    config: { unattendedTools: ['facility_propose_repair', 'facility_propose_unknown'] },
  })
  try {
    assert.equal((await env.tools.get('facility_propose_repair').execute({ equipmentId: 'eq-2' }, auto)).ok, true)
    await assert.rejects(env.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05' }, auto),
      /facility_propose_reschedule: not allowed in an automatic task — only facility_propose_repair may propose there/)
  } finally {
    await env.api.close()
  }
})

test('an empty unattendedTools list means "not set" (DSH fills unset arrays with []): every propose tool of the application is the cap', async () => {
  const env = await setup([task('pb_overdue_followup', ['facility_propose_reschedule'])], { config: { unattendedTools: [], applications: { 'equipment-inspection': { unattendedTools: [] } } } })
  try {
    const ok = await env.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05' }, auto)
    assert.equal(ok.proposal.id, 'p-inspection_reschedule')
  } finally {
    await env.api.close()
  }
})
