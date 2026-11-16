// 1 つの DSH に 2 つの業務アプリケーション（設備点検＋備品予約。どちらも架空）。ボット → アプリケーションはレジストリ（ctx.bridgeApps）だけで決まる。
// 備品予約は経路を個別指定（paths の上書き）して、アプリケーションごとの経路が使われることも確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationRegistry, registryService } from '@dsh-bridge/dsh-core'
import { apply, LINK_GUIDE_JA } from '../src/index.js'
import { makeCtx, makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const BOOKING_PATHS = { identity: '/api/bridge/identity', link: '/api/bridge/identities/link' }

function businessApi(tag, { identityPath, linkPath, linked = new Set(), codes = new Map() }) {
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== `svc-${tag}`) return { status: 401, body: { ok: false, error: 'service_token_required' } }
    if (req.path === identityPath) {
      return linked.has(req.query.userId)
        ? { body: { ok: true, linked: true, orgId: `org-${tag}`, user: { id: `emp-${tag}`, role: 'staff', displayName: `${tag}-user` } } }
        : { body: { ok: true, linked: false, orgId: `org-${tag}` } }
    }
    if (req.path === linkPath && req.method === 'POST') {
      const user = codes.get(req.body?.code)
      if (!user) return { status: 404, body: { ok: false, error: 'link_code_invalid' } }
      linked.add(req.body.source.userId)
      return { body: { ok: true, user } }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  })
}

async function setup({ strict = false } = {}) {
  const eqLinked = new Set(['U100'])
  const bookingLinked = new Set()
  const eq = await businessApi('eq', { identityPath: '/bridge/v1/identity', linkPath: '/bridge/v1/identities/link', linked: eqLinked, codes: new Map([['111111', { id: 'emp-eq', displayName: '点検員A' }]]) })
  const booking = await businessApi('booking', { identityPath: BOOKING_PATHS.identity, linkPath: BOOKING_PATHS.link, linked: bookingLinked, codes: new Map([['222222', { id: 'emp-booking', displayName: '予約係B' }]]) })
  const registry = createApplicationRegistry({
    strict,
    applications: [
      { id: 'equipment-inspection', name: '設備点検', default: true, apiUrl: eq.url, serviceToken: 'svc-eq' },
      { id: 'facility-booking', name: '備品予約', apiUrl: booking.url, serviceToken: 'svc-booking', paths: BOOKING_PATHS, bots: [{ platform: 'wecom-app', botId: 'W2' }], messages: { unlinkedReply: '備品予約: 連携してください' } },
    ],
  })
  const im = mockDshIm()
  const subscribers = []
  const bridgeEvents = { subscribe: (types, handler) => { subscribers.push({ types, handler }); return () => {} } }
  const ctx = makeCtx({ dshIm: im.dshIm, bridgeApps: registryService(registry), bridgeEvents })
  // プラグイン設定の apiUrl はレジストリがあれば使われない（ここに来たら失敗する URL）
  apply(ctx, { apiUrl: 'http://127.0.0.1:1', serviceToken: 'wrong', guideIntervalSeconds: 0, cacheTtlSeconds: 600 })
  return {
    eq, booking, im, ctx, subscribers, eqLinked, bookingLinked,
    close: async () => { await ctx.dispose(); await eq.close(); await booking.close() },
  }
}

const eqSource = (o = {}) => makeSource({ platform: 'slack', botId: 'B1', userId: 'U100', ...o })
const bookingSource = (o = {}) => makeSource({ platform: 'wecom-app', botId: 'W2', teamId: 'corp1', userId: 'U100', ...o })

test('the resolver picks the application from the bot; lookups go to that application only (its own paths)', async () => {
  const env = await setup()
  try {
    assert.equal(await env.im.state.resolver(eqSource()), 'allow')
    const denied = await env.im.state.resolver(bookingSource())
    assert.equal(denied.deny, true)
    assert.equal(denied.reply, '備品予約: 連携してください', 'per-application guide')
    assert.equal(env.eq.callsTo('/bridge/v1/identity').length, 1)
    assert.equal(env.booking.callsTo(BOOKING_PATHS.identity).length, 1)
    assert.equal(env.booking.calls[0].headers['x-service-token'], 'svc-booking')
    assert.deepEqual(env.booking.calls[0].query, { platform: 'wecom-app', teamId: 'corp1', userId: 'U100', botId: 'W2' })
    // 同じ IM ユーザー ID でも、アプリケーションが違えば別のキャッシュ
    assert.equal(await env.im.state.resolver(eqSource()), 'allow')
    assert.equal(env.eq.callsTo('/bridge/v1/identity').length, 1, 'equipment lookup served from its cache')
    env.im.state.sessions.set('s-booking', bookingSource())
    const identity = await env.ctx.bridgeIdentity.forSession('s-booking')
    assert.equal(identity.applicationId, 'facility-booking')
    assert.equal(identity.linked, false)
    assert.equal(env.ctx.bridgeIdentity.api.baseUrl(), env.eq.url, 'connection info = the default application')
  } finally {
    await env.close()
  }
})

test('link codes go to the API of the bot\'s application; a code of A does not link in B', async () => {
  const env = await setup()
  try {
    assert.match((await env.im.reply('連携 111111', bookingSource({ userId: 'U7' })))[0], /無効か、有効期限/, 'an equipment code sent to the booking bot is checked by booking')
    assert.equal(env.eq.callsTo('/bridge/v1/identities/link').length, 0)
    assert.equal(env.booking.callsTo(BOOKING_PATHS.link).length, 1)
    const replies = await env.im.reply('連携 222222', bookingSource({ userId: 'U7' }))
    assert.match(replies[0], /連携が完了しました。予約係B さん/)
    assert.deepEqual(env.booking.callsTo(BOOKING_PATHS.link).at(-1).body, { code: '222222', source: { platform: 'wecom-app', teamId: 'corp1', userId: 'U7', botId: 'W2' } })
    assert.equal(await env.im.state.resolver(bookingSource({ userId: 'U7' })), 'allow')
    // 設備点検では未連携のまま
    assert.equal((await env.im.state.resolver(eqSource({ userId: 'U7' }))).reply, LINK_GUIDE_JA)
  } finally {
    await env.close()
  }
})

test('a bot that no application owns is denied without calling any API (strict registry)', async () => {
  const env = await setup({ strict: true })
  try {
    const stray = makeSource({ platform: 'line', botId: 'L9', userId: 'U100' })
    const denied = await env.im.state.resolver(stray)
    assert.equal(denied.deny, true)
    assert.match(denied.reply, /割り当てられていません/)
    assert.match((await env.im.reply('連携 111111', stray))[0], /割り当てられていません/)
    assert.equal(env.eq.calls.length + env.booking.calls.length, 0)
  } finally {
    await env.close()
  }
})

test('sns_identity.unlinked of the default application does not clear the other application\'s cache', async () => {
  const env = await setup()
  try {
    env.bookingLinked.add('U100')
    assert.equal(await env.im.state.resolver(eqSource()), 'allow')
    assert.equal(await env.im.state.resolver(bookingSource()), 'allow')
    const notified = []
    env.ctx.bridgeIdentity.onUnlinked((e) => notified.push(e))
    // bridge-events（既定のアプリケーション）：設備点検の職員 emp-eq が slack を解除
    env.eqLinked.delete('U100')
    await env.subscribers[0].handler({ id: 1, type: 'sns_identity.unlinked', payload: { identityId: 'x', userId: 'emp-eq', platform: 'slack' } })
    assert.equal(notified[0].applicationId, 'equipment-inspection')
    assert.equal((await env.im.state.resolver(eqSource())).deny, true)
    assert.equal(await env.im.state.resolver(bookingSource()), 'allow')
    assert.equal(env.booking.callsTo(BOOKING_PATHS.identity).length, 1, 'booking cache untouched')
    // 備品予約のイベント（applicationId 付き）で同じ職員 ID でも設備点検には影響しない
    await env.subscribers[0].handler({ id: 2, type: 'sns_identity.unlinked', applicationId: 'facility-booking', payload: { userId: 'emp-eq', platform: 'slack' } })
    assert.equal(notified[1].applicationId, 'facility-booking')
  } finally {
    await env.close()
  }
})
