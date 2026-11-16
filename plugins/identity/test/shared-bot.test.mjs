// 共用ボット（個人 WeChat：1 つの WeChat アカウントに 1 ボット）で 2 つのアプリケーション（設備点検・備品予約。架空）を同じ窓口内で切り替える。
// dsh-im の受信 gate（ルーター → claims → resolver → agent）は小さな模擬で再現する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationRegistry, createDelegationGate, createToolRequester, registryService } from '@dsh-bridge/dsh-core'
import { apply } from '../src/index.js'
import { createSwitchParser } from '../src/app-switch.js'
import { makeCtx, makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const WX = 'wx_shared'

function businessApi(tag, { linked, codes }) {
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== `svc-${tag}`) return { status: 401, body: { ok: false, error: 'service_token_required' } }
    if (req.path === '/bridge/v1/identity') {
      return linked.has(req.query.userId)
        ? { body: { ok: true, linked: true, orgId: `org-${tag}`, user: { id: `emp-${tag}`, role: 'staff', displayName: `${tag}-user` } } }
        : { body: { ok: true, linked: false, orgId: `org-${tag}` } }
    }
    if (req.path === '/bridge/v1/identities/link' && req.method === 'POST') {
      const user = codes.get(req.body?.code)
      if (!user) return { status: 404, body: { ok: false, error: 'link_code_invalid' } }
      linked.add(req.body.source.userId)
      return { body: { ok: true, user } }
    }
    if (req.path === '/bridge/v1/delegations' && req.method === 'POST') {
      if (!linked.has(req.body?.source?.userId)) return { status: 404, body: { ok: false, error: 'identity_not_linked' } }
      return { body: { ok: true, token: `dt-${tag}`, user: { id: `emp-${tag}`, role: 'staff' }, expiresAt: new Date(Date.now() + 120_000).toISOString() } }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } }
  })
}

/** dsh-im の受信 gate の模擬：ルーター → claims → resolver → agent。返信はルーターの decorateReply を通す。 */
function inboundGate(im, routerOf) {
  return async (text, source, { replyTo = null } = {}) => {
    const router = routerOf()
    const routed = router ? await router.route({ source, text, replyTo }) : null
    const src = routed?.applicationId ? { ...source, applicationId: routed.applicationId } : source
    const replies = []
    const reply = async (t) => { replies.push(router?.decorateReply ? router.decorateReply(src, t) : t) }
    const claim = im.state.claims.find((e) => e.matcher(text, src))
    if (claim) {
      await claim.handler({ text, source: src, reply })
      return { kind: 'claimed', replies, source: src }
    }
    const verdict = await im.state.resolver(src)
    if (verdict !== 'allow') {
      if (verdict?.reply) await reply(verdict.reply)
      return { kind: 'denied', replies, source: src }
    }
    return { kind: 'agent', replies, source: src, answer: (t) => (router?.decorateReply ? router.decorateReply(src, t) : t) }
  }
}

async function setup({ statePath = null, replyWindowSeconds = 600, config = {} } = {}) {
  const eqLinked = new Set()
  const bookingLinked = new Set()
  const eq = await businessApi('eq', { linked: eqLinked, codes: new Map([['111111', { id: 'emp-eq', displayName: '点検員A' }]]) })
  const booking = await businessApi('booking', { linked: bookingLinked, codes: new Map([['222222', { id: 'emp-booking', displayName: '予約係B' }]]) })
  const registry = createApplicationRegistry({
    applications: [
      { id: 'equipment-inspection', name: '設備点検', aliases: ['点検'], default: true, apiUrl: eq.url, serviceToken: 'svc-eq', namespace: 'facility',
        bots: [{ platform: 'weixin', botId: WX, multiApp: true }, { platform: 'wecom-app', botId: 'W1' }] },
      { id: 'facility-booking', name: '備品予約', aliases: ['予約'], namespace: 'booking', apiUrl: booking.url, serviceToken: 'svc-booking',
        bots: [{ platform: 'weixin', botId: WX, multiApp: true }, { platform: 'wecom-app', botId: 'W2' }],
        messages: { unlinkedReply: '備品予約の Web で連携コードを発行し、『連携 123456』と送信してください。' } },
    ],
  })
  const im = mockDshIm()
  let router = null
  im.dshIm.setConversationRouter = (r) => { router = r; return () => { if (router === r) router = null } }
  const bridgeApps = registryService(registry)
  const ctx = makeCtx({ dshIm: im.dshIm, bridgeApps })
  const plugin = apply(ctx, {
    guideIntervalSeconds: 0, cacheTtlSeconds: 600, switchReplyWindowSeconds: replyWindowSeconds, ...(statePath ? { switchStatePath: statePath } : {}), ...config,
  })
  return {
    eq, booking, im, ctx, plugin, registry, bridgeApps, eqLinked, bookingLinked,
    router: () => router,
    send: inboundGate(im, () => router),
    close: async () => { await ctx.dispose(); await eq.close(); await booking.close() },
  }
}

const wx = (o = {}) => makeSource({ platform: 'weixin', botId: WX, teamId: undefined, userId: 'wxid_staff', conversationId: 'wxid_staff', ...o })

test('#一覧 / #備品予約 / #いま / #ヘルプ in the shared window; links go to the CURRENT application', async () => {
  const env = await setup()
  try {
    let r = await env.send('#一覧', wx())
    assert.equal(r.kind, 'claimed')
    assert.equal(r.replies[0], [
      '【アプリ一覧】このチャットで使える業務アプリ：',
      '・設備点検（#点検）← いま',
      '・備品予約（#予約）',
      '切り替え：「#アプリ名」　いまのアプリ：「#いま」',
      'アプリごとに会話・記録は別々です。',
    ].join('\n'))
    assert.equal(env.eq.calls.length + env.booking.calls.length, 0, 'commands need no API call')

    // 設備点検（既定）で連携 → 設備点検の API だけに届く。返信は【設備点検】
    r = await env.send('連携 111111', wx())
    assert.equal(r.source.applicationId, 'equipment-inspection')
    assert.equal(r.replies[0], '【設備点検】連携が完了しました。点検員A さんとしてご利用いただけます。これから、確認やお願いが必要なことをこのチャットでお知らせします。気になることがあれば、いつでも話しかけてください。')
    assert.equal(env.eq.callsTo('/bridge/v1/identities/link').length, 1)
    assert.equal(env.booking.calls.length, 0)

    // 備品予約に切り替え（未連携なので手順を添える）
    r = await env.send('＃備品予約', wx())
    assert.match(r.replies[0], /^【備品予約】備品予約に切り替えました。ここからは備品予約の会話です/)
    assert.match(r.replies[0], /備品予約とはまだ連携していません/)
    r = await env.send('#いま', wx())
    assert.equal(r.replies[0], '【備品予約】いまのアプリは備品予約です。ほかのアプリは「#一覧」で確認できます。')
    r = await env.send('#予約', wx())
    assert.equal(r.replies[0], '【備品予約】いまのアプリは備品予約です。')

    // 備品予約では未連携：案内は備品予約の文言で【備品予約】付き。照会は備品予約の API
    r = await env.send('明日のプロジェクターは空いてる？', wx())
    assert.equal(r.kind, 'denied')
    assert.equal(r.replies[0], '【備品予約】備品予約の Web で連携コードを発行し、『連携 123456』と送信してください。')
    // 設備点検のコードはここ（備品予約）では無効
    r = await env.send('連携 111111', wx())
    assert.match(r.replies[0], /^【備品予約】連携コードが無効か/)
    assert.equal(env.booking.callsTo('/bridge/v1/identities/link').length, 1)
    r = await env.send('連携 222222', wx())
    assert.equal(r.replies[0], '【備品予約】連携が完了しました。予約係B さんとしてご利用いただけます。これから、確認やお願いが必要なことをこのチャットでお知らせします。気になることがあれば、いつでも話しかけてください。')
    r = await env.send('明日のプロジェクターは空いてる？', wx())
    assert.equal(r.kind, 'agent')
    assert.equal(r.source.applicationId, 'facility-booking')
    assert.equal(r.answer('空いています。'), '【備品予約】空いています。')
    // AI 秘書のラベルで始まる返事にも【アプリ名】が付く（ラベルはアプリ名ではない）
    assert.equal(r.answer('【ご報告】空いています。'), '【備品予約】【ご報告】空いています。')

    r = await env.send('#経理', wx())
    assert.equal(r.replies[0], '【アプリ一覧】「#経理」というアプリはこのチャットにありません。「#一覧」で使えるアプリを確認してください。')
    r = await env.send('#ヘルプ', wx())
    assert.match(r.replies[0], /^【使い方】/)
    assert.match(r.replies[0], /（例 #点検）/, 'the example is one of this chat\'s applications')
    r = await env.send('#点検', wx())
    assert.match(r.replies[0], /^【設備点検】設備点検に切り替えました。/)
    assert.doesNotMatch(r.replies[0], /まだ連携していません/, 'already linked in 設備点検')
    assert.equal(env.ctx.bridgeIdentity.currentApplication(wx()), 'equipment-inspection')
  } finally {
    await env.close()
  }
})

test('switch words and list texts are configurable', async () => {
  const env = await setup({ config: { switchWords: { list: ['apps', 'メニュー'], current: ['now'], help: ['help'] }, switchMessages: { listTitle: '【アプリ一覧】Apps:' } } })
  try {
    let r = await env.send('#メニュー', wx())
    assert.match(r.replies[0], /^【アプリ一覧】Apps:\n・設備点検（#点検）← いま/)
    r = await env.send('#now', wx())
    assert.equal(r.replies[0], '【設備点検】いまのアプリは設備点検です。ほかのアプリは「#一覧」で確認できます。')
    // 既定の語（一覧）は外したので、アプリ名として扱われる
    r = await env.send('#一覧', wx())
    assert.match(r.replies[0], /「#一覧」というアプリはこのチャットにありません/)
    const parse = createSwitchParser({})
    assert.deepEqual(parse('＃ヘルプ'), { kind: 'help' })
    assert.deepEqual(parse('#点検'), { kind: 'switch', query: '点検' })
    assert.equal(parse('# 一覧 です'), null)
  } finally {
    await env.close()
  }
})

test('switchMessages.helpExample fixes the example of the help text', async () => {
  const env = await setup({ config: { switchMessages: { helpExample: '#予約' } } })
  try {
    const r = await env.send('#ヘルプ', wx())
    assert.match(r.replies[0], /・#アプリ名（例 #予約）　切り替え/)
  } finally {
    await env.close()
  }
})

test('a notification from 備品予約 is prefixed; a reply to it while 設備点検 is current goes to 備品予約', async () => {
  const env = await setup({ replyWindowSeconds: 0 })
  try {
    env.eqLinked.add('wxid_staff')
    env.bookingLinked.add('wxid_staff')
    const router = env.router()
    const text = router.decorateOutbound({ botId: WX, to: { userId: 'wxid_staff' }, text: '予約の返却期限を 1 日過ぎた備品があります（期限 2026-10-23）。', applicationId: 'facility-booking' })
    assert.equal(text, '【備品予約】予約の返却期限を 1 日過ぎた備品があります（期限 2026-10-23）。')
    // applicationId の無い通知は共用ボットの既定＝設備点検
    assert.equal(router.decorateOutbound({ botId: WX, to: { userId: 'wxid_staff' }, text: '点検記録が登録されました。' }), '【設備点検】点検記録が登録されました。')
    // 共用でないボットはそのまま
    assert.equal(router.decorateOutbound({ botId: 'W2', to: { userId: 'u' }, text: '予約', applicationId: 'facility-booking' }), '予約')

    let r = await env.send('今日の点検は？', wx())
    assert.equal(r.source.applicationId, 'equipment-inspection', '設備点検 is current')
    r = await env.send('どの備品ですか？', wx(), { replyTo: { content: '【備品予約】予約の返却期限を 1 日過ぎた備品があります（期限 2026-10-23）。' } })
    assert.equal(r.kind, 'agent')
    assert.equal(r.source.applicationId, 'facility-booking')
    assert.equal(r.answer('プロジェクター P-02 です。'), '【備品予約】（引用された通知への返信のため、備品予約の会話に切り替えました。「#一覧」で切り替えられます）\nプロジェクター P-02 です。')
    assert.equal(r.answer('つづき'), '【備品予約】つづき', 'the notice is said once')
    r = await env.send('ほかには？', wx())
    assert.equal(r.source.applicationId, 'facility-booking', 'sticky until the next #<name>')
  } finally {
    await env.close()
  }
})

test('a delegation for one application never reaches the other: the gate follows the routed source', async () => {
  const env = await setup()
  try {
    env.eqLinked.add('wxid_staff')
    env.bookingLinked.add('wxid_staff')
    const gateFor = (id) => {
      const application = () => env.registry.get(id)
      const { requestJson } = createToolRequester({ application })
      return createDelegationGate({ application, registry: () => env.registry, identity: () => env.ctx.bridgeIdentity, requestJson, logger: { info() {}, warn() {} } })
    }
    const eqGate = gateFor('equipment-inspection')
    const bookingGate = gateFor('facility-booking')
    await env.send('#備品予約', wx())
    const turn = await env.send('明日の予約は？', wx({ messageId: 'm2' }))
    env.im.state.sessions.set('s-booking', turn.source) // dsh-im: sourceForTurn = the routed source of this turn
    const exec = { sessionId: 's-booking' }
    const principal = await bookingGate.authorize('booking_list_reservations', exec)
    assert.equal(principal.applicationId, 'facility-booking')
    assert.equal(principal.delegationToken, 'dt-booking')
    await assert.rejects(eqGate.authorize('facility_list_overdue', exec), /this conversation belongs to application "facility-booking", not "equipment-inspection"/)
    assert.equal(env.eq.callsTo('/bridge/v1/delegations').length, 0, 'no equipment delegation was even requested')
    // 同じ人が #点検 に戻ると、新しいターンは設備点検の会話
    await env.send('#点検', wx())
    const eqTurn = await env.send('期限切れの点検は？', wx({ messageId: 'm3' }))
    env.im.state.sessions.set('s-eq', eqTurn.source)
    assert.equal((await eqGate.authorize('facility_list_overdue', { sessionId: 's-eq' })).delegationToken, 'dt-eq')
    await assert.rejects(bookingGate.authorize('booking_list_reservations', { sessionId: 's-eq' }), /belongs to application "equipment-inspection"/)
    // 進行中のターン（s-booking）は切り替え後も備品予約のまま（ターンの発信元に固定）
    assert.equal((await env.ctx.bridgeIdentity.forSession('s-booking')).applicationId, 'facility-booking')
  } finally {
    await env.close()
  }
})

test('ordinary bots are untouched: no routing, #<name> reaches the agent, the bot table decides', async () => {
  const env = await setup()
  try {
    env.bookingLinked.add('U9')
    const source = makeSource({ platform: 'wecom-app', botId: 'W2', userId: 'U9' })
    assert.equal(await env.router().route({ source, text: '#点検' }), null)
    const r = await env.send('#点検', source)
    assert.equal(r.kind, 'agent')
    assert.equal(r.source.applicationId, undefined)
    assert.equal(env.ctx.bridgeIdentity.applicationOf(source), 'facility-booking')
    assert.equal(env.router().decorateReply(source, 'x'), 'x')
  } finally {
    await env.close()
  }
})

test('the current application and notification bindings survive a restart (switchStatePath)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-identity-switch-'))
  const statePath = join(dir, 'app-switch.json')
  try {
    const a = await setup({ statePath })
    await a.send('#備品予約', wx())
    a.router().decorateOutbound({ botId: WX, to: { userId: 'wxid_b' }, text: '別の人への通知', applicationId: 'facility-booking' })
    await a.close() // dispose flushes
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(Object.values(saved.currents)[0], 'facility-booking')
    const b = await setup({ statePath })
    try {
      assert.equal(b.ctx.bridgeIdentity.currentApplication(wx()), 'facility-booking')
      // selector：applicationId の無い照会（古い呼び出し元）も「いまのアプリ」で解決
      assert.equal(b.bridgeApps.resolveApplication(wx()).id, 'facility-booking')
      const r = await b.send('それは？', wx({ userId: 'wxid_b', conversationId: 'wxid_b' }), { replyTo: { content: '別の人への通知' } })
      assert.equal(r.source.applicationId, 'facility-booking')
    } finally {
      await b.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
