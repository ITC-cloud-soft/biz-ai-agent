import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aiAllowlist, addDays, cardReplyCode, cardToken, cronToSlot, daysBetween, etagMatches, hashPassword, isValidDate, linkCodeHash, loadManifest,
  localParts, notifiableTypes, reportDecl, safeEqual, verifyPassword,
} from '../src/index.mjs'
import { TOY_MANIFEST } from './toy.mjs'

test('crypto: constant-time compare, scrypt passwords, keyed link-code hashes, derived card secrets', async () => {
  assert.equal(safeEqual('a', 'a'), true)
  assert.equal(safeEqual('a', 'ab'), false)
  assert.equal(safeEqual(undefined, 'a'), false)
  const h = await hashPassword('secret-1')
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.equal(await verifyPassword('secret-1', h), true)
  assert.equal(await verifyPassword('secret-2', h), false)
  assert.equal(await verifyPassword('x', 'scrypt$00$00'), false)
  const k1 = Buffer.alloc(32, 1)
  const k2 = Buffer.alloc(32, 2)
  assert.notEqual(linkCodeHash(k1, '123456'), linkCodeHash(k2, '123456'), 'keyed per database')
  assert.equal(cardToken(k1, 'd1'), cardToken(k1, 'd1'), 'idempotent')
  assert.notEqual(cardToken(k1, 'd1'), cardToken(k1, 'd2'))
  assert.match(cardReplyCode(k1, 'd1'), /^\d{6}$/)
})

test('manifest: load + validate (fail fast), etag, notifiable types, AI allow-list, report, cron slots', () => {
  const info = loadManifest({ file: TOY_MANIFEST })
  assert.match(info.etag, /^"[0-9a-f]{32}"$/)
  assert.equal(loadManifest({ manifest: info.manifest }).etag, info.etag, 'etag is derived from the content')
  assert.throws(() => loadManifest({ manifest: { ...info.manifest, roles: undefined } }), /invalid manifest/)
  assert.throws(() => loadManifest({}), /required/)
  assert.deepEqual(notifiableTypes(info.manifest), ['task.overdue'])
  assert.deepEqual(aiAllowlist(info.manifest), { 'GET /api/tasks': ['admin', 'manager', 'staff'], 'GET /api/tasks/overdue': ['admin', 'manager'] })
  assert.equal(reportDecl(info.manifest).kind, 'daily_tasks')
  assert.equal(reportDecl(info.manifest, 'nope'), null)
  assert.equal(cronToSlot('30 8 * * *'), '08:30')
  assert.throws(() => cronToSlot('*/5 * * * *'), /unsupported/)
  assert.equal(etagMatches('W/"abc", "def"', '"def"'), true)
  assert.equal(etagMatches('*', '"x"'), true)
  assert.equal(etagMatches('"abc"', '"x"'), false)
  assert.equal(etagMatches(undefined, '"x"'), false)
})

test('time: local dates in the system time zone', () => {
  const at = new Date('2026-10-26T16:30:00Z')
  assert.deepEqual(localParts(at, 'Asia/Tokyo'), { date: '2026-10-27', time: '01:30' })
  assert.deepEqual(localParts(at, 'UTC'), { date: '2026-10-26', time: '16:30' })
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(daysBetween('2026-10-20', '2026-10-27'), 7)
  assert.equal(isValidDate('2026-02-28'), true)
  assert.equal(isValidDate('2026-02-30'), false)
  assert.equal(isValidDate('2026-2-3'), false)
})
