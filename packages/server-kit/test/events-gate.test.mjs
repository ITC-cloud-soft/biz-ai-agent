import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkEvent, createEventWriter, createMemoryStore, createPrincipalResolver, EventRejected, gate, loadManifest, sha256 } from '../src/index.mjs'
import { TOY_MANIFEST } from './toy.mjs'

const { manifest } = loadManifest({ file: TOY_MANIFEST })

test('event writer: declared types only, per-type payload whitelist, no personal data, transactional', async () => {
  const store = createMemoryStore()
  const emit = createEventWriter(manifest)
  const ok = { type: 'task.done', aggregateType: 'task', aggregateId: 't1', payload: { taskId: 't1', doneOn: '2026-10-27', ignored: undefined } }
  const id = await store.tx((t) => emit(t, ok))
  assert.equal(id, 1)
  assert.deepEqual((await store.getEvent(1)).payload, { taskId: 't1', doneOn: '2026-10-27' })
  const reject = (event, re) => assert.throws(() => checkEvent(manifest, event), (e) => e instanceof EventRejected && re.test(e.reason))
  reject({ ...ok, type: 'task.nope' }, /undeclared_type/)
  reject({ ...ok, aggregateType: 'Bad Type' }, /invalid_aggregate/)
  reject({ ...ok, payload: { taskId: 't1', dueOn: '2026-10-27' } }, /unknown key dueOn/) // whitelisted for task.overdue, not for task.done
  reject({ ...ok, payload: { taskId: 'call 090-1234-5678' } }, /phone|pii|at \/taskId/)
  reject({ ...ok, payload: [] }, /not an object/)
  // a refused event rolls the whole transaction back
  await assert.rejects(store.tx(async (t) => { await t.addHit('x', 'y'); await emit(t, { ...ok, type: 'nope' }) }), EventRejected)
  assert.equal(await store.countBucket('x', 10), 0)
  await assert.rejects(emit(null, ok), /store transaction/)
})

test('gate: the policy decides before any lookup', () => {
  const req = { headers: {} }
  const user = (role) => ({ kind: 'user', user: { id: 'u', role } })
  const code = (fn) => { try { fn(); return 'ok' } catch (e) { return `${e.status} ${e.code}` } }
  assert.equal(code(() => gate({ kind: 'anon' }, { public: true }, req)), 'ok')
  assert.equal(code(() => gate({ kind: 'anon' }, { allow: ['user'] }, req)), '401 authentication_required')
  assert.equal(code(() => gate({ kind: 'service' }, { allow: ['user'] }, req)), '403 human_required')
  assert.equal(code(() => gate({ kind: 'delegated', user: { role: 'staff' } }, { allow: ['user'] }, req)), '403 delegation_not_permitted')
  assert.equal(code(() => gate({ kind: 'delegated', user: { role: 'staff' } }, { allow: ['delegated'], delegatedRoles: ['admin'] }, req)), '403 delegation_not_permitted')
  assert.equal(code(() => gate(user('staff'), { allow: ['service'] }, req)), '403 insufficient_role')
  assert.equal(code(() => gate(user('staff'), { allow: ['user'], roles: ['admin'] }, req)), '403 insufficient_role')
  assert.equal(code(() => gate(user('staff'), { allow: ['user'], bff: true }, req, { bffSecret: '' })), '503 bff_secret_not_configured')
  assert.equal(code(() => gate(user('staff'), { allow: ['user'], bff: true }, req, { bffSecret: 's' })), '403 bff_only')
  assert.equal(code(() => gate(user('staff'), { allow: ['user'], bff: true }, { headers: { 'x-bff-secret': 's' } }, { bffSecret: 's' })), 'ok')
})

test('principals: service / delegated (live link, active employee, live session) / user / anon', async () => {
  const store = createMemoryStore()
  const users = { u1: { id: 'u1', role: 'staff', active: true } }
  let sessionLive = true
  const { resolvePrincipal } = createPrincipalResolver({
    store, serviceToken: 'svc', employees: { get: async (id) => users[id] ?? null },
    authenticate: async (req) => (req.headers.cookie === 's=1' ? { user: { id: 'u1', role: 'staff' }, sessionId: 'sess' } : null),
    isSessionLive: async () => sessionLive,
  })
  const identity = await store.insertIdentity({ userId: 'u1', platform: 'slack', externalId: 'U1' })
  await store.insertDelegation({ tokenHash: sha256('tok'), userId: 'u1', identityId: identity.id, expiresAt: new Date(Date.now() + 60_000) })
  await store.insertDelegation({ tokenHash: sha256('web'), userId: 'u1', sessionId: 'sess', expiresAt: new Date(Date.now() + 60_000) })
  const p = (headers) => resolvePrincipal({ headers }).then((x) => x.kind, (e) => e.code)
  assert.equal(await p({ 'x-service-token': 'svc' }), 'service')
  assert.equal(await p({ 'x-service-token': 'nope' }), 'invalid_service_token')
  assert.equal(await p({ 'x-delegation-token': 'tok' }), 'service_token_required')
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'tok' }), 'delegated')
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'other' }), 'invalid_delegation_token')
  assert.equal(await p({ cookie: 's=1' }), 'user')
  assert.equal(await p({}), 'anon')
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'web' }), 'delegated')
  sessionLive = false
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'web' }), 'invalid_delegation_token', 'dies with the web session')
  users.u1.active = false
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'tok' }), 'invalid_delegation_token', 'a deactivated employee')
  users.u1.active = true
  await store.unlinkIdentity(identity.id)
  assert.equal(await p({ 'x-service-token': 'svc', 'x-delegation-token': 'tok' }), 'invalid_delegation_token', 'the link ended')
  assert.throws(() => createPrincipalResolver({ store }), /serviceToken/)
})
