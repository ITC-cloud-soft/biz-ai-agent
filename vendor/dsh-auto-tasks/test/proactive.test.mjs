import test from 'node:test'
import assert from 'node:assert/strict'
import { proactiveBackend } from '../lib/backends.js'

test('backends: proactive create/cancel against mocked panel API', async () => {
  const calls = []
  const alarm = { id: 'alarm-1', sessionId: 's1', prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (String(url).includes('/action')) {
      const action = JSON.parse(String(init.body)).action
      return { ok: true, json: async () => ({ alarms: action.kind === 'create' ? [alarm] : [] }) }
    }
    return { ok: true, json: async () => ({ alarms: [alarm] }) }
  }
  try {
    const backend = proactiveBackend({ get: () => undefined })
    const created = await backend.createAlarm('s1', { prompt: 'p', after_seconds: 60 })
    assert.equal(created.id, 'alarm-1')
    assert.equal(await backend.cancelAlarm('s1', 'alarm-1'), true)
    const kinds = calls.filter((c) => c.body).map((c) => c.body.action.kind)
    assert.deepEqual(kinds, ['create', 'cancel'])
  } finally {
    globalThis.fetch = oldFetch
  }
})
