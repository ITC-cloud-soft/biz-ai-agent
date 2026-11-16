// GET /bridge/v1/graph/neighbors (G-01…G-07) and "why did this approval reach me?" end to end — a real claim on the web → its
// approval → the bridge-graph tool, wrapped the way bridge-tools wraps a tool module (dsh-core defineTool + guardTool +
// createToolRequester), run with each employee's own delegation (the ticket flow).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi, createToolRequester, defineTool, guardTool } from '@dsh-bridge/dsh-core'
import { loadManifest } from '@dsh-bridge/server-kit'
import { runGraphChecks } from '@dsh-bridge/graph/conformance'
import graphTools, { renderWhy } from '@dsh-bridge/plugin-graph'
import { MANIFEST_FILE } from '../src/app.mjs'
import { SERVICE, S, manifestWithGraphRoles, startWithPeople } from './helpers.mjs'

const APP_ID = 'expense-claims'
const MISSING = '00000000-0000-4000-8000-000000000000'
let env
let small // { claim, approval } of staff1, up to the limit: staff1's manager decides
let large // over the limit: an administrator decides
const tokens = new Map()

function whyTool(e) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const application = {
    id: APP_ID, name: 'Expense Claims', namespace: 'expense', paths: {},
    api: createBusinessApi({ applicationId: APP_ID, label: 'expense-claims API', baseUrl: () => e.srv.base, serviceToken: () => SERVICE }),
    manifest: () => manifest,
    ensureManifest: async () => manifest,
  }
  const requester = createToolRequester({ application: () => application })
  const [tool] = graphTools({ applicationId: APP_ID, application: () => application, namespace: 'expense', requestJson: requester.requestJson, defineTool })
  const gate = {
    async authorize(_n, exec) {
      const token = tokens.get(exec.sessionId)
      if (!token) throw new Error('not allowed — no linked employee')
      return { mode: 'delegated', delegationToken: token, applicationId: APP_ID, cacheKey: exec.sessionId }
    },
    forget() {},
  }
  return guardTool(gate, tool, { write: false })
}
async function as(e, person, id) {
  tokens.set(id, (await e.delegated(person))['x-delegation-token'])
  return { sessionId: id }
}

before(async () => {
  env = await startWithPeople()
  small = await env.claim(env.people.staff1, { amountYen: 8_000 })
  large = await env.claim(env.people.staff1, { amountYen: 48_000, category: 'lodging' })
})
after(() => env?.srv.stop())

test('neighbors: IDs and types only; the asker is marked; staff their own, a manager their team\'s, nobody else\'s', async () => {
  const a = small.approval.id
  const m = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${a}`, { headers: await env.delegated(env.people.manager) })
  assert.equal(m.status, 200)
  assert.deepEqual(m.body, {
    ok: true, entity: 'approval', id: a, viewer: { role: 'manager' },
    neighbors: [
      { relation: 'subject', entity: 'expense_claim', id: small.claim.id },
      { relation: 'requested_by', entity: 'employee', id: env.people.staff1.id },
      { relation: 'required_role', entity: 'role', id: 'manager' },
      { relation: 'assigned_to', entity: 'employee', id: env.people.manager.id, you: true },
    ],
  })
  const own = await env.call('GET', `/bridge/v1/graph/neighbors?entity=expense_claim&id=${small.claim.id}`, { headers: env.people.staff1.web })
  assert.deepEqual(own.body.neighbors, [{ relation: 'requested_by', entity: 'employee', id: env.people.staff1.id, you: true }, { relation: 'approval', entity: 'approval', id: a }])
  const none = await env.call('GET', `/bridge/v1/graph/neighbors?entity=expense_claim&id=${MISSING}`, { headers: env.people.staff2.web })
  for (const p of [env.people.staff2, env.people.manager2]) {
    const other = await env.call('GET', `/bridge/v1/graph/neighbors?entity=expense_claim&id=${small.claim.id}`, { headers: p.web })
    assert.deepEqual([other.status, other.body], [404, none.body], `${p.role} of another team`)
  }
})

test('graph conformance (G-01…G-07): every role may read; delegation × role with the graph tool for managers only', async () => {
  const fixtures = async (e, probe, notPermitted = []) => ({
    probe: { entity: 'expense_claim', id: probe },
    missing: { entity: 'expense_claim', id: MISSING },
    allowed: [
      { label: 'claimant web', headers: e.people.staff1.web }, { label: 'manager web', headers: e.people.manager.web },
      { label: 'manager ai', headers: await e.delegated(e.people.manager) }, { label: 'admin ai', headers: await e.delegated(e.people.admin) },
    ],
    denied: [
      { label: 'other staff web', headers: e.people.staff2.web }, { label: 'other staff ai', headers: await e.delegated(e.people.staff2) },
      { label: 'other team manager web', headers: e.people.manager2.web },
    ],
    notPermitted,
  })
  const a = await runGraphChecks({ baseUrl: env.srv.base, serviceToken: SERVICE, fixtures: await fixtures(env, small.claim.id) })
  assert.deepEqual(a.filter((x) => x.state === 'fail'), [])
  assert.deepEqual(a.map((x) => `${x.id}:${x.state}`), ['G-01:pass', 'G-02:pass', 'G-03:pass', 'G-04:pass', 'G-05:pass', 'G-06:pass', 'G-07:skip'])

  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await e.claim(e.people.staff1)
    const f = await fixtures(e, r.claim.id, [{ label: 'claimant ai', headers: await e.delegated(e.people.staff1) }])
    f.denied = f.denied.filter((x) => x.label !== 'other staff ai') // a staff delegation is refused (403) before visibility counts
    const b = await runGraphChecks({ baseUrl: e.srv.base, serviceToken: SERVICE, fixtures: f })
    assert.deepEqual(b.filter((x) => x.state !== 'pass'), [], JSON.stringify(b))
  } finally {
    await e.srv.stop()
  }
  assert.equal((await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${small.approval.id}`, { headers: S })).body.error, 'human_required')
})

test('e2e "why did this approval reach me?": the manager, an administrator, the claimant, another employee', async () => {
  const tool = whyTool(env)
  assert.equal(tool.name, 'expense_graph_why')

  // the claimant's manager who got the approval card of the small claim
  const m = await tool.execute({ entity: 'approval', id: small.approval.id }, await as(env, env.people.manager, 'c-why-manager'))
  assert.equal(m.found, true)
  assert.deepEqual(m.reasons.map((x) => x.kind), ['required_role', 'assignee', 'event_audience', 'related_event'])
  const said = renderWhy(m)[0].text
  assert.match(said, /It waits for a decision by the role Manager \(manager\) — that is your role\./)
  assert.match(said, /It is assigned to you\./)
  assert.match(said, /"Expense claim waiting" \(expense\.claim_waiting\)/)
  assert.ok(said.includes(`expense_claim /expense-claims/${small.claim.id}`), 'the screen of the claim')
  assert.doesNotMatch(said, /Test staff1|Test manager|password|displayName|Train to a client/, 'IDs and rules only, no names, no note')

  // an administrator: the large claim waits for the administrators' role
  const ad = await tool.execute({ entity: 'approval', id: large.approval.id }, await as(env, env.people.admin2, 'c-why-admin'))
  assert.ok(ad.reasons.some((x) => x.kind === 'required_role'), JSON.stringify(ad.reasons))
  assert.match(renderWhy(ad)[0].text, /Administrator \(admin\) — that is your role/)

  // the employee who made the claim
  const s = await tool.execute({ entity: 'approval', id: small.approval.id }, await as(env, env.people.staff1, 'c-why-claimant'))
  assert.ok(s.reasons.some((x) => x.kind === 'author'), JSON.stringify(s.reasons))
  assert.ok(!s.reasons.some((x) => x.kind === 'required_role' || x.kind === 'assignee'), 'the claimant is not the one who decides')

  // another staff member and another team's manager: the same answer as for an approval that does not exist
  const o = await tool.execute({ entity: 'approval', id: small.approval.id }, await as(env, env.people.staff2, 'c-why-other'))
  const o2 = await tool.execute({ entity: 'approval', id: small.approval.id }, await as(env, env.people.manager2, 'c-why-other-manager'))
  const missing = await tool.execute({ entity: 'approval', id: MISSING }, { sessionId: 'c-why-other' })
  assert.deepEqual([o, o2, missing], [{ ok: true, found: false }, { ok: true, found: false }, { ok: true, found: false }])

  // the decision is recorded, and the graph shows who decided (an ID)
  assert.equal((await env.call('POST', `/api/approvals/${small.approval.id}/decision`, { headers: env.people.manager.web, body: { action: 'approve' } })).status, 200)
  const after = await env.call('GET', `/bridge/v1/graph/neighbors?entity=approval&id=${small.approval.id}`, { headers: env.people.manager.web })
  assert.deepEqual(after.body.neighbors.at(-1), { relation: 'decided_by', entity: 'employee', id: env.people.manager.id, you: true })
})

test('delegation × role: with the graph tool for managers only, a staff member\'s AI is refused by the business system', async () => {
  const e = await startWithPeople({ manifest: manifestWithGraphRoles(['admin', 'manager']) })
  try {
    const r = await e.claim(e.people.staff1)
    const tool = whyTool(e)
    await assert.rejects(tool.execute({ entity: 'expense_claim', id: r.claim.id }, await as(e, e.people.staff1, 'c-g-staff')), (err) => err.status === 403 && /delegation_not_permitted/.test(err.message))
    const ok = await tool.execute({ entity: 'expense_claim', id: r.claim.id }, await as(e, e.people.manager, 'c-g-manager'))
    assert.equal(ok.found, true)
  } finally {
    await e.srv.stop()
  }
})
