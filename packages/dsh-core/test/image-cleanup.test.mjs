import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, constants } from 'node:zlib'
import { attachmentIdsIn, createImageCleanup, resolveDshHome, scanZstdFrames, sessionLogText } from '../src/image-cleanup.js'

const hex = (c) => c.repeat(64)
const A = hex('a')
const B = hex('b')
const C = hex('c')
const V = hex('e')
const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const header = (id) => `${JSON.stringify({ type: 'session', version: 4, id, agentPreset: 'care-assistant' })}\n`
const imageEvent = (id) => `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'q' }, { type: 'image', attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/png' } }] } })}\n`

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-image-cleanup-'))
  return dir
}

async function writeLog(dir, sessionId, events, { torn = false } = {}) {
  const sdir = join(dir, 'sessions', '--ws--', sessionId)
  await mkdir(sdir, { recursive: true })
  const frames = [frame(header(sessionId)), ...events.map((e) => frame(e))]
  let buf = Buffer.concat(frames)
  if (torn) buf = buf.subarray(0, buf.length - 3)
  await writeFile(join(sdir, 'session.v4.jsonl.zstd'), buf)
}

async function writeObject(dir, id, bytes = 10) {
  const p = join(dir, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, Buffer.alloc(bytes, 1))
  await chmod(p, 0o444)
  return p
}

const objectPath = (dir, id) => join(dir, 'attachments', 'v1', 'objects', id.slice(0, 2), id)

test('scanZstdFrames + sessionLogText read every frame; a torn last frame is refused', () => {
  const buf = Buffer.concat([frame('one\n'), frame('two\n'), frame('three\n')])
  const { frames, torn } = scanZstdFrames(buf)
  assert.equal(frames.length, 3)
  assert.equal(torn, false)
  assert.equal(sessionLogText(buf, { compressed: true }), 'one\ntwo\nthree\n')
  assert.equal(scanZstdFrames(buf.subarray(0, buf.length - 2)).torn, true)
  assert.throws(() => sessionLogText(buf.subarray(0, buf.length - 2), { compressed: true }), /inside a frame/)
  assert.throws(() => scanZstdFrames(Buffer.from('not zstd at all')), /magic/)
})

test('attachmentIdsIn finds sha256 ids; resolveDshHome: config, then DSH_HOME, then ~/.dsh', () => {
  assert.deepEqual([...attachmentIdsIn(`x sha256:${A} y "sha256:${B}"`)], [A, B])
  assert.equal(resolveDshHome('C:/h', { DSH_HOME: 'C:/e' }), 'C:/h')
  assert.equal(resolveDshHome('', { DSH_HOME: 'C:/e' }), 'C:/e')
  assert.match(resolveDshHome('', {}), /\.dsh$/)
})

test('a retired conversation: its own images go (with the request-image cache); shared and other images stay', async () => {
  const dir = await home()
  try {
    let t = 1_000_000
    const cleanup = createImageCleanup({ dshHome: dir, now: () => t, logger: { warn() {} } })
    await writeLog(dir, 'session-retired-0001', [imageEvent(A), imageEvent(B)])
    await writeLog(dir, 'session-other-00001', [imageEvent(B)]) // not ours, still refers to B
    await writeLog(dir, 'session-untracked-1', [imageEvent(C)]) // not in the ledger: C is never touched
    for (const id of [A, B, C]) await writeObject(dir, id)
    const variant = join(dir, 'cache', 'attachments', 'request-images', V.slice(0, 2), V)
    await mkdir(join(variant, '..'), { recursive: true })
    await writeFile(variant, 'small')
    await mkdir(join(dir, 'llm-deepseek'), { recursive: true })
    await writeFile(join(dir, 'llm-deepseek', 'files-v3.json'), JSON.stringify({ formatVersion: 3, records: [{ attachmentId: `sha256:${A}`, variantId: `sha256:${V}` }] }))
    await cleanup.track('session-retired-0001')
    await cleanup.retire('session-retired-0001')
    t += 1000
    const r = await cleanup.runOnce()
    assert.deepEqual({ retired: r.retired, deleted: r.deleted, kept: r.kept }, { retired: 1, deleted: 1, kept: 1 })
    assert.equal(existsSync(objectPath(dir, A)), false)
    assert.equal(existsSync(variant), false)
    assert.equal(existsSync(objectPath(dir, B)), true)
    assert.equal(existsSync(objectPath(dir, C)), true)
    const ledger = JSON.parse(await readFile(join(dir, 'storages', 'bridge-assistant', 'image-sessions.json'), 'utf8'))
    assert.deepEqual(ledger.sessions, {})
    const again = await cleanup.runOnce()
    assert.equal(again.deleted, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a live or recently used conversation keeps its images; idle ones are retired after idleMs', async () => {
  const dir = await home()
  try {
    let t = 5_000_000
    const cleanup = createImageCleanup({ dshHome: dir, idleMs: 60_000, now: () => t, logger: { warn() {} } })
    await writeLog(dir, 'session-busy-000001', [imageEvent(A)])
    await writeLog(dir, 'session-quiet-00001', [imageEvent(B)])
    await writeObject(dir, A)
    await writeObject(dir, B)
    await cleanup.track('session-busy-000001')
    await cleanup.track('session-quiet-00001')
    t += 30_000
    assert.equal((await cleanup.runOnce()).deleted, 0)
    t += 60_000
    const r = await cleanup.runOnce({ live: new Set(['session-busy-000001']) })
    assert.equal(r.deleted, 1)
    assert.equal(existsSync(objectPath(dir, A)), true)
    assert.equal(existsSync(objectPath(dir, B)), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a reference outside the session logs (auto-tasks, storages) keeps the image', async () => {
  const dir = await home()
  try {
    const cleanup = createImageCleanup({ dshHome: dir, logger: { warn() {} } })
    await writeLog(dir, 'session-retired-0002', [imageEvent(A)])
    await writeObject(dir, A)
    await mkdir(join(dir, 'auto-tasks'), { recursive: true })
    await writeFile(join(dir, 'auto-tasks', 'run.json'), JSON.stringify({ image: `sha256:${A}` }))
    await cleanup.track('session-retired-0002')
    await cleanup.retire('session-retired-0002')
    const r = await cleanup.runOnce()
    assert.equal(r.deleted, 0)
    assert.equal(existsSync(objectPath(dir, A)), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fail closed: an unreadable (torn) log anywhere means nothing is removed this time', async () => {
  const dir = await home()
  try {
    const warnings = []
    const cleanup = createImageCleanup({ dshHome: dir, logger: { warn: (...a) => warnings.push(a) } })
    await writeLog(dir, 'session-retired-0003', [imageEvent(A)])
    await writeLog(dir, 'session-writing-001', [imageEvent(B)], { torn: true })
    await writeObject(dir, A)
    await cleanup.track('session-retired-0003')
    await cleanup.retire('session-retired-0003')
    const r = await cleanup.runOnce()
    assert.equal(r.skipped, 'unreadable')
    assert.equal(existsSync(objectPath(dir, A)), true)
    assert.equal(warnings.length, 1)
    assert.equal(cleanup.stats().skipped, 1)
    // the next pass, once the log is whole again, removes it
    await writeLog(dir, 'session-writing-001', [imageEvent(B)])
    assert.equal((await cleanup.runOnce()).deleted, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the ledger survives a restart; ids outside the ledger format are ignored', async () => {
  const dir = await home()
  try {
    const first = createImageCleanup({ dshHome: dir, logger: { warn() {} } })
    await first.track('session-restart-001')
    await first.track('../escape') // not a session id
    const second = createImageCleanup({ dshHome: dir, logger: { warn() {} } })
    await second.retire('session-restart-001')
    const ledger = JSON.parse(await readFile(join(dir, 'storages', 'bridge-assistant', 'image-sessions.json'), 'utf8'))
    assert.deepEqual(Object.keys(ledger.sessions), ['session-restart-001'])
    assert.ok(ledger.sessions['session-restart-001'].retiredAt)
    assert.ok((await stat(join(dir, 'storages', 'bridge-assistant', 'image-sessions.json'))).size > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('gate() waits while objects are being removed; run() never throws', async () => {
  const dir = await home()
  try {
    const cleanup = createImageCleanup({ dshHome: dir, logger: { warn() {} } })
    await cleanup.gate()
    const broken = createImageCleanup({ dshHome: dir, logger: { warn() {} }, fs: { readFile: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }) } } })
    const r = await broken.run()
    assert.ok(r)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('orphan(): an image given to the model once (no conversation) goes at the next pass unless something refers to it; owner ledgers are separate', async () => {
  const dir = await home()
  try {
    const reader = createImageCleanup({ dshHome: dir, owner: 'bridge-reader', logger: { warn() {} } })
    await writeObject(dir, A)
    await writeObject(dir, B)
    await writeLog(dir, 'session-someone-0001', [imageEvent(B)]) // B is also in a conversation: kept
    await reader.orphan(`sha256:${A}`)
    await reader.orphan(B)
    await reader.orphan('not-an-id')
    const r = await reader.runOnce()
    assert.deepEqual({ deleted: r.deleted }, { deleted: 1 })
    assert.equal(existsSync(objectPath(dir, A)), false)
    assert.equal(existsSync(objectPath(dir, B)), true)
    const ledger = JSON.parse(await readFile(join(dir, 'storages', 'bridge-reader', 'image-sessions.json'), 'utf8'))
    assert.deepEqual(ledger.orphans, {})
    assert.equal(existsSync(join(dir, 'storages', 'bridge-assistant', 'image-sessions.json')), false, 'the assistant ledger is untouched')
    assert.throws(() => createImageCleanup({ dshHome: dir, owner: '../x' }), /invalid owner/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
