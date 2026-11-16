import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BridgeApiError, BridgeHttpError, BridgeProtocolError, BridgeUnreachableError, apiSource, createBusinessApi, sourceKey,
} from '../src/index.js'
import { startFakeApi } from './helpers.mjs'
import { createCareApi } from '../src/compat/care-billing-paths.js'

test('service token, delegation header, query encoding and JSON body', async () => {
  const api = await startFakeApi((req) => ({ body: { ok: true, echo: req.query } }))
  try {
    const client = createBusinessApi({ applicationId: 'a', baseUrl: () => `${api.url}/`, serviceToken: () => 'svc-a' })
    const res = await client.get('/x', { query: { q: '承認 & done=1', empty: '', none: undefined }, delegationToken: 'dlg-1' })
    assert.deepEqual(res.echo, { q: '承認 & done=1' })
    const call = api.calls[0]
    assert.equal(call.headers['x-service-token'], 'svc-a')
    assert.equal(call.headers['x-delegation-token'], 'dlg-1')
    await client.post('/y', { a: 1 })
    assert.deepEqual(api.calls[1].body, { a: 1 })
    assert.equal(api.calls[1].headers['content-type'], 'application/json')
    assert.equal(api.calls[1].headers['x-delegation-token'], undefined)
  } finally {
    await api.close()
  }
})

test('typed errors: http (with code), invalid body, unreachable, protocol mismatch', async () => {
  const api = await startFakeApi((req) => {
    if (req.path === '/403') return { status: 403, body: { ok: false, error: 'delegation_not_permitted' } }
    if (req.path === '/html') return { raw: '<html>proxy</html>' }
    if (req.path === '/v2') return { body: { ok: true }, headers: { 'bridge-protocol': '2' } }
    if (req.path === '/v1') return { body: { ok: true }, headers: { 'bridge-protocol': '1' } }
    if (req.path === '/empty') return { raw: '' }
    return null
  })
  try {
    const client = createBusinessApi({ applicationId: 'a', label: 'a API', baseUrl: () => api.url, serviceToken: () => 't' })
    await assert.rejects(client.get('/403'), (e) => e instanceof BridgeHttpError && e.status === 403 && e.code === 'delegation_not_permitted'
      && e.applicationId === 'a' && /a API GET \/403 failed with HTTP 403 \(delegation_not_permitted\)/.test(e.message))
    await assert.rejects(client.get('/html'), (e) => e instanceof BridgeApiError && e.kind === 'invalid_body' && /non-JSON body/.test(e.message))
    await assert.rejects(client.get('/v2'), (e) => e instanceof BridgeProtocolError && e.code === 'protocol_mismatch')
    assert.deepEqual(await client.get('/v1'), { ok: true })
    assert.deepEqual(await client.get('/empty'), {})
    await assert.rejects(client.request('GET', '/empty', { allowEmpty: false }), /non-JSON/)
    const legacy = createCareApi({ baseUrl: () => api.url })
    assert.deepEqual(await legacy.get('/v2'), { ok: true }, 'the legacy client does not check the protocol header')
    const down = createBusinessApi({ baseUrl: () => 'http://127.0.0.1:1', serviceToken: () => 't' })
    await assert.rejects(down.get('/x'), (e) => e instanceof BridgeUnreachableError && e.status === 0 && /could not reach/.test(e.message))
  } finally {
    await api.close()
  }
})

test('retries only idempotent calls on 502/503/504 and transport errors', async () => {
  let n = 0
  const api = await startFakeApi(() => { n += 1; return n % 2 === 1 ? { status: 503, body: { ok: false, error: 'db_unavailable' } } : { body: { ok: true } } })
  try {
    const client = createBusinessApi({ baseUrl: () => api.url, serviceToken: () => 't', retries: 2, retryDelayMs: 1 })
    assert.deepEqual(await client.get('/r'), { ok: true })
    assert.equal(api.calls.length, 2)
    n = 0
    await assert.rejects(client.post('/w', {}), (e) => e.status === 503)
    assert.equal(api.calls.length, 3, 'POST is never retried')
  } finally {
    await api.close()
  }
})

test('no fallback to CARE_* env for a registry application; missing URL is a typed request error', async () => {
  const previous = process.env.CARE_SERVICE_TOKEN
  process.env.CARE_SERVICE_TOKEN = 'care-secret'
  const api = await startFakeApi(() => ({ body: { ok: true } }))
  try {
    const client = createBusinessApi({ baseUrl: () => api.url, serviceToken: () => '', defaultServiceToken: '', defaultBaseUrl: '' })
    await client.get('/x')
    assert.equal(api.calls[0].headers['x-service-token'], undefined, 'another application never receives the care service token')
    const noUrl = createBusinessApi({ baseUrl: () => '', defaultBaseUrl: '' })
    await assert.rejects(noUrl.get('/x'), (e) => e instanceof BridgeApiError && e.kind === 'request' && e.code === 'api_url_missing')
  } finally {
    if (previous === undefined) delete process.env.CARE_SERVICE_TOKEN
    else process.env.CARE_SERVICE_TOKEN = previous
    await api.close()
  }
})

test('apiSource / sourceKey drop the bot and conversation', () => {
  assert.deepEqual(apiSource({ platform: 'slack', teamId: 'T', userId: 'U', botId: 'B', conversationId: 'C' }), { platform: 'slack', userId: 'U', teamId: 'T' })
  assert.equal(apiSource({ platform: 'slack' }), null)
  assert.equal(sourceKey({ platform: 'line', userId: 'U' }), 'line\u0000\u0000U')
})
