// The administrators' attachment settings client (AttachmentSettingsCard) against a real @dsh-bridge/server-kit system (the
// server-kit test toy, port 20204), and the employee's settings normalized for the picker. Data is fictional.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentSettingsError, createAttachmentSettingsClient, normAttachmentSettings } from '../src/core/index.ts'
import { listen } from '../../server-kit/src/index.mjs'
import { client, createToy } from '../../server-kit/test/toy.mjs'

let toy
let srv
let admin
let manager
before(async () => {
  toy = await createToy()
  srv = await listen(toy.bridge.handler, { port: 20204 })
  admin = toy.addUser('admin')
  manager = toy.addUser('manager')
})
after(async () => { await srv?.stop() })

const fetchAs = (u) => (url, init) => fetch(`${srv.base}${url}`, { ...init, headers: { ...init.headers, ...u.headers } })

test('admin client: get the defaults, save, refused for a non-admin; the employee settings normalize for the picker', async () => {
  const c = createAttachmentSettingsClient({ fetch: fetchAs(admin) })
  const first = await c.get()
  assert.deepEqual([first.roles, first.types.length, first.limits.maxFiles], [['admin', 'manager'], 7, 5])
  const saved = await c.save({ roles: ['admin'], types: ['image', 'pdf'] })
  assert.deepEqual([saved.roles, saved.types], [['admin'], ['image', 'pdf']])
  await assert.rejects(createAttachmentSettingsClient({ fetch: fetchAs(manager) }).get(), (e) => e instanceof AttachmentSettingsError && e.status === 403 && e.code === 'insufficient_role')
  await assert.rejects(c.save({ roles: ['owner'], types: [] }), (e) => e.code === 'invalid_value')
  const call = client(srv.base)
  const mine = normAttachmentSettings((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: admin.headers })).body)
  assert.deepEqual([mine.enabled, mine.types, mine.limits.maxFileBytes], [true, ['image', 'pdf'], 10 * 1024 * 1024])
  assert.equal(normAttachmentSettings((await call('GET', '/bridge/v1/assistant/attachment-settings', { headers: manager.headers })).body).enabled, false)
})
