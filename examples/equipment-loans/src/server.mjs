#!/usr/bin/env node
// Starts equipment-loans with fictional seed data (memory store: everything is gone after a restart).
//
//   LOANS_PORT (19760) · LOANS_HOST (127.0.0.1) · LOANS_SERVICE_TOKEN / LOANS_BFF_SECRET (dev values unless NODE_ENV=production)
//   LOANS_SEED_PASSWORD (dev default: loans-dev) — the password of the four fictional employees
//   LOANS_WEB_URL (default http://<host>:<port>) — the business web's URL in knowledge sources
import { randomBytes } from 'node:crypto'
import { addDays, todayIn } from '@dsh-bridge/server-kit'
import { startServer } from './app.mjs'

const env = process.env
const production = env.NODE_ENV === 'production'
const secret = (name, dev) => {
  if (env[name]) return env[name]
  if (production) throw new Error(`${name} is required with NODE_ENV=production`)
  return dev
}
const serviceToken = secret('LOANS_SERVICE_TOKEN', 'loans-dev-service-token-000000000000')
const bffSecret = secret('LOANS_BFF_SECRET', 'loans-dev-bff-secret-0000000000000000')
const seedPassword = env.LOANS_SEED_PASSWORD || (production ? randomBytes(18).toString('base64url') : 'loans-dev')

const port = Number(env.LOANS_PORT || 19760)
const host = env.LOANS_HOST || '127.0.0.1'
const webBase = env.LOANS_WEB_URL || `http://${host}:${port}`
const server = await startServer({ port, host, webBase, serviceToken, bffSecret, log: console.log })
const { app } = server

// fictional employees (role labels, no names), a small catalog, one long loan waiting for approval, one loan already overdue
const users = {}
for (const [loginId, role, displayName] of [['admin', 'admin', 'Admin One'], ['manager', 'manager', 'Manager One'], ['staff1', 'staff', 'Staff One'], ['staff2', 'staff', 'Staff Two']]) {
  users[loginId] = await app.createUser({ loginId, password: seedPassword, role, displayName })
}
const items = {}
for (const [assetTag, kind, highValue] of [['LAP-001', 'laptop', false], ['LAP-002', 'laptop', false], ['LAP-900', 'laptop', true], ['PRJ-001', 'projector', false], ['CAM-001', 'camera', true]]) {
  items[assetTag] = app.createItem({ assetTag, kind, highValue })
}
const today = todayIn('UTC')
await app.requestLoan(users.staff1, { itemId: items['LAP-001'].id, startsOn: addDays(today, 3), dueOn: addDays(today, 16) })
const { loan } = await app.requestLoan(users.staff2, { itemId: items['PRJ-001'].id, startsOn: today, dueOn: addDays(today, 2) })
Object.assign(app.data.loans.get(loan.id), { startsOn: addDays(today, -5), dueOn: addDays(today, -2) }) // time passed: overdue

console.log(`equipment-loans on ${server.base} — employees admin / manager / staff1 / staff2${env.LOANS_SEED_PASSWORD || production ? '' : ' (password loans-dev)'}`)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await server.stop(); process.exit(0) })
