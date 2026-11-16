// 1 つの DSH に 2 つの業務アプリケーション（設備点検＋備品予約。架空）。受信者・本人設定はそのイベントのアプリケーションの API、
// 送信はそのアプリケーションのボット、結果の報告もそのアプリケーションへ。AI 社員の定時報告は会話のアプリケーションに結び付く。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/index.js'
import { AI_REPORT_MARKER, createAiReporter } from '../src/ai-report.js'
import { cardText, makeSource, silentLogger } from './helpers.mjs'
import { equipmentRegistry, fakeApi } from './env.mjs'

const JST = (h, m = 0) => Date.UTC(2026, 9, 27, h - 9, m)
const ALL_DAY = { start: '00:00', end: '23:59', timeZone: 'Asia/Tokyo' }
const GREETING = /^(おはようございます|お疲れさまです|夜分に失礼します)。/
const BOOKING_PATHS = {
  notificationRecipients: '/api/bridge/notifications/for-event/{eventId}',
  notificationDeliveries: '/api/bridge/notifications/deliveries',
  identity: '/api/bridge/identity',
}

function memoryTable() {
  const map = new Map()
  return { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, structuredClone(v)) }, delete: async (k) => map.delete(k), map }
}

function im() {
  const sent = []
  return {
    sent,
    dshIm: {
      listBots: async () => [{ botId: 'B-eq', channel: 'slack' }, { botId: 'B-booking', channel: 'slack' }, { botId: 'W-booking', channel: 'wecom-app' }],
      async sendCard(input) { sent.push(input); return { messageRef: `ref-${sent.length}`, delivered: true, deduped: false } },
      listTargets: async () => [],
      createTarget: async (botId, target) => target,
    },
  }
}

/** 備品予約の文面モジュール（manifest の無いアプリケーションの業務の文面。拡張点の見本）。 */
const bookingTemplates = {
  templates: {
    'reservation.overdue': ({ count, params }) => ({
      title: '返却期限の超過',
      text: `返却期限を過ぎた予約が ${count > 1 ? count : (Number.isInteger(params.count) ? params.count : 1)} 件あります。`,
      intent: 'action',
      ask: '業務 Web の「予約」で返却の状況を確認してください。',
    }),
  },
  types: ['reservation.overdue'],
}

async function setup() {
  const eq = await fakeApi({
    11: {
      type: 'inspection.overdue',
      recipients: [
        // the link was made through the booking bot: equipment must not send from another application's bot
        { userId: 'u9', identity: { platform: 'slack', externalId: 'X-u9', botId: 'B-booking' }, template: 'inspection.overdue', params: { count: 2, daysOverdue: 3, dueOn: '2026-10-24', name: '氏名' }, link: '/equipment/e1', quietHours: null },
        { userId: 'u8', identity: { platform: 'slack', externalId: 'X-u8' }, template: 'inspection.overdue', params: { count: 1, daysOverdue: 1, dueOn: '2026-10-26' }, link: null, quietHours: ALL_DAY },
      ],
    },
  }, { token: 'svc-eq', extra: (req) => {
    if (req.path === '/bridge/v1/identity') return { body: { ok: true, linked: req.query.userId === 'U-admin', user: { id: 'eq-admin', role: 'manager' } } }
    return null
  } })
  const booking = await fakeApi({
    11: { type: 'reservation.overdue', recipients: [{ userId: 'u1', identity: { platform: 'slack', externalId: 'X-u1' }, template: 'reservation.overdue', params: { count: 1 }, link: '/reservations/r1', quietHours: null }] },
  }, { token: 'svc-booking', prefix: '/api/bridge', extra: (req) => {
    if (req.path === '/api/bridge/identity') return { body: { ok: true, linked: req.query.userId === 'U-admin', user: { id: 'booking-admin', role: 'admin' } } }
    return null
  } })
  const registry = await equipmentRegistry(eq, { serviceToken: 'svc-eq', default: false, bots: [{ platform: 'slack', botId: 'B-eq' }] }, [
    { id: 'facility-booking', name: '備品予約', namespace: 'booking', default: true, apiUrl: booking.url, serviceToken: 'svc-booking', paths: BOOKING_PATHS,
      bots: [{ platform: 'slack', botId: 'B-booking' }, { platform: 'wecom-app', botId: 'W-booking' }] },
  ])
  return { eq, booking, registry, close: async () => { await eq.close(); await booking.close() } }
}

test('recipients from the event\'s application, sent from that application\'s bot, reported back to it; keys do not collide', async () => {
  const env = await setup()
  const messenger = im()
  const clock = { t: JST(12) }
  const tables = { pending: memoryTable(), sent: memoryTable(), reports: memoryTable(), audiences: memoryTable() }
  const n = createNotifier({
    registry: env.registry, dshIm: messenger.dshIm, tables, logger: silentLogger(), now: () => clock.t, random: () => 1,
    webUrl: () => 'https://booking.example.test',
    templateModules: () => [{ application: 'facility-booking', module: { ...bookingTemplates, render: null } }],
    applicationOptions: (id) => (id === 'equipment-inspection' ? { webUrl: 'https://facility.example.test' } : {}),
  })
  try {
    assert.deepEqual(await n.handleEvent({ id: 11, type: 'reservation.overdue', applicationId: 'facility-booking' }), { queued: 1 })
    assert.deepEqual(await n.handleEvent({ id: 11, type: 'inspection.overdue', applicationId: 'equipment-inspection' }), { queued: 2 })
    assert.deepEqual(await n.handleEvent({ id: 12, type: 'inspection.overdue', applicationId: 'facility-booking' }), { queued: 0 }, 'not declared by the booking application')
    assert.equal(env.booking.calls.filter((c) => c.path.startsWith('/api/bridge/notifications/for-event/')).length, 1)
    assert.equal(env.eq.calls.filter((c) => c.path === '/bridge/v1/notifications/for-event/11').length, 1)
    // pending: the default application keeps its key; the other is prefixed
    assert.ok(tables.pending.map.has('11:u8') === false && tables.pending.map.has('equipment-inspection|11:u8'), 'u8 waits for its quiet hours')
    await n.flush()
    assert.deepEqual(messenger.sent.map((s) => [s.botId, s.to.userId, s.idempotencyKey, s.applicationId ?? null]), [
      ['B-booking', 'X-u1', 'notify:11:u1', null],
      ['B-eq', 'X-u9', 'notify:equipment-inspection:11:u9', 'equipment-inspection'],
    ])
    const eqCard = messenger.sent[1].card
    // manifest の templates.inspection.overdue：intent action → 【対応のお願い】、action → 「▶ お願いしたいこと」、署名はアプリ名
    assert.equal(eqCard.title, '【対応のお願い】点検期限の超過')
    assert.equal(cardText(eqCard), [
      '【対応のお願い】点検期限の超過',
      'お疲れさまです。点検期限を 3 日過ぎた設備があります（期限 2026-10-24）。あなたの確認対象の未点検は 2 件です。',
      '▶ お願いしたいこと：担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。',
      '業務 Web を開いて対応: https://facility.example.test/equipment/e1',
      '— 設備点検 AI 秘書',
    ].join('\n'))
    assert.ok(!/氏名/.test(cardText(eqCard)), 'undeclared / unsafe params never reach the text')
    // the booking application has no manifest: its own template module writes the text (the extension point)
    assert.equal(cardText(messenger.sent[0].card), [
      '【対応のお願い】返却期限の超過',
      'お疲れさまです。返却期限を過ぎた予約が 1 件あります。',
      '▶ お願いしたいこと：業務 Web の「予約」で返却の状況を確認してください。',
      '業務 Web を開いて対応: https://booking.example.test/reservations/r1',
      '— 備品予約 AI 秘書',
    ].join('\n'))
    // reports go to the application that resolved the recipients (its own paths)
    assert.deepEqual(env.booking.reports.map((r) => [r.userId, r.eventIds, r.status]), [['u1', [11], 'sent']])
    assert.deepEqual(env.eq.reports.map((r) => [r.userId, r.eventIds, r.status]), [['u9', [11], 'sent']])
    // per-application quiet hours (decided by the equipment application for u8): deferred
    assert.equal(n.status().pending, 1)
    assert.equal(n.status().deferred, 1)
    assert.equal(n.status().duplicates, 0, 'the same event id of the other application is not a duplicate')
  } finally {
    await env.close()
  }
})

test('playbook audience: an auto-task report goes to the recipients the application resolved for the event', async () => {
  const env = await setup()
  const messenger = im()
  const tables = { pending: memoryTable(), sent: memoryTable(), reports: memoryTable(), audiences: memoryTable() }
  const n = createNotifier({ registry: env.registry, dshIm: messenger.dshIm, tables, logger: silentLogger(), honorQuietHours: () => false })
  try {
    await n.handleEvent({ id: 11, type: 'inspection.overdue', applicationId: 'equipment-inspection' })
    assert.deepEqual(tables.audiences.get('equipment-inspection|11').recipients.map((r) => r.userId), ['u9', 'u8'])
    const before = messenger.sent.length
    const out = await n.deliverAudience({
      task: { id: 'pb_equipment-inspection_overdue_followup', name: '【設備点検】点検期限超過のフォロー', applicationId: 'equipment-inspection', audience: { rule: 'assignee_and_managers' } },
      run: { runId: 'run-1', eventType: 'inspection.overdue', eventId: '11', dedupeKey: 'equipment-inspection:11' },
      report: { id: 'rp1', status: 'needsDecision' },
      text: '🙋 期限超過 2 件。設備責任者が点検日を確認してください。',
      idempotencyKey: 'auto-tasks:pb_equipment-inspection_overdue_followup:k:equipment-inspection:11:audience:',
    })
    assert.equal(out.handled, true)
    const cards = messenger.sent.slice(before)
    assert.deepEqual(cards.map((c) => [c.botId, c.to.userId, c.idempotencyKey]), [
      ['B-eq', 'X-u9', 'auto-tasks:pb_equipment-inspection_overdue_followup:k:equipment-inspection:11:audience::u:u9'],
      ['B-eq', 'X-u8', 'auto-tasks:pb_equipment-inspection_overdue_followup:k:equipment-inspection:11:audience::u:u8'],
    ])
    assert.deepEqual(out.results.map((r) => [r.userId, r.ok]), [['u9', true], ['u8', true]])
    // no summary: the auto-tasks header / icon is dropped and the label comes from the status (needsDecision → 対応のお願い)
    assert.equal(cards[0].card.title, '【対応のお願い】点検期限超過のフォロー')
    const lines = cardText(cards[0].card).split('\n')
    assert.match(lines[1], GREETING)
    assert.equal(lines[1].replace(GREETING, ''), '期限超過 2 件。設備責任者が点検日を確認してください。')
    assert.equal(lines.at(-1), '— 設備点検 AI 秘書')
    assert.ok(!cardText(cards[0].card).includes('🙋'))
    // the AI summary already starts with a secretary label: that line is the heading
    const framed = await n.deliverAudience({
      task: { id: 'pb_equipment-inspection_overdue_followup', name: '点検期限超過のフォロー', applicationId: 'equipment-inspection' },
      run: { runId: 'run-2', eventType: 'inspection.overdue', eventId: '11', dedupeKey: 'equipment-inspection:11:2' },
      report: { id: 'rp2', status: 'done', summary: '【ご報告】期限超過の設備は点検済みでした。\nご対応は不要です。' },
      text: '✅ **点検期限超過のフォロー**\n\n【ご報告】期限超過の設備は点検済みでした。\nご対応は不要です。',
      idempotencyKey: 'auto-tasks:pb:k:2:audience:',
    })
    assert.equal(framed.handled, true)
    const done = messenger.sent.at(-1).card
    assert.equal(done.title, '【ご報告】期限超過の設備は点検済みでした。')
    assert.match(cardText(done), /^【ご報告】期限超過の設備は点検済みでした。\n(おはようございます|お疲れさまです|夜分に失礼します)。ご対応は不要です。\n— 設備点検 AI 秘書$/)
    // no event (cron run), an unknown application or a type that is not notified: not handled (auto-tasks uses the task's channels)
    assert.equal((await n.deliverAudience({ task: { id: 't', applicationId: 'equipment-inspection' }, run: null, text: 'x' })).handled, false)
    assert.equal((await n.deliverAudience({ task: { id: 't', applicationId: 'nope' }, run: { eventId: '11' }, text: 'x' })).handled, false)
    assert.deepEqual(await n.deliverAudience({ task: { id: 't', applicationId: 'equipment-inspection' }, run: { eventId: '99', eventType: 'proposal.reviewed' }, text: 'x' }), { handled: false, reason: 'not_notified' })
  } finally {
    await env.close()
  }
})

test('AI report is bound to the conversation\'s application: identity, role, times (settings or manifest cron) and prompt per application', async () => {
  const env = await setup()
  const alarms = []
  const proactive = {
    async state(sessionId) { return { alarms: alarms.filter((a) => a.sessionId === sessionId) } },
    async action(action, sessionId) {
      if (action.kind === 'create') alarms.push({ id: `al-${alarms.length + 1}`, sessionId, prompt: action.args.prompt, cron: action.args.cron, state: 'scheduled', args: action.args })
      if (action.kind === 'cancel') { const a = alarms.find((x) => x.id === action.id); if (a) a.state = 'cancelled' }
      return { ok: true }
    },
  }
  const messenger = im()
  const r = createAiReporter({
    registry: env.registry, dshIm: messenger.dshIm, proactive: () => proactive, logger: silentLogger(),
    applicationOptions: (id) => (id === 'facility-booking' ? { aiReportPrompt: '予約の状況を報告してください。', aiReportRoles: ['admin'] } : {}),
  })
  const bookingAdmin = makeSource({ platform: 'slack', botId: 'B-booking', userId: 'U-admin', conversationId: 'D-booking' })
  const eqAdmin = makeSource({ platform: 'slack', botId: 'B-eq', userId: 'U-admin', conversationId: 'D-eq' })
  try {
    await r.noteInbound({ sessionId: 'sess-booking', source: bookingAdmin })
    await r.noteInbound({ sessionId: 'sess-eq', source: eqAdmin })
    assert.match(await r.handleCommand('定時報告 オン', eqAdmin), /オンにしました（毎日 08:30/)
    // the booking application has neither report settings nor a manifest
    assert.match(await r.handleCommand('定時報告 オン', bookingAdmin), /報告の時刻がまだ設定されていません/)
    const eqAlarms = alarms.filter((a) => a.sessionId === 'sess-eq' && a.state === 'scheduled')
    assert.deepEqual(eqAlarms.map((a) => a.cron), ['30 8 * * *'], 'from the manifest reports.*.cron')
    assert.ok(eqAlarms[0].prompt.startsWith(AI_REPORT_MARKER))
    assert.match(eqAlarms[0].prompt, /facility_list_overdue/)
    // identity looked up at each application's API
    assert.equal(env.eq.calls.filter((c) => c.path === '/bridge/v1/identity').length, 1)
    assert.equal(env.booking.calls.filter((c) => c.path === '/api/bridge/identity').length, 1)
    // owners: the non-default conversation carries its application (the tools-sdk gate checks it)
    assert.deepEqual(r.ownerOf('sess-eq'), { platform: 'slack', teamId: 'T1', userId: 'U-admin', botId: 'B-eq', applicationId: 'equipment-inspection' })
    assert.match(await r.handleCommand('定時報告 オフ', eqAdmin), /オフにしました/)
    assert.equal(r.ownerOf('sess-eq'), null)
  } finally {
    await env.close()
  }
})
