// Wires the equipment-inspection system on @dsh-bridge/server-kit: PostgreSQL store (bridge_* tables) + business tables,
// hooks, business routes. startServer() is used by server.mjs and by the tests.
import { fileURLToPath } from 'node:url'
import { createBridgeApp, createPool, createPostgresStore, ensureDatabase, listen, loadManifest, migrate, readMigrations } from '@dsh-bridge/server-kit'
import { createAuth } from './auth.mjs'
import { PROTECTED_DATABASES } from './config.mjs'
import { createDomain } from './domain.mjs'
import { createHooks } from './hooks.mjs'
import { createHelp } from './help.mjs'
import { registerBusiness } from './routes.mjs'

export const MANIFEST_FILE = fileURLToPath(new URL('../bridge.manifest.yaml', import.meta.url))
export const businessMigrations = () => readMigrations(new URL('./migrations/', import.meta.url))

/** Applies the business migrations and the kit's Bridge migrations (idempotent). */
export async function migrateAll(pool) {
  await migrate(pool, { migrations: businessMigrations(), table: 'app_migration', lockKey: 1973_0001 })
  await createPostgresStore({ pool }).migrate()
}

/** Builds the system on an existing (migrated) pool. -> { handler, kit, router, auth, domain, store } */
export async function createEquipmentApp({ pool, config, manifestFile = MANIFEST_FILE, log = () => {} }) {
  const store = createPostgresStore({ pool })
  const auth = createAuth({ pool, secureCookies: config.secureCookies })
  const manifestInfo = loadManifest({ file: manifestFile })
  const domainRef = {}
  const hooks = createHooks({ pool, auth, manifest: manifestInfo.manifest, domainRef })
  const bridge = await createBridgeApp({
    manifest: manifestInfo,
    store,
    serviceToken: config.serviceToken,
    bffSecret: config.bffSecret,
    orgId: config.orgId,
    service: manifestInfo.manifest.system.id,
    version: config.version,
    personalBotPlatforms: config.personalBotPlatforms,
    linkGlobalMaxFailures: config.linkGlobalMaxFailures,
    roles: { reportReaders: ['admin', 'manager'], reportRunners: ['admin'], proposalReviewers: ['admin', 'manager'], admins: ['admin'] },
    hooks,
    // how-to questions answered from manual/*.md (GET /bridge/v1/help/*, the manifest's help.tool)
    help: createHelp({ webBase: config.publicUrl ?? `http://${config.host ?? '127.0.0.1'}:${config.port ?? 19730}` }),
    // the AI employee's external connectors (routes, the proposal kind connector_write, kit.connectors.tick() in the scheduler)
    connectors: { secretKey: config.connectorKey, allowLocalhost: config.connectorAllowLocalhost === true },
    log,
  })
  const domain = createDomain({ pool, kit: bridge.kit })
  domainRef.domain = domain
  registerBusiness(bridge.router, { pool, kit: bridge.kit, auth, domain })
  return { ...bridge, auth, domain, store, manifestInfo }
}

/** Starts a full instance: database (created if missing), migrations, app, HTTP server. */
export async function startServer({ config, manifestFile, log = console.log } = {}) {
  await ensureDatabase(config.databaseUrl, { protectedNames: [...PROTECTED_DATABASES] })
  const pool = await createPool(config.databaseUrl)
  await migrateAll(pool)
  const app = await createEquipmentApp({ pool, config, manifestFile, log })
  const http = await listen(app.handler, { port: config.port, host: config.host })
  return {
    base: http.base,
    pool,
    app,
    server: http.server,
    async stop() {
      await http.stop()
      await pool.end()
    },
  }
}
