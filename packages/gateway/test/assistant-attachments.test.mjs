// The BFF part for files attached in the AI assistant panel: the early check and the message.send attachments.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareAssistantAttachments, checkAssistantAttachments, attachmentErrorStatus, ASSISTANT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_PROMPT,
  MAX_SCANNED_PAGES,
} from '../src/index.mjs'

const b64 = (b) => Buffer.from(b).toString('base64')
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const XLSX = b64(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]))
const XLSX_MT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

test('constants', () => {
  assert.deepEqual(ASSISTANT_ATTACHMENT_LIMITS, { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxNameLength: 200 })
  assert.equal(DEFAULT_ATTACHMENT_PROMPT, '添付した資料について説明してください。')
  assert.equal(attachmentErrorStatus('attachments_not_allowed'), 403)
  assert.equal(attachmentErrorStatus('type_mismatch'), 422)
  assert.equal(attachmentErrorStatus('attachment_prepare_failed'), 502)
})

test('checkAssistantAttachments: count, sizes, extension + leading bytes, settings, model', () => {
  assert.deepEqual(checkAssistantAttachments(undefined), { ok: true, files: [], totalBytes: 0 })
  const img = { name: '写真.png', mediaType: 'image/png', data: PNG }
  const ok = checkAssistantAttachments([img])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.files[0], { index: 0, name: '写真.png', mediaType: 'image/png', type: 'image', category: 'image', size: 11, data: PNG })
  assert.equal(checkAssistantAttachments(Array(6).fill(img)).error, 'too_many_files')
  assert.equal(checkAssistantAttachments([{ ...img, name: 'a.jpg', mediaType: 'image/jpeg' }]).error, 'type_mismatch')
  assert.equal(checkAssistantAttachments([{ ...img, mediaType: 'application/pdf' }]).error, 'type_mismatch')
  assert.equal(checkAssistantAttachments([{ ...img, name: 'a.xlsm' }]).error, 'unsupported_type')
  assert.deepEqual(checkAssistantAttachments([{ ...img, data: 'xx!' }]), { ok: false, error: 'invalid_attachment', status: 422, details: { index: 0, name: '写真.png', reason: 'data' } })
  assert.equal(checkAssistantAttachments([img], { limits: { maxFileBytes: 5 } }).error, 'file_too_large')
  assert.equal(checkAssistantAttachments([img, img], { limits: { maxTotalBytes: 15 } }).error, 'total_too_large')
  const off = checkAssistantAttachments([img], { settings: { enabled: false } })
  assert.equal(off.error, 'attachments_not_allowed')
  assert.equal(off.status, 403)
  assert.equal(checkAssistantAttachments([img], { settings: { enabled: true, types: ['pdf'] } }).details.reason, 'disabled')
  assert.equal(checkAssistantAttachments([img], { imagesSupported: false }).error, 'images_not_supported')
  assert.equal(checkAssistantAttachments([img], { imagesSupported: null }).ok, true)
  assert.equal(checkAssistantAttachments([{ name: 'a.txt', mediaType: 'text/plain', data: b64([0x61, 0, 0x62]) }]).error, 'type_mismatch')
  assert.equal(checkAssistantAttachments([{ name: 'a.csv', mediaType: 'application/vnd.ms-excel', data: b64('a,b') }]).ok, true)
})

test('prepareAssistantAttachments: images keep base64 and skip data in prepare, documents come back as text', async () => {
  const calls = []
  const callPrepare = async (body) => {
    calls.push(body)
    return { ok: true, documents: [{ name: '見積書.xlsx', kind: 'xlsx', text: '## 見積\n\n| a |\n| --- |', chars: 20, truncated: false, sheets: 1 }], images: [{ name: '写真.png', mediaType: 'image/png', size: 11 }] }
  }
  const r = await prepareAssistantAttachments({
    files: [{ name: '写真.png', mediaType: 'image/png', data: PNG }, { name: '見積書.xlsx', mediaType: XLSX_MT, data: XLSX }],
    callPrepare,
  })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0].files, [
    { name: '写真.png', mediaType: 'image/png', size: 11 },
    { name: '見積書.xlsx', mediaType: XLSX_MT, size: 34, data: XLSX },
  ])
  assert.deepEqual(r.attachments, [
    { kind: 'image', mediaType: 'image/png', data: PNG, name: '写真.png' },
    { kind: 'document', name: '見積書.xlsx', kind2: 'xlsx', text: '## 見積\n\n| a |\n| --- |', truncated: false },
  ])
  assert.deepEqual(r.summary, { count: 2, types: { image: 1, xlsx: 1 }, totalBytes: 45 })
  assert.deepEqual(r.labels, [{ name: '写真.png', kind: 'image' }, { name: '見積書.xlsx', kind: 'xlsx' }])
})

test('prepareAssistantAttachments: no files, business refusals, unreachable business system', async () => {
  let called = false
  const none = await prepareAssistantAttachments({ files: [], callPrepare: async () => { called = true } })
  assert.deepEqual(none, { ok: true, attachments: [], summary: { count: 0, types: {}, totalBytes: 0 }, labels: [] })
  assert.equal(called, false)
  const files = [{ name: 'a.xlsx', mediaType: XLSX_MT, data: XLSX }]
  const refused = await prepareAssistantAttachments({ files, callPrepare: async () => ({ ok: false, error: 'no_text', details: { index: 0 } }) })
  assert.deepEqual(refused, { ok: false, error: 'no_text', status: 422, details: { index: 0 } })
  const role = await prepareAssistantAttachments({ files, callPrepare: async () => ({ ok: false, error: 'attachments_not_allowed' }) })
  assert.equal(role.status, 403)
  const down = await prepareAssistantAttachments({ files, callPrepare: async () => { throw new Error('ECONNREFUSED') } })
  assert.deepEqual(down, { ok: false, error: 'attachment_prepare_failed', status: 502 })
  const missing = await prepareAssistantAttachments({ files, callPrepare: async () => ({ ok: true, documents: [], images: [] }) })
  assert.equal(missing.error, 'attachment_prepare_failed')
  const weird = await prepareAssistantAttachments({ files, callPrepare: async () => ({ ok: false, error: '<script>' }) })
  assert.equal(weird.error, 'attachment_prepare_failed')
})

test('scanned PDF pages (OCR by the model) travel as pageImages; a model that cannot read images refuses them', async () => {
  const PDF = b64(Buffer.from('%PDF-1.4\n%x\n', 'latin1'))
  const files = [{ name: 'スキャン.pdf', mediaType: 'application/pdf', data: PDF }]
  const JPG = b64([0xff, 0xd8, 0xff, 0xe0, 1])
  const answer = { ok: true, documents: [{ name: 'スキャン.pdf', kind: 'pdf', text: '--- p.1 ---\n（スキャン）', truncated: false, ocr: 'model', pageImages: [{ page: 1, mediaType: 'image/jpeg', data: JPG }, { page: 2, mediaType: 'image/png', data: JPG }, { page: 3, mediaType: 'image/jpeg', data: '!!' }] }], images: [] }
  const r = await prepareAssistantAttachments({ files, callPrepare: async () => answer, imagesSupported: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.attachments[0].pageImages, [{ page: 1, mediaType: 'image/jpeg', data: JPG }], 'only well-formed JPEG pages')
  assert.deepEqual(r.labels, [{ name: 'スキャン.pdf', kind: 'pdf', scannedPages: 1 }])
  const no = await prepareAssistantAttachments({ files, callPrepare: async () => answer, imagesSupported: false })
  assert.equal(no.ok, false)
  assert.equal(no.error, 'images_not_supported')
  assert.equal(no.details.reason, 'scanned_pdf')
  const plain = await prepareAssistantAttachments({ files, callPrepare: async () => ({ ...answer, documents: [{ ...answer.documents[0], pageImages: undefined }] }), imagesSupported: false })
  assert.equal(plain.ok, true)
  assert.equal(plain.attachments[0].pageImages, undefined)
  assert.equal(MAX_SCANNED_PAGES, 10)
})
