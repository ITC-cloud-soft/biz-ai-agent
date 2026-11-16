// 届かない理由の報告（WeChat のコンテキスト無し・iLink の拒否・ボット未接続・LINE の送信上限）と、
// AI 社員の定時報告のエンジン（「定時報告 オン / オフ / テスト」→ dsh-proactive の business アラーム。時刻は業務システムの設定か manifest の cron）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi } from '@dsh-bridge/dsh-core'
import { apply, classifyDeliveryError, createNotifier } from '../src/index.js'
import {
  AI_REPORT_MARKER, commandPattern, cronOf, createAiReporter, defaultReportPrompt, deliveryDraft, reportTargetId, timesOfCron,
} from '../src/ai-report.js'
import { cardText, makeCtx, makeSource, mockDshIm, mockStorageDomain, silentLogger, startFakeApi, waitFor } from './helpers.mjs'
import { JST, WEB, equipmentRegistry, ev, fakeApi, openTables } from './env.mjs'

function weixinFailure({ context }) {
  const ilink = Object.assign(new Error('微信服务拒绝了回复消息。'), { code: 'send-rejected', providerCode: '-2' })
  const wrapped = Object.assign(new Error(`Weixin text delivery failed (endpoint=sendmessage host=ilinkai.weixin.qq.com chunk=1/1 contextToken=${context ? 'yes' : 'no'} http=2xx provider=-2 cause=send-rejected)`, { cause: ilink }),
    { code: 'send-rejected', providerCode: '-2' })
  return Object.assign(new Error('delivery-failed', { cause: wrapped }), { code: 'delivery-failed' })
}

test('classifyDeliveryError (from @dsh-bridge/dsh-core): WeChat context missing / iLink rejection / bad target / bot offline / unknown', () => {
  assert.deepEqual(classifyDeliveryError(weixinFailure({ context: false }), 'weixin'), { reason: 'weixin_context_missing', undeliverable: 'now' })
  assert.deepEqual(classifyDeliveryError(weixinFailure({ context: true }), 'weixin'), { reason: 'weixin_rejected', undeliverable: 'after-retries' })
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { code: 'invalid-target' }), 'slack'), { reason: 'invalid_target', undeliverable: 'now' })
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { code: 'bot-not-connected' }), 'weixin'), { reason: 'bot_offline', undeliverable: false })
  assert.equal(classifyDeliveryError(Object.assign(new Error('provider timeout'), { code: 'timeout' }), 'slack'), null)
})

const reportRecipient = (userId, platform = 'weixin') => ({
  userId, identity: { platform, externalId: `wx-${userId}`, botId: 'W1' }, template: 'inspection_report.ready', params: { overdue: 2, inspections: 5 }, link: '/', quietHours: null,
})

function failingIm(makeError) {
  const state = { calls: 0, delivered: [] }
  return {
    state,
    dshIm: {
      listBots: async () => [{ botId: 'W1', channel: 'weixin' }],
      async sendCard({ to, card, idempotencyKey }) {
        state.calls += 1
        const error = makeError(state.calls)
        if (error) throw error
        state.delivered.push({ to: to.userId, text: cardText(card), key: idempotencyKey })
        return { messageRef: `ref-${idempotencyKey}`, delivered: true, deduped: false }
      },
    },
  }
}

async function notifier(api, im, clock, extra = {}) {
  return createNotifier({
    registry: await equipmentRegistry(api), dshIm: im.dshIm, tables: (await openTables(mockStorageDomain())).tables, logger: silentLogger(),
    webUrl: () => WEB, now: () => clock.t, random: () => 0, retryBaseMs: () => 1000, maxRetryMs: () => 1000, maxAttempts: () => 8, ...extra,
  })
}

test('the scheduled report event is sent at once (quiet exempt); WeChat without context -> undeliverable at the first failure with the reason', async () => {
  const api = await fakeApi({ 1: { type: 'inspection_report.ready', recipients: [reportRecipient('u-admin')] }, 2: { type: 'inspection_report.ready', recipients: [reportRecipient('u-admin')] } })
  const clock = { t: JST(8, 30, 26) }
  try {
    const ok = failingIm(() => null)
    const n1 = await notifier(api, ok, clock)
    await n1.handleEvent(ev(1, 'inspection_report.ready'))
    assert.equal(ok.state.delivered.length, 1)
    assert.equal(ok.state.delivered[0].text.split('\n').slice(0, 2).join('\n'), '【ご報告】点検状況の定時報告\nおはようございます。点検状況の定時報告です（期限超過 2 件・本日の点検 5 件）。')
    assert.deepEqual(api.reports.map((r) => [r.status, r.channel]), [['sent', 'weixin']])

    const im = failingIm(() => weixinFailure({ context: false }))
    const n2 = await notifier(api, im, clock)
    await n2.handleEvent(ev(2, 'inspection_report.ready'))
    assert.equal(im.state.calls, 1, 'not retried: nothing changes until the user writes to the bot')
    assert.deepEqual(api.reports[1], { userId: 'u-admin', eventIds: [2], status: 'undeliverable', channel: 'weixin', errorCode: 'weixin_context_missing' })
    const st = n2.status()
    assert.equal(st.undeliverable, 1)
    assert.equal(st.pending, 0)
    assert.equal(st.lastUndeliverable.reason, 'weixin_context_missing')
  } finally {
    await api.close()
  }
})

test('iLink ret=-2 with a context: retried a few times, then undeliverable; bot offline: normal retries, then failed bot_offline', async () => {
  const api = await fakeApi({ 3: { type: 'inspection_report.ready', recipients: [reportRecipient('u-a')] }, 4: { type: 'inspection_report.ready', recipients: [reportRecipient('u-b')] } })
  const clock = { t: JST(12) }
  try {
    const im = failingIm(() => weixinFailure({ context: true }))
    const n = await notifier(api, im, clock)
    await n.handleEvent(ev(3, 'inspection_report.ready'))
    for (let i = 0; i < 5; i += 1) { clock.t += 2000; await n.flush() }
    assert.equal(im.state.calls, 3, 'undeliverableRetries (3) attempts')
    assert.deepEqual(api.reports.at(-1), { userId: 'u-a', eventIds: [3], status: 'undeliverable', channel: 'weixin', errorCode: 'weixin_rejected' })

    const off = failingIm(() => Object.assign(new Error('offline'), { code: 'bot-not-connected' }))
    const n2 = await notifier(api, off, clock)
    await n2.handleEvent(ev(4, 'inspection_report.ready'))
    for (let i = 0; i < 10; i += 1) { clock.t += 2000; await n2.flush() }
    assert.equal(off.state.calls, 8)
    assert.deepEqual(api.reports.at(-1), { userId: 'u-b', eventIds: [4], status: 'failed', channel: 'weixin', errorCode: 'bot_offline' })
  } finally {
    await api.close()
  }
})

test('LINE monthly push quota (HTTP 429): retry-later, never before Retry-After, then failed line_quota (not undeliverable)', async () => {
  const lineUser = `U${'b'.repeat(32)}`
  const api = await fakeApi({ 5: { type: 'inspection_report.ready', recipients: [{ ...reportRecipient('u-line', 'line'), identity: { platform: 'line', externalId: lineUser, botId: 'L1' } }] } })
  const clock = { t: JST(12) }
  const calls = []
  const im = {
    dshIm: {
      listBots: async () => [{ botId: 'L1', channel: 'line' }],
      async sendCard({ botId, to }) {
        calls.push({ botId, to: to.userId, at: clock.t })
        throw Object.assign(new Error('delivery-failed'), {
          code: 'delivery-failed',
          cause: Object.assign(new Error('line POST /v2/bot/message/push failed (HTTP 429)'), { status: 429, retryAfter: 30, body: { message: 'You have reached your monthly limit.' } }),
        })
      },
    },
  }
  try {
    const n = await notifier(api, im, clock, { maxRetryMs: () => 60_000, maxAttempts: () => 3 })
    await n.handleEvent(ev(5, 'inspection_report.ready'))
    assert.deepEqual(calls.map((c) => [c.botId, c.to]), [['L1', lineUser]])
    clock.t += 10_000
    await n.flush()
    assert.equal(calls.length, 1, 'not before Retry-After (30 s)')
    clock.t += 21_000
    await n.flush()
    assert.equal(calls.length, 2)
    clock.t += 31_000
    await n.flush()
    assert.equal(calls.length, 3)
    assert.deepEqual(api.reports.at(-1), { userId: 'u-line', eventIds: [5], status: 'failed', channel: 'line', errorCode: 'line_quota' })
    assert.equal(n.status().undeliverable, 0, 'a quota is not a bad target')
  } finally {
    await api.close()
  }
})

// ---------------------------------------------------------------- AI 社員の定時報告
function mockProactive() {
  const alarms = []
  let id = 0
  const calls = []
  return {
    alarms,
    calls,
    service: {
      contractVersion: 1,
      async state(sessionId) { return { alarms: alarms.filter((a) => a.sessionId === sessionId).map((a) => ({ ...a })) } },
      async action(action, sessionId) {
        calls.push({ action, sessionId })
        if (action.kind === 'create') {
          assert.equal(action.sessionId, sessionId)
          id += 1
          alarms.push({ id: `alarm_${id}`, sessionId, prompt: action.args.prompt, cron: action.args.cron, state: 'scheduled', args: action.args })
        } else if (action.kind === 'cancel') {
          const a = alarms.find((x) => x.id === action.id)
          a.state = 'cancelled'
        } else if (action.kind === 'fire') {
          if (!alarms.some((x) => x.id === action.id)) return { ok: false, error: { code: 'not_found', message: 'no alarm' } }
        }
        return { ok: true, snapshot: await this.state(sessionId) }
      },
    },
  }
}

/** 本人確認（/bridge/v1/identity）と、報告の時刻の設定（このアプリケーションは paths.reportSettings を持つ）。 */
async function identityApi(users, { settings = ['08:30', '17:30'] } = {}) {
  return startFakeApi((req) => {
    if (req.path === '/bridge/v1/identity') {
      const u = users[req.query.userId]
      return { body: u ? { ok: true, linked: true, user: u } : { ok: true, linked: false } }
    }
    if (req.path === '/api/report/settings') return { body: { ok: true, enabled: true, times: settings, timeZone: 'Asia/Tokyo' } }
    return { status: 404, body: { error: 'not_found' } }
  })
}

test('AI report: route / target / cron helpers', () => {
  assert.deepEqual(deliveryDraft({ platform: 'weixin', userId: 'wx-1' }), { kind: 'user', route: { toUserId: 'wx-1' } })
  assert.deepEqual(deliveryDraft({ platform: 'slack', userId: 'U1', conversationId: 'D1' }), { kind: 'conversation', route: { channelId: 'D1' } })
  assert.equal(deliveryDraft({ platform: 'teams', userId: 'x' }), null)
  assert.equal(deliveryDraft({ platform: 'email', userId: 'a@example.test', conversationId: 'a@example.test' }), null, 'email is notify-only')
  assert.equal(reportTargetId({ platform: 'weixin', userId: 'wx-1' }), reportTargetId({ platform: 'weixin', userId: 'wx-1', botId: 'other' }))
  assert.match(reportTargetId({ platform: 'weixin', userId: 'wx-1' }), /^bridge-report-[0-9a-f]{16}$/)
  assert.equal(cronOf('08:30'), '30 8 * * *')
  assert.equal(cronOf('17:05'), '5 17 * * *')
  assert.throws(() => cronOf('8:30'))
  assert.deepEqual(timesOfCron('30 8 * * *'), ['08:30'])
  assert.deepEqual(timesOfCron('0 9,15 * * *'), ['09:00', '15:00'])
  assert.deepEqual(timesOfCron('0 9 * * 1'), [])
  assert.deepEqual(timesOfCron('*/5 * * * *'), [])
  assert.equal(commandPattern('daily report').test('Daily Report on'), true)
  assert.equal(commandPattern('a.b').test('axb'), false, 'the keyword is literal')
  assert.match(defaultReportPrompt({ name: '設備点検', namespace: 'facility' }), /facility_\* のツール/)
})

test('AI report: a direct-chat delivery target for every supported platform (accepted by the vendored dsh-im when it can be loaded)', async (t) => {
  let normalizeDeliveryTarget = null
  try {
    ({ normalizeDeliveryTarget } = await import('../../../vendor/dsh-im/plugin-src/host/delivery-adapter.mjs'))
  } catch { /* the vendored dsh-im is not installed here: check the drafts only */ }
  const lineUser = `U${'a'.repeat(32)}`
  const cases = [
    [{ platform: 'weixin', userId: 'wx-1' }, { kind: 'user', route: { toUserId: 'wx-1' } }],
    [{ platform: 'telegram', userId: '42', conversationId: '42' }, { kind: 'chat', route: { chatId: '42' } }],
    [{ platform: 'slack', userId: 'U1', conversationId: 'D1' }, { kind: 'conversation', route: { channelId: 'D1' } }],
    [{ platform: 'line', userId: lineUser }, { kind: 'user', route: { userId: lineUser } }],
    [{ platform: 'dingtalk', userId: 'staff01' }, { kind: 'user', route: { userId: 'staff01' } }],
    [{ platform: 'feishu', userId: 'ou_0123456789abcdef', conversationId: 'oc_x' }, { kind: 'user', route: { openId: 'ou_0123456789abcdef' } }],
    [{ platform: 'wecom', userId: 'staff02', conversationId: 'staff02' }, { kind: 'user', route: { chatId: 'staff02' } }],
    [{ platform: 'wecom-app', userId: 'staff03', conversationId: 'staff03' }, { kind: 'user', route: { chatId: 'staff03' } }],
    [{ platform: 'teams', userId: 'aad-1', conversationId: 'a:1Xyz' }, { kind: 'conversation', route: { conversationId: 'a:1Xyz' } }],
    [{ platform: 'qq', userId: 'OPENID1', conversationId: 'OPENID1' }, { kind: 'user', route: { userOpenId: 'OPENID1' } }],
    [{ platform: 'whatsapp', userId: '810000000000@s.whatsapp.net', conversationId: '810000000000@s.whatsapp.net' }, { kind: 'user', route: { jid: '810000000000@s.whatsapp.net' } }],
    [{ platform: 'whatsapp', userId: 'Tester', conversationId: '123456789012@lid' }, { kind: 'user', route: { jid: '123456789012@lid' } }],
    [{ platform: 'matrix', userId: '@tester:example.org', conversationId: '!room:example.org' }, { kind: 'dm', route: { userId: '@tester:example.org' } }],
    [{ platform: 'discord', userId: '123456789012345678', conversationId: '987654321098765432' }, { kind: 'user', route: { userId: '123456789012345678' } }],
    [{ platform: 'imessage', userId: '+810000000000', conversationId: 'iMessage;-;+810000000000' }, { kind: 'user', route: { chatGuid: 'iMessage;-;+810000000000' } }],
  ]
  for (const [source, expected] of cases) {
    const draft = deliveryDraft(source)
    assert.deepEqual(draft, expected, source.platform)
    if (normalizeDeliveryTarget) {
      const target = { name: '定時業務報告（AI 社員）', ...draft }
      assert.deepEqual(normalizeDeliveryTarget(source.platform, target, { targetIdRequired: false }), target, `${source.platform} accepted by dsh-im`)
    }
  }
  if (!normalizeDeliveryTarget) t.diagnostic('vendored dsh-im not loadable here; the dsh-im cross-check was skipped')
  // no direct-chat address -> null (the report then only stays in the DSH conversation)
  for (const source of [
    { platform: 'teams', userId: 'aad-1' }, { platform: 'wecom', userId: '' }, { platform: 'qq' },
    { platform: 'whatsapp', userId: 'Tester', conversationId: '120363000000000000@g.us' }, { platform: 'matrix', userId: 'tester' },
    { platform: 'discord', userId: 'not-a-snowflake' }, { platform: 'imessage', userId: '+810000000000' }, { platform: 'unknown', userId: 'x' },
  ]) assert.equal(deliveryDraft(source), null, JSON.stringify(source))
})

test('AI report: 「定時報告 オン」 creates business alarms in the employee\'s own conversation (times from the business settings, IM target), idempotent; off / test / status', async () => {
  const api = await identityApi({ 'wx-admin': { id: 'u-admin', role: 'admin' }, 'wx-staff': { id: 'u-staff', role: 'inspector' } })
  const pro = mockProactive()
  const targets = []
  const dshIm = {
    listTargets: async () => targets.map((x) => ({ ...x })),
    createTarget: async (botId, target) => { targets.push({ botId, ...target }); return target },
  }
  let proactive = null
  const r = createAiReporter({
    api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc', label: 'test API' }), paths: { reportSettings: '/api/report/settings' },
    dshIm, proactive: () => proactive, logger: silentLogger(), prompt: () => '点検の状況をまとめてください。',
  })
  const admin = makeSource({ platform: 'weixin', botId: 'W1', teamId: undefined, userId: 'wx-admin', conversationId: 'wx-admin' })
  const staff = makeSource({ platform: 'weixin', botId: 'W1', teamId: undefined, userId: 'wx-staff', conversationId: 'wx-staff' })
  try {
    assert.match(await r.handleCommand('定時報告 オン', makeSource({ platform: 'weixin', userId: 'wx-nobody' })), /連携していません/)
    assert.match(await r.handleCommand('定時報告 オン', staff), /設定された役割/)
    assert.match(await r.handleCommand('定時報告 オン', admin), /一度話しかけて/)
    await r.noteInbound({ sessionId: 'sess-admin', source: admin, text: 'こんにちは' })
    await r.noteInbound({ sessionId: 'sess-group', source: { ...admin, conversationKind: 'group' }, text: 'x' })
    assert.match(await r.handleCommand('定時報告 オン', admin), /dsh-proactive/)
    proactive = pro.service
    assert.match(await r.handleCommand('定時報告 オン', { ...admin, conversationKind: 'group' }), /個別チャット/)

    const reply = await r.handleCommand('定時報告　オン', admin) // full-width space (IME)
    assert.match(reply, /オンにしました（毎日 08:30・17:30、日本時間）/)
    const live = pro.alarms.filter((a) => a.state === 'scheduled')
    assert.deepEqual(live.map((a) => [a.sessionId, a.cron]), [['sess-admin', '30 8 * * *'], ['sess-admin', '30 17 * * *']])
    for (const a of live) {
      assert.equal(a.prompt, `${AI_REPORT_MARKER}点検の状況をまとめてください。`, 'the configured prompt (the pluggable report template)')
      assert.deepEqual(
        { mode: a.args.mode, tz: a.args.time_zone, target: a.args.target_mode, quiet: a.args.respect_quiet_hours, deliver: a.args.deliver_to },
        { mode: 'business', tz: 'Asia/Tokyo', target: 'resume', quiet: false, deliver: [{ bot_id: 'W1', target_id: reportTargetId(admin) }] })
    }
    assert.deepEqual(targets, [{ botId: 'W1', targetId: reportTargetId(admin), name: '定時業務報告（AI 社員）', kind: 'user', route: { toUserId: 'wx-admin' } }])
    assert.deepEqual(r.ownerOf('sess-admin'), { platform: 'weixin', userId: 'wx-admin', botId: 'W1' })
    assert.equal(r.ownerOf('sess-other'), null)

    // again: the old alarms are replaced (still two), the target is reused
    await r.handleCommand('定時報告 on', admin)
    assert.equal(pro.alarms.filter((a) => a.state === 'scheduled').length, 2)
    assert.equal(targets.length, 1)
    assert.match(await r.handleCommand('定時報告', admin), /オンです（毎日 08:30・17:30）/)
    assert.match(await r.handleCommand('定時報告 テスト', admin), /今すぐ 1 回起動/)
    assert.equal(pro.calls.at(-1).action.kind, 'fire')
    assert.match(await r.handleCommand('定時報告 オフ', admin), /オフにしました/)
    assert.equal(pro.alarms.filter((a) => a.state === 'scheduled').length, 0)
    assert.equal(r.ownerOf('sess-admin'), null)
    assert.match(await r.handleCommand('定時報告 テスト', admin), /先に「定時報告 オン」/)
    assert.equal(await r.handleCommand('定時報告をオンにして', admin), null, 'only the exact command is claimed')
    assert.equal(r.matches('定時報告 オン'), true)
    assert.equal(r.matches('今日の定時報告は？'), false)
  } finally {
    await api.close()
  }
})

test('AI report without report settings: times from the manifest reports.*.cron, prompt from the report playbook', async () => {
  const api = await identityApi({ 'U-admin': { id: 'eq-admin', role: 'manager' } })
  const pro = mockProactive()
  try {
    const registry = await equipmentRegistry(api)
    const r = createAiReporter({ registry, dshIm: {}, proactive: () => pro.service, logger: silentLogger(), command: () => 'daily report' })
    const admin = makeSource({ platform: 'slack', botId: 'B1', userId: 'U-admin', conversationId: 'D-1' })
    await r.noteInbound({ sessionId: 'sess-1', source: admin })
    assert.equal(r.matches('定時報告 オン'), false, 'the keyword is configurable')
    assert.match(await r.handleCommand('daily report on', admin), /オンにしました（毎日 08:30、日本時間）/)
    assert.match(await r.handleCommand('daily report on', admin), /「daily report オフ」/)
    const alarm = pro.alarms.find((a) => a.state === 'scheduled')
    assert.equal(alarm.cron, '30 8 * * *')
    assert.ok(alarm.prompt.startsWith(`${AI_REPORT_MARKER}点検状況の定時報告の時刻です。facility_list_overdue`), 'the manifest report playbook instructions')
    assert.equal(alarm.args.deliver_to, undefined, 'no dsh-im targets here: the report stays in the conversation')
  } finally {
    await api.close()
  }
})

test('apply(): the IM command is claimed via dsh-im; the owner is exposed for bridge-tools', async () => {
  const api = await identityApi({ 'wx-admin': { id: 'u-admin', role: 'admin' } })
  const im = mockDshIm()
  im.dshIm.listTargets = async () => []
  im.dshIm.createTarget = async (botId, target) => target
  const pro = mockProactive()
  const ctx = makeCtx({ dshIm: im.dshIm, storageDomain: mockStorageDomain(), dshProactive: pro.service })
  // the plugin-config application has no reportSettings path in v1: give the times through a registry entry with paths
  const registry = await equipmentRegistry(api, { paths: { reportSettings: '/api/report/settings' }, bots: [{ platform: 'weixin', botId: 'W1' }] })
  const { registryService } = await import('@dsh-bridge/dsh-core')
  ctx.bridgeApps = registryService(registry)
  try {
    const service = apply(ctx, { webUrl: WEB })
    await service.ready
    const admin = makeSource({ platform: 'weixin', botId: 'W1', teamId: undefined, userId: 'wx-admin', conversationId: 'wx-admin' })
    ctx.emit('dsh-im/inbound', { sessionId: 'sess-1', source: admin, text: 'hi' })
    await waitFor(async () => (await service.status()).aiReport.owners === 0)
    assert.equal(await im.reply('こんにちは', admin), null, 'ordinary messages go to the agent')
    const replies = await im.reply('定時報告 オン', admin)
    assert.equal(replies.length, 1)
    assert.match(replies[0], /オンにしました/)
    assert.deepEqual(service.aiReportOwner('sess-1'), { platform: 'weixin', userId: 'wx-admin', botId: 'W1' })
    assert.equal((await service.status()).aiReport.owners, 1)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})
