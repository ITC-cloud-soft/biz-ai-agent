// The pure logic of @dsh-bridge/web-kit (src/core/*-core.ts, run with Node's type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  DEFAULT_CHANNELS, HOST_MESSAGES_JA, LINK_CODE_PLATFORMS, PERSONAL_BOT_PLATFORMS, PERSONAL_CHANNELS, PERSONAL_HIDDEN_SETTINGS, PLATFORM_LABEL, STRINGS_JA, createStrings, format, isPersonalBotPlatform,
  linkCodePlatformNames, linkCodeState, makeTranslator, mmss, parseRich, pickChannels, platformLabel, secondsLeft, selectChannel, splitChannelGroups, spokenCode, t,
} from '../src/core/index.ts'

test('platform labels: every dsh-im platform has a Japanese label; link-code platforms exclude email and personal WeChat', () => {
  const expected = {
    slack: 'Slack', line: 'LINE', teams: 'Teams', telegram: 'Telegram', weixin: 'WeChat', wecom: '企業微信 ボット', 'wecom-app': '企業微信 アプリ',
    dingtalk: 'DingTalk', feishu: '飛書 / Lark', qq: 'QQ', discord: 'Discord', matrix: 'Matrix', whatsapp: 'WhatsApp', imessage: 'iMessage', email: 'メール',
  }
  for (const [p, label] of Object.entries(expected)) assert.equal(PLATFORM_LABEL[p], label, p)
  assert.equal(platformLabel('unknown-x'), 'unknown-x')
  assert.equal(platformLabel('line', { line: 'LINE 公式' }), 'LINE 公式', 'host override')
  assert.ok(!LINK_CODE_PLATFORMS.includes('email') && !LINK_CODE_PLATFORMS.includes('weixin'))
  assert.match(linkCodePlatformNames(), /^Slack・LINE・Teams・Telegram・/)
  assert.equal(linkCodePlatformNames(['slack', 'line']), 'Slack・LINE')
  // S1: an employee's own bot on every channel except email / iMessage / office
  assert.equal(isPersonalBotPlatform('weixin'), true)
  assert.equal(isPersonalBotPlatform('slack'), true)
  for (const p of ['email', 'imessage', 'office']) assert.equal(isPersonalBotPlatform(p), false, p)
  assert.deepEqual([...PERSONAL_BOT_PLATFORMS].filter((p) => p !== 'wechat').sort(),
    ['dingtalk', 'discord', 'feishu', 'line', 'matrix', 'qq', 'slack', 'teams', 'telegram', 'wecom', 'wecom-app', 'weixin', 'whatsapp'])
})

test('personal channels (S1): every personal platform, WeChat through the fork WeixinSettingsTab, no email / iMessage; hidden parts', () => {
  assert.deepEqual(PERSONAL_CHANNELS.map((c) => c.id), ['slack', 'line', 'teams', 'weixin', 'telegram', 'discord', 'whatsapp', 'matrix', 'dingtalk', 'feishu', 'wecom', 'wecom-app', 'qq'])
  assert.ok(PERSONAL_CHANNELS.every((c) => c.rpc === `/${c.id}` && /SettingsTab$/.test(c.exportName) && /^channels\/[a-z-]+\/index\.js$/.test(c.path)))
  assert.deepEqual(PERSONAL_CHANNELS.find((c) => c.id === 'weixin'), { id: 'weixin', label: 'WeChat', rpc: '/weixin', group: 'main', exportName: 'WeixinSettingsTab', path: 'channels/weixin/index.js' })
  assert.deepEqual(splitChannelGroups(PERSONAL_CHANNELS).main.map((c) => c.id), ['slack', 'line', 'teams', 'weixin', 'telegram'])
  assert.deepEqual(new Set(PERSONAL_CHANNELS.map((c) => c.id)), new Set(PERSONAL_BOT_PLATFORMS.filter((p) => p !== 'wechat')))
  // 「更多设置」 (access policy …), working folder, model, preset, context enhancement, the WeCom app's proxy / callback base
  assert.deepEqual([...PERSONAL_HIDDEN_SETTINGS].sort(), ['advanced', 'agentPreset', 'appSettings', 'callbackSecretReset', 'contextEnhancement', 'model', 'workspace'])
  assert.ok(Object.isFrozen(PERSONAL_CHANNELS) && Object.isFrozen(PERSONAL_HIDDEN_SETTINGS))
})

test('strings: Japanese defaults, override map (unknown keys ignored), placeholders', () => {
  const s = createStrings({ 'sns.title': '外部アカウント連携', 'nope.key': 'x' })
  assert.equal(s['sns.title'], '外部アカウント連携')
  assert.equal(s['link.issue'], STRINGS_JA['link.issue'])
  assert.ok(!('nope.key' in s))
  assert.equal(t(s, 'link.left', { mm: '09', ss: '05' }), '残り 09:05')
  assert.equal(format('{a} {b}', { a: 1 }), '1 {b}', 'unknown placeholders stay')
  for (const [k, v] of Object.entries(STRINGS_JA)) if (!['common.dash', 'link.placeholder'].includes(k)) assert.match(v, /[぀-ヿ一-鿿]|[A-Za-z]/, k)
})

test('no business branding in the library (no care / 介護 / ケアビリング words in src)', () => {
  const files = []
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(`${dir}/${e.name}`) : files.push(`${dir}/${e.name}`) }
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    assert.doesNotMatch(text, /ケアビリング|介護|利用者|care-web|care-api|\bcare_/i, f)
  }
})

test('link codes: countdown, mm:ss, spoken digits, state', () => {
  assert.equal(secondsLeft(10_500, 0), 10)
  assert.equal(secondsLeft(0, 5000), 0)
  assert.deepEqual(mmss(125), { mm: '02', ss: '05' })
  assert.equal(spokenCode('123456'), '1 2 3 4 5 6')
  assert.deepEqual(linkCodeState(null, 0), { kind: 'none' })
  assert.deepEqual(linkCodeState({ code: '123456', expiresAt: 61_000 }, 0), { kind: 'live', code: '123456', left: 61 })
  assert.deepEqual(linkCodeState({ code: '123456', expiresAt: 1000 }, 1000), { kind: 'expired' })
})

test('im runtime core: translator chain, channel catalog (no personal WeChat), picking and grouping', () => {
  const tr = makeTranslator({ 保存: '保存する' }, { en: { 取消: 'Cancel' }, overrides: { 删除: '削除' } })
  assert.equal(tr('保存'), '保存する')
  assert.equal(tr('删除'), '削除')
  assert.equal(tr('取消'), 'Cancel')
  assert.equal(tr('Payload must be an object.'), HOST_MESSAGES_JA['Payload must be an object.'])
  assert.equal(tr('未知'), '未知')
  assert.ok(!DEFAULT_CHANNELS.some((c) => c.id === 'weixin'), 'personal WeChat is never an org channel')
  assert.ok(DEFAULT_CHANNELS.every((c) => c.rpc === `/${c.id}` && /SettingsTab$/.test(c.exportName)))
  const picked = pickChannels(DEFAULT_CHANNELS, ['line', 'slack', 'nope'], { line: 'LINE 公式' })
  assert.deepEqual(picked.map((c) => [c.id, c.label]), [['line', 'LINE 公式'], ['slack', 'Slack']])
  const g = splitChannelGroups(DEFAULT_CHANNELS)
  assert.deepEqual(g.main.map((c) => c.id), ['slack', 'line', 'teams', 'telegram'])
  assert.equal(selectChannel(DEFAULT_CHANNELS, 'qq').id, 'qq')
  assert.equal(selectChannel(DEFAULT_CHANNELS, 'zzz').id, 'slack')
})

test('rich strings: {name} placeholders (filled with text or elements by the components) and **bold** spans', () => {
  assert.deepEqual(parseRich('送信 「**{command}**」 です'), [
    { kind: 'text', text: '送信 「' }, { kind: 'bold', children: [{ kind: 'var', name: 'command' }] }, { kind: 'text', text: '」 です' },
  ])
  assert.deepEqual(parseRich('a{x}b{y}'), [{ kind: 'text', text: 'a' }, { kind: 'var', name: 'x' }, { kind: 'text', text: 'b' }, { kind: 'var', name: 'y' }])
  assert.deepEqual(parseRich('**太字**'), [{ kind: 'bold', children: [{ kind: 'text', text: '太字' }] }])
  assert.deepEqual(parseRich('2 ** 3'), [{ kind: 'text', text: '2 ** 3' }], 'an unmatched ** stays as text')
  assert.deepEqual(parseRich(''), [])
  // the rich defaults read as before: the admin hint and its link follow the code notice
  assert.match(STRINGS_JA['sns.codeNotice'], /管理者に依頼してください。\{admin\}$/)
  assert.match(STRINGS_JA['sns.adminHint'], /\{link\}$/)
  // keys added for hosts default to the text the components showed before
  assert.equal(STRINGS_JA['sns.unlinkConfirm'], STRINGS_JA['sns.unlink'])
  assert.equal(STRINGS_JA['sns.mineCaption'], STRINGS_JA['sns.mineTitle'])
  assert.equal(STRINGS_JA['im.tabLoadFailed'], STRINGS_JA['im.loadFailed'])
  assert.equal(STRINGS_JA['notify.quietSection'], STRINGS_JA['notify.quietTitle'])
  assert.equal(STRINGS_JA['notify.unavailableTitle'], STRINGS_JA['common.preparing'])
  assert.equal(t(createStrings(), 'link.spoken', { code: spokenCode('12') }), `${STRINGS_JA['link.yourCode']} 1 2`)
})
