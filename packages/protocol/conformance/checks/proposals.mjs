// PR: invariant 3 (the AI proposes, a person decides) on the generic proposal envelope.
import assert from 'node:assert/strict'
import { delegationForRole } from './delegation.mjs'

const REQ = { requires: ['hook:proposalSample'] }

export function register(s) {
  s.check('PR1', 'a delegation can create a proposal for an employee role that may act on it: result pending_review', async (c) => {
    const sample = await c.fx.hooks.proposalSample()
    const d = await delegationForRole(c, sample.role)
    const r = await c.api.post(c.v1('/proposals'), c.as.delegated(d.token), { kind: sample.kind, payload: sample.payload })
    c.ok(r, 201, 'create proposal')
    assert.equal(r.body.proposal.status, 'pending_review')
    assert.equal(r.body.proposal.kind, sample.kind)
    const noKind = await c.api.post(c.v1('/proposals'), c.as.delegated(d.token), { payload: sample.payload })
    c.err(noKind, 400, null, 'missing kind')
    c.err(await c.api.post(c.v1('/proposals'), c.as.anon(), { kind: sample.kind, payload: sample.payload }), 401, null, 'anonymous')
    c.err(await c.api.post(c.v1('/proposals'), c.as.user(c.fx.employees.admin), { kind: sample.kind, payload: sample.payload }), 403, null, 'an employee session cannot create AI proposals')
  }, REQ)

  s.check('PR2', 'the AI can neither accept nor reject its own proposal; a person can, once', async (c) => {
    const sample = await c.fx.hooks.proposalSample()
    const d = await delegationForRole(c, sample.role)
    const created = await c.api.post(c.v1('/proposals'), c.as.delegated(d.token), { kind: sample.kind, payload: sample.payload })
    c.ok(created, 201)
    const id = created.body.proposal.id
    for (const verb of ['accept', 'reject']) {
      c.err(await c.api.post(c.v1(`/proposals/${id}/${verb}`), c.as.delegated(d.token), {}), 403, ['delegation_not_permitted'], `delegation ${verb}`)
      c.err(await c.api.post(c.v1(`/proposals/${id}/${verb}`), c.as.service(), {}), 403, null, `service principal ${verb}`)
      c.err(await c.api.post(c.v1(`/proposals/${id}/${verb}`), c.as.anon(), {}), 401, null, `anonymous ${verb}`)
    }
    const still = await c.api.get(c.v1('/proposals'), c.as.user(c.fx.employees[sample.reviewerRole ?? 'manager']), { status: 'pending_review' })
    c.ok(still, 200)
    assert.ok(still.body.proposals.some((p) => p.id === id), 'the proposal is still pending after every refused attempt')
    const reviewer = c.fx.employees[sample.reviewerRole ?? 'manager']
    const rejected = await c.api.post(c.v1(`/proposals/${id}/reject`), c.as.user(reviewer), { comment: 'conformance' })
    c.ok(rejected, 200, 'a reviewer rejects')
    assert.equal(rejected.body.proposal.status, 'rejected')
    c.err(await c.api.post(c.v1(`/proposals/${id}/reject`), c.as.user(reviewer), { comment: 'again' }), 409, null, 'second decision')
  }, REQ)

  s.check('PR3', 'a delegation cannot propose what the employee\'s role could not do (403 role_not_permitted)', async (c) => {
    const f = await c.fx.hooks.proposalForbiddenSample()
    const d = await delegationForRole(c, f.role)
    c.err(await c.api.post(c.v1('/proposals'), c.as.delegated(d.token), { kind: f.kind, payload: f.payload }), 403, ['role_not_permitted', 'delegation_not_permitted', 'insufficient_role'],
      `${f.role} proposing ${f.kind}`)
  }, { requires: ['hook:proposalForbiddenSample'] })
}
