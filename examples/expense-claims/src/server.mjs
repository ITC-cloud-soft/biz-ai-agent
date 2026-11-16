#!/usr/bin/env node
// Starts expense-claims with fictional seed data (memory store: everything is gone after a restart).
//
//   EXPENSE_PORT (19770) · EXPENSE_HOST (127.0.0.1) · EXPENSE_SERVICE_TOKEN / EXPENSE_BFF_SECRET (dev values unless NODE_ENV=production)
//   EXPENSE_SEED_PASSWORD (dev default: expense-dev) — the password of the seven fictional employees
//   EXPENSE_WEB_URL (default http://<host>:<port>) — the business web's URL in knowledge sources
//   EXPENSE_DATA_DIR (default <example>/.data, git-ignored) — the settings plugin's data (settings, uploaded documents, vectors
//     file, knowledge graph); the employees and claims stay in memory
//   AGENT_VECTOR_DB_URL / AGENT_SETTINGS_KEY / model key variables — read by the settings plugin. In development they may sit in
//     <example>/.env.local (git-ignored; loaded only when NODE_ENV is not production)
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { addDays, todayIn } from '@dsh-bridge/server-kit'
import { startServer, TIME_ZONE } from './app.mjs'

const env = process.env
const production = env.NODE_ENV === 'production'
const localEnv = fileURLToPath(new URL('../.env.local', import.meta.url))
if (!production && existsSync(localEnv)) process.loadEnvFile(localEnv)
const secret = (name, dev) => {
  if (env[name]) return env[name]
  if (production) throw new Error(`${name} is required with NODE_ENV=production`)
  return dev
}
const serviceToken = secret('EXPENSE_SERVICE_TOKEN', 'expense-dev-service-token-0000000000')
const bffSecret = secret('EXPENSE_BFF_SECRET', 'expense-dev-bff-secret-00000000000000')
const seedPassword = env.EXPENSE_SEED_PASSWORD || (production ? randomBytes(18).toString('base64url') : 'expense-dev')

const port = Number(env.EXPENSE_PORT || 19770)
const host = env.EXPENSE_HOST || '127.0.0.1'
const webBase = env.EXPENSE_WEB_URL || `http://${host}:${port}`
const dataDir = env.EXPENSE_DATA_DIR || fileURLToPath(new URL('../.data/', import.meta.url))
const server = await startServer({ port, host, webBase, serviceToken, bffSecret, dataDir, log: console.log })
const { app } = server

// fictional employees: two administrators, two managers with their teams
const users = {}
for (const [loginId, role, displayName, manager] of [
  ['admin', 'admin', 'Avery Admin', null], ['admin2', 'admin', 'Alex Admin', null],
  ['manager', 'manager', 'Morgan Manager', 'admin'], ['manager2', 'manager', 'Casey Manager', 'admin'],
  ['staff1', 'staff', 'Sam Staff', 'manager'], ['staff2', 'staff', 'Riley Staff', 'manager'], ['staff3', 'staff', 'Jordan Staff', 'manager2'],
]) {
  users[loginId] = await app.createUser({ loginId, password: seedPassword, role, displayName, managerId: manager ? users[manager].id : null })
}
// two waiting claims: a small one (staff1's manager decides) that has waited 4 days — the first waiting-scan reminds — and a
// large one (an administrator decides)
const today = todayIn(TIME_ZONE)
const small = await app.submitClaim(users.staff1, { spentOn: addDays(today, -6), category: 'transport', amountYen: 4_800, note: 'Train to the client visit (fictional)' })
Object.assign(app.data.claims.get(small.claim.id), { createdAt: new Date(Date.now() - 4 * 86_400_000), submittedOn: addDays(today, -4) })
await app.submitClaim(users.staff3, { spentOn: addDays(today, -2), category: 'lodging', amountYen: 45_000, note: 'Two nights for the trade fair (fictional)' })

console.log(`expense-claims on ${server.base} (settings: ${server.base}/agent-settings, data ${dataDir}) — employees admin / admin2 / manager / manager2 / staff1 / staff2 / staff3${env.EXPENSE_SEED_PASSWORD || production ? '' : ' (password expense-dev)'}`)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await server.stop(); process.exit(0) })
