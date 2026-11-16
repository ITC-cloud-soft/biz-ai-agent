// Test helpers: temporary databases of their own (fw_equipment_test for the conformance suite, fw_equipment_unit_test for
// domain.test.mjs: created per test file, dropped at the end) and an in-process server on an ephemeral port.
import { dropDatabase, ensureDatabase } from '@dsh-bridge/server-kit'
import { startServer } from '../src/app.mjs'
import { loadConfig, PROTECTED_DATABASES } from '../src/config.mjs'

// FW_TEST_DATABASE_URL = postgres://<user>:<password>@<host>:<port>/<any database>: only the server and credentials are used.
// Unset: the database tests are skipped (SKIP_REASON).
const SERVER_URL = process.env.FW_TEST_DATABASE_URL || ''
export const SKIP_REASON = SERVER_URL ? false : 'FW_TEST_DATABASE_URL is not set (postgres://<user>:<password>@<host>:5432/<db>): PostgreSQL tests skipped'
const withDatabase = (name) => { if (!SERVER_URL) return `postgres://unset@127.0.0.1:5432/${name}`; const u = new URL(SERVER_URL); u.pathname = `/${name}`; return u.toString() }
export const TEST_DATABASE_URL = withDatabase('fw_equipment_test')
/** The unit tests (domain.test.mjs) use a database of their own, so the two test files never share one. */
export const UNIT_DATABASE_URL = withDatabase('fw_equipment_unit_test')
export const TEST_SERVICE_TOKEN = 'equipment-test-service-token-0000000000'
export const TEST_BFF_SECRET = 'equipment-test-bff-secret-00000000000'


/** Drops and recreates the test database (only a *_test database, never a protected one). */
export async function resetTestDatabase(url = TEST_DATABASE_URL) {
  await dropDatabase(url, { protectedNames: [...PROTECTED_DATABASES] })
  await ensureDatabase(url, { protectedNames: [...PROTECTED_DATABASES] })
}

export async function dropTestDatabase(url = TEST_DATABASE_URL) {
  await dropDatabase(url, { protectedNames: [...PROTECTED_DATABASES] })
}

export async function startTestServer({ env = {}, databaseUrl = TEST_DATABASE_URL } = {}) {
  await resetTestDatabase(databaseUrl)
  const config = loadConfig({
    EQUIPMENT_PORT: '0',
    EQUIPMENT_DATABASE_URL: databaseUrl,
    EQUIPMENT_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    EQUIPMENT_BFF_SECRET: TEST_BFF_SECRET,
    EQUIPMENT_SCHEDULER: '0',
    EQUIPMENT_SEED: '0',
    ...env,
  })
  const server = await startServer({ config, log: (line) => process.stderr.write(`${line}\n`) })
  return {
    ...server,
    async stop() {
      await server.stop()
      await dropTestDatabase(databaseUrl)
    },
  }
}

/** Tiny JSON client. */
export function client(base) {
  return async function call(method, path, { headers = {}, body, query } = {}) {
    const url = new URL(`${base}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, body: json, text, headers: res.headers }
  }
}
