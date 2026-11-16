// bridge-notify の汎用エンジン：受信者は業務システム、文面は manifest の templates（AI 秘書の形）。データは架空（設備点検）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createNotifier, inject, name } from '../src/index.js'
import { quietUntil } from '../src/quiet-hours.js'
import { renderManifestMessage } from '../src/templates.js'
import { makeCtx, mockStorageDomain, silentLogger, waitFor } from './helpers.mjs'
import {
  ASK, JST, MIN, QUIET, SEC, WEB, equipmentRegistry, ev, fakeApi, fallback, imMock, openTables, plain, recipient,
} from './env.mjs'

async function notifier(api, im, tables, clock, extra = {}) {
  return createNotifier({
    registry: await equipmentRegistry(api),
    dshIm: im.dshIm,
    tables,
    logger: silentLogger(),
    webUrl: () => WEB,
    retryBaseMs: () => 1000,
    maxRetryMs: () => 8000,
    maxAttempts: () => 3,
    now: () => clock.t,
    random: () => 1,
    ...extra,
  })
}

const overdue = (userId, o = {}) => recipient(userId, { template: 'inspection.overdue', params: { count: 2, daysOverdue: 3, dueOn: '2026-10-22' }, ...o })

test('metadata', () => {
  assert.equal(name, 'bridge-notify')
  assert.deepEqual(inject, ['dshIm', 'storageDomain'])
})

test('a manifest-notified event is sent at once with idempotencyKey notify:<eventId>:<userId>, then reported', async () => {
  const api = await fakeApi({ 11: { type: 'inspection.overdue', recipients: [overdue('u-insp', { link: '/equipment/eq-1' })] } })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock, { platformPriority: () => ['line', 'slack'] })
    assert.deepEqual(await n.handleEvent(ev(11, 'inspection.overdue')), { queued: 1 })
    assert.equal(api.forEventCalls()[0].query.platforms, 'line,slack')
    assert.deepEqual(im.delivered, [{
      botId: 'B-slack', targetId: 'X-u-insp', key: 'notify:11:u-insp',
      text: fallback('【対応のお願い】点検期限の超過', ['お疲れさまです。点検期限を 3 日過ぎた設備があります（期限 2026-10-22）。あなたの確認対象の未点検は 2 件です。', ASK.overdue], `${WEB}/equipment/eq-1`),
    }])
    assert.deepEqual(im.via, ['card'], 'default: sendCard to the user (no registered target needed)')
    assert.equal(im.state.unknownTarget, 0)
    assert.deepEqual(api.reports, [{ userId: 'u-insp', eventIds: [11], status: 'sent', channel: 'slack', messageRef: 'ref-notify:11:u-insp' }])
    assert.equal(n.status().pending, 0)
    // types neither declared in the manifest nor configured are ignored without calling the API
    assert.deepEqual(await n.handleEvent(ev(12, 'proposal.reviewed')), { queued: 0 })
    assert.equal(api.forEventCalls().length, 1)
  } finally {
    await api.close()
  }
})

test('digestTypes: the realtime digest per recipient and type (15 s settle); one message, max eventId as key', async () => {
  const done = () => ({ type: 'inspection.completed', recipients: [
    recipient('u-mgr', { template: 'inspection.completed', params: { count: 1 } }),
    recipient('u-admin', { template: 'inspection.completed', params: { count: 1 }, platform: 'line' }),
  ] })
  const api = await fakeApi({ 21: done(), 22: done(), 23: done(), 24: { type: 'inspection.overdue', recipients: [overdue('u-mgr')] } })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock, { digestTypes: () => ['inspection.completed', 'inspection.overdue'] })
    await n.handleEvent(ev(21, 'inspection.completed'))
    clock.t += 5 * SEC
    await n.handleEvent(ev(22, 'inspection.completed'))
    await n.handleEvent(ev(24, 'inspection.overdue'))
    clock.t += 5 * SEC
    await n.handleEvent(ev(23, 'inspection.completed'))
    assert.equal(im.delivered.length, 0, 'nothing while the run of events continues')
    assert.equal(n.status().pending, 7)

    // the overdue one (alone, at 12:00:05) is due at 12:00:20; the completed run (last at 12:00:10) at 12:00:25
    clock.t = JST(12) + 20 * SEC
    await n.flush()
    assert.deepEqual(im.delivered.map((d) => d.key), ['notify:24:u-mgr'])
    clock.t = JST(12) + 24 * SEC
    await n.flush()
    assert.equal(im.delivered.length, 1)
    clock.t = JST(12) + 25 * SEC
    await n.flush()
    const byKey = Object.fromEntries(im.delivered.slice(1).map((d) => [d.key, d]))
    assert.deepEqual(Object.keys(byKey).sort(), ['notify:23:u-admin', 'notify:23:u-mgr'])
    assert.equal(byKey['notify:23:u-mgr'].text, fallback('【ご報告】点検の完了',
      ['お疲れさまです。3 件まとめてお知らせします。', '点検が 3 件完了しました。', ASK.info], `${WEB}/equipment/eq-1`))
    assert.equal(byKey['notify:23:u-admin'].botId, 'B-line')
    assert.deepEqual(api.reports.find((r) => r.userId === 'u-mgr' && r.eventIds.length === 3).eventIds, [21, 22, 23])
    assert.equal(api.reports.length, 3)
    assert.equal(n.status().pending, 0)
  } finally {
    await api.close()
  }
})

test('a long burst of a realtime digest is capped by realtimeDigestSeconds', async () => {
  const api = await fakeApi(() => ({ type: 'inspection.completed', recipients: [recipient('u-mgr', { template: 'inspection.completed', params: { count: 1 }, quietHours: null })] }))
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(11) }
  try {
    const n = await notifier(api, im, tables, clock, { digestTypes: () => ['inspection.completed'] })
    let id = 10
    const start = clock.t
    while (clock.t - start < 125 * SEC) {
      await n.handleEvent(ev(id, 'inspection.completed'))
      id += 1
      clock.t += 10 * SEC
      await n.flush()
    }
    assert.equal(im.delivered.length, 1, 'one message within 120 s of the first event although events keep coming every 10 s')
    assert.match(im.delivered[0].text, /12 件まとめてお知らせします。\n点検が 12 件完了しました。/)
  } finally {
    await api.close()
  }
})

test('fixed digest windows: manifest notify.digestMinutes, overridden by digestWindows (0 = no merging)', async () => {
  const repair = () => ({ type: 'repair.requested', recipients: [recipient('u-mgr', { template: 'repair.requested', params: { count: 1 }, quietHours: null })] })
  const api = await fakeApi({ 31: repair(), 32: repair(), 33: repair() })
  const im = imMock()
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, (await openTables(mockStorageDomain())).tables, clock)
    await n.handleEvent(ev(31, 'repair.requested'))
    clock.t += 10 * MIN
    await n.handleEvent(ev(32, 'repair.requested'))
    clock.t = JST(12, 29)
    await n.flush()
    assert.equal(im.delivered.length, 0, 'the manifest declares digestMinutes: 30')
    clock.t = JST(12, 30)
    await n.flush()
    assert.equal(im.delivered.length, 1)
    assert.match(im.delivered[0].text, /^【対応のお願い】修理依頼の起票\nお疲れさまです。2 件まとめてお知らせします。\n修理依頼が 2 件届いています。/)

    const im2 = imMock()
    const n2 = await notifier(api, im2, (await openTables(mockStorageDomain())).tables, clock, { digestWindows: () => ({ 'repair.requested': 0 }) })
    await n2.handleEvent(ev(33, 'repair.requested'))
    assert.deepEqual(im2.delivered.map((d) => d.key), ['notify:33:u-mgr'], 'digestWindows 0: sent at once')
  } finally {
    await api.close()
  }
})

test('quiet hours defer until their end; a quiet-exempt event (manifest notify.quiet: exempt) goes out at night', async () => {
  const api = await fakeApi({
    31: { type: 'inspection.overdue', recipients: [overdue('u-insp')] },
    32: { type: 'equipment.failure_reported', recipients: [
      recipient('u-insp', { template: 'equipment.failure', params: { reportedAt: '20:45' } }),
      recipient('u-mgr', { template: 'equipment.failure', params: { reportedAt: '20:45' } }),
    ] },
  })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(21, 1) }
  try {
    const n = await notifier(api, im, tables, clock)
    await n.handleEvent(ev(31, 'inspection.overdue'))
    await n.handleEvent(ev(32, 'equipment.failure_reported'))
    assert.deepEqual(im.delivered.map((d) => d.key).sort(), ['notify:32:u-insp', 'notify:32:u-mgr'])
    // おやすみ時間の対象外の夜の送信：あいさつは「夜分に失礼します」、【至急】
    assert.equal(im.delivered[0].text, fallback('【至急】設備の故障', ['夜分に失礼します。設備の故障が報告されました（20:45）。', ASK.failure], `${WEB}/equipment/eq-1`))
    const st = n.status()
    assert.equal(st.pending, 1)
    assert.equal(st.deferredNow, 1)
    clock.t = JST(7, 59, 26)
    await n.flush()
    assert.equal(im.delivered.length, 2)
    clock.t = JST(8, 0, 26)
    await n.flush()
    assert.equal(im.delivered[2].key, 'notify:31:u-insp')
    assert.match(im.delivered[2].text, /^【対応のお願い】点検期限の超過\nおはようございます。点検期限を 3 日過ぎた設備があります/)
  } finally {
    await api.close()
  }
})

test('quiet hours turned off: a new event of the same digest goes out with the deferred ones instead of waiting for the morning', async () => {
  let quiet = QUIET // the person's setting, answered by the business system per event
  const api = await fakeApi(() => ({ type: 'inspection.completed', recipients: [recipient('u-mgr', { template: 'inspection.completed', params: { count: 1 }, quietHours: quiet })] }))
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock({ failNext: 1 })
  const clock = { t: JST(21) }
  try {
    const n = await notifier(api, im, tables, clock, { digestTypes: () => ['inspection.completed'] })
    await n.handleEvent(ev(71, 'inspection.completed'))
    clock.t += 20 * SEC
    await n.flush()
    assert.equal(n.status().deferredNow, 1, 'deferred to 08:00 while quiet hours are on')
    await n.handleEvent(ev(72, 'inspection.completed'))
    clock.t += 20 * SEC
    await n.flush()
    assert.equal(n.status().pending, 2)
    assert.equal(im.state.calls, 0, 'still quiet: the new event waits with the first one')

    quiet = null // the person turns quiet hours off
    await n.handleEvent(ev(73, 'inspection.completed'))
    clock.t += 20 * SEC
    await n.flush()
    assert.equal(im.state.calls, 1, 'sent at once (the send fails once)')
    assert.equal(n.status().pending, 3)
    await n.flush()
    assert.equal(im.state.calls, 1, 'a send failure still waits for its retry time')
    clock.t += 1000
    await n.flush()
    assert.equal(im.delivered.length, 1)
    assert.match(im.delivered[0].text, /3 件まとめてお知らせします。/)
    assert.equal(n.status().pending, 0)
  } finally {
    await api.close()
  }
})

test('restart: queued, deferred and unreported notifications survive in DSH storage and resume', async () => {
  const api = await fakeApi({
    41: { type: 'inspection.overdue', recipients: [overdue('u-insp')] },
    42: { type: 'inspection.completed', recipients: [recipient('u-mgr', { template: 'inspection.completed', params: { count: 1 }, quietHours: null })] },
    43: { type: 'equipment.failure_reported', recipients: [recipient('u-mgr2', { template: 'equipment.failure', params: { reportedAt: '22:00' } })] },
  }, { failReports: 1 })
  const storage = mockStorageDomain()
  const im = imMock()
  const clock = { t: JST(22) }
  try {
    const first = await openTables(storage)
    const n1 = await notifier(api, im, first.tables, clock, { digestTypes: () => ['inspection.completed'] })
    await n1.handleEvent(ev(41, 'inspection.overdue')) // deferred (quiet hours)
    await n1.handleEvent(ev(42, 'inspection.completed')) // digest window open
    await n1.handleEvent(ev(43, 'equipment.failure_reported')) // sent, but the report to the business API fails
    assert.equal(im.delivered.length, 1)
    assert.equal(api.reports.length, 0)
    assert.equal(n1.status().reportsPending, 1)
    await first.domain.close() // process stops

    clock.t = JST(8, 1, 26)
    const second = await openTables(storage)
    const n2 = await notifier(api, im, second.tables, clock, { digestTypes: () => ['inspection.completed'] })
    assert.equal(n2.status().pending, 2)
    await n2.flush()
    assert.deepEqual(im.delivered.map((d) => d.key).sort(), ['notify:41:u-insp', 'notify:42:u-mgr', 'notify:43:u-mgr2'])
    assert.deepEqual(api.reports.map((r) => r.eventIds[0]).sort(), [41, 42, 43])
    assert.equal(n2.status().pending, 0)
    assert.equal(n2.status().reportsPending, 0)
    await second.domain.close()
  } finally {
    await api.close()
  }
})

test('idempotent: failed sends retry with the same key (no double message); redelivered events and re-resolution do not resend', async () => {
  const api = await fakeApi({ 51: { type: 'inspection.overdue', recipients: [overdue('u-insp', { quietHours: null })] } })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock({ failNext: 1, failAfterDeliver: true }) // the provider got it, the answer was lost
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock)
    await n.handleEvent(ev(51, 'inspection.overdue'))
    assert.equal(im.delivered.length, 1)
    assert.equal(n.status().retrying, 1)
    assert.equal(api.reports.length, 0)
    await n.handleEvent(ev(51, 'inspection.overdue')) // bridge-events at-least-once
    assert.equal(n.status().pending, 1)
    assert.equal(n.status().duplicates, 1)
    clock.t += 1000
    await n.flush()
    assert.equal(im.state.calls, 2)
    assert.equal(im.delivered.length, 1, 'retried with the same idempotencyKey -> deduped by dsh-im')
    assert.equal(n.status().deduped, 1)
    assert.deepEqual(api.reports.map((r) => [r.status, r.eventIds]), [['sent', [51]]])
    await n.handleEvent(ev(51, 'inspection.overdue'))
    await n.flush()
    assert.equal(im.state.calls, 2)
  } finally {
    await api.close()
  }
})

test('gives up after maxAttempts and reports failed; the API unreachable -> throw (bridge-events retries); 404 -> skipped', async () => {
  const api = await fakeApi({
    61: { type: 'inspection.overdue', recipients: [overdue('u-insp', { quietHours: null })] },
    62: { type: 'inspection.overdue', status: 503 },
  })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock({ failNext: 99 })
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock)
    await n.handleEvent(ev(61, 'inspection.overdue'))
    for (let i = 0; i < 5; i += 1) {
      clock.t += 10_000
      await n.flush()
    }
    assert.equal(im.state.calls, 3)
    assert.deepEqual(api.reports, [{ userId: 'u-insp', eventIds: [61], status: 'failed', channel: 'slack', errorCode: 'timeout' }])
    assert.equal(n.status().failed, 1)
    assert.equal(n.status().pending, 0)

    await assert.rejects(() => n.handleEvent(ev(62, 'inspection.overdue')), /HTTP 503/)
    assert.deepEqual(await n.handleEvent(ev(63, 'inspection.overdue')), { queued: 0 })
  } finally {
    await api.close()
  }
})

test('bot choice: the personal bot of the link first, then config, then listBots; no bot -> retried', async () => {
  const api = await fakeApi({
    71: { type: 'inspection.overdue', recipients: [
      overdue('u-a', { quietHours: null, platform: 'weixin', botId: 'W-personal' }),
      overdue('u-b', { quietHours: null, platform: 'teams' }),
      overdue('u-c', { quietHours: null, platform: 'telegram' }),
    ] },
  })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock, { bots: () => ({ teams: 'T-org' }) })
    await n.handleEvent(ev(71, 'inspection.overdue'))
    assert.deepEqual(im.delivered.map((d) => [d.targetId, d.botId]).sort(), [['X-u-a', 'W-personal'], ['X-u-b', 'T-org']])
    assert.equal(n.status().retrying, 1, 'telegram has no bot: kept and retried')
  } finally {
    await api.close()
  }
})

test('manifest templates use numbers / dates / times only, even if the business API sent something else', async () => {
  const api = await fakeApi({})
  try {
    const registry = await equipmentRegistry(api)
    const manifest = registry.get('equipment-inspection').manifest()
    const NOON = JST(14)
    const m = renderManifestMessage(manifest, { template: 'inspection.overdue', type: 'inspection.overdue', count: 1, params: { daysOverdue: '氏名の文字列', dueOn: '倉庫の奥', count: 2 }, link: '/equipment/eq-1', webUrl: WEB, appName: '設備点検', now: NOON })
    assert.equal(m.body, plain('【対応のお願い】点検期限の超過', ['お疲れさまです。点検期限を — 日過ぎた設備があります（期限 —）。あなたの確認対象の未点検は 2 件です。', ASK.overdue], `${WEB}/equipment/eq-1`))
    const s = renderManifestMessage(manifest, { template: 'inspection.completed', type: 'inspection.completed', count: 2, params: { count: 1 }, link: 'javascript:alert(1)', appName: '設備点検', now: NOON })
    assert.equal(s.body, plain('【ご報告】点検の完了', ['お疲れさまです。2 件まとめてお知らせします。', '点検が 2 件完了しました。', ASK.info]), 'count raised to the bundle; unsafe link dropped')
    assert.equal(renderManifestMessage(manifest, { template: 'unknown.thing', type: 'unknown.thing', count: 1, appName: '設備点検', now: NOON }).body,
      plain('【ご報告】設備点検', ['お疲れさまです。業務 Web に新しいお知らせがあります。', ASK.info]))
    assert.equal(renderManifestMessage(null, { template: 'x', type: 'x', count: 1, appName: '設備点検', now: NOON }).title, '【ご報告】設備点検')
  } finally {
    await api.close()
  }
})

test('quietUntil: [start, end) in Asia/Tokyo, across midnight or not', () => {
  assert.equal(quietUntil(JST(21, 30), QUIET), JST(8, 0, 26))
  assert.equal(quietUntil(JST(3, 15), QUIET), JST(8, 0))
  assert.equal(quietUntil(JST(8, 0), QUIET), null)
  assert.equal(quietUntil(JST(19, 59), QUIET), null)
  assert.equal(quietUntil(JST(20, 0), QUIET), JST(8, 0, 26))
  assert.equal(quietUntil(JST(12, 30), { start: '12:00', end: '13:00' }), JST(13, 0))
  assert.equal(quietUntil(JST(13, 0), { start: '12:00', end: '13:00' }), null)
  assert.equal(quietUntil(JST(21), null), null)
  assert.equal(quietUntil(JST(21), { start: 'x', end: '08:00' }), null)
})

test('apply(): subscribes to bridge-events (notifyTypes + manifest notify), persists in DSH storage and flushes due work on start', async () => {
  const api = await fakeApi({
    81: { type: 'inspection.overdue', recipients: [overdue('u-insp', { quietHours: null })] },
    82: { type: 'repair.completed', recipients: [recipient('u-insp', { template: 'repair.completed', quietHours: null })] },
  })
  const storage = mockStorageDomain()
  const im = imMock()
  const subscribers = []
  const manifestSubscribers = []
  const bridgeEvents = {
    subscribe: (types, handler) => { subscribers.push({ types, handler }); return () => {} },
    subscribeManifestNotify: (handler) => { manifestSubscribers.push(handler); return () => {} },
  }
  // a notification left over from a previous run (due long ago)
  const pre = await openTables(storage)
  await pre.tables.pending.put('80:u-old', {
    eventId: 80, userId: 'u-old', type: 'inspection.overdue', template: 'inspection.overdue', params: {}, link: '/equipment/eq-0',
    identity: { platform: 'slack', externalId: 'X-u-old' }, quietHours: null, digest: false, receivedAt: Date.now() - 3600_000, attempts: 0, nextAttemptAt: null, batchKey: null,
  })
  await pre.domain.close()
  const ctx = makeCtx({ dshIm: im.dshIm, storageDomain: storage, bridgeEvents })
  try {
    const service = apply(ctx, { apiUrl: api.url, serviceToken: 'svc', webUrl: WEB, applicationName: '設備点検', notifyTypes: ['repair.completed'] })
    await service.ready
    assert.deepEqual(im.delivered.map((d) => d.key), ['notify:80:u-old'])
    assert.equal(ctx.bridgeNotify, service)
    assert.deepEqual(subscribers[0].types, ['repair.completed'])
    assert.equal(manifestSubscribers.length, 1)
    assert.equal(manifestSubscribers[0], subscribers[0].handler, 'the same handler: bridge-events delivers once')
    // without a registry there is no manifest: a configured type renders the default text with the application name
    await subscribers[0].handler(ev(82, 'repair.completed'))
    await waitFor(() => im.delivered.length === 2)
    assert.equal(im.delivered[1].key, 'notify:82:u-insp')
    assert.match(im.delivered[1].text, /^【ご報告】設備点検\n.*業務 Web に新しいお知らせがあります。[\s\S]*— 設備点検 AI 秘書$/)
    // a manifest-declared type is not notified here (no manifest in the plugin-config application)
    assert.deepEqual(await manifestSubscribers[0](ev(81, 'inspection.overdue')), { queued: 0 })
    const status = await service.status()
    assert.equal(status.persistent, true)
    assert.equal(status.messages, 2)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('verification settings: honorQuietHours false ignores quiet hours; digestMinutes 0 sends everything at once; digestMinutes caps fixed windows', async () => {
  const api = await fakeApi({ 91: { type: 'inspection.completed', recipients: [recipient('u-mgr', { template: 'inspection.completed', params: { count: 1 } })] } })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock()
  const clock = { t: JST(23) }
  try {
    const n = await notifier(api, im, tables, clock, { honorQuietHours: () => false })
    await n.handleEvent(ev(91, 'inspection.completed'))
    assert.deepEqual(im.delivered.map((d) => d.key), ['notify:91:u-mgr'])
    // digestMinutes 0 (verification): even a digest type and a manifest window go out at once
    const repair = await fakeApi({ 92: { type: 'repair.requested', recipients: [recipient('u-mgr', { template: 'repair.requested', params: { count: 1 }, quietHours: null })] } })
    try {
      const im2 = imMock()
      const n2 = await notifier(repair, im2, (await openTables(mockStorageDomain())).tables, clock, { digestMs: () => 0, digestTypes: () => ['repair.requested'] })
      await n2.handleEvent(ev(92, 'repair.requested'))
      assert.deepEqual(im2.delivered.map((d) => d.key), ['notify:92:u-mgr'])
      // a cap shorter than the manifest window (30 min) shortens it
      const im3 = imMock()
      const n3 = await notifier(repair, im3, (await openTables(mockStorageDomain())).tables, clock, { digestMs: () => 5 * MIN })
      await n3.handleEvent(ev(92, 'repair.requested'))
      assert.equal(im3.delivered.length, 0)
      clock.t += 5 * MIN
      await n3.flush()
      assert.equal(im3.delivered.length, 1)
    } finally {
      await repair.close()
    }
  } finally {
    await api.close()
  }
})

test('deliveryMode text: send to a registered target; unknown-target falls back to sendCard with the same key', async () => {
  const api = await fakeApi({ 95: { type: 'inspection.overdue', recipients: [overdue('u-reg', { quietHours: null }), overdue('u-new', { quietHours: null })] } })
  const { tables } = await openTables(mockStorageDomain())
  const im = imMock({ targets: ['B-slack|X-u-reg'] })
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, im, tables, clock, { deliveryMode: () => 'text' })
    await n.handleEvent(ev(95, 'inspection.overdue'))
    const byTarget = Object.fromEntries(im.delivered.map((d, i) => [d.targetId, { ...d, via: im.via[i] }]))
    assert.equal(byTarget['X-u-reg'].via, 'send')
    assert.match(byTarget['X-u-reg'].text, /^【対応のお願い】点検期限の超過\n[\s\S]*こちらから開けます：https:\/\/facility\.example\.test\/equipment\/eq-1\n— 設備点検 AI 秘書$/)
    assert.equal(byTarget['X-u-new'].via, 'card')
    assert.equal(byTarget['X-u-new'].key, 'notify:95:u-new')
    assert.equal(im.state.unknownTarget, 1)
    assert.equal(n.status().cardFallbacks, 1)
    assert.equal(n.status().pending, 0)
    assert.deepEqual(api.reports.map((r) => r.status), ['sent', 'sent'])
  } finally {
    await api.close()
  }
})

test('platform priority: every supported platform by default (DEFAULT_PLATFORM_PRIORITY); more than 10 keeps the platforms with a bot first', async () => {
  const api = await fakeApi({ 31: { type: 'inspection.overdue', recipients: [overdue('u-insp')] } })
  const clock = { t: JST(12) }
  try {
    const n = await notifier(api, imMock(), (await openTables(mockStorageDomain())).tables, clock)
    await n.handleEvent(ev(31, 'inspection.overdue'))
    const asked = api.forEventCalls()[0].query.platforms.split(',')
    assert.deepEqual(asked, ['slack', 'line', 'teams', 'weixin', 'telegram', 'wecom-app', 'wecom', 'dingtalk', 'feishu', 'qq'])
    assert.ok(!asked.includes('email'), 'email is notify-only and not a default target')

    const many = ['teams', 'weixin', 'telegram', 'wecom-app', 'wecom', 'dingtalk', 'qq', 'discord', 'matrix', 'whatsapp', 'imessage', 'slack']
    const n2 = await notifier(api, imMock(), (await openTables(mockStorageDomain())).tables, clock, { platformPriority: () => many })
    await n2.handleEvent(ev(31, 'inspection.overdue'))
    const asked2 = api.forEventCalls()[1].query.platforms.split(',')
    assert.equal(asked2.length, 10)
    assert.deepEqual(asked2, ['teams', 'weixin', 'telegram', 'wecom-app', 'wecom', 'dingtalk', 'qq', 'discord', 'matrix', 'slack'], 'slack (has a bot) kept, order kept')
  } finally {
    await api.close()
  }
})
