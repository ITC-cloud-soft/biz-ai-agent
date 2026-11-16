// MySQL 8 / TiDB helpers: the pool (TLS, UTC), database lifecycle (create / drop, with a guard list), transactions and an
// ordered migration runner serialised across processes (GET_LOCK). `mysql2` is loaded lazily, so the kit can be used with
// the memory or PostgreSQL store without installing it.
import { databaseName, readMigrations } from './pg.mjs'

let mysqlModule = null
/** The `mysql2/promise` module (peer dependency of @dsh-bridge/server-kit when the MySQL / TiDB store is used). */
export async function loadMysql() {
  if (!mysqlModule) {
    try { mysqlModule = (await import('mysql2/promise')).default } catch (error) {
      throw new Error(`the MySQL / TiDB store needs the "mysql2" package (pnpm add mysql2): ${error.message}`)
    }
  }
  return mysqlModule
}

/** Database names never created, reset or dropped by these helpers (system schemas of MySQL and TiDB). Apps add their own. */
export const MYSQL_SYSTEM_DATABASES = Object.freeze(['mysql', 'information_schema', 'performance_schema', 'sys', 'test', 'metrics_schema'])

const NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function checkName(name, protectedNames) {
  const lower = name.toLowerCase()
  if ([...MYSQL_SYSTEM_DATABASES, ...protectedNames.map((n) => n.toLowerCase())].includes(lower)) throw new Error(`refusing to touch the database "${name}" (protected)`)
  if (!NAME_RE.test(name)) throw new Error(`unsupported database name "${name}"`)
}

/**
 * mysql://user:password@host:port/database[?ssl=false] -> mysql2 connection options. TLS (TLS 1.2+, the server certificate
 * verified against the system CAs) unless the host is localhost / 127.0.0.1 / ::1, or the URL says ?ssl=false (a plain
 * MySQL on a private network). ?ssl=true forces TLS on localhost too. Times are UTC (`timezone: 'Z'`).
 */
export function mysqlConnectionOptions(url, { database } = {}) {
  const u = new URL(url)
  if (!/^mysql2?:$/.test(u.protocol)) throw new Error('a mysql:// URL is required')
  const ssl = u.searchParams.get('ssl')
  const tls = ssl === 'false' ? false : ssl === 'true' ? true : !LOCAL_HOSTS.has(u.hostname)
  const db = database === undefined ? databaseName(url) : database
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ...(db ? { database: db } : {}),
    ...(tls ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
  }
}

const UTC_SESSION = `set time_zone = '+00:00'`

async function withAdmin(url, fn) {
  const mysql = await loadMysql()
  const conn = await mysql.createConnection(mysqlConnectionOptions(url, { database: null }))
  try { return await fn(conn) } finally { await conn.end().catch(() => {}) }
}

/** Creates the database (utf8mb4, utf8mb4_bin) when it does not exist. -> true when created */
export async function ensureMysqlDatabase(url, { protectedNames = [] } = {}) {
  const name = databaseName(url)
  checkName(name, protectedNames)
  return withAdmin(url, async (conn) => {
    const [rows] = await conn.query('select schema_name from information_schema.schemata where schema_name = ?', [name])
    if (rows.length) return false
    await conn.query(`create database if not exists \`${name}\` character set utf8mb4 collate utf8mb4_bin`)
    return true
  })
}

/** Drops a database (tests: their own temporary database). Only names matching `allow` (default /_test$/) are dropped. */
export async function dropMysqlDatabase(url, { protectedNames = [], allow = /_test$/ } = {}) {
  const name = databaseName(url)
  checkName(name, protectedNames)
  if (!allow.test(name)) throw new Error(`refusing to drop "${name}": only databases matching ${allow} are dropped`)
  return withAdmin(url, async (conn) => {
    await conn.query(`drop database if exists \`${name}\``)
  })
}

/**
 * A mysql2/promise pool for the URL (see mysqlConnectionOptions): TLS unless local, `timezone: 'Z'`, and the session
 * time_zone set to '+00:00' on every new connection (DATETIME defaults and NOW() are UTC).
 */
export async function createMysqlPool(url, { max = 10 } = {}) {
  const mysql = await loadMysql()
  const pool = mysql.createPool({ ...mysqlConnectionOptions(url), connectionLimit: max, waitForConnections: true, enableKeepAlive: true })
  // queued before any query of the new connection; a connection that cannot be set to UTC is not used
  pool.pool.on('connection', (conn) => { conn.query(UTC_SESSION, (error) => { if (error) conn.destroy() }) })
  return pool
}

/** Runs fn(conn) in one transaction on a connection of the pool (a mysql2/promise pool). */
export async function withMysqlTransaction(pool, fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (error) {
    await conn.rollback().catch(() => {})
    throw error
  } finally {
    conn.release()
  }
}

/**
 * Splits a migration file into statements: `--` comment lines are dropped, a statement ends with ";" at the end of a
 * line. (Write one statement per ";"-terminated block; no ";" at a line end inside string literals.)
 */
export function splitSqlStatements(sql) {
  const body = sql.split(/\r?\n/).filter((line) => !/^\s*--/.test(line)).join('\n')
  return body.split(/;[ \t]*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)
}

// ER_TABLE_EXISTS_ERROR, ER_DUP_FIELDNAME, ER_DUP_KEYNAME, ER_FK_DUP_NAME
const ALREADY_THERE = new Set([1050, 1060, 1061, 1826])

/** The kit's own migrations (the Bridge tables, MySQL / TiDB dialect). Same ids as the PostgreSQL ones. */
export const bridgeMysqlMigrations = () => readMigrations(new URL('./migrations-mysql/', import.meta.url))

/**
 * Applies the migrations not applied yet, in order, under a named lock (GET_LOCK, per database and table: several instances
 * may start at once). Applied ids are recorded in `table`. MySQL / TiDB commit every DDL statement by itself, so a migration
 * is not atomic: when one stopped half-way, the next run executes it again and skips the statements whose object is already
 * there (table / column / index / foreign key exists). Prefer `create table if not exists` and `insert ignore` for seeds.
 * -> ids applied now
 */
export async function migrateMysql(pool, { migrations, table = 'bridge_migration', lockTimeoutSeconds = 120 } = {}) {
  if (!Array.isArray(migrations)) throw new TypeError('migrateMysql(pool, { migrations: [{ id, sql }] })')
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error(`invalid migration table "${table}"`)
  const conn = await pool.getConnection()
  const lockName = `left(concat('fw_migrate:', coalesce(database(), ''), '.', ?), 64)`
  const applied = []
  let locked = false
  try {
    const [[got]] = await conn.query(`select get_lock(${lockName}, ?) as ok`, [table, lockTimeoutSeconds])
    if (Number(got.ok) !== 1) throw new Error(`migrate: the migration lock of "${table}" was not obtained within ${lockTimeoutSeconds} s`)
    locked = true
    await conn.query(`create table if not exists \`${table}\` (id varchar(191) not null primary key, applied_at datetime(6) not null default current_timestamp(6))
      engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin`)
    const [rows] = await conn.query(`select id from \`${table}\``)
    const done = new Set(rows.map((r) => r.id))
    for (const m of migrations) {
      if (done.has(m.id)) continue
      try {
        for (const statement of splitSqlStatements(m.sql)) {
          try { await conn.query(statement) } catch (error) {
            if (!ALREADY_THERE.has(error?.errno)) throw error // a re-run of a migration that stopped half-way: that object is in place
          }
        }
        await conn.query(`insert into \`${table}\` (id) values (?)`, [m.id])
        applied.push(m.id)
      } catch (error) {
        throw new Error(`migration ${m.id} failed: ${error.message}`)
      }
    }
  } finally {
    if (locked) await conn.query(`select release_lock(${lockName})`, [table]).catch(() => {})
    conn.release()
  }
  return applied
}
