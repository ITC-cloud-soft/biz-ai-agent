import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasTableFromOpenApi, camelRows, createMemoryStore, fillTemplate, pickAlias, POLICY, registerAliasRoutes, startScheduler } from '../src/index.mjs'
import { client, createToy, SERVICE_TOKEN } from './toy.mjs'

// An EXISTING API (pre-Bridge paths) mapped onto /bridge/v1 by aliases: same handler, same policy, v1 shape.
let toy
let call
const S = { 'x-service-token': SERVICE_TOKEN }
before(async () => {
  toy = await createToy({ store: createMemoryStore() })
  const { router } = toy.bridge
  router.add('GET', '/api/legacy/things/:id', { allow: ['service'] }, async ({ params, query, req }) => ({
    status: 200, body: { ok: true, thing: { id: params.id, mode: query.get('mode'), seen_url: req.url, created_at: 'x' } },
  }))
  router.add('GET', '/api/legacy/mine', { allow: ['user'], roles: ['admin'] }, async ({ principal }) => ({ status: 200, body: { ok: true, rows: [{ user_id: principal.user.id, team_id: 'T' }] } }))
  router.add('GET', '/api/legacy/svc-mine', { allow: ['service'] }, async () => ({ status: 200, body: { ok: true, rows: [{ user_id: 'service' }] } }))
  const result = registerAliasRoutes(router, {
    base: '/bridge/v2test',
    table: [
      { operationId: 'getThing', method: 'GET', path: '/things/{thingId}', aliases: [{ method: 'GET', path: '/api/legacy/things/{thingId}', query: { mode: 'v1' }, status: 'exact' }] },
      { operationId: 'listMine', method: 'GET', path: '/mine', aliases: [{ method: 'GET', path: '/api/legacy/mine', status: 'shape' }, { method: 'GET', path: '/api/legacy/svc-mine', for: ['service'], status: 'shape' }] },
      { operationId: 'gone', method: 'GET', path: '/gone', aliases: [{ method: 'GET', path: '/api/legacy/none', status: 'exact' }] },
      { operationId: 'missing', method: 'GET', path: '/missing', aliases: [{ method: 'GET', path: '/x', status: 'missing' }] },
    ],
    adapters: { listMine: camelRows('rows') },
  })
  assert.deepEqual(result.served, ['getThing', 'listMine'])
  assert.deepEqual(result.skipped.map((s) => s.operationId), ['gone', 'missing'])
  await toy.start()
  call = client(toy.base)
})
after(async () => { await toy?.stop() })

test('alias: v1 path -> existing route with mapped params and default query; the existing policy still applies', async () => {
  const id = '00000000-0000-4000-8000-00000000abcd'
  const r = await call('GET', `/bridge/v2test/things/${id}`, { headers: S })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual([r.body.thing.id, r.body.thing.mode], [id, 'v1'])
  assert.equal(r.body.thing.seen_url, `/api/legacy/things/${id}?mode=v1`, 'handlers reading req.url see the existing path')
  assert.equal((await call('GET', `/bridge/v2test/things/${id}`, { headers: S, query: { mode: 'other' } })).body.thing.mode, 'other')
  assert.equal((await call('GET', '/bridge/v2test/things/not-a-uuid', { headers: S })).status, 404)
  assert.equal(r.headers.get('bridge-protocol'), '1')
})

test('alias: per-principal alias (for: [service]) and a shape adapter (snake_case -> camelCase)', async () => {
  const admin = toy.addUser('admin')
  const staff = toy.addUser('staff')
  const mine = await call('GET', '/bridge/v2test/mine', { headers: admin.headers })
  assert.deepEqual(mine.body.rows, [{ userId: admin.id, teamId: 'T' }])
  assert.equal((await call('GET', '/bridge/v2test/mine', { headers: staff.headers })).body.error, 'insufficient_role', 'the existing route policy')
  assert.deepEqual((await call('GET', '/bridge/v2test/mine', { headers: S })).body.rows, [{ userId: 'service' }])
  assert.equal((await call('GET', '/bridge/v2test/mine')).body.error, 'authentication_required')
})

test('alias helpers: table from an OpenAPI extension, pickAlias, fillTemplate', () => {
  const doc = { paths: { '/identity': { get: { operationId: 'getIdentity', 'x-my-alias': [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] } } } }
  assert.deepEqual(aliasTableFromOpenApi(doc, { key: 'x-my-alias' }), [{ operationId: 'getIdentity', method: 'GET', path: '/identity', aliases: [{ method: 'GET', path: '/api/ai/identity', status: 'exact' }] }])
  const aliases = [{ path: '/a' }, { path: '/b', for: ['delegated'] }]
  assert.equal(pickAlias(aliases, 'delegated').path, '/b')
  assert.equal(pickAlias(aliases, 'user').path, '/a')
  assert.equal(fillTemplate('/x/{id}/y', { id: 'a b' }), '/x/a%20b/y')
  assert.ok(POLICY.SERVICE.allow.includes('service'))
})

test('scheduler: report slots from the manifest cron (once per day) and periodic tasks', async () => {
  let now = new Date('2026-10-27T00:30:00Z') // 09:30 in Asia/Tokyo: after the 09:00 slot
  const t = await createToy({ now: () => now })
  let runs = 0
  const logs = []
  const stop = startScheduler({ kit: t.kit, everyMs: 60_000, tasks: [{ name: 'scan', everyMinutes: 1, run: async () => { runs += 1 } }, { name: 'bad', run: async () => { throw new Error('nope') } }], log: (l) => logs.push(l) })
  await stop.firstTick
  stop()
  assert.equal(runs, 1)
  assert.ok(logs.some((l) => /bad: nope/.test(l)))
  const r = await t.kit.reports.latest()
  assert.deepEqual([r.slot, r.date], ['09:00', '2026-10-27'])
  assert.equal(await t.kit.reports.generate({ slot: '09:00' }), null, 'the slot is stored once')
  now = new Date('2026-10-27T23:30:00Z') // next day 08:30: before the slot
  const stop2 = startScheduler({ kit: t.kit, everyMs: 60_000 })
  await stop2.firstTick
  stop2()
  assert.equal((await t.kit.reports.latest()).date, '2026-10-27')
})

test('alias: the care-api table (examples/care-billing/manifest/care-api-v1-aliases.json, v1 form rows) maps onto existing routes', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const file = new URL('../../../examples/care-billing/manifest/care-api-v1-aliases.json', import.meta.url)
  if (!existsSync(file)) return
  const table = JSON.parse(readFileSync(file, 'utf8'))
  const { createRouter } = await import('../src/index.mjs')
  // a stand-in for care-api: one stub route per alias path (":param" form)
  const legacy = createRouter()
  const seen = new Set()
  for (const row of table) {
    for (const a of row.aliases) {
      const key = `${a.method} ${a.path}`
      if (a.status === 'missing' || seen.has(key) || a.path.startsWith('/bridge/v1/') || a.path === '/health') continue
      seen.add(key)
      legacy.add(a.method, a.path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'), { allow: ['service', 'user', 'delegated'] }, async ({ params }) => ({ status: 200, body: { ok: true, from: key, params } }))
    }
  }
  const router = createRouter()
  const result = registerAliasRoutes(router, { table, from: legacy, skip: ['getHealth', 'getManifest'] })
  const expected = table.filter((r) => !['getHealth', 'getManifest'].includes(r.operationId) && r.aliases.some((a) => a.status !== 'missing')).map((r) => r.operationId)
  assert.deepEqual(result.served.sort(), expected.sort())
  const m = router.match('GET', '/bridge/v1/identity')
  assert.ok(m?.route, 'GET /bridge/v1/identity is routed')
  const out = await m.route.handler({ principal: { kind: 'service' }, req: { url: '/bridge/v1/identity?platform=slack', headers: {} }, query: new URLSearchParams('platform=slack'), params: {}, kit: { config: {} } })
  assert.equal(out.body.from, 'GET /api/ai/identity')
})
