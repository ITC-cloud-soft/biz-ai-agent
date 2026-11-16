// The store contract on PostgreSQL, in a temporary database of its own (created here, dropped at the end).
//   FW_TEST_DATABASE_URL=postgres://<user>:<password>@<host>:5432/<any database> (only the server / credentials are used;
//   the database is fw_serverkit_test). Unset: skipped with a message.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPool, createPostgresStore, dropDatabase, ensureDatabase, migrate } from '../src/index.mjs'
import { storeContract } from './store-contract.mjs'

const SERVER_URL = process.env.FW_TEST_DATABASE_URL || ''
const URL_ = SERVER_URL ? Object.assign(new URL(SERVER_URL), { pathname: '/fw_serverkit_test' }).toString() : ''
let store = null
let unavailable = SERVER_URL ? null : 'FW_TEST_DATABASE_URL is not set (postgres://<user>:<password>@<host>:5432/<db>): PostgreSQL store tests skipped'
if (!unavailable) try {
  await dropDatabase(URL_).catch(() => {})
  await ensureDatabase(URL_)
} catch (error) {
  unavailable = `PostgreSQL not reachable (${error.message.split('\n')[0]})`
}

if (unavailable) {
  test('postgres store', { skip: unavailable }, () => {})
} else {
  before(async () => {
    store = createPostgresStore({ pool: await createPool(URL_) })
    const applied = await store.migrate()
    assert.deepEqual(applied, ['001_bridge', '002_event_delegation', '003_ai_profile', '004_assistant_attachments', '005_connectors'])
    assert.deepEqual(await store.migrate(), [], 'idempotent')
  })
  after(async () => {
    await store?.close()
    await dropDatabase(URL_)
  })
  storeContract('postgres store', () => store)

  test('postgres store: t.db is the transaction client (business tables and events commit together)', async () => {
    await store.db.query('create table if not exists biz_thing (id serial primary key, name text)')
    await assert.rejects(store.tx(async (t) => {
      await t.db.query(`insert into biz_thing (name) values ('x')`)
      await t.insertEvent({ type: 'a.b', aggregateType: 'a', aggregateId: '1', payload: {} })
      throw new Error('rollback')
    }))
    assert.equal((await store.db.query('select count(*)::int as n from biz_thing')).rows[0].n, 0)
  })

  test('postgres helpers: migrate() with app migrations; guarded database names', async () => {
    const applied = await migrate(store.pool, { migrations: [{ id: '001_app', sql: 'create table app_x (id int)' }], table: 'app_migration' })
    assert.deepEqual(applied, ['001_app'])
    await assert.rejects(migrate(store.pool, { migrations: [{ id: '002_bad', sql: 'create tabel nope' }], table: 'app_migration' }), /002_bad failed/)
    await assert.rejects(ensureDatabase('postgres://u:p@127.0.0.1:5432/postgres'), /protected/)
    await assert.rejects(ensureDatabase('postgres://u:p@127.0.0.1:5432/mine', { protectedNames: ['mine'] }), /protected/)
    await assert.rejects(dropDatabase('postgres://u:p@127.0.0.1:5432/production_db'), /only databases matching/)
    await assert.rejects(ensureDatabase('postgres://u:p@127.0.0.1:5432/Bad-Name'), /unsupported/)
  })
}
