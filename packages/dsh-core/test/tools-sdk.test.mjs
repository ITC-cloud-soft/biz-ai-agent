import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply, createApplicationRegistry, createDelegationGate, createToolRequester, currentPrincipal, defineTool, guardTool, manifestTools,
  registerManifestTools, registerTools, runWithPrincipal,
} from '../src/index.js'
import { makeSource, miniManifest, silentLogger, startFakeApi } from './helpers.mjs'
import { enableCareBillingPaths } from '../src/compat/care-billing-paths.js'

enableCareBillingPaths()

function delegationApi(tag, { linked = new Set(['U100']) } = {}) {
  let n = 0
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== `svc-${tag}`) return { status: 401, body: { ok: false, error: 'service_token_required' } }
    if (req.path.endsWith('/delegations')) {
      if (!linked.has(req.body?.source?.userId)) return { status: 404, body: { ok: false, error: 'identity_not_linked' } }
      n += 1
      return { status: 201, body: { ok: true, token: `dlg-${tag}-${n}`, user: { id: `emp-${tag}`, role: 'staff' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    }
    if (req.path === '/api/equipment') return { body: { ok: true, equipment: [{ id: 'o1' }], q: req.query } }
    if (req.path.startsWith('/api/equipment/')) return { body: { ok: true, equipment: { id: decodeURIComponent(req.path.split('/').pop()) } } }
    if (req.path === '/api/ping') return { body: { ok: true } }
    if (req.path === '/api/proposals') return { status: 201, body: { ok: true, proposal: { id: 'p1' } } }
    return null
  })
}

async function twoApps() {
  const care = await delegationApi('care')
  const demo = await delegationApi('demo')
  const registry = createApplicationRegistry({
    applications: [
      { id: 'care-billing', default: true, apiUrl: care.url, serviceToken: 'svc-care', paths: 'legacy', namespace: 'care', label: 'care-api' },
      { id: 'equipment-inspection', apiUrl: demo.url, serviceToken: 'svc-demo', bots: [{ platform: 'slack', botId: 'S2' }] },
    ],
    logger: silentLogger,
  })
  return { care, demo, registry, close: async () => { await care.close(); await demo.close() } }
}

/** forSession: 会話 → {source, linked, applicationId}（care-identity と同じ形）。 */
function identityFor(registry, sessions) {
  return {
    forSession: async (sid) => {
      const source = sessions[sid]
      if (!source) return null
      return { source, linked: true, user: { id: 'e' }, applicationId: registry.resolveApplication(source)?.id ?? null }
    },
    invalidate() {},
  }
}

function gateFor(registry, appId, identity, extra = {}) {
  const application = () => registry.get(appId)
  const requester = createToolRequester({ application })
  const gate = createDelegationGate({ application, registry: () => registry, identity: () => identity, requestJson: requester.requestJson, logger: silentLogger, ...extra })
  return { gate, requester }
}

const exec = (id) => ({ agent: { session: { id } } })

test('defineTool: access is read | propose | open (no direct writes), name and description required', () => {
  const tool = defineTool({ name: 'demo_x', description: 'Read-only: x', execute: async () => ({}) })
  assert.equal(tool.access, 'read')
  assert.equal(Object.keys(tool).includes('access'), false, 'access is not sent to the DSH tool registry')
  assert.throws(() => defineTool({ name: 'demo_x', description: 'x', access: 'write', execute() {} }), /writes are proposals only/)
  assert.throws(() => defineTool({ name: 'Demo X', description: 'x', execute() {} }), /invalid tool name/)
  assert.throws(() => defineTool({ name: 'demo_x', execute() {} }), /description is required/)
})

test('a conversation of application B cannot use the tools of A (no delegation is requested anywhere)', async () => {
  const env = await twoApps()
  try {
    const identity = identityFor(env.registry, { care: makeSource({ botId: 'B1' }), demo: makeSource({ botId: 'S2' }) })
    const care = gateFor(env.registry, 'care-billing', identity)
    const demo = gateFor(env.registry, 'equipment-inspection', identity)
    await assert.rejects(care.gate.authorize('care_list_buildings', exec('demo')), /belongs to application "equipment-inspection", not "care-billing"/)
    await assert.rejects(demo.gate.authorize('equipment_inspection_list_equipment', exec('care')), /belongs to application "care-billing", not "equipment-inspection"/)
    assert.equal(env.care.calls.length + env.demo.calls.length, 0)

    // 同じ IM 利用者でも、委託はそれぞれのアプリケーションの API で別々に取る
    const a = await care.gate.authorize('care_list_buildings', exec('care'))
    const b = await demo.gate.authorize('equipment_inspection_list_equipment', exec('demo'))
    assert.equal(a.applicationId, 'care-billing')
    assert.equal(a.delegationToken, 'dlg-care-1')
    assert.equal(b.applicationId, 'equipment-inspection')
    assert.equal(b.delegationToken, 'dlg-demo-1')
    assert.equal(env.care.callsTo('/api/ai/delegations').length, 1)
    assert.equal(env.demo.callsTo('/bridge/v1/delegations').length, 1)
    assert.equal(env.demo.callsTo('/bridge/v1/delegations')[0].headers['x-service-token'], 'svc-demo')
  } finally {
    await env.close()
  }
})

test('a delegation token minted for A is never sent to B (requester refuses before any request)', async () => {
  const env = await twoApps()
  try {
    const demoRequester = createToolRequester({ application: () => env.registry.get('equipment-inspection') })
    const principal = { mode: 'delegated', delegationToken: 'dlg-care-1', applicationId: 'care-billing', access: 'read' }
    await assert.rejects(
      runWithPrincipal(principal, () => demoRequester.requestJson('equipment_inspection_list_equipment', '/api/equipment')),
      /refusing to send a delegation token of application "care-billing" to "equipment-inspection"/,
    )
    assert.equal(env.demo.calls.length, 0)
    const own = { ...principal, delegationToken: 'dlg-demo-1', applicationId: 'equipment-inspection' }
    await runWithPrincipal(own, () => demoRequester.requestJson('equipment_inspection_list_equipment', '/api/equipment'))
    assert.equal(env.demo.calls[0].headers['x-delegation-token'], 'dlg-demo-1')
  } finally {
    await env.close()
  }
})

test('read tools can only GET; propose tools may POST (as a proposal)', async () => {
  const env = await twoApps()
  try {
    const identity = identityFor(env.registry, { demo: makeSource({ botId: 'S2' }) })
    const { gate, requester } = gateFor(env.registry, 'equipment-inspection', identity)
    const sneaky = guardTool(gate, defineTool({
      name: 'equipment_inspection_list_equipment', description: 'Read-only', execute: () => requester.requestJson('equipment_inspection_list_equipment', '/api/proposals', undefined, { method: 'POST', body: {} }),
    }))
    await assert.rejects(sneaky.execute({}, exec('demo')), /read-only tool cannot call POST/)
    assert.equal(env.demo.callsTo('/api/proposals').length, 0)
    const propose = guardTool(gate, defineTool({
      name: 'equipment_inspection_propose_x', description: 'Propose-only (non-binding)', access: 'propose',
      execute: () => requester.requestJson('equipment_inspection_propose_x', '/api/proposals', undefined, { method: 'POST', body: { kind: 'x' } }),
    }), { write: true })
    assert.equal((await propose.execute({}, exec('demo'))).proposal.id, 'p1')
    assert.equal(currentPrincipal(), undefined)
  } finally {
    await env.close()
  }
})

test('registerTools checks the application namespace', async () => {
  const env = await twoApps()
  try {
    const registered = []
    const { gate } = gateFor(env.registry, 'equipment-inspection', null)
    const app = env.registry.get('equipment-inspection')
    assert.deepEqual(registerTools({ register: (t) => registered.push(t) }, gate, [defineTool({ name: 'equipment_inspection_ping', description: 'x', access: 'open', execute: async () => ({ ok: true }) })], { application: app }), ['equipment_inspection_ping'])
    assert.throws(() => registerTools({ register() {} }, gate, [defineTool({ name: 'care_list_buildings', description: 'x', execute: async () => ({}) })], { application: app }), /outside the namespace "equipment_inspection_"/)
    assert.deepEqual(await registered[0].execute({}, exec('none')), { ok: true }, 'open tools need no delegation')
  } finally {
    await env.close()
  }
})

test('manifest tools: GET read tools of the namespace are generated (path params encoded, query from args)', async () => {
  const env = await twoApps()
  try {
    const manifest = miniManifest('equipment-inspection', {
      tools: [
        { name: 'equipment_inspection_list_equipment', description: '設備の一覧', http: 'GET /api/equipment', access: 'read', roles: ['staff'], input: { $ref: '#/schemas/EquipmentQuery' } },
        { name: 'equipment_inspection_get_equipment', description: '設備 1 件', http: 'GET /api/equipment/{equipmentId}', access: 'read', roles: ['staff'], input: { type: 'object', required: ['equipmentId'], additionalProperties: false, properties: { equipmentId: { type: 'string' } } } },
        { name: 'equipment_inspection_propose_reschedule', description: '提案', http: 'POST /api/proposals', access: 'propose', roles: ['staff'] },
        { name: 'care_list_buildings', description: '他のアプリケーションの名前', http: 'GET /api/buildings', access: 'read', roles: ['staff'] },
        { name: 'equipment_inspection_ping', description: '稼働', http: 'GET /api/ping', access: 'read', roles: ['staff'], open: true },
      ],
      schemas: { EquipmentQuery: { type: 'object', additionalProperties: false, properties: { status: { type: 'string' }, limit: { type: 'integer' } } } },
    })
    const reg = createApplicationRegistry({
      applications: [{ id: 'equipment-inspection', apiUrl: env.demo.url, serviceToken: 'svc-demo', manifest, bots: [{ platform: 'slack', botId: 'S2' }] }],
      logger: silentLogger,
    })
    const app = reg.get('equipment-inspection')
    await app.refreshManifest()
    const identity = identityFor(reg, { demo: makeSource({ botId: 'S2' }) })
    const { gate, requester } = gateFor(reg, 'equipment-inspection', identity)
    const { tools, skipped } = manifestTools(app, { requestJson: requester.requestJson })
    assert.deepEqual(tools.map((t) => t.name), ['equipment_inspection_list_equipment', 'equipment_inspection_get_equipment', 'equipment_inspection_ping'])
    assert.deepEqual(skipped.map((s) => s.name), ['equipment_inspection_propose_reschedule', 'care_list_buildings'])
    const registered = new Map()
    registerManifestTools({ register: (t) => registered.set(t.name, t) }, { application: app, gate, requestJson: requester.requestJson, logger: silentLogger })
    const list = registered.get('equipment_inspection_list_equipment')
    assert.match(list.description, /^Read-only: 設備の一覧/)
    assert.deepEqual(list.parameters.properties.status, { type: 'string' })
    const res = await list.execute({ status: 'open' }, exec('demo'))
    assert.deepEqual(res.data.q, { status: 'open' })
    assert.equal(env.demo.callsTo('/api/equipment')[0].headers['x-delegation-token'], 'dlg-demo-1')
    await assert.rejects(list.execute({ residentName: 'x' }, exec('demo')), /unknown argument/)
    const got = await registered.get('equipment_inspection_get_equipment').execute({ equipmentId: 'a/b c' }, exec('demo'))
    assert.equal(got.data.equipment.id, 'a/b c')
    assert.equal(env.demo.calls.at(-1).path, '/api/equipment/a%2Fb%20c')
    await assert.rejects(registered.get('equipment_inspection_get_equipment').execute({}, exec('demo')), /"equipmentId" is required/)
    assert.match(list.output.render({}, res)[0].text, /o1/)
    // 発信元なし（owner 会話）は拒否
    await assert.rejects(list.execute({}, exec('owner')), /not allowed/)
  } finally {
    await env.close()
  }
})

test('proactive business wake: the report owner must belong to the same application', async () => {
  const env = await twoApps()
  try {
    const owner = makeSource({ botId: 'S2' })
    const { gate } = gateFor(env.registry, 'care-billing', identityFor(env.registry, {}), {
      reportOwner: () => owner,
      activeWake: () => ({ mode: 'business' }),
    })
    await assert.rejects(gate.authorize('care_get_business_report', exec('s-report')), /belongs to application "equipment-inspection"/)
    owner.botId = 'B1'
    assert.equal((await gate.authorize('care_get_business_report', exec('s-report'))).proactive, true)
  } finally {
    await env.close()
  }
})

test('assistant sessions only serve the application of the assistant (default application)', async () => {
  const env = await twoApps()
  try {
    const assistant = { isAssistantSession: () => true, delegationForSession: async () => ({ token: 'dlg-assist', userId: 'e1' }) }
    const demo = gateFor(env.registry, 'equipment-inspection', null, { assistant: () => assistant })
    await assert.rejects(demo.gate.authorize('equipment_inspection_list_equipment', exec('as-1')), /assistant conversation belongs to application "care-billing"/)
    const care = gateFor(env.registry, 'care-billing', null, { assistant: () => assistant })
    assert.equal((await care.gate.authorize('care_list_buildings', exec('as-1'))).delegationToken, 'dlg-assist')
  } finally {
    await env.close()
  }
})

test('unattended (auto task) sessions: per application, only for tasks of that application', async () => {
  const env = await twoApps()
  try {
    const tasks = [{ sessionId: 'auto-1', enabled: true, applicationId: 'care-billing' }]
    const isAutoTaskSession = async (sid, appId) => tasks.some((t) => t.sessionId === sid && (!t.applicationId || t.applicationId === appId))
    const onBehalf = makeSource({ userId: 'U100' })
    const care = gateFor(env.registry, 'care-billing', identityFor(env.registry, {}), { unattended: () => onBehalf, isAutoTaskSession })
    const demo = gateFor(env.registry, 'equipment-inspection', identityFor(env.registry, {}), { unattended: () => onBehalf, isAutoTaskSession })
    assert.equal((await care.gate.authorize('care_list_buildings', exec('auto-1'))).unattended, true)
    await assert.rejects(demo.gate.authorize('equipment_inspection_list_equipment', exec('auto-1')), /not allowed/)
    assert.equal(env.demo.calls.length, 0)
  } finally {
    await env.close()
  }
})

test('bridge-apps plugin: generateTools registers manifest tools behind the gate of that application', async () => {
  const env = await twoApps()
  try {
    const manifest = miniManifest('equipment-inspection', { tools: [{ name: 'equipment_inspection_list_equipment', description: '設備', http: 'GET /api/equipment', access: 'read', roles: ['staff'] }] })
    const registered = new Map()
    const source = makeSource({ botId: 'S2' })
    const ctx = {
      logger: () => silentLogger,
      tools: { register: (t) => registered.set(t.name, t) },
      bridgeIdentity: { forSession: async (sid) => (sid === 'demo' ? { source, linked: true, applicationId: 'equipment-inspection' } : null), invalidate() {} },
    }
    const { generated, loaded } = apply(ctx, {
      applications: [
        { id: 'care-billing', default: true, apiUrl: env.care.url, serviceToken: 'svc-care', paths: 'legacy' },
        { id: 'equipment-inspection', apiUrl: env.demo.url, serviceToken: 'svc-demo', manifest, generateTools: true, bots: [{ platform: 'slack', botId: 'S2' }] },
      ],
      manifestRefreshSeconds: 0,
    })
    await loaded
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(generated, ['equipment_inspection_list_equipment'])
    const res = await registered.get('equipment_inspection_list_equipment').execute({}, exec('demo'))
    assert.equal(res.ok, true)
    // bridge-apps reads each application's AI employee profile at start-up (GET paths.aiProfile); no tool call goes to the other application
    assert.equal(env.care.calls.filter((c) => c.path !== '/api/ai/ai-profile').length, 0)
  } finally {
    await env.close()
  }
})

test('bridge-apps plugin: with bridge-tools loaded, generated tools are authorized by bridge-tools\' gate of the application (unattended delegation, report owners)', async () => {
  const env = await twoApps()
  try {
    const manifest = miniManifest('equipment-inspection', { tools: [{ name: 'equipment_inspection_list_equipment', description: '設備', http: 'GET /api/equipment', access: 'read', roles: ['staff'] }] })
    const registered = new Map()
    const asked = []
    // what @dsh-bridge/plugin-tools provides: gate(applicationId) with its own unattended policy (install.mjs --auto-task-delegate)
    const toolsGate = {
      authorize: async (tool, exec) => { asked.push([tool, exec?.agent?.session?.id ?? exec?.sessionId ?? null]); return { mode: 'delegated', delegationToken: 'dlg-unattended', applicationId: 'equipment-inspection', access: 'read', unattended: true } },
      forget() {}, forgetUser: () => 0, clear() {}, size: () => 0,
    }
    const ctx = {
      logger: () => silentLogger,
      tools: { register: (t) => registered.set(t.name, t) },
      bridgeIdentity: { forSession: async () => null, invalidate() {} },
      bridgeTools: { gate: (id) => (id === 'equipment-inspection' ? toolsGate : null) },
    }
    const { loaded } = apply(ctx, {
      applications: [
        { id: 'care-billing', default: true, apiUrl: env.care.url, serviceToken: 'svc-care', paths: 'legacy' },
        { id: 'equipment-inspection', apiUrl: env.demo.url, serviceToken: 'svc-demo', manifest, generateTools: true, bots: [{ platform: 'slack', botId: 'S2' }] },
      ],
      manifestRefreshSeconds: 0,
    })
    await loaded
    await new Promise((r) => setTimeout(r, 10))
    // an automatic-task conversation: no IM sender, so the registry-only gate would refuse it
    const res = await registered.get('equipment_inspection_list_equipment').execute({}, exec('auto-1'))
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(asked.length, 1)
    assert.equal(env.demo.callsTo('/api/equipment')[0].headers['x-delegation-token'], 'dlg-unattended')
    // bridge-apps reads each application's AI employee profile at start-up (GET paths.aiProfile); no tool call goes to the other application
    assert.equal(env.care.calls.filter((c) => c.path !== '/api/ai/ai-profile').length, 0)
  } finally {
    await env.close()
  }
})
