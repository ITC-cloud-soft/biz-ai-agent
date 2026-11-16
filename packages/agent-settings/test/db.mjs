// The database of the pgvector tests: a real PostgreSQL + pgvector server when AGENT_TEST_PG_URL is set (a test database only:
// the tables the tests use are dropped first), otherwise PGlite (PostgreSQL in-process with the pgvector extension).
//   AGENT_TEST_PG_URL=postgres://postgres:<password>@127.0.0.1:55433/agent_vectors_test npm test
export const TEST_PG_URL = process.env.AGENT_TEST_PG_URL || ''
export const DB_KIND = TEST_PG_URL ? 'postgresql' : 'pglite'

export async function testDb({ tables = [] } = {}) {
  if (TEST_PG_URL) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: TEST_PG_URL, max: 4 })
    for (const t of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`bad table ${t}`)
      await pool.query(`DROP TABLE IF EXISTS ${t}`)
    }
    return { db: pool, close: () => pool.end() }
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const { vector } = await import('@electric-sql/pglite/vector')
  const db = await PGlite.create({ extensions: { vector } })
  return { db, close: () => db.close() }
}
