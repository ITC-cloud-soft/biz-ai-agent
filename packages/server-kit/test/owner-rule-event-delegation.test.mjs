// Fail-closed identity and delegation rules of the kit (same as ケアビリング's care-api):
//   - the personal-bot owner rule at lookup: through a registered personal bot an account resolves ONLY to the bot's registrant
//     (GET /identity, POST /delegations, IM decisions); a retired personal bot resolves nobody
//   - personal bots on every personal channel by default (PERSONAL_BOT_PLATFORMS), not email / iMessage
//   - per-event delegations (POST /delegations { event: { id } }, U10): opt-in per event type (hooks.eventDelegations), the person
//     the business's own event names, only while the event is fresh and the person's own condition holds (issue AND every use)
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeApp, createMemoryStore, PERSONAL_BOT_PLATFORMS } from '../src/index.mjs'
import { BFF_SECRET, client, createToy, SERVICE_TOKEN, TOY_MANIFEST } from './toy.mjs'

const S = { 'x-service-token': SERVICE_TOKEN }
const D = (token) => ({ ...S, 'x-delegation-token': token })
let seq = 0
const uid = () => `U${process.pid}-o${(seq += 1)}`

/** A toy on its own (port 0) with a controllable clock. */
async function startToy(options = {}) {
  let clock = Date.now()
  const now = () => new Date(clock)
  const toy = await (await createToy({ now, ...options })).start()
  const call = client(toy.base)
  const bff = (emp) => ({ ...emp.headers, 'x-bff-secret': BFF_SECRET })
  async function link(emp, source) {
    const code = await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })
    assert.equal(code.status, 201, code.text)
    const r = await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: code.body.code, source } })
    assert.equal(r.status, 200, r.text)
    return source
  }
  const lookup = (s) => call('GET', '/bridge/v1/identity', { headers: S, query: Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== null)) })
  return { toy, call, bff, link, lookup, advance: (ms) => { clock += ms } }
}

describe('personal-bot owner rule at lookup (GET /identity, POST /delegations, IM decisions)', () => {
  let env
  before(async () => { env = await startToy() })
  after(async () => { await env?.toy.stop() })

  test('through a personal bot only its owner resolves; another employee linked through the organisation bot is "not linked" there', async () => {
    const { toy, call, bff, link, lookup } = env
    const owner = toy.addUser('staff')
    const other = toy.addUser('manager')
    const orgBot = `slack-org-${uid()}`
    const personal = `slack-${uid()}`
    // both linked in the same Slack workspace through the organisation's bot
    const ownerSrc = await link(owner, { platform: 'slack', teamId: 'T9', userId: uid(), botId: orgBot })
    const otherSrc = await link(other, { platform: 'slack', teamId: 'T9', userId: uid(), botId: orgBot })
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: bff(owner), body: { platform: 'slack', botId: personal } })).status, 201)

    // the other employee writes to the owner's personal bot: not linked, nothing about whose bot it is, no delegation
    const r1 = await lookup({ ...otherSrc, botId: personal })
    assert.equal(r1.status, 200)
    assert.deepEqual(r1.body, { ok: true, linked: false, orgId: 'toy-org' })
    const d1 = await call('POST', '/bridge/v1/delegations', { headers: S, body: { source: { ...otherSrc, botId: personal } } })
    assert.deepEqual([d1.status, d1.body.error], [404, 'identity_not_linked'])
    // through the organisation's bot, and without a botId: unchanged
    assert.equal((await lookup(otherSrc)).body.user.id, other.id)
    assert.equal((await lookup({ ...otherSrc, botId: undefined })).body.user.id, other.id)
    // the owner, linked in the same workspace, resolves through their own bot
    const r2 = await lookup({ ...ownerSrc, botId: personal })
    assert.equal(r2.body.linked, true)
    assert.equal(r2.body.user.id, owner.id)
    assert.equal((await call('POST', '/bridge/v1/delegations', { headers: S, body: { source: { ...ownerSrc, botId: personal } } })).status, 201)
    // an IM decision sent through someone else's personal bot: the sender is not resolved
    const approval = await toy.requestApproval(toy.addUser('staff'))
    const decision = await call('POST', `/bridge/v1/approvals/${approval.id}/im-decision`, {
      headers: S, body: { action: 'approve', replyCode: '123456', source: { ...otherSrc, botId: personal } },
    })
    assert.deepEqual([decision.status, decision.body.error], [404, 'identity_not_linked'])
  })

  test('a retired personal bot resolves nobody, its owner included', async () => {
    const { toy, call, bff, link, lookup } = env
    const owner = toy.addUser('staff')
    const personal = `line-${uid()}`
    const orgSrc = await link(owner, { platform: 'line', userId: uid() })
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: bff(owner), body: { platform: 'line', botId: personal } })).status, 201)
    const viaBot = await link(owner, { platform: 'line', userId: uid(), botId: personal })
    assert.equal((await lookup({ ...orgSrc, botId: personal })).body.linked, true)
    // unlinking the account linked through the bot retires the bot
    const row = (await call('GET', '/bridge/v1/me/identities', { headers: owner.headers })).body.identities.find((i) => i.externalId === viaBot.userId)
    assert.equal((await call('DELETE', `/bridge/v1/me/identities/${row.id}`, { headers: owner.headers })).body.personalBotRevoked, true)
    assert.equal((await lookup({ ...orgSrc, botId: personal })).body.linked, false, 'retired bot')
    assert.equal((await call('POST', '/bridge/v1/delegations', { headers: S, body: { source: { ...orgSrc, botId: personal } } })).body.error, 'identity_not_linked')
    assert.equal((await lookup(orgSrc)).body.linked, true, 'the organisation bot / no botId: unchanged')
  })

  test('personal bots on every personal channel by default; email / iMessage / office are not personal; wechat = weixin', async () => {
    const { toy, call, bff } = env
    assert.deepEqual(toy.kit.config.personalBotPlatforms, [...PERSONAL_BOT_PLATFORMS])
    assert.deepEqual([...PERSONAL_BOT_PLATFORMS],
      ['slack', 'line', 'teams', 'telegram', 'discord', 'weixin', 'whatsapp', 'wecom', 'wecom-app', 'qq', 'dingtalk', 'feishu', 'matrix'])
    const owner = toy.addUser('manager')
    for (const platform of PERSONAL_BOT_PLATFORMS) {
      const r = await call('POST', '/bridge/v1/me/personal-bots', { headers: bff(owner), body: { platform, botId: `${platform}-${uid()}` } })
      assert.equal(r.status, 201, `${platform}: ${r.text}`)
    }
    for (const platform of ['email', 'imessage', 'office']) {
      const r = await call('POST', '/bridge/v1/me/personal-bots', { headers: bff(owner), body: { platform, botId: `${platform}-${uid()}` } })
      assert.deepEqual([r.status, r.body.error], [400, 'invalid_platform'], platform)
    }
    const wx = await call('POST', '/bridge/v1/me/personal-bots', { headers: bff(owner), body: { platform: 'wechat', botId: `wx-${uid()}` } })
    assert.equal(wx.status, 201)
    assert.equal(wx.body.bot.platform, 'weixin')
  })

  test('a narrower personalBotPlatforms is honoured (opt out per channel)', async () => {
    const narrow = await startToy({ personalBotPlatforms: ['line'] })
    try {
      const owner = narrow.toy.addUser('staff')
      assert.equal((await narrow.call('POST', '/bridge/v1/me/personal-bots', { headers: narrow.bff(owner), body: { platform: 'line', botId: `l-${uid()}` } })).status, 201)
      assert.equal((await narrow.call('POST', '/bridge/v1/me/personal-bots', { headers: narrow.bff(owner), body: { platform: 'slack', botId: `s-${uid()}` } })).body.error, 'invalid_platform')
    } finally {
      await narrow.toy.stop()
    }
  })
})

describe('per-event delegations (POST /delegations { event: { id } })', () => {
  // task.overdue: the task's owner, only while their own setting "let the AI follow up my overdue tasks" (aiFollowUp) is on.
  // task.done: the task's owner (personOf), fresh for 3 minutes only.
  const rules = ({ users, tasks }) => ({
    'task.overdue': { personOf: (e) => e.payload.ownerUserId, eligible: async (_e, u) => users.get(u.id)?.aiFollowUp === true },
    'task.done': { maxAgeHours: 0.05, personOf: (e) => tasks.get(e.payload.taskId)?.ownerUserId, eligible: async () => true },
  })
  let env
  before(async () => { env = await startToy({ eventDelegations: rules }) })
  after(async () => { await env?.toy.stop() })
  const issue = (body) => env.call('POST', '/bridge/v1/delegations', { headers: S, body })

  test('issued for the person the event names (never the caller\'s choice); read-only; ends when the person\'s setting is turned off', async () => {
    const { toy, call } = env
    const owner = toy.addUser('staff')
    toy.users.get(owner.id).aiFollowUp = true
    const task = await toy.addTask({ ownerUserId: owner.id, dueInDays: -2 })
    const eventId = await toy.markOverdue(task)
    const r = await issue({ event: { id: eventId } })
    assert.equal(r.status, 201, r.text)
    assert.deepEqual(r.body.user, { id: owner.id, role: 'staff', displayName: null })
    assert.ok(new Date(r.body.expiresAt) <= new Date(Date.now() + 5 * 60_000 + 1000))
    assert.equal((await issue({ event: { id: String(eventId) } })).status, 201, 'a numeric string id is accepted')
    assert.equal((await call('GET', '/api/tasks', { headers: D(r.body.token) })).status, 200)
    assert.equal((await call('GET', '/api/tasks/overdue', { headers: D(r.body.token) })).body.error, 'delegation_not_permitted', 'the person\'s own role')
    assert.equal((await call('POST', '/api/tasks', { headers: D(r.body.token), body: {} })).body.error, 'delegation_not_permitted', 'no writes')
    const audit = await toy.store.listAudit({ action: 'delegation.issued' })
    assert.ok(audit.some((a) => a.target === owner.id && a.detail?.via === 'event' && a.detail?.eventType === 'task.overdue'))
    // the person turns the setting off: the live token stops at once, no new one
    toy.users.get(owner.id).aiFollowUp = false
    assert.equal((await call('GET', '/api/tasks', { headers: D(r.body.token) })).body.error, 'invalid_delegation_token')
    assert.deepEqual([(await issue({ event: { id: eventId } })).status, (await issue({ event: { id: eventId } })).body.error], [403, 'event_delegation_refused'])
    // deactivated: refused even with the setting on
    toy.users.get(owner.id).aiFollowUp = true
    assert.equal((await issue({ event: { id: eventId } })).status, 201)
    toy.users.get(owner.id).active = false
    assert.equal((await issue({ event: { id: eventId } })).body.error, 'event_delegation_refused')
  })

  test('an event with no person, an unknown event, a type that grants nothing, a stale event: refused (403 / 404 / 422 / 409)', async () => {
    const { toy, call, advance } = env
    const unowned = await toy.markOverdue(await toy.addTask({ dueInDays: -1 }))
    assert.deepEqual([(await issue({ event: { id: unowned } })).status, (await issue({ event: { id: unowned } })).body.error], [403, 'event_delegation_refused'])
    assert.deepEqual([(await issue({ event: { id: 999999 } })).status, (await issue({ event: { id: 999999 } })).body.error], [404, 'event_not_found'])
    const approval = await toy.requestApproval(toy.addUser('staff'))
    const requested = (await toy.store.listEvents(0, 500)).find((e) => e.type === 'approval.requested' && e.payload.approvalId === approval.id)
    assert.deepEqual([(await issue({ event: { id: requested.id } })).status, (await issue({ event: { id: requested.id } })).body.error], [422, 'event_not_delegable'])

    // task.done is fresh for 3 minutes: a token issued in time dies when the event goes stale (before its own 5 minutes)
    const owner = toy.addUser('manager')
    const task = await toy.addTask({ ownerUserId: owner.id })
    const doneId = await toy.kit.tx((t) => toy.kit.emitEvent(t, { type: 'task.done', aggregateType: 'task', aggregateId: task.id, payload: { taskId: task.id, doneOn: '2026-10-29' } }))
    const r = await issue({ event: { id: doneId } })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.body.user.id, owner.id, 'personOf')
    assert.equal((await call('GET', '/api/tasks', { headers: D(r.body.token) })).status, 200)
    advance(4 * 60_000)
    assert.equal((await call('GET', '/api/tasks', { headers: D(r.body.token) })).body.error, 'invalid_delegation_token')
    assert.deepEqual([(await issue({ event: { id: doneId } })).status, (await issue({ event: { id: doneId } })).body.error], [409, 'event_stale'])
    assert.ok((await toy.store.listAudit({ action: 'delegation.refused' })).some((a) => a.detail?.code === 'event_stale'))
  })

  test('the body: exactly one of source / event, event = { id } only, no employee in the body; service principal only', async () => {
    const { toy, call } = env
    const owner = toy.addUser('staff')
    toy.users.get(owner.id).aiFollowUp = true
    const eventId = await toy.markOverdue(await toy.addTask({ ownerUserId: owner.id, dueInDays: -1 }))
    const bad = async (body, code) => {
      const r = await issue(body)
      assert.deepEqual([r.status, r.body.error], [400, code], JSON.stringify(body))
    }
    await bad({ event: { id: eventId }, source: { platform: 'slack', userId: 'U1' } }, 'source_or_event')
    await bad({ event: { id: eventId, userId: toy.addUser('admin').id } }, 'unknown_field')
    await bad({ event: { id: eventId }, userId: owner.id }, 'unknown_field')
    for (const id of ['abc', 0, -1, 1.5, null]) await bad({ event: { id } }, 'invalid_event')
    await bad({ event: 'x' }, 'invalid_event')
    assert.equal((await call('POST', '/bridge/v1/delegations', { headers: owner.headers, body: { event: { id: eventId } } })).body.error, 'insufficient_role')
    assert.equal((await call('POST', '/bridge/v1/delegations', { body: { event: { id: eventId } } })).status, 401)
  })

  test('without hooks.eventDelegations the kit answers 400 to the event key (not implemented = refused)', async () => {
    const plain = await startToy()
    try {
      const owner = plain.toy.addUser('staff')
      const eventId = await plain.toy.markOverdue(await plain.toy.addTask({ ownerUserId: owner.id, dueInDays: -1 }))
      const r = await plain.call('POST', '/bridge/v1/delegations', { headers: S, body: { event: { id: eventId } } })
      assert.deepEqual([r.status, r.body.error], [400, 'unknown_field'])
      assert.equal(plain.toy.kit.eventDelegations.enabled, false)
    } finally {
      await plain.toy.stop()
    }
  })

  test('createBridgeApp refuses an event rule without the person\'s condition or for an event the manifest does not declare', async () => {
    const base = {
      manifest: { file: TOY_MANIFEST }, store: createMemoryStore(), serviceToken: SERVICE_TOKEN,
      hooks: { employees: { get: async () => null, list: async () => [] } },
    }
    await assert.rejects(createBridgeApp({ ...base, hooks: { ...base.hooks, eventDelegations: { 'task.overdue': {} } } }), /eventDelegations\.task\.overdue\.eligible/)
    await assert.rejects(createBridgeApp({ ...base, hooks: { ...base.hooks, eventDelegations: { 'task.unknown': { eligible: async () => true } } } }), /declares no event task\.unknown/)
  })
})
