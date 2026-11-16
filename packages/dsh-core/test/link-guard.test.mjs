// link-guard.js: the links an AI answer may carry (care-ai-native docs/design/SNS_HELP_QA.md §4.3). Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLinkGuard, routePattern, DEFAULT_LINK_REPLACEMENT, HELP_LABEL, SECRETARY_LABEL_RE, frameAiText } from '../src/index.js'

const ROUTES = ['/', '/login', '/portal/*', '/cm/monitoring', '/cm/monitoring/:id', '/settings/sns', '/staff/', '/staff/shift']
const R = DEFAULT_LINK_REPLACEMENT

test('routePattern: :name is one segment, a trailing /* any sub path, a trailing slash is fine', () => {
  assert.ok(routePattern('/cm/monitoring/:id').test('/cm/monitoring/123e4567'))
  assert.ok(!routePattern('/cm/monitoring/:id').test('/cm/monitoring/a/b'))
  assert.ok(routePattern('/portal/*').test('/portal'))
  assert.ok(routePattern('/portal/*').test('/portal/x/y'))
  assert.ok(routePattern('/settings/sns').test('/settings/sns/'))
  assert.ok(!routePattern('/settings/sns').test('/settings/snsx'))
  assert.ok(routePattern('/a.b').test('/a.b') && !routePattern('/a.b').test('/aXb'))
})

test('the business web: only its screens; query, fragment and trailing punctuation are kept', () => {
  const guard = createLinkGuard({ base: 'https://care.example.test', routes: ROUTES })
  const input = [
    'こちらから開けます：https://care.example.test/cm/monitoring?month=2026-10',
    'くわしい手順：https://care.example.test/help/03-care-manager#manual-cm-monitoring。',
    '詳細は https://care.example.test/cm/monitoring/123e4567-e89b-42d3-a456-426614174000.',
    '間違い：https://care.example.test/cm/monitorng',
    '（https://care.example.test/settings/sns）で連携します',
  ].join('\n')
  const { text, removed } = guard(input)
  assert.deepEqual(removed, ['https://care.example.test/help/03-care-manager#manual-cm-monitoring', 'https://care.example.test/cm/monitorng'])
  assert.match(text, /こちらから開けます：https:\/\/care\.example\.test\/cm\/monitoring\?month=2026-10/)
  assert.match(text, new RegExp(`くわしい手順：${R}。`))
  assert.match(text, /cm\/monitoring\/123e4567-e89b-42d3-a456-426614174000\./)
  assert.match(text, new RegExp(`間違い：${R}`))
  assert.match(text, /（https:\/\/care\.example\.test\/settings\/sns）/)
  // with the help page declared as a route the manual link stays
  assert.deepEqual(createLinkGuard({ base: 'https://care.example.test', routes: [...ROUTES, '/help/*'] })(input).removed, ['https://care.example.test/cm/monitorng'])
})

test('a base path; other hosts only when allowed (exact or parent domain); credentials never', () => {
  const guard = createLinkGuard({ base: 'https://example.test/care/', routes: ROUTES, allowHosts: ['mhlw.go.jp'] })
  const { text, removed } = guard([
    'https://example.test/care/cm/monitoring',
    'https://example.test/other/cm/monitoring',
    'https://www.mhlw.go.jp/stf/index.html',
    'https://evil.example/phish',
    'https://user:pw@example.test/care/login',
    'http://example.test/care/login',
  ].join(' '))
  assert.deepEqual(removed, ['https://example.test/other/cm/monitoring', 'https://evil.example/phish', 'https://user:pw@example.test/care/login', 'http://example.test/care/login'])
  assert.ok(text.startsWith('https://example.test/care/cm/monitoring '))
  assert.match(text, /https:\/\/www\.mhlw\.go\.jp\/stf\/index\.html/)
})

test('no routes or no base: the guard keeps everything (it cannot tell)', () => {
  const t = 'https://anything.example/x'
  assert.deepEqual(createLinkGuard({ base: 'https://care.example.test', routes: [] })(t), { text: t, removed: [] })
  assert.deepEqual(createLinkGuard({ base: '', routes: ROUTES })(t), { text: t, removed: [] })
  assert.deepEqual(createLinkGuard({ base: 'not a url', routes: ROUTES })(t), { text: t, removed: [] })
  assert.equal(createLinkGuard({ base: 'https://a.test', routes: ROUTES })('').text, '')
})

test('【ご案内】 is a secretary label (info): frameAiText keeps it as the title', () => {
  assert.equal(HELP_LABEL, '【ご案内】')
  assert.ok(SECRETARY_LABEL_RE.test('【ご案内】モニタリングの入力'))
  const framed = frameAiText('【ご案内】モニタリングの入力\nモニタリングは「ケアマネジャー › モニタリング」で書きます。', { now: Date.parse('2026-10-29T03:00:00Z') })
  assert.equal(framed.title, '【ご案内】モニタリングの入力')
  assert.equal(framed.intent, 'info')
  assert.match(framed.text, /^お疲れさまです。モニタリングは/)
})
