// A tiny in-memory Bridge v1 server used to prove that the conformance checks DETECT violations (mutation tests).
// `flaws` switches on one deliberate violation of a section-3 invariant at a time.
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

export const SERVICE_TOKEN = 'mock-service-token-0000000000000000'

export async function startMockBridge(flaws = {}) {
  const users = new Map() // id -> { id, role }
  const codes = new Map() // code -> { userId, used, expiresAt }
  const links = new Map() // `${platform}|${team}|${user}` -> userId
  const delegations = new Map() // token -> userId
  const events = []
  const sessions = new Map() // cookie -> userId

  const newUser = (role) => {
    const u = { id: randomUUID(), role }
    users.set(u.id, u)
    const sid = randomBytes(8).toString('hex')
    sessions.set(sid, u.id)
    return { ...u, headers: { cookie: `sid=${sid}` } }
  }
  const emit = (type, payload) => events.push({ id: events.length + 1, type, aggregateType: type.split('.')[0], aggregateId: randomUUID(), payload, at: new Date().toISOString() })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { body = {} }
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json', 'bridge-protocol': '1' }); res.end(JSON.stringify(json)) }
    const fail = (status, error) => send(status, { ok: false, error })
    const service = req.headers['x-service-token'] === SERVICE_TOKEN
    const sid = /sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1]
    const sessionUser = sid ? users.get(sessions.get(sid)) : null
    const route = `${req.method} ${url.pathname}`
    const strict = (allowed) => Object.keys(body).every((k) => allowed.includes(k))

    if (route === 'GET /bridge/v1/health') return send(200, { ok: true, protocol: 1 })
    if (route === 'POST /bridge/v1/me/link-codes') {
      if (service) return fail(403, 'insufficient_role')
      if (!sessionUser) return fail(401, 'authentication_required')
      const userId = flaws.linkCodeFromBody && users.has(body.userId) ? body.userId : sessionUser.id
      for (const [k, v] of codes) if (v.userId === userId && !v.used) codes.delete(k) // a new code revokes the previous unused one
      const code = String(Math.floor(100000 + Math.random() * 900000))
      codes.set(code, { userId, used: false, expiresAt: Date.now() + 600_000 })
      return send(201, { ok: true, code, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (route === 'POST /bridge/v1/identities/link') {
      if (!service) return fail(401, 'authentication_required')
      if (!strict(['code', 'source']) || !/^\d{6}$/.test(String(body.code))) return fail(400, 'invalid_input')
      const entry = codes.get(body.code)
      if (!entry || (entry.used && !flaws.reuseCode)) return fail(404, 'link_code_invalid')
      const key = `${body.source.platform}|${body.source.teamId ?? ''}|${body.source.userId}`
      if (links.has(key)) return fail(409, 'identity_already_linked')
      entry.used = true
      links.set(key, entry.userId)
      const u = users.get(entry.userId)
      return send(200, { ok: true, user: { id: u.id, role: u.role, displayName: null } })
    }
    if (route === 'GET /bridge/v1/identity') {
      if (!service) return fail(401, 'authentication_required')
      const key = `${url.searchParams.get('platform')}|${url.searchParams.get('teamId') ?? ''}|${url.searchParams.get('userId')}`
      const userId = links.get(key)
      if (!userId) return send(200, { ok: true, linked: false, orgId: 'org', ...(flaws.unlinkedHint ? { hint: 'try the manager' } : {}) })
      const u = users.get(userId)
      return send(200, { ok: true, linked: true, orgId: 'org', user: { id: u.id, role: u.role, displayName: null } })
    }
    if (route === 'POST /bridge/v1/delegations') {
      if (!service) return fail(401, 'authentication_required')
      if (!strict(['source']) || !body.source?.userId) return fail(400, 'invalid_input')
      const key = `${body.source.platform}|${body.source.teamId ?? ''}|${body.source.userId}`
      let userId = links.get(key)
      if (!userId && flaws.delegateUnlinked) userId = [...users.keys()][0]
      if (!userId) return fail(404, 'identity_not_linked')
      const token = `cdt_${randomBytes(16).toString('hex')}`
      delegations.set(token, userId)
      const u = users.get(userId)
      return send(201, { ok: true, token, user: { id: u.id, role: u.role, displayName: null }, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    }
    if (route === 'GET /bridge/v1/events') {
      if (!service) return fail(401, 'authentication_required')
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const page = events.filter((e) => e.id > after).slice(0, limit)
      return send(200, { ok: true, events: page, nextAfter: page.length ? page[page.length - 1].id : after })
    }
    return fail(404, 'not_found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    newUser,
    emit,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}
