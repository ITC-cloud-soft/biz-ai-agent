import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliasTable, aliasTableMarkdown, applyAliasTable, fillTemplate, lintOpenApi, listOperations, loadOpenApi, matchOperation, pickAlias, validateAgainst,
} from '../src/index.mjs'

const doc = () => loadOpenApi()
const clone = (x) => JSON.parse(JSON.stringify(x))
const messages = (r) => r.errors.map((e) => e.message)

/** An annotated copy: every operation mapped onto a made-up legacy route (/api/... with the same path parameters). */
function withAliases(d) {
  const copy = clone(d)
  for (const o of listOperations(copy)) {
    const entry = copy.paths[o.path][o.method.toLowerCase()]
    entry['x-legacy-alias'] = o.operationId === 'getLatestReport'
      ? [{ method: 'GET', path: '/api/reports/latest', for: ['user'], status: 'exact' },
          { method: 'GET', path: '/api/ai/report', for: ['delegated'], query: { mode: 'latest' }, status: 'shape', note: 'v1 shape' }]
      : [{ method: o.method, path: `/api${o.path}`, status: 'exact' }]
  }
  return copy
}

describe('bridge-v1.yaml', () => {
  test('lint is clean (errors and warnings)', () => {
    const r = lintOpenApi(doc())
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
  })

  test('covers every endpoint group of the architecture (section 7)', () => {
    const paths = Object.keys(doc().paths)
    for (const needed of [
      '/identity', '/identities/link', '/identities/stats', '/me/link-codes', '/me/identities', '/me/identities/{identityId}', '/me/personal-bots',
      '/delegations', '/events', '/notifications/for-event/{eventId}', '/notifications/deliveries', '/approvals/{approvalId}/deliveries',
      '/approvals/{approvalId}/im-decision', '/assistant/tickets', '/assistant/delegations', '/reports/latest', '/reports/run', '/proposals',
      '/proposals/{proposalId}/accept', '/manifest',
    ]) assert.ok(paths.includes(needed), needed)
  })

  test('auth schemes: service token, delegation token, BFF secret, user session', () => {
    const s = doc().components.securitySchemes
    assert.deepEqual([s.serviceToken.name, s.delegationToken.name, s.bffSecret.name], ['x-service-token', 'x-delegation-token', 'x-bff-secret'])
    assert.ok(s.userSessionCookie && s.userBearer)
    const ops = Object.fromEntries(listOperations(doc()).map((o) => [o.operationId, o.op.security]))
    assert.deepEqual(ops.issueDelegation, [{ serviceToken: [] }])
    assert.deepEqual(ops.registerMyPersonalBot, [{ userSessionCookie: [], bffSecret: [] }, { userBearer: [], bffSecret: [] }])
    assert.ok(ops.createProposal.some((req) => 'delegationToken' in req))
    assert.deepEqual(ops.getHealth, [])
  })

  test('every response declares bridge-protocol and every error uses the envelope', () => {
    const d = doc()
    for (const o of listOperations(d)) {
      for (const [status, raw] of Object.entries(o.op.responses)) {
        const r = raw.$ref ? d.components.responses[raw.$ref.split('/').pop()] : raw
        assert.ok(r.headers['bridge-protocol'], `${o.operationId} ${status}`)
        if (/^[45]/.test(status)) assert.equal(r.content['application/json'].schema.$ref, '#/components/schemas/ErrorEnvelope', `${o.operationId} ${status}`)
      }
    }
  })

  test('the bundled document carries no implementation aliases', () => {
    const table = aliasTable(doc())
    assert.equal(table.length, listOperations(doc()).length)
    assert.deepEqual(table.filter((r) => r.aliases.length).map((r) => r.operationId), [])
  })

  test('alias table of an annotated copy (an implementation that maps v1 onto its own older routes)', () => {
    const d = withAliases(doc())
    const table = aliasTable(d, { extension: 'x-legacy-alias' })
    assert.equal(table.find((r) => r.operationId === 'issueDelegation').aliases[0].path, '/api/delegations')
    assert.ok(aliasTableMarkdown(d, { extension: 'x-legacy-alias', label: 'legacy API' }).includes('| legacy API |'))
    const latest = table.find((r) => r.operationId === 'getLatestReport')
    assert.equal(pickAlias(latest.aliases, 'user').path, '/api/reports/latest')
    assert.equal(pickAlias(latest.aliases, 'delegated').path, '/api/ai/report')
    assert.deepEqual(pickAlias(latest.aliases, 'delegated').query, { mode: 'latest' })
    assert.deepEqual(lintOpenApi(d, { aliasExtension: 'x-legacy-alias' }).errors, [])
  })

  test('applyAliasTable: a JSON alias table (the aliasTable() shape) gives the same annotated copy; stale rows are refused', () => {
    const annotated = withAliases(doc())
    const table = JSON.parse(JSON.stringify(aliasTable(annotated, { extension: 'x-legacy-alias' })))
    const original = doc()
    const before = JSON.stringify(original)
    const applied = applyAliasTable(original, table, { extension: 'x-legacy-alias' })
    assert.equal(JSON.stringify(original), before, 'the document is not modified')
    assert.deepEqual(aliasTable(applied, { extension: 'x-legacy-alias' }), table)
    assert.equal(aliasTableMarkdown(applied, { extension: 'x-legacy-alias' }), aliasTableMarkdown(annotated, { extension: 'x-legacy-alias' }))
    assert.deepEqual(lintOpenApi(applied, { aliasExtension: 'x-legacy-alias', requireAliases: true }).errors, [])
    // the default extension, and operations without a row stay unannotated
    const partial = applyAliasTable(doc(), table.slice(0, 1))
    assert.equal(aliasTable(partial).filter((r) => r.aliases.length).length, 1)
    assert.ok(lintOpenApi(partial, { requireAliases: true }).errors.some((e) => /x-alias is required/.test(e.message)))
    // refused: unknown operation, duplicate row, a method / path that no longer matches, aliases not a list, not an array
    assert.throws(() => applyAliasTable(doc(), [{ ...table[0], operationId: 'noSuchOperation' }]), /unknown operationId/)
    assert.throws(() => applyAliasTable(doc(), [table[0], table[0]]), /duplicate operationId/)
    assert.throws(() => applyAliasTable(doc(), [{ ...table[0], method: table[0].method === 'GET' ? 'POST' : 'GET' }]), /does not match the document/)
    assert.throws(() => applyAliasTable(doc(), [{ ...table[0], v1: '/bridge/v1/elsewhere' }]), /does not match the document/)
    assert.throws(() => applyAliasTable(doc(), [{ ...table[0], aliases: null }]), /aliases must be a list/)
    assert.throws(() => applyAliasTable(doc(), {}), TypeError)
  })

  test('matchOperation and fillTemplate', () => {
    const d = doc()
    const m = matchOperation(d, 'DELETE', '/bridge/v1/me/identities/abc-123')
    assert.equal(m.operation.operationId, 'deleteMyIdentity')
    assert.deepEqual(m.params, { identityId: 'abc-123' })
    assert.equal(matchOperation(d, 'GET', '/bridge/v1/nope'), null)
    assert.equal(matchOperation(d, 'POST', '/bridge/v1/events'), null)
    assert.equal(fillTemplate('/api/ai/approvals/{approvalId}/deliveries', { approvalId: 'a/b' }), '/api/ai/approvals/a%2Fb/deliveries')
  })

  test('component schemas validate real-looking bodies', () => {
    const d = doc()
    assert.ok(validateAgainst(d, 'IdentityLookup', { ok: true, linked: false, orgId: 'o' }).valid)
    assert.ok(!validateAgainst(d, 'IdentityLookup', { ok: true, linked: true, orgId: 'o' }).valid, 'linked: true needs user')
    assert.ok(!validateAgainst(d, 'IdentityLookup', { ok: true, linked: false, user: { id: 'x', role: 'admin' } }).valid, 'linked: false must not carry a user')
    assert.ok(validateAgainst(d, 'LinkCode', { ok: true, code: '123456', expiresAt: '2026-10-26T08:30:00Z' }).valid)
    assert.ok(!validateAgainst(d, 'LinkCode', { ok: true, code: '12345', expiresAt: '2026-10-26T08:30:00Z' }).valid)
    assert.ok(!validateAgainst(d, 'LinkRequest', { code: '123456', source: { platform: 'Slack', userId: 'u' } }).valid, 'platform is lower case')
    assert.ok(!validateAgainst(d, 'ImDecisionRequest', { action: 'maybe', source: { platform: 'slack', userId: 'u' } }).valid)
    assert.ok(validateAgainst(d, 'ErrorEnvelope', { ok: false, error: 'bff_only', message: 'x' }).valid)
    assert.ok(!validateAgainst(d, 'ErrorEnvelope', { ok: false, error: 'botId_required' }).valid, 'error codes are lower snake case')
  })
})

describe('lintOpenApi catches mistakes', () => {
  const mutate = (fn) => {
    const d = clone(doc())
    fn(d)
    return lintOpenApi(d)
  }
  test('aliases (when used): required on request, bad alias parameters, missing note', () => {
    const ext = { aliasExtension: 'x-legacy-alias' }
    const lint = (fn, opts = ext) => { const d = withAliases(doc()); fn(d); return lintOpenApi(d, opts) }
    assert.ok(messages(lint((d) => { delete d.paths['/identity'].get['x-legacy-alias'] }, { ...ext, requireAliases: true })).some((m) => /x-legacy-alias is required/.test(m)))
    assert.deepEqual(messages(lint((d) => { delete d.paths['/identity'].get['x-legacy-alias'] })), [], 'optional unless requireAliases')
    assert.ok(messages(lint((d) => { d.paths['/me/identities/{identityId}'].delete['x-legacy-alias'][0].path = '/api/identities/{id}' })).some((m) => /alias parameters/.test(m)))
    assert.ok(messages(lint((d) => { d.paths['/events'].get['x-legacy-alias'][0].status = 'shape' })).some((m) => /note is required/.test(m)))
  })
  test('a response without the protocol header, an error without the envelope', () => {
    assert.ok(messages(mutate((d) => { delete d.paths['/identity'].get.responses['200'].headers['bridge-protocol'] })).some((m) => /bridge-protocol header/.test(m)))
    assert.ok(messages(mutate((d) => { d.paths['/identity'].get.responses['400'] = { description: 'x', headers: { 'bridge-protocol': {} }, content: { 'application/json': { schema: { type: 'object' } } } } })).some((m) => /ErrorEnvelope/.test(m)))
  })
  test('implicit security, unknown scheme, duplicate operationId, unresolvable $ref, mis-quoted keys', () => {
    assert.ok(messages(mutate((d) => { delete d.paths['/events'].get.security })).some((m) => /security must be declared/.test(m)))
    assert.ok(messages(mutate((d) => { d.paths['/events'].get.security = [{ nope: [] }] })).some((m) => /unknown security scheme/.test(m)))
    assert.ok(messages(mutate((d) => { d.paths['/events'].get.operationId = 'identityStats' })).some((m) => /duplicate operationId/.test(m)))
    assert.ok(messages(mutate((d) => { d.paths['/events'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Nope' } })).some((m) => /unresolvable/.test(m)))
    assert.ok(messages(mutate((d) => { d.components.schemas.Health.properties['used or revoked'] = null })).some((m) => /space or comma/.test(m)))
  })
  test('path parameters must be declared', () => {
    assert.ok(messages(mutate((d) => { d.paths['/me/identities/{identityId}'].delete.parameters = [] })).some((m) => /path parameters/.test(m)))
  })
})
