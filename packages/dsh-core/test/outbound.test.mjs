// N1b: グループ会話の判定・方針と、AI の自由文の事後の検査（screenOutboundText）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_CHAT_GUIDE, createApplicationRegistry, groupChatPolicy, isGroupConversation, screenOutboundText } from '../src/index.js'

test('isGroupConversation / groupChatPolicy', () => {
  assert.equal(isGroupConversation({ conversationKind: 'group' }), true)
  assert.equal(isGroupConversation({ conversationKind: 'channel' }), true, 'anything that is not direct')
  assert.equal(isGroupConversation({ conversationKind: 'direct' }), false)
  assert.equal(isGroupConversation({}), false, 'no kind (not an IM source) = 1:1')
  assert.equal(isGroupConversation(null), false)
  assert.equal(groupChatPolicy(undefined, null, 'allow'), 'allow')
  assert.equal(groupChatPolicy('deny', 'allow'), 'deny')
  assert.equal(groupChatPolicy('open', 1), 'deny', 'unknown values fall back to deny')
  assert.equal(GROUP_CHAT_GUIDE, '業務の内容は個別チャットでお尋ねください。')
})

test('registry: applications[].groupChat is kept (deny / allow / null)', () => {
  const reg = createApplicationRegistry({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    applications: [
      { id: 'app-a', apiUrl: 'http://a', serviceToken: 's', default: true, groupChat: 'allow' },
      { id: 'app-b', apiUrl: 'http://b', serviceToken: 's', bots: [{ platform: 'slack', botId: 'B2' }], groupChat: 'everyone' },
    ],
  })
  assert.equal(reg.get('app-a').groupChat, 'allow')
  assert.equal(reg.get('app-b').groupChat, null)
})

test('screenOutboundText: counts, roles and the business web URL pass', () => {
  const ok = [
    '【定時のご報告】10月25日 8:30',
    'おはようございます。お疲れさまです。本日の状況です。',
    '■ 対応が必要なこと',
    '・未提出の記録 3 件：介護担当の皆さんは業務 Web の記録画面で提出をお願いします。',
    '・承認待ち 2 件：サービス提供責任者さん・ケアマネジャーさま、ご確認をお願いします。利用者様・ご家族様への連絡は不要です。',
    '■ ご参考：同様に、仕様どおり問題なし。期限 2026-11-01、ID ab12cd34。たくさんの記録をありがとうございます。',
    'https://care.example.jp/dashboard',
    '— ケアビリング AI 秘書',
  ].join('\n')
  assert.deepEqual(screenOutboundText(ok, { allowedUrlPrefixes: ['https://care.example.jp'] }), { ok: true, reasons: [] })
})

test('screenOutboundText: amounts, honorific names, contacts, other URLs, long or empty text are flagged (codes only)', () => {
  const cases = [
    ['請求額 123,400 円', 'amount'], ['￥5,000 の未収', 'amount'], ['合計 12 万円', 'amount'],
    ['山田太郎様の記録', 'person_name'], ['ヤマダさんに連絡', 'person_name'], ['佐藤氏', 'person_name'], ['田中くん', 'person_name'],
    ['電話 03-1234-5678', 'contact'], ['携帯 09012345678', 'contact'], ['〒100-0001', 'contact'], ['a.b@example.jp へ', 'contact'],
    ['https://evil.example.com/x', 'external_url'], ['   ', 'empty'], ['あ'.repeat(1501), 'too_long'], [Array(41).fill('x').join('\n'), 'too_long'],
  ]
  for (const [text, reason] of cases) {
    const out = screenOutboundText(text, { allowedUrlPrefixes: ['https://care.example.jp'] })
    assert.equal(out.ok, false, text.slice(0, 20))
    assert.ok(out.reasons.includes(reason), `${text.slice(0, 20)} -> ${out.reasons}`)
    for (const r of out.reasons) assert.match(r, /^[a-z_]+$/, 'reason codes only, never the matched text')
  }
  assert.equal(screenOutboundText('https://care.example.jp.evil.test/', { allowedUrlPrefixes: ['https://care.example.jp/'] }).ok, false)
})

// G1 (care docs/design/cm/G1.md): the health words — 病名・症状・服薬・バイタル・受診 — make the whole text the fixed one
test('screenOutboundText: health words are flagged (health); the report wording and everyday words pass', async () => {
  const { HEALTH_WORDS } = await import('../src/index.js')
  assert.ok(HEALTH_WORDS.length > 50 && HEALTH_WORDS.every((w) => typeof w === 'string' && w.length >= 1))
  const flagged = [
    '認知症の方 2 名の記録', '発熱のため訪問を中止', '服薬の確認が 3 件', '血圧が高めでした', 'SpO2 の記録', '体温 37.5℃', '37度台の方', '入院された方が 1 名',
    '処方の変更', 'インスリンの時間',
  ]
  for (const text of flagged) {
    const out = screenOutboundText(text, { allowedUrlPrefixes: ['https://care.example.jp'] })
    assert.deepEqual([out.ok, out.reasons], [false, ['health']], text)
  }
  const ok = [
    '■ 対応が必要なこと', '・ヒヤリハット・事故 1 件、安否確認の未回答 2 件、区分変更の兆候 1 件', '・今月の居宅訪問の記録（モニタリング）がまだ 3 件',
    '・認定の有効期間が 60 日以内に終わる方 2 件', '本日もがんばりましょう。今年度 2 度目のご案内です。', '要支援の方の安否確認',
  ].join('\n')
  assert.deepEqual(screenOutboundText(ok), { ok: true, reasons: [] })
  // healthWords: [] switches the list off (a caller's own list replaces it)
  assert.equal(screenOutboundText('発熱のため訪問を中止', { healthWords: [] }).ok, true)
  assert.deepEqual(screenOutboundText('独自の語', { healthWords: ['独自'] }).reasons, ['health'])
})
