// The business web API (/api/*) and the static self-service page, on the kit's router (same gate as /bridge/v1).
// The AI's read tools (manifest.tools) are business endpoints guarded by the delegation gate:
//   delegated access = AI allow-list (kit.readToolPolicy, from manifest.tools) intersected with the employee's role.
// Every write is human-only: a delegation token gets 403 delegation_not_permitted.
import { readFileSync } from 'node:fs'
import { baseHeaders, fail, POLICY, strictKeys, UUID_RE } from '@dsh-bridge/server-kit'
import { ROLES } from './auth.mjs'

const LOGIN_FAILURES = 5 // per login id per 10 minutes
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

export function registerBusiness(router, { pool, kit, auth, domain }) {
  const { store } = kit
  const HUMAN = { allow: ['user'] }
  const MANAGERS = { allow: ['user'], roles: ['admin', 'manager'] }
  const ADMIN = { allow: ['user'], roles: ['admin'] }

  // ---------------------------------------------------------------- sessions
  router.add('POST', '/api/auth/login', POLICY.PUBLIC, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['loginId', 'password', 'mode'])
    if (typeof b.loginId !== 'string' || !b.loginId || b.loginId.length > 64 || typeof b.password !== 'string' || b.password.length > 200) fail(400, 'invalid_credentials')
    if (b.mode !== undefined && !['cookie', 'bearer'].includes(b.mode)) fail(400, 'invalid_mode')
    if (await store.countHits('login_failure', b.loginId, 10) >= LOGIN_FAILURES) fail(429, 'too_many_attempts')
    const s = await auth.login(b.loginId, b.password)
    if (!s) {
      await store.addHit('login_failure', b.loginId)
      fail(401, 'invalid_credentials')
    }
    const maxAge = Math.round((s.expiresAt.getTime() - Date.now()) / 1000)
    const out = { ok: true, user: { id: s.user.id, role: s.user.role }, expiresAt: s.expiresAt.toISOString() }
    if (b.mode === 'bearer') return { status: 200, body: { ...out, token: s.token } } // device session (mobile apps)
    return { status: 200, body: out, headers: { 'set-cookie': auth.sessionCookie(s.token, maxAge) } }
  })

  router.add('POST', '/api/auth/logout', HUMAN, async ({ principal }) => {
    await auth.logout(principal.sessionId)
    await store.revokeTicketsBySession(principal.sessionId)
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': auth.sessionCookie('', 0) } }
  })

  router.add('GET', '/api/me', HUMAN, async ({ principal }) => {
    const { rows } = await pool.query('select id, login_id, display_name, role from app_user where id = $1', [principal.user.id])
    const u = rows[0]
    return { status: 200, body: { ok: true, user: { id: u.id, loginId: u.login_id, displayName: u.display_name, role: u.role } } }
  })

  // ---------------------------------------------------------------- equipment & inspections
  router.add('GET', '/api/equipment', kit.readToolPolicy('GET /api/equipment', [...ROLES]), async ({ principal, query }) => {
    const status = query.get('status') ?? 'active'
    const overdueOnly = query.get('overdueOnly')
    if (overdueOnly !== null && !['true', 'false'].includes(overdueOnly)) fail(400, 'invalid_overdue_only')
    return { status: 200, body: { ok: true, equipment: await domain.listEquipment(principal.user, { status, overdueOnly: overdueOnly === 'true' }) } }
  })

  router.add('POST', '/api/equipment', MANAGERS, async ({ principal, body }) => ({
    status: 201, body: { ok: true, equipment: await domain.createEquipment(principal.user, body ?? {}) },
  }))

  router.add('GET', '/api/inspections/overdue', kit.readToolPolicy('GET /api/inspections/overdue', ['admin', 'manager']), async () => ({
    status: 200, body: { ok: true, ...(await domain.listOverdue()) },
  }))

  router.add('POST', '/api/inspections', HUMAN, async ({ principal, body }) => ({
    status: 201, body: { ok: true, inspection: await domain.recordInspection(principal.user, body ?? {}) },
  }))

  router.add('POST', '/api/repair-requests', HUMAN, async ({ principal, body }) => ({
    status: 201, body: { ok: true, ...(await domain.createRepairRequest(principal.user, body ?? {})) },
  }))

  // ---------------------------------------------------------------- approvals (web UI: the same rule as the IM card)
  router.add('GET', '/api/approvals', MANAGERS, async () => ({ status: 200, body: { ok: true, approvals: await domain.listPendingApprovals() } }))

  router.add('POST', '/api/approvals/:approvalId/decision', MANAGERS, async ({ principal, params, body }) => ({
    status: 200, body: { ok: true, approval: await domain.decideOnWeb(principal.user, params.approvalId, body ?? {}) },
  }))

  // ---------------------------------------------------------------- administration
  router.add('POST', '/api/admin/users', ADMIN, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['loginId', 'password', 'role', 'displayName'])
    if (typeof b.loginId !== 'string' || !/^[A-Za-z0-9._-]{3,64}$/.test(b.loginId)) fail(400, 'invalid_login_id')
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) fail(400, 'invalid_password')
    if (!ROLES.includes(b.role)) fail(400, 'invalid_role')
    if (typeof b.displayName !== 'string' || !b.displayName.trim() || b.displayName.length > 60) fail(400, 'invalid_display_name')
    if ((await pool.query('select 1 from app_user where login_id = $1', [b.loginId])).rowCount) fail(409, 'login_id_taken')
    const u = await auth.createUser(pool, b)
    await store.audit({ actor: principal.user.id, action: 'user.create', target: u.id, detail: { role: u.role } })
    return { status: 201, body: { ok: true, user: { id: u.id, loginId: u.login_id, role: u.role, active: u.active } } }
  })

  router.add('PATCH', '/api/admin/users/:userId', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['active', 'role'])
    if (b.active !== undefined && typeof b.active !== 'boolean') fail(400, 'invalid_active')
    if (b.role !== undefined && !ROLES.includes(b.role)) fail(400, 'invalid_role')
    if (!UUID_RE.test(params.userId)) fail(404, 'user_not_found')
    if (params.userId === principal.user.id && b.active === false) fail(422, 'cannot_deactivate_self')
    const { rows } = await pool.query('update app_user set active = coalesce($2, active), role = coalesce($3, role) where id = $1 returning id, role, active', [params.userId, b.active ?? null, b.role ?? null])
    if (!rows.length) fail(404, 'user_not_found')
    // deactivation ends every session, delegation and ticket of the employee (the kit checks hooks.employees on every use)
    if (rows[0].active === false) await store.revokeDelegationsByUser(params.userId)
    await store.audit({ actor: principal.user.id, action: 'user.update', target: params.userId, detail: { active: rows[0].active, role: rows[0].role } })
    return { status: 200, body: { ok: true, user: rows[0] } }
  })

  router.add('POST', '/api/admin/overdue-scan', MANAGERS, async () => ({ status: 200, body: { ok: true, created: await domain.scanOverdue() } }))

  // ---------------------------------------------------------------- the self-service page (plain HTML, no build)
  for (const [path, s] of Object.entries(STATIC)) {
    const content = readFileSync(new URL(`../public/${s.file}`, import.meta.url))
    router.add('GET', path, POLICY.PUBLIC, async ({ res }) => {
      res.writeHead(200, baseHeaders({ 'content-type': s.type, 'content-length': content.length, 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' }))
      res.end(content)
      return null
    })
  }
}
