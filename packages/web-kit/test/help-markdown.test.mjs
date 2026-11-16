// help-markdown-core: the manual on a help page (@dsh-bridge/help manuals). Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { manualChapters, manualHref, parseInline, parseMarkdown, sectionsOf } from '../src/core/help-markdown-core.ts'

test('inline: bold, code, links (chapters → <basePath>/<chapter>, other documents → text, http → external)', () => {
  assert.deepEqual(parseInline('**Q. どこ？** `/x` と [A](02-a.md#manual-a)、[設計](../design/X.md)、[外](https://example.test/x)'), [
    { kind: 'bold', text: 'Q. どこ？' }, { kind: 'text', text: ' ' }, { kind: 'code', text: '/x' }, { kind: 'text', text: ' と ' },
    { kind: 'link', text: 'A', href: '/help/02-a#manual-a', external: false }, { kind: 'text', text: '、' },
    { kind: 'text', text: '設計' }, { kind: 'text', text: '、' }, { kind: 'link', text: '外', href: 'https://example.test/x', external: true },
  ])
  assert.deepEqual(manualHref('02-a.md', { basePath: '/docs/manual' }), { href: '/docs/manual/02-a', external: false })
  assert.deepEqual(parseInline('[A](02-a.md)', { basePath: '/m' })[0], { kind: 'link', text: 'A', href: '/m/02-a', external: false })
  assert.equal(manualHref('javascript:alert(1)'), null)
})

test('blocks: heading ids from anchors, tables, lists with continuation lines', () => {
  const b = parseMarkdown('# 1. X\n\n## A\n\n<a id="manual-a"></a>\n\n| a | b |\n|---|---|\n| URL | `/a` |\n\n- **Q. q**\n  A. a\n\n1. one\n2. two\n')
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'heading', 'table', 'list', 'list'])
  assert.equal(b[1].id, 'manual-a')
  assert.deepEqual(b[3].items[0][1], [{ kind: 'text', text: 'A. a' }])
})

test('the example manual (examples/equipment-inspection/manual): chapters and their section anchors', () => {
  const dir = new URL('../../../examples/equipment-inspection/manual/', import.meta.url)
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]))
  const chapters = manualChapters(files)
  assert.deepEqual(chapters.map((c) => c.id), ['01-basics', '02-inspections'])
  assert.deepEqual(sectionsOf(chapters[0]).map((s) => s.id), ['manual-basics-login', 'manual-basics-sns-link', 'manual-basics-notify'])
  assert.match(chapters[0].audience, /^この章の対象/)
})
