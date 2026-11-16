// 自動タスクの委託の分類（playbook の delegation → タスクの source.delegation）：bridge-tools の設定 unattendedDelegates
// （install.mjs --auto-task-delegate <class>=<platform>:<userId>,<class>=each）と ctx.autoTasks.activeRun（いま動いている回）。
//  - <class>：その分類の職員の委託（無ければ unattendedOnBehalfOf）
//  - <class>=each：その回の起動事件の本人に業務システムが発行する委託（{ event: { id } }）。設定で 'each' と書いた分類だけ
//  - 提案は従来どおり、その会話のタスクの source.tools に挙がったものだけ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { equipmentApi, exec, identityFor, load, registryFor } from './env.mjs'

const auto = exec('auto-1')
const PLAN = { platform: 'line', userId: 'U200' }

/** 事件ごとの委託：事件 41 は点検員 A、42 は点検員 B。refused の事件は 403。 */
const eventDelegations = (refused = new Set()) => (req) => {
  if (req.path !== '/bridge/v1/delegations' || !req.body?.event) return null
  const id = req.body.event.id
  if (refused.has(id)) return { status: 403, body: { error: 'event_delegation_refused' } }
  const user = { 41: 'inspector-a', 42: 'inspector-b' }[id]
  if (!user) return { status: 404, body: { error: 'event_not_found' } }
  return { status: 201, body: { ok: true, token: `dlg-ev-${id}`, user: { id: user, role: 'inspector' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
}

async function setup({ tasks, run = { current: null }, config = {}, entry = {}, refused } = {}) {
  const api = await equipmentApi({ extra: eventDelegations(refused) })
  const autoTasks = {
    list: async ({ sessionId } = {}) => tasks.filter((t) => t.sessionId === sessionId),
    activeRun: (sessionId) => (run.current?.sessionId === sessionId ? run.current : undefined),
  }
  const env = await load({ registry: registryFor(api, entry), identity: identityFor({}), autoTasks, config })
  return { api, run, ...env }
}
const task = (id, delegation, tools = ['facility_list_overdue', 'facility_propose_reschedule']) => ({
  id, sessionId: 'auto-1', enabled: true, applicationId: 'equipment-inspection', source: { kind: 'playbook', tools, ...(delegation ? { delegation } : {}) },
})
const runOf = (taskId, eventId, delegation) => ({ runId: `run-${eventId}`, taskId, sessionId: 'auto-1', eventId: String(eventId), eventType: 'inspection.overdue', applicationId: 'equipment-inspection', delegation })

test('unattendedDelegates: the delegate of the run\'s class (plugin config), else unattendedOnBehalfOf', async () => {
  const run = { current: runOf('pb_plan', 7, 'planning') }
  const env = await setup({
    tasks: [task('pb_plan', 'planning'), task('pb_other', 'other')],
    run,
    config: { unattendedPolicy: 'delegate', unattendedOnBehalfOf: { platform: 'feishu', userId: 'U100' }, unattendedDelegates: { planning: PLAN } },
  })
  try {
    assert.equal((await env.tools.get('facility_list_overdue').execute({}, auto)).ok, true)
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations').at(-1).body, { source: { platform: 'line', userId: 'U200' } })
    run.current = runOf('pb_other', 8, 'other')
    await env.tools.get('facility_list_overdue').execute({}, auto)
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations').at(-1).body, { source: { platform: 'feishu', userId: 'U100' } }, 'no delegate for the class: the default')
  } finally {
    await env.api.close()
  }
})

test('<class>=each: each run proposes under the delegation the business system issued for its own event; refused when not opted in', async () => {
  const run = { current: runOf('pb_each', 41, 'inspector=each') }
  const refused = new Set([43])
  const env = await setup({ tasks: [task('pb_each', 'inspector=each')], run, refused, config: { unattendedPolicy: 'delegate', unattendedDelegates: { inspector: 'each' } } })
  try {
    const ok = await env.tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-2', dueOn: '2026-11-05', reason: '部品待ち' }, auto)
    assert.equal(ok.proposal.id, 'p-inspection_reschedule')
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations').map((c) => c.body), [{ event: { id: 41 } }])
    assert.equal(env.api.callsTo('/bridge/v1/proposals', 'POST').at(-1).headers['x-delegation-token'], 'dlg-ev-41')
    run.current = runOf('pb_each', 42, 'inspector=each')
    await env.tools.get('facility_list_overdue').execute({}, auto)
    assert.equal(env.api.callsTo('/api/inspections/overdue').at(-1).headers['x-delegation-token'], 'dlg-ev-42')
    // a playbook's proposal limit still applies to per-person runs
    await assert.rejects(env.tools.get('facility_propose_repair')?.execute({ equipmentId: 'eq-2' }, auto) ?? Promise.reject(new Error('not registered: fine')), /not allowed in an automatic task|not registered/)
    run.current = runOf('pb_each', 43, 'inspector=each')
    await assert.rejects(env.tools.get('facility_list_overdue').execute({}, auto), /issues no delegation for the event that started this automatic task \(event_delegation_refused\)/)
    run.current = null
    await assert.rejects(env.tools.get('facility_list_overdue').execute({}, auto), /acts only during one of its triggered runs/)
  } finally {
    await env.api.close()
  }
  const off = await setup({ tasks: [task('pb_each', 'inspector=each')], run: { current: runOf('pb_each', 41, 'inspector=each') }, config: { unattendedPolicy: 'delegate', unattendedOnBehalfOf: { platform: 'feishu', userId: 'U100' } } })
  try {
    await assert.rejects(off.tools.get('facility_list_overdue').execute({}, auto), /per-person delegation of "inspector" is not enabled/)
    assert.equal(off.api.callsTo('/bridge/v1/delegations').length, 0)
  } finally {
    await off.api.close()
  }
})

test('the registry entry\'s delegation (bridge-apps) may carry unattendedDelegates too; applications.<id> overrides', async () => {
  const run = { current: runOf('pb_each', 41, 'inspector=each') }
  const env = await setup({
    tasks: [task('pb_each', 'inspector=each')],
    run,
    entry: { delegation: { unattendedPolicy: 'delegate', unattendedDelegates: { inspector: 'each' } } },
  })
  try {
    await env.tools.get('facility_list_overdue').execute({}, auto)
    assert.deepEqual(env.api.callsTo('/bridge/v1/delegations').at(-1).body, { event: { id: 41 } })
  } finally {
    await env.api.close()
  }
  const denied = await setup({
    tasks: [task('pb_each', 'inspector=each')],
    run: { current: runOf('pb_each', 41, 'inspector=each') },
    entry: { delegation: { unattendedPolicy: 'delegate', unattendedDelegates: { inspector: 'each' } } },
    config: { applications: { 'equipment-inspection': { unattendedPolicy: 'deny' } } },
  })
  try {
    await assert.rejects(denied.tools.get('facility_list_overdue').execute({}, auto), /no IM sender/)
  } finally {
    await denied.api.close()
  }
})
