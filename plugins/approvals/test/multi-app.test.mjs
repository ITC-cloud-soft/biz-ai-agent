// 1 つの DSH に 2 つの業務アプリケーション（設備点検＋備品予約。架空）。承認カードはそのアプリケーションのボットから送り、
// 決定はそのアプリケーションの API へ。card token / 返信コードは発行したアプリケーションにしか送らない。
// 備品予約は経路を個別指定（paths の上書き）、文字返信の語は設定 replyWords で英語も受け付ける。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationRegistry } from '@dsh-bridge/dsh-core'
import { MSG, createApprovalsIm, parseActionTarget, replyMatcher } from '../src/index.js'
import { makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function memoryTable() {
  const map = new Map()
  return { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, v) }, delete: async (k) => map.delete(k), map }
}

const BOOKING_PATHS = {
  approvalDeliveries: '/api/bridge/approvals/{approvalId}/deliveries',
  approvalDeliverySent: '/api/bridge/approvals/{approvalId}/deliveries/{deliveryId}/sent',
  approvalDecision: '/api/bridge/approvals/{approvalId}/im-decision',
  approvalDecisions: '/api/bridge/im-decisions',
}

/** prefix: v1 は /bridge/v1（返信コードは /bridge/v1/approvals/im-decisions）、備品予約は /api/bridge（/api/bridge/im-decisions）。 */
function approvalsApi({ token, prefix, decisionsPath, replyCode }) {
  const decisions = []
  const server = startFakeApi((req) => {
    if (req.headers['x-service-token'] !== token) return { status: 401, body: { error: 'invalid_service_token' } }
    let m = new RegExp(`^${prefix}/approvals/([^/]+)/deliveries$`).exec(req.path)
    if (m && req.method === 'POST') {
      return {
        body: {
          ok: true,
          deliveries: [{
            deliveryId: 'dlv-1', // the same id in both applications (ids are per application)
            user: { id: 'e1' },
            identity: { platform: 'slack', teamId: 'T1', externalId: 'U1' },
            token: `cat_${token}_secret`,
            replyCode,
            card: { title: `${token} の承認依頼`, fields: [], body: '確認してください。' },
            reused: false,
          }],
        },
      }
    }
    m = new RegExp(`^${prefix}/approvals/([^/]+)/deliveries/([^/]+)/sent$`).exec(req.path)
    if (m) return { body: { ok: true, delivery: {} } }
    m = new RegExp(`^${prefix}/approvals/([^/]+)/im-decision$`).exec(req.path)
    if (m) { decisions.push({ path: req.path, body: req.body }); return { body: { ok: true, approval: { id: m[1], status: 'executed' } } } }
    if (req.path === decisionsPath) { decisions.push({ path: req.path, body: req.body }); return { body: { ok: true, approval: { id: 'apv-1', status: 'executed' } } } }
    return { status: 404, body: { error: 'not_found' } }
  })
  return server.then((s) => ({ ...s, decisions }))
}

async function setup({ replyWords } = {}) {
  const eq = await approvalsApi({ token: 'svc-eq', prefix: '/bridge/v1', decisionsPath: '/bridge/v1/approvals/im-decisions', replyCode: '100001' })
  const booking = await approvalsApi({ token: 'svc-booking', prefix: '/api/bridge', decisionsPath: '/api/bridge/im-decisions', replyCode: '200001' })
  const registry = createApplicationRegistry({
    logger: silent,
    applications: [
      { id: 'equipment-inspection', name: '設備点検', default: true, apiUrl: eq.url, serviceToken: 'svc-eq' },
      { id: 'facility-booking', name: '備品予約', apiUrl: booking.url, serviceToken: 'svc-booking', paths: BOOKING_PATHS, bots: [{ platform: 'slack', botId: 'B-booking' }] },
    ],
  })
  const im = mockDshIm()
  const table = memoryTable()
  const core = createApprovalsIm({
    registry, dshIm: im.dshIm, table, logger: silent, platformPriority: () => ['slack'], webUrl: () => 'https://facility.example.test/approvals?id={id}',
    applicationOptions: (id) => (id === 'facility-booking' ? { webUrl: 'https://booking.example.test/requests/{id}' } : { showBusinessBody: false }),
    ...(replyWords ? { replyWords: () => replyWords } : {}),
  })
  return { eq, booking, im, table, core, close: async () => { await eq.close(); await booking.close() } }
}

const eqUser = (o = {}) => makeSource({ platform: 'slack', botId: 'B1', teamId: 'T1', userId: 'U1', ...o })
const bookingUser = (o = {}) => makeSource({ platform: 'slack', botId: 'B-booking', teamId: 'T1', userId: 'U1', ...o })

async function press(core, actionId, source) {
  const responses = []
  await core.handleAction({ actionId, value: '', source, messageRef: 'ref-x', respond: async (t) => { responses.push(t) } })
  return responses
}
async function reply(core, text, source) {
  const replies = []
  await core.handleReply({ text, source, reply: async (t) => { replies.push(t) } })
  return replies
}
const requestBoth = async (core) => {
  await core.handleEvent({ id: 1, type: 'approval.requested', aggregateId: 'apv-1', payload: {}, applicationId: 'equipment-inspection' })
  await core.handleEvent({ id: 1, type: 'approval.requested', aggregateId: 'apv-1', payload: {}, applicationId: 'facility-booking' })
}

test('cards are sent from each application\'s bot with application-scoped button ids, keys and links', async () => {
  const env = await setup()
  try {
    await requestBoth(env.core)
    assert.deepEqual(env.im.state.sent.map((s) => [s.botId, s.idempotencyKey, s.card.actions[0].id, s.applicationId ?? null]), [
      ['B1', 'approval:apv-1:e1', 'bridge_approval:approve:dlv-1', null],
      ['B-booking', 'approval:facility-booking:apv-1:e1', 'bridge_approval:approve:facility-booking/dlv-1', 'facility-booking'],
    ])
    assert.equal(env.im.state.sent[1].card.link.url, 'https://booking.example.test/requests/apv-1')
    assert.equal(env.im.state.sent[0].card.link.url, 'https://facility.example.test/approvals?id=apv-1')
    // AI 秘書の署名はそのアプリケーションの名前。業務システムの本文は showBusinessBody（設備点検は false）
    const [eqCard, bookingCard] = env.im.state.sent.map((s) => s.card)
    assert.ok(eqCard.title.startsWith('【承認のお願い】') && bookingCard.title.startsWith('【承認のお願い】'))
    assert.equal(eqCard.footer.split('\n').at(-1), '— 設備点検 AI 秘書')
    assert.equal(bookingCard.footer.split('\n').at(-1), '— 備品予約 AI 秘書')
    assert.ok(!eqCard.body.includes('ご参考'))
    assert.ok(bookingCard.body.includes('ご参考：確認してください。'))
    assert.match(bookingCard.body, /\n▶ お願いしたいこと：内容を確認し、「承認」か「差戻」を選んでください。\n/, 'no expiresAt: no invented deadline')
    assert.ok(bookingCard.body.endsWith('ご参考：確認してください。'))
    assert.equal(env.booking.callsTo('/api/bridge/approvals/apv-1/deliveries', 'POST').length, 1, 'the application\'s own paths')
    assert.ok(env.table.map.has('apv-1') && env.table.map.has('facility-booking|apv-1'))
    assert.deepEqual(env.core.status().applications, { 'equipment-inspection': 1, 'facility-booking': 1 })
    assert.deepEqual(parseActionTarget('facility-booking/dlv-1'), { applicationId: 'facility-booking', deliveryId: 'dlv-1' })
    assert.deepEqual(parseActionTarget('4f1c0d6e-0000-4000-8000-000000000001'), { applicationId: null, deliveryId: '4f1c0d6e-0000-4000-8000-000000000001' })
  } finally {
    await env.close()
  }
})

test('a button decides at the card\'s application only; the same button from another application\'s bot is refused without any API call', async () => {
  const env = await setup()
  try {
    await requestBoth(env.core)
    assert.deepEqual(await press(env.core, 'bridge_approval:approve:facility-booking/dlv-1', eqUser()), [MSG.notYours])
    assert.equal(env.booking.decisions.length + env.eq.decisions.length, 0)
    assert.deepEqual(await press(env.core, 'bridge_approval:approve:facility-booking/dlv-1', bookingUser()), [MSG.approved])
    assert.deepEqual(env.booking.decisions.map((d) => [d.path, d.body.token]), [['/api/bridge/approvals/apv-1/im-decision', 'cat_svc-booking_secret']])
    assert.equal(env.eq.decisions.length, 0)
    // the equipment card is untouched and still decidable from its bot
    assert.equal(env.table.get('apv-1').status, 'requested')
    assert.deepEqual(await press(env.core, 'bridge_approval:approve:dlv-1', eqUser()), [MSG.approved])
    assert.deepEqual(env.eq.decisions.map((d) => [d.path, d.body.token]), [['/bridge/v1/approvals/apv-1/im-decision', 'cat_svc-eq_secret']])
  } finally {
    await env.close()
  }
})

test('reply codes go only to the application that issued them', async () => {
  const env = await setup()
  try {
    await requestBoth(env.core)
    // the booking code sent to the equipment bot: refused locally, never forwarded to either API
    assert.deepEqual(await reply(env.core, '承認 200001', eqUser()), [MSG.notYours])
    assert.equal(env.booking.decisions.length + env.eq.decisions.length, 0)
    assert.deepEqual(await reply(env.core, '承認 200001', bookingUser()), [MSG.approved])
    assert.deepEqual(env.booking.decisions.map((d) => [d.path, d.body.replyCode]), [['/api/bridge/im-decisions', '200001']])
    assert.deepEqual(await reply(env.core, '承認 100001', eqUser()), [MSG.approved])
    assert.deepEqual(env.eq.decisions.map((d) => [d.path, d.body.replyCode]), [['/bridge/v1/approvals/im-decisions', '100001']])
    // an unknown code goes to the conversation's application (the business system checks it)
    await reply(env.core, '承認 999999', bookingUser())
    assert.equal(env.booking.decisions.at(-1).body.replyCode, '999999')
  } finally {
    await env.close()
  }
})

test('reply words are configurable (buttons, footer and text replies follow)', async () => {
  const env = await setup({ replyWords: { approve: ['approve', '承認'], reject: ['reject'] } })
  try {
    await requestBoth(env.core)
    const card = env.im.state.sent[0].card
    assert.deepEqual(card.actions.map((a) => a.label), ['approve', 'reject'])
    assert.match(card.footer, /「approve 100001」／「reject 100001 理由」/)
    assert.deepEqual(await reply(env.core, 'reject 100001', eqUser()), [MSG.reasonRequired('100001', { approve: ['approve'], reject: ['reject'] })])
    assert.deepEqual(await reply(env.core, 'Approve １００００１', eqUser()), [MSG.approved])
    assert.equal(env.eq.decisions.at(-1).body.action, 'approve')
    const m = replyMatcher({ approve: ['OK'], reject: ['NG'] })
    assert.deepEqual(m.parse('ng 123456 部品の型番が違う'), { action: 'reject', code: '123456', comment: '部品の型番が違う' })
    assert.equal(m.parse('承認 123456'), null)
  } finally {
    await env.close()
  }
})

test('approval.decided of one application finishes only its own cards', async () => {
  const env = await setup()
  try {
    await requestBoth(env.core)
    await env.core.handleEvent({ id: 2, type: 'approval.decided', aggregateId: 'apv-1', payload: { status: 'rejected' }, applicationId: 'facility-booking' })
    assert.equal(env.table.get('facility-booking|apv-1').status, 'rejected')
    assert.equal(env.table.get('facility-booking|apv-1').deliveries[0].token, undefined, 'secrets dropped')
    assert.equal(env.table.get('apv-1').status, 'requested')
    assert.equal(env.im.state.updated.length, 1)
    // an event of an unknown application is ignored
    await env.core.handleEvent({ id: 3, type: 'approval.requested', aggregateId: 'apv-9', payload: {}, applicationId: 'nope' })
    assert.equal(env.table.get('nope|apv-9'), undefined)
  } finally {
    await env.close()
  }
})
