// 外部連携の操作（業務システムの connector catalog）から作るツール：読む操作は本人の委託で業務システムに実行させる、書く操作は提案だけ、
// 一覧から消えた操作は動かさない（docs/AI_EMPLOYEE_PROFILE.md §3.2）。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { equipmentApi, exec, identityFor, linked, load, registryFor } from './env.mjs'

const READ = {
  connectorId: 'billing-software', connectorName: '請求ソフト（架空）', operationId: 'import-status', name: '取込状況の照会', description: '月の取込状況',
  effect: 'read', pii: 'none', roles: ['inspector'], input: { type: 'object', properties: { month: { type: 'string' } }, required: ['month'], additionalProperties: false },
}
const WRITE = {
  ...READ, operationId: 'update-level', name: '区分の送信', description: '', effect: 'write', pii: 'health',
  input: { type: 'object', properties: { externalId: { type: 'string' }, level: { type: 'integer' } }, required: ['externalId', 'level'], additionalProperties: false },
}

test('external tools: a read runs through the business system as the employee; a write is a proposal; removed operations fail closed', async () => {
  let catalog = [READ, WRITE, { ...READ, operationId: 'bad', roles: [] }]
  const api = await equipmentApi({
    extra: (req) => {
      if (req.path === '/bridge/v1/connectors/catalog') return { body: { ok: true, operations: catalog } }
      if (req.path === '/bridge/v1/connectors/billing-software/operations/import-status/run' && req.method === 'POST') return { body: { ok: true, connectorId: 'billing-software', operationId: 'import-status', status: 200, data: { status: 'done' } } }
      return null
    },
  })
  try {
    const { tools, service } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    const read = tools.get('facility_ext_billing_software_import_status')
    const write = tools.get('facility_ext_billing_software_update_level')
    assert.ok(read && write, [...tools.keys()].join(', '))
    assert.equal(tools.has('facility_ext_billing_software_bad'), false, 'an operation without roles is not given to the AI')
    assert.match(read.description, /^Read-only external: 取込状況の照会 — 月の取込状況 \(請求ソフト（架空）/)
    assert.match(write.description, /^Propose-only \(non-binding\) external write/)
    assert.deepEqual(service.list().filter((x) => x.name.includes('_ext_')).map((x) => x.access), ['read', 'propose'])

    const r = await read.execute({ month: '2026-10' }, exec('s1'))
    assert.deepEqual(r, { ok: true, data: { status: 'done' } })
    const call = api.callsTo('/bridge/v1/connectors/billing-software/operations/import-status/run')[0]
    assert.deepEqual([call.method, call.body, call.headers['x-delegation-token']], ['POST', { input: { month: '2026-10' } }, 'dlg-eq-U100-1'])
    await assert.rejects(read.execute({ month: '2026-10', url: 'https://x' }, exec('s1')), /unknown argument\(s\): url/)
    await assert.rejects(read.execute({}, exec('s1')), /"month" is required/)

    const p = await write.execute({ externalId: 'R-1', level: 3 }, exec('s1'))
    assert.deepEqual(p, { ok: true, proposal: { id: 'p-connector_write', kind: 'connector_write', status: 'pending_review' } })
    assert.deepEqual(api.callsTo('/bridge/v1/proposals', 'POST').at(-1).body, { kind: 'connector_write', payload: { connectorId: 'billing-software', operationId: 'update-level', input: { externalId: 'R-1', level: 3 } } })

    catalog = [WRITE]
    await service.refresh()
    await assert.rejects(read.execute({ month: '2026-10' }, exec('s1')), /no longer available/)
    assert.equal(api.callsTo('/bridge/v1/connectors/billing-software/operations/import-status/run').length, 1)
  } finally {
    await api.close()
  }
})

test('external tools: a read tool may POST only to the run path of its application', async () => {
  const api = await equipmentApi({ extra: (req) => (req.path === '/bridge/v1/connectors/catalog' ? { body: { ok: true, operations: [] } } : null) })
  try {
    const { tools, service } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    await service.register('equipment-inspection', (kit) => [kit.defineTool({
      name: 'facility_sneaky_run',
      description: 'Read-only (claims to be): tries to post elsewhere with the connector flag.',
      async execute() { return kit.requestJson('facility_sneaky_run', '/bridge/v1/proposals', undefined, { method: 'POST', body: {}, connectorRun: true }) },
    })])
    await assert.rejects(tools.get('facility_sneaky_run').execute({}, exec('s1')), /a read-only tool cannot call POST/)
  } finally {
    await api.close()
  }
})

test('external tools: an application without the capability (404) gets none', async () => {
  const api = await equipmentApi()
  try {
    const { tools } = await load({ registry: registryFor(api), identity: identityFor({ s1: linked('U100') }) })
    assert.ok(![...tools.keys()].some((n) => n.includes('_ext_')))
  } finally {
    await api.close()
  }
})
