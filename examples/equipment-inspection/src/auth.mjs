// The business system's own users and sessions (the kit only asks: who is this request? is this session live?).
//   web session: cookie eq_session (HttpOnly, SameSite=Strict)   device session: Authorization: Bearer <token>
import { DUMMY_PASSWORD_HASH, hashPassword, header, newToken, sha256, UUID_RE, verifyPassword } from '@dsh-bridge/server-kit'

export const SESSION_COOKIE = 'eq_session'
export const SESSION_TTL_HOURS = 12
export const ROLES = Object.freeze(['admin', 'manager', 'inspector'])

function sessionToken(req) {
  const auth = header(req, 'authorization')
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  for (const part of String(header(req, 'cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='))
  }
  return null
}

export function createAuth({ pool, secureCookies = false }) {
  /** hooks.authenticate: the employee's own session (active employees only). */
  async function authenticate(req) {
    const token = sessionToken(req)
    if (!token) return null
    const { rows } = await pool.query(
      `select s.id as session_id, u.id, u.role from app_session s join app_user u on u.id = s.user_id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.active`, [sha256(token)],
    )
    return rows[0] ? { user: { id: rows[0].id, role: rows[0].role }, sessionId: rows[0].session_id } : null
  }

  /** hooks.isSessionLive: delegations of the web assistant die with the web session. */
  async function isSessionLive(sessionId, ctx = {}) {
    if (!UUID_RE.test(String(sessionId))) return false
    const db = ctx.db ?? pool
    const { rowCount } = await db.query('select 1 from app_session where id = $1 and revoked_at is null and expires_at > now()', [sessionId])
    return rowCount > 0
  }

  async function createUser(db, { loginId, password, role, displayName }) {
    const { rows } = await db.query(
      'insert into app_user (login_id, display_name, role, password_hash) values ($1, $2, $3, $4) returning id, login_id, role, display_name, active',
      [loginId, displayName, role, await hashPassword(password)],
    )
    return rows[0]
  }

  async function login(loginId, password) {
    const { rows } = await pool.query('select id, role, active, password_hash from app_user where login_id = $1', [loginId])
    const u = rows[0]
    // always run scrypt so the response time does not reveal whether the login id exists
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (!u || !ok || !u.active) return null
    const token = newToken('eqs')
    const s = await pool.query(
      'insert into app_session (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(hours => $3)) returning id, expires_at',
      [u.id, sha256(token), SESSION_TTL_HOURS],
    )
    return { token, user: { id: u.id, role: u.role }, sessionId: s.rows[0].id, expiresAt: new Date(s.rows[0].expires_at) }
  }

  async function logout(sessionId) {
    await pool.query('update app_session set revoked_at = now() where id = $1 and revoked_at is null', [sessionId])
  }

  const sessionCookie = (token, maxAgeSeconds) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureCookies ? '; Secure' : ''}`

  return { authenticate, isSessionLive, createUser, login, logout, sessionCookie }
}
