import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V1_PATHS, apply, createApplicationRegistry, parseSessionKey, sessionKey } from '../src/index.js'
import { silentLogger, startFakeApi } from './helpers.mjs'
import { LEGACY_PATHS, enableCareBillingPaths, legacyRegistry } from '../src/compat/care-billing-paths.js'

enableCareBillingPaths()

const TWO_APPS = [
  { id: 'care-billing', name: 'ケアビリング', default: true, apiUrl: 'http://care.invalid', serviceToken: 'svc-care', paths: 'legacy', namespace: 'care' },
  { id: 'equipment-inspection', name: 'デモ', apiUrl: 'http://demo.invalid', serviceToken: 'svc-demo', bots: [{ platform: 'wecom-app', botId: 'W2' }, { platform: 'slack', botId: 'S2' }] },
]

test('bot → application comes from config only; the default application takes unassigned bots', () => {
  const reg = createApplicationRegistry({ applications: TWO_APPS, logger: silentLogger })
  assert.deepEqual(reg.ids(), ['care-billing', 'equipment-inspection'])
  assert.equal(reg.resolveApplication({ platform: 'wecom-app', botId: 'W2' }).id, 'equipment-inspection')
  assert.equal(reg.resolveApplication({ platform: 'slack', botId: 'S2' }).id, 'equipment-inspection')
  assert.equal(reg.resolveApplication({ platform: 'slack', botId: 'B1' }).id, 'care-billing', 'catch-all default')
  assert.equal(reg.resolveApplication({ platform: 'line', botId: 'W2' }).id, 'care-billing', 'platform must match too')
  assert.equal(reg.default().id, 'care-billing')
  assert.equal(reg.get('equipment-inspection').namespace, 'equipment_inspection')
  assert.deepEqual(reg.get('care-billing').paths, LEGACY_PATHS)
  assert.deepEqual(reg.get('equipment-inspection').paths, V1_PATHS)
})

test('strict registry (or a default with explicit bots) leaves unassigned bots without an application', () => {
  const strict = createApplicationRegistry({ applications: TWO_APPS, strict: true, logger: silentLogger })
  assert.equal(strict.resolveApplication({ platform: 'slack', botId: 'B1' }), null)
  assert.equal(strict.resolveApplication({ platform: 'wecom-app', botId: 'W2' }).id, 'equipment-inspection')
  const explicit = createApplicationRegistry({
    applications: [{ ...TWO_APPS[0], bots: [{ platform: 'slack', botId: 'B1' }] }, TWO_APPS[1]], logger: silentLogger,
  })
  assert.equal(explicit.resolveApplication({ platform: 'line', botId: 'L9' }), null)
  assert.equal(explicit.resolveApplication({ platform: 'slack', botId: 'B1' }).id, 'care-billing')
  const noDefault = createApplicationRegistry({ applications: [TWO_APPS[1], { id: 'other-app', apiUrl: 'http://o.invalid' }], logger: silentLogger })
  assert.equal(noDefault.default(), null)
  assert.equal(noDefault.resolveApplication({ platform: 'slack', botId: 'B1' }), null)
})

test('invalid registries are refused at start-up', () => {
  assert.throws(() => createApplicationRegistry({ applications: [{ id: 'Bad Id' }] }), /id must match/)
  assert.throws(() => createApplicationRegistry({ applications: [{ id: 'a-app' }, { id: 'a-app' }] }), /registered twice/)
  assert.throws(() => createApplicationRegistry({
    applications: [{ id: 'a-app', bots: [{ platform: 'slack', botId: 'B' }] }, { id: 'b-app', bots: [{ platform: 'slack', botId: 'B' }] }],
  }), /assigned to both/)
  assert.throws(() => createApplicationRegistry({ applications: [{ id: 'a-app', default: true }, { id: 'b-app', default: true }] }), /more than one default/)
  assert.throws(() => createApplicationRegistry({ applications: [{ id: 'a-app', bots: [{ platform: 'slack' }] }] }), /needs platform and botId/)
})

test('apiUrlEnv / serviceTokenEnv are read per call; each application only sends its own token', async () => {
  const care = await startFakeApi(() => ({ body: { ok: true, who: 'care' } }))
  const demo = await startFakeApi(() => ({ body: { ok: true, who: 'demo' } }))
  process.env.B2_TEST_DEMO_URL = demo.url
  process.env.B2_TEST_DEMO_TOKEN = 'svc-demo-1'
  try {
    const reg = createApplicationRegistry({
      applications: [
        { id: 'care-billing', apiUrl: care.url, serviceToken: 'svc-care', paths: 'legacy' },
        { id: 'equipment-inspection', apiUrlEnv: 'B2_TEST_DEMO_URL', serviceTokenEnv: 'B2_TEST_DEMO_TOKEN', bots: [{ platform: 'slack', botId: 'S2' }] },
      ],
      logger: silentLogger,
    })
    assert.equal((await reg.get('equipment-inspection').api.get('/ping')).who, 'demo')
    process.env.B2_TEST_DEMO_TOKEN = 'svc-demo-2'
    await reg.get('equipment-inspection').api.get('/ping')
    assert.deepEqual(demo.calls.map((c) => c.headers['x-service-token']), ['svc-demo-1', 'svc-demo-2'])
    assert.equal((await reg.get('care-billing').api.get('/ping')).who, 'care')
    assert.equal(care.calls[0].headers['x-service-token'], 'svc-care')
    assert.equal(reg.describe()[1].hasServiceToken, true)
    assert.equal(JSON.stringify(reg.describe()).includes('svc-'), false, 'describe() never shows tokens')
  } finally {
    delete process.env.B2_TEST_DEMO_URL
    delete process.env.B2_TEST_DEMO_TOKEN
    await care.close()
    await demo.close()
  }
})

test('compat legacyRegistry (careBillingRegistry): plugin config first, then CARE_API_URL / CARE_SERVICE_TOKEN per call, then the old default URL', () => {
  const prevUrl = process.env.CARE_API_URL
  const prevToken = process.env.CARE_SERVICE_TOKEN
  try {
    delete process.env.CARE_API_URL
    let configured = ''
    const reg = legacyRegistry({ apiUrl: () => configured })
    const app = reg.default()
    assert.equal(app.id, 'care-billing')
    assert.equal(app.catchAll, true)
    assert.equal(app.apiUrl(), 'http://127.0.0.1:8788')
    process.env.CARE_API_URL = 'http://env.invalid:1/'
    assert.equal(app.apiUrl(), 'http://env.invalid:1')
    configured = 'http://cfg.invalid:2'
    assert.equal(app.apiUrl(), 'http://cfg.invalid:2')
    process.env.CARE_SERVICE_TOKEN = 'from-env'
    assert.equal(app.hasServiceToken(), true)
    assert.equal(app.label, 'care-api')
  } finally {
    if (prevUrl === undefined) delete process.env.CARE_API_URL
    else process.env.CARE_API_URL = prevUrl
    if (prevToken === undefined) delete process.env.CARE_SERVICE_TOKEN
    else process.env.CARE_SERVICE_TOKEN = prevToken
  }
})

test('unattended delegation policy per application', () => {
  const reg = createApplicationRegistry({
    applications: [{ id: 'care-billing', apiUrl: 'http://c.invalid', delegation: { unattendedPolicy: 'delegate', unattendedOnBehalfOf: { platform: 'line', userId: 'Ux' } } }],
  })
  assert.deepEqual(reg.default().unattended(), { policy: 'delegate', onBehalfOf: { platform: 'line', userId: 'Ux' }, delegates: {} })
  const off = createApplicationRegistry({ applications: [{ id: 'care-billing', apiUrl: 'http://c.invalid' }] })
  assert.deepEqual(off.default().unattended(), { policy: 'deny', onBehalfOf: null, delegates: {} })
  // per delegation class (unattendedDelegates): only with unattendedPolicy delegate
  const classes = { planning: { platform: 'line', userId: 'Up' }, inspector: 'each' }
  const per = createApplicationRegistry({ applications: [{ id: 'care-billing', apiUrl: 'http://c.invalid', delegation: { unattendedPolicy: 'delegate', unattendedDelegates: classes } }] })
  assert.deepEqual(per.default().unattended(), { policy: 'delegate', onBehalfOf: null, delegates: classes })
  const denied = createApplicationRegistry({ applications: [{ id: 'care-billing', apiUrl: 'http://c.invalid', delegation: { unattendedPolicy: 'deny', unattendedDelegates: classes } }] })
  assert.deepEqual(denied.default().unattended().delegates, {})
})

test('session key = (application, platform, bot, conversation)', () => {
  const source = { platform: 'weixin', botId: 'W1', userId: 'wx-u', conversationId: 'wx-u' }
  const a = sessionKey({ applicationId: 'care-billing', source })
  const b = sessionKey({ applicationId: 'equipment-inspection', source })
  assert.notEqual(a, b)
  assert.deepEqual(parseSessionKey(a), { applicationId: 'care-billing', platform: 'weixin', botId: 'W1', conversationKey: 'wx-u' })
  const slack = sessionKey({ applicationId: 'care-billing', platform: 'slack', botId: 'B:1', conversationKey: 'T1/C:9' })
  assert.deepEqual(parseSessionKey(slack), { applicationId: 'care-billing', platform: 'slack', botId: 'B:1', conversationKey: 'T1/C:9' })
  assert.throws(() => sessionKey({ platform: 'slack', botId: 'B', conversationKey: 'c' }), /applicationId is required/)
  assert.equal(parseSessionKey('nope'), null)
})

test('bridge-apps plugin provides ctx.bridgeApps and loads manifests', async () => {
  const ctx = { logger: () => silentLogger }
  const disposers = []
  ctx.on = (event, fn) => { if (event === 'dispose') disposers.push(fn) }
  const { registry, loaded } = apply(ctx, {
    applications: [{ id: 'example-app', apiUrl: 'http://127.0.0.1:1', manifestFile: 'pkg:@dsh-bridge/protocol/manifests/example.manifest.yaml' }],
    manifestRefreshSeconds: 0,
  })
  await loaded
  assert.equal(ctx.bridgeApps, registry)
  assert.equal(registry.size(), 1)
  assert.equal(registry.default().manifest().system.id, 'example-app')
  assert.deepEqual(registry.default().describe().id, 'example-app')
  assert.equal(registry.default().manifestInfo().source, 'file')
  for (const fn of disposers) fn()
})
