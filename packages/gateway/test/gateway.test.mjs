import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDshGateway, fromFile, fromEnv, fromValue, parseLaunchToken, redactToken, supervise, withFrameAncestors,
} from '../src/index.mjs'

const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

function hasAuth(cookie, secret) {
  return String(cookie || '').split(';').map((c) => c.trim()).includes(`dsh-auth-x=${secret}`)
}

/** Fake DSH: loopback fence, token exchange, cookie auth, echo, upgrade. */
async function startFakeDsh() {
  const state = { secret: 'v1', exchanges: 0, requests: [], token: TOKEN, rpc: [] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push({ method: req.method, url: req.url, headers: req.headers })
    const authority = `127.0.0.1:${server.address().port}`
    if (req.headers.host !== authority) { res.writeHead(403); return res.end('fence') }
    if (req.headers.origin && req.headers.origin !== `http://${authority}`) { res.writeHead(403); return res.end('origin') }
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== state.token) { res.writeHead(401); return res.end() }
      state.exchanges += 1
      res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-x=${state.secret}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict` })
      return res.end()
    }
    if (url.pathname.startsWith('/assets/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('// public') }
    // Webhook routes: DSH serves them without a session; dsh-im verifies the platform signature itself.
    if (url.pathname.startsWith('/dsh-hooks/')) {
      let hookBody = ''
      req.on('data', (c) => { hookBody += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1; Path=/' })
        res.end(JSON.stringify({ path: req.url, method: req.method, body: hookBody, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null, signature: req.headers['x-line-signature'] ?? null, actor: req.headers['x-bridge-actor'] ?? null, legacyActor: req.headers['x-care-actor'] ?? null, appHeader: req.headers['x-app-tenant'] ?? null }))
      })
      return
    }
    if (!hasAuth(req.headers.cookie, state.secret)) { res.writeHead(401); return res.end('auth required') }
    if (url.pathname.startsWith('/api/dsh-im/') || url.pathname.startsWith('/api/bridge-assistant/')) {
      let rpcBody = ''
      req.on('data', (c) => { rpcBody += c })
      req.on('end', () => {
        const message = JSON.parse(rpcBody)
        state.rpc.push({ path: url.pathname, message, cookie: req.headers.cookie })
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-x=' + state.secret + '; Path=/' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { echoed: message.payload, cookieSeen: Boolean(req.headers.cookie) } } }))
      })
      return
    }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: '/api/next' }); return res.end() }
    if (url.pathname === '/abs-redirect') { res.writeHead(302, { location: `http://${authority}/x?y=1` }); return res.end() }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['extra=1; Path=/', 'dsh-auth-x=' + state.secret + '; Path=/'],
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      })
      res.end(JSON.stringify({ path: req.url, method: req.method, body, cookie: req.headers.cookie, host: req.headers.host, origin: req.headers.origin ?? null, auth: req.headers.authorization ?? null }))
    })
  })
  server.on('upgrade', (req, socket) => {
    const authority = `127.0.0.1:${server.address().port}`
    state.requests.push({ method: 'UPGRADE', url: req.url, headers: req.headers })
    if (req.headers.host !== authority || !hasAuth(req.headers.cookie, state.secret)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: leak=1\r\nX-Path: ${req.url}\r\n\r\n`)
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, state, target: `http://127.0.0.1:${server.address().port}` }
}

async function startGatewayServer(options) {
  const gateway = createDshGateway({ logger: process.env.GW_DEBUG ? console : { info() {}, warn() {}, error() {} }, ...options })
  const server = http.createServer(async (req, res) => {
    if (await gateway.handleRequest(req, res)) return
    res.writeHead(404); res.end('not dsh')
  })
  server.on('upgrade', async (req, socket, head) => {
    if (await gateway.handleUpgrade(req, socket, head)) return
    socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, gateway, base: `http://127.0.0.1:${server.address().port}` }
}

const openSockets = new Set()
function track(socket) { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)); return socket }

const admin = async () => ({ id: 'u1', email: 'admin@example.com', role: 'admin' })

async function setup(t, overrides = {}) {
  const dsh = await startFakeDsh()
  const gw = await startGatewayServer({ target: dsh.target, getSessionUser: admin, launchToken: fromValue(TOKEN), ...overrides })
  dsh.server.on('upgrade', (_req, socket) => track(socket))
  gw.server.on('upgrade', (_req, socket) => track(socket))
  t.after(() => { for (const s of openSockets) s.destroy(); gw.gateway.close(); dsh.server.close(); gw.server.close(); dsh.server.closeAllConnections?.(); gw.server.closeAllConnections?.() })
  return { dsh, gw }
}

test('exchanges the launch token server-side and injects the DSH cookie', async (t) => {
  const { dsh, gw } = await setup(t)
  const res = await fetch(`${gw.base}/dsh/api/echo?x=1`, { headers: { cookie: 'app_session=SECRET' } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.path, '/api/echo?x=1', 'mount prefix stripped')
  assert.equal(body.cookie, 'dsh-auth-x=v1', 'only the DSH cookie is sent upstream (business web cookie stripped)')
  assert.ok(!String(body.cookie).includes('app_session'))
  assert.equal(body.host, dsh.target.replace('http://', ''), 'Host rewritten to the DSH loopback authority')
  assert.equal(dsh.state.exchanges, 1)
  // Second request reuses the jar.
  await (await fetch(`${gw.base}/dsh/api/echo`)).json()
  assert.equal(dsh.state.exchanges, 1)
  assert.equal(gw.gateway.hasSession, true)
})

test('never leaks DSH Set-Cookie to the browser and strips browser credentials', async (t) => {
  const { gw } = await setup(t)
  const res = await fetch(`${gw.base}/dsh/api/echo`, { headers: { authorization: 'Bearer x', 'x-service-token': 's' } })
  assert.equal(res.headers.get('set-cookie'), null)
  const body = await res.json()
  assert.equal(body.auth, null)
})

test('adds frame headers and overrides stricter upstream framing policy', async (t) => {
  const { gw } = await setup(t)
  const res = await fetch(`${gw.base}/dsh/api/echo`)
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self'")
  const denied = await fetch(`${gw.base}/dsh/api/echo`, { headers: {} })
  assert.ok(denied.headers.get('content-security-policy').includes("frame-ancestors 'self'"))
  assert.equal(withFrameAncestors(undefined), "frame-ancestors 'self'")
})

test('401 when there is no business web session, 403 when not allowed (with frame headers)', async (t) => {
  const { dsh, gw } = await setup(t, { getSessionUser: async (req) => (req.headers['x-test-user'] === 'staff' ? { id: 's', role: 'staff' } : null) })
  const anon = await fetch(`${gw.base}/dsh/`)
  assert.equal(anon.status, 401)
  assert.equal(anon.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.deepEqual(await anon.json(), { ok: false, error: 'authentication_required' })
  const staff = await fetch(`${gw.base}/dsh/`, { headers: { 'x-test-user': 'staff' } })
  assert.equal(staff.status, 403)
  assert.equal(dsh.state.requests.length, 0, 'nothing reached DSH')
})

test('rejects cross-site and foreign-origin requests before reaching DSH', async (t) => {
  const { dsh, gw } = await setup(t)
  const cross = await fetch(`${gw.base}/dsh/api/echo`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross.status, 403)
  const foreign = await fetch(`${gw.base}/dsh/api/echo`, { method: 'POST', body: '{}', headers: { origin: 'http://evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal(dsh.state.requests.length, 0)
  // Same-origin POST: Origin rewritten to the upstream origin so DSH's fence accepts it.
  const ok = await fetch(`${gw.base}/dsh/api/echo`, { method: 'POST', body: '{"a":1}', headers: { origin: gw.base, 'content-type': 'application/json' } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.origin, dsh.target)
  assert.equal(body.body, '{"a":1}')
})

test('/dsh redirects to /dsh/; non-mount paths are not handled', async (t) => {
  const { gw } = await setup(t)
  const res = await fetch(`${gw.base}/dsh?a=1`, { redirect: 'manual' })
  assert.equal(res.status, 308)
  assert.equal(res.headers.get('location'), '/dsh/?a=1')
  const other = await fetch(`${gw.base}/dshx/`)
  assert.equal(other.status, 404)
  assert.equal(await other.text(), 'not dsh')
})

test('rewrites upstream Location headers under the mount and drops browser-supplied tokens', async (t) => {
  const { dsh, gw } = await setup(t)
  const r1 = await fetch(`${gw.base}/dsh/redirect`, { redirect: 'manual' })
  assert.equal(r1.headers.get('location'), '/dsh/api/next')
  const r2 = await fetch(`${gw.base}/dsh/abs-redirect`, { redirect: 'manual' })
  assert.equal(r2.headers.get('location'), '/dsh/x?y=1')
  await (await fetch(`${gw.base}/dsh/api/echo?token=attacker&k=v`)).json()
  assert.equal(dsh.state.requests.at(-1).url, '/api/echo?k=v')
  // Raw query preserved byte-for-byte (DSH combo loader).
  await (await fetch(`${gw.base}/dsh/plugins/??@deepseek-ai/a/client.js,@x/b/client.js&rev=12ab`)).text()
  assert.equal(dsh.state.requests.at(-1).url, '/plugins/??@deepseek-ai/a/client.js,@x/b/client.js&rev=12ab')
})

test('re-exchanges automatically when DSH rejects the cookie (restart / expiry)', async (t) => {
  const { dsh, gw } = await setup(t)
  await (await fetch(`${gw.base}/dsh/api/echo`)).json()
  dsh.state.secret = 'v2' // DSH restarted with a new signing secret
  const res = await fetch(`${gw.base}/dsh/api/echo`)
  assert.equal(res.status, 200)
  assert.match((await res.json()).cookie, /dsh-auth-x=v2/)
  assert.equal(dsh.state.exchanges, 2)
})

test('502 when the launch token is wrong or DSH is down', async (t) => {
  const { gw } = await setup(t, { launchToken: fromValue('tok_wrongwrongwrongwrongwrong') })
  const res = await fetch(`${gw.base}/dsh/api/echo`)
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), { ok: false, error: 'dsh_unavailable' })
})

function rawUpgrade(base, path, headers = {}) {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = track(net.connect(Number(port), '127.0.0.1'))
    let data = ''
    socket.on('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      data += chunk
      if (data.includes('\r\n\r\n')) resolve({ socket, head: data })
    })
    socket.on('error', reject)
    socket.on('close', () => resolve({ socket, head: data }))
  })
}

test('WebSocket upgrade: auth, prefix strip, cookie injection, no Set-Cookie leak, bidirectional pipe', async (t) => {
  const { dsh, gw } = await setup(t)
  const { socket, head } = await rawUpgrade(gw.base, '/dsh/api/remote.mux', { Cookie: 'app_session=SECRET' })
  assert.match(head, /^HTTP\/1\.1 101/)
  assert.match(head, /X-Path: \/api\/remote\.mux/)
  assert.doesNotMatch(head, /set-cookie/i)
  const up = dsh.state.requests.find((r) => r.method === 'UPGRADE')
  assert.equal(up.headers.cookie, 'dsh-auth-x=v1')
  assert.equal(up.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==')
  const echoed = new Promise((resolve) => socket.once('data', resolve))
  socket.write('ping')
  assert.equal(await echoed, 'echo:ping')
  socket.destroy()
})

test('WebSocket upgrade is rejected with 401 / 403 before reaching DSH', async (t) => {
  const { dsh, gw } = await setup(t, { getSessionUser: async (req) => (req.headers['x-test-user'] ? { role: req.headers['x-test-user'] } : null) })
  const anon = await rawUpgrade(gw.base, '/dsh/api/remote.mux')
  assert.match(anon.head, /^HTTP\/1\.1 401/)
  const staff = await rawUpgrade(gw.base, '/dsh/api/remote.mux', { 'X-Test-User': 'staff' })
  assert.match(staff.head, /^HTTP\/1\.1 403/)
  const cross = await rawUpgrade(gw.base, '/dsh/api/remote.mux', { 'X-Test-User': 'admin', Origin: 'http://evil.example' })
  assert.match(cross.head, /^HTTP\/1\.1 403/)
  assert.equal(dsh.state.requests.length, 0)
})

test('WebSocket upgrade re-exchanges after DSH restart', async (t) => {
  const { dsh, gw } = await setup(t)
  await (await fetch(`${gw.base}/dsh/api/echo`)).json()
  dsh.state.secret = 'v3'
  const { socket, head } = await rawUpgrade(gw.base, '/dsh/api/remote.mux')
  assert.match(head, /^HTTP\/1\.1 101/)
  assert.equal(dsh.state.exchanges, 2)
  socket.destroy()
})

test('launch token sources: parse, file, env, redaction', async () => {
  const line = `dsh web: http://127.0.0.1:3190/dsh/?token=${TOKEN}`
  assert.equal(parseLaunchToken(line), TOKEN)
  assert.equal(parseLaunchToken(`dsh web: http://a/?token=old_old_old_old_old_old\nnoise\n${line}\n`), TOKEN, 'last line wins')
  assert.equal(parseLaunchToken(TOKEN), TOKEN)
  assert.equal(parseLaunchToken('dsh web: http://a/'), undefined)
  assert.equal(parseLaunchToken('short'), undefined)
  assert.equal(redactToken(line), 'dsh web: http://127.0.0.1:3190/dsh/?token=<redacted>')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-gw-'))
  const file = join(dir, 'dsh.log')
  await writeFile(file, `booting\n${line}\n`)
  assert.equal(await fromFile(file)(), TOKEN)
  await assert.rejects(fromFile(join(dir, 'missing.log'))(), /cannot read/)
  assert.equal(await fromEnv('X_TOKEN', { X_TOKEN: `http://h/?token=${TOKEN}` })(), TOKEN)
  await assert.rejects(fromEnv('X_TOKEN', {})(), /carries no DSH launch token/)
})

test('supervise(): reads the token from the child stdout, redacts logs, stops the child', async () => {
  const script = `console.log('starting'); console.log('dsh web: http://127.0.0.1:1/dsh/?token=${TOKEN}'); setInterval(() => {}, 1000)`
  const logs = []
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }
  const launch = supervise({ command: process.execPath, args: ['-e', script], logger, restart: false, readyTimeoutMs: 10000 })
  try {
    assert.equal(await launch(), TOKEN)
    assert.ok(launch.child, 'child running')
    assert.ok(logs.some((l) => l.includes('token=<redacted>')))
    assert.ok(!logs.some((l) => l.includes(TOKEN)), 'token never logged')
  } finally {
    await launch.stop()
  }
  assert.equal(launch.child, null)
  await assert.rejects(launch(), /stopped/)
})

test('supervise(): a child that becomes ready after the ready timeout is used by later calls', async () => {
  const script = `setTimeout(() => console.log('dsh web: http://127.0.0.1:1/dsh/?token=${TOKEN}'), 400); setInterval(() => {}, 1000)`
  const launch = supervise({ command: process.execPath, args: ['-e', script], logger: {}, restart: false, readyTimeoutMs: 100 })
  try {
    await assert.rejects(launch(), /did not print its URL line within 100ms/)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(await launch(), TOKEN)
    assert.ok(launch.child, 'the same child keeps running')
  } finally {
    await launch.stop()
  }
})

test('supervise(): rejects when the child exits before printing its URL', async () => {
  const launch = supervise({ command: process.execPath, args: ['-e', 'process.exit(3)'], restart: false, logger: {} })
  await assert.rejects(launch(), /exited \(code=3/)
  await launch.stop()
})

test('mount-unaware plugin URLs (rootPaths) are proxied unchanged behind the same auth', async (t) => {
  const { dsh, gw } = await setup(t, { getSessionUser: async (req) => (req.headers['x-test-user'] ? { role: req.headers['x-test-user'] } : null) })
  const res = await fetch(`${gw.base}/api/dsh-proactive/state?x=1`, { headers: { 'x-test-user': 'admin' } })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).path, '/api/dsh-proactive/state?x=1')
  assert.equal((await fetch(`${gw.base}/auto-tasks/api/reports?limit=1`, { headers: { 'x-test-user': 'admin' } })).status, 200)
  assert.equal(dsh.state.requests.at(-1).url, '/auto-tasks/api/reports?limit=1')
  const before = dsh.state.requests.length
  assert.equal((await fetch(`${gw.base}/api/dsh-proactive/state`)).status, 401)
  assert.equal((await fetch(`${gw.base}/api/dsh-proactive/state`, { headers: { 'x-test-user': 'staff' } })).status, 403)
  assert.equal(dsh.state.requests.length, before)
  // Everything else under /api stays with the BFF (business API).
  assert.equal((await fetch(`${gw.base}/api/invoices`)).status, 404)
  assert.equal((await fetch(`${gw.base}/api/dsh-proactive-x`)).status, 404)
})

test('rootPaths: [] disables the passthrough', async (t) => {
  const { gw } = await setup(t, { rootPaths: [] })
  assert.equal((await fetch(`${gw.base}/api/dsh-proactive/state`)).status, 404)
})

// ── publicPaths (webhooks) ──────────────────────────────────────────────────

test('publicPaths: exact-match POST is forwarded without BFF auth, cookies and actor headers stripped, no DSH cookie injected', async (t) => {
  const { dsh, gw } = await setup(t, { getSessionUser: async () => null, publicPaths: ['/dsh-hooks/line', '/dsh-hooks/teams'], stripRequestHeaders: ['X-App-Tenant'] })
  const res = await fetch(`${gw.base}/dsh-hooks/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': 'sig==', cookie: 'app_session=SECRET', 'x-bridge-actor': 'u1', 'x-care-actor': 'u1', 'x-app-tenant': 't1' },
    body: '{"events":[]}',
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('set-cookie'), null, 'upstream Set-Cookie is not passed to the platform')
  const body = await res.json()
  assert.equal(body.path, '/dsh-hooks/line')
  assert.equal(body.body, '{"events":[]}', 'raw body preserved for signature checks')
  assert.equal(body.signature, 'sig==')
  assert.equal(body.cookie, null, 'neither the browser cookie nor the DSH cookie is sent')
  assert.equal(body.actor, null)
  assert.equal(body.legacyActor, null, 'the legacy actor header name is stripped too')
  assert.equal(body.appHeader, null, 'stripRequestHeaders adds application headers')
  assert.equal(dsh.state.exchanges, 0, 'no launch-token exchange for a public path')
  assert.equal(gw.gateway.hasSession, false)
  const teams = await (await fetch(`${gw.base}/dsh-hooks/teams`, { method: 'POST', headers: { authorization: 'Bearer jwt.part.sig' }, body: '{}' })).json()
  assert.equal(teams.auth, 'Bearer jwt.part.sig', 'Bot Framework bearer token reaches dsh-im')
})

test('publicPaths: other methods get 405, near-miss paths stay protected, unset means nothing is public', async (t) => {
  const { dsh, gw } = await setup(t, { getSessionUser: async () => null, publicPaths: ['/dsh-hooks/line'] })
  const get = await fetch(`${gw.base}/dsh-hooks/line`)
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  for (const path of ['/dsh-hooks/line/', '/dsh-hooks/line/x', '/dsh-hooks/LINE', '/dsh-hooks/teams']) {
    const res = await fetch(`${gw.base}${path}`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 404, `${path} is not public (falls through to the BFF)`)
  }
  assert.equal(dsh.state.requests.length, 0)
  const plain = await setup(t, { getSessionUser: async () => null })
  assert.deepEqual(plain.gw.gateway.publicPaths, [])
  assert.equal((await fetch(`${plain.gw.base}/dsh-hooks/line`, { method: 'POST', body: '{}' })).status, 404)
  assert.throws(() => createDshGateway({ target: dsh.target, getSessionUser: admin, launchToken: fromValue(TOKEN), publicPaths: ['/dsh/hooks'] }), /outside the mount/)
  assert.throws(() => createDshGateway({ target: dsh.target, getSessionUser: admin, launchToken: fromValue(TOKEN), publicPaths: ['/a/../b'] }), /invalid public path/)
})

// ── publicPrefixes (WeCom self-built app callback listener) ─────────────────

/** Fake dsh-im wecom-app callback listener: one route, GET = URL verification (echostr), POST = message. */
async function startFakeWecomListener(t) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      seen.push({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, body })
      if (url.pathname !== '/wecom-app-callback/bot1/0123456789abcdef0123456789abcdef') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'leak=1' })
      res.end(req.method === 'GET' ? `echo:${url.searchParams.get('echostr')}` : `ok:${body}`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections?.() })
  return { seen, target: `http://127.0.0.1:${server.address().port}` }
}

test('publicPrefixes: WeCom callback GET (URL verification) and POST reach their own listener without BFF auth; query and body kept; cookies never cross', async (t) => {
  const wecom = await startFakeWecomListener(t)
  const { dsh, gw } = await setup(t, { getSessionUser: async () => null, publicPrefixes: [{ prefix: '/wecom-app-callback/', target: wecom.target }] })
  assert.deepEqual(gw.gateway.publicPrefixes, ['/wecom-app-callback/'])
  const path = '/wecom-app-callback/bot1/0123456789abcdef0123456789abcdef'
  const get = await fetch(`${gw.base}${path}?msg_signature=abc&timestamp=1&nonce=n&echostr=E%2BS%3D`, { headers: { cookie: 'app_session=SECRET' } })
  assert.equal(get.status, 200)
  assert.equal(await get.text(), 'echo:E+S=')
  assert.equal(get.headers.get('set-cookie'), null)
  const post = await fetch(`${gw.base}${path}?msg_signature=abc&timestamp=1&nonce=n`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<xml><Encrypt>x</Encrypt></xml>' })
  assert.equal(await post.text(), 'ok:<xml><Encrypt>x</Encrypt></xml>')
  assert.deepEqual(wecom.seen.map((r) => [r.method, r.url, r.cookie]), [
    ['GET', `${path}?msg_signature=abc&timestamp=1&nonce=n&echostr=E%2BS%3D`, null],
    ['POST', `${path}?msg_signature=abc&timestamp=1&nonce=n`, null],
  ])
  assert.equal(wecom.seen[0].host, wecom.target.replace('http://', ''))
  // unknown bot path: the listener's own 404 (= reachable, used by preflight's probe)
  assert.equal((await fetch(`${gw.base}/wecom-app-callback/probe`)).status, 404)
  assert.equal(dsh.state.requests.length, 0, 'nothing reaches DSH web')
  assert.equal(dsh.state.exchanges, 0)
})

test('publicPrefixes: other methods 405; traversal / odd paths are not forwarded; listener down -> 502; invalid config throws', async (t) => {
  const wecom = await startFakeWecomListener(t)
  const { gw } = await setup(t, { getSessionUser: async () => null, publicPrefixes: [{ prefix: '/wecom-app-callback/', target: wecom.target }] })
  const put = await fetch(`${gw.base}/wecom-app-callback/bot1/x`, { method: 'PUT', body: 'x' })
  assert.equal(put.status, 405)
  assert.equal(put.headers.get('allow'), 'GET, POST')
  for (const p of ['/wecom-app-callback/', '/wecom-app-callback/a/b/c/d/e', '/wecom-app-callback/a%2F..%2Fb', '/wecom-app-callback//x', '/wecom-app-callbackx/a']) {
    assert.equal((await fetch(`${gw.base}${p}`)).status, 404, p)
  }
  assert.equal(wecom.seen.length, 0, 'none of them reached the listener')
  const down = await setup(t, { getSessionUser: async () => null, publicPrefixes: [{ prefix: '/wecom-app-callback/', target: 'http://127.0.0.1:1' }] })
  const r = await fetch(`${down.gw.base}/wecom-app-callback/bot1/x`)
  assert.equal(r.status, 502)
  assert.equal((await r.json()).error, 'webhook_listener_unavailable')
  const make = (publicPrefixes) => () => createDshGateway({ target: 'http://127.0.0.1:3180', getSessionUser: admin, launchToken: fromValue(TOKEN), publicPrefixes })
  assert.throws(make([{ prefix: '/wecom-app-callback', target: wecom.target }]), /invalid public prefix/)
  assert.throws(make([{ prefix: '/dsh/x/', target: wecom.target }]), /outside the mount/)
  assert.throws(make([{ prefix: '/wecom-app-callback/', target: 'ftp://x' }]), /origin target/)
  assert.throws(make([{ prefix: '/wecom-app-callback/', target: 'http://127.0.0.1:30987/path' }]), /origin target/)
  assert.throws(make([{ prefix: '/wecom-app-callback/', target: wecom.target, methods: ['DELETE'] }]), /methods/)
})

// ── server-side RPC (allow-listed) ──────────────────────────────────────────

const WEIXIN_RPC = [{ channel: '/weixin', methods: ['provision.begin', 'provision.poll', 'provision.verify', 'provision.cancel', 'bot.delete'] }]

test('rpc: refuses everything outside rpcAllowlist (default empty) without contacting DSH', async (t) => {
  const { dsh, gw } = await setup(t)
  await assert.rejects(gw.gateway.rpc('/weixin', 'provision.begin', {}), (error) => error.code === 'rpc_not_allowed')
  const allowed = await setup(t, { rpcAllowlist: WEIXIN_RPC })
  await assert.rejects(allowed.gw.gateway.rpc('/weixin', 'bot.workspace.set', { botId: 'b' }), (error) => error.code === 'rpc_not_allowed')
  await assert.rejects(allowed.gw.gateway.rpc('/slack', 'connection.status', {}), (error) => error.code === 'rpc_not_allowed')
  await assert.rejects(allowed.gw.gateway.rpc('/weixin/../slack', 'bot.delete', {}), (error) => error.code === 'rpc_not_allowed')
  assert.equal(dsh.state.requests.length + allowed.dsh.state.requests.length, 0)
})

test('rpc: sends the client-request envelope with the owner cookie and returns only the result', async (t) => {
  const { dsh, gw } = await setup(t, { rpcAllowlist: WEIXIN_RPC })
  const result = await gw.gateway.rpc('/weixin', 'provision.begin', {})
  assert.deepEqual(result, { ok: true, value: { echoed: { method: 'provision.begin', payload: {} }, cookieSeen: true } })
  assert.equal(JSON.stringify(result).includes('dsh-auth-x'), false, 'no cookie in the returned value')
  const [call] = dsh.state.rpc
  assert.equal(call.path, '/api/dsh-im/weixin')
  assert.equal(call.message.type, 'client-request')
  assert.equal(call.message.method, 'dsh-im/weixin')
  assert.match(call.message.rpcId, /^[0-9a-f-]{36}$/)
  assert.equal(call.cookie, 'dsh-auth-x=v1')
  assert.equal(dsh.state.exchanges, 1)
})

test('rpc: another plugin (bridge-assistant) is reachable only through its own plugin/channel/method entries', async (t) => {
  const ASSISTANT_RPC = [...WEIXIN_RPC, { plugin: 'bridge-assistant', channel: '/assistant', methods: ['message.send'] }]
  const { dsh, gw } = await setup(t, { rpcAllowlist: ASSISTANT_RPC })
  const result = await gw.gateway.rpc('/assistant', 'message.send', { ticket: 't' }, { plugin: 'bridge-assistant' })
  assert.equal(result.ok, true)
  const [call] = dsh.state.rpc
  assert.equal(call.path, '/api/bridge-assistant/assistant')
  assert.equal(call.message.method, 'bridge-assistant/assistant')
  assert.deepEqual(call.message.payload, { method: 'message.send', payload: { ticket: 't' } })
  // the plugin is part of the key: the same channel/method under dsh-im (the default) or another plugin is refused
  await assert.rejects(gw.gateway.rpc('/assistant', 'message.send', {}), (error) => error.code === 'rpc_not_allowed')
  await assert.rejects(gw.gateway.rpc('/assistant', 'message.send', {}, { plugin: 'dsh-im' }), (error) => error.code === 'rpc_not_allowed')
  await assert.rejects(gw.gateway.rpc('/weixin', 'provision.begin', {}, { plugin: 'bridge-assistant' }), (error) => error.code === 'rpc_not_allowed')
  await assert.rejects(gw.gateway.rpc('/assistant', 'conversation.reset', {}, { plugin: 'bridge-assistant' }), (error) => error.code === 'rpc_not_allowed')
  assert.equal(dsh.state.rpc.length, 1)
  assert.throws(() => createDshGateway({ target: dsh.target, getSessionUser: async () => null, launchToken: fromValue(TOKEN), rpcAllowlist: [{ plugin: '../x', channel: '/a', methods: [] }] }), /invalid rpcAllowlist entry/)
})

test('rpc: a DSH restart (401) re-exchanges the launch token once and retries', async (t) => {
  const { dsh, gw } = await setup(t, { rpcAllowlist: WEIXIN_RPC })
  await gw.gateway.rpc('/weixin', 'provision.poll', { attemptId: 'a1' })
  dsh.state.secret = 'v2' // DSH restarted: the held cookie is no longer valid
  const result = await gw.gateway.rpc('/weixin', 'bot.delete', { botId: 'weixin_x', confirm: true })
  assert.equal(result.ok, true)
  assert.equal(dsh.state.exchanges, 2)
  assert.equal(dsh.state.rpc.at(-1).cookie, 'dsh-auth-x=v2')
  dsh.state.token = 'tok_rotated_but_not_known_to_gateway_0000'
  dsh.state.secret = 'v3'
  await assert.rejects(gw.gateway.rpc('/weixin', 'provision.poll', { attemptId: 'a1' }), (error) => !String(error.message).includes('dsh-auth-x'))
})
