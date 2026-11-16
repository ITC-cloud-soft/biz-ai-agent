// @dsh-bridge/server-kit/extract: type detection, limits, and the conversion of each document format. Every file is invented
// and built here (docx / xlsx are assembled as ZIP archives in memory).
import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import {
  detectAttachmentType, checkAttachments, extractDocument, prepareAttachments, attachmentSummary, resolveLimits, base64Size,
  decodeText, parseCsv, markdownTable, acceptAttribute, AttachmentError, ATTACHMENT_LIMITS, ATTACHMENT_TYPES, ATTACHMENT_ERRORS,
  DEFAULT_ATTACHMENT_ROLES, createPdfTextExtractor,
} from '../src/extract/index.mjs'

function zip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const body = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8)
    h.writeUInt32LE(crc32(raw) >>> 0, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc32(raw) >>> 0, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28)
    c.writeUInt32LE(offset, 42)
    locals.push(h, nameBuf, body)
    central.push(c, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(central)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10)
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, e])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const p = (text, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
function docx(body, { macro = false } = {}) {
  return zip({
    '[Content_Types].xml': `<?xml version="1.0"?><Types><Override ContentType="application/vnd.${macro ? 'ms-word.document.macroEnabled.main+xml' : 'openxmlformats-officedocument.wordprocessingml.document.main+xml'}"/></Types>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  })
}

function xlsx({ sheets, strings = [], styles = '', extra = {} }) {
  const files = {
    '[Content_Types].xml': '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    'xl/workbook.xml': `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': styles || '<styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
    ...extra,
  }
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${s.rows}</sheetData></worksheet>` })
  return zip(files)
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a......', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
const PDF = Buffer.from('%PDF-1.4\n%fake\n', 'latin1')
const DOCX_MT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

test('constants: the contract values', () => {
  assert.equal(ATTACHMENT_LIMITS.maxFiles, 5)
  assert.equal(ATTACHMENT_LIMITS.maxFileBytes, 10 * 1024 * 1024)
  assert.equal(ATTACHMENT_LIMITS.maxTotalBytes, 20 * 1024 * 1024)
  assert.equal(ATTACHMENT_LIMITS.maxCharsPerFile, 30_000)
  assert.equal(ATTACHMENT_LIMITS.maxCharsTotal, 60_000)
  assert.deepEqual(ATTACHMENT_TYPES, ['image', 'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'text'])
  assert.deepEqual(DEFAULT_ATTACHMENT_ROLES, ['admin', 'manager', 'billing'])
  assert.ok(ATTACHMENT_ERRORS.includes('images_not_supported'))
  assert.equal(acceptAttribute(['image']), '.png,.jpg,.jpeg,.webp,.gif')
  assert.deepEqual(resolveLimits({ maxFiles: 9, maxFileBytes: 1000 }).maxFiles, 5, 'limits can only be lowered')
  assert.equal(resolveLimits({ maxFileBytes: 1000 }).maxFileBytes, 1000)
})

test('detectAttachmentType: extension, media type and leading bytes must agree', () => {
  assert.deepEqual(detectAttachmentType('a.png', 'image/png', PNG), { ok: true, type: 'image', category: 'image', mediaType: 'image/png', ext: 'png' })
  assert.equal(detectAttachmentType('a.JPG', 'image/jpg', JPEG).mediaType, 'image/jpeg')
  assert.equal(detectAttachmentType('a.gif', 'image/gif', GIF).ok, true)
  assert.equal(detectAttachmentType('a.webp', '', WEBP).ok, true)
  assert.equal(detectAttachmentType('a.png', 'image/png', JPEG).error, 'type_mismatch')
  assert.equal(detectAttachmentType('a.png', 'image/jpeg', PNG).error, 'type_mismatch')
  assert.equal(detectAttachmentType('a.pdf', 'application/pdf', PDF).type, 'pdf')
  assert.equal(detectAttachmentType('a.pdf', 'application/pdf', PNG).error, 'type_mismatch')
  assert.equal(detectAttachmentType('a.png', 'image/png').ok, true, 'without bytes: name + media type only')
  assert.equal(detectAttachmentType('', 'image/png').ext, 'png', 'a pasted image without a name')
  for (const n of ['a.xlsm', 'a.docm', 'a.xls', 'a.doc', 'a.zip', 'a.exe', 'a.html', 'a.svg', 'noext']) {
    assert.equal(detectAttachmentType(n, 'application/octet-stream', Buffer.from('x')).error, 'unsupported_type', n)
  }
  // csv as Windows reports it, markdown as text/plain
  assert.equal(detectAttachmentType('a.csv', 'application/vnd.ms-excel', Buffer.from('a,b\n1,2')).type, 'csv')
  assert.equal(detectAttachmentType('a.md', 'text/plain', Buffer.from('# t')).type, 'markdown')
  assert.equal(detectAttachmentType('a.txt', 'text/plain', PNG).error, 'type_mismatch', 'binary renamed to .txt')
  assert.equal(detectAttachmentType('a.txt', 'text/plain', Buffer.from([0x61, 0, 0x62])).error, 'type_mismatch')
  // OOXML: the package must match the extension; macro-enabled packages are refused
  const d = docx(p('x'))
  assert.equal(detectAttachmentType('a.docx', DOCX_MT, d).type, 'docx')
  assert.equal(detectAttachmentType('a.xlsx', XLSX_MT, d).error, 'type_mismatch')
  assert.equal(detectAttachmentType('a.docx', DOCX_MT, docx(p('x'), { macro: true })).error, 'unsupported_type')
  assert.equal(detectAttachmentType('a.docx', DOCX_MT, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])).error, 'type_mismatch', 'an old .doc renamed')
  const withVba = xlsx({ sheets: [{ name: 'S', rows: '' }], extra: { 'xl/vbaProject.bin': 'x' } })
  assert.equal(detectAttachmentType('a.xlsx', XLSX_MT, withVba).error, 'unsupported_type')
})

test('checkAttachments: count, sizes, types, settings, model, shape', () => {
  const img = { name: 'a.png', mediaType: 'image/png', data: PNG.toString('base64') }
  const doc = { name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') }
  const ok = checkAttachments([img, doc])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.files.map((f) => [f.type, f.category, f.size]), [['image', 'image', 12], ['text', 'document', 5]])
  assert.equal(ok.totalBytes, 17)
  assert.equal(checkAttachments(Array(6).fill(img)).error, 'too_many_files')
  assert.deepEqual(checkAttachments([img, { ...doc, data: 'not base64!' }]), { ok: false, error: 'invalid_attachment', details: { index: 1, name: 'a.txt', reason: 'data' } })
  assert.equal(checkAttachments([{ name: 'big.png', mediaType: 'image/png', size: 11 * 1024 * 1024 }]).error, 'file_too_large')
  assert.equal(checkAttachments([img], { maxFileBytes: 10 }).error, 'file_too_large')
  assert.equal(checkAttachments(Array(3).fill({ name: 'b.png', mediaType: 'image/png', size: 8 * 1024 * 1024 })).error, 'total_too_large')
  assert.equal(checkAttachments([img], {}, { enabled: false }).error, 'attachments_not_allowed')
  assert.deepEqual(checkAttachments([doc, img], {}, { types: ['text'] }).details, { index: 1, name: 'a.png', reason: 'disabled' })
  assert.equal(checkAttachments([img], {}, { images: false }).error, 'images_not_supported')
  assert.equal(checkAttachments([img], {}, { images: null }).ok, true, 'unknown: images are sent')
  assert.equal(checkAttachments([{ name: 'a.txt', mediaType: 'text/plain', size: 3 }]).details.reason, 'data', 'documents need data')
  assert.equal(checkAttachments([{ name: 'a.png', mediaType: 'image/png', size: 3 }]).ok, true, 'images may come without data')
  assert.equal(checkAttachments([{ name: '../x.png', mediaType: 'image/png', size: 3 }]).details.reason, 'name')
  assert.equal(checkAttachments([{ name: 'x'.repeat(197) + '.png', mediaType: 'image/png', size: 3 }]).details.reason, 'name')
  assert.equal(checkAttachments([{ name: 'a.png', mediaType: 'image/png', size: 0 }]).details.reason, 'empty')
  assert.equal(checkAttachments('x').error, 'invalid_attachment')
  assert.equal(checkAttachments([{ ...img, size: 99 }]).details.reason, 'size', 'declared size must match the data')
  assert.equal(base64Size('YWJj'), 3)
  assert.equal(base64Size('YWI='), 2)
  assert.equal(base64Size('YW=='), 1)
  assert.equal(base64Size('YW='), null)
})

test('text and markdown: character set detection, line ends, BOM', async () => {
  assert.equal(decodeText(Buffer.from([0x82, 0xa0, 0x82, 0xa2])).encoding, 'shift_jis')
  assert.equal(decodeText(Buffer.from([0x82, 0xa0, 0x82, 0xa2])).text, 'あい')
  assert.equal(decodeText(Buffer.from('﻿あ\r\nい', 'utf8')).text, 'あ\nい')
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('あい', 'utf16le')])).text, 'あい')
  const md = await extractDocument({ name: 'メモ.md', mediaType: 'text/markdown', bytes: Buffer.from('# 見出し\r\n\r\n- 項目\r\n') })
  assert.deepEqual(md, { name: 'メモ.md', kind: 'markdown', text: '# 見出し\n\n- 項目', chars: 11, truncated: false })
  await assert.rejects(extractDocument({ name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from(' \n ') }), { code: 'no_text' })
  const long = await extractDocument({ name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('あ'.repeat(40_000)) })
  assert.equal(long.chars, 30_000)
  assert.equal(long.truncated, true)
})

test('csv: delimiter, quotes, Shift_JIS, Markdown table, empty rows and columns left out', async () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\n\n1,"x\ny",3\n'), [['a', 'b,c', 'd "e"'], ['1', 'x\ny', '3']])
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']])
  assert.equal(markdownTable([['a', '', 'c|d'], ['', '', ''], ['1', '', '3']]), '| a | c\\|d |\n| --- | --- |\n| 1 | 3 |')
  const sjis = Buffer.from([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a, 0x0d, 0x0a, 0x8d, 0xb2, 0x93, 0xa1, 0x2c, 0x31, 0x30, 0x30]) // 名前,金額 / 佐藤,100
  const r = await extractDocument({ name: '一覧.csv', mediaType: 'text/csv', bytes: sjis })
  assert.equal(r.kind, 'csv')
  assert.equal(r.text, '| 名前 | 金額 |\n| --- | --- |\n| 佐藤 | 100 |')
  const many = await extractDocument({ name: 'm.csv', mediaType: 'text/csv', bytes: Buffer.from(Array.from({ length: 30 }, (_, i) => `r${i},v`).join('\n')) }, { maxSheetRows: 10 })
  assert.equal(many.truncated, true)
  assert.match(many.text, /以下省略：10 行まで/)
})

test('docx: headings, paragraphs, bullet and numbered lists, tables, deleted text skipped', async () => {
  const body = [
    p('見積書', '<w:pStyle w:val="1"/>'),
    p('概要', '<w:pStyle w:val="Heading2"/>'),
    '<w:p><w:r><w:t>本文の</w:t></w:r><w:r><w:tab/><w:t>続き</w:t></w:r><w:del><w:r><w:delText>消した文</w:delText></w:r></w:del></w:p>',
    p('項目A', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    p('手順1', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
    `<w:tbl><w:tr><w:tc>${p('品名')}</w:tc><w:tc>${p('数量')}</w:tc></w:tr><w:tr><w:tc>${p('車いす')}</w:tc><w:tc>${p('2')}</w:tc></w:tr></w:tbl>`,
    '<w:p/>',
  ].join('')
  const r = await extractDocument({ name: '見積書.docx', mediaType: DOCX_MT, bytes: docx(body) })
  assert.equal(r.kind, 'docx')
  assert.equal(r.text, '# 見積書\n\n## 概要\n\n本文の\t続き\n\n- 項目A\n\n1. 手順1\n\n| 品名 | 数量 |\n| --- | --- |\n| 車いす | 2 |')
  assert.doesNotMatch(r.text, /消した文/)
  await assert.rejects(extractDocument({ name: 'e.docx', mediaType: DOCX_MT, bytes: docx('<w:p/>') }), { code: 'no_text' })
  const doctype = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<!DOCTYPE x [<!ENTITY a "b">]><w:document><w:body/></w:document>' })
  await assert.rejects(extractDocument({ name: 'x.docx', mediaType: DOCX_MT, bytes: doctype }), (e) => e instanceof AttachmentError && e.code === 'invalid_attachment')
})

test('xlsx: one section per visible sheet, shared strings, numbers, dates, booleans, formulas as values, row limit', async () => {
  const styles = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="9"/><xf numFmtId="20"/></cellXfs></styleSheet>'
  const rows = [
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>',
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>0.30000000000000004</v></c><c r="D3" s="1"><v>45658</v></c></row>',
    '<row r="4"><c r="A4" t="inlineStr"><is><t>小計</t></is></c><c r="B4"><f>SUM(B3:B3)</f><v>1200</v></c><c r="D4" s="2"><v>45659</v></c></row>',
    '<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" s="3"><v>0.25</v></c><c r="D5" s="4"><v>0.5</v></c></row>',
  ].join('')
  const book = xlsx({
    strings: ['品名', '金額', '日付', '手すり'],
    styles,
    sheets: [{ name: '見積', rows }, { name: '隠し', hidden: true, rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row>' }, { name: '空', rows: '' }],
  })
  const r = await extractDocument({ name: '見積書.xlsx', mediaType: XLSX_MT, bytes: book })
  assert.equal(r.kind, 'xlsx')
  assert.equal(r.sheets, 2)
  assert.equal(r.truncated, false)
  assert.equal(r.text, [
    '## 見積', '', '| 品名 | 金額 | 日付 |', '| --- | --- | --- |', '| 手すり | 0.3 | 2025-01-01 |', '| 小計 | 1200 | 2025-01-02 |', '| TRUE | 25% | 12:00 |',
    '', '## 空', '', '（空のシート）',
  ].join('\n'))
  assert.doesNotMatch(r.text, /secret/)
  const big = xlsx({ sheets: [{ name: 'S', rows: Array.from({ length: 12 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('') }] })
  const t = await extractDocument({ name: 'b.xlsx', mediaType: XLSX_MT, bytes: big }, { maxSheetRows: 5 })
  assert.equal(t.truncated, true)
  assert.match(t.text, /このシートは 12 行あります/)
})

test('pdf: injected reader, page sections, no_text, truncated pages, no reader -> unsupported_type', async () => {
  const pdfText = async (bytes, { maxPages }) => ({ numPages: 3, pages: ['一頁目の文', '', '三頁目'].slice(0, maxPages) })
  const r = await extractDocument({ name: '資料.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText })
  assert.deepEqual(r, { name: '資料.pdf', kind: 'pdf', text: '--- p.1 ---\n一頁目の文\n\n--- p.2 ---\n\n\n--- p.3 ---\n三頁目', chars: 48, truncated: false, pages: 3 })
  const cut = await extractDocument({ name: 'a.pdf', mediaType: 'application/pdf', bytes: PDF }, { maxPdfPages: 1 }, { pdfText })
  assert.equal(cut.truncated, true)
  await assert.rejects(extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: async () => ({ pages: ['', ' '], numPages: 2 }) }), { code: 'no_text' })
  await assert.rejects(extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: null }), { code: 'unsupported_type' })
  assert.equal(createPdfTextExtractor({ resolveFrom: [new URL('./no-such-dir/x.mjs', import.meta.url).href] }), null)
})

test('prepareAttachments: documents converted in order, the total character limit, images listed, summary without names', async () => {
  const files = [
    { name: '写真.png', mediaType: 'image/png', size: 2048 },
    { name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('あ'.repeat(25_000)).toString('base64') },
    { name: 'b.md', mediaType: 'text/markdown', data: Buffer.from('い'.repeat(25_000)).toString('base64') },
    { name: 'c.txt', mediaType: 'text/plain', data: Buffer.from('う'.repeat(25_000)).toString('base64') },
  ]
  const r = await prepareAttachments(files)
  assert.equal(r.ok, true)
  assert.deepEqual(r.images, [{ name: '写真.png', mediaType: 'image/png', size: 2048 }])
  assert.deepEqual(r.documents.map((d) => [d.name, d.chars, d.truncated]), [['a.txt', 25_000, false], ['b.md', 25_000, false], ['c.txt', 10_000, true]])
  assert.deepEqual(r.summary, { count: 4, types: { image: 1, text: 2, markdown: 1 }, totalBytes: 2048 + 3 * 75_000 })
  assert.doesNotMatch(JSON.stringify(r.summary), /txt|png|あ/)
  const bad = await prepareAttachments([{ name: 'x.csv', mediaType: 'text/csv', data: Buffer.from(',,\n,,').toString('base64') }])
  assert.deepEqual(bad, { ok: false, error: 'no_text', details: { index: 0, name: 'x.csv' } })
  assert.deepEqual(attachmentSummary([]), { count: 0, types: {}, totalBytes: 0 })
})

// ------------------------------------------------------------------ OCR of scanned PDF pages
const SCAN_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const scanReader = (pages, images, extra = {}) => async (bytes, { ocrPages }) => ({ numPages: pages.length, pages, images: images.slice(0, ocrPages), ...extra })

test('ocr: scanned pages come back as page images for the model, with a note in the page text', async () => {
  const pdfText = scanReader(['一頁目の文', ''], [{ page: 2, mediaType: 'image/jpeg', data: SCAN_JPEG }])
  const r = await extractDocument({ name: '記録.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText })
  assert.equal(r.ocr, 'model')
  assert.equal(r.ocrPages, 1)
  assert.deepEqual(r.pageImages, [{ page: 2, mediaType: 'image/jpeg', data: SCAN_JPEG.toString('base64') }])
  assert.match(r.text, /--- p\.1 ---\n一頁目の文\n\n--- p\.2 ---\n（スキャンのページ：この質問に画像として付いています。画像の文字を読み取ってください）/)
  // an image-only PDF is no longer no_text
  const only = await extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: scanReader([''], [{ page: 1, mediaType: 'image/jpeg', data: SCAN_JPEG }]) })
  assert.equal(only.pageImages.length, 1)
})

test('ocr: a local OCR engine turns the scanned pages into text (no images leave); engine errors leave the page empty', async () => {
  const seen = []
  const ocr = async (bytes, { mediaType, page }) => { seen.push([bytes.length, mediaType, page]); if (page === 3) throw new Error('engine'); return `頁${page}の読み取り結果` }
  const pdfText = scanReader(['', '本文', ''], [{ page: 1, mediaType: 'image/jpeg', data: SCAN_JPEG }, { page: 3, mediaType: 'image/jpeg', data: SCAN_JPEG }])
  const r = await extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText, ocr })
  assert.equal(r.ocr, 'engine')
  assert.equal(r.ocrPages, 2)
  assert.equal(r.pageImages, undefined)
  assert.equal(r.text, '--- p.1 ---\n頁1の読み取り結果\n\n--- p.2 ---\n本文\n\n--- p.3 ---')
  assert.deepEqual(seen, [[SCAN_JPEG.length, 'image/jpeg', 1], [SCAN_JPEG.length, 'image/jpeg', 3]])
})

test('ocr: off (ocrPages 0), no canvas (renderUnavailable) -> no_text with a reason; bad images are dropped', async () => {
  await assert.rejects(
    extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: scanReader([''], [{ page: 1, mediaType: 'image/jpeg', data: SCAN_JPEG }]), ocrPages: 0 }),
    (e) => e.code === 'no_text' && e.details?.reason === 'ocr_off')
  await assert.rejects(
    extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: scanReader([''], [], { renderUnavailable: true }) }),
    (e) => e.code === 'no_text' && e.details?.reason === 'ocr_unavailable')
  const bad = [{ page: 9, mediaType: 'image/jpeg', data: SCAN_JPEG }, { page: 1, mediaType: 'image/png', data: SCAN_JPEG }, { page: 1, mediaType: 'image/jpeg', data: Buffer.alloc(0) }]
  await assert.rejects(extractDocument({ name: 's.pdf', mediaType: 'application/pdf', bytes: PDF }, {}, { pdfText: scanReader([''], bad) }), { code: 'no_text' })
})

test('ocr in prepareAttachments: one page budget for all documents, settings.ocr false turns it off, the summary counts pages', async () => {
  const b64 = PDF.toString('base64')
  const files = [
    { name: 'a.pdf', mediaType: 'application/pdf', size: PDF.length, data: b64 },
    { name: 'b.pdf', mediaType: 'application/pdf', size: PDF.length, data: b64 },
  ]
  const eight = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, mediaType: 'image/jpeg', data: SCAN_JPEG }))
  const pdfText = scanReader(Array(8).fill(''), eight)
  const r = await prepareAttachments(files, { pdfText })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.documents.map((d) => d.pageImages.length), [8, 2], 'maxOcrPages (10) across both files')
  assert.equal(r.summary.ocrPages, 10)
  const off = await prepareAttachments(files, { pdfText, settings: { ocr: false } })
  assert.equal(off.ok, false)
  assert.equal(off.error, 'no_text')
  assert.equal(ATTACHMENT_LIMITS.maxOcrPages, 10)
})
