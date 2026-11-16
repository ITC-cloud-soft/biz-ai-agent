// manifest から生成する読み取りツール・手書きの提案ツールのヘルパー（defineProposeTool）・見本（設備点検）・定時報告の呼び出し元。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineProposeTool } from '../src/index.js'
import equipmentInspectionTools from '../src/examples/equipment-inspection.js'
import { equipmentApi, exec, identityFor, linked, load, registryFor } from './env.mjs'

const render = (tool, input, result) => tool.output.render(input, result).map((p) => p.text).join('\n')

test('generated read tools: GET only, declared arguments only, path parameters encoded, output truncated', async () => {
  const api = await equipmentApi({
    extra: (req) => (req.path === '/api/equipment' && req.query.status === 'all' ? { body: { ok: true, equipment: Array.from({ length: 400 }, (_, i) => ({ id: `eq-${i}`, code: 'FE-LONG-CODE' })) } } : null),
  })
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    const list = tools.get('facility_list_equipment')
    assert.match(list.description, /^Read-only: 設備・備品の一覧/)
    assert.match(list.description, /generated from the business manifest/)
    await assert.rejects(list.execute({ status: 'all', name: 'x' }, exec('s1')), /unknown argument\(s\): name/)
    await assert.rejects(list.execute({ status: { $ne: 1 } }, exec('s1')), /"status" must be a scalar/)
    const get = tools.get('facility_get_equipment')
    await assert.rejects(get.execute({}, exec('s1')), /"equipmentId" is required/)
    await get.execute({ equipmentId: 'eq/1 x' }, exec('s1'))
    assert.equal(api.calls.find((c) => c.path.startsWith('/api/equipment/')).path, '/api/equipment/eq%2F1%20x')
    const big = await list.execute({ status: 'all' }, exec('s1'))
    assert.match(render(list, {}, big), /… \(truncated\)$/)
    assert.equal(tools.has('facility_propose_repair'), false, 'propose tools in the manifest need a hand-written implementation')
    assert.equal(tools.has('booking_list_reservations'), false, 'outside the namespace')
    assert.ok(api.calls.filter((c) => c.path !== '/bridge/v1/delegations').every((c) => c.method === 'GET'))
  } finally {
    await api.close()
  }
})

test('a read tool can never write: POST from a read tool is refused before reaching the API', async () => {
  const api = await equipmentApi()
  try {
    const { tools, service } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    await service.register('equipment-inspection', (kit) => [kit.defineTool({
      name: 'facility_sneaky_write',
      description: 'Read-only (claims to be): tries to write.',
      async execute() { return kit.requestJson('facility_sneaky_write', '/bridge/v1/proposals', undefined, { method: 'POST', body: { kind: 'x', payload: {} } }) },
    })])
    await assert.rejects(tools.get('facility_sneaky_write').execute({}, exec('s1')), /a read-only tool cannot call POST \/bridge\/v1\/proposals; only propose tools may write/)
    assert.equal(api.callsTo('/bridge/v1/proposals').length, 0)
  } finally {
    await api.close()
  }
})

test('example: facility_propose_reschedule validates the business shape and sends one proposal', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    const tool = tools.get('facility_propose_reschedule')
    assert.match(tool.description, /^Propose-only \(non-binding\): propose a new next-inspection date/)
    assert.deepEqual(tool.parameters.required, ['equipmentId', 'dueOn'])
    assert.equal(tool.parameters.additionalProperties, false)
    const run = exec('s1')
    await assert.rejects(tool.execute({ equipmentId: 'eq-1', dueOn: '2026-11-05', result: 'ok' }, run), /result is not accepted \(this tool only proposes a new date/)
    await assert.rejects(tool.execute({ equipmentId: 'eq-1', dueOn: '2026-11-05', inspector: 'someone' }, run), /unknown argument\(s\): inspector/)
    await assert.rejects(tool.execute({ equipmentId: 'eq-1' }, run), /"dueOn" is required/)
    await assert.rejects(tool.execute({ equipmentId: 'eq-1', dueOn: '2026-02-30' }, run), /must be a real date/)
    await assert.rejects(tool.execute({ equipmentId: '../x', dueOn: '2026-11-05' }, run), /"equipmentId" has an invalid format/)
    await assert.rejects(tool.execute({ equipmentId: 'eq-1', dueOn: '2026-11-05', reason: 'x'.repeat(201) }, run), /at most 200 characters/)
    assert.equal(api.callsTo('/bridge/v1/proposals').length, 0, 'invalid input never reaches the API')
    const res = await tool.execute({ equipmentId: ' eq-1 ', dueOn: '2026-11-05', reason: '業者の都合' }, run)
    assert.deepEqual(api.callsTo('/bridge/v1/proposals')[0].body, { kind: 'inspection_reschedule', payload: { equipmentId: 'eq-1', dueOn: '2026-11-05', reason: '業者の都合' } })
    assert.match(render(tool, {}, res), /^proposal p-inspection_reschedule kind=inspection_reschedule status=pending_review\n.*a person must accept it/)
  } finally {
    await api.close()
  }
})

test('defineProposeTool: shape checks and a missing proposal in the response', async () => {
  assert.throws(() => defineProposeTool({ name: 'x_propose', kind: 'k', parameters: { type: 'object', properties: {} } }), /requestJson is required/)
  assert.throws(() => defineProposeTool({ name: 'x_propose', kind: 'Bad Kind', parameters: { type: 'object', properties: {} } }, { requestJson: async () => ({}) }), /invalid proposal kind/)
  assert.throws(() => defineProposeTool({ name: 'x_propose', kind: 'k1', parameters: { type: 'string' } }, { requestJson: async () => ({}) }), /object schema/)
  const tool = defineProposeTool({ name: 'x_propose', kind: 'k1', description: 'propose x.', parameters: { type: 'object', properties: { a: { type: 'string' } } } }, { requestJson: async () => ({ ok: true }) })
  assert.equal(tool.access, 'propose')
  await assert.rejects(tool.execute({ a: '1' }), /response is missing "proposal"/)
  assert.equal(typeof equipmentInspectionTools, 'function')
})

test('scheduled report turn: reads on behalf of the employee who enabled it, only while a business wake runs; proposals stay denied', async () => {
  const api = await equipmentApi()
  try {
    let wake = { mode: 'business' }
    const notify = { aiReportOwner: (sessionId) => (sessionId === 'rep-1' ? { platform: 'slack', teamId: 'T1', userId: 'U100', botId: 'B1' } : null) }
    const proactive = { activeWake: () => wake }
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({}), notify, proactive })
    assert.equal((await tools.get('facility_list_overdue').execute({}, exec('rep-1'))).ok, true)
    assert.equal(api.callsTo('/api/inspections/overdue')[0].headers['x-delegation-token'], 'dlg-eq-U100-1')
    await assert.rejects(tools.get('facility_propose_reschedule').execute({ equipmentId: 'eq-1', dueOn: '2026-11-05' }, exec('rep-1')), /not allowed/)
    wake = null
    await assert.rejects(tools.get('facility_list_overdue').execute({}, exec('rep-1')), /no IM sender/)
    wake = { mode: 'business' }
    await assert.rejects(tools.get('facility_list_overdue').execute({}, exec('rep-2')), /no IM sender/, 'another conversation has no report owner')
  } finally {
    await api.close()
  }
})
