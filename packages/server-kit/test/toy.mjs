// A fictional business system ("toy tasks") built on the kit with the memory store: the hooks a real system implements,
// with its business data in plain maps. Used by app.test.mjs and alias.test.mjs.
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createBridgeApp, createMemoryStore, fail, listen, POLICY, todayIn, addDays, UUID_RE } from '../src/index.mjs'

export const TOY_MANIFEST = fileURLToPath(new URL('./fixtures/toy.manifest.yaml', import.meta.url))
export const SERVICE_TOKEN = 'toy-test-service-token-0000000000'
export const BFF_SECRET = 'toy-test-bff-secret-0000000000'

// eventDelegations: ({ users, tasks }) => hooks.eventDelegations (per-event delegations; absent = the kit answers 400 to { event })
export async function createToy({ now, store = createMemoryStore({ now }), bffSecret = BFF_SECRET, eventDelegations = null, personalBotPlatforms, help = null, connectors = undefined, piiScan = null, documentReads = null } = {}) {
  const users = new Map()
  const sessions = new Map() // token -> { userId, sessionId, revoked }
  const tasks = new Map()
  const approvals = new Map()
  const today = () => todayIn('Asia/Tokyo', now?.() ?? new Date())

  const hooks = {
    employees: {
      get: async (id) => users.get(String(id)) ?? null,
      list: async ({ roles }) => [...users.values()].filter((u) => u.active && (!roles || roles.includes(u.role))),
    },
    authenticate: async (req) => {
      const m = /(?:^|;\s*)toy_session=([^;]+)/.exec(String(req.headers.cookie ?? ''))
      const s = m && sessions.get(m[1])
      if (!s || s.revoked) return null
      const u = users.get(s.userId)
      if (!u?.active) return null
      return { user: { id: u.id, role: u.role }, sessionId: s.sessionId }
    },
    isSessionLive: async (sessionId) => [...sessions.values()].some((s) => s.sessionId === sessionId && !s.revoked),
    recipientsFor: async (event) => {
      if (event.type !== 'task.overdue') return null
      const task = tasks.get(event.payload.taskId)
      if (!task) return { stale: 'task_deleted' }
      if (task.done) return { stale: 'done' }
      const list = [...users.values()].filter((u) => u.active && (['admin', 'manager'].includes(u.role) || u.id === task.ownerUserId))
      const overdue = [...tasks.values()].filter((t) => !t.done && t.dueOn < today())
      return {
        users: list,
        dedupeKey: `task.overdue:${task.id}:${event.payload.dueOn}`,
        link: `/tasks/${task.id}`,
        paramsFor: (u) => ({ count: u.role === 'staff' ? overdue.filter((t) => t.ownerUserId === u.id).length : overdue.length, daysOverdue: event.payload.daysOverdue, dueOn: event.payload.dueOn }),
      }
    },
    approvals: {
      get: async (id) => approvals.get(id) ?? null,
      approvers: async (a) => [...users.values()].filter((u) => u.active && ['manager', 'admin'].includes(u.role) && u.id !== a.requestedBy),
      card: async (a) => ({ title: 'タスク完了の承認', fields: [{ label: 'タスク ID', value: a.subjectId.slice(0, 8) }], body: '承認・却下はボタンか返信コードで。' }),
      mayDecide: async (a, u) => ['manager', 'admin'].includes(u.role) && u.id !== a.requestedBy,
      decide: async (a, { action, actor, channel }, ctx) => {
        a.status = action === 'approve' ? 'approved' : 'rejected'
        a.decidedBy = actor.id
        await ctx.emitEvent({ type: 'approval.decided', aggregateType: 'approval', aggregateId: a.id, payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, decision: action, status: a.status, channel, decidedByUserId: actor.id } })
        return { id: a.id, status: a.status, channel }
      },
    },
    proposalKinds: {
      task_reschedule: {
        roles: ['admin', 'manager', 'staff'],
        validate: async (p) => {
          if (typeof p.taskId !== 'string' || !tasks.has(p.taskId)) fail(422, 'task_not_found')
          if (typeof p.dueOn !== 'string') fail(400, 'invalid_payload')
        },
        apply: async (p) => { tasks.get(p.taskId).dueOn = p.dueOn },
      },
      task_delete: { roles: ['admin', 'manager'], validate: async () => {}, apply: async (p) => { tasks.delete(p.taskId) } },
    },
    reports: {
      compute: async (viewer) => {
        const own = viewer.role === 'staff'
        const list = [...tasks.values()].filter((t) => !own || t.ownerUserId === viewer.id)
        const overdue = list.filter((t) => !t.done && t.dueOn < today()).length
        return { sections: { tasks: { total: list.length, done: list.filter((t) => t.done).length }, overdue: { count: overdue } }, attention: overdue }
      },
    },
  }

  if (eventDelegations) hooks.eventDelegations = eventDelegations({ users, tasks })
  if (piiScan) hooks.piiScan = piiScan({ users })
  if (documentReads) hooks.documentReads = documentReads
  const bridge = await createBridgeApp({
    manifest: { file: TOY_MANIFEST }, store, serviceToken: SERVICE_TOKEN, bffSecret, hooks, now, personalBotPlatforms, orgId: 'toy-org', service: 'toy-tasks', version: '1.0.0',
    help, connectors, log: (line) => process.stderr.write(`${line}\n`),
  })
  const { kit, router } = bridge

  // the business's own API behind the same gate (a read tool and a write)
  router.add('GET', '/api/tasks', kit.readToolPolicy('GET /api/tasks', ['admin', 'manager', 'staff']), async ({ principal }) => ({
    status: 200, body: { ok: true, tasks: [...tasks.values()].filter((t) => principal.user.role !== 'staff' || t.ownerUserId === principal.user.id) },
  }))
  router.add('GET', '/api/tasks/overdue', kit.readToolPolicy('GET /api/tasks/overdue', ['admin', 'manager']), async () => ({
    status: 200, body: { ok: true, tasks: [...tasks.values()].filter((t) => !t.done && t.dueOn < today()) },
  }))
  router.add('POST', '/api/tasks', { allow: ['user'] }, async () => ({ status: 201, body: { ok: true } }))
  router.add('GET', '/api/public', POLICY.PUBLIC, async () => ({ status: 200, body: { ok: true, public: true } }))

  const toy = {
    bridge, kit, store, users, sessions, tasks, approvals,
    addUser(role, { active = true } = {}) {
      const u = { id: randomUUID(), role, active }
      users.set(u.id, u)
      const token = randomUUID()
      const sessionId = randomUUID()
      sessions.set(token, { userId: u.id, sessionId, revoked: false })
      return { ...u, user: u, token, sessionId, headers: { cookie: `toy_session=${token}` } }
    },
    async addTask({ ownerUserId = null, dueInDays = 5 } = {}) {
      const t = { id: randomUUID(), ownerUserId, dueOn: addDays(today(), dueInDays), done: false }
      tasks.set(t.id, t)
      return t
    },
    /** The business change and its event in one transaction (outbox). */
    async markOverdue(task) {
      return kit.tx(async (t) => kit.emitEvent(t, { type: 'task.overdue', aggregateType: 'task', aggregateId: task.id, payload: { taskId: task.id, dueOn: task.dueOn, daysOverdue: 2, ownerUserId: task.ownerUserId ?? undefined } }))
    },
    async requestApproval(requester) {
      const task = await toy.addTask({ ownerUserId: requester.id })
      const a = { id: randomUUID(), status: 'pending', expiresAt: new Date(Date.now() + 86_400_000), requestedBy: requester.id, subjectType: 'task_close', subjectId: task.id, requiredRole: 'manager' }
      approvals.set(a.id, a)
      await kit.tx((t) => kit.emitEvent(t, { type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id, payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, requiredRole: 'manager', expiresAt: a.expiresAt.toISOString() } }))
      return a
    },
    async start() {
      const srv = await listen(bridge.handler)
      toy.base = srv.base
      toy.stop = srv.stop
      return toy
    },
  }
  return toy
}

/** Tiny JSON client. */
export function client(base) {
  return async function call(method, path, { headers = {}, body, query, raw } = {}) {
    const url = new URL(`${base}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, body: json, text, headers: res.headers }
  }
}

export const isUuid = (v) => UUID_RE.test(v)
