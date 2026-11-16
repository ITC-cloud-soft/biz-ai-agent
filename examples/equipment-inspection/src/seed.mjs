// Fictional data for `pnpm start` on an EMPTY database: four employees (placeholder names) and five pieces of equipment,
// one of them overdue so the first scan emits inspection.overdue. Dev passwords only (EQUIPMENT_SEED_PASSWORD).
import { addDays, todayIn } from '@dsh-bridge/server-kit'

export const SEED_USERS = Object.freeze([
  { loginId: 'admin', role: 'admin', displayName: '管理者 サンプル' },
  { loginId: 'manager', role: 'manager', displayName: '責任者 サンプル' },
  { loginId: 'inspector1', role: 'inspector', displayName: '点検員 A' },
  { loginId: 'inspector2', role: 'inspector', displayName: '点検員 B' },
])

export async function seedIfEmpty({ pool, auth, password, timeZone = 'Asia/Tokyo' }) {
  const { rows } = await pool.query('select count(*)::int as n from app_user')
  if (rows[0].n > 0) return false
  const users = {}
  for (const u of SEED_USERS) users[u.loginId] = await auth.createUser(pool, { ...u, password })
  const today = todayIn(timeZone)
  const equipment = [
    ['FE-001', '消火器', '1F 東廊下', 'fire', 180, addDays(today, 30), users.inspector1.id],
    ['FE-002', '消火器', '2F 西廊下', 'fire', 180, addDays(today, -3), users.inspector1.id],
    ['EL-001', '非常灯', '階段 A', 'lighting', 90, addDays(today, 10), users.inspector2.id],
    ['AED-001', 'AED', '1F 受付', 'medical', 30, addDays(today, 2), users.inspector2.id],
    ['WH-001', '給湯器', '厨房', 'utility', 365, addDays(today, 120), null],
  ]
  for (const [code, name, location, category, interval, due, assignee] of equipment) {
    await pool.query(
      'insert into equipment (code, name, location, category, interval_days, next_due_on, assignee_user_id) values ($1, $2, $3, $4, $5, $6, $7)',
      [code, name, location, category, interval, due, assignee],
    )
  }
  return true
}
