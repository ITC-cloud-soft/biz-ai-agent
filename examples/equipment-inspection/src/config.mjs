// Configuration of the equipment-inspection example (environment variables only; no secrets in the repository).
//
//   EQUIPMENT_PORT / EQUIPMENT_HOST          HTTP port / bind address (default 19730 / 127.0.0.1)
//   EQUIPMENT_DATABASE_URL                   PostgreSQL URL (required, e.g. postgres://<user>:<password>@127.0.0.1:5432/equipment_inspection)
//                                            DATABASE_URL is deliberately NOT read (it may point at another system's database).
//   EQUIPMENT_SERVICE_TOKEN                  x-service-token of the AI plane (DSH)   -- a dev default below, refused in production
//   EQUIPMENT_BFF_SECRET                     x-bff-secret of the business web BFF    -- a dev default below, refused in production
//   EQUIPMENT_PERSONAL_BOT_PLATFORMS         comma separated platforms with personal bots (default: the kit's PERSONAL_BOT_PLATFORMS)
//   EQUIPMENT_SCHEDULER / EQUIPMENT_SEED     0 disables the in-process scheduler / the fictional seed on an empty database
//   EQUIPMENT_SEED_PASSWORD                  password of the seeded users (dev default "equipment-dev")
//   EQUIPMENT_LINK_GLOBAL_MAX_FAILURES       global wrong-link-code budget per 10 minutes (default 1000)
//   EQUIPMENT_CONNECTOR_KEY                  key material (32+ characters) sealing the external connectors' API keys -- a dev default below, refused in production
//   EQUIPMENT_CONNECTOR_ALLOW_LOCALHOST      1 = external connectors may call http://localhost (development only, never in production)
import { databaseName } from '@dsh-bridge/server-kit'

/** Databases of other systems on the same PostgreSQL that this example never uses, creates or drops. */
export const PROTECTED_DATABASES = Object.freeze(['care', 'care_ui', 'care_test', 'care_joint', 'bridge_demo', 'bridge_demo_test'])

const DEV_SERVICE_TOKEN = 'equipment-dev-service-token-0000000000'
const DEV_BFF_SECRET = 'equipment-dev-bff-secret-000000000000'
const DEV_CONNECTOR_KEY = 'equipment-dev-connector-key-00000000000'
export const isDevSecret = (v) => v === DEV_SERVICE_TOKEN || v === DEV_BFF_SECRET

export function loadConfig(env = process.env) {
  const databaseUrl = env.EQUIPMENT_DATABASE_URL
  if (!databaseUrl) throw new Error('EQUIPMENT_DATABASE_URL is required (postgres://<user>:<password>@<host>:5432/equipment_inspection)')
  const name = databaseName(databaseUrl)
  if (PROTECTED_DATABASES.includes(name) || ['postgres', 'template0', 'template1'].includes(name)) {
    throw new Error(`equipment-inspection refuses to use the database "${name}" (it belongs to another system)`)
  }
  const production = env.NODE_ENV === 'production'
  if (production && (!env.EQUIPMENT_SERVICE_TOKEN || !env.EQUIPMENT_BFF_SECRET || !env.EQUIPMENT_CONNECTOR_KEY)) {
    throw new Error('EQUIPMENT_SERVICE_TOKEN, EQUIPMENT_BFF_SECRET and EQUIPMENT_CONNECTOR_KEY are required when NODE_ENV=production')
  }
  return {
    port: Number(env.EQUIPMENT_PORT || 19730),
    host: env.EQUIPMENT_HOST || '127.0.0.1',
    databaseUrl,
    serviceToken: env.EQUIPMENT_SERVICE_TOKEN || DEV_SERVICE_TOKEN,
    bffSecret: env.EQUIPMENT_BFF_SECRET ?? DEV_BFF_SECRET,
    personalBotPlatforms: env.EQUIPMENT_PERSONAL_BOT_PLATFORMS ? String(env.EQUIPMENT_PERSONAL_BOT_PLATFORMS).split(',').map((s) => s.trim()).filter(Boolean) : undefined, // undefined = the kit default
    scheduler: env.EQUIPMENT_SCHEDULER !== '0',
    seed: env.EQUIPMENT_SEED !== '0',
    seedPassword: env.EQUIPMENT_SEED_PASSWORD || 'equipment-dev',
    linkGlobalMaxFailures: Number(env.EQUIPMENT_LINK_GLOBAL_MAX_FAILURES || 1000),
    orgId: 'facility-example',
    secureCookies: production,
    version: '0.1.0',
    // external connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3)
    connectorKey: env.EQUIPMENT_CONNECTOR_KEY || DEV_CONNECTOR_KEY,
    connectorAllowLocalhost: !production && env.EQUIPMENT_CONNECTOR_ALLOW_LOCALHOST === '1',
  }
}
