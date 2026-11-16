// PostgreSQL helpers: database lifecycle (create / drop, with a guard list), transactions and an ordered migration runner.
// `pg` is loaded lazily, so the kit can be used with the memory store without installing it.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let pgModule = null
/** The `pg` module (peer dependency of @dsh-bridge/server-kit when the PostgreSQL store is used). */
export async function loadPg() {
  if (!pgModule) {
    try { pgModule = (await import('pg')).default } catch (error) {
      throw new Error(`the PostgreSQL store needs the "pg" package (pnpm add pg): ${error.message}`)
    }
  }
  return pgModule
}

export function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

/** Database names never created, reset or dropped by these helpers (maintenance databases). Apps add their own. */
export const MAINTENANCE_DATABASES = Object.freeze(['postgres', 'template0', 'template1'])

function checkName(name, protectedNames) {
  if ([...MAINTENANCE_DATABASES, ...protectedNames].includes(name)) throw new Error(`refusing to touch the database "${name}" (protected)`)
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsupported database name "${name}"`)
}

async function withMaintenance(url, fn) {
  const pg = await loadPg()
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

/** Creates the database when it does not exist. -> true when created */
export async function ensureDatabase(url, { protectedNames = [] } = {}) {
  const name = databaseName(url)
  checkName(name, protectedNames)
  return withMaintenance(url, async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name])
    if (rowCount) return false
    await client.query(`create database ${name}`)
    return true
  })
}

/** Drops a database (tests: their own temporary database). Only names matching `allow` (default /_test$/) are dropped. */
export async function dropDatabase(url, { protectedNames = [], allow = /_test$/ } = {}) {
  const name = databaseName(url)
  checkName(name, protectedNames)
  if (!allow.test(name)) throw new Error(`refusing to drop "${name}": only databases matching ${allow} are dropped`)
  return withMaintenance(url, async (client) => {
    await client.query(`drop database if exists ${name} with (force)`)
  })
}

export async function createPool(url, { max = 10 } = {}) {
  const pg = await loadPg()
  return new pg.Pool({ connectionString: url, max })
}

/** Runs fn(client) in one transaction. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Reads `NNN_name.sql` files of a directory (URL or path) in name order -> [{ id, sql }]. */
export function readMigrations(dir) {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir
  return readdirSync(path).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(`${path}/${f}`, 'utf8') }))
}

/** The kit's own migrations (the Bridge tables). */
export const bridgeMigrations = () => readMigrations(new URL('./migrations/', import.meta.url))

/**
 * Applies the migrations not applied yet, in order, each in its own transaction, under an advisory lock (several
 * instances may start at once). Applied ids are recorded in `table`. -> ids applied now
 */
export async function migrate(pool, { migrations, table = 'bridge_migration', lockKey = 1972_0101 } = {}) {
  if (!Array.isArray(migrations)) throw new TypeError('migrate(pool, { migrations: [{ id, sql }] })')
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`invalid migration table "${table}"`)
  const client = await pool.connect()
  const applied = []
  try {
    await client.query('select pg_advisory_lock($1)', [lockKey])
    await client.query(`create table if not exists ${table} (id text primary key, applied_at timestamptz not null default now())`)
    const done = new Set((await client.query(`select id from ${table}`)).rows.map((r) => r.id))
    for (const m of migrations) {
      if (done.has(m.id)) continue
      await client.query('begin')
      try {
        await client.query(m.sql)
        await client.query(`insert into ${table} (id) values ($1)`, [m.id])
        await client.query('commit')
        applied.push(m.id)
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw new Error(`migration ${m.id} failed: ${error.message}`)
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [lockKey]).catch(() => {})
    client.release()
  }
  return applied
}
