// AI 社員の外部連携：接続先・操作・規則の検査、条件の評価、差し込み、応答の許可リスト（docs/AI_EMPLOYEE_PROFILE.md §3）。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOperationRequest, checkOperationInput, connectorHostOf, connectorToolName, cronMatches, evaluateWhen, parseCron, pickResponseFields, renderRuleInput,
  validateConnector, validateOperation, validateRule,
} from '../src/index.mjs'

const codes = (r) => r.errors.map((e) => `${e.field}:${e.code}`)

const READ = {
  id: 'import-status', name: '取込状況の照会', method: 'GET', path: '/v1/imports/{month}',
  input: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, office: { type: 'string' } } },
  responseFields: ['status', 'counts.total', 'items[].id'], pii: 'none', roles: ['admin', 'billing'],
}
const WRITE = {
  id: 'update-level', name: '区分の送信', method: 'PUT', path: '/v1/residents/{externalId}/level',
  input: { type: 'object', properties: { externalId: { type: 'string' }, level: { type: 'integer', minimum: 1, maximum: 7 } }, required: ['level'] },
  pii: 'health', idempotent: true,
}
const CONNECTOR = {
  id: 'billing-software', name: '請求ソフト（架空）', kind: 'third_party', baseUrl: 'https://billing.example.test/api/',
  auth: { type: 'api_key', headerName: 'X-Api-Key' }, operations: [READ, WRITE],
}

test('a connector: https only, the base host is allowed, secrets have no place, defaults', () => {
  const r = validateConnector(CONNECTOR)
  assert.ok(r.ok, JSON.stringify(r.errors))
  const c = r.connector
  assert.equal(c.baseUrl, 'https://billing.example.test/api')
  assert.deepEqual(c.allowedHosts, ['billing.example.test'])
  assert.deepEqual(c.auth, { type: 'api_key', headerName: 'x-api-key' })
  assert.deepEqual([c.timeoutMs, c.ratePerMinute, c.maxResponseBytes, c.enabled], [10_000, 30, 256 * 1024, true])
  const read = c.operations[0]
  assert.deepEqual([read.effect, read.idempotent, read.input.required, read.input.additionalProperties], ['read', true, ['month'], false])
  assert.equal(read.input.properties.office.maxLength, 500)
  const write = c.operations[1]
  assert.deepEqual([write.effect, write.idempotent, write.autoRun], ['write', true, { allowed: false, reason: null }])
  assert.deepEqual(write.input.required, ['level', 'externalId'])

  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, baseUrl: 'http://billing.example.test' })), ['baseUrl:not_https'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, baseUrl: 'http://localhost:9000' })), ['baseUrl:not_https'])
  assert.ok(validateConnector({ ...CONNECTOR, baseUrl: 'http://127.0.0.1:9000' }, { allowLocalhost: true }).ok)
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, baseUrl: 'https://u:p@billing.example.test' })), ['baseUrl:invalid'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, allowedHosts: ['other.example.test'] })), ['baseUrl:host_not_allowed'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, apiKey: 'x' })), ['apiKey:unknown_field'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, auth: { type: 'api_key', headerName: 'Cookie' } })), ['auth.headerName:invalid'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, timeoutMs: 30_000 })), ['timeoutMs:invalid'])
  assert.deepEqual(codes(validateConnector({ ...CONNECTOR, operations: [READ, READ] })), ['operations[1].id:duplicate'])
  const oauth = validateConnector({ ...CONNECTOR, auth: { type: 'oauth2_client', clientId: 'cid', tokenUrl: 'https://auth.example.test/token' } })
  assert.deepEqual(codes(oauth), ['auth.tokenUrl:host_not_allowed'])
  assert.ok(validateConnector({ ...CONNECTOR, allowedHosts: ['billing.example.test', 'auth.example.test'], auth: { type: 'oauth2_client', clientId: 'cid', tokenUrl: 'https://auth.example.test/token' } }).ok)
  assert.deepEqual(connectorHostOf('https://a.example.test:8443/x').host, 'a.example.test:8443')
})

test('an operation: path variables are declared, response fields are paths, auto-run needs an idempotent write and a reason', () => {
  assert.deepEqual(codes(validateOperation({ ...READ, path: '/v1/{nope}' })), ['operation.path:path_var_undeclared'])
  assert.deepEqual(codes(validateOperation({ ...READ, path: '/v1/../x' })), ['operation.path:invalid'])
  assert.deepEqual(codes(validateOperation({ ...READ, responseFields: ['a.b', 'x y'] })), ['operation.responseFields[1]:invalid'])
  assert.deepEqual(codes(validateOperation({ ...READ, path: '/v1/imports', input: { type: 'object', properties: { x: { type: 'object' } } } })), ['operation.input.properties.x.type:invalid'])
  assert.deepEqual(codes(validateOperation({ ...READ, pii: 'secret' })), ['operation.pii:invalid'])
  assert.deepEqual(codes(validateOperation({ ...WRITE, idempotent: false, autoRun: { allowed: true, reason: '毎晩同じ値を送るだけ' } })), ['operation.autoRun.allowed:auto_needs_idempotent'])
  assert.deepEqual(codes(validateOperation({ ...WRITE, autoRun: { allowed: true } })), ['operation.autoRun.reason:reason_required'])
  const ok = validateOperation({ ...WRITE, autoRun: { allowed: true, reason: '同じ値を何度送っても同じ結果' } })
  assert.deepEqual(ok.operation.autoRun, { allowed: true, reason: '同じ値を何度送っても同じ結果' })
  assert.deepEqual(validateOperation({ ...READ, autoRun: { allowed: true } }).operation.autoRun, { allowed: false, reason: null }, 'a read needs no permission')
  assert.deepEqual(codes(validateOperation({ ...READ, method: 'DELETE', effect: 'read' })), ['operation.effect:invalid'])
})

test('a rule: one trigger, simple conditions, existing operation, approval by a role, auto only when allowed, high PII needs allowPii', () => {
  const connectors = [validateConnector(CONNECTOR).connector]
  const base = {
    id: 'send-level', name: '区分変更を請求ソフトへ', trigger: { event: 'classification.change_decided' },
    when: { all: [{ field: 'payload.decision', op: 'eq', value: 'approved' }] },
    action: { connector: 'billing-software', operation: 'update-level', input: { externalId: '{payload.residentExternalId}', level: '{payload.newLevel}' } },
    approvers: { role: 'manager' }, allowPii: true,
  }
  const r = validateRule(base, { connectors, events: ['classification.change_decided'], roles: ['admin', 'manager'] })
  assert.ok(r.ok, JSON.stringify(r.errors))
  assert.deepEqual([r.rule.mode, r.rule.notify, r.rule.enabled], ['approval', { onSuccess: 'info', onFailure: 'action' }, true])
  const v = (rule, ctx = { connectors }) => codes(validateRule(rule, ctx))
  assert.deepEqual(v({ ...base, trigger: { event: 'x', cron: '0 8 * * *' } }), ['trigger:invalid'])
  assert.deepEqual(v({ ...base, trigger: { event: 'nope' } }, { connectors, events: ['a'] }), ['trigger.event:unknown_event'])
  assert.deepEqual(v({ ...base, trigger: { cron: '0 25 * * *' } }), ['trigger.cron:invalid'])
  assert.deepEqual(v({ ...base, when: { all: [{ field: 'process.env', op: 'eq', value: 1 }] } }), ['when.all[0].field:invalid'])
  assert.deepEqual(v({ ...base, when: { all: [{ field: 'payload.n', op: 'gt', value: '3' }] } }), ['when.all[0].value:invalid'])
  assert.deepEqual(v({ ...base, when: { all: [{ field: 'payload.n', op: 'regex', value: '.*' }] } }), ['when.all[0].op:invalid'])
  assert.deepEqual(v({ ...base, action: { ...base.action, operation: 'x' } }), ['action.operation:unknown_operation'])
  assert.deepEqual(v({ ...base, action: { ...base.action, input: { externalId: '{payload.x}', level: 1, extra: 1 } } }), ['action.input.extra:unknown_field'])
  assert.deepEqual(v({ ...base, action: { ...base.action, input: { externalId: '{secrets.key}', level: 1 } } }), ['action.input.externalId:invalid', 'action.input.externalId:required'])
  assert.deepEqual(v({ ...base, action: { ...base.action, input: { externalId: '{payload.x}' } } }), ['action.input.level:required'])
  assert.deepEqual(v({ ...base, approvers: undefined }), ['approvers.role:required'])
  assert.deepEqual(v({ ...base, mode: 'auto', approvers: undefined }), ['mode:auto_not_allowed'])
  assert.deepEqual(v({ ...base, allowPii: false }), ['allowPii:pii_not_allowed'])
  assert.deepEqual(v({ ...base, approvers: { role: 'nobody' } }, { connectors, roles: ['admin'] }), ['approvers.role:unknown_role'])
  const readRule = { id: 'nightly', name: '毎晩の照会', trigger: { cron: '0 2 * * *' }, action: { connector: 'billing-software', operation: 'import-status', input: { month: '{now.month}' } }, mode: 'auto' }
  assert.ok(validateRule(readRule, { connectors }).ok, 'a read may run automatically')
})

test('conditions, input templates, requests and the response allowlist', () => {
  const data = { event: { type: 'x' }, payload: { decision: 'approved', n: '5', tags: ['a', 'b'], empty: '' } }
  assert.ok(evaluateWhen(null, data))
  assert.ok(evaluateWhen({ all: [{ field: 'payload.decision', op: 'eq', value: 'approved' }, { field: 'payload.n', op: 'gt', value: 4 }] }, data))
  assert.ok(!evaluateWhen({ all: [{ field: 'payload.n', op: 'lt', value: 4 }] }, data))
  assert.ok(evaluateWhen({ any: [{ field: 'payload.tags', op: 'contains', value: 'b' }, { field: 'payload.none', op: 'exists' }] }, data))
  assert.ok(!evaluateWhen({ all: [{ field: 'payload.empty', op: 'exists' }] }, data))
  assert.ok(!evaluateWhen({ all: [{ field: 'payload.__proto__', op: 'exists' }] }, data))
  assert.deepEqual(renderRuleInput({ a: '{payload.n}', b: '月 {payload.decision} / {payload.none}', c: 3 }, data), { a: '5', b: '月 approved / ', c: 3 })
  assert.deepEqual(renderRuleInput({ a: '{payload.tags}' }, data), { a: ['a', 'b'] })

  const op = validateOperation(READ).operation
  assert.deepEqual(checkOperationInput(op, { month: '2026-10' }), { ok: true, errors: [] })
  assert.deepEqual(codes(checkOperationInput(op, { month: '10月' })), ['input.month:invalid'])
  assert.deepEqual(codes(checkOperationInput(op, {})), ['input:required'])
  assert.deepEqual(codes(checkOperationInput(op, { month: '2026-10', x: 1 })), ['input.x:unknown_field'])
  assert.deepEqual(buildOperationRequest(op, { month: '2026/10', office: 'A' }), { method: 'GET', path: '/v1/imports/2026%2F10', query: { office: 'A' }, body: null })
  const w = validateOperation(WRITE).operation
  assert.deepEqual(buildOperationRequest(w, { externalId: 'R-1', level: 3 }), { method: 'PUT', path: '/v1/residents/R-1/level', query: {}, body: { level: 3 } })

  const response = { status: 'done', secret: 'x', counts: { total: 3, other: 1 }, items: [{ id: 'a', name: '架空' }, { id: 'b' }], long: 'z'.repeat(600) }
  assert.deepEqual(pickResponseFields(response, ['status', 'counts.total', 'items[].id', 'nope.x']), { status: 'done', counts: { total: 3 }, items: [{ id: 'a' }, { id: 'b' }] })
  assert.deepEqual(pickResponseFields(response, ['counts']), {}, 'an object leaf is never passed')
  assert.equal(pickResponseFields(response, ['long']).long.length, 501)
  assert.deepEqual(pickResponseFields(response, []), {})
})

test('cron and tool names', () => {
  assert.equal(parseCron('* * *'), null)
  assert.equal(parseCron('61 * * * *'), null)
  assert.ok(cronMatches('*/15 9-17 * * 1-5', { minute: 30, hour: 9, day: 2, month: 11, weekday: 1 }))
  assert.ok(!cronMatches('*/15 9-17 * * 1-5', { minute: 31, hour: 9, day: 2, month: 11, weekday: 1 }))
  assert.ok(cronMatches('0 0 * * 7', { minute: 0, hour: 0, day: 1, month: 11, weekday: 0 }), '7 = Sunday')
  assert.equal(connectorToolName('care', 'billing-software', 'import-status'), 'care_ext_billing_software_import_status')
  assert.equal(connectorToolName('care', 'a'.repeat(40), 'b'.repeat(40)), null)
})
