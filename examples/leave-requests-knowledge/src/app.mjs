// leave-requests — the smallest business system that works with AI employees, in one file.
//
// Employees request leave; a manager approves it on the web or with the approval card in their own chat; a request that
// waits 2 days is followed up. Everything Bridge v1 needs comes from @dsh-bridge/server-kit; this file only holds what
// knows the business: its data, its login, and the hooks (who exists, who is told, who decides, what the AI may propose).
//
// The store is the kit's MEMORY store and the business data are plain maps: nothing to install, nothing persists across a
// restart. A real system keeps the same hooks and swaps the store (createPostgresStore / createMysqlStore) and the maps for
// its own tables (see examples/equipment-inspection).
//
// biz-ai-agent pilot: this copy of framework/examples/leave-requests adds the KNOWLEDGE capability (@dsh-bridge/knowledge):
// the company documents in knowledge/*.md, indexed with per-section visibility, searched with the asker's own rights at
// GET /bridge/v1/knowledge/search, and the handbook screen /handbook/:docId the sources link to (the same visibility).
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  addDays, createBridgeApp, createMemoryStore, DATE_RE, DUMMY_PASSWORD_HASH, fail, hashPassword, header, listen, newToken, POLICY,
  sha256, strictKeys, todayIn, UUID_RE, verifyPassword,
} from '@dsh-bridge/server-kit'
import { registerGraph } from '@dsh-bridge/graph'
import { bridgePiiScreen, buildKnowledgeIndex, canSee, createKnowledgeService, readKnowledgeDir, registerKnowledge } from '@dsh-bridge/knowledge'

export const MANIFEST_FILE = fileURLToPath(new URL('../bridge.manifest.yaml', import.meta.url))
export const KNOWLEDGE_DIR = fileURLToPath(new URL('../knowledge/', import.meta.url))
export const ROLES = Object.freeze(['admin', 'manager', 'staff'])
const SESSION_COOKIE = 'lr_session'
const SESSION_TTL_MS = 12 * 3600_000
const UNANSWERED_DAYS = 2
const APPROVAL_TTL_DAYS = 7
const LOGIN_FAILURES = 5 // per login id per 10 minutes
const MANAGERS = ['admin', 'manager']

/**
 * createLeaveApp({ serviceToken, bffSecret, now?, log?, manifest?, webBase?, knowledgeDir?, knowledgeOptions? })
 *   -> { handler, kit, router, store, data, createUser, knowledge, rebuildKnowledge, ... }
 * manifest: { file } (default bridge.manifest.yaml) or { manifest } (tests); webBase: the business web's URL in sources ('' = paths)
 * knowledgeOptions: passed to createKnowledgeService (embedder, rerank, minCoverage …; none = BM25F, the default)
 */
export async function createLeaveApp({
  serviceToken, bffSecret, orgId = 'example-org', now = () => new Date(), log = () => {},
  manifest = { file: MANIFEST_FILE }, webBase = '', knowledgeDir = KNOWLEDGE_DIR, knowledgeOptions = {},
}) {
  const store = createMemoryStore({ now })
  const data = { users: new Map(), sessions: new Map(), leave: new Map(), approvals: new Map() }
  const today = () => todayIn('UTC', now())
  const daysSince = (date) => Math.floor((now().getTime() - date.getTime()) / 86_400_000)
  const employee = (u) => u && { id: u.id, role: u.role, active: u.active }

  // ── the business's own login (the kit never sees passwords) ───────────────────────────────────────────────────────
  async function createUser({ loginId, password, role, displayName }) {
    const u = { id: randomUUID(), loginId, role, displayName, active: true, passwordHash: await hashPassword(password) }
    data.users.set(u.id, u)
    return u
  }
  function sessionOf(req) {
    const auth = header(req, 'authorization')
    let token = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : null
    for (const part of String(header(req, 'cookie') ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (!token && k === SESSION_COOKIE) token = decodeURIComponent(v.join('='))
    }
    const s = token && data.sessions.get(sha256(token))
    return s && !s.revoked && s.expiresAt > now() ? s : null
  }
  const sessionCookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`

  // ── leave requests and their approval (one approval per request; managers decide, never the requester) ──────────
  const leaveJson = (l) => ({ id: l.id, requesterUserId: l.requesterUserId, startsOn: l.startsOn, endsOn: l.endsOn, status: l.status, requestedAt: l.createdAt.toISOString() })
  const approvalJson = (a) => ({ id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, status: a.status, expiresAt: a.expiresAt.toISOString(), decidedBy: a.decidedBy ?? null, channel: a.channel ?? null })
  const mayDecide = (a, user) => Boolean(user && user.active !== false && MANAGERS.includes(user.role) && String(user.id) !== String(a.requestedBy))
  const visibleTo = (user) => (l) => user.role !== 'staff' || l.requesterUserId === user.id
  const unanswered = (minDays = UNANSWERED_DAYS) => [...data.leave.values()].filter((l) => l.status === 'pending' && daysSince(l.createdAt) >= minDays)

  function checkDates(startsOn, endsOn) {
    if (typeof startsOn !== 'string' || !DATE_RE.test(startsOn) || typeof endsOn !== 'string' || !DATE_RE.test(endsOn)) fail(400, 'invalid_dates')
    if (startsOn < today() || endsOn < startsOn || endsOn > addDays(today(), 366)) fail(400, 'invalid_dates')
  }

  /** The business change and its event in one transaction (outbox): the request, its approval, approval.requested. */
  async function requestLeave(user, body) {
    strictKeys(body, ['startsOn', 'endsOn'])
    checkDates(body.startsOn, body.endsOn)
    const leave = { id: randomUUID(), requesterUserId: user.id, startsOn: body.startsOn, endsOn: body.endsOn, status: 'pending', createdAt: now() }
    const a = { id: randomUUID(), subjectType: 'leave_request', subjectId: leave.id, requiredRole: 'manager', requestedBy: user.id, status: 'pending', expiresAt: new Date(now().getTime() + APPROVAL_TTL_DAYS * 86_400_000) }
    await kit.tx(async (t) => {
      await kit.emitEvent(t, {
        type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id,
        payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, requiredRole: a.requiredRole, expiresAt: a.expiresAt.toISOString() },
      })
      data.leave.set(leave.id, leave) // the memory store's transaction cannot roll maps back: change them after the event is written
      data.approvals.set(a.id, a)
    })
    return { leaveRequest: leaveJson(leave), approval: approvalJson(a) }
  }

  /** A person's decision (web or chat card) inside the caller's transaction: the request, the approval, approval.decided. */
  async function decide(t, a, { action, actor, channel }) {
    if (a.status !== 'pending') fail(409, 'already_decided')
    if (a.expiresAt <= now()) fail(409, 'approval_expired')
    const status = action === 'approve' ? 'approved' : 'rejected'
    await kit.emitEvent(t, {
      type: 'approval.decided', aggregateType: 'approval', aggregateId: a.id,
      payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, decision: action, status, channel, decidedByUserId: actor.id },
    })
    Object.assign(a, { status, decidedBy: actor.id, channel })
    const leave = data.leave.get(a.subjectId)
    if (leave) leave.status = status
    return approvalJson(a)
  }

  /** The follow-up: one leave.unanswered per request that has waited long enough (the scheduler of a real system runs it). */
  async function scanUnanswered(minDays = UNANSWERED_DAYS) {
    const created = []
    for (const l of unanswered(minDays).filter((x) => !x.unansweredNotified)) {
      const eventId = await kit.tx(async (t) => kit.emitEvent(t, {
        type: 'leave.unanswered', aggregateType: 'leave_request', aggregateId: l.id,
        payload: { leaveRequestId: l.id, requesterUserId: l.requesterUserId, startsOn: l.startsOn, daysWaiting: daysSince(l.createdAt) },
      }))
      l.unansweredNotified = true
      created.push({ leaveRequestId: l.id, eventId })
    }
    return created
  }

  // ── the hooks: the only Bridge code that knows this business ─────────────────────────────────────────────────────
  const hooks = {
    employees: {
      get: async (id) => employee(data.users.get(String(id))),
      getMany: async (ids) => ids.map((id) => employee(data.users.get(String(id)))).filter(Boolean),
      list: async ({ roles } = {}) => [...data.users.values()].filter((u) => u.active && (!roles || roles.includes(u.role))).map(employee),
    },
    authenticate: async (req) => {
      const s = sessionOf(req)
      const u = s && data.users.get(s.userId)
      return u?.active ? { user: { id: u.id, role: u.role }, sessionId: s.sessionId } : null
    },
    isSessionLive: async (sessionId) => [...data.sessions.values()].some((s) => s.sessionId === sessionId && !s.revoked && s.expiresAt > now()),

    /** Who is told about an event, and with which typed parameters (never names). The system decides, not the AI. */
    recipientsFor: async (event) => {
      if (event.type !== 'leave.unanswered') return null
      const l = data.leave.get(event.payload.leaveRequestId)
      if (!l) return { stale: 'deleted' }
      if (l.status !== 'pending') return { stale: 'decided' }
      const users = [...data.users.values()].filter((u) => u.active && (MANAGERS.includes(u.role) || u.id === l.requesterUserId)).map(employee)
      const waiting = unanswered()
      return {
        users,
        dedupeKey: `leave.unanswered:${l.id}`,
        link: `/leave-requests/${l.id}`,
        paramsFor: (u) => ({ count: u.role === 'staff' ? waiting.filter(visibleTo(u)).length : waiting.length, daysWaiting: event.payload.daysWaiting, startsOn: l.startsOn }),
      }
    },

    approvals: {
      get: async (id) => data.approvals.get(String(id)) ?? null,
      approvers: async (a) => [...data.users.values()].filter((u) => mayDecide(a, u)).map(employee),
      /** The chat card: IDs and dates only — no names, no reasons. */
      card: async (a) => {
        const l = data.leave.get(a.subjectId)
        return {
          title: 'Leave request',
          fields: [
            { label: 'Request', value: String(a.subjectId).slice(0, 8) },
            { label: 'Dates', value: l ? `${l.startsOn} – ${l.endsOn}` : '-' },
            { label: 'Decide by', value: a.expiresAt.toISOString().slice(0, 10) },
          ],
          body: 'Approve or reject with the buttons or the reply code. Details are in Leave Requests.',
        }
      },
      mayDecide: async (a, user) => mayDecide(a, user), // the same rule as the web
      decide: (a, decision, ctx) => decide(ctx.t, a, decision),
    },

    /** What the AI may propose (a person accepts or rejects every proposal; apply runs only then). */
    proposalKinds: {
      leave_new_dates: {
        roles: ['admin', 'manager', 'staff'],
        async validate(p, ctx, principal) {
          strictKeys(p, ['leaveRequestId', 'startsOn', 'endsOn', 'reason'], 'invalid_payload')
          if (typeof p.leaveRequestId !== 'string' || !UUID_RE.test(p.leaveRequestId)) fail(400, 'invalid_payload')
          checkDates(p.startsOn, p.endsOn)
          const l = data.leave.get(p.leaveRequestId)
          if (!l || l.status !== 'pending') fail(422, 'leave_request_not_pending')
          if (principal?.user?.role === 'staff' && l.requesterUserId !== principal.user.id) fail(422, 'leave_request_not_pending') // staff: their own only
        },
        async apply(p) { Object.assign(data.leave.get(p.leaveRequestId), { startsOn: p.startsOn, endsOn: p.endsOn }) },
      },
      leave_cancel: {
        roles: MANAGERS,
        async validate(p) {
          strictKeys(p, ['leaveRequestId'], 'invalid_payload')
          if (!data.leave.get(String(p.leaveRequestId))) fail(422, 'leave_request_not_found')
        },
        async apply(p) { data.leave.get(p.leaveRequestId).status = 'cancelled' },
      },
    },

    /** The scheduled report: counts per section, scoped by role (staff: their own). */
    reports: {
      compute: async (viewer) => {
        const mine = [...data.leave.values()].filter((l) => viewer.role !== 'staff' || l.requesterUserId === viewer.id)
        const pending = mine.filter((l) => l.status === 'pending').length
        const upcoming = mine.filter((l) => l.status === 'approved' && l.startsOn >= today() && l.startsOn <= addDays(today(), 7)).length
        return { sections: { pending: { count: pending }, approved_upcoming: { count: upcoming } }, attention: pending }
      },
    },

    /** Names live only here, in the roster: a text that contains one is refused by long-term memory. */
    piiScan: async (text) => {
      const hay = String(text).normalize('NFKC').toLowerCase()
      const hit = [...data.users.values()].some((u) => u.displayName.length >= 2 && hay.includes(u.displayName.normalize('NFKC').toLowerCase()))
      return { kinds: hit ? ['staff_name'] : [] }
    },
  }

  const bridge = await createBridgeApp({
    manifest, store, serviceToken, bffSecret, orgId, service: 'leave-requests', version: '0.1.0', hooks, now, log,
    roles: { reportReaders: MANAGERS, reportRunners: ['admin'], proposalReviewers: MANAGERS, admins: ['admin'] },
  })
  const { kit, router } = bridge

  // ── the business web API (/api/*), on the kit's router and gate ─────────────────────────────────────────────────────
  // A read endpoint the AI may call is a manifest tool (kit.readToolPolicy); every write is people only.
  const HUMAN = { allow: ['user'] }
  const HUMAN_MANAGERS = { allow: ['user'], roles: MANAGERS }
  const ADMIN = { allow: ['user'], roles: ['admin'] }

  router.add('POST', '/api/auth/login', POLICY.PUBLIC, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['loginId', 'password'])
    if (typeof b.loginId !== 'string' || !b.loginId || b.loginId.length > 64 || typeof b.password !== 'string' || b.password.length > 200) fail(400, 'invalid_credentials')
    if (await store.countHits('login_failure', b.loginId, 10) >= LOGIN_FAILURES) fail(429, 'too_many_attempts')
    const u = [...data.users.values()].find((x) => x.loginId === b.loginId)
    const ok = await verifyPassword(b.password, u?.passwordHash ?? DUMMY_PASSWORD_HASH) // same work whether or not the id exists
    if (!u || !ok || !u.active) {
      await store.addHit('login_failure', b.loginId)
      fail(401, 'invalid_credentials')
    }
    const token = newToken('lrs')
    const s = { sessionId: randomUUID(), userId: u.id, expiresAt: new Date(now().getTime() + SESSION_TTL_MS), revoked: false }
    data.sessions.set(sha256(token), s)
    return { status: 200, body: { ok: true, user: { id: u.id, role: u.role } }, headers: { 'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000) } }
  })

  router.add('POST', '/api/auth/logout', HUMAN, async ({ principal }) => {
    for (const s of data.sessions.values()) if (s.sessionId === principal.sessionId) s.revoked = true
    await store.revokeTicketsBySession(principal.sessionId)
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': sessionCookie('', 0) } }
  })

  router.add('GET', '/api/me', HUMAN, async ({ principal }) => {
    const u = data.users.get(principal.user.id)
    return { status: 200, body: { ok: true, user: { id: u.id, loginId: u.loginId, displayName: u.displayName, role: u.role } } }
  })

  router.add('GET', '/api/leave-requests', kit.readToolPolicy('GET /api/leave-requests', [...ROLES]), async ({ principal, query }) => {
    const status = query.get('status') ?? 'all'
    if (!['pending', 'approved', 'rejected', 'cancelled', 'all'].includes(status)) fail(400, 'invalid_status')
    const list = [...data.leave.values()].filter(visibleTo(principal.user)).filter((l) => status === 'all' || l.status === status)
    return { status: 200, body: { ok: true, leaveRequests: list.map(leaveJson) } }
  })

  router.add('GET', '/api/leave-requests/unanswered', kit.readToolPolicy('GET /api/leave-requests/unanswered', MANAGERS), async () => ({
    status: 200,
    body: { ok: true, leaveRequests: unanswered().map((l) => ({ id: l.id, requesterUserId: l.requesterUserId, startsOn: l.startsOn, daysWaiting: daysSince(l.createdAt) })) },
  }))

  router.add('POST', '/api/leave-requests', HUMAN, async ({ principal, body }) => ({ status: 201, body: { ok: true, ...(await requestLeave(principal.user, body ?? {})) } }))

  router.add('POST', '/api/approvals/:approvalId/decision', HUMAN_MANAGERS, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['action'])
    if (!['approve', 'reject'].includes(b.action)) fail(400, 'invalid_action')
    const a = data.approvals.get(params.approvalId)
    if (!a) fail(404, 'approval_not_found')
    if (!mayDecide(a, data.users.get(principal.user.id))) fail(403, 'role_not_permitted')
    const approval = await kit.tx(async (t) => {
      const out = await decide(t, a, { action: b.action, actor: principal.user, channel: 'web' })
      await t.revokeApprovalDeliveries({ approvalId: a.id }) // the chat cards of this approval stop working
      return out
    })
    return { status: 200, body: { ok: true, approval } }
  })

  router.add('POST', '/api/admin/users', ADMIN, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['loginId', 'password', 'role', 'displayName'])
    if (typeof b.loginId !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(b.loginId)) fail(400, 'invalid_login_id')
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) fail(400, 'invalid_password')
    if (!ROLES.includes(b.role)) fail(400, 'invalid_role')
    if (typeof b.displayName !== 'string' || !b.displayName.trim() || b.displayName.length > 60) fail(400, 'invalid_display_name')
    if ([...data.users.values()].some((u) => u.loginId === b.loginId)) fail(409, 'login_id_taken')
    const u = await createUser(b)
    return { status: 201, body: { ok: true, user: { id: u.id, loginId: u.loginId, role: u.role, active: u.active } } }
  })

  router.add('PATCH', '/api/admin/users/:userId', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['active'])
    if (typeof b.active !== 'boolean') fail(400, 'invalid_active')
    const u = data.users.get(params.userId)
    if (!u) fail(404, 'user_not_found')
    if (u.id === principal.user.id && b.active === false) fail(422, 'cannot_deactivate_self')
    u.active = b.active
    // deactivation ends the employee's sessions and delegations at once (the kit re-checks hooks.employees on every use)
    if (!u.active) {
      for (const s of data.sessions.values()) if (s.userId === u.id) s.revoked = true
      await store.revokeDelegationsByUser(u.id)
    }
    return { status: 200, body: { ok: true, user: employee(u) } }
  })

  router.add('POST', '/api/admin/unanswered-scan', HUMAN_MANAGERS, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['minDays'])
    const minDays = b.minDays ?? UNANSWERED_DAYS
    if (!Number.isInteger(minDays) || minDays < 0 || minDays > 30) fail(400, 'invalid_min_days')
    return { status: 200, body: { ok: true, created: await scanUnanswered(minDays) } }
  })

  // ── knowledge: the company documents, searched with the asker's own rights ─────────────────────────────────────────
  // Indexed at start (and again by rebuildKnowledge). Every chunk passes the same personal-data check as long-term memory
  // before it enters the index: bridgePiiScreen = POST /bridge/v1/pii-scan (protocol shapes + hooks.piiScan, names of the roster).
  // The AI reaches it only through a delegation, and only
  // for the roles of the manifest tool on GET /bridge/v1/knowledge/search.
  const baseDocuments = await readKnowledgeDir(knowledgeDir)
  const buildIndex = (documents, options = {}) => buildKnowledgeIndex(documents, {
    roles: kit.declaredRoles, routes: kit.manifest.web?.routes ?? null, screen: bridgePiiScreen({ hooks, ctx: () => kit.ctx() }), ...options,
  })
  const knowledge = createKnowledgeService(await buildIndex(baseDocuments), { webBase, ...knowledgeOptions })
  await knowledge.ready()
  registerKnowledge(bridge, knowledge)
  /** Rebuilds the index (documents added or changed; e.g. a document for one employee: visibility { users: [id] }). */
  async function rebuildKnowledge(extraDocuments = [], options = {}) {
    const index = await buildIndex([...baseDocuments, ...extraDocuments], options)
    await knowledge.setIndex(index)
    return index
  }

  // ── graph: the direct relations of one object, IDs and types only (GET /bridge/v1/graph/neighbors) ─────────────────────
  // The same rules as the screens: staff see their own leave requests and the approvals of their own requests; managers see
  // all. An object the asker may not see answers 404 like one that does not exist.
  const graphHooks = {
    canRead: async ({ entity, id }, asker) => {
      if (entity === 'leave_request') {
        const l = data.leave.get(id)
        return Boolean(l && (asker.role !== 'staff' || l.requesterUserId === asker.id))
      }
      if (entity === 'approval') {
        const a = data.approvals.get(id)
        return Boolean(a && (MANAGERS.includes(asker.role) || a.requestedBy === asker.id))
      }
      return false
    },
    neighbors: async ({ entity, id }) => {
      if (entity === 'leave_request') {
        const l = data.leave.get(id)
        const a = [...data.approvals.values()].find((x) => x.subjectType === 'leave_request' && x.subjectId === id)
        return [{ relation: 'requested_by', entity: 'employee', id: l.requesterUserId }, ...(a ? [{ relation: 'approval', entity: 'approval', id: a.id }] : [])]
      }
      const a = data.approvals.get(id)
      return [
        { relation: 'subject', entity: a.subjectType, id: a.subjectId },
        { relation: 'requested_by', entity: 'employee', id: a.requestedBy },
        { relation: 'required_role', entity: 'role', id: a.requiredRole },
        ...(a.decidedBy ? [{ relation: 'decided_by', entity: 'employee', id: a.decidedBy }] : []),
      ]
    },
  }
  registerGraph(bridge, graphHooks)

  // The handbook screen the sources link to: the sections this employee may read, nothing else (404 for a document that does
  // not exist AND for one the employee may not read: the screen does not tell them apart). People only, like every screen.
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  router.add('GET', '/handbook/:docId', HUMAN, async ({ principal, params, res }) => {
    const asker = { id: principal.user.id, role: principal.user.role }
    const chunks = knowledge.index().chunks.filter((c) => c.documentId === params.docId && canSee(c.visibility, asker))
    if (!chunks.length) fail(404, 'not_found')
    const sections = []
    for (const c of chunks) {
      const last = sections.at(-1)
      if (last && last.key === `${c.heading}#${c.anchor}`) last.text.push(c.text)
      else sections.push({ key: `${c.heading}#${c.anchor}`, heading: c.heading, anchor: c.anchor, text: [c.text] })
    }
    const html = [
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escape(chunks[0].title)}</title><h1>${escape(chunks[0].title)}</h1>`,
      ...sections.map((s) => `${s.heading ? `<h2${s.anchor ? ` id="${escape(s.anchor)}"` : ''}>${escape(s.heading)}</h2>` : ''}${s.text.map((t) => `<p>${escape(t)}</p>`).join('')}`),
    ].join('\n')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return null
  }, { patterns: { docId: '[a-z0-9][a-z0-9-]{0,62}' } })

  return { ...bridge, kit, router, store, data, createUser, requestLeave, scanUnanswered, knowledge, rebuildKnowledge }
}

/** A running instance (server.mjs, the tests). */
export async function startServer({ port = 0, host = '127.0.0.1', ...options }) {
  const app = await createLeaveApp(options)
  const http = await listen(app.handler, { port, host })
  return { app, base: http.base, stop: http.stop }
}
