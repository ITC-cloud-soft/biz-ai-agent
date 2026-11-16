#!/usr/bin/env node
// equipment-inspection: a small business system (備品・設備点検) that speaks Bridge protocol v1 through @dsh-bridge/server-kit.
//   pnpm --filter @dsh-bridge/example-equipment-inspection start      (http://127.0.0.1:19730, database equipment_inspection)
import { startScheduler } from '@dsh-bridge/server-kit'
import { startServer } from './app.mjs'
import { isDevSecret, loadConfig } from './config.mjs'
import { seedIfEmpty } from './seed.mjs'

const config = loadConfig()
const instance = await startServer({ config })
const { kit, auth, domain, manifestInfo } = instance.app
if (config.seed && await seedIfEmpty({ pool: instance.pool, auth, password: config.seedPassword, timeZone: kit.timeZone })) {
  console.log('[equipment] seeded fictional users: admin / manager / inspector1 / inspector2 (password: EQUIPMENT_SEED_PASSWORD, dev default "equipment-dev")')
}
const stopScheduler = config.scheduler
  ? startScheduler({ kit, tasks: [{ name: 'overdue-scan', everyMinutes: 5, run: async () => {
    const created = await domain.scanOverdue()
    if (created.length) console.log(`[equipment] overdue scan: ${created.length} inspection.overdue event(s)`)
  } }, { name: 'connector-rules', everyMinutes: 1, run: () => kit.connectors.tick() }], log: console.log })
  : () => {}
console.log(`[equipment] ${manifestInfo.manifest.system.name} (${manifestInfo.manifest.system.id}) on ${instance.base}`)
console.log(`[equipment]   self-service SNS linking: ${instance.base}/`)
console.log(`[equipment]   Bridge v1: ${instance.base}/bridge/v1/health, manifest etag ${manifestInfo.etag}`)
if (isDevSecret(config.serviceToken) || isDevSecret(config.bffSecret)) console.log('[equipment]   using the DEV service token / BFF secret (set EQUIPMENT_SERVICE_TOKEN / EQUIPMENT_BFF_SECRET)')

const shutdown = async () => {
  stopScheduler()
  await instance.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
