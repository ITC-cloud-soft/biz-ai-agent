// @dsh-bridge/help on a real (fictional) manual: examples/equipment-inspection/manual. Pure except reading that folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import {
  buildHelpIndex, checkAnchors, checkCoverage, checkLinks, checkLinksAreRoutes, checkMenuLabels, checkRoleText, checkSectionPaths, createHelpService,
  createSearcher, expandQuery, listPath, normalize, parseChapter, parseManual, readManualDir, routeOf, routePattern, searchManual, serializeIndex,
  setManifestWebRoutes, terms,
} from '../src/index.mjs'

const DIR = fileURLToPath(new URL('../../../examples/equipment-inspection/manual/', import.meta.url))
const ROLES = ['admin', 'manager', 'inspector']
const LABELS = { admin: '施設管理者', manager: '設備責任者', inspector: '点検員' }
const ROUTES = [{ path: '/', roles: ROLES }, { path: '/equipment', roles: ['admin', 'manager'] }, { path: '/equipment/:id', roles: ['admin', 'manager'] }]
const manual = readManualDir(DIR)
const chapters = parseManual(manual.files)
const index = buildHelpIndex({ chapters, routes: ROUTES, roles: ROLES, publicSections: ['manual-basics-login', 'manual-basics-sns-*'], synonyms: manual.synonyms })

test('routes: patterns, the route of a path, the list path of a detail screen', () => {
  assert.ok(routePattern('/equipment/:id').test('/equipment/42') && !routePattern('/equipment/:id').test('/equipment/42/x'))
  assert.ok(routePattern('/portal/*').test('/portal') && routePattern('/portal/*').test('/portal/a/b'))
  assert.equal(routeOf('/equipment/42?x=1', ROUTES).path, '/equipment/:id')
  assert.equal(routeOf('/equipment', ROUTES).path, '/equipment')
  assert.equal(routeOf('/nope', ROUTES), null)
  assert.deepEqual([listPath('/equipment/:id'), listPath('/a/:id/b'), listPath('/x'), listPath('/:id')], ['/equipment', '/a', '/x', null])
})

test('the manual parses: chapters, sections, table rows, steps, FAQ, unconfirmed lines; synonyms', () => {
  assert.deepEqual(chapters.map((c) => [c.chapter, c.sections.length]), [['01-basics', 3], ['02-inspections', 2]])
  const login = chapters[0].sections[0]
  assert.equal(login.id, 'manual-basics-login')
  assert.deepEqual([login.title, login.menu, login.paths, login.roleText], ['ログイン', '画面の「ログイン」', ['/'], 'すべての職員'])
  assert.deepEqual(login.steps, ['「ログイン ID」と「パスワード」を入れます。', '「ログイン」を押します。'])
  assert.equal(login.qa[0].q, 'ログインできない。')
  assert.deepEqual(login.related, ['manual-basics-sns-link'])
  assert.ok(manual.synonyms.length >= 3)
  const odd = parseChapter('09-x.md', '# 9. X\n\n## A\n\n<a id="manual-x-a"></a>\n\n| 項目 | 内容 |\n|---|---|\n| URL | `/a` |\n| アプリの画面 | APP-1 ホーム |\n\n- 決め方は（要確認）。\n')
  assert.deepEqual(odd.sections[0].unconfirmed, ['決め方は（要確認）。'])
  assert.deepEqual(odd.sections[0].app, { screen: 'APP-1 ホーム', location: '' })
})

test('the index: roles from the routes (not the text), public sections, deterministic', () => {
  const byId = new Map(index.sections.map((s) => [s.id, s]))
  assert.deepEqual(byId.get('manual-basics-login').roles, ROLES)
  assert.equal(byId.get('manual-basics-login').public, true)
  assert.equal(byId.get('manual-basics-sns-link').public, true)
  assert.equal(byId.get('manual-basics-notify').public, false)
  assert.equal(serializeIndex(index), serializeIndex(buildHelpIndex({ chapters: parseManual(manual.files), routes: ROUTES, roles: ROLES, publicSections: ['manual-basics-login', 'manual-basics-sns-*'], synonyms: manual.synonyms })))
  assert.deepEqual(JSON.parse(serializeIndex(index)), JSON.parse(JSON.stringify(index)))
})

test('CI checks: clean on the example; each check catches its mistake', () => {
  assert.deepEqual(checkAnchors(chapters), [])
  assert.deepEqual(checkSectionPaths(chapters, ROUTES), [])
  assert.deepEqual(checkCoverage(chapters, ROUTES.slice(0, 1)), [])
  assert.deepEqual(checkRoleText(chapters, [{ path: '/', roles: ['admin'] }], { labels: LABELS }).length, 0) // 「すべての職員」
  assert.deepEqual(checkLinks(manual.files, chapters), [])
  // mistakes
  const broken = parseManual({ '01-a.md': '# 1\n\n## A\n\n<a id="manual-a"></a>\n\n| 項目 | 内容 |\n|---|---|\n| URL | `/nope` |\n| メニュー | 古い名前 |\n| 使える役割 | 施設管理者 |\n\n[x](02-b.md#manual-b) [y](#manual-zz)\n\n## A2\n\n<a id="manual-a"></a>\n' })
  assert.match(checkAnchors(broken)[0], /duplicate anchor manual-a/)
  assert.match(checkSectionPaths(broken, ROUTES)[0], /\/nope is not a route/)
  assert.deepEqual(checkCoverage(chapters, ROUTES, { exclusions: ['/gone'] }).sort(), [
    'exclusion /gone is no route any more', 'route /equipment has no section (add one, or the path with a reason to the exclusions)',
    'route /equipment/:id has no section (add one, or the path with a reason to the exclusions)',
  ].sort())
  assert.match(checkCoverage(chapters, ROUTES.slice(0, 1), { menuPaths: ['/equipment'] })[0], /menu item \/equipment has no section/)
  const roleCase = parseManual({ '01-a.md': '# 1\n\n## A\n\n<a id="manual-a"></a>\n\n| 項目 | 内容 |\n|---|---|\n| URL | `/equipment` |\n| メニュー | 設備 |\n| 使える役割 | 施設管理者 |\n' })
  assert.match(checkRoleText(roleCase, ROUTES, { labels: LABELS })[0], /does not name 設備責任者/)
  assert.deepEqual(checkRoleText(roleCase, ROUTES, { labels: LABELS, skip: (_s, r) => r === 'manager' }), [])
  assert.match(checkMenuLabels(roleCase, new Map([['/equipment', '設備・備品']]))[0], /does not name 「設備・備品」/)
  assert.deepEqual(checkLinks({ '01-a.md': '[x](02-b.md#manual-b) [y](#manual-zz) [z](../README.md)' }, broken), ['01-a.md: link to a missing chapter 02-b.md#manual-b', '01-a.md: unresolved anchor #manual-zz'])
  assert.deepEqual(checkLinksAreRoutes([{ from: 'notice', path: '/equipment/${id}' }, { from: 'manifest', path: '/repair/{id}' }], (p) => Boolean(routeOf(p, ROUTES))), ['manifest: link /repair/{id} is not a route'])
})

test('search: normalization, fillers and synonyms; the right section; nothing for an unrelated question', () => {
  assert.equal(normalize('ロ グ イ ン！'), 'ろぐいん')
  assert.deepEqual(terms('ろぐ'), ['ろぐ'])
  assert.deepEqual(expandQuery('期限切れの設備はどこ？', manual.synonyms).extra, ['点検期限'])
  const s = createSearcher(index)
  const top = (q, role = 'manager') => searchManual(s, q, { role, roleLabels: LABELS }).results.map((r) => r.id)
  assert.equal(top('ログインできない')[0], 'manual-basics-login')
  assert.equal(top('修理依頼を承認したい')[0], 'manual-inspections-repair-approval')
  assert.equal(top('期限切れの設備はどこ？')[0], 'manual-inspections-overdue')
  assert.equal(top('SNS の連携のしかた')[0], 'manual-basics-sns-link')
  assert.equal(searchManual(s, '今日の天気は？', { role: 'admin' }).found, false)
  // every FAQ question finds its own section first
  for (const sec of index.sections) for (const { q } of sec.qa) assert.equal(top(q)[0], sec.id, q)
})

test('answers: URL on the web base only when the role may open the screen, whom to ask otherwise; the public sections for no role', () => {
  const routes = [{ path: '/', roles: ROLES }, { path: '/equipment', roles: ['admin', 'manager'] }]
  const ix = buildHelpIndex({
    chapters: parseManual({ ...manual.files, '03-equipment.md': '# 3\n\n## 設備の一覧\n\n<a id="manual-eq-list"></a>\n\n| 項目 | 内容 |\n|---|---|\n| URL | `/equipment`（詳細：`/equipment/:id`） |\n| キーワード | 設備の一覧、消火器、AED |\n\n設備の一覧を見ます。\n' }),
    routes, roles: ROLES, publicSections: ['manual-basics-login'],
  })
  const help = createHelpService(ix, { webBase: () => 'https://eq.example.test/', roleLabels: LABELS })
  const asManager = help.search('設備の一覧を見たい', { role: 'manager' }).results.find((r) => r.id === 'manual-eq-list')
  assert.deepEqual([asManager.canOpen, asManager.url, asManager.manualUrl, asManager.alt], [true, 'https://eq.example.test/equipment', 'https://eq.example.test/help/03-equipment#manual-eq-list', null])
  const asInspector = help.search('設備の一覧を見たい', { role: 'inspector' }).results.find((r) => r.id === 'manual-eq-list')
  assert.deepEqual([asInspector.canOpen, asInspector.url, asInspector.alt], [false, null, 'この画面は 施設管理者・設備責任者 が使います。施設管理者・設備責任者にご依頼ください。'])
  const anon = help.search('ログインできない', { role: null })
  assert.ok(anon.found && anon.results.every((r) => ix.sections.find((s) => s.id === r.id).public))
  assert.equal(help.search('設備の一覧を見たい', { role: null }).found, false)
  assert.equal(help.section('manual-eq-list', { role: null }), null)
  assert.equal(help.section('manual-eq-list', { role: 'admin' }).url, 'https://eq.example.test/equipment')
  assert.equal(help.section('manual-none', { role: 'admin' }), null)
  // prefer and demote
  const s = createSearcher(ix)
  assert.equal(searchManual(s, 'ログイン', { role: 'inspector', prefer: { inspector: ['02-'] } }).results.length > 0, true)
  // no manual page
  assert.equal(createHelpService(ix, { manualPage: '' }).search('ログインできない', { role: 'admin' }).results[0].manualUrl, null)
})

test('setManifestWebRoutes: inserts the web block before roles:, then replaces it', () => {
  const yaml = 'bridge: 1\nsystem:\n  id: x\n\nroles:\n  admin: {}\n'
  const once = setManifestWebRoutes(yaml, ['/', '/a/:id'])
  assert.match(once, /web:\n {2}routes:\n {4}- '\/'\n {4}- '\/a\/:id'\n\nroles:/)
  assert.equal(setManifestWebRoutes(once, ['/', '/a/:id']), once)
  assert.match(setManifestWebRoutes(once, ['/b']), /routes:\n {4}- '\/b'\n\nroles:/)
  assert.throws(() => setManifestWebRoutes('bridge: 1\n', ['/']), /no roles/)
  // a hand-written web: block (after roles:, without the header) is replaced in place, never duplicated
  const hand = 'bridge: 1\nroles:\n  admin: {}\nweb:\n  routes:\n    - /old\n\nevents: {}\n'
  const fixed = setManifestWebRoutes(hand, ['/new'])
  assert.equal(fixed.match(/^web:/gm).length, 1)
  assert.match(fixed, /roles:\n {2}admin: \{\}\n# The screens[^\n]*\nweb:\n {2}routes:\n {4}- '\/new'\n\nevents: \{\}\n$/)
  assert.equal(setManifestWebRoutes(fixed, ['/new']), fixed)
  const atEnd = setManifestWebRoutes('bridge: 1\nroles:\n  a: {}\nweb:\n  routes: []\n', ['/'])
  assert.equal(atEnd.match(/^web:/gm).length, 1)
})
