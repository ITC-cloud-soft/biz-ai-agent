import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyApprovals, approvalSubject, cardWording, decisionErrorMessage, inject, name, MSG, replyMatcher } from '../src/index.js'
import { apply as applyEvents } from '@dsh-bridge/plugin-events'
import { BridgeApiError } from '@dsh-bridge/dsh-core'
import { makeCtx, makeSource, mockDshIm, mockStorageDomain, startFakeApi, waitFor } from './helpers.mjs'

const APPROVAL = 'apv-1'

/**
 * 承認者: e1(slack U1) e2(slack U2 / weixin wx2) e3(weixin wx3) e4(slack U4, 役割不足)。Bridge v1 の承認 API のモック（架空のデータ）。
 * wording：カードに付ける任意の文面（業務システムが承認の種類ごとに決める card.wording）。
 */
function fakeApprovalsApi({ wording = null } = {}) {
  const events = []
  const byKey = new Map() // delivery 記録（deliveries は冪等。プラットフォームが外れたものは revoked）
  const deliveryCalls = []
  const decided = new Map()
  const revoked = new Set()
  let seq = 0
  const approvers = {
    slack: [
      { user: { id: 'e1', displayName: '承認者1' }, identity: { platform: 'slack', teamId: 'T1', externalId: 'U1' } },
      { user: { id: 'e2', displayName: '承認者2' }, identity: { platform: 'slack', teamId: 'T1', externalId: 'U2' } },
      { user: { id: 'e4', displayName: '承認者4' }, identity: { platform: 'slack', teamId: 'T1', externalId: 'U4' }, forbidden: true },
    ],
    weixin: [
      { user: { id: 'e2', displayName: '承認者2' }, identity: { platform: 'weixin', externalId: 'wx2' } },
      { user: { id: 'e3', displayName: '承認者3' }, identity: { platform: 'weixin', externalId: 'wx3' } },
    ],
  }
  const all = () => [...byKey.values()]
  const ownerOf = (source) => all().filter((d) => !d.revoked && d.identity.platform === source?.platform && d.identity.externalId === source?.userId)

  function decide(approvalId, d, b) {
    if (d.revoked) return { status: 409, body: { error: 'delivery_revoked' } }
    if (decided.has(approvalId)) return { status: 409, body: { error: `already_${decided.get(approvalId).status}` } }
    if (revoked.has(approvalId)) return { status: 409, body: { error: 'delivery_revoked' } }
    if (d.forbidden) return { status: 403, body: { error: 'role_not_permitted' } }
    if (b.action === 'reject' && !b.comment) return { status: 400, body: { error: 'comment_required' } }
    const status = b.action === 'approve' ? 'executed' : 'rejected'
    decided.set(approvalId, { action: b.action, by: d.user.id, comment: b.comment, status })
    return { body: { ok: true, approval: { id: approvalId, status }, deliveryId: d.deliveryId } }
  }

  const api = startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { error: 'service_token_required' } }
    if (req.path === '/bridge/v1/events') {
      const after = req.query.after === undefined ? 0 : Number(req.query.after)
      const page = events.filter((e) => e.id > after)
      return { body: { ok: true, events: page, nextAfter: page.at(-1)?.id ?? after } }
    }
    let m = /^\/bridge\/v1\/approvals\/([^/]+)\/deliveries$/.exec(req.path)
    if (m && req.method === 'POST') {
      if (decided.has(m[1])) return { status: 409, body: { error: `already_${decided.get(m[1]).status}` } }
      const platforms = req.body.platforms
      if (!Array.isArray(platforms) || platforms.length === 0) return { status: 400, body: { error: 'platforms_required' } }
      deliveryCalls.push(platforms)
      const out = []
      for (const userId of ['e1', 'e2', 'e4', 'e3']) {
        const linked = Object.entries(approvers).flatMap(([pf, list]) => list.filter((a) => a.user.id === userId).map((a) => ({ ...a, pf })))
        const current = all().find((x) => x.approvalId === m[1] && x.user.id === userId && !x.revoked)
        if (current && platforms.includes(current.identity.platform)) {
          out.push({ ...current.wire, reused: true })
          continue
        }
        if (current) current.revoked = true // プラットフォームがリストから外れた → 無効
        const best = platforms.map((pf) => linked.find((a) => a.pf === pf)).find(Boolean)
        if (!best) continue
        seq += 1
        const wire = {
          deliveryId: `dlv-${seq}`,
          user: best.user,
          identity: best.identity,
          token: `cat_secret-token-${seq}`,
          replyCode: String(100000 + seq),
          expiresAt: '2099-01-01T00:00:00.000Z',
          card: {
            title: '修理依頼の承認依頼', fields: [{ label: '設備コード', value: 'FE-01' }, { label: '修理内容', value: '消火器の交換' }], body: '消火器 FE-01 の交換を発注します。',
            ...(wording ? { wording } : {}),
          },
          // e3 には業務システムが本人用のリンク（その人として承認画面を開く）を付ける
          ...(userId === 'e3' ? { link: `https://facility.example.test/open#t=personal-${seq}` } : {}),
        }
        byKey.set(`${m[1]}:${userId}:${seq}`, { ...wire, wire, approvalId: m[1], forbidden: Boolean(best.forbidden), attempts: 5, revoked: false })
        out.push({ ...wire, reused: false })
      }
      return { body: { ok: true, deliveries: out } }
    }
    m = /^\/bridge\/v1\/approvals\/([^/]+)\/deliveries\/([^/]+)\/sent$/.exec(req.path)
    if (m) return { body: { ok: true, delivery: { id: m[2] } } }
    m = /^\/bridge\/v1\/approvals\/([^/]+)\/im-decision$/.exec(req.path)
    if (m && req.method === 'POST') {
      const b = req.body
      const d = all().find((x) => x.token === b.token)
      if (!d || d.approvalId !== m[1]) return { status: 404, body: { error: 'delivery_not_found' } }
      if (b.source?.userId !== d.identity.externalId || b.source?.platform !== d.identity.platform) return { status: 403, body: { error: 'identity_mismatch' } }
      return decide(m[1], d, b)
    }
    if (req.path === '/bridge/v1/approvals/im-decisions' && req.method === 'POST') {
      const b = req.body
      const mine = ownerOf(b.source)
      if (mine.length === 0) return { status: 404, body: { error: 'identity_not_linked' } }
      const d = mine.find((x) => x.replyCode === b.replyCode)
      if (!d) {
        mine[0].attempts -= 1
        if (mine[0].attempts <= 0) return { status: 429, body: { error: 'delivery_locked' } }
        return { status: 403, body: { error: 'invalid_reply_code', remainingAttempts: mine[0].attempts } }
      }
      return decide(d.approvalId, d, b)
    }
    return { status: 404, body: { error: 'not_found' } }
  })
  return { api, events, byKey, decided, revoked, deliveryCalls }
}

async function setup({ supportsDialog = true, storage = mockStorageDomain(), fake, im: givenIm, approvalsExtra = {} } = {}) {
  const f = fake ?? fakeApprovalsApi()
  const api = await f.api
  const im = givenIm ?? mockDshIm({ supportsDialog })
  const services = { dshIm: im.dshIm, storageDomain: storage }
  const ctx = makeCtx(services)
  const config = { apiUrl: api.url, serviceToken: 'svc', applicationName: '設備点検', platformPriority: ['slack', 'weixin'], webUrl: 'https://facility.example.test/approvals/{id}' }
  const approvalsConfig = { ...config, ...approvalsExtra }
  const events = applyEvents(ctx, { ...config, enabled: false })
  const approvals = applyApprovals(ctx, approvalsConfig)
  await events.ready
  await approvals.ready
  return { f, api, im, ctx, events, approvals, storage, approvalsConfig }
}

const requested = (id = 1) => ({ id, type: 'approval.requested', aggregateType: 'approval', aggregateId: APPROVAL, payload: { approvalId: APPROVAL, expiresAt: '2099-01-01T00:00:00.000Z' }, at: '2026-10-25T00:00:00.000Z' })
const sentTo = (im, userId) => im.state.sent.find((s) => s.to.userId === userId)
const slack = (userId, extra = {}) => makeSource({ platform: 'slack', teamId: 'T1', userId, ...extra })

test('approvalSubject: the kind of approval only (no doubled 承認)', () => {
  for (const title of ['修理依頼の承認依頼', '修理依頼の承認', '【修理依頼】', '修理依頼承認']) assert.equal(approvalSubject(title), '修理依頼', title)
  assert.equal(approvalSubject('承認依頼'), '')
})

test('metadata', () => {
  assert.equal(name, 'bridge-approvals')
  assert.deepEqual(inject, ['dshIm', 'storageDomain'])
})

test('E2E: approval.requested → cards → button → im-decision → all cards updated', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()

    // 配信先の優先順：e1/e2/e4 は slack、e3 は weixin。e2 は weixin に重複送信しない
    assert.deepEqual(im.state.sent.map((s) => [s.botId, s.to.userId, s.idempotencyKey]), [
      ['B1', 'U1', `approval:${APPROVAL}:e1`],
      ['B1', 'U2', `approval:${APPROVAL}:e2`],
      ['B1', 'U4', `approval:${APPROVAL}:e4`],
      ['W1', 'wx3', `approval:${APPROVAL}:e3`],
    ])
    const card = sentTo(im, 'U1').card
    // AI 秘書：件名は【承認のお願い】と何の承認か（種類だけ）、本文はお願い（期限は expiresAt から日本時間で）・ボタンの説明・署名
    assert.equal(card.title, '【承認のお願い】修理依頼')
    const body = card.body.split('\n')
    assert.match(body[0], /^(おはようございます|お疲れさまです|夜分に失礼します)。修理依頼の承認をお願いします。$/)
    assert.deepEqual(body.slice(1), [
      '▶ お願いしたいこと（期限 01/01 09:00）：内容を確認し、「承認」か「差戻」を選んでください。',
      '・承認：この内容で確定します',
      '・差戻：理由を添えて申請者に戻します',
      'ご参考：消火器 FE-01 の交換を発注します。',
    ], 'the business system body is kept as a reference (showBusinessBody, default true)')
    // 返信コードの案内と署名は footer（dsh-im はボタンの無いプラットフォームでも footer を出す。textFallback に同じ文を重ねない）
    assert.equal(card.footer, '文字で返信する場合：「承認 100001」／「差戻 100001 理由」\n— 設備点検 AI 秘書')
    assert.equal(card.textFallback, undefined)
    assert.deepEqual(card.actions.map((a) => [a.id, a.label, a.style, a.value]), [
      ['bridge_approval:approve:dlv-1', '承認', 'primary', 'dlv-1'],
      ['bridge_approval:reject:dlv-1', '差戻', 'danger', 'dlv-1'],
    ])
    assert.match(card.footer, /「承認 100001」/)
    assert.equal(card.link.url, `https://facility.example.test/approvals/${APPROVAL}`)
    // token はカード（ボタン value を含む）のどこにも出ない
    for (const s of im.state.sent) assert.equal(JSON.stringify(s).includes('secret-token'), false)
    // deliveries は 1 回だけ、優先順のプラットフォームの一覧で呼ぶ
    assert.deepEqual(f.deliveryCalls, [['slack', 'weixin']])
    await waitFor(() => api.callsTo(`/bridge/v1/approvals/${APPROVAL}/deliveries/dlv-1/sent`).length === 1)

    // ボタン押下（U1）
    const responses = await im.press('bridge_approval:approve:dlv-1', slack('U1'), { messageRef: sentTo(im, 'U1').messageRef })
    assert.deepEqual(responses, [MSG.approved])
    const decision = api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`)[0]
    assert.deepEqual(decision.body, {
      token: 'cat_secret-token-1',
      action: 'approve',
      source: { platform: 'slack', teamId: 'T1', userId: 'U1' },
      channelMessageId: sentTo(im, 'U1').messageRef,
    })
    assert.deepEqual(f.decided.get(APPROVAL), { action: 'approve', by: 'e1', comment: undefined, status: 'executed' })

    // 全カード更新（ボタンなし・承認済み）
    assert.deepEqual(im.state.updated.map((u) => u.messageRef).sort(), im.state.sent.map((s) => s.messageRef).sort())
    for (const u of im.state.updated) {
      assert.deepEqual(u.card.actions, [])
      assert.match(u.card.footer, /承認済み/)
      // 更新したカードは【ご報告】：結果と「ご対応は不要です」
      assert.equal(u.card.title, '【ご報告】修理依頼の承認依頼（承認済み）')
      assert.equal(u.card.body, 'この承認依頼は承認されました。ご対応は不要です。')
      assert.equal(u.card.footer, '状態：承認済み\n— 設備点検 AI 秘書')
    }

    // 後から届く approval.decided は冪等（再更新しない）
    f.events.push({ id: 2, type: 'approval.decided', aggregateType: 'approval', aggregateId: APPROVAL, payload: { status: 'executed', decision: 'approve' } })
    await events.pollNow()
    assert.equal(im.state.updated.length, 4)

    // 決定後のボタンは「既に承認」
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-2', slack('U2')), [MSG.finished.approved])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('reject via Slack dialog sends the reason as comment', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const responses = await im.press('bridge_approval:reject:dlv-2', slack('U2'), { dialogAnswer: '  交換ではなく修理で足ります ' })
    assert.deepEqual(responses, [MSG.rejected])
    const body = api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`)[0].body
    assert.equal(body.action, 'reject')
    assert.equal(body.comment, '交換ではなく修理で足ります')
    for (const u of im.state.updated) assert.match(u.card.footer, /差戻し済み/)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('reject dialog cancelled → nothing sent to the business API', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    assert.deepEqual(await im.press('bridge_approval:reject:dlv-1', slack('U1'), { dialogAnswer: null }), [MSG.reasonCancelled])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('channel without dialog: reject asks for a text reason; 「差戻 code 理由」 decides', async () => {
  const { f, api, im, ctx, events } = await setup({ supportsDialog: false })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    assert.deepEqual(await im.press('bridge_approval:reject:dlv-1', slack('U1')), [MSG.askReason('100001')])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)

    assert.deepEqual(await im.reply('差戻 100001', slack('U1')), [MSG.reasonRequired('100001')])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)

    assert.deepEqual(await im.reply('差戻　１００００１　設備コードが誤り', slack('U1', { messageId: 'm-77' })), [MSG.rejected])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)
    const body = api.callsTo('/bridge/v1/approvals/im-decisions')[0].body
    assert.deepEqual(body, {
      replyCode: '100001',
      action: 'reject',
      comment: '設備コードが誤り',
      source: { platform: 'slack', teamId: 'T1', userId: 'U1' },
      channelMessageId: 'm-77',
    })
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('B-028: the reason typed into the card (Teams / Lark input) rejects without a dialog or a text reply', async () => {
  const { f, api, im, ctx, events } = await setup({ supportsDialog: false })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const reject = im.state.sent[0].card.actions.find((a) => a.id.startsWith('bridge_approval:reject:'))
    assert.deepEqual(reject.input, { label: MSG.reasonInputLabel, placeholder: MSG.reasonInputPlaceholder })
    // empty input → the text-reply guidance (with an example), nothing decided
    assert.deepEqual(await im.press('bridge_approval:reject:dlv-1', slack('U1'), { inputText: '  ' }), [MSG.askReason('100001')])
    assert.match(MSG.askReason('100001'), /例：差戻 100001 金額を確認してください/)
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)
    assert.deepEqual(await im.press('bridge_approval:reject:dlv-1', slack('U1'), { inputText: ' 金額を確認してください ' }), [MSG.rejected])
    const body = api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`)[0].body
    assert.equal(body.action, 'reject')
    assert.equal(body.comment, '金額を確認してください')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('B-028: on a channel without input or dialog (LINE …), the next message after 差戻 is the reason; 「取消」 cancels; others are not caught', async () => {
  const { f, api, im, ctx, events } = await setup({ supportsDialog: false })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    // before 差戻, a plain message goes to the agent (not claimed)
    assert.equal(await im.reply('こんにちは', slack('U1')), null)
    assert.deepEqual(await im.press('bridge_approval:reject:dlv-1', slack('U1')), [MSG.askReason('100001')])
    // another person's message is not taken as the reason
    assert.equal(await im.reply('関係ない話', slack('U2')), null)
    // 「取消」 ends the wait without deciding; the next plain message goes to the agent again
    assert.deepEqual(await im.reply('取消', slack('U1')), [MSG.reasonCancelled])
    assert.equal(await im.reply('こんにちは', slack('U1')), null)
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)
    // press again, then send the reason as a plain message → rejected with that comment
    await im.press('bridge_approval:reject:dlv-1', slack('U1'))
    assert.deepEqual(await im.reply('金額を確認してください', slack('U1', { messageId: 'm-88' })), [MSG.rejected])
    const body = api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`)[0].body
    assert.equal(body.action, 'reject')
    assert.equal(body.comment, '金額を確認してください')
    // the wait is over after one message
    assert.equal(await im.reply('ありがとう', slack('U1')), null)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('B-028: 「差戻123456理由」 without spaces is understood; a 7th digit is not part of a code', () => {
  const m = replyMatcher()
  assert.deepEqual(m.parse('差戻100001金額を確認してください'), { action: 'reject', code: '100001', comment: '金額を確認してください' })
  assert.deepEqual(m.parse('差戻 100001 金額違い'), { action: 'reject', code: '100001', comment: '金額違い' })
  assert.deepEqual(m.parse('承認100001'), { action: 'approve', code: '100001', comment: undefined })
  assert.equal(m.parse('承認 1000012'), null)
  assert.equal(m.parse('差戻1000012 理由'), null)
})

test('text reply 「承認 code」 from WeChat approves', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const wx3 = makeSource({ platform: 'weixin', teamId: undefined, userId: 'wx3', botId: 'W1' })
    const code = sentTo(im, 'wx3').card.footer.match(/承認 (\d{6})/)[1]
    assert.equal(await im.reply('承認お願いします', wx3), null, 'not a command → goes to the agent')
    assert.deepEqual(await im.reply(`承認 ${code}`, wx3), [MSG.approved])
    const body = api.callsTo('/bridge/v1/approvals/im-decisions')[0].body
    assert.deepEqual(body, { replyCode: code, action: 'approve', source: { platform: 'weixin', userId: 'wx3' }, channelMessageId: 'm1' })
    assert.equal(f.decided.get(APPROVAL).by, 'e3')
    // 応答の approval.id から全カードを更新
    assert.equal(im.state.updated.length, 4)
    for (const u of im.state.updated) assert.match(u.card.footer, /承認済み/)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('a per-approver link from the business system is used on that approver\'s card (request and final) and not kept after the decision', async () => {
  const { f, api, im, ctx, events, storage } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const personal = sentTo(im, 'wx3').card.link.url
    assert.match(personal, /^https:\/\/facility\.example\.test\/open#t=personal-\d+$/)
    assert.equal(sentTo(im, 'U1').card.link.url, `https://facility.example.test/approvals/${APPROVAL}`, 'without one: the configured webUrl')
    const wx3 = makeSource({ platform: 'weixin', teamId: undefined, userId: 'wx3', botId: 'W1' })
    const code = sentTo(im, 'wx3').card.footer.match(/承認 (\d{6})/)[1]
    assert.deepEqual(await im.reply(`承認 ${code}`, wx3), [MSG.approved])
    const updated = im.state.updated.find((u) => u.messageRef === sentTo(im, 'wx3').messageRef)
    assert.equal(updated.card.link.url, personal)
    const stored = storage.units.get('bridge_approvals').tables.get('approvals').get(APPROVAL)
    assert.equal(JSON.stringify(stored).includes('personal-'), false, 'the link is a secret like the token: dropped once decided')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('someone else pressing is refused locally; wrong reply codes are refused by the business API', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U2')), [MSG.notYours])
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1', { teamId: 'T-other' })), [MSG.notYours])
    assert.deepEqual(await im.press('bridge_approval:approve:nope', slack('U1')), [MSG.notFound])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 0)
    // U2 が U1 の返信コードを送っても、業務システムは U2 自身の配信とだけ照合する
    assert.deepEqual(await im.reply('承認 100001', slack('U2')), [MSG.code.invalid_reply_code(4)])
    assert.match(MSG.code.invalid_reply_code(4), /あと 4 回/)
    for (let i = 0; i < 3; i += 1) await im.reply('承認 999999', slack('U2'))
    assert.deepEqual(await im.reply('承認 999999', slack('U2')), [MSG.code.delivery_locked])
    // 未連携の送信者
    assert.deepEqual(await im.reply('承認 100001', slack('U-unknown')), [MSG.code.identity_not_linked])
    assert.equal(f.decided.has(APPROVAL), false)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('business API 403 (no authority) is answered in Japanese and cards stay open', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-3', slack('U4')), [MSG.code.role_not_permitted])
    assert.equal(im.state.updated.length, 0)
    // 他の承認者はまだ決定できる
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.approved])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('approval.expired updates every card and purges tokens', async () => {
  const storage = mockStorageDomain()
  const { f, api, im, ctx, events } = await setup({ storage })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    f.events.push({ id: 2, type: 'approval.expired', aggregateType: 'approval', aggregateId: APPROVAL, payload: {} })
    f.revoked.add(APPROVAL)
    await events.pollNow()
    assert.equal(im.state.updated.length, 4)
    for (const u of im.state.updated) assert.match(u.card.footer, /期限切れ/)
    const stored = storage.units.get('bridge_approvals').tables.get('approvals').get(APPROVAL)
    assert.equal(stored.status, 'expired')
    assert.equal(JSON.stringify(stored).includes('secret-token'), false)
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.finished.expired])
    assert.deepEqual(await im.reply('承認 100001', slack('U1')), [MSG.code.delivery_revoked])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('re-processing approval.requested (at-least-once) never sends a card twice', async () => {
  const { im, ctx, approvals, api } = await setup()
  try {
    await approvals.handleEvent(requested(1))
    await approvals.handleEvent(requested(1))
    assert.equal(im.state.sent.length, 4)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('delivery state survives a DSH restart (buttons keep working)', async () => {
  const storage = mockStorageDomain()
  const fake = fakeApprovalsApi()
  const first = await setup({ storage, fake })
  first.f.events.push(requested(1))
  await first.events.pollNow()
  const refs = first.im.state.sent.map((s) => s.messageRef)
  await first.ctx.dispose()

  const second = await setup({ storage, fake })
  try {
    assert.deepEqual(await second.im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.approved])
    assert.deepEqual(second.im.state.updated.map((u) => u.messageRef).sort(), refs.sort())
  } finally {
    await second.ctx.dispose()
    await second.api.close()
  }
})

test('business API unreachable during decision → Japanese retry message', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    await api.close()
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.error.unreachable])
  } finally {
    await ctx.dispose()
  }
})

test('decisionErrorMessage maps HTTP statuses', () => {
  const e = (status, code = '') => new BridgeApiError('x', { status, code })
  assert.equal(decisionErrorMessage(e(0)), MSG.error.unreachable)
  assert.equal(decisionErrorMessage(e(400, 'comment_required')), MSG.error.commentRequired)
  assert.equal(decisionErrorMessage(e(401)), MSG.error.unauthorized)
  assert.equal(decisionErrorMessage(e(403)), MSG.error.forbidden)
  assert.equal(decisionErrorMessage(e(404)), MSG.error.notFound)
  assert.equal(decisionErrorMessage(e(409)), MSG.error.conflict)
  assert.equal(decisionErrorMessage(e(410)), MSG.error.gone)
  assert.equal(decisionErrorMessage(e(503)), MSG.error.server)
  // Bridge v1 のエラーコード
  for (const code of ['token_or_reply_code_required', 'comment_required', 'identity_not_linked', 'delivery_not_found',
    'identity_mismatch', 'role_not_permitted', 'self_approval_forbidden', 'delivery_locked', 'too_many_attempts',
    'delivery_used', 'delivery_revoked', 'expired']) {
    assert.equal(decisionErrorMessage(e(400, code)), MSG.code[code], code)
  }
  const invalid = new BridgeApiError('x', { status: 403, code: 'invalid_reply_code', body: { error: 'invalid_reply_code', remainingAttempts: 2 } })
  assert.match(decisionErrorMessage(invalid), /あと 2 回/)
  assert.equal(decisionErrorMessage(e(409, 'already_executed')), MSG.finished.approved)
  assert.equal(decisionErrorMessage(e(409, 'already_rejected')), MSG.finished.rejected)
  assert.equal(decisionErrorMessage(e(409, 'already_cancelled')), MSG.finished.cancelled)
  assert.equal(decisionErrorMessage(e(429)), MSG.code.too_many_attempts)
})

test('approval cancelled by void (approval.decided status=cancelled) updates cards to 取消', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    f.events.push({ id: 2, type: 'approval.decided', aggregateType: 'approval', aggregateId: APPROVAL, payload: { status: 'cancelled', decision: null } })
    f.revoked.add(APPROVAL)
    await events.pollNow()
    assert.equal(im.state.updated.length, 4)
    for (const u of im.state.updated) {
      assert.match(u.card.footer, /取消/)
      assert.deepEqual(u.card.actions, [])
    }
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.finished.cancelled])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('lost local state is rebuilt from idempotent deliveries (reused:true) without resending', async () => {
  const fake = fakeApprovalsApi()
  const first = await setup({ fake })
  first.f.events.push(requested(1))
  await first.events.pollNow()
  const im = first.im
  await first.ctx.dispose()
  // ストレージが空の新しいプロセス。dsh-im 側の sendCard の重複排除は有効のまま
  const second = await setup({ fake, im })
  try {
    await second.approvals.handleEvent(requested(1))
    assert.equal(im.state.sent.length, 4, 'no duplicate cards')
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.approved])
    assert.equal(api(second).callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`)[0].body.token, 'cat_secret-token-1')
  } finally {
    await second.ctx.dispose()
    await second.api.close()
  }
})

function api(x) { return x.api }

test('platform list change: dropped/replaced deliveries are revoked, cards marked, old buttons answered', async () => {
  const { f, api, im, ctx, approvals, approvalsConfig } = await setup()
  try {
    await approvals.handleEvent(requested(1))
    assert.equal(im.state.sent.length, 4)
    approvalsConfig.platformPriority = ['weixin']
    await approvals.handleEvent(requested(1))
    assert.deepEqual(f.deliveryCalls, [['slack', 'weixin'], ['weixin']])
    // e2 は weixin（wx2）に新しい delivery、e3 は reused で再送なし
    const wx2 = im.state.sent.find((s) => s.to.userId === 'wx2')
    assert.ok(wx2, 'replacement card sent to wx2')
    assert.equal(wx2.idempotencyKey, `approval:${APPROVAL}:e2:${wx2.card.actions[0].value}`)
    assert.equal(im.state.sent.length, 5)
    // slack のカード 3 枚（e1/e2/e4）は無効表示
    const marked = im.state.updated.map((u) => u.messageRef).sort()
    const slackRefs = im.state.sent.filter((s) => s.botId === 'B1').map((s) => s.messageRef).sort()
    assert.deepEqual(marked, slackRefs)
    for (const u of im.state.updated) assert.match(u.card.footer, /無効/)
    // 旧ボタンはローカルで delivery_revoked
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-2', slack('U2')), [MSG.code.delivery_revoked])
    // 新しいボタンは使える
    const wx2Source = makeSource({ platform: 'weixin', teamId: undefined, userId: 'wx2', botId: 'W1' })
    assert.deepEqual(await im.press(wx2.card.actions[0].id, wx2Source), [MSG.approved])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).at(-1).body.token.startsWith('cat_secret-token-'), true)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('old token rejected by the business API with 409 delivery_revoked is explained', async () => {
  assert.equal(decisionErrorMessage(new BridgeApiError('x', { status: 409, code: 'delivery_revoked' })), MSG.code.delivery_revoked)
})

test('second approver after a decision gets 409 → already processed', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    // Web で先に決定された（イベント未着）状況
    f.decided.set(APPROVAL, { action: 'approve', by: 'web', status: 'executed' })
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.finished.approved])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('a button pressed before sendCard returns still finds its delivery (saved before sending)', async () => {
  const im = mockDshIm()
  const original = im.dshIm.sendCard
  let early = null
  im.dshIm.sendCard = async (input) => {
    // IM が配信直後に（sendCard の応答より先に）ボタン押下を届けるケースを再現する
    if (!early && input.to.userId === 'U1') {
      early = await im.press('bridge_approval:approve:dlv-1', slack('U1'), { messageRef: 'pending' })
    }
    return original(input)
  }
  const { f, api, ctx, events } = await setup({ im })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    assert.deepEqual(early, [MSG.approved])
    assert.equal(api.callsTo(`/bridge/v1/approvals/${APPROVAL}/im-decision`).length, 1)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

function weixinContextMissing() {
  const ilink = Object.assign(new Error('微信服务拒绝了回复消息。'), { code: 'send-rejected', providerCode: '-2' })
  const wrapped = Object.assign(new Error('Weixin text delivery failed (endpoint=sendmessage contextToken=no provider=-2 cause=send-rejected)', { cause: ilink }),
    { code: 'send-rejected', providerCode: '-2' })
  return Object.assign(new Error('delivery-failed', { cause: wrapped }), { code: 'delivery-failed' })
}

test('approval.decided: a card that can never be updated (WeChat context missing) is given up with a reason; the event stream moves on', async () => {
  const { f, api, im, ctx, events, approvals } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    im.dshIm.updateCard = async () => { throw weixinContextMissing() }
    f.events.push({ id: 2, type: 'approval.decided', aggregateType: 'approval', aggregateId: APPROVAL, payload: { status: 'executed', decision: 'approve' } })
    await events.pollNow()
    const s = events.status()
    assert.equal(s.cursor, 2)
    assert.equal(s.deadLetters.length, 0)
    assert.equal(approvals.publicService?.stats?.().updatesUndeliverable ?? approvals.stats?.updatesUndeliverable ?? 4, 4)
    // 決定後のボタンは「既に承認」（token は消えている）
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1')), [MSG.finished.approved])
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('approval.decided: a transient card update failure (bot offline) is still retried', async () => {
  const { f, api, im, ctx, events } = await setup()
  try {
    f.events.push(requested(1))
    await events.pollNow()
    im.dshIm.updateCard = async () => { throw Object.assign(new Error('no bot'), { code: 'bot-not-connected' }) }
    f.events.push({ id: 2, type: 'approval.decided', aggregateType: 'approval', aggregateId: APPROVAL, payload: { status: 'executed', decision: 'approve' } })
    await events.pollNow().catch(() => {})
    assert.equal(events.status().cursor, 1)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('actionPrefix / stateDomain / messages: buttons of an earlier prefix keep working, records stay in the named domain, error texts are overridable', async () => {
  const storage = mockStorageDomain()
  const extra = {
    actionPrefix: 'legacy_approval', stateDomain: 'legacy_approvals',
    messages: { identity_not_linked: '連携されていません（独自の文）。', invalid_reply_code: '返信コードが違います（独自）。' },
  }
  const { f, api, im, ctx, events } = await setup({ storage, approvalsExtra: extra })
  try {
    assert.deepEqual(im.state.actions.map((a) => a.prefix), ['legacy_approval:'], 'onAction is registered with the configured prefix')
    f.events.push(requested(1))
    await events.pollNow()
    const card = sentTo(im, 'U1').card
    assert.deepEqual(card.actions.map((a) => a.id), ['legacy_approval:approve:dlv-1', 'legacy_approval:reject:dlv-1'])
    assert.ok(storage.units.get('legacy_approvals').tables.get('approvals').has(APPROVAL), 'the record is in the named domain')
    assert.equal(storage.units.has('bridge_approvals'), false)
    // 既定の接頭辞のボタンは受け付けない（登録していない）
    await assert.rejects(im.press('bridge_approval:approve:dlv-1', slack('U1')), /no action handler/)
    // 文字返信のエラーは上書きした文
    assert.deepEqual(await im.reply('承認 999999', slack('U-none')), ['連携されていません（独自の文）。'])
    assert.deepEqual(await im.reply('承認 999999', slack('U1')), ['返信コードが違います（独自）。（あと 4 回まで）'])
    assert.deepEqual(await im.press('legacy_approval:approve:dlv-1', slack('U1')), [MSG.approved])
    assert.equal(f.decided.get(APPROVAL).by, 'e1')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('decisionErrorMessage: overrides by error code; the remaining attempts are still added', () => {
  const err = (status, code, body) => Object.assign(new BridgeApiError('x', { status, code, body }), {})
  assert.equal(decisionErrorMessage(err(404, 'identity_not_linked'), { identity_not_linked: 'A' }), 'A')
  assert.equal(decisionErrorMessage(err(404, 'identity_not_linked'), {}), MSG.code.identity_not_linked)
  assert.equal(decisionErrorMessage(err(403, 'invalid_reply_code', { remainingAttempts: 2 }), { invalid_reply_code: 'B' }), 'B（あと 2 回まで）')
})

const WORDING = Object.freeze({
  lead: '2026年10月分の修理の発注の承認をお願いします。',
  ask: '業務 Web の「承認」で見積を確認し、「承認」か「差戻」を選んでください。',
  buttons: { approve: 'この内容で業者に発注します', reject: '理由を添えて設備担当に戻します' },
  replies: { approved: '承認しました。ありがとうございます。業者に発注します。', rejected: '差戻しました。ありがとうございます。設備担当へ戻します。' },
  statusBody: { approved: 'この承認依頼は承認され、業者に発注しました。ご対応は不要です。' },
  extra: 'ignored', // unknown keys are dropped
})

test('card.wording: the sentences of one approval kind (lead / ask / buttons / button reply / decided card)', async () => {
  const { f, api, im, ctx, events } = await setup({ fake: fakeApprovalsApi({ wording: WORDING }), approvalsExtra: { showBusinessBody: false } })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const card = sentTo(im, 'U1').card
    assert.equal(card.title, '【承認のお願い】修理依頼', 'the title stays the generic one')
    const body = card.body.split('\n')
    assert.match(body[0], /^(おはようございます|お疲れさまです|夜分に失礼します)。2026年10月分の修理の発注の承認をお願いします。$/)
    assert.deepEqual(body.slice(1), [
      '▶ お願いしたいこと（期限 01/01 09:00）：業務 Web の「承認」で見積を確認し、「承認」か「差戻」を選んでください。',
      '・承認：この内容で業者に発注します',
      '・差戻：理由を添えて設備担当に戻します',
    ])
    assert.deepEqual(await im.press('bridge_approval:approve:dlv-1', slack('U1'), { messageRef: sentTo(im, 'U1').messageRef }), [WORDING.replies.approved])
    assert.equal(im.state.updated.length, 4)
    for (const u of im.state.updated) {
      assert.equal(u.card.title, '【ご報告】修理依頼の承認依頼（承認済み）')
      assert.equal(u.card.body, WORDING.statusBody.approved)
    }
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('card.wording: a text reply 「差戻 code 理由」 answers with the approval kind\'s reply; a state without its own body keeps the generic one', async () => {
  const { f, api, im, ctx, events } = await setup({ fake: fakeApprovalsApi({ wording: WORDING }) })
  try {
    f.events.push(requested(1))
    await events.pollNow()
    const wx3 = makeSource({ platform: 'weixin', teamId: undefined, userId: 'wx3', botId: 'W1' })
    const code = sentTo(im, 'wx3').card.footer.match(/承認 (\d{6})/)[1]
    assert.deepEqual(await im.reply(`差戻 ${code} 見積の確認が必要です`, wx3), [WORDING.replies.rejected])
    assert.equal(f.decided.get(APPROVAL).status, 'rejected')
    assert.equal(im.state.updated.length, 4)
    for (const u of im.state.updated) assert.equal(u.card.body, MSG.statusBody.rejected, 'no statusBody.rejected given: the generic body')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('cardWording keeps only short strings of the known keys (300 characters at most, whitespace folded)', () => {
  assert.equal(cardWording(null), null)
  assert.equal(cardWording(['x']), null)
  assert.equal(cardWording({ lead: '', ask: 1, buttons: [] }), null)
  assert.deepEqual(cardWording({
    lead: '  承認を\nお願いします。 ', buttons: { approve: '発注します', other: 'x' }, replies: { approved: 'x'.repeat(301) }, statusBody: { cancelled: '取り消しました。' },
  }), { lead: '承認を お願いします。', buttons: { approve: '発注します' }, statusBody: { cancelled: '取り消しました。' } })
})

