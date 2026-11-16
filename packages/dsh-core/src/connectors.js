// connectors.js — AI 社員の外部連携（docs/AI_EMPLOYEE_PROFILE.md §3）の DSH 側：業務システムが AI に渡す操作の一覧（catalog）の保持者。
//
//   GET <paths.connectorCatalog>（サービストークン、If-None-Match / etag → 304）。bridge-tools が起動時と connectorRefreshSeconds ごとに取り直す。
//   - 一覧にあるのは操作の ID・名前・説明・読む / 書く・役割・入力の形だけ。接続先の URL・ホスト・秘密は業務システムだけが持つ（D6）。
//   - paths.connectorCatalog が無い・404 = その業務システムに無い機能（空）。取れない・形が違うときは前の一覧のまま。
//   - 読む操作は POST <paths.connectorRun>（本人の委託、業務システムが実行して許可リストの項目だけ返す）、書く操作は提案だけ。
import { CONNECTOR_ID_RE, INPUT_TYPES, OPERATION_EFFECTS, connectorToolName } from '@dsh-bridge/protocol'
import { BridgeApiError } from './api-client.js'

export const CONNECTOR_REFRESH_SECONDS = 60
const ROLE_RE = /^[a-z][a-z0-9_]{0,39}$/

/** 一覧の 1 件を確かめる（形が違うものは捨てる。AI のツールの引数になるので入力の形も確かめる）。 */
export function normalizeCatalogEntry(e) {
  if (!e || typeof e !== 'object') return null
  if (!CONNECTOR_ID_RE.test(String(e.connectorId ?? '')) || !CONNECTOR_ID_RE.test(String(e.operationId ?? ''))) return null
  if (!OPERATION_EFFECTS.includes(e.effect)) return null
  if (!Array.isArray(e.roles) || !e.roles.length || e.roles.some((r) => typeof r !== 'string' || !ROLE_RE.test(r))) return null
  const input = e.input
  if (!input || typeof input !== 'object' || input.type !== 'object' || !input.properties || typeof input.properties !== 'object') return null
  for (const p of Object.values(input.properties)) if (!p || !INPUT_TYPES.includes(p.type)) return null
  const required = Array.isArray(input.required) ? input.required.filter((r) => Object.hasOwn(input.properties, r)) : []
  const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
  return Object.freeze({
    connectorId: e.connectorId,
    connectorName: text(e.connectorName, 60) || e.connectorId,
    operationId: e.operationId,
    name: text(e.name, 60) || e.operationId,
    description: text(e.description, 300),
    effect: e.effect,
    pii: typeof e.pii === 'string' ? e.pii : 'none',
    roles: Object.freeze([...e.roles]),
    input: Object.freeze({ type: 'object', properties: structuredClone(input.properties), required, additionalProperties: false }),
  })
}

/**
 * 1 アプリケーションの外部連携の一覧の保持者。
 * @param {{ applicationId: string, api?: object, path?: string, now?: () => number, logger?: object }} opts
 */
export function createConnectorCatalogHolder({ applicationId, api = null, path = '', now = Date.now, logger = console }) {
  const state = { operations: [], etag: null, served: null, loadedAt: null, checkedAt: null, lastError: null }
  let inflight = null

  async function refresh() {
    if (!path || !api) return state.operations
    if (inflight) return inflight
    inflight = (async () => {
      state.checkedAt = new Date(now()).toISOString()
      try {
        const res = await api.request('GET', path, { headers: state.etag ? { 'if-none-match': state.etag } : {}, raw: true })
        if (res.status === 304) { state.lastError = null; return state.operations }
        const body = res.body
        if (!body || body.ok !== true || !Array.isArray(body.operations)) throw new Error('unexpected response shape')
        state.operations = Object.freeze(body.operations.map(normalizeCatalogEntry).filter(Boolean))
        state.etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null
        state.served = true
        state.loadedAt = new Date(now()).toISOString()
        state.lastError = null
        return state.operations
      } catch (error) {
        if (error instanceof BridgeApiError && error.status === 404) {
          Object.assign(state, { operations: [], etag: null, served: false, lastError: null })
          return state.operations
        }
        state.lastError = error?.message ?? String(error)
        logger.debug?.('bridge: %s connector catalog unavailable: %s', applicationId, state.lastError)
        return state.operations
      }
    })()
    try { return await inflight } finally { inflight = null }
  }

  return {
    get: () => state.operations,
    /** その操作が今も一覧にあるか（消えた操作のツールは実行しない：fail closed）。 */
    find: (connectorId, operationId) => state.operations.find((o) => o.connectorId === connectorId && o.operationId === operationId) ?? null,
    refresh,
    info: () => ({ applicationId, path: path || null, served: state.served, operations: state.operations.length, etag: state.etag, loadedAt: state.loadedAt, checkedAt: state.checkedAt, lastError: state.lastError }),
  }
}

/** 経路の雛形（{connectorId} / {operationId}）を埋める。 */
export function connectorPath(template, connectorId, operationId) {
  return String(template ?? '').replace('{connectorId}', encodeURIComponent(connectorId)).replace('{operationId}', encodeURIComponent(operationId))
}

/** path が paths.connectorRun の雛形に当たるか（読む操作のツールが POST してよい唯一の経路）。 */
export function isConnectorRunPath(template, path) {
  if (!template) return false
  const id = '[a-z][a-z0-9-]{0,39}'
  const re = new RegExp(`^${String(template).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{connectorId}', id).replace('{operationId}', id)}$`)
  return re.test(String(path))
}

/** AI のツールの名前：`<namespace>_ext_<接続先>_<操作>`（@dsh-bridge/protocol の connectorToolName。64 字を超えるなら null）。 */
export { connectorToolName }
