// The store contract on MySQL 8 / TiDB, in a temporary database of its own (created here, dropped at the end).
//   FW_TEST_MYSQL_URL=mysql://<user>:<password>@<host>:<port>/<any database>[?ssl=false] (only the server / credentials are
//   used; the database is fw_serverkit_test). TLS unless the host is local. Unset: skipped with a message.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMysqlPool, createMysqlStore, dropMysqlDatabase, ensureMysqlDatabase, migrateMysql, mysqlConnectionOptions, splitSqlStatements, StoreConflict,
} from '../src/index.mjs'
import { storeContract } from './store-contract.mjs'

const SERVER_URL = process.env.FW_TEST_MYSQL_URL || ''
const URL_ = SERVER_URL ? Object.assign(new URL(SERVER_URL), { pathname: '/fw_serverkit_test' }).toString() : ''
const MIGRATIONS = ['001_bridge', '002_event_delegation', '003_ai_profile', '004_assistant_attachments', '005_connectors']
let store = null
let unavailable = SERVER_URL ? null : 'FW_TEST_MYSQL_URL is not set (mysql://<user>:<password>@<host>:<port>/<db>): MySQL / TiDB store tests skipped'
if (!unavailable) try {
  await dropMysqlDatabase(URL_).catch(() => {})
  await ensureMysqlDatabase(URL_)
} catch (error) {
  unavailable = `MySQL / TiDB not reachable (${error.code ?? error.message.split('\n')[0]})` // never the URL
}

if (unavailable) {
  test('mysql store', { skip: unavailable }, () => {})
} else {
  before(async () => {
    store = createMysqlStore({ pool: await createMysqlPool(URL_, { max: 5 }) })
    // two instances starting at once: the lock lets one apply, the other finds nothing left
    const [a, b] = await Promise.all([store.migrate(), store.migrate()])
    assert.deepEqual([...a, ...b].sort(), MIGRATIONS)
    assert.deepEqual(await store.migrate(), [], 'idempotent')
  })
  after(async () => {
    await store?.close()
    await dropMysqlDatabase(URL_)
  })
  storeContract('mysql store', () => store)

  test('mysql store: t.db is the transaction connection (business tables and events commit together)', async () => {
    await store.db.query('create table if not exists biz_thing (id bigint auto_increment primary key, name text)')
    const before = await store.latestEventId()
    await assert.rejects(store.tx(async (t) => {
      await t.db.query(`insert into biz_thing (name) values ('x')`)
      await t.insertEvent({ type: 'a.b', aggregateType: 'a', aggregateId: '1', payload: {} })
      throw new Error('rollback')
    }))
    assert.equal(Number((await store.db.query('select count(*) as n from biz_thing'))[0][0].n), 0)
    assert.equal(await store.latestEventId(), before)
    await store.tx(async (t) => {
      await t.db.query(`insert into biz_thing (name) values ('y')`)
      await t.insertEvent({ type: 'a.b', aggregateType: 'a', aggregateId: '2', payload: { n: 2 } })
    })
    assert.equal(Number((await store.db.query('select count(*) as n from biz_thing'))[0][0].n), 1)
  })

  test('mysql store: concurrent event writers — ids unique, increasing, the cursor sees every one', async () => {
    const start = await store.latestEventId()
    const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => store.tx(async (t) => {
      const id = await t.insertEvent({ type: 'c.c', aggregateType: 'c', aggregateId: String(i), payload: { i } })
      await new Promise((r) => setTimeout(r, 5))
      return id
    })))
    assert.equal(new Set(ids).size, 8)
    const seen = (await store.listEvents(start, 100)).map((e) => e.id)
    assert.deepEqual(seen, [...ids].sort((x, y) => x - y))
    assert.deepEqual(seen, Array.from({ length: 8 }, (_, i) => start + 1 + i), 'no gaps: a rolled-back id is never handed out')
    // outside a transaction too (each insert opens its own)
    const solo = await store.insertEvent({ type: 'c.c', aggregateType: 'c', aggregateId: 'solo', payload: {} })
    assert.equal(solo, start + 9)
  })

  test('mysql store: duplicate keys name the index; dates, booleans and JSON come back normalised', async () => {
    const hash = `h-${Date.now()}`
    await store.insertLinkCode({ userId: 'u', codeHash: hash, expiresAt: new Date(Date.now() + 60_000) })
    await assert.rejects(store.insertLinkCode({ userId: 'u', codeHash: hash, expiresAt: new Date(Date.now() + 60_000) }),
      (e) => e instanceof StoreConflict && e.constraint === 'bridge_link_code_live')
    const r = await store.insertReport({ kind: 'k_norm', date: '2026-01-02', slot: 'test', sections: { a: [1, 'x'] }, test: true })
    assert.deepEqual([r.date, r.test, r.sections], ['2026-01-02', true, { a: [1, 'x'] }])
    const at = new Date('2026-03-04T05:06:07.890Z')
    const st = await store.putConnectorState({ stoppedAt: at })
    assert.equal(st.stoppedAt.toISOString(), at.toISOString(), 'UTC in, UTC out')
    await store.putConnectorState({ stoppedAt: null })
  })

  test('mysql helpers: migrateMysql() with app migrations; guarded database names; TLS unless local', async () => {
    const applied = await migrateMysql(store.pool, { migrations: [{ id: '001_app', sql: '-- app\ncreate table app_x (id int);\ncreate table app_y (id int);' }], table: 'app_migration' })
    assert.deepEqual(applied, ['001_app'])
    await assert.rejects(migrateMysql(store.pool, { migrations: [{ id: '002_bad', sql: 'create tabel nope' }], table: 'app_migration' }), /002_bad failed/)
    assert.deepEqual(splitSqlStatements('-- c\nselect 1;\nselect 2 /*T![x] y */;\n\n'), ['select 1', 'select 2 /*T![x] y */'])
    for (const name of ['mysql', 'information_schema', 'performance_schema', 'sys', 'test', 'INFORMATION_SCHEMA']) {
      await assert.rejects(ensureMysqlDatabase(`mysql://u:p@127.0.0.1:3306/${name}`), /protected/)
    }
    await assert.rejects(ensureMysqlDatabase('mysql://u:p@127.0.0.1:3306/mine', { protectedNames: ['mine'] }), /protected/)
    await assert.rejects(dropMysqlDatabase('mysql://u:p@127.0.0.1:3306/production_db'), /only databases matching/)
    await assert.rejects(ensureMysqlDatabase('mysql://u:p@127.0.0.1:3306/Bad-Name'), /unsupported/)
    assert.equal(mysqlConnectionOptions('mysql://u:p@127.0.0.1:3306/a').ssl, undefined)
    assert.deepEqual(mysqlConnectionOptions('mysql://u:p@db.example.com:4000/a').ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true })
    assert.equal(mysqlConnectionOptions('mysql://u:p@db.internal:3306/a?ssl=false').ssl, undefined)
    assert.equal(mysqlConnectionOptions('mysql://u:p%40x@localhost/a').password, 'p@x')
  })
}
