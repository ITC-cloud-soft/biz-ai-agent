// The route's own filtering, with a stand-in router: every neighbor is checked again with the asker's rights, and only
// well-formed IDs / relations / declared roles / declared entities get through.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerGraph } from '../src/index.mjs'

function mount(hooks) {
  let handler
  const bridge = {
    router: { add: (_m, _p, _policy, h) => { handler = h } },
    kit: { manifest: { entities: { order: {}, invoice: {} } }, declaredRoles: ['clerk', 'boss'], allowlist: {}, readToolPolicy: () => ({}), log: () => {} },
  }
  registerGraph(bridge, hooks)
  return (params, user = { id: 'u-1', role: 'clerk' }) => handler({ principal: { user }, query: new URLSearchParams(params) })
}

test('neighbors the asker may not read are dropped; malformed ones too; the asker is marked', async () => {
  const call = mount({
    canRead: async ({ entity, id }) => !(entity === 'invoice' && id === 'inv-secret'),
    neighbors: async () => [
      { relation: 'billed_as', entity: 'invoice', id: 'inv-1' },
      { relation: 'billed_as', entity: 'invoice', id: 'inv-secret' },
      { relation: 'owner', entity: 'employee', id: 'u-1' },
      { relation: 'owner', entity: 'employee', id: 'u-2' },
      { relation: 'must_decide', entity: 'role', id: 'boss' },
      { relation: 'must_decide', entity: 'role', id: 'king' },
      { relation: 'Bad Relation', entity: 'invoice', id: 'inv-1' },
      { relation: 'other', entity: 'customer', id: 'c-1' },
      { relation: 'other', entity: 'invoice', id: '../x' },
    ],
  })
  const r = await call({ entity: 'order', id: 'o-1' })
  assert.deepEqual(r.body.neighbors, [
    { relation: 'billed_as', entity: 'invoice', id: 'inv-1' },
    { relation: 'owner', entity: 'employee', id: 'u-1', you: true },
    { relation: 'owner', entity: 'employee', id: 'u-2' },
    { relation: 'must_decide', entity: 'role', id: 'boss' },
  ])
  assert.deepEqual(r.body.viewer, { role: 'clerk' })
})

test('404 for an object the asker may not read; 400 for an undeclared entity or a malformed id', async () => {
  const call = mount({ canRead: async () => false, neighbors: async () => { throw new Error('never called') } })
  await assert.rejects(call({ entity: 'order', id: 'o-1' }), (e) => e.status === 404 && /not_found/.test(e.code ?? e.message))
  await assert.rejects(call({ entity: 'customer', id: 'o-1' }), (e) => e.status === 400)
  await assert.rejects(call({ entity: 'order', id: '' }), (e) => e.status === 400)
  assert.throws(() => mount({}), /canRead and neighbors hooks are required/)
})
