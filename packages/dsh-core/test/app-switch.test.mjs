// 共用ボット（個人 WeChat）：レジストリの multiApp と、同じ窓口内のアプリケーション切り替え（BRIDGE_ARCHITECTURE §15.2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MULTI_APP_PLATFORMS, appPrefix, createAppSwitch, createApplicationRegistry, parseSwitchCommand, registryService, withAppPrefix,
} from '../src/index.js'
import { silentLogger } from './helpers.mjs'
import { enableCareBillingPaths } from '../src/compat/care-billing-paths.js'

// これらのテストは最初の利用者（ケアビリング）の互換 profile（paths: legacy）と 2 つ目のアプリケーションで共用ボットを確かめる
enableCareBillingPaths()

const WX = 'wx_shared_bot'
const APPS = [
  {
    id: 'care-billing', name: 'ケアビリング', aliases: ['介護'], default: true, apiUrl: 'http://care.invalid', serviceToken: 'svc-care', paths: 'legacy', namespace: 'care',
    bots: [{ platform: 'weixin', botId: WX, multiApp: true }, { platform: 'wecom-app', botId: 'W1' }],
  },
  {
    id: 'equipment-inspection', name: '設備点検', namespace: 'facility', apiUrl: 'http://demo.invalid', serviceToken: 'svc-demo',
    bots: [{ platform: 'weixin', botId: WX, multiApp: true }, { platform: 'wecom-app', botId: 'W2' }],
  },
]
const wx = (o = {}) => ({ platform: 'weixin', botId: WX, userId: 'wxid_a', conversationId: 'wxid_a', conversationKind: 'direct', messageId: 'm1', ...o })

function registry(apps = APPS, options = {}) {
  return createApplicationRegistry({ applications: apps, logger: silentLogger, ...options })
}

test('registry: a multiApp bot may be listed by several applications; ordinary bots stay one-to-one', () => {
  const reg = registry()
  assert.deepEqual(MULTI_APP_PLATFORMS, ['weixin'])
  assert.equal(reg.isMultiAppBot(wx()), true)
  assert.equal(reg.isMultiAppBot({ platform: 'wecom-app', botId: 'W2' }), false)
  assert.deepEqual(reg.applicationsForBot(wx()).map((a) => a.id), ['care-billing', 'equipment-inspection'])
  assert.deepEqual(reg.applicationsForBot({ platform: 'wecom-app', botId: 'W2' }).map((a) => a.id), ['equipment-inspection'])
  assert.equal(reg.resolveApplication({ platform: 'wecom-app', botId: 'W1' }).id, 'care-billing')
  assert.equal(reg.resolveApplication({ platform: 'wecom-app', botId: 'W2' }).id, 'equipment-inspection')
  // 共用ボット：選択が無ければ既定（レジストリの既定アプリケーションが載せている）
  assert.equal(reg.sharedDefaultApplication(wx()).id, 'care-billing')
  assert.equal(reg.resolveApplication(wx()).id, 'care-billing')
  assert.deepEqual(reg.sharedBots(), [{ platform: 'weixin', botId: WX, applications: ['care-billing', 'equipment-inspection'] }])
  assert.deepEqual(reg.get('care-billing').aliases, ['介護'])
  // registryService（ctx.bridgeApps）にも出る
  const service = registryService(reg)
  assert.equal(service.isMultiAppBot(wx()), true)
  assert.equal(typeof service.setApplicationSelector, 'function')
})

test('registry: source.applicationId and the selector only pick among the bot\'s own applications', () => {
  const reg = registry([...APPS, { id: 'other-app', apiUrl: 'http://o.invalid', bots: [{ platform: 'slack', botId: 'S9' }] }])
  assert.equal(reg.resolveApplication(wx({ applicationId: 'equipment-inspection' })).id, 'equipment-inspection')
  assert.equal(reg.resolveApplication(wx({ applicationId: 'other-app' })).id, 'care-billing', 'not on this bot → ignored')
  assert.equal(reg.resolveApplication({ platform: 'wecom-app', botId: 'W1', applicationId: 'equipment-inspection' }).id, 'care-billing',
    'an ordinary bot ignores applicationId (bot table wins)')
  const dispose = reg.setApplicationSelector((source) => (source.userId === 'wxid_b' ? 'equipment-inspection' : 'other-app'))
  assert.equal(reg.resolveApplication(wx({ userId: 'wxid_b' })).id, 'equipment-inspection')
  assert.equal(reg.resolveApplication(wx()).id, 'care-billing', 'selector value not on the bot → default')
  assert.equal(reg.resolveApplication(wx({ userId: 'wxid_b', applicationId: 'care-billing' })).id, 'care-billing', 'applicationId before selector')
  assert.equal(dispose(), true)
  assert.equal(dispose(), false)
  assert.equal(reg.resolveApplication(wx({ userId: 'wxid_b' })).id, 'care-billing')
  // 選択が例外を投げても既定へ
  reg.setApplicationSelector(() => { throw new Error('boom') })
  assert.equal(reg.resolveApplication(wx()).id, 'care-billing')
})

test('registry: shared bots are refused unless every listing says multiApp, and only on switching platforms', () => {
  assert.throws(() => registry([
    { id: 'a-app', bots: [{ platform: 'weixin', botId: WX, multiApp: true }] },
    { id: 'b-app', bots: [{ platform: 'weixin', botId: WX }] },
  ]), /assigned to both "a-app" and "b-app".*multiApp: true in every application/)
  assert.throws(() => registry([
    { id: 'a-app', bots: [{ platform: 'slack', botId: 'S1', multiApp: true }] },
  ]), /multiApp is only supported on weixin \(got slack\)/)
  assert.throws(() => registry([
    { id: 'a-app', bots: [{ platform: 'wecom-app', botId: 'W' }] },
    { id: 'b-app', bots: [{ platform: 'wecom-app', botId: 'W' }] },
  ]), /assigned to both "a-app" and "b-app"$/)
  // 既定アプリケーションが共用ボットを載せていなければ、登録順の最初
  const reg = registry([
    { id: 'main-app', default: true, bots: [{ platform: 'slack', botId: 'S1' }] },
    { id: 'b-app', name: 'B', bots: [{ platform: 'weixin', botId: WX, multiApp: true }] },
    { id: 'c-app', name: 'C', bots: [{ platform: 'weixin', botId: WX, multiApp: true }] },
  ])
  assert.equal(reg.sharedDefaultApplication(wx()).id, 'b-app')
  assert.equal(reg.sharedDefaultApplication({ platform: 'slack', botId: 'S1' }), null)
})

test('parseSwitchCommand: #一覧 / #いま / #ヘルプ / #<name>, full-width ＃ accepted, ordinary text is not a command', () => {
  assert.deepEqual(parseSwitchCommand('#一覧'), { kind: 'list' })
  assert.deepEqual(parseSwitchCommand('＃一覧'), { kind: 'list' })
  assert.deepEqual(parseSwitchCommand(' #いま '), { kind: 'current' })
  assert.deepEqual(parseSwitchCommand('#ヘルプ'), { kind: 'help' })
  assert.deepEqual(parseSwitchCommand('#？'), { kind: 'help' })
  assert.deepEqual(parseSwitchCommand('#介護'), { kind: 'switch', query: '介護' })
  assert.deepEqual(parseSwitchCommand('# 設備点検'), { kind: 'switch', query: '設備点検' })
  assert.equal(parseSwitchCommand('今日の #介護 の予定'), null)
  assert.equal(parseSwitchCommand('#介護 の予定は？'), null)
  assert.equal(parseSwitchCommand('##'), null)
  assert.equal(parseSwitchCommand(''), null)
  assert.equal(appPrefix({ name: '設備点検' }), '【設備点検】')
  assert.equal(withAppPrefix({ name: '設備点検' }, '点検期限を過ぎています'), '【設備点検】点検期限を過ぎています')
  assert.equal(withAppPrefix({ name: '設備点検' }, '【アプリ一覧】…'), '【アプリ一覧】…', 'already prefixed')
  // AI 秘書のラベル（docs/design/IM_MESSAGE_STYLE.md）はアプリ名ではない：その前に【アプリ名】を付ける（二重にはしない）
  for (const label of ['【ご報告】', '【対応のお願い】', '【至急】', '【承認のお願い】', '【ご相談】', '【定時のご報告】']) {
    assert.equal(withAppPrefix({ name: '設備点検' }, `${label}点検期限の超過`), `【設備点検】${label}点検期限の超過`, label)
  }
  assert.equal(withAppPrefix({ name: '設備点検' }, '【設備点検】【ご報告】x'), '【設備点検】【ご報告】x')
})

test('app switch: current / select / find per conversation; another user or bot keeps its own choice', () => {
  const reg = registry()
  const sw = createAppSwitch({ registry: reg })
  assert.equal(sw.isShared(wx()), true)
  assert.equal(sw.isShared({ platform: 'wecom-app', botId: 'W2', userId: 'u' }), false)
  assert.equal(sw.current(wx()).id, 'care-billing')
  assert.equal(sw.find(wx(), '介護').id, 'care-billing')
  assert.equal(sw.find(wx(), '設備点検').id, 'equipment-inspection')
  assert.equal(sw.find(wx(), 'FACILITY').id, 'equipment-inspection', 'namespace, case-insensitive')
  assert.equal(sw.find(wx(), 'equipment-inspection').id, 'equipment-inspection')
  assert.equal(sw.find(wx(), '経理'), null)
  assert.equal(sw.select(wx(), 'equipment-inspection').id, 'equipment-inspection')
  assert.equal(sw.current(wx()).id, 'equipment-inspection')
  assert.equal(sw.current(wx({ userId: 'wxid_b', conversationId: 'wxid_b' })).id, 'care-billing', 'per conversation')
  assert.deepEqual(sw.list(wx()).map((e) => [e.app.id, e.current]), [['care-billing', false], ['equipment-inspection', true]])
  assert.equal(sw.select(wx(), 'other-app'), null, 'not on this bot')
  assert.equal(sw.current({ platform: 'wecom-app', botId: 'W2', userId: 'u' }), null)
  assert.equal(sw.route({ source: { platform: 'wecom-app', botId: 'W2', userId: 'u', conversationId: 'u' }, text: 'x' }), null)
})

test('app switch: a notification is prefixed and recorded; a quoting reply routes back to its application', () => {
  let t = 1_000_000
  const sw = createAppSwitch({ registry: registry(), now: () => t, replyWindowMs: 0 }) // 引用だけを見る
  const sent = sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: '点検期限を 3 日過ぎた設備があります。' })
  assert.deepEqual(sent, { text: '【設備点検】点検期限を 3 日過ぎた設備があります。', applicationId: 'equipment-inspection', shared: true })
  // 介護がいまのアプリ。引用なしの発言は（時間窓が無効なので）結び付かない
  t += 1000
  assert.deepEqual(sw.route({ source: wx(), text: '今日の訪問は？' }), { applicationId: 'care-billing', reason: 'current', switched: false })
  t += 1000
  // 通知を引用した返信（本文の一部・【アプリ名】）→ 設備点検に切り替え
  const routed = sw.route({ source: wx({ messageId: 'm2' }), text: 'どの設備？', replyTo: { content: '点検期限を 3 日過ぎた設備' } })
  assert.deepEqual(routed, { applicationId: 'equipment-inspection', reason: 'quote', switched: true })
  assert.equal(sw.current(wx()).id, 'equipment-inspection', 'sticky')
  assert.deepEqual(sw.takeNotice(wx(), 'equipment-inspection'), { applicationId: 'equipment-inspection', reason: 'quote' })
  assert.equal(sw.takeNotice(wx(), 'equipment-inspection'), null, 'once')
  // 【アプリ名】で始まるメッセージの引用（エージェントの返信など）もそのアプリケーション
  assert.equal(sw.route({ source: wx(), text: 'つづき', replyTo: { content: '【ケアビリング】本日の未提出記録は 1 件です。' } }).applicationId, 'care-billing')
  // 別のボットの通知・期限切れは結び付かない
  sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: 'wx_other', to: { userId: 'wxid_a' }, text: 'よそのボットの通知です' })
  assert.equal(sw.route({ source: wx(), text: 'x', replyTo: { content: 'よそのボットの通知です' } }).reason, 'current')
  t += 8 * 24 * 3600_000
  assert.equal(sw.route({ source: wx(), text: 'x', replyTo: { content: '点検期限を 3 日過ぎた設備' } }).reason, 'current', 'retention')
})

test('app switch: without a quote, the first message after a notification inside the window answers it', () => {
  let t = 5_000_000
  const sw = createAppSwitch({ registry: registry(), now: () => t, replyWindowMs: 60_000 })
  sw.route({ source: wx(), text: 'こんにちは' })
  t += 1000
  sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: '期限切れの点検があります' })
  t += 30_000
  // 切り替えコマンドは通知に結び付けない（明示の操作が優先）
  assert.deepEqual(sw.route({ source: wx(), text: '#いま' }), { applicationId: 'care-billing', reason: 'command', switched: false })
  t += 1000
  assert.equal(sw.route({ source: wx(), text: 'わかりました' }).reason, 'current', 'the command was the first message after the notification')
  t += 1000
  sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: '2 件目の通知' })
  t += 10_000
  assert.deepEqual(sw.route({ source: wx(), text: '見ます' }), { applicationId: 'equipment-inspection', reason: 'reply-window', switched: true })
  t += 1000
  assert.equal(sw.route({ source: wx(), text: 'もう一つ' }).reason, 'current', 'only the first message')
  assert.equal(sw.current(wx()).id, 'equipment-inspection')
  sw.select(wx(), 'care-billing')
  sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: '3 件目の通知' })
  t += 61_000
  assert.equal(sw.route({ source: wx(), text: '遅い返事' }).applicationId, 'care-billing', 'outside the window')
})

test('app switch: a notification without (or with a foreign) applicationId is the shared bot\'s default; ordinary bots are untouched', () => {
  const sw = createAppSwitch({ registry: registry() })
  assert.equal(sw.noteNotification({ platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: '記録が提出されました' }).text, '【ケアビリング】記録が提出されました')
  assert.equal(sw.noteNotification({ applicationId: 'other-app', platform: 'weixin', botId: WX, to: { userId: 'wxid_a' }, text: 'x' }).applicationId, 'care-billing')
  assert.deepEqual(sw.noteNotification({ applicationId: 'equipment-inspection', platform: 'wecom-app', botId: 'W2', to: { userId: 'u' }, text: '点検' }),
    { text: '点検', applicationId: 'equipment-inspection', shared: false })
  assert.equal(sw.stats().notifications, 2)
})

test('app switch: snapshot / restore keeps the current application and notification bindings', () => {
  let t = 10_000
  const reg = registry()
  let saves = 0
  const a = createAppSwitch({ registry: reg, now: () => t, onChange: () => { saves += 1 } })
  a.select(wx(), 'equipment-inspection')
  a.noteNotification({ applicationId: 'equipment-inspection', platform: 'weixin', botId: WX, to: { userId: 'wxid_b' }, text: '通知 B' })
  a.noteNotificationMessageId({ platform: 'weixin', botId: WX, to: { userId: 'wxid_b' }, text: '【設備点検】通知 B', messageId: 'out-7' })
  assert.ok(saves >= 3)
  const data = JSON.parse(JSON.stringify(a.snapshot()))
  const b = createAppSwitch({ registry: reg, now: () => t })
  assert.equal(b.restore(data), true)
  assert.equal(b.current(wx()).id, 'equipment-inspection')
  const bSource = wx({ userId: 'wxid_b', conversationId: 'wxid_b' })
  assert.equal(b.current(bSource).id, 'care-billing')
  t += 1000
  assert.equal(b.route({ source: bSource, text: 'x', replyTo: { messageId: 'out-7' } }).applicationId, 'equipment-inspection', 'by message id')
  assert.equal(b.restore({ version: 99 }), false)
})
