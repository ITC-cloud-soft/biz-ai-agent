import test from 'node:test'
import assert from 'node:assert/strict'
import { dshWebBase, imBackend } from '../lib/backends.js'

test('backends: dshWebBase env override', () => {
  const old = process.env.DSH_WEB_BASE
  process.env.DSH_WEB_BASE = 'http://127.0.0.1:9999'
  assert.equal(dshWebBase(), 'http://127.0.0.1:9999')
  if (old === undefined) delete process.env.DSH_WEB_BASE
  else process.env.DSH_WEB_BASE = old
})

test('backends: imBackend reports availability', async () => {
  const fake = { get: () => undefined }
  assert.equal(imBackend(fake).available, false)
  const withIm = {
    get: () => ({ send: async () => ({ sent: true }), listBots: async () => [], listTargets: async () => [] }),
  }
  assert.equal(imBackend(withIm).available, true)
  assert.equal((await imBackend(withIm).send('b', 't', 'x')).sent, true)
})
