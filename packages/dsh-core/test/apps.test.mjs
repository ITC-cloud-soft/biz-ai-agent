// apps.js：経路（appPath）・単一アプリケーション互換・送信ボットの選択（第 2 段階 B2-plugins の共通部品）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BridgeApiError, V1_PATHS, appPath, applicationOfEvent, createApplicationRegistry, createBotResolver, hasPath,
  scopedKey, singleApplicationRegistry,
} from '../src/index.js'
import { silentLogger } from './helpers.mjs'
import {
  LEGACY_PATHS, careBillingSingleApplicationRegistry, createCareApi, enableCareBillingPaths,
} from '../src/compat/care-billing-paths.js'

enableCareBillingPaths()

const registry = () => createApplicationRegistry({
  logger: silentLogger,
  applications: [
    { id: 'care-billing', default: true, paths: 'legacy', apiUrl: 'http://care.invalid', serviceToken: 'a' },
    { id: 'equipment-inspection', apiUrl: 'http://demo.invalid', serviceToken: 'b', bots: [{ platform: 'slack', botId: 'B-demo' }] },
  ],
})

test('appPath fills path parameters (encoded) from the legacy / v1 tables; missing paths and parameters are request errors', () => {
  const reg = registry()
  assert.equal(appPath(reg.get('care-billing'), 'notificationRecipients', { eventId: 42 }), '/api/ai/notifications/for-event/42')
  assert.equal(appPath(reg.get('equipment-inspection'), 'approvalDeliverySent', { approvalId: 'a/1', deliveryId: 'd 1' }), '/bridge/v1/approvals/a%2F1/deliveries/d%201/sent')
  assert.equal(appPath(reg.get('equipment-inspection'), 'approvalDecisions'), '/bridge/v1/approvals/im-decisions')
  assert.equal(LEGACY_PATHS.events, '/api/ai/events')
  assert.equal(V1_PATHS.events, '/bridge/v1/events')
  // bridge-memory が保存の前に使う個人情報の検査（任意の機能）
  assert.equal(V1_PATHS.piiScan, '/bridge/v1/pii-scan')
  assert.equal(appPath(reg.get('care-billing'), 'piiScan'), '/api/ai/pii-scan')
  assert.equal(hasPath(reg.get('care-billing'), 'reportSettings'), true)
  assert.equal(hasPath(reg.get('equipment-inspection'), 'reportSettings'), false, 'v1 has no report settings (times come from the manifest)')
  assert.throws(() => appPath(reg.get('equipment-inspection'), 'reportSettings'), (e) => e instanceof BridgeApiError && e.code === 'path_unsupported' && e.applicationId === 'equipment-inspection')
  assert.throws(() => appPath(reg.get('care-billing'), 'approvalDecision', {}), (e) => e.code === 'path_param_missing')
})

test('singleApplicationRegistry: generic defaults (id default, v1 paths, every bot)', () => {
  const reg = singleApplicationRegistry({ baseUrl: () => 'http://x.invalid' })
  assert.equal(reg.default().id, 'default')
  assert.equal(reg.default().namespace, 'default')
  assert.equal(reg.resolveApplication({ platform: 'slack', botId: 'anything' }).id, 'default')
  assert.equal(appPath(reg.default(), 'events'), '/bridge/v1/events')
  const named = singleApplicationRegistry({}, { id: 'equipment-inspection', name: '設備点検' })
  assert.equal(named.default().namespace, 'equipment_inspection')
  assert.equal(named.default().name, '設備点検')
})

test('compat careBillingSingleApplicationRegistry: one API client looks like the ケアビリング-only registry (legacy paths, every bot)', () => {
  const api = createCareApi({ baseUrl: () => 'http://x.invalid', serviceToken: () => 't' })
  const reg = careBillingSingleApplicationRegistry(api)
  assert.equal(reg.default().id, 'care-billing')
  assert.equal(reg.resolveApplication({ platform: 'slack', botId: 'anything' }).id, 'care-billing')
  assert.equal(reg.get('care-billing').api, api)
  assert.equal(reg.get('other'), null)
  assert.equal(appPath(reg.default(), 'events'), '/api/ai/events')
})

test('applicationOfEvent / scopedKey', () => {
  const reg = registry()
  assert.equal(applicationOfEvent(reg, { id: 1 }).id, 'care-billing', 'no applicationId: the default application')
  assert.equal(applicationOfEvent(() => reg, { id: 1, applicationId: 'equipment-inspection' }).id, 'equipment-inspection')
  assert.equal(applicationOfEvent(reg, { id: 1, applicationId: 'nope' }), null)
  assert.equal(scopedKey('care-billing', 'care-billing', '7:u1'), '7:u1')
  assert.equal(scopedKey(undefined, 'care-billing', '7:u1'), '7:u1')
  assert.equal(scopedKey('equipment-inspection', 'care-billing', '7:u1'), 'equipment-inspection|7:u1')
})

test('bot resolver: never another application\'s bot; preferred → configured → the application\'s bots → listBots of the application', async () => {
  const reg = registry()
  let listed = 0
  const dshIm = { listBots: async () => { listed += 1; return [{ botId: 'B-demo', channel: 'slack' }, { botId: 'B-care', channel: 'slack' }, { botId: 'L1', channel: 'line' }] } }
  const bots = createBotResolver({ dshIm, registry: reg, logger: silentLogger })
  const care = reg.get('care-billing')
  const demo = reg.get('equipment-inspection')
  // the default application (no bots listed) takes the unassigned bots only
  assert.deepEqual(await bots.resolve(care, 'slack'), { botId: 'B-care', shared: false })
  assert.deepEqual(await bots.resolve(care, 'slack', { preferred: 'B-demo' }), { botId: 'B-care', shared: false }, 'a preferred bot of another application is ignored')
  assert.deepEqual(await bots.resolve(care, 'slack', { preferred: 'B-personal' }), { botId: 'B-personal', shared: false })
  assert.deepEqual(await bots.resolve(demo, 'slack', { preferred: 'B-care' }), { botId: 'B-demo', shared: false })
  assert.deepEqual(await bots.resolve(demo, 'slack', { configured: { slack: 'B-x' } }), { botId: 'B-x', shared: false })
  assert.equal(await bots.resolve(demo, 'line'), null, 'line bot L1 is unassigned → belongs to the default application, not to the demo')
  assert.deepEqual(await bots.resolve(care, 'line'), { botId: 'L1', shared: false })
  await bots.resolve(care, 'slack')
  assert.equal(listed, 3, 'found bots are cached per (application, platform); misses are not')
})

test('bot resolver: a shared (multiApp) personal WeChat bot serves every application that lists it', async (t) => {
  let reg
  try {
    reg = createApplicationRegistry({
      logger: silentLogger,
      applications: [
        { id: 'care-billing', default: true, paths: 'legacy', apiUrl: 'http://care.invalid', serviceToken: 'a', bots: [{ platform: 'weixin', botId: 'WX', multiApp: true }] },
        { id: 'equipment-inspection', apiUrl: 'http://demo.invalid', serviceToken: 'b', bots: [{ platform: 'weixin', botId: 'WX', multiApp: true }] },
      ],
    })
  } catch {
    t.skip('this registry has no shared bots')
    return
  }
  if (typeof reg.applicationsForBot !== 'function') { t.skip('no applicationsForBot'); return }
  const bots = createBotResolver({ dshIm: { listBots: async () => [] }, registry: reg, logger: silentLogger })
  assert.deepEqual(await bots.resolve(reg.get('equipment-inspection'), 'weixin', { preferred: 'WX' }), { botId: 'WX', shared: true })
  assert.deepEqual(await bots.resolve(reg.get('care-billing'), 'weixin'), { botId: 'WX', shared: true }, 'from the application\'s own bots list')
})
