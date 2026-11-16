import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/index.mjs'
import { storeContract } from './store-contract.mjs'

const store = createMemoryStore()
storeContract('memory store', () => store)

test('memory store: transactions are serialised; calls from outside wait for a running transaction', async () => {
  const s = createMemoryStore()
  const order = []
  const slow = s.tx(async (t) => {
    order.push('tx:start')
    await new Promise((r) => setTimeout(r, 20))
    await t.addHit('b', 'k')
    order.push('tx:end')
  })
  const outside = s.addHit('b', 'k2').then(() => order.push('outside'))
  await Promise.all([slow, outside])
  assert.deepEqual(order, ['tx:start', 'tx:end', 'outside'])
  // a failed transaction does not lose a write made concurrently from outside
  const failing = s.tx(async (t) => { await t.addHit('c', '1'); await new Promise((r) => setTimeout(r, 10)); throw new Error('x') }).catch(() => {})
  const write = s.addHit('c', '2')
  await Promise.all([failing, write])
  assert.equal(await s.countBucket('c', 10), 1)
  // store.x inside a transaction's async context joins the transaction (no deadlock)
  await s.tx(async () => { await s.addHit('d', '1') })
  assert.equal(await s.countBucket('d', 10), 1)
})

test('memory store: an injected clock drives expiry', async () => {
  let now = new Date('2026-10-27T00:00:00Z')
  const s = createMemoryStore({ now: () => now })
  await s.insertDelegation({ tokenHash: 'h', userId: 'u', expiresAt: new Date('2026-10-27T00:05:00Z') })
  assert.ok(await s.findLiveDelegation('h'))
  now = new Date('2026-10-27T00:06:00Z')
  assert.equal(await s.findLiveDelegation('h'), null)
})
