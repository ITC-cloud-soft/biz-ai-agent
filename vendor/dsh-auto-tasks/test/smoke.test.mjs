import test from 'node:test'
import assert from 'node:assert/strict'

test('host smoke: 20 checks (tools/API/CRUD/delivery/inbox/approval)', async () => {
  await import('./host-smoke.mjs')
  const failed = process.exitCode === 1
  process.exitCode = 0
  assert.equal(failed, false, 'host smoke reported failures')
})
