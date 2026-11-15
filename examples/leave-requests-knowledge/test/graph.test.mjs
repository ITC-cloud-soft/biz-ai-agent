// Week 4 on the pilot: GET /bridge/v1/graph/neighbors (G-01…G-07) and "why did this approval reach me?" end to end —
// a real leave request on the web → its approval → the bridge-graph tool, wrapped the way bridge-tools wraps a tool module
// (dsh-core defineTool + guardTool + createToolRequester), run with each employee's own delegation (the ticket flow).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi, createToolRequester, defineTool, guardTool } from '@dsh-bridge/dsh-core'
import { loadManifest } from '@dsh-bridge/server-kit'
import { runGraphChecks } from '@dsh-bridge/graph/conformance'
import graphTools, { renderWhy } from '@dsh-bridge/plugin-graph'
import { MANIFEST_FILE } from '../src/app.mjs'
import { SERVICE, S, startWithPeople } from './helpers.mjs'

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
let env
let leave // { leaveRequest, approval } of staff1
const tokens = new Map()

function whyTool(e) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const application = {
    id: 'leave-requests', name: 'Leave Requests', namespace: 'leave', paths: {},
    api: createBusinessApi({ applicationId: 'leave-requests', label: 'leave-requests API', baseUrl: () => e.srv.base, serviceToken: () => SERVICE }),
    manifest: () => manifest,
    ensureManifest: async () => manifest,
  }
  const requester = createToolRequester({ application: () => application })
  const [tool] = graphTools({ applicationId: 'leave-requests', application: () => application, namespace: 'leave', requestJson: requester.requestJson, defineTool })
  const gate = {
    async authorize(_n, exec) {
      const token = tokens.get(exec.sessionId)
      if (!token) throw new Error('not allowed — no linked employee')
      return { mode: 'delegated', delegationToken: token, applicationId: 'leave-requests', cacheKey: exec.sessionId }
    },
    forget() {},
  }
  return guardTool(gate, tool, { write: false })
}
async function as(e, person, id) {
  tokens.set(id, (await e.delegated(person))['x-delegation-token'])
  return { sessionId: id }
}
function manifestWithGraphRoles(roles) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const copy = structuredClone(manifest)
  copy.tools.find((t) => t.http === 'GET /bridge/v1/graph/neighbors').roles = roles
  return { manifest: copy }
}

before(async () => {
  env = await startWithPeople()
  const r = await env.call('POST', '/api/leave-requests', { headers: env.people.staff1.web, body: { startsOn: day(10), endsOn: day(12) } })
  assert.equal(r.status, 201)
  leave = r.body
})
after(() => env?.srv.stop())

test('neighbors: IDs and types only; the asker is marked; staff see their own objects only', async () => {
  const a = leave.approval.id
  const m = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${a}`, { headers: await env.delegated(env.people.manager) })
  assert.equal(m.status, 200)
  assert.deepEqual(m.body, {
    ok: true, entity: 'approval', id: a, viewer: { role: 'manager' },
    neighbors: [
      { relation: 'subject', entity: 'leave_request', id: leave.leaveRequest.id },
      { relation: 'requested_by', entity: 'employee', id: env.people.staff1.id },
      { relation: 'required_role', entity: 'role', id: 'manager' },
    ],
  })
  const own = await env.call('GET', `/bridge/v1/graph/neighbors?entity=leave_request&id=${leave.leaveRequest.id}`, { headers: env.people.staff1.web })
  assert.deepEqual(own.body.neighbors, [{ relation: 'requested_by', entity: 'employee', id: env.people.staff1.id, you: true }, { relation: 'approval', entity: 'approval', id: a }])
  const other = await env.call('GET', `/bridge/v1/graph/neighbors?entity=leave_request&id=${leave.leaveRequest.id}`, { headers: env.people.staff2.web })
  const none = await env.call('GET', '/bridge/v1/graph/neighbors?entity=leave_request&id=00000000-0000-4000-8000-000000000000', { headers: env.people.staff2.web })
  assert.deepEqual([other.status, other.body], [404, none.body])
})

test('graph conformance (G-01…G-07): every role may read; delegation × role with the graph tool for managers only', async () => {
  const fixtures = async (e, probe, notPermitted = []) => ({
    probe: { entity: 'leave_request', id: probe },
    missing: { entity: 'leave_request', id: '00000000-0000-4000-8000-000000000000' },
    allowed: [
      { label: 'requester web', headers: e.people.staff1.web }, { label: 'manager web', headers: e.people.manager.web },
      { label: 'manager ai', headers: await e.delegated(e.people.manager) },
    ],
    denied: [{ label: 'other staff web', headers: e.people.staff2.web }, { label: 'other staff ai', headers: await e.delegated(e.people.staff2) }],
    notPermitted,
  })
  const a = await runGraphChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await fixtures(env, leave.leaveRequest.id) })
  assert.deepEqual(a.filter((x) => x.state === 'fail'), [])
  assert.deepEqual(a.map((x) => `${x.id}:${x.state}`), ['G-01:pass', 'G-02:pass', 'G-03:pass', 'G-04:pass', 'G-05:pass', 'G-06:pass', 'G-07:skip'])

  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await e.call('POST', '/api/leave-requests', { headers: e.people.staff1.web, body: { startsOn: day(20), endsOn: day(20) } })
    const f = await fixtures(e, r.body.leaveRequest.id, [{ label: 'requester ai', headers: await e.delegated(e.people.staff1) }])
    f.denied = f.denied.filter((x) => x.label !== 'other staff ai') // a staff delegation is refused (403) before visibility counts
    const b = await runGraphChecks({ baseUrl: e.srv.base, serviceToken: SERVICE, fixtures: f })
    assert.deepEqual(b.filter((x) => x.state !== 'pass'), [], JSON.stringify(b))
  } finally {
    await e.srv.stop()
  }
  assert.equal((await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${leave.approval.id}`, { headers: S })).body.error, 'human_required')
})

test('e2e "why did this approval reach me?": the manager, the requester, another employee', async () => {
  const tool = whyTool(env)
  assert.equal(tool.name, 'leave_graph_why')

  // the manager who got the approval card
  const m = await tool.execute({ entity: 'approval', id: leave.approval.id }, await as(env, env.people.manager, 'c-why-manager'))
  assert.equal(m.found, true)
  assert.deepEqual(m.reasons.map((x) => x.kind), ['required_role', 'event_audience', 'related_event', 'playbook'])
  const said = renderWhy(m)[0].text
  assert.match(said, /It waits for a decision by the role Manager \(manager\) — that is your role\./)
  assert.match(said, /"Approval request" \(approval\.requested\) is sent to Administrator \(admin\), Manager \(manager\) — your role is one of them/)
  assert.match(said, /"Leave request unanswered" \(leave\.unanswered\) about its subject \(Leave request\)/)
  assert.match(said, /"Unanswered leave follow-up" \(unanswered_followup, switched off\) reports to/)
  assert.ok(said.includes(`leave_request /leave-requests/${leave.leaveRequest.id}`), 'the screen of the request')
  assert.doesNotMatch(said, /Test staff1|password|displayName/, 'IDs and rules only, no names')

  // the employee who made the request
  const s = await tool.execute({ entity: 'approval', id: leave.approval.id }, await as(env, env.people.staff1, 'c-why-requester'))
  assert.deepEqual(s.reasons.map((x) => x.kind), ['author', 'audience_rule'])
  assert.match(renderWhy(s)[0].text, /also goes to the employee who made it \(audience rule requester_and_managers\) — that is you/)

  // another staff member: the same answer as for an approval that does not exist
  const o = await tool.execute({ entity: 'approval', id: leave.approval.id }, await as(env, env.people.staff2, 'c-why-other'))
  const missing = await tool.execute({ entity: 'approval', id: '00000000-0000-4000-8000-000000000000' }, { sessionId: 'c-why-other' })
  assert.deepEqual([o, missing], [{ ok: true, found: false }, { ok: true, found: false }])

  // the decision is recorded, and the graph shows who decided (an ID)
  const d = await env.call('POST', `/api/approvals/${leave.approval.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })
  assert.equal(d.status, 200)
  const after = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${leave.approval.id}`, { headers: env.people.manager.web })
  assert.deepEqual(after.body.neighbors.at(-1), { relation: 'decided_by', entity: 'employee', id: env.people.manager.id, you: true })
})

test('delegation × role: with the graph tool for managers only, a staff member\'s AI is refused by the business system', async () => {
  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await e.call('POST', '/api/leave-requests', { headers: e.people.staff1.web, body: { startsOn: day(30), endsOn: day(30) } })
    const tool = whyTool(e)
    await assert.rejects(tool.execute({ entity: 'leave_request', id: r.body.leaveRequest.id }, await as(e, e.people.staff1, 'c-g-staff')), (err) => err.status === 403 && /delegation_not_permitted/.test(err.message))
    const ok = await tool.execute({ entity: 'leave_request', id: r.body.leaveRequest.id }, await as(e, e.people.manager, 'c-g-manager'))
    assert.equal(ok.found, true)
  } finally {
    await e.srv.stop()
  }
})
