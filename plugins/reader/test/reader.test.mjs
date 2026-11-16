// bridge-reader: claim page images from the business system, have the model transcribe them one page at a time, answer with the text
// (or an error code). The business API, DSH llm and attachments are mocked. Data is fictional.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReadError, cleanRead, createReaderService } from '../src/service.js'
import { READ_SYSTEM, createModelReader, inject } from '../src/index.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')
const ID = '11111111-2222-4333-8444-555555555555'
const READ = { id: ID, purpose: 'care_inbox', language: 'ja', hint: 'ケアプラン 第2表', pages: [{ page: 1, mediaType: 'image/png', data: PNG }, { page: 2, mediaType: 'image/png', data: PNG }] }

function fakeApp({ reads = [READ], claimError = null, answerError = null } = {}) {
  const calls = []
  const app = {
    id: 'care-billing',
    paths: { documentReads: '/api/ai/document-reads', documentReadResult: '/api/ai/document-reads/{readId}/result' },
    api: {
      async get(path, opts) { calls.push(['GET', path, opts?.query]); if (claimError) throw claimError; const out = { ok: true, reads }; reads = []; return out },
      async post(path, body) { calls.push(['POST', path, body]); if (answerError) throw answerError; return { ok: true } },
    },
  }
  return { app, calls, registry: { list: () => [app] } }
}

test('inject declares every service the plugin reads', () => {
  assert.deepEqual([...inject].sort(), ['attachments', 'connection', 'llm', 'typertGateway'])
})

test('cleanRead: id, pages (1..10), media types, base64; control characters out of the hint', () => {
  assert.equal(cleanRead(READ).pages.length, 2)
  assert.equal(cleanRead({ ...READ, hint: 'a\u0000b' }).hint, 'a b')
  for (const bad of [{ ...READ, id: 'x' }, { ...READ, pages: [] }, { ...READ, pages: Array(11).fill(READ.pages[0]) },
    { ...READ, pages: [{ ...READ.pages[0], mediaType: 'image/gif' }] }, { ...READ, pages: [{ ...READ.pages[0], data: 'x!' }] }]) {
    assert.equal(cleanRead(bad), null)
  }
})

test('tick: claims, reads every page, answers with the text in page order (cut at 20,000 characters)', async () => {
  const { calls, registry } = fakeApp()
  const service = createReaderService({ registry, read: async (r) => r.pages.map((p) => ({ page: p.page, text: p.page === 2 ? 'あ'.repeat(20_010) : '利用者番号 T-0042' })), logger: { warn() {} } })
  await service.tick()
  assert.deepEqual(calls[0], ['GET', '/api/ai/document-reads', { limit: 2 }])
  const [verb, path, body] = calls[1]
  assert.equal(`${verb} ${path}`, `POST /api/ai/document-reads/${ID}/result`)
  assert.deepEqual(body.pages.map((p) => [p.page, p.text.length]), [[1, '利用者番号 T-0042'.length], [2, 20_000]])
  assert.deepEqual({ reads: service.stats().reads, pages: service.stats().pages }, { reads: 1, pages: 2 })
})

test('tick: a model error becomes { error } (codes only); a 409 answer (claim expired) is quiet; malformed reads are skipped', async () => {
  const warnings = []
  const { calls, registry } = fakeApp({ reads: [READ, { id: 'bad' }], answerError: Object.assign(new Error('x'), { status: 409 }) })
  const service = createReaderService({ registry, read: async () => { throw new ReadError('images_not_supported') }, logger: { warn: (...a) => warnings.push(a.join(' ')) } })
  await service.tick()
  assert.deepEqual(calls[1][2], { error: 'images_not_supported' })
  assert.equal(service.stats().skipped, 1)
  assert.ok(!warnings.some((w) => w.includes('answering')), '409 is not a warning')
  const other = createReaderService({ registry: fakeApp().registry, read: async () => { throw new Error('boom 090-1234-5678') }, logger: { warn() {} } })
  await other.tick()
  assert.equal(other.stats().lastError, 'model_failed')
})

test('tick: an application without the capability (404) is not asked again for a while; no paths = not asked', async () => {
  let t = 1000
  const { calls, registry } = fakeApp({ claimError: Object.assign(new Error('nf'), { status: 404 }) })
  const service = createReaderService({ registry, read: async () => [], now: () => t, logger: { warn() {} } })
  await service.tick()
  await service.tick()
  assert.equal(calls.length, 1)
  t += 11 * 60_000
  await service.tick()
  assert.equal(calls.length, 2)
  const bare = { list: () => [{ id: 'x', paths: {}, api: { get: async () => { throw new Error('must not be called') } } }] }
  await createReaderService({ registry: bare, read: async () => [] }).tick()
})

test('model reader: one request per page with the image ref, temperature 0, the fixed system text; the images go to the cleanup', async () => {
  const requests = []
  const orphans = []
  let ran = 0
  const read = createModelReader({
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream(o) { requests.push(o); yield { type: 'reasoning-delta', text: 'thinking' }; yield { type: 'text-delta', text: ' 次回の訪問は ' }; yield { type: 'text-delta', text: '11 月 4 日 ' } },
    },
    attachments: { saveImage: async (i) => ({ attachmentId: `sha256:${String(i.name).endsWith('1') ? 'a' : 'b'}`.padEnd(71, '0'), mediaType: i.mediaType, bytes: i.data.length, width: 1, height: 1 }) },
    model: async () => ({ provider: 'deepseek', model: 'v4-flash' }),
    cleanup: { orphan: async (id) => { orphans.push(id) }, run: () => { ran += 1 } },
  })
  const out = await read(cleanRead(READ))
  assert.deepEqual(out, [{ page: 1, text: '次回の訪問は 11 月 4 日' }, { page: 2, text: '次回の訪問は 11 月 4 日' }])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].system, READ_SYSTEM)
  assert.equal(requests[0].temperature, 0)
  assert.deepEqual(requests[0].messages[0].content.map((c) => c.type), ['text', 'image'])
  assert.match(requests[0].messages[0].content[0].text, /ケアプラン 第2表.*ページ 1/)
  assert.equal(orphans.length, 2)
  assert.equal(ran, 1)
})

test('model reader: a model that cannot read images is refused before any image is stored; no model = model_failed', async () => {
  let saved = 0
  const deps = { attachments: { saveImage: async () => { saved += 1; return { attachmentId: 'x' } } }, model: async () => ({ provider: 'p', model: 'm' }) }
  const textOnly = createModelReader({ ...deps, llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }), async *stream() {} } })
  await assert.rejects(textOnly(cleanRead(READ)), (e) => e instanceof ReadError && e.code === 'images_not_supported')
  assert.equal(saved, 0)
  const none = createModelReader({ ...deps, model: async () => null, llm: { async *stream() {} } })
  await assert.rejects(none(cleanRead(READ)), (e) => e.code === 'model_failed')
})
