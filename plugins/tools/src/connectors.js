// connectors.js — 外部連携（docs/AI_EMPLOYEE_PROFILE.md §3.2）の操作から AI のツールを作る。
//
//   読む操作 → `<namespace>_ext_<接続先>_<操作>`（access: read）：POST <paths.connectorRun> を本人の委託で。業務システムが外部 API を呼び、
//             許可リストの項目だけ返す。AI は URL・秘密・応答の本文を知らない。
//   書く操作 → 同じ名前（access: propose）：提案だけ（POST <paths.connectorPropose>）。人が承認してから業務システムが実行する（D5）。
// どちらも実行のたびに一覧（catalog）にまだあるかを確かめる（消えた・止めた操作は動かさない：fail closed）。役割は業務システムが確かめる。
import { connectorPath, connectorToolName, defineTool } from '@dsh-bridge/dsh-core'

const MAX_RENDER = 4000
const asText = (text) => [{ type: 'text', text }]

function checkArgs(name, schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${name}: arguments must be an object`)
  const declared = Object.keys(schema.properties)
  const unknown = Object.keys(args).filter((k) => !declared.includes(k))
  if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
  for (const r of schema.required) if (args[r] === undefined || args[r] === null || args[r] === '') throw new Error(`${name}: "${r}" is required`)
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null))
}

/**
 * @param {object} app            レジストリのアプリケーション（namespace・paths・name）
 * @param {object} deps
 * @param {Function} deps.requestJson   createToolRequester の requestJson
 * @param {object} deps.catalog         createConnectorCatalogHolder
 * @param {Set<string>} [deps.skip]     登録済みの名前
 * @returns {{ tools: object[], skipped: Array<{ name, reason }> }}
 */
export function connectorTools(app, { requestJson, catalog, skip = new Set() }) {
  const out = { tools: [], skipped: [] }
  for (const op of catalog.get()) {
    const name = connectorToolName(app.namespace, op.connectorId, op.operationId)
    if (!name) { out.skipped.push({ name: `${op.connectorId}/${op.operationId}`, reason: 'tool name too long' }); continue }
    if (skip.has(name)) { out.skipped.push({ name, reason: 'already registered' }); continue }
    const current = () => {
      const now = catalog.find(op.connectorId, op.operationId)
      if (!now || now.effect !== op.effect) throw new Error(`${name}: this external operation is no longer available (removed or stopped by an administrator)`)
      return now
    }
    const label = `${op.name}${op.description ? ` — ${op.description}` : ''} (${op.connectorName}; an external system the business system ${app.name} calls for you)`
    if (op.effect === 'read') {
      out.tools.push(defineTool({
        name,
        access: 'read',
        description: `Read-only external: ${label}. Returns only the fields the administrator allowed.`,
        parameters: structuredClone(op.input),
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
          render: (_args, result) => {
            let body = ''
            try { body = JSON.stringify(result?.data ?? null) } catch { body = '[unserializable]' }
            return asText(body.length > MAX_RENDER ? `${body.slice(0, MAX_RENDER)}… (truncated)` : body)
          },
        },
        async execute(args = {}) {
          const now = current()
          const input = checkArgs(name, now.input, args)
          const path = connectorPath(app.paths.connectorRun, op.connectorId, op.operationId)
          const body = await requestJson(name, path, undefined, { method: 'POST', body: { input }, connectorRun: true })
          return { ok: true, data: body?.data ?? {} }
        },
      }))
      continue
    }
    if (!app.paths.connectorPropose) { out.skipped.push({ name, reason: 'no paths.connectorPropose' }); continue }
    out.tools.push(defineTool({
      name,
      access: 'propose',
      description: `Propose-only (non-binding) external write: ${label}. Creates a request that a person approves first; the business system runs it only after that.`,
      parameters: structuredClone(op.input),
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, proposal: { type: 'object' } }, required: ['ok'] },
        render: (_args, result) => asText([
          `request ${result?.proposal?.id ?? '?'} status=${result?.proposal?.status ?? '?'}`,
          'this is a request only: a person must approve it before the external system is called',
        ].join('\n')),
      },
      async execute(args = {}) {
        const now = current()
        const input = checkArgs(name, now.input, args)
        const template = app.paths.connectorPropose
        const path = connectorPath(template, op.connectorId, op.operationId)
        const body = template.includes('{connectorId}')
          ? { input }
          : { kind: 'connector_write', payload: { connectorId: op.connectorId, operationId: op.operationId, input } }
        const res = await requestJson(name, path, undefined, { method: 'POST', body })
        const p = res?.proposal
        if (!p || typeof p !== 'object') throw new Error(`${name}: the business API response is missing "proposal"`)
        return { ok: true, proposal: { id: p.id ?? null, kind: p.kind ?? 'connector_write', status: p.status ?? null } }
      },
    }))
  }
  return out
}
