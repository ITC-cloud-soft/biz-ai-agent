// bridge-tools のテスト環境：設備点検（架空）の業務 API のモックと、レジストリ（fixture の manifest）・bridge-tools の読み込み。
import { fileURLToPath } from 'node:url'
import { createApplicationRegistry, registryService } from '@dsh-bridge/dsh-core'
import { apply } from '../src/index.js'
import { makeSource, silentLogger, startFakeApi } from './helpers.mjs'

export const EQ_MANIFEST = fileURLToPath(new URL('./fixtures/equipment-inspection.manifest.yaml', import.meta.url))
export const EXAMPLE_MODULE = '@dsh-bridge/plugin-tools/examples/equipment-inspection'
export const exec = (sessionId) => ({ agent: { session: { id: sessionId } } })
export const linked = (userId, extra = {}) => ({ source: makeSource({ userId, ...extra }), linked: true, user: { id: `emp-${userId}`, role: 'inspector' } })

/**
 * 設備点検の業務 API（Bridge v1 ＋業務の GET）。delegations は linkedUsers の IM ユーザーだけに発行する。
 * @param {object} [options]
 * @param {(req) => object|null} [options.extra]  追加の経路
 */
export function equipmentApi({ token = 'svc', expiresInMs = 300_000, linkedUsers = new Set(['U100', 'U200']), extra = null, tag = 'eq' } = {}) {
  let n = 0
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== token) return { status: 401, body: { error: 'service_token_required' } }
    if (req.path === '/bridge/v1/delegations' && !req.body?.event) {
      if (!linkedUsers.has(req.body?.source?.userId)) return { status: 404, body: { error: 'identity_not_linked' } }
      n += 1
      return {
        status: 201,
        body: {
          ok: true,
          token: `dlg-${tag}-${req.body.source.userId}-${n}`,
          user: { id: `emp-${req.body.source.userId}`, role: 'inspector', displayName: 'x' },
          expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        },
      }
    }
    const more = extra?.(req)
    if (more) return more
    if (req.path === '/api/equipment') return { body: { ok: true, equipment: [{ id: 'eq-1', code: 'FE-01', nextInspectionOn: '2026-11-01' }] } }
    if (req.path.startsWith('/api/equipment/')) return { body: { ok: true, equipment: { id: decodeURIComponent(req.path.slice('/api/equipment/'.length)), code: 'FE-01' } } }
    if (req.path === '/api/inspections/overdue') return { body: { ok: true, overdue: [{ equipmentId: 'eq-2', dueOn: '2026-10-20', daysOverdue: 7 }] } }
    if (req.path === '/bridge/v1/proposals' && req.method === 'POST') {
      return { status: 201, body: { ok: true, proposal: { id: `p-${req.body.kind}`, kind: req.body.kind, status: 'pending_review', payload: req.body.payload } } }
    }
    if (req.path === '/bridge/v1/health') return { body: { ok: true, protocol: 1, version: '1.0.0' } }
    return { status: 404, body: { error: 'not_found' } }
  })
}

export function registryFor(api, entry = {}, others = []) {
  return createApplicationRegistry({
    logger: silentLogger(),
    applications: [
      { id: 'equipment-inspection', name: '設備点検', namespace: 'facility', default: true, apiUrl: api.url, serviceToken: 'svc', manifestFile: EQ_MANIFEST, ...entry },
      ...others,
    ],
  })
}

export function identityFor(map) {
  const invalidated = []
  const listeners = []
  return {
    invalidated,
    listeners,
    forSession: async (sessionId) => (typeof map === 'function' ? map(sessionId) : map[sessionId] ?? null),
    invalidate: (source) => invalidated.push(source.userId),
    onUnlinked: (fn) => { listeners.push(fn); return () => {} },
  }
}

/**
 * bridge-tools を読み込み、ready を待つ。tools は名前 → 登録されたツール（gate 付き）。
 * @param {object} opts
 * @param {object} [opts.registry]  無ければプラグイン設定（apiUrl / serviceToken）の 1 件
 */
export async function load({ registry = null, identity = null, autoTasks = null, assistant = null, notify = null, proactive = null, config = {} } = {}) {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) }, logger: () => silentLogger() }
  if (registry) ctx.bridgeApps = registryService(registry)
  if (identity) ctx.bridgeIdentity = identity
  if (autoTasks) ctx.autoTasks = autoTasks
  if (assistant) ctx.bridgeAssistant = assistant
  if (notify) ctx.bridgeNotify = notify
  if (proactive) ctx.dshProactive = proactive
  ctx.provide = (key, value) => { ctx[key] = value }
  const service = apply(ctx, { toolModules: [{ module: EXAMPLE_MODULE }], ...config })
  await service.ready
  return { tools, service, ctx }
}
