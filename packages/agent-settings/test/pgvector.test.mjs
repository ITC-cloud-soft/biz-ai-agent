// The pgvector store on real pgvector SQL (PGlite: PostgreSQL in-process with the pgvector extension; no server, no Docker).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { createPgVectorStore, digestOf } from '../src/index.mjs'

const key = (text, embedder = 'emb:test') => `${embedder}\u0000${text}`

test('pgvector store: vectors keyed by hash (no text), reloaded by a new store, stale ones dropped', async () => {
  const db = await PGlite.create({ extensions: { vector } })
  const store = createPgVectorStore({ db })
  const cache = await store.cache([key('alpha text'), key('beta text')])
  assert.equal(cache.has(key('alpha text')), false)
  cache.set(key('alpha text'), Float32Array.from([1, 0, 0]))
  cache.set(key('beta text'), Float32Array.from([0, 1, 0]))
  assert.equal(await store.save(cache, [key('alpha text'), key('beta text')]), 2)
  const rows = (await db.query('SELECT * FROM agent_vectors')).rows
  assert.deepEqual(Object.keys(rows[0]).sort(), ['digest', 'dim', 'embedder', 'embedding', 'updated_at'])
  assert.ok(!JSON.stringify(rows).includes('alpha text'), 'no text in the table')
  assert.ok(rows.some((r) => r.digest === digestOf('alpha text')))

  const again = await createPgVectorStore({ db }).cache([key('alpha text')])
  assert.deepEqual(Array.from(again.get(key('alpha text'))), [1, 0, 0], 'a restart reads the stored vector: nothing is embedded again')
  assert.equal(await store.save(await store.cache([key('alpha text')]), [key('alpha text')]), 1, 'beta is no chunk any more: dropped')
  assert.equal((await db.query("SELECT count(*)::int AS n FROM agent_vectors WHERE embedder = 'emb:other'")).rows[0].n, 0)
  assert.throws(() => createPgVectorStore({ db, table: 'x; drop table y' }), /table must match/)
})

test('pgvector search: only among the given (visible) digests — the nearest hidden vector is never returned', async () => {
  const db = await PGlite.create({ extensions: { vector } })
  const store = createPgVectorStore({ db, table: 'kv' })
  const cache = await store.cache([])
  const texts = { public1: [1, 0.2, 0], public2: [0, 1, 0], hidden: [1, 0, 0] }
  for (const [t, v] of Object.entries(texts)) cache.set(key(t), Float32Array.from(v))
  await store.save(cache, Object.keys(texts).map((t) => key(t)))
  const q = [1, 0, 0] // identical to the hidden vector
  const all = await store.search('emb:test', q, Object.keys(texts).map(digestOf))
  assert.equal(all[0].digest, digestOf('hidden'), 'with every digest the hidden one would be first')
  const visible = await store.search('emb:test', q, [digestOf('public1'), digestOf('public2')])
  assert.deepEqual(visible.map((h) => h.digest), [digestOf('public1'), digestOf('public2')])
  assert.ok(visible[0].sim > 0.9 && visible[1].sim < 0.1)
  assert.deepEqual(await store.search('emb:test', q, []), [])
  assert.deepEqual(await store.search('emb:test', [1, 0], [digestOf('public1')]), [], 'another dimension: nothing')
})
