// @dsh-bridge/knowledge without a server: Markdown, chunks, visibility, the personal-data screen, the search and its rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KnowledgeBuildError, buildKnowledgeIndex, canSee, chunkText, createKnowledgeSearcher, createKnowledgeService, localKinds, parseKnowledgeMarkdown,
  queryTerms, searchKnowledge, sectionVisibility, documentVisibility, splitSections, termsOf,
} from '../src/index.mjs'

const ROLES = ['admin', 'manager', 'staff']

const MD = `---
id: travel-policy
title: Travel policy
link: /handbook/travel-policy
roles: [admin, manager, staff]
keywords: [business trip, expenses]
---
Rules for business trips (fictional).

## Booking {#booking}
Book trains and hotels through the travel desk at least 3 days ahead.

## Expense limits {#limits roles=admin,manager}
Hotel up to 15000 yen per night. Managers approve expense claims within 5 working days.

## 出張の精算 {#seisan}
出張の精算は帰ってから 10 日以内に申請してください。
`

test('Markdown: front matter, sections with anchors and narrowed roles, the introduction', () => {
  const d = parseKnowledgeMarkdown(MD)
  assert.equal(d.id, 'travel-policy')
  assert.deepEqual(d.visibility.roles, ['admin', 'manager', 'staff'])
  assert.deepEqual(d.keywords, ['business trip', 'expenses'])
  assert.deepEqual(d.sections.map((s) => [s.heading, s.anchor ?? null, s.roles ?? null]), [
    [null, null, null], ['Booking', 'booking', null], ['Expense limits', 'limits', ['admin', 'manager']], ['出張の精算', 'seisan', null],
  ])
  assert.throws(() => splitSections('## A {color=red}\ntext'), /unknown heading attribute/)
})

test('chunks: paragraphs packed up to the limit; a long paragraph is cut at sentence ends', () => {
  assert.deepEqual(chunkText('a\n\nb\n\nc', 10), ['a\n\nb\n\nc'])
  const long = 'One sentence here. '.repeat(20).trim()
  const parts = chunkText(long, 100)
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 100))
  assert.ok(parts.slice(0, -1).every((p) => p.endsWith('.')))
})

test('visibility: required, known roles only, sections only narrow, canSee by role or by employee id', () => {
  assert.throws(() => documentVisibility({}, { declaredRoles: ROLES, where: 'd' }), /never visible to everyone/)
  assert.throws(() => documentVisibility({ roles: ['boss'] }, { declaredRoles: ROLES, where: 'd' }), /unknown role/)
  const doc = documentVisibility({ roles: ['manager', 'staff'], users: ['u-1'] }, { declaredRoles: ROLES, where: 'd' })
  assert.throws(() => sectionVisibility(doc, { roles: ['admin'] }, { where: 's' }), /can only narrow/)
  assert.throws(() => sectionVisibility(doc, { users: ['u-2'] }, { where: 's' }), /can only narrow/)
  const narrow = sectionVisibility(doc, { roles: ['manager'] }, { where: 's' })
  assert.deepEqual([narrow.roles, narrow.users], [['manager'], []])
  assert.equal(sectionVisibility(doc, {}, { where: 's' }), doc)
  assert.equal(canSee(doc, { id: 'u-9', role: 'staff' }), true)
  assert.equal(canSee(doc, { id: 'u-1', role: 'admin' }), true, 'named employee')
  assert.equal(canSee(doc, { id: 'u-9', role: 'admin' }), false)
  assert.equal(canSee(doc, null), false)
  assert.equal(canSee(doc, { id: '', role: '' }), false)
})

test('personal data: e-mail, phone and long numbers are found; dates and amounts are not', () => {
  assert.deepEqual(localKinds('mail desk@example.co.jp'), ['email'])
  assert.deepEqual(localKinds('call 03-1234-5678 or +81 90 1234 5678'), ['phone'])
  assert.deepEqual(localKinds('account 12345678901'), ['long_number'])
  assert.deepEqual(localKinds('from 2026-11-14 to 2026-12-31, up to 15000 yen, 10 日以内'), [])
})

test('build: links must be screens of web.routes; the screen hook sees every chunk; failures list ids and kinds, never text', async () => {
  const d = parseKnowledgeMarkdown(MD)
  await assert.rejects(buildKnowledgeIndex([d], { roles: ROLES, routes: ['/leave-requests'] }), /not a screen of the business web/)
  const seen = []
  const index = await buildKnowledgeIndex([d], { roles: ROLES, routes: ['/handbook/:docId'], screen: (t) => { seen.push(t); return { kinds: /15000/.test(t) ? ['amount'] : [] } }, onPersonalData: 'skip' })
  assert.equal(seen.length, 4)
  assert.deepEqual(index.rejected, [{ chunkId: 'travel-policy:2:0', documentId: 'travel-policy', kinds: ['amount'] }])
  await assert.rejects(buildKnowledgeIndex([d], { roles: ROLES, screen: (t) => ({ kinds: /15000/.test(t) ? ['amount'] : [] }) }), (e) => e instanceof KnowledgeBuildError && /travel-policy:2:0: personal data \(amount\)/.test(e.message) && !/15000/.test(e.message))
  await assert.rejects(buildKnowledgeIndex([d, d], { roles: ROLES }), /duplicate id/)
})

test('search: permissions before statistics; the restricted section only for its roles; Japanese without a tokenizer', async () => {
  const index = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const s = createKnowledgeSearcher(index)
  const staff = { id: 's1', role: 'staff' }
  const manager = { id: 'm1', role: 'manager' }
  assert.equal(s.visibleCount(staff), 3)
  assert.equal(s.visibleCount(manager), 4)
  assert.equal(searchKnowledge(s, 'hotel expense limits per night', { asker: manager }).results[0].id, 'travel-policy:2:0')
  assert.ok(!searchKnowledge(s, 'hotel expense limits per night', { asker: staff, limit: 5 }).results.some((r) => r.id === 'travel-policy:2:0'))
  const ja = searchKnowledge(s, '出張の精算はいつまでに申請', { asker: staff })
  assert.equal(ja.results[0].id, 'travel-policy:3:0')
  assert.deepEqual(ja.results[0].source, { title: 'Travel policy › 出張の精算', url: '/handbook/travel-policy#seisan' })
  assert.deepEqual(searchKnowledge(s, 'hotel', { asker: null }), { found: false, results: [] }, 'no asker: nothing')
  assert.deepEqual(searchKnowledge(s, 'zzqx qqzx', { asker: manager }), { found: false, results: [] })
})

test('search: the hidden chunks change no score (the same as an index without them)', async () => {
  const full = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const cut = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD.replace(/## Expense limits[\s\S]*?(?=## 出張)/, '## Expense limits {#limits roles=admin,manager}\n\n'))], { roles: ROLES })
  const staff = { id: 's1', role: 'staff' }
  for (const q of ['hotel expense', 'book trains', 'business trip', '出張の精算', 'managers approve']) {
    assert.deepEqual(searchKnowledge(createKnowledgeSearcher(full), q, { asker: staff, limit: 5 }), searchKnowledge(createKnowledgeSearcher(cut), q, { asker: staff, limit: 5 }), q)
  }
})

test('terms: bigrams for Japanese / Chinese runs, words and numbers for Latin text; question words dropped', () => {
  assert.deepEqual(termsOf("Carry-over days, the manager's"), ['w:carry', 'w:over', 'w:day', 'w:the', 'w:manager'])
  assert.deepEqual(termsOf('有給休暇 5 日'), ['有給', '給休', '休暇', '日', 'n:5'])
  assert.deepEqual(termsOf('リモートワーク'), termsOf('りもーとわーく'), 'katakana = hiragana (help normalize)')
  assert.ok(termsOf('20 days').includes('n:20'))
  const { own } = queryTerms('How many days of annual leave do I get?')
  assert.deepEqual([...own].sort(), ['w:annual', 'w:day', 'w:leave'])
})

test('service: setIndex swaps the index for later searches', async () => {
  const a = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  const svc = createKnowledgeService(a, { webBase: 'https://lr.example/' })
  const r = await svc.search('book trains hotels', { asker: { id: 's', role: 'staff' } })
  assert.equal(r.results[0].source.url, 'https://lr.example/handbook/travel-policy#booking')
  svc.setIndex(await buildKnowledgeIndex([], { roles: ROLES }))
  assert.deepEqual(await svc.search('book trains hotels', { asker: { id: 's', role: 'staff' } }), { found: false, results: [] })
})
