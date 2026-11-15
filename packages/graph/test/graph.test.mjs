// @dsh-bridge/graph without a server: the skeleton from a manifest, and the "why did this reach me" explanation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManifestGraph, explainReach, graphIndex } from '../src/pure.mjs'

const MANIFEST = {
  roles: { admin: { label: 'Administrator' }, manager: { label: 'Manager' }, staff: { label: 'Staff' } },
  entities: { leave_request: { label: 'Leave request', link: '/leave-requests/{id}' }, approval: { label: 'Approval' } },
  audienceRules: { requester_and_managers: { description: 'Requester and managers', roles: ['admin', 'manager'], includes: ['author'] } },
  events: {
    'leave.unanswered': { label: 'Leave request unanswered', aggregate: 'leave_request', audience: { rule: 'requester_and_managers' }, playbook: 'followup' },
    'approval.requested': { label: 'Approval request', aggregate: 'approval', audience: { roles: ['admin', 'manager'] } },
  },
  tools: [
    { name: 'leave_list_requests', http: 'GET /api/leave-requests', access: 'read', roles: ['admin', 'manager', 'staff'] },
    { name: 'leave_list_unanswered', http: 'GET /api/leave-requests/unanswered', access: 'read', roles: ['admin', 'manager'] },
  ],
  playbooks: { followup: { label: 'Follow-up', trigger: { events: ['leave.unanswered'] }, tools: ['leave_list_unanswered'], audience: { roles: ['admin', 'manager'] }, enabled: false } },
  reports: { daily: { label: 'Daily', audience: { roles: ['admin', 'manager'] } } },
}

test('skeleton: nodes and edges straight from the manifest, deterministic', () => {
  const g = buildManifestGraph(MANIFEST)
  assert.deepEqual(g, buildManifestGraph(structuredClone(MANIFEST)))
  const ix = graphIndex(g)
  const to = (from, type) => ix.out(from, type).map((e) => e.to).sort()
  assert.deepEqual(to('event:approval.requested', 'about'), ['entity:approval'])
  assert.deepEqual(to('event:approval.requested', 'notifies'), ['role:admin', 'role:manager'])
  assert.deepEqual(to('event:leave.unanswered', 'notifies'), ['role:admin', 'role:manager'], 'through the audience rule')
  assert.deepEqual(to('event:leave.unanswered', 'triggers'), ['playbook:followup'])
  assert.deepEqual(to('playbook:followup', 'uses'), ['tool:leave_list_unanswered'])
  assert.deepEqual(to('tool:leave_list_unanswered', 'available_to'), ['role:admin', 'role:manager'])
  assert.deepEqual(ix.out('tool:leave_list_requests', 'reads'), [{ from: 'tool:leave_list_requests', to: 'entity:leave_request', type: 'reads', inferred: true }])
  assert.deepEqual(to('report:daily', 'delivered_to'), ['role:admin', 'role:manager'])
  assert.deepEqual(ix.node('audience:requester_and_managers').includes, ['author'])
  assert.ok(!JSON.stringify(g).includes('undefined'))
})

test('why: a manager and an approval request — the event audience, the required role; the link of its subject', () => {
  const g = buildManifestGraph(MANIFEST)
  const r = explainReach(g, {
    ref: { entity: 'approval', id: 'a-1' },
    viewer: { role: 'manager' },
    neighbors: [{ relation: 'subject', entity: 'leave_request', id: 'l-1' }, { relation: 'requested_by', entity: 'employee', id: 'u-9' }, { relation: 'required_role', entity: 'role', id: 'manager' }],
  })
  assert.deepEqual(r.reasons.map((x) => x.kind), ['required_role', 'event_audience', 'related_event', 'playbook'])
  assert.match(r.reasons[1].text, /"Approval request" \(approval\.requested\) is sent to Administrator \(admin\), Manager \(manager\) — your role is one of them/)
  assert.deepEqual(r.reasons[1].path, ['event:approval.requested', 'entity:approval', 'role:manager'])
  assert.match(r.reasons[3].text, /switched off/)
  assert.deepEqual(r.links, [{ entity: 'leave_request', id: 'l-1', url: '/leave-requests/l-1' }])
})

test('why: the requester is told through the audience rule; a role nobody sends to gets "none"', () => {
  const g = buildManifestGraph(MANIFEST)
  const mine = explainReach(g, { ref: { entity: 'leave_request', id: 'l-1' }, viewer: { role: 'staff' }, neighbors: [{ relation: 'requested_by', entity: 'employee', id: 'u-1', you: true }] })
  assert.deepEqual(mine.reasons.map((x) => x.kind), ['author', 'audience_rule'])
  const other = explainReach(g, { ref: { entity: 'approval', id: 'a-1' }, viewer: { role: 'staff' }, neighbors: [] })
  assert.deepEqual(other.reasons.map((x) => x.kind), ['none'])
  assert.throws(() => explainReach(g, { ref: { entity: 'invoice', id: 'x' }, viewer: { role: 'staff' } }), /not an entity of the manifest/)
})
