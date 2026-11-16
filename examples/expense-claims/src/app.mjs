// expense-claims (経費精算) — employees of a fictional company claim their business expenses, in one file.
//
// An employee submits a claim (date, category, amount in yen, a short note). A claim of up to 30,000 yen is decided by the
// claimant's own manager; a claim over 30,000 yen by an administrator. Nobody decides their own claim. A claim that has waited
// more than 3 days for a decision prompts ONE reminder to its approver(s) (expense.claim_waiting). Staff see their own claims,
// managers their own and their team's, administrators all.
//
// The AI employee reads the claims the asking employee may see and may PROPOSE a correction (date, category, note — never the
// amount); the claimant accepts or rejects it on the web. It never approves and never decides an amount.
//
// Everything Bridge v1 needs comes from @dsh-bridge/server-kit; this file only holds what knows the business: its data, its
// login, and the hooks (who exists, who is told, who decides, what the AI may propose). The store is the kit's MEMORY store and
// the business data are plain maps (nothing persists across a restart); a real system keeps the hooks and swaps both.
//
// Knowledge: the expense rules in knowledge/*.md (Japanese and English), indexed with per-section visibility, searched with the
// asker's own rights at GET /bridge/v1/knowledge/search, and the handbook screen /handbook/:docId the sources link to.
// Graph: GET /bridge/v1/graph/neighbors — the direct relations of one claim or approval (IDs and types only).
//
// Built from examples/leave-requests-knowledge with skills/agent-builder.
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addDays, createBridgeApp, createMemoryStore, DATE_RE, DUMMY_PASSWORD_HASH, fail, hashPassword, header, listen, newToken, POLICY,
  sha256, strictKeys, todayIn, UUID_RE, verifyPassword,
} from '@dsh-bridge/server-kit'
import { createAgentSettings, signInPage, redirectToSignIn } from '@dsh-bridge/agent-settings'
import { createDshGateway } from '@dsh-bridge/gateway'
import { registerGraph } from '@dsh-bridge/graph'
import { bridgePiiScreen, buildKnowledgeIndex, canSee, readKnowledgeDir, registerKnowledge } from '@dsh-bridge/knowledge'

export const MANIFEST_FILE = fileURLToPath(new URL('../bridge.manifest.yaml', import.meta.url))
export const KNOWLEDGE_DIR = fileURLToPath(new URL('../knowledge/', import.meta.url))
export const ROLES = Object.freeze(['admin', 'manager', 'staff'])
export const TIME_ZONE = 'Asia/Tokyo'
export const CATEGORIES = Object.freeze(['transport', 'lodging', 'meals', 'supplies', 'communication', 'other'])
/** Up to this amount the claimant's manager decides; above it an administrator (the business need). */
export const APPROVAL_LIMIT_YEN = 30_000
/** A claim waiting MORE than this many days for a decision prompts one reminder to its approver(s) (the business need). */
export const REMINDER_AFTER_DAYS = 3
export const MAX_AMOUNT_YEN = 1_000_000 // to confirm with the administrators
export const SUBMIT_WITHIN_DAYS = 30 // a claim is submitted within 30 days of the expense (to confirm; the documents say so)
export const NOTE_MAX = 200
export const CORRECTION_REASONS = Object.freeze(['date_mismatch', 'category_mismatch', 'note_unclear'])
export const AUDIT_REASONS = Object.freeze(['random_sample', 'near_limit', 'late_submission', 'duplicate_suspected'])
const SESSION_COOKIE = 'ec_session'
const SESSION_TTL_MS = 12 * 3600_000
const APPROVAL_TTL_DAYS = 14
const LOGIN_FAILURES = 5 // per login id per 10 minutes
const MANAGERS = ['admin', 'manager']
const DAY_MS = 86_400_000

/**
 * The knowledge options (language tuning) — ONE object, used by the app (agent.register) and by evals/run.mjs, so the evals
 * measure the configuration that runs. Synonym groups: the first word of a group is the one the documents use.
 */
export const KNOWLEDGE_OPTIONS = Object.freeze({
  // tuned with the evals after their first run (README "Evals"); single words only — a group word matches as a substring of
  // the question with its spaces removed, so a multi-word entry never matches
  synonyms: [
    // en
    ['commuting', 'commute', 'daily'],
    ['fines', 'ticket', 'penalty'],
    ['alcohol', 'beer', 'wine', 'drinks'],
    ['salary', 'money', 'refund', 'reimbursed'],
    ['propose', 'suggested', 'suggest', 'suggests'],
    // ja
    ['宿泊', 'ホテル', '泊まる'],
    ['通勤', '通う'],
    ['領収書', 'レシート'],
    ['保管', '取っておく', '取っておけ'],
    ['支払', '戻って', '戻る'],
    ['分割', '分けて', '分ける'],
    ['チーム', '部下'],
  ],
})

/**
 * createExpenseApp({ serviceToken, bffSecret, now?, log?, manifest?, webBase?, knowledgeDir?, knowledgeOptions?, ... })
 *   -> { handler, kit, router, store, data, createUser, submitClaim, scanWaiting, mayDecide, knowledge, rebuildKnowledge, agent, ... }
 * manifest: { file } (default bridge.manifest.yaml) or { manifest } (tests); webBase: the business web's URL in sources ('' = paths)
 * knowledgeOptions: added to KNOWLEDGE_OPTIONS (embedder, rerank …; none = BM25F)
 * dataDir / agentEnv / agentFetch / vectorDb: the settings plugin (@dsh-bridge/agent-settings): its data directory (default a new
 *   temp directory), where it reads keys and AGENT_VECTOR_DB_URL, the fetch for model calls, a database for pgvector
 * dsh: { target, launchToken } — a running DSH: the framework's DSH gateway at /dsh (administrators only), for the IM bot pages
 */
export async function createExpenseApp({
  serviceToken, bffSecret, orgId = 'example-org', now = () => new Date(), log = () => {},
  manifest = { file: MANIFEST_FILE }, webBase = '', knowledgeDir = KNOWLEDGE_DIR, knowledgeOptions = {},
  dataDir = null, agentEnv = process.env, agentFetch = globalThis.fetch, vectorDb = null, dsh = null,
}) {
  const store = createMemoryStore({ now })
  const data = { users: new Map(), sessions: new Map(), claims: new Map(), approvals: new Map() }
  const today = () => todayIn(TIME_ZONE, now())
  const daysSince = (date) => Math.floor((now().getTime() - date.getTime()) / DAY_MS)
  const waitedTooLong = (c) => c.status === 'pending' && now().getTime() - c.createdAt.getTime() > REMINDER_AFTER_DAYS * DAY_MS
  const employee = (u) => u && { id: u.id, role: u.role, active: u.active }

  // ── the business's own login (the kit never sees passwords) ───────────────────────────────────────────────────────
  async function createUser({ loginId, password, role, displayName, managerId = null }) {
    const u = { id: randomUUID(), loginId, role, displayName, managerId, active: true, passwordHash: await hashPassword(password) }
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

  // ── claims and their approval ───────────────────────────────────────────────────────────────────────────────────
  const claimJson = (c) => ({
    id: c.id, claimantUserId: c.claimantUserId, spentOn: c.spentOn, category: c.category, amountYen: c.amountYen, note: c.note,
    status: c.status, approvalId: c.approvalId, requiredRole: data.approvals.get(c.approvalId)?.requiredRole ?? null,
    submittedAt: c.createdAt.toISOString(), decidedAt: c.decidedAt?.toISOString() ?? null, auditSample: Boolean(c.auditSample),
  })
  const approvalJson = (a) => ({
    id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, requiredRole: a.requiredRole, assignedTo: a.assignedTo,
    status: a.status, expiresAt: a.expiresAt.toISOString(), decidedBy: a.decidedBy ?? null, channel: a.channel ?? null,
  })

  /** Who decides a claim of this amount: up to the limit the claimant's own manager, above it an administrator. */
  function approverFor(claimant, amountYen) {
    if (amountYen > APPROVAL_LIMIT_YEN) return { requiredRole: 'admin', assignedTo: null }
    const m = claimant.managerId ? data.users.get(claimant.managerId) : null
    // no (active) manager: an administrator decides (to confirm)
    if (!m || !m.active || m.id === claimant.id) return { requiredRole: 'admin', assignedTo: null }
    return { requiredRole: m.role, assignedTo: m.id }
  }

  /**
   * THE approval rule (the web route, the chat card and the reminder's recipients all use it): never the claimant; an approval
   * assigned to a manager is that manager's alone (while they are active; after that an administrator's); else an administrator.
   */
  function mayDecide(a, user) {
    if (!a || !user || user.active === false || String(user.id) === String(a.requestedBy)) return false
    if (a.assignedTo && data.users.get(a.assignedTo)?.active) return String(user.id) === String(a.assignedTo)
    return user.role === 'admin'
  }

  /** Who may see a claim (the same rule for the web, the AI's delegation and the graph). */
  const visibleTo = (user) => (c) => {
    if (!user || !c) return false
    if (user.role === 'admin' || c.claimantUserId === user.id) return true
    if (user.role !== 'manager') return false
    return data.users.get(c.claimantUserId)?.managerId === user.id || data.approvals.get(c.approvalId)?.assignedTo === user.id
  }

  function checkSpentOn(spentOn, { submittedOn = today() } = {}) {
    if (typeof spentOn !== 'string' || !DATE_RE.test(spentOn) || spentOn > today()) fail(400, 'invalid_date')
    if (spentOn < addDays(submittedOn, -SUBMIT_WITHIN_DAYS)) fail(400, 'claim_too_late')
  }
  const checkCategory = (category) => { if (!CATEGORIES.includes(category)) fail(400, 'invalid_category') }
  const checkNote = (note) => { if (typeof note !== 'string' || note.length > NOTE_MAX) fail(400, 'invalid_note') }
  function checkAmount(amountYen) {
    if (!Number.isInteger(amountYen) || amountYen < 1 || amountYen > MAX_AMOUNT_YEN) fail(400, 'invalid_amount')
  }

  /** The business change and its event in one transaction (outbox): the claim, its approval, approval.requested. */
  async function submitClaim(user, body) {
    strictKeys(body, ['spentOn', 'category', 'amountYen', 'note'])
    checkSpentOn(body.spentOn)
    checkCategory(body.category)
    checkAmount(body.amountYen)
    const note = body.note ?? ''
    checkNote(note)
    const claimant = data.users.get(user.id)
    const c = { id: randomUUID(), claimantUserId: user.id, spentOn: body.spentOn, category: body.category, amountYen: body.amountYen, note: note.trim(), status: 'pending', createdAt: now(), submittedOn: today() }
    const { requiredRole, assignedTo } = approverFor(claimant, c.amountYen)
    const a = {
      id: randomUUID(), subjectType: 'expense_claim', subjectId: c.id, requiredRole, assignedTo, requestedBy: user.id, status: 'pending',
      expiresAt: new Date(now().getTime() + APPROVAL_TTL_DAYS * DAY_MS),
    }
    c.approvalId = a.id
    await kit.tx(async (t) => {
      await kit.emitEvent(t, {
        type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id,
        payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, requiredRole: a.requiredRole, expiresAt: a.expiresAt.toISOString() },
      })
      data.claims.set(c.id, c) // the memory store's transaction cannot roll maps back: change them after the event is written
      data.approvals.set(a.id, a)
    })
    return { claim: claimJson(c), approval: approvalJson(a) }
  }

  /** A person's decision (web or chat card) inside the caller's transaction: the claim, the approval, approval.decided. */
  async function decide(t, a, { action, actor, channel }) {
    if (a.status !== 'pending') fail(409, 'already_decided')
    if (a.expiresAt <= now()) fail(409, 'approval_expired')
    const c = data.claims.get(a.subjectId)
    if (!c || c.status !== 'pending') fail(409, 'claim_not_pending')
    const status = action === 'approve' ? 'approved' : 'rejected'
    await kit.emitEvent(t, {
      type: 'approval.decided', aggregateType: 'approval', aggregateId: a.id,
      payload: { approvalId: a.id, subjectType: a.subjectType, subjectId: a.subjectId, decision: action, status, channel, decidedByUserId: actor.id },
    })
    Object.assign(a, { status, decidedBy: actor.id, channel })
    Object.assign(c, { status, decidedAt: now() })
    return approvalJson(a)
  }

  /** The reminder: one expense.claim_waiting per claim that has waited more than 3 days (a real system's scheduler runs it). */
  async function scanWaiting() {
    const created = []
    for (const c of [...data.claims.values()].filter((x) => waitedTooLong(x) && !x.waitingNotified)) {
      const a = data.approvals.get(c.approvalId)
      const eventId = await kit.tx(async (t) => kit.emitEvent(t, {
        type: 'expense.claim_waiting', aggregateType: 'expense_claim', aggregateId: c.id,
        payload: { claimId: c.id, approvalId: a.id, claimantUserId: c.claimantUserId, requiredRole: a.requiredRole, submittedOn: c.submittedOn, daysWaiting: daysSince(c.createdAt) },
      }))
      c.waitingNotified = true
      created.push({ claimId: c.id, eventId })
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
      if (event.type !== 'expense.claim_waiting') return null
      const c = data.claims.get(event.payload.claimId)
      if (!c) return { stale: 'deleted' }
      if (c.status !== 'pending') return { stale: 'decided' }
      const a = data.approvals.get(c.approvalId)
      // the approver(s) only — checked with THE approval rule, the one the web screen uses
      const users = [...data.users.values()].filter((u) => u.active && mayDecide(a, u)).map(employee)
      const waitingFor = (u) => [...data.claims.values()].filter((x) => waitedTooLong(x) && mayDecide(data.approvals.get(x.approvalId), u)).length
      return {
        users,
        dedupeKey: `expense.claim_waiting:${c.id}`,
        link: `/expense-claims/${c.id}`,
        paramsFor: (u) => ({ count: waitingFor(u), daysWaiting: event.payload.daysWaiting, submittedOn: event.payload.submittedOn }),
      }
    },

    approvals: {
      get: async (id) => data.approvals.get(String(id)) ?? null,
      approvers: async (a) => [...data.users.values()].filter((u) => u.active && mayDecide(a, u)).map(employee),
      /** The chat card: the claim's ID, date, category, amount and limit rule — no names, no note. */
      card: async (a) => {
        const c = data.claims.get(a.subjectId)
        return {
          title: 'Expense claim',
          fields: [
            { label: 'Claim', value: String(a.subjectId).slice(0, 8) },
            { label: 'Spent on', value: c?.spentOn ?? '-' },
            { label: 'Category', value: c?.category ?? '-' },
            { label: 'Amount (yen)', value: c ? String(c.amountYen) : '-' },
            { label: 'Rule', value: a.requiredRole === 'admin' && !a.assignedTo ? 'administrator' : 'manager (up to 30000 yen)' },
            { label: 'Decide by', value: a.expiresAt.toISOString().slice(0, 10) },
          ],
          body: 'Approve or reject with the buttons or the reply code. The receipt and the note are in Expense Claims.',
        }
      },
      mayDecide: async (a, user) => mayDecide(a, user), // the same rule as the web
      decide: (a, decision, ctx) => decide(ctx.t, a, decision),
    },

    /** What the AI may propose (a person accepts or rejects every proposal; apply runs only then). */
    proposalKinds: {
      // a correction of a waiting claim (date, category, note — NEVER the amount); the CLAIMANT accepts or rejects it on the web
      expense_correct_claim: {
        roles: [...ROLES],
        async validate(p, ctx, principal) {
          strictKeys(p, ['claimId', 'spentOn', 'category', 'note', 'reasonCode'], 'invalid_payload') // an amount is refused here
          if (typeof p.claimId !== 'string' || !UUID_RE.test(p.claimId)) fail(400, 'invalid_payload')
          if (!CORRECTION_REASONS.includes(p.reasonCode)) fail(400, 'invalid_payload')
          if (p.spentOn === undefined && p.category === undefined && p.note === undefined) fail(400, 'invalid_payload')
          const c = data.claims.get(p.claimId)
          // an employee's AI corrects only what that employee may see; missing and hidden answer alike
          if (!c || !principal?.user || !visibleTo(principal.user)(c)) fail(422, 'claim_not_found')
          if (c.status !== 'pending') fail(422, 'claim_not_pending')
          if (p.spentOn !== undefined) checkSpentOn(p.spentOn, { submittedOn: c.submittedOn })
          if (p.category !== undefined) checkCategory(p.category)
          if (p.note !== undefined) checkNote(p.note)
        },
        async apply(p, user) {
          const c = data.claims.get(p.claimId)
          if (!c || c.status !== 'pending') fail(409, 'claim_not_pending')
          if (String(user?.id) !== String(c.claimantUserId)) fail(403, 'not_the_claimant') // only the claimant accepts
          if (p.spentOn !== undefined) checkSpentOn(p.spentOn, { submittedOn: c.submittedOn })
          for (const k of ['spentOn', 'category']) if (p[k] !== undefined) c[k] = p[k]
          if (p.note !== undefined) c.note = p.note.trim()
          c.corrections = (c.corrections ?? 0) + 1
        },
      },
      // the audit sample (administrators): an approved claim is added to the next audit's sample; an administrator accepts it
      expense_audit_sample: {
        roles: ['admin'],
        async validate(p) {
          strictKeys(p, ['claimId', 'reasonCode'], 'invalid_payload')
          if (typeof p.claimId !== 'string' || !UUID_RE.test(p.claimId) || !AUDIT_REASONS.includes(p.reasonCode)) fail(400, 'invalid_payload')
          const c = data.claims.get(p.claimId)
          if (!c || c.status !== 'approved') fail(422, 'claim_not_approved')
          if (c.auditSample) fail(422, 'already_sampled')
        },
        async apply(p, user) {
          if (user?.role !== 'admin') fail(403, 'role_not_permitted')
          const c = data.claims.get(p.claimId)
          if (!c || c.status !== 'approved') fail(409, 'claim_not_approved')
          Object.assign(c, { auditSample: true, auditReason: p.reasonCode, auditSampledBy: user.id })
        },
      },
    },

    /** The scheduled report: counts per section, scoped by what the viewer may see (staff: their own). */
    reports: {
      compute: async (viewer) => {
        const mine = [...data.claims.values()].filter(visibleTo(viewer))
        const month = today().slice(0, 7)
        const pending = mine.filter((c) => c.status === 'pending').length
        const waiting = mine.filter(waitedTooLong).length
        const approved = mine.filter((c) => c.status === 'approved' && todayIn(TIME_ZONE, c.decidedAt).slice(0, 7) === month).length
        const forMe = [...data.claims.values()].filter((c) => c.status === 'pending' && mayDecide(data.approvals.get(c.approvalId), viewer)).length
        return { sections: { pending: { count: pending }, waiting_long: { count: waiting }, approved_this_month: { count: approved } }, attention: forMe }
      },
    },

    /** Names live only here, in the roster: a text that contains one is refused by long-term memory and by the index. */
    piiScan: async (text) => {
      const hay = String(text).normalize('NFKC').toLowerCase()
      const hit = [...data.users.values()].some((u) => u.displayName.length >= 2 && hay.includes(u.displayName.normalize('NFKC').toLowerCase()))
      return { kinds: hit ? ['staff_name'] : [] }
    },
  }

  // biz-ai-agent settings (@dsh-bridge/agent-settings): the approvals of uploaded documents and the knowledge.updated report go
  // first, everything else to this system's own hooks
  const agent = createAgentSettings({ dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'expense-agent-')), env: agentEnv, fetch: agentFetch, now, log, vectorDb })
  hooks.approvals = agent.approvals(hooks.approvals)
  hooks.recipientsFor = agent.recipientsFor(hooks.recipientsFor)

  const bridge = await createBridgeApp({
    manifest, store, serviceToken, bffSecret, orgId, service: 'expense-claims', version: '0.1.0', hooks, now, log,
    // proposals: the kit's review routes are for administrators (they may reject a stale proposal); a correction is ACCEPTED only
    // by its claimant (apply checks it), through this system's own route below
    roles: { reportReaders: MANAGERS, reportRunners: ['admin'], proposalReviewers: ['admin'], admins: ['admin'] },
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
    const token = newToken('ecs')
    const s = { sessionId: randomUUID(), userId: u.id, expiresAt: new Date(now().getTime() + SESSION_TTL_MS), revoked: false }
    data.sessions.set(sha256(token), s)
    return { status: 200, body: { ok: true, user: { id: u.id, role: u.role } }, headers: { 'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000) } }
  })

  // The sign-in page (the agent-settings plugin's look): this system has no sign-in screen of its own (it posts to /api/auth/login).
  router.add('GET', '/login', POLICY.PUBLIC, async ({ req, res, query }) => {
    const page = signInPage({ lang: query.get('lang'), acceptLanguage: req.headers['accept-language'], system: kit.manifest.system ?? {}, next: query.get('next') })
    res.writeHead(200, page.headers)
    res.end(page.html)
    return null
  })

  router.add('POST', '/api/auth/logout', HUMAN, async ({ principal }) => {
    for (const s of data.sessions.values()) if (s.sessionId === principal.sessionId) s.revoked = true
    await store.revokeTicketsBySession(principal.sessionId)
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': sessionCookie('', 0) } }
  })

  router.add('GET', '/api/me', HUMAN, async ({ principal }) => {
    const u = data.users.get(principal.user.id)
    return { status: 200, body: { ok: true, user: { id: u.id, loginId: u.loginId, displayName: u.displayName, role: u.role, managerId: u.managerId } } }
  })

  router.add('GET', '/api/expense-claims', kit.readToolPolicy('GET /api/expense-claims', [...ROLES]), async ({ principal, query }) => {
    const status = query.get('status') ?? 'all'
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) fail(400, 'invalid_status')
    const list = [...data.claims.values()].filter(visibleTo(principal.user)).filter((c) => status === 'all' || c.status === status)
    return { status: 200, body: { ok: true, claims: list.map(claimJson) } }
  })

  router.add('GET', '/api/expense-claims/waiting', kit.readToolPolicy('GET /api/expense-claims/waiting', MANAGERS), async ({ principal }) => ({
    status: 200,
    body: {
      ok: true,
      claims: [...data.claims.values()].filter((c) => waitedTooLong(c) && visibleTo(principal.user)(c)).map((c) => ({
        id: c.id, claimantUserId: c.claimantUserId, submittedOn: c.submittedOn, daysWaiting: daysSince(c.createdAt),
        requiredRole: data.approvals.get(c.approvalId).requiredRole, yourDecision: mayDecide(data.approvals.get(c.approvalId), principal.user),
      })),
    },
  }))

  router.add('POST', '/api/expense-claims', HUMAN, async ({ principal, body }) => ({ status: 201, body: { ok: true, ...(await submitClaim(principal.user, body ?? {})) } }))

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

  // the AI's corrections of one claim (people only: whoever may see the claim sees its open corrections)
  const correctionsOf = async (claimId) => (await store.listProposals({ kind: 'expense_correct_claim', status: 'pending_review', limit: 200 }))
    .filter((p) => p.payload?.claimId === claimId)
  router.add('GET', '/api/expense-claims/:claimId/corrections', HUMAN, async ({ principal, params }) => {
    const c = data.claims.get(params.claimId)
    if (!c || !visibleTo(principal.user)(c)) fail(404, 'claim_not_found')
    const list = await correctionsOf(c.id)
    return { status: 200, body: { ok: true, corrections: list.map((p) => ({ id: p.id, status: p.status, payload: p.payload, createdAt: p.createdAt ?? null })) } }
  })

  /** The claimant accepts or rejects an AI correction of their own claim (people only; nobody else decides it). */
  router.add('POST', '/api/expense-claims/:claimId/corrections/:proposalId/decision', HUMAN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['action'])
    if (!['accept', 'reject'].includes(b.action)) fail(400, 'invalid_action')
    const c = data.claims.get(params.claimId)
    if (!c || !visibleTo(principal.user)(c)) fail(404, 'claim_not_found')
    if (c.claimantUserId !== principal.user.id) fail(403, 'not_the_claimant')
    if (!UUID_RE.test(params.proposalId)) fail(404, 'correction_not_found')
    return store.tx(async (t) => {
      const p = await t.getProposal(params.proposalId)
      if (!p || p.kind !== 'expense_correct_claim' || p.payload?.claimId !== c.id) fail(404, 'correction_not_found')
      if (p.status !== 'pending_review') fail(409, `already_${p.status}`)
      if (b.action === 'accept') await hooks.proposalKinds.expense_correct_claim.apply(p.payload, principal.user, kit.ctx(t), p)
      const updated = await t.decideProposal(p.id, { status: b.action === 'accept' ? 'accepted' : 'rejected', decidedBy: principal.user.id, comment: null })
      await t.audit({ actor: principal.user.id, action: `proposal.${b.action}`, target: p.id })
      return { status: 200, body: { ok: true, correction: { id: updated.id, status: updated.status }, claim: claimJson(c) } }
    })
  })

  const checkManager = (managerId, selfId = null) => {
    if (managerId === null) return
    const m = typeof managerId === 'string' && data.users.get(managerId)
    if (!m || !m.active || !MANAGERS.includes(m.role) || m.id === selfId) fail(400, 'invalid_manager')
  }

  router.add('POST', '/api/admin/users', ADMIN, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['loginId', 'password', 'role', 'displayName', 'managerId'])
    if (typeof b.loginId !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(b.loginId)) fail(400, 'invalid_login_id')
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) fail(400, 'invalid_password')
    if (!ROLES.includes(b.role)) fail(400, 'invalid_role')
    if (typeof b.displayName !== 'string' || !b.displayName.trim() || b.displayName.length > 60) fail(400, 'invalid_display_name')
    checkManager(b.managerId ?? null)
    if ([...data.users.values()].some((u) => u.loginId === b.loginId)) fail(409, 'login_id_taken')
    const u = await createUser({ ...b, managerId: b.managerId ?? null })
    return { status: 201, body: { ok: true, user: { id: u.id, loginId: u.loginId, role: u.role, active: u.active, managerId: u.managerId } } }
  })

  router.add('PATCH', '/api/admin/users/:userId', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['active', 'managerId'])
    if (b.active === undefined && b.managerId === undefined) fail(400, 'nothing_to_change')
    if (b.active !== undefined && typeof b.active !== 'boolean') fail(400, 'invalid_active')
    const u = data.users.get(params.userId)
    if (!u) fail(404, 'user_not_found')
    if (b.managerId !== undefined) {
      checkManager(b.managerId, u.id)
      u.managerId = b.managerId
    }
    if (b.active !== undefined) {
      if (u.id === principal.user.id && b.active === false) fail(422, 'cannot_deactivate_self')
      u.active = b.active
      // deactivation ends the employee's sessions and delegations at once (the kit re-checks hooks.employees on every use)
      if (!u.active) {
        for (const s of data.sessions.values()) if (s.userId === u.id) s.revoked = true
        await store.revokeDelegationsByUser(u.id)
      }
    }
    return { status: 200, body: { ok: true, user: { ...employee(u), managerId: u.managerId } } }
  })

  router.add('POST', '/api/admin/waiting-scan', ADMIN, async ({ body }) => {
    strictKeys(body ?? {}, [])
    return { status: 200, body: { ok: true, created: await scanWaiting() } }
  })

  // ── knowledge: the expense rules, searched with the asker's own rights ─────────────────────────────────────────────
  // Indexed at start (and again by rebuildKnowledge). Every chunk passes the same personal-data check as long-term memory
  // before it enters the index: bridgePiiScreen = POST /bridge/v1/pii-scan (protocol shapes + hooks.piiScan, names of the roster).
  // The AI reaches it only through a delegation, and only for the roles of the manifest tool on GET /bridge/v1/knowledge/search.
  const baseDocuments = await readKnowledgeDir(knowledgeDir)
  const screen = bridgePiiScreen({ hooks, ctx: () => kit.ctx() })
  const buildIndex = (documents, options = {}) => buildKnowledgeIndex(documents, {
    roles: kit.declaredRoles, routes: kit.manifest.web?.routes ?? null, screen, ...options,
  })
  const gateway = dsh ? createDshGateway({
    target: dsh.target,
    mountPath: '/dsh',
    getSessionUser: async (req) => (await hooks.authenticate(req))?.user ?? null,
    isAllowed: (u) => u?.role === 'admin',
    launchToken: dsh.launchToken,
    logger: { info() {}, warn: (...m) => log('[dsh-gateway]', ...m), error: (...m) => log('[dsh-gateway]', ...m) },
  }) : null
  // the settings plugin builds the knowledge service (BM25F / RAG / knowledge graph, by its settings) and serves /agent-settings;
  // the knowledge options are the same object evals/run.mjs uses
  await agent.register(bridge, {
    baseDocuments, buildIndex, webBase, knowledgeOptions: { ...KNOWLEDGE_OPTIONS, ...knowledgeOptions }, screen,
    gateway: gateway ? { rpcBase: '/dsh/api/dsh-im' } : null,
  })
  const knowledge = agent.knowledge
  registerKnowledge(bridge, knowledge)
  /** Rebuilds the index (documents added or changed; e.g. a document for one employee: visibility { users: [id] }). */
  async function rebuildKnowledge(extraDocuments = [], options = {}) {
    const index = await buildIndex([...baseDocuments, ...extraDocuments], options)
    await knowledge.setIndex(index)
    return index
  }

  // ── graph: the direct relations of one object, IDs and types only (GET /bridge/v1/graph/neighbors) ─────────────────────
  // The same rules as the screens: staff see their own claims, managers their own and their team's, administrators all; an
  // approval is visible with its claim. An object the asker may not see answers 404 like one that does not exist.
  const graphHooks = {
    canRead: async ({ entity, id }, asker) => {
      if (entity === 'expense_claim') return visibleTo(asker)(data.claims.get(id))
      if (entity === 'approval') {
        const a = data.approvals.get(id)
        return Boolean(a && a.subjectType === 'expense_claim' && visibleTo(asker)(data.claims.get(a.subjectId)))
      }
      return false
    },
    neighbors: async ({ entity, id }) => {
      if (entity === 'expense_claim') {
        const c = data.claims.get(id)
        // the claimant is "requested_by" (the relation explainReach turns into "You made it")
        return [{ relation: 'requested_by', entity: 'employee', id: c.claimantUserId }, { relation: 'approval', entity: 'approval', id: c.approvalId }]
      }
      const a = data.approvals.get(id)
      return [
        { relation: 'subject', entity: a.subjectType, id: a.subjectId },
        { relation: 'requested_by', entity: 'employee', id: a.requestedBy },
        { relation: 'required_role', entity: 'role', id: a.requiredRole },
        ...(a.assignedTo ? [{ relation: 'assigned_to', entity: 'employee', id: a.assignedTo }] : []),
        ...(a.decidedBy ? [{ relation: 'decided_by', entity: 'employee', id: a.decidedBy }] : []),
      ]
    },
  }
  registerGraph(bridge, graphHooks)

  // The handbook screen the sources link to: the sections this employee may read, nothing else (404 for a document that does
  // not exist AND for one the employee may not read: the screen does not tell them apart). People only, like every screen.
  const escape = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
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

  // a browser without a session on a screen goes to /login (and back); the DSH gateway's paths; then the Bridge
  const handler = async (req, res) => {
    if (await redirectToSignIn(req, res, { authenticate: hooks.authenticate })) return
    if (gateway && await gateway.handleRequest(req, res)) return
    return bridge.handler(req, res)
  }
  return { ...bridge, handler, kit, router, store, data, createUser, submitClaim, scanWaiting, mayDecide, knowledge, rebuildKnowledge, agent, gateway }
}

/** A running instance (server.mjs, the tests). */
export async function startServer({ port = 0, host = '127.0.0.1', ...options }) {
  const app = await createExpenseApp(options)
  const http = await listen(app.handler, { port, host })
  return { app, base: http.base, stop: http.stop }
}
