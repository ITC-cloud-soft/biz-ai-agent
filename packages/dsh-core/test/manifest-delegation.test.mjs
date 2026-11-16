import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkManifest, createApplicationRegistry, createDelegationCache, resolveManifestFile } from '../src/index.js'
import { miniManifest, silentLogger, startFakeApi } from './helpers.mjs'
import { enableCareBillingPaths } from '../src/compat/care-billing-paths.js'

enableCareBillingPaths()
const EXAMPLE_MANIFEST = 'pkg:@dsh-bridge/protocol/manifests/example.manifest.yaml'

test('the bundled example manifest resolves through pkg: and validates', () => {
  const file = resolveManifestFile(EXAMPLE_MANIFEST)
  assert.match(file.replaceAll('\\', '/'), /protocol\/manifests\/example\.manifest\.yaml$/)
  const reg = createApplicationRegistry({ applications: [{ id: 'example-app', apiUrl: 'http://x.invalid', manifestFile: EXAMPLE_MANIFEST }] })
  return reg.get('example-app').refreshManifest().then((m) => {
    assert.equal(m.system.id, 'example-app')
    assert.ok(m.tools.some((t) => t.name === 'example_app_list_reports'))
  })
})

test('manifestUrl: etag + If-None-Match (304 keeps the cached manifest); invalid and foreign manifests are refused', async () => {
  let doc = miniManifest('equipment-inspection', { version: 'v1' })
  let etag = '"v1"'
  const api = await startFakeApi((req) => {
    if (req.path !== '/bridge/v1/manifest') return null
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { ok: false, error: 'service_token_required' } }
    if (req.headers['if-none-match'] === etag) return { status: 304, headers: { etag } }
    return { body: doc, headers: { etag, 'bridge-protocol': '1' } }
  })
  try {
    const reg = createApplicationRegistry({
      applications: [{ id: 'equipment-inspection', apiUrl: api.url, serviceToken: 'svc', manifestUrl: '/bridge/v1/manifest' }],
      logger: silentLogger,
    })
    const app = reg.get('equipment-inspection')
    assert.equal((await app.refreshManifest()).version, 'v1')
    assert.equal(app.manifestInfo().etag, '"v1"')
    await app.refreshManifest()
    assert.equal(api.calls[1].headers['if-none-match'], '"v1"')
    assert.equal(app.manifest().version, 'v1')

    // 壊れた manifest → 前のものを使い続ける
    doc = { bridge: 1, system: { id: 'equipment-inspection' } }
    etag = '"broken"'
    await app.refreshManifest()
    assert.equal(app.manifest().version, 'v1')
    assert.match(app.manifestInfo().lastError, /invalid/)

    // 他のアプリケーションの manifest は受け付けない
    doc = miniManifest('care-billing', { version: 'v9' })
    etag = '"foreign"'
    await app.refreshManifest()
    assert.equal(app.manifest().version, 'v1')
    assert.match(app.manifestInfo().lastError, /not for application "equipment-inspection"/)

    doc = miniManifest('equipment-inspection', { version: 'v2' })
    etag = '"v2"'
    assert.equal((await app.refreshManifest()).version, 'v2')
    assert.equal(app.manifestInfo().lastError, null)
  } finally {
    await api.close()
  }
})

test('manifestUrl not served (404 / unreachable) → bundled manifestFile', async () => {
  const api = await startFakeApi(() => ({ status: 404, body: { ok: false, error: 'not_found' } }))
  try {
    const reg = createApplicationRegistry({
      applications: [{ id: 'example-app', apiUrl: api.url, serviceToken: 'svc', paths: 'legacy', manifestUrl: '/bridge/v1/manifest', manifestFile: EXAMPLE_MANIFEST }],
      logger: silentLogger,
    })
    const m = await reg.default().refreshManifest()
    assert.equal(m.system.id, 'example-app')
    assert.equal(reg.default().manifestInfo().source, 'file')
    assert.match(reg.default().manifestInfo().lastError, /404/)
  } finally {
    await api.close()
  }
  assert.equal(checkManifest(miniManifest('x-app'), { applicationId: 'y-app' }).valid, false)
})

test('delegation cache is keyed by (application, source): a token of A is never returned for B', async () => {
  let t = 1_000_000
  const cache = createDelegationCache({ now: () => t })
  const source = { platform: 'slack', teamId: 'T1', userId: 'U1', botId: 'B1' }
  const mints = []
  const mint = (app) => async (body) => { mints.push({ app, body }); return { token: `dlg-${app}-${mints.length}`, user: { id: `emp-${app}` }, expiresAt: new Date(t + 300_000).toISOString() } }
  const a = await cache.get('care-billing', source, mint('care'))
  const b = await cache.get('equipment-inspection', source, mint('demo'))
  assert.equal(a.token, 'dlg-care-1')
  assert.equal(b.token, 'dlg-demo-2')
  assert.equal(a.applicationId, 'care-billing')
  assert.equal(b.applicationId, 'equipment-inspection')
  assert.deepEqual(mints[0].body, { source: { platform: 'slack', userId: 'U1', teamId: 'T1' } })
  assert.equal((await cache.get('care-billing', source, mint('care'))).token, 'dlg-care-1', 'cached')
  // 解除は職員 ID の名前空間（アプリケーション）ごと
  assert.equal(cache.forgetUser('emp-care', 'slack', 'equipment-inspection'), 0)
  assert.equal(cache.forgetUser('emp-care', 'slack', 'care-billing'), 1)
  assert.equal(cache.size(), 1)
  // 期限 30 秒前から取り直す・業務システムの expiresAt が長くても 5 分で切る
  t += 300_000 - 20_000
  assert.equal((await cache.get('equipment-inspection', source, mint('demo'))).token, 'dlg-demo-3')
  const long = await cache.get('x-app', source, async () => ({ token: 'tok-long', user: { id: 'e' }, expiresAt: new Date(t + 3_600_000).toISOString() }))
  assert.equal(long.expiresAt, t + 300_000)
  await assert.rejects(cache.get('y-app', source, async () => ({ token: '' })), /returned no delegation token/)
  await assert.rejects(cache.get('', source, async () => ({ token: 'x' })), /no application/)
  assert.equal(cache.forgetApplication('equipment-inspection'), 1)
})

test('concurrent delegation requests for the same (application, source) share one mint', async () => {
  const cache = createDelegationCache()
  let n = 0
  const mint = async () => { n += 1; await new Promise((r) => setTimeout(r, 10)); return { token: `t${n}`, user: { id: 'e' }, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
  const [x, y] = await Promise.all([cache.get('a-app', { platform: 'line', userId: 'U' }, mint), cache.get('a-app', { platform: 'line', userId: 'U' }, mint)])
  assert.equal(n, 1)
  assert.equal(x.token, y.token)
})
