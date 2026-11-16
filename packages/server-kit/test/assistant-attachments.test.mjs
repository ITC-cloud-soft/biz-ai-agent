// Files attached in the AI assistant panel over HTTP on the toy system (/bridge/v1/assistant/attachments/prepare,
// /bridge/v1/assistant/attachment-settings, /bridge/v1/admin/assistant/attachment-settings): the memory store, and the
// PostgreSQL store in a temporary database of its own (fw_attw1_test; FW_TEST_DATABASE_URL, skipped when unset).
// Ports 20201–20203 (the ATT test ports). Every file is invented here.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeApp, createMemoryStore, createPool, createPostgresStore, defaultAttachmentRoles, dropDatabase, ensureDatabase, listen } from '../src/index.mjs'
import { BFF_SECRET, client, createToy, SERVICE_TOKEN } from './toy.mjs'

const S = { 'x-service-token': SERVICE_TOKEN }
const b64 = (s) => Buffer.from(s).toString('base64')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function suite(label, { port, makeStore }) {
  describe(label, () => {
    let toy
    let srv
    let call
    let admin
    let manager
    let staff
    const bff = (u) => ({ ...u.headers, 'x-bff-secret': BFF_SECRET })
    before(async () => {
      toy = await createToy({ store: await makeStore() })
      srv = await listen(toy.bridge.handler, { port })
      call = client(srv.base)
      admin = toy.addUser('admin')
      manager = toy.addUser('manager')
      staff = toy.addUser('staff')
    })
    after(async () => { await srv?.stop() })

    test('settings of the employee: the defaults (admin + manager of the toy manifest, every type), limits', async () => {
      const mine = await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: manager.headers })
      assert.equal(mine.status, 200)
      assert.deepEqual(mine.body, {
        ok: true, enabled: true, roles: ['admin', 'manager'], types: ['image', 'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'text'],
        limits: { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxCharsPerFile: 30_000, maxCharsTotal: 60_000 },
      })
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: staff.headers })).body.enabled, false)
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings')).status, 401)
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: S })).status, 403, 'the service is not an employee')
    })

    test('prepare: session AND BFF secret; documents converted, images listed without data; audit without names', async () => {
      const files = [
        { name: '写真.png', mediaType: 'image/png', size: PNG.length },
        { name: '一覧.csv', mediaType: 'text/csv', size: 23, data: b64('品名,数\n手すり,2\n') },
        { name: 'メモ.md', mediaType: 'text/markdown', data: b64('# 議事\n\n- 決定 A') },
      ]
      assert.equal((await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: manager.headers, body: { files } })).body.error, 'bff_only')
      assert.equal((await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: S, body: { files } })).status, 403)
      const r = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: { files } })
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.body, {
        ok: true,
        documents: [
          { name: '一覧.csv', kind: 'csv', text: '| 品名 | 数 |\n| --- | --- |\n| 手すり | 2 |', chars: 36, truncated: false },
          { name: 'メモ.md', kind: 'markdown', text: '# 議事\n\n- 決定 A', chars: 12, truncated: false },
        ],
        images: [{ name: '写真.png', mediaType: 'image/png', size: 12 }],
      })
      const audit = (await toy.store.listAudit({ action: 'assistant.attachments' })).at(-1)
      assert.equal(audit.actor, manager.id)
      assert.deepEqual(audit.detail, { ok: true, count: 3, types: { image: 1, csv: 1, markdown: 1 }, totalBytes: 12 + 23 + Buffer.byteLength('# 議事\n\n- 決定 A') })
      assert.doesNotMatch(JSON.stringify(audit), /写真|一覧|メモ|手すり|議事/)
    })

    test('prepare refusals: role 403, limits / types / contents 422 with details (index, name), unknown fields', async () => {
      const one = (f) => call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: { files: [f] } })
      const role = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(staff), body: { files: [{ name: 'a.txt', mediaType: 'text/plain', data: b64('x') }] } })
      assert.deepEqual([role.status, role.body], [403, { ok: false, error: 'attachments_not_allowed' }])
      assert.deepEqual((await one({ name: 'a.xlsm', mediaType: 'application/octet-stream', data: b64('PK') })).body, { ok: false, error: 'unsupported_type', details: { index: 0, name: 'a.xlsm' } })
      assert.equal((await one({ name: 'a.png', mediaType: 'image/png', data: b64('not a png') })).body.error, 'type_mismatch')
      assert.equal((await one({ name: 'a.txt', mediaType: 'text/plain', data: b64('  ') })).body.error, 'no_text')
      assert.equal((await one({ name: 'a.pdf', mediaType: 'application/pdf', data: b64('%PDF-1.4\n') })).body.details.reason, 'pdf_reader_unavailable', 'no pdfjs-dist in the framework')
      assert.equal((await one({ name: 'a.txt', mediaType: 'text/plain', size: 3 })).body.error, 'invalid_attachment', 'a document needs its data')
      assert.equal((await one({ name: 'a.png', mediaType: 'image/png', size: 11 * 1024 * 1024 })).body.error, 'file_too_large')
      const many = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: { files: Array(6).fill({ name: 'a.png', mediaType: 'image/png', size: 1 }) } })
      assert.deepEqual([many.status, many.body.error], [422, 'too_many_files'])
      assert.equal((await one({ name: 'a.png', mediaType: 'image/png', size: 1, userId: 'x' })).body.details.reason, 'unknown_field')
      assert.equal((await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: { files: [], userId: 'x' } })).status, 400)
      assert.equal((await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: {} })).body.details.field, 'files')
      const refused = (await toy.store.listAudit({ action: 'assistant.attachments' })).filter((a) => a.detail.ok === false)
      assert.ok(refused.some((a) => a.detail.error === 'attachments_not_allowed' && a.actor === staff.id))
    })

    test('a body with several MB of base64 is accepted (the route raises the JSON limit)', async () => {
      const text = 'あ'.repeat(1_000_000) // 3 MB of UTF-8
      const r = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(manager), body: { files: [{ name: 'big.txt', mediaType: 'text/plain', data: b64(text) }] } })
      assert.equal(r.status, 200, r.text)
      assert.deepEqual([r.body.documents[0].chars, r.body.documents[0].truncated], [30_000, true])
    })

    test('administrators: GET / PUT settings (roles within the manifest, known types), audited; the employee sees it at once', async () => {
      assert.equal((await call('GET', '/bridge/v1/admin/assistant/attachment-settings', { headers: manager.headers })).body.error, 'insufficient_role')
      assert.equal((await call('PUT', '/bridge/v1/admin/assistant/attachment-settings', { headers: S, body: { roles: [], types: [] } })).status, 403)
      const before = await call('GET', '/bridge/v1/admin/assistant/attachment-settings', { headers: admin.headers })
      assert.deepEqual([before.body.roles, before.body.updatedBy], [['admin', 'manager'], null])
      const bad = (body) => call('PUT', '/bridge/v1/admin/assistant/attachment-settings', { headers: admin.headers, body })
      assert.deepEqual((await bad({ roles: ['owner'], types: [] })).body, { ok: false, error: 'invalid_value', details: { field: 'roles' } })
      assert.deepEqual((await bad({ roles: ['admin'], types: ['exe'] })).body.details, { field: 'types' })
      assert.deepEqual((await bad({ roles: ['admin'] })).body, { ok: false, error: 'required', details: { field: 'types' } })
      assert.equal((await bad({ roles: ['admin'], types: [], extra: 1 })).status, 400)
      const put = await bad({ roles: ['staff', 'admin', 'staff'], types: ['text', 'image'] })
      assert.equal(put.status, 200, put.text)
      assert.deepEqual([put.body.roles, put.body.types, put.body.updatedBy], [['staff', 'admin'], ['image', 'text'], admin.id])
      assert.ok(put.body.updatedAt)
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: staff.headers })).body.enabled, true)
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: manager.headers })).body.enabled, false)
      const csv = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: bff(staff), body: { files: [{ name: 'a.csv', mediaType: 'text/csv', data: b64('a,b') }] } })
      assert.deepEqual([csv.status, csv.body.error, csv.body.details.reason], [422, 'unsupported_type', 'disabled'])
      const audit = (await toy.store.listAudit({ action: 'assistant.attachment_settings.updated' })).at(-1)
      assert.deepEqual(audit.detail, { roles: ['staff', 'admin'], types: ['image', 'text'] })
      // no type at all: nobody can attach
      await bad({ roles: ['staff'], types: [] })
      assert.equal((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: staff.headers })).body.enabled, false)
    })
  })
}

suite('memory store', { port: 20201, makeStore: async () => createMemoryStore() })

const SERVER_URL = process.env.FW_TEST_DATABASE_URL || ''
const DB_URL = SERVER_URL ? Object.assign(new URL(SERVER_URL), { pathname: '/fw_attw1_test' }).toString() : ''
let pgSkip = SERVER_URL ? null : 'FW_TEST_DATABASE_URL is not set: PostgreSQL part skipped'
let pool = null
if (!pgSkip) {
  try {
    await dropDatabase(DB_URL).catch(() => {})
    await ensureDatabase(DB_URL)
  } catch (error) { pgSkip = `PostgreSQL not reachable (${error.message.split('\n')[0]})` }
}
if (pgSkip) test('postgres store', { skip: pgSkip }, () => {})
else {
  suite('postgres store', {
    port: 20202,
    makeStore: async () => {
      pool = await createPool(DB_URL)
      const store = createPostgresStore({ pool })
      const applied = await store.migrate()
      assert.ok(applied.includes('004_assistant_attachments'))
      return store
    },
  })
  after(async () => { await pool?.end(); await dropDatabase(DB_URL) })
}

test('options: attachments false (404), a PDF reader, lower limits, default roles', async () => {
  const toy = await createToy()
  const make = (attachments) => createBridgeApp({ manifest: { manifest: toy.kit.manifest }, store: createMemoryStore(), serviceToken: SERVICE_TOKEN, bffSecret: BFF_SECRET, hooks: toy.kit.hooks, attachments })
  const off = await listen((await make(false)).handler, { port: 20203 })
  try {
    assert.equal((await client(off.base)('GET', '/bridge/v1/assistant/attachment-settings', { headers: S })).status, 404)
  } finally { await off.stop() }
  const app = await make({ pdfText: async () => ({ pages: ['架空の請求書'], numPages: 1 }), limits: { maxFiles: 2 }, defaultRoles: ['staff'] })
  const srv = await listen(app.handler, { port: 20203 })
  try {
    const u = toy.addUser('staff')
    const call = client(srv.base)
    const s = await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: u.headers })
    assert.deepEqual([s.body.enabled, s.body.roles, s.body.limits.maxFiles], [true, ['staff'], 2])
    const r = await call('POST', '/bridge/v1/assistant/attachments/prepare', { headers: { ...u.headers, 'x-bff-secret': BFF_SECRET }, body: { files: [{ name: '請求.pdf', mediaType: 'application/pdf', data: b64('%PDF-1.4\n') }] } })
    assert.deepEqual(r.body.documents, [{ name: '請求.pdf', kind: 'pdf', text: '--- p.1 ---\n架空の請求書', chars: 18, truncated: false, pages: 1 }])
  } finally { await srv.stop() }
  assert.deepEqual(defaultAttachmentRoles(['admin', 'billing', 'staff']), ['admin', 'billing'])
  assert.deepEqual(defaultAttachmentRoles(['owner', 'clerk']), ['owner'])
  assert.deepEqual(defaultAttachmentRoles([]), ['admin', 'manager', 'billing'])
})
