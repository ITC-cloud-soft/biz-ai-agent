// The employee's own connections client (against a real @dsh-bridge/server-kit system) and the notification logic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addedIdentities, createMeImClient, groupNotifyTypes, isUnavailable, MeImError, maybe, normIdentity, normPrefs, putBody, quietInvalid, samePrefs,
  serverTypeIds, visibleTypes, wants, DEFAULT_PREFS,
} from '../src/core/index.ts'
import { createToy, SERVICE_TOKEN } from '../../server-kit/test/toy.mjs'

let toy
before(async () => { toy = await (await createToy()).start() })
after(async () => { await toy?.stop() })

/** fetch as the browser of one employee (their session cookie), against the toy system. */
const asEmployee = (emp) => (url, init) => fetch(`${toy.base}${url}`, { ...init, headers: { ...init.headers, cookie: emp.headers.cookie } })

test('me client against server-kit: issue a code, the link appears in my list, unlink; another employee never sees it', async () => {
  const emp = toy.addUser('staff')
  const other = toy.addUser('admin')
  const me = createMeImClient({ fetch: asEmployee(emp), weixinBase: null })
  const code = await me.issueLinkCode()
  assert.match(code.code, /^\d{6}$/)
  assert.ok(code.expiresAt > Date.now())
  const before = await me.listMyIdentities()
  assert.deepEqual([before.unavailable, before.data], [false, []])
  const link = await fetch(`${toy.base}/bridge/v1/identities/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
    body: JSON.stringify({ code: code.code, source: { platform: 'slack', teamId: 'T9', userId: 'U-web-kit' } }),
  })
  assert.equal(link.status, 200)
  const list = (await me.listMyIdentities()).data
  assert.equal(list.length, 1)
  assert.deepEqual([list[0].platform, list[0].teamId, list[0].externalId], ['slack', 'T9', 'U-web-kit'])
  assert.deepEqual(addedIdentities(new Set(), list).map((i) => i.id), [list[0].id])
  assert.deepEqual((await createMeImClient({ fetch: asEmployee(other) }).listMyIdentities()).data, [], 'own links only (admin too)')
  await assert.rejects(createMeImClient({ fetch: asEmployee(other) }).removeMyIdentity(list[0]), (e) => e instanceof MeImError && e.status === 404 && e.code === 'identity_not_found')
  await me.removeMyIdentity(list[0])
  assert.deepEqual((await me.listMyIdentities()).data, [])
})

test('me client: notification preferences round trip with the kit (types listed by the server, quiet hours keys)', async () => {
  const emp = toy.addUser('staff')
  const me = createMeImClient({ fetch: asEmployee(emp) })
  const got = await me.getNotifyPreferences()
  assert.deepEqual(serverTypeIds(got.data), ['task.overdue'])
  const prefs = normPrefs(got.data)
  assert.deepEqual(prefs.quietHours, { enabled: false, start: '22:00', end: '07:00' })
  const rows = visibleTypes([], { serverIds: serverTypeIds(got.data), labels: { 'task.overdue': '期限超過' } })
  assert.deepEqual(rows, [{ id: 'task.overdue', label: '期限超過' }])
  const draft = { ...prefs, types: { 'task.overdue': { im: false } }, quietHours: { ...prefs.quietHours, enabled: true, start: '21:00' } }
  const saved = normPrefs(await me.putNotifyPreferences(putBody(draft, rows)))
  assert.equal(wants(saved, 'task.overdue'), false)
  assert.deepEqual(saved.quietHours, { enabled: true, start: '21:00', end: '07:00' })
  await assert.rejects(me.putNotifyPreferences({ userId: 'someone-else', types: {} }), (e) => e.code === 'unknown_field')
})

test('me client: paths, snake_case rows, personal WeChat removal through the BFF, unavailable endpoints', async () => {
  const calls = []
  const answers = {
    'GET /x/v1/me/identities': [200, { identities: [{ id: 'i1', platform: 'weixin', team_id: null, external_id: 'wx-u', bot_id: 'b1', verified_at: '2026-10-27T00:00:00Z' }, { bogus: true }] }],
    'DELETE /bff/wx/identities/i1': [200, { ok: true }],
    'DELETE /x/v1/me/identities/i2': [200, { ok: true }],
    'POST /bff/wx/begin': [503, { ok: false, error: 'dsh_gateway_not_configured' }],
    'GET /x/v1/me/notification-preferences': [404, { ok: false, error: 'not_found' }],
    'POST /bff/wx/poll': [200, { provision: { attemptId: 'a1', status: 'pending' } }],
  }
  const fakeFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    const [status, body] = answers[`${init.method} ${url}`] ?? [500, { ok: false, error: 'boom' }]
    return { status, ok: status < 400, text: async () => JSON.stringify(body) }
  }
  const me = createMeImClient({ base: '/x/v1', weixinBase: '/bff/wx', fetch: fakeFetch })
  const list = (await me.listMyIdentities()).data
  assert.deepEqual(list, [{ id: 'i1', platform: 'weixin', teamId: null, externalId: 'wx-u', botId: 'b1', method: null, verifiedAt: '2026-10-27T00:00:00Z', createdAt: null }])
  await me.removeMyIdentity(list[0])
  await me.removeMyIdentity({ ...list[0], id: 'i2', platform: 'slack' })
  assert.deepEqual(calls.slice(1, 3), ['DELETE /bff/wx/identities/i1', 'DELETE /x/v1/me/identities/i2'])
  assert.deepEqual(await me.beginWeixin(), { unavailable: true, data: null })
  assert.deepEqual(await me.getNotifyPreferences(), { unavailable: true, data: null })
  assert.deepEqual(await me.pollWeixin('a1'), { attemptId: 'a1', status: 'pending' })
  await assert.rejects(me.issueLinkCode(), (e) => e.status === 500 && e.code === 'boom')
  await assert.rejects(maybe(Promise.reject(new MeImError(500, 'x'))), /x/)
  assert.equal(isUnavailable(new MeImError(405, 'x')), true)
  const noWx = createMeImClient({ weixinBase: null, fetch: fakeFetch })
  assert.equal(noWx.weixinEnabled, false)
  await assert.rejects(noWx.pollWeixin('a1'), (e) => e.code === 'weixin_not_configured')
  // unlinkBase (S1): every unlink goes to the BFF, which also deletes the employee's own personal bot; my personal bots
  calls.length = 0
  answers['DELETE /api/me/im/identities/i1'] = [200, { ok: true }]
  answers['DELETE /api/me/im/identities/i2'] = [200, { ok: true }]
  answers['GET /x/v1/me/personal-bots'] = [200, { bots: [{ id: 'r1', platform: 'slack', botId: 'slack_1', kind: 'personal' }, { bogus: 1 }] }]
  const all = createMeImClient({ base: '/x/v1', unlinkBase: '/api/me/im', fetch: fakeFetch })
  await all.removeMyIdentity(list[0])
  await all.removeMyIdentity({ ...list[0], id: 'i2', platform: 'slack' })
  assert.deepEqual(calls, ['DELETE /api/me/im/identities/i1', 'DELETE /api/me/im/identities/i2'])
  assert.deepEqual(await all.listMyPersonalBots(), { unavailable: false, data: [{ platform: 'slack', botId: 'slack_1' }] })
  const offline = createMeImClient({ fetch: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(offline.issueLinkCode(), (e) => e.code === 'network')
  assert.equal(normIdentity(null), null)
})

test('notify logic: normalisation, default-off, roles, groups, quiet hours, PUT body', () => {
  const p = normPrefs({ preferences: { types: { a: { im: false }, b: true }, quiet_hours: { enabled: true, start: '9:00', end: '07:00:00', applyToX: true } } })
  assert.deepEqual(p, { types: { a: { im: false }, b: { im: true } }, quietHours: { applyToX: true, enabled: true, start: '09:00', end: '07:00' } })
  assert.deepEqual(normPrefs(null), DEFAULT_PREFS)
  assert.equal(wants(p, 'a'), false)
  assert.equal(wants(p, 'zzz'), true)
  assert.equal(wants(p, 'zzz', ['zzz']), false)
  const defs = [
    { id: 'x.one', label: '一', group: 'g1' },
    { id: 'x.two', label: '二', roles: ['admin'], group: 'g2' },
    { id: 'x.three', label: '三' },
  ]
  assert.deepEqual(visibleTypes(defs, { role: 'staff' }).map((d) => d.id), ['x.one', 'x.three'])
  assert.deepEqual(visibleTypes(defs, { role: 'admin', serverIds: ['x.three', 'x.new', 'x.two'] }).map((d) => d.id), ['x.two', 'x.three', 'x.new'])
  const groups = groupNotifyTypes(visibleTypes(defs, { role: 'admin' }), [{ id: 'g2', label: 'G2' }, { id: 'g1', label: 'G1' }, { id: 'other', label: 'その他' }], 'other')
  assert.deepEqual(groups.map((g) => [g.group, g.types.map((t) => t.id)]), [['g2', ['x.two']], ['g1', ['x.one']], ['other', ['x.three']]])
  assert.deepEqual(groupNotifyTypes([{ id: 'a' }]).map((g) => g.types.length), [1])
  assert.equal(quietInvalid({ types: {}, quietHours: { enabled: true, start: '10:00', end: '10:00' } }), true)
  assert.equal(quietInvalid({ types: {}, quietHours: { enabled: false, start: '10:00', end: '10:00' } }), false)
  assert.deepEqual(putBody(p, [{ id: 'a' }, { id: 'c' }], { defaultOff: ['c'] }), { types: { a: { im: false }, c: { im: false } }, quietHours: { enabled: true, start: '09:00', end: '07:00' } })
  assert.deepEqual(Object.keys(putBody(p, [], { quietKeys: ['enabled', 'start', 'end', 'applyToX'] }).quietHours), ['enabled', 'start', 'end', 'applyToX'])
  assert.equal(samePrefs(p, normPrefs({ types: p.types, quietHours: p.quietHours })), true)
})

test('notify logic: a host default for quiet hours with its own flags (always present, camelCase or snake_case)', () => {
  const defaultQuiet = { enabled: true, start: '20:00', end: '08:00', applyToX: false }
  assert.deepEqual(normPrefs({ preferences: { types: {} } }, { defaultQuiet }).quietHours, { applyToX: false, enabled: true, start: '20:00', end: '08:00' })
  assert.deepEqual(normPrefs({ quietHours: { enabled: false, apply_to_x: true } }, { defaultQuiet }).quietHours, { applyToX: true, enabled: false, start: '20:00', end: '08:00' })
  assert.deepEqual(normPrefs({ quietHours: { applyToX: true, start: '21:00' } }, { defaultQuiet }).quietHours, { applyToX: true, enabled: true, start: '21:00', end: '08:00' })
  assert.deepEqual(normPrefs({ quietHours: { applyToX: 'yes' } }, { defaultQuiet }).quietHours.applyToX, false, 'wrong type: the default')
  const p = normPrefs({ quietHours: { enabled: true, start: '22:00', end: '06:00', apply_to_x: true } }, { defaultQuiet })
  assert.deepEqual(putBody(p, [], { quietKeys: ['enabled', 'start', 'end', 'applyToX'] }).quietHours, { enabled: true, start: '22:00', end: '06:00', applyToX: true })
})
