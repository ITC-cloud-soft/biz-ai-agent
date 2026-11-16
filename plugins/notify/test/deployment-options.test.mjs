// 既存の導入先を引き継ぐための設定：stateDomain（保存先の名前）・apiErrorPrefix（報告の errorCode）・audienceSource
// （自動タスクの報告の受信者を記録から取るか、そのたびに業務システムに解決させるか）・aiReportMessages / aiReportTargetPrefix
// （定時報告の返事と dsh-im の配信先 ID）。データは架空（設備点検）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeApiError, createBusinessApi } from '@dsh-bridge/dsh-core'
import { apply, createNotifier, stateDomains } from '../src/index.js'
import { createAiReporter, reportTargetId } from '../src/ai-report.js'
import { makeCtx, makeSource, mockStorageDomain, silentLogger, startFakeApi } from './helpers.mjs'
import { JST, WEB, equipmentRegistry, ev, fakeApi, imMock, recipient } from './env.mjs'

function memoryTable() {
  const map = new Map()
  return { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, structuredClone(v)) }, delete: async (k) => map.delete(k) }
}

test('stateDomain: every domain of the plugin is named after it (main / _ai_report / _audience)', async () => {
  assert.deepEqual(stateDomains({}), { main: 'bridge_notify', aiReport: 'bridge_notify_ai_report', audience: 'bridge_notify_audience' })
  assert.deepEqual(stateDomains({ stateDomain: 'legacy_notify' }), { main: 'legacy_notify', aiReport: 'legacy_notify_ai_report', audience: 'legacy_notify_audience' })
  const storage = mockStorageDomain()
  // a notification queued by a deployment that ran under another name
  storage.units.set('legacy_notify', {
    tables: new Map([['pending', new Map([['90:u-old', {
      eventId: 90, userId: 'u-old', type: 'inspection.overdue', template: 'inspection.overdue', params: {}, link: '/equipment/eq-0',
      identity: { platform: 'slack', externalId: 'X-u-old' }, quietHours: null, digest: false, receivedAt: Date.now() - 3600_000, attempts: 0, nextAttemptAt: null, batchKey: null,
    }]])], ['sent', new Map()], ['reports', new Map()]]),
    global: null,
  })
  const api = await fakeApi({})
  const im = imMock()
  const ctx = makeCtx({ dshIm: im.dshIm, storageDomain: storage })
  try {
    const service = apply(ctx, { apiUrl: api.url, serviceToken: 'svc', webUrl: WEB, applicationName: '設備点検', stateDomain: 'legacy_notify' })
    await service.ready
    assert.deepEqual(im.delivered.map((d) => d.key), ['notify:90:u-old'], 'the queued notification of the named domain is sent on start')
    assert.deepEqual([...storage.units.keys()].sort(), ['legacy_notify', 'legacy_notify_ai_report', 'legacy_notify_audience'])
    assert.equal(storage.units.get('legacy_notify').tables.get('sent').has('90:u-old'), true)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('apiErrorPrefix: a send that fails with a business-API error is reported as <prefix>_<status> (per application)', async () => {
  const api = await fakeApi({ 61: { type: 'inspection.overdue', recipients: [recipient('u-insp', { template: 'inspection.overdue', quietHours: null })] } })
  const im = imMock()
  im.dshIm.sendCard = async () => { throw new BridgeApiError('upstream', { status: 503, code: 'unavailable' }) }
  const clock = { t: JST(12) }
  const make = (extra) => createNotifier({
    registry: null,
    dshIm: im.dshIm,
    tables: { pending: memoryTable(), sent: memoryTable(), reports: memoryTable() },
    logger: silentLogger(),
    retryBaseMs: () => 1000,
    maxRetryMs: () => 2000,
    maxAttempts: () => 2,
    now: () => clock.t,
    random: () => 1,
    ...extra,
  })
  try {
    const registry = await equipmentRegistry(api)
    const byDefault = make({ registry })
    await byDefault.handleEvent(ev(61, 'inspection.overdue'))
    for (let i = 0; i < 3; i += 1) { clock.t += 10_000; await byDefault.flush() }
    assert.equal(api.reports.at(-1).errorCode, 'api_503')
    const custom = make({ registry, apiErrorPrefix: () => 'business_api' })
    await custom.handleEvent(ev(61, 'inspection.overdue'))
    for (let i = 0; i < 3; i += 1) { clock.t += 10_000; await custom.flush() }
    assert.equal(api.reports.at(-1).errorCode, 'business_api_503')
    const perApp = make({ registry, applicationOptions: (id) => (id === 'equipment-inspection' ? { apiErrorPrefix: 'eq_api' } : {}) })
    await perApp.handleEvent(ev(61, 'inspection.overdue'))
    for (let i = 0; i < 3; i += 1) { clock.t += 10_000; await perApp.flush() }
    assert.equal(api.reports.at(-1).errorCode, 'eq_api_503')
  } finally {
    await api.close()
  }
})

test('audienceSource resolve: the recipients of an auto-task report are resolved by the business system at report time (nothing recorded)', async () => {
  let recipients = [recipient('u9', { template: 'inspection.overdue', quietHours: null }), recipient('u8', { template: 'inspection.overdue', quietHours: null })]
  const api = await fakeApi((id) => (id === 11 ? { type: 'inspection.overdue', recipients } : null))
  const im = imMock()
  const tables = { pending: memoryTable(), sent: memoryTable(), reports: memoryTable(), audiences: memoryTable() }
  const registry = await equipmentRegistry(api)
  const n = createNotifier({
    registry, dshIm: im.dshIm, tables, logger: silentLogger(), honorQuietHours: () => false,
    applicationOptions: () => ({ audienceSource: 'resolve' }),
  })
  try {
    await n.handleEvent(ev(11, 'inspection.overdue'))
    assert.equal([...tables.audiences.entries()].length, 0, 'not recorded')
    recipients = [recipient('u7', { template: 'inspection.overdue', quietHours: null })] // the business system now answers someone else
    const before = im.delivered.length
    const out = await n.deliverAudience({
      task: { id: 'pb_x', name: '点検期限超過のフォロー', applicationId: 'equipment-inspection', audience: { rule: 'assignee_and_managers' } },
      run: { runId: 'r1', eventType: 'inspection.overdue', eventId: '11', dedupeKey: '11' },
      report: { status: 'done', summary: '【ご報告】確認しました。' },
      text: '【ご報告】確認しました。',
      idempotencyKey: 'auto-tasks:pb_x:k:11:audience:',
    })
    assert.equal(out.handled, true)
    assert.deepEqual(im.delivered.slice(before).map((d) => d.targetId), ['X-u7'], 'resolved at report time')
    assert.equal(api.forEventCalls().length, 2)
  } finally {
    await api.close()
  }
})

test('aiReportMessages / aiReportTargetPrefix: the replies and the dsh-im target id of an existing deployment', async () => {
  assert.match(reportTargetId({ platform: 'weixin', userId: 'wx-1' }, 'legacy-report'), /^legacy-report-[0-9a-f]{16}$/)
  assert.equal(reportTargetId({ platform: 'weixin', userId: 'wx-1' }, 'legacy-report').slice(-16), reportTargetId({ platform: 'weixin', userId: 'wx-1' }).slice(-16))
  assert.match(reportTargetId({ platform: 'weixin', userId: 'wx-1' }, 'bad prefix!'), /^bridge-report-/, 'an invalid prefix falls back')
  const api = await startFakeApi((req) => {
    if (req.path === '/bridge/v1/identity') {
      if (req.query.userId === 'wx-admin') return { body: { ok: true, linked: true, user: { id: 'u-admin', role: 'admin' } } }
      if (req.query.userId === 'wx-staff') return { body: { ok: true, linked: true, user: { id: 'u-staff', role: 'inspector' } } }
      return { body: { ok: true, linked: false } }
    }
    if (req.path === '/api/report/settings') return { body: { ok: true, enabled: true, times: [], timeZone: 'Asia/Tokyo' } }
    return { status: 404, body: { error: 'not_found' } }
  })
  const targets = []
  const r = createAiReporter({
    api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc', label: 'test API' }), paths: { reportSettings: '/api/report/settings' },
    dshIm: { listTargets: async () => targets, createTarget: async (botId, t) => { targets.push({ botId, ...t }); return t } },
    proactive: () => ({ state: async () => ({ alarms: [] }), action: async () => ({ ok: true }) }),
    logger: silentLogger(),
    messages: () => ({ notLinked: '未連携です（独自）。', role: '役割が足りません（独自）。', noTimes: '時刻が未設定です（独自）。' }),
    targetPrefix: () => 'legacy-report',
  })
  const admin = makeSource({ platform: 'weixin', botId: 'W1', teamId: undefined, userId: 'wx-admin', conversationId: 'wx-admin' })
  try {
    assert.equal(await r.handleCommand('定時報告 オン', makeSource({ platform: 'weixin', userId: 'wx-nobody' })), '未連携です（独自）。')
    assert.equal(await r.handleCommand('定時報告 オン', makeSource({ platform: 'weixin', userId: 'wx-staff' })), '役割が足りません（独自）。')
    await r.noteInbound({ sessionId: 'sess-admin', source: admin, text: 'こんにちは' })
    assert.equal(await r.handleCommand('定時報告 オン', admin), '時刻が未設定です（独自）。')
  } finally {
    await api.close()
  }
})
