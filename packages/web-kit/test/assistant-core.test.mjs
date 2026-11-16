// The AI assistant panel's pure parts: answers as safe Markdown (links by rule, never HTML) and the attachment picker's checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantLinkHref, parseAssistantMarkdown, parseInline, parseMarkdown,
  ASSISTANT_ATTACHMENT_LIMITS, ATTACHMENT_TYPE_IDS, acceptFor, attachmentErrorOf, attachmentTypeOf, bytesToBase64, extensionsFor, fileToBase64,
  formatBytes, normAttachmentSettings, pastedName, planAdd, sameAdminSettings, sniffMatches, toMessageAttachments, STRINGS_JA, ATTACHMENT_ERROR_CODES,
} from '../src/core/index.ts'

test('answer Markdown: headings, bold / italic / code, lists with a start number, tables with escaped pipes, code blocks, line breaks', () => {
  const b = parseAssistantMarkdown('## 結論\n**3 件**あります。*確認*してください\n次の行\n\n1. `A`\n2. B\n\n3. C\n\n| 列 | 値 |\n|---|---|\n| a\\|b | 1 |\n\n```js\nconst x = 1 < 2\n```\n\n> 引用\n')
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'para', 'list', 'list', 'table', 'code', 'para'])
  assert.equal(b[0].level, 2)
  assert.deepEqual(b[1].inline, [
    { kind: 'bold', text: '3 件' }, { kind: 'text', text: 'あります。' }, { kind: 'italic', text: '確認' }, { kind: 'text', text: 'してください' },
    { kind: 'br', text: '\n' }, { kind: 'text', text: '次の行' },
  ])
  assert.equal(b[2].start, undefined)
  assert.equal(b[3].start, 3)
  assert.deepEqual(b[4].rows[0][0], [{ kind: 'text', text: 'a|b' }])
  assert.deepEqual(b[5], { kind: 'code', lang: 'js', text: 'const x = 1 < 2' })
  assert.deepEqual(b[6].inline, [{ kind: 'text', text: '引用' }])
  // markup stays text: no HTML is ever produced
  assert.deepEqual(parseAssistantMarkdown('<img src=x onerror=alert(1)>')[0].inline, [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  // the manual keeps its old behaviour (spaces between lines)
  assert.deepEqual(parseMarkdown('a\nb')[0].inline, [{ kind: 'text', text: 'a b' }])
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ kind: 'text', text: '2 * 3 * 4' }], 'a lone star is not italic')
})

test('answer links: own paths and origin, allowed hosts (external), everything else text', () => {
  const o = { origin: 'https://care.example.test', allowedHosts: ['www.mhlw.go.jp', '*.example.org'] }
  assert.deepEqual(assistantLinkHref('/billing/2026-10', o), { href: '/billing/2026-10', external: false })
  assert.deepEqual(assistantLinkHref('https://care.example.test/residents?x=1#a', o), { href: '/residents?x=1#a', external: false })
  assert.deepEqual(assistantLinkHref('https://www.mhlw.go.jp/a', o), { href: 'https://www.mhlw.go.jp/a', external: true })
  assert.deepEqual(assistantLinkHref('https://docs.example.org/a', o), { href: 'https://docs.example.org/a', external: true })
  assert.equal(assistantLinkHref('https://example.org.evil.test/a', o), null)
  assert.equal(assistantLinkHref('https://evil.test/a', o), null)
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/x', 'mailto:a@example.test', 'https://u:p@www.mhlw.go.jp/', '/a b', 'vbscript:x']) {
    assert.equal(assistantLinkHref(bad, o), null, bad)
  }
  assert.equal(assistantLinkHref('/admin/x', { allowedPrefixes: ['/billing'] }), null)
  assert.deepEqual(assistantLinkHref('/billing/x', { allowedPrefixes: ['/billing'] }), { href: '/billing/x', external: false })
  assert.equal(assistantLinkHref('/billingx', { allowedPrefixes: ['/billing'] }), null)
  const b = parseAssistantMarkdown('[請求](/billing) と [外](https://evil.test) と [厚労省](https://www.mhlw.go.jp/)', o)
  assert.deepEqual(b[0].inline, [
    { kind: 'link', text: '請求', href: '/billing', external: false }, { kind: 'text', text: ' と ' }, { kind: 'text', text: '外' }, { kind: 'text', text: ' と ' },
    { kind: 'link', text: '厚労省', href: 'https://www.mhlw.go.jp/', external: true },
  ])
})

test('attachment types, accept attribute, leading bytes', () => {
  assert.deepEqual(ATTACHMENT_TYPE_IDS, ['image', 'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'text'])
  assert.deepEqual(attachmentTypeOf('a.PNG', 'image/png'), { type: 'image', mediaType: 'image/png' })
  assert.deepEqual(attachmentTypeOf('a.csv', 'application/vnd.ms-excel'), { type: 'csv', mediaType: 'text/csv' })
  assert.deepEqual(attachmentTypeOf('a.xlsm', ''), { error: 'unsupported_type' })
  assert.deepEqual(attachmentTypeOf('a.png', 'image/jpeg'), { error: 'type_mismatch' })
  assert.deepEqual(attachmentTypeOf('', 'image/png'), { type: 'image', mediaType: 'image/png' })
  assert.equal(acceptFor(['image', 'pdf']), '.png,.jpg,.jpeg,.webp,.gif,.pdf')
  assert.deepEqual(extensionsFor(['markdown', 'text']), ['.md', '.txt'])
  assert.equal(sniffMatches('image', 'image/png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), true)
  assert.equal(sniffMatches('image', 'image/png', Uint8Array.from([0xff, 0xd8, 0xff])), false)
  assert.equal(sniffMatches('xlsx', '', Uint8Array.from([0x50, 0x4b, 3, 4])), true)
  assert.equal(sniffMatches('text', '', Uint8Array.from([0x61, 0, 0x62])), false)
  assert.equal(pastedName('image/png', 2), '貼り付けた画像-2.png')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB')
  assert.equal(formatBytes(1.55 * 1024 * 1024), '1.6 MB')
})

test('planAdd: types, model, size, count, total — in order, one error per refused file', () => {
  const L = { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 140 }
  const r = planAdd([{ size: 40 }], [
    { name: 'a.png', mediaType: 'image/png', size: 10 },
    { name: 'b.exe', mediaType: '', size: 10 },
    { name: 'c.pdf', mediaType: 'application/pdf', size: 101 },
    { name: 'd.pdf', mediaType: 'application/pdf', size: 95 },
    { name: 'e.txt', mediaType: 'text/plain', size: 20 },
    { name: 'f.txt', mediaType: 'text/plain', size: 1 },
  ], { limits: L })
  assert.deepEqual(r.accept.map((a) => a.index), [0, 4])
  assert.deepEqual(r.errors, [{ code: 'unsupported_type', name: 'b.exe' }, { code: 'file_too_large', name: 'c.pdf' }, { code: 'total_too_large', name: 'd.pdf' }, { code: 'too_many_files', name: 'f.txt' }])
  assert.deepEqual(planAdd([], [{ name: 'a.png', mediaType: 'image/png', size: 1 }], { images: false }).errors, [{ code: 'images_not_supported', name: 'a.png' }])
  assert.deepEqual(planAdd([], [{ name: 'a.png', mediaType: 'image/png', size: 1 }], { types: ['pdf'] }).errors, [{ code: 'unsupported_type', name: 'a.png' }])
})

test('settings normalization, base64, message body, error codes and their strings', async () => {
  assert.equal(normAttachmentSettings(null), null)
  assert.deepEqual(normAttachmentSettings({ enabled: true, roles: ['admin', 1], types: ['image', 'exe', 'pdf'], limits: { maxFiles: 99, maxFileBytes: 1000 } }), {
    enabled: true, roles: ['admin'], types: ['image', 'pdf'], limits: { maxFiles: 5, maxFileBytes: 1000, maxTotalBytes: ASSISTANT_ATTACHMENT_LIMITS.maxTotalBytes },
  })
  assert.equal(normAttachmentSettings({ enabled: true, types: [] }).enabled, false, 'no type: nothing to attach')
  assert.equal(bytesToBase64(new TextEncoder().encode('あいう')), Buffer.from('あいう').toString('base64'))
  const big = new Uint8Array(100_000).map((_, i) => i % 251)
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'))
  const f = await fileToBase64(new Blob([new Uint8Array([1, 2, 3])]))
  assert.equal(f.data, 'AQID')
  assert.deepEqual([...f.head], [1, 2, 3])
  assert.deepEqual(toMessageAttachments([{ id: 'x', name: 'a.png', mediaType: 'image/png', type: 'image', size: 3, data: 'AQID', previewUrl: 'blob:x' }]), [{ name: 'a.png', mediaType: 'image/png', data: 'AQID' }])
  assert.equal(attachmentErrorOf({ ok: false, error: 'images_not_supported' }), 'images_not_supported')
  assert.equal(attachmentErrorOf({ ok: false, error: 'forbidden' }), null)
  for (const code of ATTACHMENT_ERROR_CODES) assert.ok(STRINGS_JA[`attach.err.${code}`], code)
  assert.equal(sameAdminSettings({ roles: ['a', 'b'], types: ['pdf'] }, { roles: ['b', 'a'], types: ['pdf'] }), true)
  assert.equal(sameAdminSettings({ roles: ['a'], types: ['pdf'] }, { roles: ['a'], types: [] }), false)
})
