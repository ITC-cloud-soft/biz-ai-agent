// The pgvector store (PostgreSQL + the pgvector extension): the vectors of the knowledge chunks, and the vector search.
//
//   createPgVectorStore({ db, table? })     db = anything with query(sql, params) -> { rows }: a pg Pool / Client, PGlite …
//
// One table (default agent_vectors): (embedder, digest) → vector, where digest = SHA-256 of the chunk's embedding text — the text
// itself is never stored. The same chunk text embedded by the same model is never embedded again (also across restarts and
// processes). save() keeps only the vectors of the current chunks of that embedder.
//
// PERMISSIONS FIRST, in SQL: search() gets the digests of the asker's VISIBLE chunks and searches only among them
// (WHERE digest = ANY($visible)); a hidden chunk is never compared, never counted, never returned.
// Exact search (no ANN index): fine for thousands of chunks. With one fixed dimension an HNSW index can be added, e.g.
//   CREATE INDEX ON agent_vectors USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE dim = 1536
import { createHash } from 'node:crypto'

const TABLE_RE = /^[a-z_][a-z0-9_]{0,40}$/
const SEP = '\u0000'
export const digestOf = (text) => createHash('sha256').update(String(text)).digest('hex')
const splitKey = (key) => {
  const i = key.indexOf(SEP)
  return { embedder: key.slice(0, i), digest: digestOf(key.slice(i + 1)) }
}
const toSql = (v) => `[${Array.from(v, (x) => (Number.isFinite(x) ? x : 0)).join(',')}]`
const fromSql = (s) => Float32Array.from(JSON.parse(s))

export function createPgVectorStore({ db, table = 'agent_vectors' } = {}) {
  if (typeof db?.query !== 'function') throw new TypeError('createPgVectorStore: db with query(sql, params) is required (a pg Pool, PGlite, …)')
  if (!TABLE_RE.test(table)) throw new TypeError('createPgVectorStore: table must match [a-z_][a-z0-9_]*')
  let ready = null
  const init = () => {
    ready ??= (async () => {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector')
      await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
        embedder text NOT NULL, digest text NOT NULL, dim integer NOT NULL, embedding vector NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (embedder, digest))`)
    })().catch((error) => { ready = null; throw error })
    return ready
  }
  return {
    kind: 'pgvector',
    init,
    /** A Map-like cache for createKnowledgeService({ vectorCache }), preloaded with the stored vectors of these keys. */
    async cache(keys = []) {
      await init()
      const byEmbedder = new Map()
      for (const key of keys) {
        const { embedder, digest } = splitKey(key)
        if (!byEmbedder.has(embedder)) byEmbedder.set(embedder, new Set())
        byEmbedder.get(embedder).add(digest)
      }
      const stored = new Map()
      for (const [embedder, digests] of byEmbedder) {
        const { rows } = await db.query(`SELECT digest, embedding::text AS v FROM ${table} WHERE embedder = $1 AND digest = ANY($2::text[])`, [embedder, [...digests]])
        for (const r of rows) stored.set(`${embedder}${SEP}${r.digest}`, fromSql(r.v))
      }
      const added = new Map()
      const storedKey = (key) => { const { embedder, digest } = splitKey(key); return `${embedder}${SEP}${digest}` }
      return {
        added,
        get: (key) => added.get(key) ?? stored.get(storedKey(key)),
        set: (key, v) => { added.set(key, v) },
        has: (key) => added.has(key) || stored.has(storedKey(key)),
      }
    },
    /** Write the new vectors and drop the vectors of this embedder's chunks that no longer exist. Returns the stored count. */
    async save(cache, usedKeys) {
      await init()
      for (const [key, v] of cache.added) {
        const { embedder, digest } = splitKey(key)
        await db.query(
          `INSERT INTO ${table} (embedder, digest, dim, embedding) VALUES ($1, $2, $3, $4::vector)
           ON CONFLICT (embedder, digest) DO UPDATE SET dim = EXCLUDED.dim, embedding = EXCLUDED.embedding, updated_at = now()`,
          [embedder, digest, v.length, toSql(v)],
        )
      }
      const embedders = new Map()
      for (const key of usedKeys) {
        const { embedder, digest } = splitKey(key)
        if (!embedders.has(embedder)) embedders.set(embedder, [])
        embedders.get(embedder).push(digest)
      }
      let count = 0
      for (const [embedder, digests] of embedders) {
        await db.query(`DELETE FROM ${table} WHERE embedder = $1 AND NOT (digest = ANY($2::text[]))`, [embedder, digests])
        count += Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE embedder = $1`, [embedder])).rows[0].n)
      }
      return count
    },
    /** The nearest of the GIVEN digests (the asker's visible chunks): [{ digest, sim }] best first. */
    async search(embedderId, queryVector, digests, limit = 50) {
      if (!digests.length) return []
      await init()
      const { rows } = await db.query(
        `SELECT digest, 1 - (embedding <=> $2::vector) AS sim FROM ${table}
         WHERE embedder = $1 AND dim = $3 AND digest = ANY($4::text[])
         ORDER BY embedding <=> $2::vector LIMIT $5`,
        [embedderId, toSql(queryVector), queryVector.length, digests, limit],
      )
      return rows.map((r) => ({ digest: r.digest, sim: Number(r.sim) }))
    },
  }
}
