import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRouter, HttpError, parseSource, readBody, sendError, sendJson, strictKeys } from '../src/http.mjs'

const req = (text, type = 'application/json') => Object.assign(Readable.from(text ? [Buffer.from(text)] : []), { headers: { 'content-type': type } })
const fakeRes = () => {
  const r = { status: 0, headers: {}, body: '', writeHead(s, h) { r.status = s; r.headers = h }, end(b) { r.body = b ?? '' } }
  return r
}

test('router: params, 404 (null), 405 with allow, bad escapes -> 400', () => {
  const router = createRouter()
  router.add('GET', '/a/:id', { allow: ['service'] }, () => null)
  router.add('POST', '/a/:id', { allow: ['service'] }, () => null)
  router.add('GET', '/b/:n', { allow: ['service'] }, () => null, { patterns: { n: '[0-9]+' } })
  assert.deepEqual(router.match('GET', '/a/x%20y').params, { id: 'x y' })
  assert.equal(router.match('GET', '/nope'), null)
  const m = router.match('DELETE', '/a/1')
  assert.equal(m.error.status, 405)
  assert.equal(m.error.allow, 'GET, POST')
  assert.equal(router.match('GET', '/a/%E0').error.code, 'invalid_path')
  assert.equal(router.match('GET', '/b/12').params.n, '12')
  assert.equal(router.match('GET', '/b/x'), null)
  assert.throws(() => router.add('GET', '/c', null, () => null), /policy/)
})

test('readBody: JSON objects only, content-type required, size limit, pre-parsed bodies', async () => {
  assert.deepEqual(await readBody(req('{"a":1}')), { a: 1 })
  assert.equal(await readBody(req('')), null)
  await assert.rejects(readBody(req('[1]')), (e) => e.code === 'invalid_json')
  await assert.rejects(readBody(req('{"a":')), (e) => e.code === 'invalid_json')
  await assert.rejects(readBody(req('{"a":1}', 'text/plain')), (e) => e.code === 'invalid_json')
  await assert.rejects(readBody(req('{"a":"' + 'x'.repeat(100) + '"}'), { maxBytes: 50 }), (e) => e.status === 413)
  assert.deepEqual(await readBody({ headers: {}, body: { a: 2 } }), { a: 2 })
  await assert.rejects(readBody({ headers: {}, body: [1] }), (e) => e.code === 'invalid_json')
})

test('sendJson / sendError: envelope and the bridge-protocol header', () => {
  const r = fakeRes()
  sendError(r, new HttpError(403, 'bff_only'))
  assert.equal(r.status, 403)
  assert.equal(r.headers['bridge-protocol'], '1')
  assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'bff_only' })
  const r2 = fakeRes()
  sendError(r2, new Error('boom'))
  assert.deepEqual([r2.status, JSON.parse(r2.body).error], [500, 'internal_error'])
  const r3 = fakeRes()
  sendJson(r3, 201, { ok: true }, { etag: '"x"' })
  assert.deepEqual([r3.status, r3.headers.etag, r3.headers['cache-control']], [201, '"x"', 'no-store'])
})

test('strictKeys / parseSource', () => {
  assert.doesNotThrow(() => strictKeys({ a: 1 }, ['a', 'b']))
  assert.throws(() => strictKeys({ userId: 'x' }, ['a']), (e) => e.code === 'unknown_field')
  assert.deepEqual(parseSource({ platform: 'slack', userId: 'U1' }), { platform: 'slack', teamId: '', userId: 'U1', botId: null })
  assert.deepEqual(parseSource({ platform: 'weixin', userId: 'U1', teamId: 'T', botId: 'b' }), { platform: 'weixin', teamId: 'T', userId: 'U1', botId: 'b' })
  for (const bad of [null, [], { platform: 'Slack', userId: 'U' }, { platform: 'slack' }, { platform: 'slack', userId: 'x'.repeat(129) }, { platform: 'slack', userId: 'U', teamId: 1 }]) {
    assert.throws(() => parseSource(bad), (e) => e.code === 'invalid_source', JSON.stringify(bad))
  }
})
