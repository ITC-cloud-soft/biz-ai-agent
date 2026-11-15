// GET /bridge/v1/graph/neighbors (G-01…G-07) and "why did this loan / approval reach me?" end to end — a real loan request on
// the web → its approval → the bridge-graph tool, wrapped the way bridge-tools wraps a tool module (dsh-core defineTool +
// guardTool + createToolRequester), run with each employee's own delegation (the ticket flow).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi, createToolRequester, defineTool, guardTool } from '@dsh-bridge/dsh-core'
import { loadManifest } from '@dsh-bridge/server-kit'
import { runGraphChecks } from '@dsh-bridge/graph/conformance'
import graphTools, { renderWhy } from '@dsh-bridge/plugin-graph'
import { MANIFEST_FILE } from '../src/app.mjs'
import { SERVICE, S, day, manifestWithGraphRoles, startWithPeople } from './helpers.mjs'

const MISSING = '00000000-0000-4000-8000-000000000000'
let env
let camera // { loan, approval } of staff1: a high-value item, so it waits for a manager
const tokens = new Map()

function whyTool(e) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const application = {
    id: 'equipment-loans', name: 'Equipment Loans', namespace: 'loan', paths: {},
    api: createBusinessApi({ applicationId: 'equipment-loans', label: 'equipment-loans API', baseUrl: () => e.srv.base, serviceToken: () => SERVICE }),
    manifest: () => manifest,
    ensureManifest: async () => manifest,
  }
  const requester = createToolRequester({ application: () => application })
  const [tool] = graphTools({ applicationId: 'equipment-loans', application: () => application, namespace: 'loan', requestJson: requester.requestJson, defineTool })
  const gate = {
    async authorize(_n, exec) {
      const token = tokens.get(exec.sessionId)
      if (!token) throw new Error('not allowed — no linked employee')
      return { mode: 'delegated', delegationToken: token, applicationId: 'equipment-loans', cacheKey: exec.sessionId }
    },
    forget() {},
  }
  return guardTool(gate, tool, { write: false })
}
async function as(e, person, id) {
  tokens.set(id, (await e.delegated(person))['x-delegation-token'])
  return { sessionId: id }
}
const borrow = (e, person, tag, startsOn, dueOn) => e.call('POST', '/api/loans', { headers: person.web, body: { itemId: e.items[tag].id, startsOn, dueOn } })

before(async () => {
  env = await startWithPeople()
  const r = await borrow(env, env.people.staff1, 'CAM-001', day(10), day(12))
  assert.equal(r.status, 201)
  camera = r.body
})
after(() => env?.srv.stop())

test('neighbors: IDs and types only; the asker is marked; staff see their own objects only; the catalog is for everyone', async () => {
  const a = camera.approval.id
  const m = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${a}`, { headers: await env.delegated(env.people.manager) })
  assert.equal(m.status, 200)
  assert.deepEqual(m.body, {
    ok: true, entity: 'approval', id: a, viewer: { role: 'manager' },
    neighbors: [
      { relation: 'subject', entity: 'loan', id: camera.loan.id },
      { relation: 'requested_by', entity: 'employee', id: env.people.staff1.id },
      { relation: 'required_role', entity: 'role', id: 'manager' },
    ],
  })
  const own = await env.call('GET', `/bridge/v1/graph/neighbors?entity=loan&id=${camera.loan.id}`, { headers: env.people.staff1.web })
  assert.deepEqual(own.body.neighbors, [
    { relation: 'requested_by', entity: 'employee', id: env.people.staff1.id, you: true },
    { relation: 'item', entity: 'equipment_item', id: env.items['CAM-001'].id },
    { relation: 'approval', entity: 'approval', id: a },
  ])
  const other = await env.call('GET', `/bridge/v1/graph/neighbors?entity=loan&id=${camera.loan.id}`, { headers: env.people.staff2.web })
  const none = await env.call('GET', `/bridge/v1/graph/neighbors?entity=loan&id=${MISSING}`, { headers: env.people.staff2.web })
  assert.deepEqual([other.status, other.body], [404, none.body])
  // the item is in the catalog for everyone, but another employee's loan of it is dropped from its neighbors
  const item = (person) => env.call('GET', `/bridge/v1/graph/neighbors?entity=equipment_item&id=${env.items['CAM-001'].id}`, { headers: person.web })
  assert.deepEqual((await item(env.people.staff2)).body.neighbors, [])
  assert.deepEqual((await item(env.people.manager)).body.neighbors, [{ relation: 'loan', entity: 'loan', id: camera.loan.id }])
})

test('graph conformance (G-01…G-07): every role may read; delegation × role with the graph tool for managers only', async () => {
  const fixtures = async (e, probe, notPermitted = []) => ({
    probe: { entity: 'loan', id: probe },
    missing: { entity: 'loan', id: MISSING },
    allowed: [
      { label: 'borrower web', headers: e.people.staff1.web }, { label: 'manager web', headers: e.people.manager.web },
      { label: 'manager ai', headers: await e.delegated(e.people.manager) },
    ],
    denied: [{ label: 'other staff web', headers: e.people.staff2.web }, { label: 'other staff ai', headers: await e.delegated(e.people.staff2) }],
    notPermitted,
  })
  const a = await runGraphChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await fixtures(env, camera.loan.id) })
  assert.deepEqual(a.filter((x) => x.state === 'fail'), [])
  assert.deepEqual(a.map((x) => `${x.id}:${x.state}`), ['G-01:pass', 'G-02:pass', 'G-03:pass', 'G-04:pass', 'G-05:pass', 'G-06:pass', 'G-07:skip'])

  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await borrow(e, e.people.staff1, 'LAP-900', day(20), day(20))
    const f = await fixtures(e, r.body.loan.id, [{ label: 'borrower ai', headers: await e.delegated(e.people.staff1) }])
    f.denied = f.denied.filter((x) => x.label !== 'other staff ai') // a staff delegation is refused (403) before visibility counts
    const b = await runGraphChecks({ baseUrl: e.srv.base, serviceToken: SERVICE, fixtures: f })
    assert.deepEqual(b.filter((x) => x.state !== 'pass'), [], JSON.stringify(b))
    assert.deepEqual(b.map((x) => x.id), ['G-01', 'G-02', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07'])
  } finally {
    await e.srv.stop()
  }
  assert.equal((await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${camera.approval.id}`, { headers: S })).body.error, 'human_required')
})

test('e2e "why did this approval reach me?": the deciding manager, the borrower, another employee', async () => {
  const tool = whyTool(env)
  assert.equal(tool.name, 'loan_graph_why')

  // the manager who got the approval card
  const m = await tool.execute({ entity: 'approval', id: camera.approval.id }, await as(env, env.people.manager, 'c-why-manager'))
  assert.equal(m.found, true)
  assert.deepEqual(m.reasons.map((x) => x.kind), ['required_role', 'event_audience', 'related_event', 'playbook'])
  const said = renderWhy(m)[0].text
  assert.match(said, /It waits for a decision by the role Manager \(manager\) — that is your role\./)
  assert.match(said, /"Approval request" \(approval\.requested\) is sent to Administrator \(admin\), Manager \(manager\) — your role is one of them/)
  assert.match(said, /"Loan overdue" \(loan\.overdue\) about its subject \(Loan\)/)
  assert.match(said, /"Overdue loan follow-up" \(overdue_followup, switched off\) reports to/)
  assert.ok(said.includes(`loan /loans/${camera.loan.id}`), 'the screen of the loan')
  assert.doesNotMatch(said, /Test staff1|Test manager|password|displayName/, 'IDs and rules only, no names')

  // the employee who borrowed: their own request, and the overdue follow-up also goes to them
  const s = await tool.execute({ entity: 'approval', id: camera.approval.id }, await as(env, env.people.staff1, 'c-why-borrower'))
  assert.deepEqual(s.reasons.map((x) => x.kind), ['author', 'audience_rule'])
  assert.match(renderWhy(s)[0].text, /also goes to the employee who made it \(audience rule borrower_and_managers\) — that is you/)

  // another staff member: the same answer as for an approval that does not exist
  const o = await tool.execute({ entity: 'approval', id: camera.approval.id }, await as(env, env.people.staff2, 'c-why-other'))
  const missing = await tool.execute({ entity: 'approval', id: MISSING }, { sessionId: 'c-why-other' })
  assert.deepEqual([o, missing], [{ ok: true, found: false }, { ok: true, found: false }])

  // the decision is recorded, and the graph shows who decided (an ID)
  const d = await env.call('POST', `/api/approvals/${camera.approval.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })
  assert.equal(d.status, 200)
  const after = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${camera.approval.id}`, { headers: env.people.manager.web })
  assert.deepEqual(after.body.neighbors.at(-1), { relation: 'decided_by', entity: 'employee', id: env.people.manager.id, you: true })
})

test('e2e "why did this loan reach me?": the overdue follow-up for a manager and for the borrower', async () => {
  const tool = whyTool(env)
  const r = await borrow(env, env.people.staff2, 'PRJ-001', day(30), day(31))
  assert.equal(r.body.approval, null, 'a short loan of a standard item: no approval')
  const m = await tool.execute({ entity: 'loan', id: r.body.loan.id }, await as(env, env.people.manager2, 'c-loan-manager'))
  assert.deepEqual(m.reasons.map((x) => x.kind), ['event_audience', 'playbook'])
  assert.match(renderWhy(m)[0].text, /"Loan overdue" \(loan\.overdue\) is sent to Administrator \(admin\), Manager \(manager\) — your role is one of them/)
  const b = await tool.execute({ entity: 'loan', id: r.body.loan.id }, await as(env, env.people.staff2, 'c-loan-borrower'))
  assert.deepEqual(b.reasons.map((x) => x.kind), ['author', 'audience_rule'])
  assert.ok(renderWhy(b)[0].text.includes(`equipment_item /equipment/${env.items['PRJ-001'].id}`), 'the screen of the item')
  assert.deepEqual(await tool.execute({ entity: 'loan', id: r.body.loan.id }, await as(env, env.people.staff1, 'c-loan-other')), { ok: true, found: false })
})

test('delegation × role: with the graph tool for managers only, a staff member\'s AI is refused by the business system', async () => {
  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await borrow(e, e.people.staff1, 'CAM-001', day(30), day(30))
    const tool = whyTool(e)
    await assert.rejects(tool.execute({ entity: 'loan', id: r.body.loan.id }, await as(e, e.people.staff1, 'c-g-staff')), (err) => err.status === 403 && /delegation_not_permitted/.test(err.message))
    const ok = await tool.execute({ entity: 'loan', id: r.body.loan.id }, await as(e, e.people.manager, 'c-g-manager'))
    assert.equal(ok.found, true)
  } finally {
    await e.srv.stop()
  }
})
