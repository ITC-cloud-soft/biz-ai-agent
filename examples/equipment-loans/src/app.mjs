// equipment-loans — employees borrow shared equipment (laptops, projectors, cameras) of a fictional company, in one file.
//
// A loan of a high-value item, or a loan longer than 7 days, waits for a manager's approval (on the web or with the approval
// card in their own chat; never the borrower's own). Every other loan is booked at once. A loan not returned by its due date
// is followed up once (loan.overdue). Staff see their own loans; managers and administrators see all.
//
// Everything Bridge v1 needs comes from @dsh-bridge/server-kit; this file only holds what knows the business: its data, its
// login, and the hooks (who exists, who is told, who decides, what the AI may propose). The store is the kit's MEMORY store
// and the business data are plain maps (nothing persists across a restart); a real system keeps the hooks and swaps both.
//
// Knowledge: the lending rules in knowledge/*.md, indexed with per-section visibility, searched with the asker's own rights at
// GET /bridge/v1/knowledge/search, and the handbook screen /handbook/:docId the sources link to (the same visibility).
// Graph: GET /bridge/v1/graph/neighbors — the direct relations of one loan, approval or equipment item (IDs and types only).
//
// Built from examples/leave-requests-knowledge with skills/agent-builder.
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
export const KINDS = Object.freeze(['laptop', 'projector', 'camera'])
/** Loans longer than this (first day to due date, both counted) need a manager's approval. */
export const APPROVAL_FREE_DAYS = 7
export const MAX_LOAN_DAYS = 30 // to confirm with the equipment owners
const BOOK_AHEAD_DAYS = 90
const SESSION_COOKIE = 'el_session'
const SESSION_TTL_MS = 12 * 3600_000
const APPROVAL_TTL_DAYS = 7
const LOGIN_FAILURES = 5 // per login id per 10 minutes
const MANAGERS = ['admin', 'manager']
const OPEN = ['pending', 'approved'] // the loan holds its item

/**
 * Synonym groups of the knowledge search (the first word of a group is the one the documents use). Owners' wording; tuned
 * with the evals and listed in the README.
 */
export const KNOWLEDGE_SYNONYMS = Object.freeze([])

/** Inclusive length of a loan in calendar days. */
export const loanDays = (startsOn, dueOn) => Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1

/**
 * createLoansApp({ serviceToken, bffSecret, now?, log?, manifest?, webBase?, knowledgeDir?, knowledgeOptions? })
 *   -> { handler, kit, router, store, data, createUser, createItem, requestLoan, scanOverdue, knowledge, rebuildKnowledge, ... }
 * manifest: { file } (default bridge.manifest.yaml) or { manifest } (tests); webBase: the business web's URL in sources ('' = paths)
 * knowledgeOptions: passed to createKnowledgeService (synonyms default KNOWLEDGE_SYNONYMS; embedder, rerank …; none = BM25F)
 */
export async function createLoansApp({
  serviceToken, bffSecret, orgId = 'example-org', now = () => new Date(), log = () => {},
  manifest = { file: MANIFEST_FILE }, webBase = '', knowledgeDir = KNOWLEDGE_DIR, knowledgeOptions = {},
}) {
  const store = createMemoryStore({ now })
  const data = { users: new Map(), sessions: new Map(), items: new Map(), loans: new Map(), approvals: new Map() }
  const today = () => todayIn('UTC', now())
  const daysBetween = (from, to) => loanDays(from, to) - 1
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

  // ── the equipment catalog ───────────────────────────────────────────────────────────────────────────────────────
  function createItem({ assetTag, kind, highValue }) {
    const item = { id: randomUUID(), assetTag, kind, highValue: Boolean(highValue), active: true }
    data.items.set(item.id, item)
    return item
  }
  const onLoanToday = (itemId) => [...data.loans.values()].some((l) => l.itemId === itemId && l.status === 'approved' && l.startsOn <= today())
  const itemJson = (i) => ({ id: i.id, assetTag: i.assetTag, kind: i.kind, highValue: i.highValue, onLoan: onLoanToday(i.id) })

  // ── loans and their approval (managers decide, never the borrower) ─────────────────────────────────────────────
  const loanJson = (l) => ({
    id: l.id, itemId: l.itemId, borrowerUserId: l.borrowerUserId, startsOn: l.startsOn, dueOn: l.dueOn, status: l.status,
    approvalReasons: l.approvalReasons, returnedOn: l.returnedOn ?? null, requestedAt: l.createdAt.toISOString(),
  })
  const approvalJson = (a) => ({ id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, status: a.status, expiresAt: a.expiresAt.toISOString(), decidedBy: a.decidedBy ?? null, channel: a.channel ?? null })
  /** THE approval rule (the web route and the chat card both use it): an active manager or administrator, never the borrower. */
  const mayDecide = (a, user) => Boolean(user && user.active !== false && MANAGERS.includes(user.role) && String(user.id) !== String(a.requestedBy))
  const visibleTo = (user) => (l) => user.role !== 'staff' || l.borrowerUserId === user.id
  const overdue = () => [...data.loans.values()].filter((l) => l.status === 'approved' && l.dueOn < today())
  /** Why a loan needs a manager's approval ([] = booked at once). */
  const approvalReasonsFor = (item, startsOn, dueOn) => [
    ...(item.highValue ? ['high_value'] : []),
    ...(loanDays(startsOn, dueOn) > APPROVAL_FREE_DAYS ? ['longer_than_7_days'] : []),
  ]

  function checkDates(startsOn, dueOn) {
    if (typeof startsOn !== 'string' || !DATE_RE.test(startsOn) || typeof dueOn !== 'string' || !DATE_RE.test(dueOn)) fail(400, 'invalid_dates')
    if (startsOn < today() || dueOn < startsOn || startsOn > addDays(today(), BOOK_AHEAD_DAYS)) fail(400, 'invalid_dates')
    if (loanDays(startsOn, dueOn) > MAX_LOAN_DAYS) fail(400, 'loan_too_long')
  }
  /** The item must exist and have no other open loan on any of these days. */
  function checkAvailable(itemId, startsOn, dueOn, exceptLoanId = null) {
    const item = typeof itemId === 'string' && data.items.get(itemId)
    if (!item || !item.active) fail(404, 'item_not_found')
    const clash = [...data.loans.values()].some((l) => l.id !== exceptLoanId && l.itemId === itemId && OPEN.includes(l.status) && l.startsOn <= dueOn && startsOn <= l.dueOn)
    if (clash) fail(409, 'item_unavailable')
    return item
  }

  /** The business change and its event in one transaction (outbox): the loan, its approval when needed, approval.requested. */
  async function requestLoan(user, body) {
    strictKeys(body, ['itemId', 'startsOn', 'dueOn'])
    checkDates(body.startsOn, body.dueOn)
    const item = checkAvailable(body.itemId, body.startsOn, body.dueOn)
    const reasons = approvalReasonsFor(item, body.startsOn, body.dueOn)
    const loan = {
      id: randomUUID(), itemId: item.id, borrowerUserId: user.id, startsOn: body.startsOn, dueOn: body.dueOn,
      status: reasons.length ? 'pending' : 'approved', approvalReasons: reasons, createdAt: now(),
    }
    if (!reasons.length) {
      data.loans.set(loan.id, loan) // booked at once: no approval, no event
      return { loan: loanJson(loan), approval: null }
    }
    const a = { id: randomUUID(), subjectType: 'loan', subjectId: loan.id, requiredRole: 'manager', requestedBy: user.id, status: 'pending', expiresAt: new Date(now().getTime() + APPROVAL_TTL_DAYS * 86_400_000) }
    await kit.tx(async (t) => {
      await kit.emitEvent(t, {
        type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id,
        payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, requiredRole: a.requiredRole, expiresAt: a.expiresAt.toISOString() },
      })
      data.loans.set(loan.id, loan) // the memory store's transaction cannot roll maps back: change them after the event is written
      data.approvals.set(a.id, a)
    })
    return { loan: loanJson(loan), approval: approvalJson(a) }
  }

  /** A person's decision (web or chat card) inside the caller's transaction: the loan, the approval, approval.decided. */
  async function decide(t, a, { action, actor, channel }) {
    if (a.status !== 'pending') fail(409, 'already_decided')
    if (a.expiresAt <= now()) fail(409, 'approval_expired')
    const loan = data.loans.get(a.subjectId)
    if (!loan || loan.status !== 'pending') fail(409, 'loan_not_pending')
    const status = action === 'approve' ? 'approved' : 'rejected'
    await kit.emitEvent(t, {
      type: 'approval.decided', aggregateType: 'approval', aggregateId: a.id,
      payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, decision: action, status, channel, decidedByUserId: actor.id },
    })
    Object.assign(a, { status, decidedBy: actor.id, channel })
    loan.status = status
    return approvalJson(a)
  }

  /** The follow-up: one loan.overdue per loan past its due date (the scheduler of a real system runs it daily). */
  async function scanOverdue() {
    const created = []
    for (const l of overdue().filter((x) => !x.overdueNotified)) {
      const eventId = await kit.tx(async (t) => kit.emitEvent(t, {
        type: 'loan.overdue', aggregateType: 'loan', aggregateId: l.id,
        payload: { loanId: l.id, borrowerUserId: l.borrowerUserId, itemId: l.itemId, dueOn: l.dueOn, daysOverdue: daysBetween(l.dueOn, today()) },
      }))
      l.overdueNotified = true
      created.push({ loanId: l.id, eventId })
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
      if (event.type !== 'loan.overdue') return null
      const l = data.loans.get(event.payload.loanId)
      if (!l) return { stale: 'deleted' }
      if (l.status !== 'approved') return { stale: l.status } // returned or cancelled since
      const users = [...data.users.values()].filter((u) => u.active && (MANAGERS.includes(u.role) || u.id === l.borrowerUserId)).map(employee)
      const late = overdue()
      return {
        users,
        dedupeKey: `loan.overdue:${l.id}`,
        link: `/loans/${l.id}`,
        paramsFor: (u) => ({ count: u.role === 'staff' ? late.filter(visibleTo(u)).length : late.length, daysOverdue: event.payload.daysOverdue, dueOn: l.dueOn }),
      }
    },

    approvals: {
      get: async (id) => data.approvals.get(String(id)) ?? null,
      approvers: async (a) => [...data.users.values()].filter((u) => mayDecide(a, u)).map(employee),
      /** The chat card: IDs, kinds, dates and rule names only — no names. */
      card: async (a) => {
        const l = data.loans.get(a.subjectId)
        const item = l && data.items.get(l.itemId)
        return {
          title: 'Equipment loan',
          fields: [
            { label: 'Loan', value: String(a.subjectId).slice(0, 8) },
            { label: 'Item', value: item ? `${item.kind} ${item.assetTag}` : '-' },
            { label: 'Dates', value: l ? `${l.startsOn} – ${l.dueOn} (${loanDays(l.startsOn, l.dueOn)} days)` : '-' },
            { label: 'Needs approval', value: l ? l.approvalReasons.map((r) => (r === 'high_value' ? 'high-value item' : 'longer than 7 days')).join(', ') : '-' },
            { label: 'Decide by', value: a.expiresAt.toISOString().slice(0, 10) },
          ],
          body: 'Approve or reject with the buttons or the reply code. Details are in Equipment Loans.',
        }
      },
      mayDecide: async (a, user) => mayDecide(a, user), // the same rule as the web
      decide: (a, decision, ctx) => decide(ctx.t, a, decision),
    },

    /** What the AI may propose (a person accepts or rejects every proposal; apply runs only then). */
    proposalKinds: {
      loan_new_dates: {
        roles: ['admin', 'manager', 'staff'],
        async validate(p, ctx, principal) {
          strictKeys(p, ['loanId', 'startsOn', 'dueOn', 'reason'], 'invalid_payload')
          if (typeof p.loanId !== 'string' || !UUID_RE.test(p.loanId)) fail(400, 'invalid_payload')
          checkDates(p.startsOn, p.dueOn)
          const l = data.loans.get(p.loanId)
          if (!l || l.status !== 'pending') fail(422, 'loan_not_pending')
          if (principal?.user?.role === 'staff' && l.borrowerUserId !== principal.user.id) fail(422, 'loan_not_pending') // staff: their own only
          checkAvailable(l.itemId, p.startsOn, p.dueOn, l.id)
        },
        // the loan keeps waiting for its approval (the decision is still a person's)
        async apply(p) { Object.assign(data.loans.get(p.loanId), { startsOn: p.startsOn, dueOn: p.dueOn }) },
      },
      loan_cancel: {
        roles: MANAGERS,
        async validate(p) {
          strictKeys(p, ['loanId'], 'invalid_payload')
          const l = data.loans.get(String(p.loanId))
          if (!l || !OPEN.includes(l.status)) fail(422, 'loan_not_open')
        },
        async apply(p) {
          const l = data.loans.get(p.loanId)
          l.status = 'cancelled'
          for (const a of data.approvals.values()) if (a.subjectId === l.id && a.status === 'pending') a.status = 'cancelled'
        },
      },
    },

    /** The scheduled report: counts per section, scoped by role (staff: their own). */
    reports: {
      compute: async (viewer) => {
        const mine = [...data.loans.values()].filter((l) => viewer.role !== 'staff' || l.borrowerUserId === viewer.id)
        const pending = mine.filter((l) => l.status === 'pending').length
        const late = mine.filter((l) => l.status === 'approved' && l.dueOn < today()).length
        const dueSoon = mine.filter((l) => l.status === 'approved' && l.dueOn >= today() && l.dueOn <= addDays(today(), 2)).length
        return { sections: { pending_approval: { count: pending }, overdue: { count: late }, due_soon: { count: dueSoon } }, attention: pending + late }
      },
    },

    /** Names live only here, in the roster: a text that contains one is refused by long-term memory and by the index. */
    piiScan: async (text) => {
      const hay = String(text).normalize('NFKC').toLowerCase()
      const hit = [...data.users.values()].some((u) => u.displayName.length >= 2 && hay.includes(u.displayName.normalize('NFKC').toLowerCase()))
      return { kinds: hit ? ['staff_name'] : [] }
    },
  }

  const bridge = await createBridgeApp({
    manifest, store, serviceToken, bffSecret, orgId, service: 'equipment-loans', version: '0.1.0', hooks, now, log,
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
    const token = newToken('els')
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

  router.add('GET', '/api/equipment', kit.readToolPolicy('GET /api/equipment', [...ROLES]), async ({ query }) => {
    const kind = query.get('kind') ?? 'all'
    if (![...KINDS, 'all'].includes(kind)) fail(400, 'invalid_kind')
    const list = [...data.items.values()].filter((i) => i.active && (kind === 'all' || i.kind === kind))
    return { status: 200, body: { ok: true, items: list.map(itemJson) } }
  })

  router.add('GET', '/api/loans', kit.readToolPolicy('GET /api/loans', [...ROLES]), async ({ principal, query }) => {
    const status = query.get('status') ?? 'all'
    if (!['pending', 'approved', 'rejected', 'returned', 'cancelled', 'all'].includes(status)) fail(400, 'invalid_status')
    const list = [...data.loans.values()].filter(visibleTo(principal.user)).filter((l) => status === 'all' || l.status === status)
    return { status: 200, body: { ok: true, loans: list.map(loanJson) } }
  })

  router.add('GET', '/api/loans/overdue', kit.readToolPolicy('GET /api/loans/overdue', MANAGERS), async () => ({
    status: 200,
    body: { ok: true, loans: overdue().map((l) => ({ id: l.id, itemId: l.itemId, borrowerUserId: l.borrowerUserId, dueOn: l.dueOn, daysOverdue: daysBetween(l.dueOn, today()) })) },
  }))

  router.add('POST', '/api/loans', HUMAN, async ({ principal, body }) => ({ status: 201, body: { ok: true, ...(await requestLoan(principal.user, body ?? {})) } }))

  /** The item came back: the borrower or a manager / administrator records it (people only). */
  router.add('POST', '/api/loans/:loanId/return', HUMAN, async ({ principal, params, body }) => {
    strictKeys(body ?? {}, [])
    const l = data.loans.get(params.loanId)
    if (!l || !visibleTo(principal.user)(l)) fail(404, 'loan_not_found')
    if (l.status !== 'approved') fail(409, 'loan_not_out')
    if (l.startsOn > today()) fail(409, 'loan_not_started')
    Object.assign(l, { status: 'returned', returnedOn: today(), returnedBy: principal.user.id })
    return { status: 200, body: { ok: true, loan: loanJson(l) } }
  })

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

  router.add('POST', '/api/admin/equipment', ADMIN, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['assetTag', 'kind', 'highValue'])
    if (typeof b.assetTag !== 'string' || !/^[A-Z]{2,4}-\d{3,5}$/.test(b.assetTag)) fail(400, 'invalid_asset_tag')
    if (!KINDS.includes(b.kind)) fail(400, 'invalid_kind')
    if (typeof b.highValue !== 'boolean') fail(400, 'invalid_high_value')
    if ([...data.items.values()].some((i) => i.assetTag === b.assetTag)) fail(409, 'asset_tag_taken')
    return { status: 201, body: { ok: true, item: itemJson(createItem(b)) } }
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

  router.add('POST', '/api/admin/overdue-scan', HUMAN_MANAGERS, async ({ body }) => {
    strictKeys(body ?? {}, [])
    return { status: 200, body: { ok: true, created: await scanOverdue() } }
  })

  // ── knowledge: the lending rules, searched with the asker's own rights ─────────────────────────────────────────────
  // Indexed at start (and again by rebuildKnowledge). Every chunk passes the same personal-data check as long-term memory
  // before it enters the index: bridgePiiScreen = POST /bridge/v1/pii-scan (protocol shapes + hooks.piiScan, names of the roster).
  // The AI reaches it only through a delegation, and only for the roles of the manifest tool on GET /bridge/v1/knowledge/search.
  const baseDocuments = await readKnowledgeDir(knowledgeDir)
  const buildIndex = (documents, options = {}) => buildKnowledgeIndex(documents, {
    roles: kit.declaredRoles, routes: kit.manifest.web?.routes ?? null, screen: bridgePiiScreen({ hooks, ctx: () => kit.ctx() }), ...options,
  })
  const knowledge = createKnowledgeService(await buildIndex(baseDocuments), { webBase, synonyms: KNOWLEDGE_SYNONYMS, ...knowledgeOptions })
  await knowledge.ready()
  registerKnowledge(bridge, knowledge)
  /** Rebuilds the index (documents added or changed; e.g. a document for one employee: visibility { users: [id] }). */
  async function rebuildKnowledge(extraDocuments = [], options = {}) {
    const index = await buildIndex([...baseDocuments, ...extraDocuments], options)
    await knowledge.setIndex(index)
    return index
  }

  // ── graph: the direct relations of one object, IDs and types only (GET /bridge/v1/graph/neighbors) ─────────────────────
  // The same rules as the screens: staff see their own loans and the approvals of their own loans; managers see all; the
  // catalog (equipment items) is for everyone. An object the asker may not see answers 404 like one that does not exist.
  const graphHooks = {
    canRead: async ({ entity, id }, asker) => {
      if (entity === 'loan') {
        const l = data.loans.get(id)
        return Boolean(l && visibleTo(asker)(l))
      }
      if (entity === 'approval') {
        const a = data.approvals.get(id)
        return Boolean(a && (MANAGERS.includes(asker.role) || a.requestedBy === asker.id))
      }
      if (entity === 'equipment_item') return Boolean(data.items.get(id)?.active)
      return false
    },
    neighbors: async ({ entity, id }) => {
      if (entity === 'loan') {
        const l = data.loans.get(id)
        const a = [...data.approvals.values()].find((x) => x.subjectType === 'loan' && x.subjectId === id)
        return [
          { relation: 'requested_by', entity: 'employee', id: l.borrowerUserId },
          { relation: 'item', entity: 'equipment_item', id: l.itemId },
          ...(a ? [{ relation: 'approval', entity: 'approval', id: a.id }] : []),
        ]
      }
      if (entity === 'equipment_item') {
        // its open loans; the route drops the ones the asker may not read
        return [...data.loans.values()].filter((l) => l.itemId === id && OPEN.includes(l.status)).map((l) => ({ relation: 'loan', entity: 'loan', id: l.id }))
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

  return { ...bridge, kit, router, store, data, createUser, createItem, requestLoan, scanOverdue, mayDecide, knowledge, rebuildKnowledge }
}

/** A running instance (server.mjs, the tests). */
export async function startServer({ port = 0, host = '127.0.0.1', ...options }) {
  const app = await createLoansApp(options)
  const http = await listen(app.handler, { port, host })
  return { app, base: http.base, stop: http.stop }
}
