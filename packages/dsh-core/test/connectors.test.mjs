// 外部連携の一覧の保持者の部品：一覧の 1 件の検査、経路の雛形、読む操作のツールが POST してよい経路（docs/AI_EMPLOYEE_PROFILE.md §3）。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectorPath, connectorToolName, isConnectorRunPath, normalizeCatalogEntry, V1_PATHS } from '../src/index.js'
import { CARE_BILLING_PATHS } from '../src/compat/care-billing-paths.js'

test('catalog entries: ids, effect, roles and a flat input are required; text is trimmed', () => {
  const ok = { connectorId: 'billing-software', operationId: 'import-status', name: ' 照会 ', effect: 'read', roles: ['admin'], input: { type: 'object', properties: { month: { type: 'string' } }, required: ['month', 'nope'] } }
  const e = normalizeCatalogEntry(ok)
  assert.deepEqual([e.name, e.connectorName, e.input.required, e.input.additionalProperties], ['照会', 'billing-software', ['month'], false])
  for (const bad of [{ ...ok, connectorId: 'Bad' }, { ...ok, effect: 'delete' }, { ...ok, roles: [] }, { ...ok, input: { type: 'object', properties: { x: { type: 'object' } } } }, null]) assert.equal(normalizeCatalogEntry(bad), null)
})

test('paths: the run template, its matcher (no other path), the tool name', () => {
  assert.equal(connectorPath(V1_PATHS.connectorRun, 'billing-software', 'import-status'), '/bridge/v1/connectors/billing-software/operations/import-status/run')
  assert.ok(isConnectorRunPath(V1_PATHS.connectorRun, '/bridge/v1/connectors/billing-software/operations/import-status/run'))
  assert.ok(isConnectorRunPath(CARE_BILLING_PATHS.connectorRun, '/api/ai/connectors/a/operations/b/run'))
  for (const p of ['/bridge/v1/proposals', '/bridge/v1/connectors/a/operations/b/run/x', '/bridge/v1/connectors/../operations/b/run', '/bridge/v1/connectors/a/operations/b/runs']) assert.ok(!isConnectorRunPath(V1_PATHS.connectorRun, p), p)
  assert.ok(!isConnectorRunPath('', '/x'))
  assert.equal(connectorToolName('facility', 'billing-software', 'import-status'), 'facility_ext_billing_software_import_status')
})
