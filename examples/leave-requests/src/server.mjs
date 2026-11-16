#!/usr/bin/env node
// Starts leave-requests with fictional seed data (memory store: everything is gone after a restart).
//
//   LEAVE_PORT (19750) · LEAVE_HOST (127.0.0.1) · LEAVE_SERVICE_TOKEN / LEAVE_BFF_SECRET (dev values unless NODE_ENV=production)
//   LEAVE_SEED_PASSWORD (dev default: leave-dev) — the password of the four fictional employees
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
const serviceToken = secret('LEAVE_SERVICE_TOKEN', 'leave-dev-service-token-000000000000')
const bffSecret = secret('LEAVE_BFF_SECRET', 'leave-dev-bff-secret-0000000000000000')
const seedPassword = env.LEAVE_SEED_PASSWORD || (production ? randomBytes(18).toString('base64url') : 'leave-dev')

const server = await startServer({ port: Number(env.LEAVE_PORT || 19750), host: env.LEAVE_HOST || '127.0.0.1', serviceToken, bffSecret, log: console.log })
const { app } = server

// fictional employees and one request that has already waited 3 days (the first unanswered-scan reports it)
const users = {}
for (const [loginId, role, displayName] of [['admin', 'admin', 'Avery Admin'], ['manager', 'manager', 'Morgan Manager'], ['staff1', 'staff', 'Sam Staff'], ['staff2', 'staff', 'Riley Staff']]) {
  users[loginId] = await app.createUser({ loginId, password: seedPassword, role, displayName })
}
const today = todayIn('UTC')
const { leaveRequest } = await app.requestLeave(users.staff1, { startsOn: addDays(today, 10), endsOn: addDays(today, 12) })
app.data.leave.get(leaveRequest.id).createdAt = new Date(Date.now() - 3 * 86_400_000)

console.log(`leave-requests on ${server.base} — employees admin / manager / staff1 / staff2${env.LEAVE_SEED_PASSWORD || production ? '' : ' (password leave-dev)'}`)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await server.stop(); process.exit(0) })
