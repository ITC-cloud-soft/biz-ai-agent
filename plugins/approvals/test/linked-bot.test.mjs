// 承認カードは承認者が連携に使ったボットから送る（同じプラットフォームにボットが複数あるとき：個人 WeChat・複数の Slack ワークスペース・
// QQ のボットごとの openid・LINE のプロバイダ）。email は通知専用のプラットフォームなので承認依頼のプラットフォームにしない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationRegistry } from '@dsh-bridge/dsh-core'
import { DEFAULT_PLATFORMS, createApprovalsIm } from '../src/index.js'
import { mockDshIm, startFakeApi } from './helpers.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function memoryTable() {
  const map = new Map()
  return { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, v) }, delete: async (k) => map.delete(k), map }
}

const delivery = (id, userId, identity) => ({
  deliveryId: id, user: { id: userId }, identity, token: `cat_${id}`, replyCode: '123456',
  card: { title: '承認依頼', fields: [], body: '確認してください。' }, reused: false,
})

async function setup(platformPriority) {
  const api = await startFakeApi((req) => {
    if (/^\/bridge\/v1\/approvals\/[^/]+\/deliveries$/.test(req.path) && req.method === 'POST') {
      return {
        body: {
          ok: true,
          deliveries: [
            delivery('d1', 'e1', { platform: 'slack', teamId: 'T2', externalId: 'U1', botId: 'B2' }), // linked through workspace B
            delivery('d2', 'e2', { platform: 'weixin', externalId: 'wx-2', botId: 'W2' }), // personal WeChat bot
            delivery('d3', 'e3', { platform: 'slack', teamId: 'T1', externalId: 'U3' }), // linked before botId was recorded
            delivery('d4', 'e4', { platform: 'slack', teamId: 'T1', externalId: 'U4', botId: 'B-booking' }), // another application's bot
          ],
        },
      }
    }
    if (/\/sent$/.test(req.path)) return { body: { ok: true, delivery: {} } }
    return { status: 404, body: { error: 'not_found' } }
  })
  const registry = createApplicationRegistry({
    logger: silent,
    applications: [
      { id: 'equipment-inspection', name: '設備点検', default: true, apiUrl: api.url, serviceToken: 'svc' },
      { id: 'facility-booking', name: '備品予約', apiUrl: 'http://127.0.0.1:9', serviceToken: 'x', bots: [{ platform: 'slack', botId: 'B-booking' }] },
    ],
  })
  const im = mockDshIm()
  im.state.bots = [
    { id: 'B1', platform: 'slack' }, { id: 'B2', platform: 'slack' }, { id: 'B-booking', platform: 'slack' },
    { id: 'W1', platform: 'weixin' }, { id: 'W2', platform: 'weixin' }, { id: 'E1', platform: 'email' },
  ]
  const core = createApprovalsIm({ registry, dshIm: im.dshIm, table: memoryTable(), logger: silent, ...(platformPriority ? { platformPriority } : {}) })
  return { api, im, core }
}

test('a card goes out through the bot the approver linked through, even when the platform has other bots', async () => {
  const { api, im, core } = await setup(() => ['slack', 'weixin'])
  try {
    await core.handleEvent({ id: 1, type: 'approval.requested', aggregateId: 'apv-1', payload: {} })
    assert.deepEqual(im.state.sent.map((s) => [s.to.userId, s.botId]), [
      ['U1', 'B2'], // not the first slack bot B1
      ['wx-2', 'W2'],
      ['U3', 'B1'], // no botId recorded -> the application's first bot of the platform
      ['U4', 'B1'], // a bot of another application is never used
    ])
  } finally {
    await api.close()
  }
})

test('email is never an approval platform; the default priority covers every supported platform (Feishu / Lark included)', async () => {
  const { api, core } = await setup(() => ['email', 'slack', 'weixin'])
  try {
    await core.handleEvent({ id: 1, type: 'approval.requested', aggregateId: 'apv-1', payload: {} })
    assert.deepEqual(api.callsTo('/bridge/v1/approvals/apv-1/deliveries', 'POST')[0].body, { platforms: ['slack', 'weixin'] })
  } finally {
    await api.close()
  }
  assert.deepEqual(DEFAULT_PLATFORMS.slice(0, 5), ['slack', 'line', 'teams', 'weixin', 'telegram'])
  for (const p of ['wecom-app', 'wecom', 'dingtalk', 'feishu', 'qq', 'discord', 'matrix', 'whatsapp', 'imessage']) assert.ok(DEFAULT_PLATFORMS.includes(p), p)
  assert.ok(!DEFAULT_PLATFORMS.includes('email'))
  // the default list: only platforms with a bot, at most 10 (Bridge protocol v1)
  const d = await setup()
  try {
    await d.core.handleEvent({ id: 1, type: 'approval.requested', aggregateId: 'apv-1', payload: {} })
    assert.deepEqual(d.api.callsTo('/bridge/v1/approvals/apv-1/deliveries', 'POST')[0].body, { platforms: ['slack', 'weixin'] })
  } finally {
    await d.api.close()
  }
})
