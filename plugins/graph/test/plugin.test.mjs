// bridge-graph without a business system: the tool's arguments, its 404 handling and what the model sees.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import graphTools, { renderWhy } from '../src/index.js'

const manifest = {
  roles: { manager: { label: 'Manager' }, staff: { label: 'Staff' } },
  entities: { approval: { label: 'Approval' }, leave_request: { label: 'Leave request', link: '/leave-requests/{id}' } },
  events: { 'approval.requested': { label: 'Approval request', aggregate: 'approval', audience: { roles: ['manager'] } } },
}
function kitWith(answer) {
  const calls = []
  const app = { name: 'Leave Requests', manifest: () => manifest, ensureManifest: async () => manifest }
  const kit = {
    namespace: 'leave',
    application: () => app,
    requestJson: async (tool, path, query) => { calls.push({ tool, path, query }); return answer(query) },
  }
  return { tool: graphTools(kit)[0], calls }
}

test('the tool: one delegated GET, the explanation, the rendered rules for the model', async () => {
  const { tool, calls } = kitWith(() => ({ ok: true, entity: 'approval', id: 'a-1', viewer: { role: 'manager' }, neighbors: [{ relation: 'subject', entity: 'leave_request', id: 'l-1' }, { relation: 'required_role', entity: 'role', id: 'manager' }] }))
  assert.equal(tool.name, 'leave_graph_why')
  const r = await tool.execute({ entity: 'approval', id: 'a-1' })
  assert.deepEqual(calls, [{ tool: 'leave_graph_why', path: '/bridge/v1/graph/neighbors', query: { entity: 'approval', id: 'a-1' } }])
  assert.deepEqual(r.reasons.map((x) => x.kind), ['required_role', 'event_audience'])
  const out = renderWhy(r)[0].text
  assert.match(out, /Explain with ONLY these reasons/)
  assert.match(out, /\[rule: event:approval\.requested → entity:approval → role:manager\]/)
  assert.match(out, /leave_request \/leave-requests\/l-1/)
})

test('404 is "not found" (the same for missing and not permitted); arguments that choose rights are refused', async () => {
  const { tool } = kitWith(() => { throw Object.assign(new Error('not_found'), { status: 404 }) })
  assert.deepEqual(await tool.execute({ entity: 'approval', id: 'zz' }), { ok: true, found: false })
  assert.match(renderWhy({ found: false })[0].text, /does not exist, or they may not see it/)
  await assert.rejects(tool.execute({ entity: 'approval', id: 'a', role: 'manager' }), /role not accepted/)
  await assert.rejects(tool.execute({ entity: 'invoice', id: 'a' }), /"entity" must be one of approval, leave_request/)
  await assert.rejects(tool.execute({ entity: 'approval', id: '../x' }), /"id" is required/)
})
