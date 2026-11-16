// N1b: 定時報告の宛先の保証（dsh-proactive の守卫）と、自動タスクの報告の固定の文面・固定の配信先に回さない設定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi } from '@dsh-bridge/dsh-core'
import { applicationOptionsFrom, apply, audienceTemplate, createNotifier } from '../src/index.js'
import { AI_REPORT_MARKER, createAiReporter, reportTargetId, reportTemplate } from '../src/ai-report.js'
import { makeCtx, makeSource, mockDshIm, mockStorageDomain, silentLogger, startFakeApi } from './helpers.mjs'
import { JST, WEB, equipmentRegistry, openTables } from './env.mjs'

function mockProactive() {
  const alarms = []
  let id = 0
  const guards = { wake: null, delivery: null }
  return {
    alarms,
    guards,
    service: {
      contractVersion: 1,
      async state(sessionId) { return { alarms: alarms.filter((a) => a.sessionId === sessionId && a.state !== 'gone').map((a) => ({ ...a })) } },
      async action(action, sessionId) {
        if (action.kind === 'create') {
          id += 1
          alarms.push({ id: `alarm_${id}`, sessionId, prompt: action.args.prompt, cron: action.args.cron, state: 'scheduled', mode: action.args.mode, args: action.args })
        } else if (action.kind === 'cancel') {
          const a = alarms.find((x) => x.id === action.id)
          if (a) a.state = 'cancelled'
        }
        return { ok: true }
      },
      setWakeGuard(fn) { guards.wake = fn; return () => { guards.wake = null } },
      setDeliveryGuard(fn) { guards.delivery = fn; return () => { guards.delivery = null } },
    },
  }
}

/** /bridge/v1/identity（users は userId → user。呼ぶたびに読み直すので、途中で役割・在職を変えられる）。 */
async function identityApi(users) {
  return startFakeApi((req) => {
    if (req.path === '/bridge/v1/identity') {
      const u = users[req.query.userId]
      return { body: u ? { ok: true, linked: true, user: u } : { ok: true, linked: false } }
    }
    if (req.path === '/api/report/settings') return { body: { ok: true, enabled: true, times: ['08:30'], timeZone: 'Asia/Tokyo' } }
    return { status: 404, body: { error: 'not_found' } }
  })
}

const admin = makeSource({ platform: 'weixin', botId: 'W1', teamId: undefined, userId: 'wx-admin', conversationId: 'wx-admin' })

async function enabledReporter({ users, options = {}, guardMode, proactiveDelivery } = {}) {
  const api = await identityApi(users)
  const pro = mockProactive()
  const targets = []
  const dshIm = {
    listTargets: async () => targets.map((x) => ({ ...x })),
    createTarget: async (botId, target) => { targets.push({ botId, ...target }); return target },
  }
  const r = createAiReporter({
    api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc', label: 'test API' }), paths: { reportSettings: '/api/report/settings' },
    dshIm, proactive: () => pro.service, logger: silentLogger(), webUrl: () => WEB, applicationOptions: () => options, now: () => JST(8, 30),
    ...(guardMode ? { guardMode: () => guardMode } : {}), ...(proactiveDelivery ? { proactiveDelivery: () => proactiveDelivery } : {}),
  })
  await r.noteInbound({ sessionId: 'sess-admin', source: admin, text: 'hi' })
  assert.match(await r.handleCommand('定時報告 オン', admin), /オンにしました/)
  const alarm = pro.alarms.find((a) => a.state === 'scheduled')
  const view = { id: alarm.id, sessionId: 'sess-admin', type: 'cron', mode: 'business', prompt: alarm.prompt }
  return { api, pro, r, alarm, view }
}

test('AI report wake guard: the owner is re-checked at fire time; not linked / inactive / role / another user -> skipped and stopped', async () => {
  const users = { 'wx-admin': { id: 'u-admin', role: 'admin' } }
  const { api, pro, r, view } = await enabledReporter({ users })
  try {
    assert.equal(await r.wakeGuard({ alarm: view }), undefined, 'still eligible: the wake runs')
    assert.equal(await r.wakeGuard({ alarm: { ...view, prompt: 'other', mode: 'companion' } }), undefined, 'other alarms are not looked at')
    users['wx-admin'] = { id: 'u-admin', role: 'staff' } // the role was changed in the business system
    assert.deepEqual(await r.wakeGuard({ alarm: view }), { skip: 'ai report: role' })
    assert.equal(pro.alarms.filter((a) => a.state === 'scheduled').length, 0, 'the report alarms are cancelled')
    assert.equal(r.ownerOf('sess-admin'), null, 'the owner record is removed (bridge-tools no longer delegates)')
    assert.deepEqual(await r.wakeGuard({ alarm: view }), { skip: 'ai report: no_owner' }, 'a left-over alarm keeps being skipped')
    assert.equal(r.stats().revoked, 2)
    // identity lookups carry the owner's bot (a personal bot resolves to its owner only)
    assert.equal(api.callsTo('/bridge/v1/identity').at(-1).query.botId, 'W1')
  } finally {
    await api.close()
  }
  for (const [label, change, reason] of [
    ['unlinked / deactivated', (u) => { delete u['wx-admin'] }, 'not_linked'],
    ['relinked to another employee', (u) => { u['wx-admin'] = { id: 'u-other', role: 'admin' } }, 'other_user'],
  ]) {
    const u = { 'wx-admin': { id: 'u-admin', role: 'admin' } }
    const env = await enabledReporter({ users: u })
    try {
      change(u)
      assert.deepEqual(await env.r.wakeGuard({ alarm: env.view }), { skip: `ai report: ${reason}` }, label)
      assert.equal(env.r.ownerOf('sess-admin'), null, label)
    } finally {
      await env.api.close()
    }
  }
})

test('AI report wake guard: a moved 1:1 session stops it; an unreachable business system only skips this fire', async () => {
  const users = { 'wx-admin': { id: 'u-admin', role: 'admin' } }
  const env = await enabledReporter({ users })
  try {
    await env.api.close()
    const skip = await env.r.wakeGuard({ alarm: env.view })
    assert.equal(skip.skip, 'ai report: unavailable')
    assert.ok(env.r.ownerOf('sess-admin'), 'not stopped on an outage')
    await env.r.noteInbound({ sessionId: 'sess-new', source: admin, text: 'hi' }) // the person's 1:1 chat now lives in another session
    assert.deepEqual(await env.r.wakeGuard({ alarm: env.view }), { skip: 'ai report: not_direct' })
    assert.equal(env.r.ownerOf('sess-admin'), null)
  } finally {
    await env.api.close().catch(() => {})
  }
})

test('AI report delivery guard: only the owner\'s own 1:1 target; the text is screened (amounts / names / contacts / external URLs -> fixed template)', async () => {
  const users = { 'wx-admin': { id: 'u-admin', role: 'admin' } }
  const { api, r, view } = await enabledReporter({ users })
  try {
    const own = { botId: 'W1', targetId: reportTargetId(admin) }
    const ok = '【定時のご報告】10月25日 8:30\nおはようございます。本日の状況です。\n■ 対応が必要なこと\n・未提出の記録 2 件：担当者の方は業務 Web の記録画面で提出をお願いします。\n— 設備点検 AI 秘書'
    assert.deepEqual(await r.deliveryGuard({ alarm: view, target: own, text: ok }), { text: ok })
    assert.match((await r.deliveryGuard({ alarm: view, target: { ...own, targetId: 'someone-else' }, text: ok })).deny, /own 1:1/)
    assert.match((await r.deliveryGuard({ alarm: view, target: { ...own, botId: 'W2' }, text: ok })).deny, /own 1:1/)
    const template = reportTemplate({ appName: 'business', url: `${WEB}/`, now: JST(8, 30) })
    assert.match(template, /^【定時のご報告】\nおはようございます。定時業務報告の時刻になりました。/)
    assert.ok(template.includes(`こちらから開けます：${WEB}/`))
    for (const bad of [
      `${ok}\n・山田太郎様の記録が未提出です。`,
      `${ok}\n・今月の請求 123,400 円`,
      `${ok}\n連絡先 03-1234-5678`,
      `${ok}\n詳しくは https://evil.example.com/x`,
      `${ok}\n${'長い文。'.repeat(500)}`,
    ]) {
      assert.deepEqual(await r.deliveryGuard({ alarm: view, target: own, text: bad }), { text: template }, bad.slice(-30))
    }
    assert.deepEqual(await r.deliveryGuard({ alarm: view, target: own, text: `${ok}\n${WEB}/dashboard` }), { text: `${ok}\n${WEB}/dashboard` }, 'the business web URL is fine')
    // another business alarm: allowed by default
    assert.equal(await r.deliveryGuard({ alarm: { ...view, prompt: '業務巡回' }, target: { botId: 'x', targetId: 'y' }, text: ok }), undefined)
  } finally {
    await api.close()
  }
})

test('AI report delivery guard: aiReportGuard template / off; proactiveDelivery deny refuses every other business alarm', async () => {
  const users = { 'wx-admin': { id: 'u-admin', role: 'admin' } }
  const own = { botId: 'W1', targetId: reportTargetId(admin) }
  const t1 = await enabledReporter({ users, options: { aiReportGuard: 'template', aiReportLink: '/dashboard' } })
  try {
    const out = await t1.r.deliveryGuard({ alarm: t1.view, target: own, text: '【定時のご報告】問題なし' })
    assert.ok(out.text.includes(`こちらから開けます：${WEB}/dashboard`) && !out.text.includes('問題なし'))
  } finally {
    await t1.api.close()
  }
  const t2 = await enabledReporter({ users, guardMode: 'off', proactiveDelivery: 'deny' })
  try {
    assert.deepEqual(await t2.r.deliveryGuard({ alarm: t2.view, target: own, text: '1,000円' }), { text: '1,000円' })
    assert.match((await t2.r.deliveryGuard({ alarm: { ...t2.view, prompt: '業務巡回' }, target: own, text: 'x' })).deny, /only the AI report/)
  } finally {
    await t2.api.close()
  }
})

test('apply(): the guards are registered on ctx.dshProactive and run the reporter', async () => {
  const api = await identityApi({ 'wx-admin': { id: 'u-admin', role: 'admin' } })
  const im = mockDshIm()
  const pro = mockProactive()
  const ctx = makeCtx({ dshIm: im.dshIm, storageDomain: mockStorageDomain(), dshProactive: pro.service })
  const { registryService } = await import('@dsh-bridge/dsh-core')
  ctx.bridgeApps = registryService(await equipmentRegistry(api))
  try {
    const service = apply(ctx, { webUrl: WEB, proactiveDelivery: 'deny' })
    await service.ready
    assert.equal(typeof pro.guards.wake, 'function')
    assert.equal(typeof pro.guards.delivery, 'function')
    const alarm = { id: 'a1', sessionId: 'nobody', type: 'cron', mode: 'business', prompt: `${AI_REPORT_MARKER}x` }
    assert.deepEqual(await pro.guards.wake({ alarm }), { skip: 'ai report: no_owner' })
    assert.match((await pro.guards.delivery({ alarm, target: { botId: 'b', targetId: 't' }, text: 'x' })).deny, /no owner/)
    assert.match((await pro.guards.delivery({ alarm: { ...alarm, prompt: 'patrol' }, target: { botId: 'b', targetId: 't' }, text: 'x' })).deny, /only the AI report/)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

// ------------------------------------------------------------------ 自動タスクの報告
async function audienceNotifier({ options = {}, recipients = [], applicationOptions = null } = {}) {
  const sent = []
  const api = await startFakeApi((req) => {
    if (req.path.startsWith('/bridge/v1/notifications/for-event/')) return { body: { ok: true, recipients } }
    return { status: 404, body: {} }
  })
  const dshIm = {
    listBots: async () => [{ botId: 'W1', channel: 'weixin' }],
    async sendCard({ botId, to, card, idempotencyKey }) { sent.push({ botId, to: to.userId, card, idempotencyKey }); return { messageRef: 'r', delivered: true, deduped: false } },
  }
  const n = createNotifier({
    registry: await equipmentRegistry(api), dshIm, tables: (await openTables(mockStorageDomain())).tables, logger: silentLogger(),
    webUrl: () => WEB, now: () => JST(10), notifyTypes: () => ['proposal.reviewed'],
    applicationOptions: applicationOptions ?? ((id) => (id === 'equipment-inspection' ? options : {})),
  })
  return { api, n, sent }
}

const recipient = { userId: 'u-1', identity: { platform: 'weixin', externalId: 'wx-1', botId: 'W1' } }
const task = { id: 'pb_x', name: '点検の提案', applicationId: 'equipment-inspection', audience: { rule: 'managers' } }

test('automatic-task report: audienceText template sends the fixed text and a link, never the AI summary', async () => {
  const { api, n, sent } = await audienceNotifier({ options: { audienceText: 'template', audienceLink: '/proposals' }, recipients: [recipient] })
  try {
    const out = await n.deliverAudience({ task, run: { eventId: '7', eventType: 'proposal.reviewed' }, report: { status: 'needsDecision', summary: '山田様の点検 1 件（12,000円）' }, text: 'x', idempotencyKey: 'k' })
    assert.equal(out.handled, true)
    assert.equal(sent.length, 1)
    const card = sent[0].card
    assert.equal(card.title, '【対応のお願い】点検の提案')
    assert.match(card.body, /確認していただきたい内容をまとめました。\n▶ お願いしたいこと：業務 Web で内容をご確認のうえ、ご対応をお願いします。/)
    assert.deepEqual(card.link, { label: '業務 Web を開いて対応', url: `${WEB}/proposals` })
    assert.ok(!JSON.stringify(card).includes('山田') && !JSON.stringify(card).includes('円'))
    const failed = audienceTemplate({ status: 'failed', title: 't', now: JST(10) })
    assert.equal(failed.title, '【ご報告】t')
    assert.match(failed.body, /完了できませんでした。\n詳しい内容は業務 Web でご確認ください。/)
  } finally {
    await api.close()
  }
})

test('automatic-task report: audienceFallback none never hands the report back to the fixed channels (handled, nothing sent)', async () => {
  const { api, n, sent } = await audienceNotifier({ options: { audienceFallback: 'none' }, recipients: [] })
  try {
    for (const input of [
      { task, run: null, report: { status: 'done' }, text: 'x' },
      { task, run: { eventId: '8', eventType: 'not.notified' }, report: { status: 'done' }, text: 'x' },
      { task, run: { eventId: '9', eventType: 'proposal.reviewed' }, report: { status: 'done' }, text: 'x' },
    ]) {
      const out = await n.deliverAudience(input)
      assert.equal(out.handled, true, JSON.stringify(input.run))
      assert.deepEqual(out.results, [])
      assert.equal(out.suppressed, true)
    }
    assert.equal(sent.length, 0)
    assert.equal(n.status().audienceSuppressed, 3)
  } finally {
    await api.close()
  }
  // default (channels): unchanged — handled false so auto-tasks may use its channels
  const d = await audienceNotifier({ recipients: [] })
  try {
    assert.deepEqual(await d.n.deliverAudience({ task, run: null, text: 'x' }), { handled: false, reason: 'no_event' })
  } finally {
    await d.api.close()
  }
})

test('automatic-task report: the plugin-wide audienceFallback none / audienceText template close every application; applications.<id> overrides', async () => {
  const of = applicationOptionsFrom({ audienceFallback: 'none', audienceText: 'template', applications: { other: { audienceText: 'summary' } } })
  assert.deepEqual(of('equipment-inspection'), { audienceFallback: 'none', audienceText: 'template' })
  assert.deepEqual(of('other'), { audienceFallback: 'none', audienceText: 'summary' }, 'an application opts out explicitly')
  assert.deepEqual(applicationOptionsFrom({})('equipment-inspection'), {}, 'nothing set: the per-application defaults (channels / summary)')
  const closed = await audienceNotifier({ applicationOptions: of, recipients: [] })
  try {
    const out = await closed.n.deliverAudience({ task, run: null, report: { status: 'done' }, text: 'x' })
    assert.deepEqual([out.handled, out.suppressed], [true, true], 'no recipient: not handed back to the fixed channels')
  } finally {
    await closed.api.close()
  }
  const framed = await audienceNotifier({ applicationOptions: of, recipients: [recipient] })
  try {
    await framed.n.deliverAudience({ task, run: { eventId: '7', eventType: 'proposal.reviewed' }, report: { status: 'needsDecision', summary: '山田様の点検 1 件（12,000円）' }, text: 'x', idempotencyKey: 'k' })
    assert.equal(framed.sent.length, 1)
    assert.equal(framed.sent[0].card.title, '【対応のお願い】点検の提案')
    assert.ok(!JSON.stringify(framed.sent[0].card).includes('山田'), 'the fixed text, never the AI summary')
  } finally {
    await framed.api.close()
  }
})
