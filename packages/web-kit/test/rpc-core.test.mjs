// The dsh-im management RPC client: envelope, response check, Japanese errors, channel status.
// Contract: vendor/dsh-im/plugin-src/management-rpc.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  ImRpcError, PERSONAL_RPC_BASE, buildEnvelope, callRpc, createAdminRpc, createPersonalRpc, createdBotId, excludingBots, httpErrorFor, imErrorMessage,
  infraFailure, probeChannel, rpcEndpoint, statusPill, summarizeStatus, withoutBots,
} from '../src/core/rpc-core.ts'

test('envelope: client-request / rpcId / method / payload.method / payload.payload', () => {
  assert.deepEqual(buildEnvelope('/slack', 'bot.bind-credentials', { botToken: 'xoxb-1' }, 'id-1'), {
    type: 'client-request', rpcId: 'id-1', method: 'dsh-im/slack', payload: { method: 'bot.bind-credentials', payload: { botToken: 'xoxb-1' } },
  })
  assert.ok(Object.hasOwn(buildEnvelope('/line', 'connection.status', {}).payload, 'payload'))
  assert.match(buildEnvelope('/line', 'connection.status', {}).rpcId, /\S+/)
  assert.equal(rpcEndpoint('/wecom-app'), 'dsh-im/wecom-app')
  for (const bad of ['slack', '/', '/a/b', '/../x', '/a b', '//x', '/x?y=1']) assert.throws(() => rpcEndpoint(bad), TypeError, bad)
})

test('httpErrorFor / imErrorMessage: gateway, DSH, permission, missing apart; Chinese messages never shown; overrides', () => {
  assert.equal(httpErrorFor(503, { error: 'dsh_gateway_not_configured' }).code, 'gateway-not-configured')
  assert.equal(httpErrorFor(502, null).code, 'dsh-unavailable')
  assert.equal(httpErrorFor(504, null).code, 'dsh-unavailable')
  assert.equal(httpErrorFor(401, null).code, 'unauthorized')
  assert.equal(httpErrorFor(403, null).code, 'forbidden')
  assert.equal(httpErrorFor(404, null).code, 'not-found')
  assert.equal(httpErrorFor(500, null).code, 'management-unreachable')
  assert.ok(httpErrorFor(403, null) instanceof ImRpcError)
  assert.match(imErrorMessage('missing-scope', '缺少权限'), /スコープ/)
  const unknown = imErrorMessage('SOMETHING_NEW', '服务暂时不可用，请稍后重试。')
  assert.match(unknown, /処理に失敗しました.*SOMETHING_NEW/)
  assert.equal(imErrorMessage('x', 'サーバでエラーが発生しました。'), 'サーバでエラーが発生しました。')
  assert.equal(imErrorMessage('forbidden', undefined, { forbidden: '管理者だけです。' }), '管理者だけです。')
  // the BFF's personal RPC (S1)
  assert.equal(httpErrorFor(422, { error: 'homeserver_not_allowed' }).code, 'homeserver-not-allowed')
  assert.match(httpErrorFor(422, { error: 'homeserver_not_allowed' }).message, /https/)
  assert.equal(httpErrorFor(429, { error: 'too_many_requests' }).code, 'too-many-requests')
  assert.equal(httpErrorFor(503, { error: 'bff_secret_not_configured' }).code, 'personal-unavailable')
  assert.equal(httpErrorFor(404, { error: 'channel_not_ready' }).code, 'not-found', 'a channel without its public hook is 「準備中」')
  for (const code of ['bot-exists', 'bot-registration-failed', 'bot-owned-by-other', 'personal-forbidden']) assert.match(imErrorMessage(code, '中文'), /[ぁ-ん]/, code)
})

test('personal RPC (S1): same envelope at /api/me/im/rpc<channel>; created bot; administrator view without the personal bots', async () => {
  const seen = []
  const rpc = createPersonalRpc(undefined, async (url, init) => {
    const env = JSON.parse(init.body)
    seen.push([url, env.method, env.payload.method])
    return { status: 200, ok: true, text: async () => JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: {}, personalBotCreated: { botId: 'slack_1' } } }) }
  })
  const r = await rpc('/slack', 'bot.bind-credentials', { botToken: 'xoxb-x', appToken: 'xapp-x' })
  assert.equal(PERSONAL_RPC_BASE, '/api/me/im/rpc')
  assert.deepEqual(seen, [['/api/me/im/rpc/slack', 'dsh-im/slack', 'bot.bind-credentials']])
  assert.equal(createdBotId(r), 'slack_1')
  assert.equal(createdBotId({ ok: true, value: {} }), null)
  assert.equal(createdBotId({ ok: false, error: { code: 'x', message: 'x' } }), null)

  // withoutBots: bots[] filtered, counts recounted, nested snapshot / connection too; nothing else changes
  const status = { state: 'connected', connected: true, configured: true, bots: [{ botId: 'org', connected: true }, { botId: 'p1', connected: true }, { botId: 'p2', connected: false }], totals: { configured: 3, connected: 2 }, extra: 1 }
  const out = withoutBots(status, new Set(['p1', 'p2']))
  assert.deepEqual(out, { state: 'connected', connected: true, configured: true, bots: [{ botId: 'org', connected: true }], totals: { configured: 1, connected: 1 }, extra: 1 })
  assert.deepEqual(withoutBots({ snapshot: { bots: [{ botId: 'p1' }] } }, new Set(['p1'])), { snapshot: { bots: [], totals: { configured: 0, connected: 0 } } })
  assert.deepEqual(withoutBots({ connection: { bots: [{ botId: 'p1', connected: true }], connected: true } }, new Set(['p1'])).connection, { bots: [], connected: false, totals: { configured: 0, connected: 0 } })
  assert.equal(withoutBots(status, new Set()), status, 'nothing excluded: the same value')
  assert.equal(withoutBots('x', new Set(['p1'])), 'x')
  // excludingBots reads the list on every call (it may arrive later); errors pass through
  let list = new Set()
  const admin = excludingBots(async (_c, m) => (m === 'fail' ? { ok: false, error: { code: 'e', message: 'e' } } : { ok: true, value: structuredClone(status) }), () => list)
  assert.equal((await admin('/slack', 'connection.status')).value.bots.length, 3)
  list = new Set(['p1', 'p2'])
  assert.deepEqual((await admin('/slack', 'connection.status')).value.bots.map((b) => b.botId), ['org'])
  assert.deepEqual(summarizeStatus(await admin('/slack', 'connection.status')), { configured: 1, connected: 1 })
  assert.equal((await admin('/slack', 'fail')).ok, false)
})

test('callRpc over real HTTP: rpcId checked, business errors returned, HTTP errors mapped; channel status helpers', async () => {
  let mode = 'ok'
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      seen.push({ url: req.url, body })
      res.writeHead(mode === 'http503' ? 503 : mode === 'http404' ? 404 : 200, { 'content-type': 'application/json' })
      if (mode === 'http503') return res.end('{"ok":false,"error":"dsh_gateway_not_configured"}')
      if (mode === 'http404') return res.end('{"ok":false,"error":"not_found"}')
      if (mode === 'wrong-id') return res.end(JSON.stringify({ type: 'server-response', rpcId: 'other', result: { ok: true } }))
      const result = mode === 'business-error'
        ? { ok: false, error: { code: 'invalid-bot-token', message: 'Bot Token 无效' } }
        : { ok: true, value: { snapshot: { bots: [{ botId: 'a', connected: true }, { botId: 'b', connected: false }] } } }
      res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/dsh/api/dsh-im`
  const rpc = createAdminRpc(base, (url, init) => fetch(url, init))
  try {
    const ok = await callRpc(base, '/slack', 'connection.status', {}, undefined, (u, i) => fetch(u, i))
    assert.equal(seen[0].url, '/dsh/api/dsh-im/slack')
    assert.equal(seen[0].body.method, 'dsh-im/slack')
    assert.deepEqual(summarizeStatus(ok), { configured: 2, connected: 1 })
    assert.deepEqual(await probeChannel(rpc, '/slack'), { kind: 'ok', configured: 2, connected: 1 })
    assert.deepEqual(statusPill({ kind: 'ok', configured: 2, connected: 1 }), { tone: 'warning', key: 'status.connected', vars: { connected: 1, configured: 2 } })
    mode = 'business-error'
    const st = await probeChannel(rpc, '/slack')
    assert.equal(st.kind, 'error')
    assert.match(st.message, /Bot Token/)
    mode = 'http404'
    assert.deepEqual(await probeChannel(rpc, '/qq'), { kind: 'pending' })
    mode = 'wrong-id'
    await assert.rejects(rpc('/slack', 'connection.status'), (e) => e.code === 'management-unreachable')
    mode = 'http503'
    const a = await probeChannel(rpc, '/slack')
    const b = await probeChannel(rpc, '/line')
    assert.equal(infraFailure({ slack: a, line: b })?.code, 'gateway-not-configured', 'one notice instead of one error per channel')
    assert.equal(infraFailure({ slack: a, qq: { kind: 'pending' } }), null)
    assert.equal(infraFailure({}), null)
  } finally {
    server.close()
  }
  await assert.rejects(callRpc('http://127.0.0.1:1/x', '/slack', 'connection.status', {}), (e) => e.code === 'network')
  assert.deepEqual(statusPill(undefined), { tone: 'neutral', key: 'status.checking' })
  assert.deepEqual(statusPill({ kind: 'pending' }), { tone: 'neutral', key: 'status.pending', dot: false }, '準備中 is a state: no status dot')
  assert.deepEqual(statusPill({ kind: 'ok', configured: 0, connected: 0 }).key, 'status.none')
})
