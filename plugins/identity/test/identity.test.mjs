import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, createIdentityService, inject, linkPattern, name, LINK_GUIDE_JA } from '../src/index.js'
import { createBusinessApi } from '@dsh-bridge/dsh-core'
import { makeCtx, makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const EMPLOYEE = { id: 'e42', role: 'inspector', displayName: '点検員A' }

function apiHandler({ linked = new Set(['U100']), codes = new Map([['123456', EMPLOYEE]]) } = {}) {
  return (req) => {
    if (req.headers['x-service-token'] !== 'svc-token') return { status: 401, body: { error: 'service_token_required' } }
    if (req.path === '/bridge/v1/identity' && req.method === 'GET') {
      return linked.has(req.query.userId) ? { body: { ok: true, linked: true, orgId: 'tenant-1', user: EMPLOYEE } } : { body: { ok: true, linked: false, orgId: 'tenant-1' } }
    }
    if (req.path === '/bridge/v1/identities/link' && req.method === 'POST') {
      const user = codes.get(req.body?.code)
      if (!user) return { status: 404, body: { error: 'link_code_invalid' } }
      if (req.body.code === '999999') return { status: 410, body: { error: 'link_code_expired' } }
      linked.add(req.body.source.userId)
      codes.delete(req.body.code)
      return { status: 200, body: { ok: true, user } }
    }
    return { status: 404, body: { error: 'not_found' } }
  }
}

async function setup(options, config = {}) {
  const api = await startFakeApi(apiHandler(options))
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token', cacheTtlSeconds: 60, guideIntervalSeconds: 0, ...config })
  return { api, im, ctx }
}

test('plugin metadata', () => {
  assert.equal(name, 'bridge-identity')
  assert.deepEqual(inject, ['dshIm'])
})

test('access resolver: linked employee is allowed, unlinked gets the Japanese guide', async () => {
  const { api, im, ctx } = await setup()
  try {
    assert.equal(typeof im.state.resolver, 'function')
    assert.equal(await im.state.resolver(makeSource({ userId: 'U100' })), 'allow')
    const denied = await im.state.resolver(makeSource({ userId: 'U999' }))
    assert.equal(denied.deny, true)
    assert.equal(denied.reply, LINK_GUIDE_JA)
    assert.match(denied.reply, /連携コードを発行/)
    assert.match(denied.reply, /『連携 123456』/)
    // サービストークン付きで照会し、source は platform/teamId/userId と受信したボット（botId。個人ボットの持ち主の判定、S1）
    const call = api.callsTo('/bridge/v1/identity')[0]
    assert.equal(call.headers['x-service-token'], 'svc-token')
    assert.deepEqual(call.query, { platform: 'slack', teamId: 'T1', userId: 'U100', botId: 'B1' })
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('resolve is per bot: the business system may answer differently through a personal bot (S1); a link clears every bot of the account', async () => {
  // B1 = organisation bot, P1 = someone else's personal bot: the same account is linked through B1 only
  const api = await startFakeApi((req) => {
    if (req.path === '/bridge/v1/identity') return { body: req.query.botId === 'P1' ? { ok: true, linked: false, orgId: 't' } : { ok: true, linked: true, orgId: 't', user: EMPLOYEE } }
    if (req.path === '/bridge/v1/identities/link') return { body: { ok: true, user: EMPLOYEE } }
    return { status: 404, body: {} }
  })
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token', cacheTtlSeconds: 60, guideIntervalSeconds: 0 })
  try {
    assert.equal(await im.state.resolver(makeSource({ botId: 'B1' })), 'allow')
    assert.equal((await im.state.resolver(makeSource({ botId: 'P1' }))).deny, true)
    // cached per bot: one lookup each, repeated messages hit the cache
    assert.equal(await im.state.resolver(makeSource({ botId: 'B1' })), 'allow')
    assert.equal((await im.state.resolver(makeSource({ botId: 'P1' }))).deny, true)
    assert.deepEqual(api.callsTo('/bridge/v1/identity').map((c) => c.query.botId), ['B1', 'P1'])
    // linking (through any bot) forgets the account's cached answers of every bot
    await im.reply('連携 123456', makeSource({ botId: 'B1' }))
    await im.state.resolver(makeSource({ botId: 'P1' }))
    assert.deepEqual(api.callsTo('/bridge/v1/identity').map((c) => c.query.botId), ['B1', 'P1', 'P1'])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('access resolver denies with an outage message when the business API is down', async () => {
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm })
  apply(ctx, { apiUrl: 'http://127.0.0.1:1', serviceToken: 'x', guideIntervalSeconds: 0 })
  const result = await im.state.resolver(makeSource())
  assert.equal(result.deny, true)
  assert.match(result.reply, /接続できません/)
})

test('guide reply is throttled per account (group spam guard)', async () => {
  const api = await startFakeApi(apiHandler())
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token', guideIntervalSeconds: 600 })
  try {
    const first = await im.state.resolver(makeSource({ userId: 'U7' }))
    const second = await im.state.resolver(makeSource({ userId: 'U7' }))
    assert.equal(first.deny, true)
    assert.equal(second, 'deny')
  } finally {
    await api.close()
  }
})

test('resolve() caches within TTL and dedupes concurrent lookups', async () => {
  const api = await startFakeApi(apiHandler())
  let t = 1_000
  const svc = createIdentityService({
    api: createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 'svc-token', label: 'test API' }),
    dshIm: null,
    ttlMs: 5_000,
    now: () => t,
  })
  try {
    const source = makeSource()
    const [a, b] = await Promise.all([svc.resolve(source), svc.resolve(source)])
    assert.deepEqual(a, { linked: true, orgId: 'tenant-1', user: EMPLOYEE })
    assert.equal(b, a)
    await svc.resolve(source)
    assert.equal(api.callsTo('/bridge/v1/identity').length, 1)
    t += 6_000
    await svc.resolve(source)
    assert.equal(api.callsTo('/bridge/v1/identity').length, 2)
    assert.equal(svc.stats().linkedSeen, 1)
  } finally {
    await api.close()
  }
})

test('forSession() uses dshIm.sourceForTurn; owner sessions without source return null', async () => {
  const { api, im, ctx } = await setup()
  try {
    im.state.sessions.set('s-im', makeSource({ userId: 'U100' }))
    const identity = await ctx.bridgeIdentity.forSession('s-im')
    assert.equal(identity.linked, true)
    assert.equal(identity.user.id, 'e42')
    assert.equal(identity.source.userId, 'U100')
    assert.equal(await ctx.bridgeIdentity.forSession('s-web-owner'), null)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('「連携 123456」 is claimed (not sent to the agent) and links the account', async () => {
  const { api, im, ctx } = await setup({ linked: new Set() })
  try {
    const source = makeSource({ userId: 'U555' })
    assert.equal((await im.state.resolver(source)).deny, true)
    assert.equal(await im.reply('こんにちは', source), null, 'ordinary text is not claimed')
    const replies = await im.reply('連携 １２３４５６', source) // 全角数字も受け付ける
    assert.equal(replies.length, 1)
    assert.match(replies[0], /連携が完了しました/)
    assert.match(replies[0], /点検員A さんとして/)
    const linkCall = api.callsTo('/bridge/v1/identities/link')[0]
    assert.deepEqual(linkCall.body, { code: '123456', source: { platform: 'slack', teamId: 'T1', userId: 'U555', botId: 'B1' } })
    // キャッシュが更新され、直後から allow
    assert.equal(await im.state.resolver(source), 'allow')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('link keywords and replies are configurable (English deployment)', async () => {
  const { api, im, ctx } = await setup({ linked: new Set() }, {
    linkKeywords: ['link', '連携'],
    messages: { linked: 'Linked. Welcome{displayName}!', invalidCode: 'That code is not valid.' },
  })
  try {
    const source = makeSource({ userId: 'U556' })
    const denied = await im.state.resolver(source)
    assert.match(denied.reply, /『link 123456』/, 'the guide uses the first keyword')
    assert.match((await im.reply('LINK 000000', source))[0], /^That code is not valid\.$/)
    assert.equal((await im.reply('link 123456', source))[0], 'Linked. Welcome点検員A さんとして!')
    assert.equal(await im.reply('リンク 123456', source), null, 'other words are not claimed')
    assert.equal(linkPattern(['連携']).test('連携123456'), true)
    assert.equal(linkPattern(['a.b']).test('axb 123456'), false, 'keywords are literal')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('link: invalid / expired code, group chat and rate limit', async () => {
  const { api, im, ctx } = await setup({ linked: new Set(), codes: new Map([['999999', EMPLOYEE]]) })
  try {
    const source = makeSource({ userId: 'U600' })
    assert.match((await im.reply('連携 000000', source))[0], /無効か、有効期限/)
    assert.match((await im.reply('連携 999999', source))[0], /無効か、有効期限/)
    const group = makeSource({ userId: 'U601', conversationKind: 'group' })
    assert.match((await im.reply('連携 123456', group))[0], /個別チャット/)
    assert.equal(api.callsTo('/bridge/v1/identities/link').length, 2, 'group attempt never reaches the business API')
    for (let i = 0; i < 3; i += 1) await im.reply('連携 000000', source)
    assert.match((await im.reply('連携 000000', source))[0], /試行回数が多すぎます/)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('email is notify-only: link codes are refused with a clear reply, AI access is denied silently, the API is never asked', async () => {
  const { api, im, ctx } = await setup({ linked: new Set(['staff@example.test']) })
  try {
    const mail = makeSource({ platform: 'email', botId: 'mail-bot', teamId: undefined, userId: 'staff@example.test', conversationId: 'staff@example.test' })
    const replies = await im.reply('連携 123456', mail)
    assert.deepEqual(replies, ['メールでは連携できません。業務Webで別の SNS を連携してください。'])
    // a spoofable sender gets no AI and no guide mail (nothing is sent back to a possibly forged From)
    assert.equal(await im.state.resolver(mail), 'deny')
    assert.equal(api.callsTo('/bridge/v1/identities/link').length, 0)
    assert.equal(api.callsTo('/bridge/v1/identity').length, 0, 'even an address the API would know is not looked up')
    assert.deepEqual(await ctx.bridgeIdentity.resolve(mail), { linked: false, orgId: null, notifyOnly: true })
    // other platforms are unchanged
    assert.equal(await im.state.resolver(makeSource({ userId: 'staff@example.test' })), 'allow')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('createIdentityService().link refuses a notify-only platform before calling the business API', async () => {
  const calls = []
  const service = createIdentityService({ api: { get: async () => ({}), post: async (...a) => { calls.push(a); return {} } }, dshIm: {} })
  await assert.rejects(service.link('123456', { platform: 'email', userId: 'a@example.test' }), (e) => e.status === 400 && e.code === 'platform_not_linkable')
  assert.equal(calls.length, 0)
})

test('dispose removes resolver and claim', async () => {
  const { api, im, ctx } = await setup()
  await ctx.dispose()
  assert.equal(im.state.resolver, null)
  assert.equal(im.state.claims.length, 0)
  await api.close()
})

test('works against an old dsh-im without the fork API (logs, no throw)', () => {
  const ctx = makeCtx({ dshIm: { send() {} } })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(typeof ctx.bridgeIdentity.resolve, 'function')
})

test('link: 409 identity_already_linked and 429 too_many_attempts answered in Japanese', async () => {
  const api = await startFakeApi((req) => {
    if (req.path !== '/bridge/v1/identities/link') return { status: 404 }
    return req.body.code === '111111'
      ? { status: 409, body: { ok: false, error: 'identity_already_linked' } }
      : { status: 429, body: { ok: false, error: 'too_many_attempts' } }
  })
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token' })
  try {
    assert.match((await im.reply('連携 111111', makeSource()))[0], /既に連携済み/)
    assert.match((await im.reply('連携 222222', makeSource()))[0], /試行回数が多すぎます/)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('sns_identity.unlinked (via bridge-events) clears the cache at once → next message is denied with the guide', async () => {
  const linked = new Set(['U100'])
  const api = await startFakeApi(apiHandler({ linked }))
  const im = mockDshIm()
  const subscribers = []
  const bridgeEvents = { subscribe: (types, handler) => { subscribers.push({ types, handler }); return () => {} } }
  const ctx = makeCtx({ dshIm: im.dshIm, bridgeEvents })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token', cacheTtlSeconds: 600, guideIntervalSeconds: 600 })
  try {
    const source = makeSource({ userId: 'U100' })
    assert.equal(await im.state.resolver(source), 'allow')
    assert.equal(await im.state.resolver(source), 'allow')
    assert.equal(api.callsTo('/bridge/v1/identity').length, 1, 'served from cache')

    const notified = []
    ctx.bridgeIdentity.onUnlinked((e) => notified.push(e))
    // Web で本人が解除（業務システム側の連携は既に消えている）
    linked.delete('U100')
    assert.deepEqual(subscribers[0].types, ['sns_identity.unlinked'])
    await subscribers[0].handler({ id: 9, type: 'sns_identity.unlinked', payload: { identityId: 'sid-1', userId: 'e42', platform: 'slack' } })
    assert.equal(notified.length, 1)
    assert.equal(notified[0].userId, 'e42')
    assert.equal(notified[0].sources[0].userId, 'U100')

    const denied = await im.state.resolver(source)
    assert.equal(denied.deny, true)
    assert.equal(denied.reply, LINK_GUIDE_JA)
    assert.equal(api.callsTo('/bridge/v1/identity').length, 2)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('unlinked only clears the matching employee and platform; lookups in flight are not re-cached', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const svc = createIdentityService({
    api: { get: async () => { calls += 1; if (calls === 3) await gate; return { linked: true, orgId: 'o', user: EMPLOYEE } } },
    dshIm: null,
    ttlMs: 60_000,
  })
  await svc.resolve(makeSource({ userId: 'U100' }))
  await svc.resolve(makeSource({ userId: 'U100', platform: 'weixin', teamId: undefined }))
  assert.deepEqual(svc.unlinked({ userId: 'someone-else', platform: 'slack' }), [])
  const removed = svc.unlinked({ userId: 'e42', platform: 'slack' })
  assert.deepEqual(removed.map((s) => s.platform), ['slack'])
  assert.equal(svc.stats().cacheSize, 1, 'weixin link kept')

  // 解除前に始まった照会（3 回目の照会）を待つ間に解除が来たら、その結果はキャッシュしない
  const pending = svc.resolve(makeSource({ userId: 'U100' }))
  svc.unlinked({ userId: 'e42', platform: 'slack' })
  release()
  await pending
  assert.equal(svc.stats().cacheSize, 1)
})
