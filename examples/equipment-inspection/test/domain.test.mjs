// equipment-inspection's own tests: the business flows behind the protocol (the conformance suite proves the protocol).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { checkNotificationParams, loadManifestFile, validateManifest } from '@dsh-bridge/protocol'
import { addDays, loadManifest, todayIn } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { seedIfEmpty } from '../src/seed.mjs'
import { client, resetTestDatabase, SKIP_REASON, startTestServer, TEST_BFF_SECRET, TEST_SERVICE_TOKEN, UNIT_DATABASE_URL } from './helpers.mjs'

let server
let call
let root
const S = { 'x-service-token': TEST_SERVICE_TOKEN }
const D = (token) => ({ ...S, 'x-delegation-token': token })
const today = () => todayIn('Asia/Tokyo')
let seq = 0
const uniq = () => `${process.pid}${(seq += 1)}`

async function login(loginId, password) {
  const r = await call('POST', '/api/auth/login', { body: { loginId, password } })
  assert.equal(r.status, 200, r.text)
  return { cookie: r.headers.get('set-cookie').split(';')[0] }
}
async function employee(role) {
  const loginId = `t-${role}-${uniq()}`
  const r = await call('POST', '/api/admin/users', { headers: root, body: { loginId, password: 'test-password-1', role, displayName: `テスト ${role}` } })
  assert.equal(r.status, 201, r.text)
  return { id: r.body.user.id, role, headers: await login(loginId, 'test-password-1') }
}
async function link(emp, platform = 'slack') {
  const code = await call('POST', '/bridge/v1/me/link-codes', { headers: emp.headers })
  assert.equal(code.status, 201)
  const source = { platform, teamId: 'T1', userId: `U${uniq()}` }
  const r = await call('POST', '/bridge/v1/identities/link', { headers: S, body: { code: code.body.code, source } })
  assert.equal(r.status, 200, r.text)
  return source
}
async function delegation(source) {
  const r = await call('POST', '/bridge/v1/delegations', { headers: S, body: { source } })
  assert.equal(r.status, 201, r.text)
  return r.body.token
}
async function equipment({ due = 30, assignee = null } = {}) {
  const r = await call('POST', '/api/equipment', { headers: root, body: { code: `EQ-${uniq()}`, name: '消火器', location: '1F', intervalDays: 30, nextDueOn: addDays(today(), due), assigneeUserId: assignee } })
  assert.equal(r.status, 201, r.text)
  return r.body.equipment
}
const events = async (after = 0) => (await call('GET', '/bridge/v1/events', { headers: S, query: { after, limit: 500 } })).body.events

const skip = SKIP_REASON
before(async () => {
  if (skip) return
  server = await startTestServer({ databaseUrl: UNIT_DATABASE_URL })
  call = client(server.base)
  await server.app.auth.createUser(server.pool, { loginId: 'root', password: 'root-password-1', role: 'admin', displayName: 'テスト 管理' })
  root = await login('root', 'root-password-1')
})
after(async () => { await server?.stop() })

describe('manifest', { skip }, () => {
  test('bridge.manifest.yaml is valid without warnings and is what GET /manifest serves (etag, 304)', async () => {
    const file = loadManifestFile(MANIFEST_FILE)
    const v = validateManifest(file)
    assert.deepEqual([v.errors, v.warnings], [[], []])
    const r = await call('GET', '/bridge/v1/manifest', { headers: S })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, file)
    assert.equal(r.headers.get('etag'), loadManifest({ file: MANIFEST_FILE }).etag, 'the etag is derived from the content')
    const again = await call('GET', '/bridge/v1/manifest', { headers: { ...S, 'if-none-match': `W/${r.headers.get('etag')}` } })
    assert.equal(again.status, 304)
    assert.equal(again.headers.get('bridge-protocol'), '1')
  })

  test('every tool of the manifest is a real route of this system', () => {
    for (const tool of server.app.kit.manifest.tools) {
      const [method, path] = tool.http.split(' ')
      assert.ok(server.app.router.match(method, path)?.route, `${tool.name}: ${tool.http} is not routed`)
    }
  })
})

describe('overdue inspection -> event -> deterministic notification', { skip }, () => {
  test('the scan emits inspection.overdue once, recipients are resolved here with typed params, an inspection makes it stale', async () => {
    const inspector = await employee('inspector')
    const manager = await employee('manager')
    const inspectorSource = await link(inspector)
    const managerSource = await link(manager)
    const eq = await equipment({ due: -4, assignee: inspector.id })
    const start = (await events()).at(-1)?.id ?? 0

    const scan = await call('POST', '/api/admin/overdue-scan', { headers: root, body: {} })
    assert.equal(scan.status, 200)
    const hit = scan.body.created.find((x) => x.equipmentId === eq.id)
    assert.ok(hit, 'inspection.overdue emitted')
    const again = await call('POST', '/api/admin/overdue-scan', { headers: root, body: {} })
    assert.ok(!again.body.created.some((x) => x.equipmentId === eq.id), 'one event per equipment and due date')

    const ev = (await events(start)).find((e) => e.id === hit.eventId)
    assert.deepEqual(ev.payload, { equipmentId: eq.id, dueOn: eq.nextDueOn, daysOverdue: 4, assigneeUserId: inspector.id })

    const r = await call('GET', `/bridge/v1/notifications/for-event/${hit.eventId}`, { headers: S, query: { platforms: 'slack' } })
    assert.equal(r.status, 200, r.text)
    const forInspector = r.body.recipients.find((x) => x.userId === inspector.id)
    const forManager = r.body.recipients.find((x) => x.userId === manager.id)
    assert.ok(forInspector && forManager, 'the assignee and the managers')
    assert.equal(forInspector.identity.externalId, inspectorSource.userId)
    assert.equal(forManager.identity.externalId, managerSource.userId)
    assert.equal(forInspector.params.count, 1, 'an inspector counts only their own overdue equipment')
    assert.ok(forManager.params.count >= 1)
    for (const rec of r.body.recipients) {
      const p = checkNotificationParams(rec.template, rec.params, { manifest: server.app.kit.manifest, probes: ['テスト'] })
      assert.ok(p.ok, JSON.stringify(p.problems))
      assert.equal(rec.link, `/equipment/${eq.id}`)
    }

    const done = await call('POST', '/api/inspections', { headers: inspector.headers, body: { equipmentId: eq.id, result: 'ok' } })
    assert.equal(done.status, 201, done.text)
    assert.equal(done.body.inspection.nextDueOn, addDays(today(), 30))
    const stale = await call('GET', `/bridge/v1/notifications/for-event/${hit.eventId}`, { headers: S, query: { platforms: 'slack' } })
    assert.equal(stale.body.stale, 'inspected')
    assert.deepEqual(stale.body.recipients, [])
    assert.ok((await events(start)).some((e) => e.type === 'inspection.completed' && e.payload.equipmentId === eq.id && e.payload.inspectorUserId === inspector.id))
  })

  test('an inspector cannot record the inspection of equipment assigned to someone else', async () => {
    const owner = await employee('inspector')
    const other = await employee('inspector')
    const eq = await equipment({ assignee: owner.id })
    const r = await call('POST', '/api/inspections', { headers: other.headers, body: { equipmentId: eq.id, result: 'ok' } })
    assert.deepEqual([r.status, r.body.error], [403, 'role_not_permitted'])
  })
})

describe('repair request approval (one approval subject)', { skip }, () => {
  test('a manager approves from IM by reply code: the repair request is approved and approval.decided says channel im', async () => {
    const inspector = await employee('inspector')
    const manager = await employee('manager')
    const source = await link(manager, 'wecom-app')
    const eq = await equipment()
    const req = await call('POST', '/api/repair-requests', { headers: inspector.headers, body: { equipmentId: eq.id, estimatedCost: 12000, detail: 'ノズルの破損' } })
    assert.equal(req.status, 201, req.text)
    const approvalId = req.body.approval.id
    const cards = await call('POST', `/bridge/v1/approvals/${approvalId}/deliveries`, { headers: S, body: { platforms: ['wecom-app'] } })
    assert.equal(cards.status, 200, cards.text)
    assert.ok(!cards.body.deliveries.some((d) => d.user.id === inspector.id), 'the requester never gets a card')
    const mine = cards.body.deliveries.find((d) => d.user.id === manager.id)
    assert.ok(JSON.stringify(mine.card).includes('12000円'))
    assert.ok(!JSON.stringify(mine.card).includes('ノズル'), 'free text of the request never reaches the card')
    const start = (await events()).at(-1).id
    const r = await call('POST', '/bridge/v1/approvals/im-decisions', { headers: S, body: { replyCode: mine.replyCode, action: 'approve', source } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.approval.status, 'approved')
    const { rows } = await server.pool.query('select status from repair_request where id = $1', [req.body.repairRequest.id])
    assert.equal(rows[0].status, 'approved')
    const decided = (await events(start)).find((e) => e.type === 'approval.decided' && e.payload.approvalId === approvalId)
    assert.deepEqual([decided.payload.channel, decided.payload.decidedByUserId], ['im', manager.id])
  })

  test('a web decision revokes the IM cards; a reject needs a comment', async () => {
    const inspector = await employee('inspector')
    const manager = await employee('manager')
    const source = await link(manager)
    const eq = await equipment()
    const req = await call('POST', '/api/repair-requests', { headers: inspector.headers, body: { equipmentId: eq.id, estimatedCost: 5000 } })
    const approvalId = req.body.approval.id
    const cards = await call('POST', `/bridge/v1/approvals/${approvalId}/deliveries`, { headers: S, body: { platforms: ['slack'] } })
    const mine = cards.body.deliveries.find((d) => d.user.id === manager.id)
    assert.equal((await call('POST', `/api/approvals/${approvalId}/decision`, { headers: manager.headers, body: { action: 'reject' } })).body.error, 'comment_required')
    assert.equal((await call('POST', `/api/approvals/${approvalId}/decision`, { headers: inspector.headers, body: { action: 'approve' } })).status, 403, 'an inspector does not approve')
    const web = await call('POST', `/api/approvals/${approvalId}/decision`, { headers: manager.headers, body: { action: 'reject', comment: '見積を取り直す' } })
    assert.equal(web.status, 200, web.text)
    const im = await call('POST', `/bridge/v1/approvals/${approvalId}/im-decision`, { headers: S, body: { token: mine.token, action: 'approve', source } })
    assert.deepEqual([im.status, im.body.error], [409, 'delivery_revoked'])
  })
})

describe('delegation = AI allow-list (manifest tools) intersected with the role', { skip }, () => {
  test('an inspector delegation lists only the assigned equipment and cannot list the overdue board; nobody writes', async () => {
    const inspector = await employee('inspector')
    const manager = await employee('manager')
    const mineEq = await equipment({ assignee: inspector.id })
    await equipment({ assignee: manager.id })
    const dIns = await delegation(await link(inspector))
    const dMgr = await delegation(await link(manager))
    const list = await call('GET', '/api/equipment', { headers: D(dIns) })
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.equipment.map((e) => e.id), [mineEq.id])
    assert.equal((await call('GET', '/api/inspections/overdue', { headers: D(dIns) })).body.error, 'delegation_not_permitted')
    assert.equal((await call('GET', '/api/inspections/overdue', { headers: D(dMgr) })).status, 200)
    const write = await call('POST', '/api/inspections', { headers: D(dMgr), body: { equipmentId: mineEq.id, result: 'ok' } })
    assert.deepEqual([write.status, write.body.error], [403, 'delegation_not_permitted'])
  })

  test('deactivating an employee ends their delegations', async () => {
    const inspector = await employee('inspector')
    const token = await delegation(await link(inspector))
    assert.equal((await call('GET', '/api/equipment', { headers: D(token) })).status, 200)
    assert.equal((await call('PATCH', `/api/admin/users/${inspector.id}`, { headers: root, body: { active: false } })).status, 200)
    assert.equal((await call('GET', '/api/equipment', { headers: D(token) })).body.error, 'invalid_delegation_token')
  })
})

describe('proposals and reports', { skip }, () => {
  test('the AI proposes a reschedule as an inspector; a manager accepts and only then the due date changes', async () => {
    const inspector = await employee('inspector')
    const manager = await employee('manager')
    const eq = await equipment({ due: 3, assignee: inspector.id })
    const token = await delegation(await link(inspector))
    const dueOn = addDays(today(), 20)
    const p = await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'inspection_reschedule', payload: { equipmentId: eq.id, dueOn } } })
    assert.equal(p.status, 201, p.text)
    assert.equal((await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: inspector.headers })).status, 403, 'an inspector does not accept')
    const own = await call('GET', '/bridge/v1/proposals', { headers: D(token) })
    assert.deepEqual(own.body.proposals.map((x) => x.id), [p.body.proposal.id], 'a delegation sees its own proposals only')
    const dueOf = async () => (await server.pool.query(`select to_char(next_due_on, 'YYYY-MM-DD') as d from equipment where id = $1`, [eq.id])).rows[0].d
    assert.equal(await dueOf(), eq.nextDueOn)
    const ok = await call('POST', `/bridge/v1/proposals/${p.body.proposal.id}/accept`, { headers: manager.headers })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(await dueOf(), dueOn)
    const bad = await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'inspection_reschedule', payload: { equipmentId: eq.id, dueOn: '2001-01-01' } } })
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_payload'])
    const retire = await call('POST', '/bridge/v1/proposals', { headers: D(token), body: { kind: 'equipment_retire', payload: { equipmentId: eq.id } } })
    assert.deepEqual([retire.status, retire.body.error], [403, 'role_not_permitted'])
  })

  test('report sections are counts scoped by role; a test run is stored and read back; scheduled slots are unique', async () => {
    const inspector = await employee('inspector')
    await equipment({ due: -2, assignee: inspector.id })
    const token = await delegation(await link(inspector))
    const live = await call('GET', '/bridge/v1/reports/latest', { headers: D(token) })
    assert.equal(live.status, 200)
    assert.deepEqual(Object.keys(live.body.report.sections).sort(), ['inspections', 'overdue'])
    assert.equal(live.body.report.sections.overdue.count, 1, 'own assigned equipment only')
    const run = await call('POST', '/bridge/v1/reports/run', { headers: root, body: { to: 'me' } })
    assert.equal(run.status, 201, run.text)
    assert.deepEqual(Object.keys(run.body.report.sections).sort(), ['equipment', 'inspections', 'overdue', 'repairs'])
    const latest = await call('GET', '/bridge/v1/reports/latest', { headers: root })
    assert.equal(latest.body.report.id, run.body.report.id)
    const slot = `t${uniq()}`
    assert.ok(await server.app.kit.reports.generate({ slot }))
    assert.equal(await server.app.kit.reports.generate({ slot }), null, 'one scheduled report per date and slot')
  })
})

describe('the self-service page and the guards', { skip }, () => {
  test('GET / serves the link page with a strict CSP and the protocol header', async () => {
    const r = await call('GET', '/')
    assert.equal(r.status, 200)
    assert.match(r.text, /連携コードを発行/)
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/)
    assert.equal(r.headers.get('bridge-protocol'), '1')
    assert.equal((await call('GET', '/app.js')).status, 200)
  })

  test('the link page flow: login cookie -> link code -> my links -> unlink', async () => {
    const emp = await employee('inspector')
    const source = await link(emp, 'line')
    const mine = await call('GET', '/bridge/v1/me/identities', { headers: emp.headers })
    const row = mine.body.identities.find((i) => i.externalId === source.userId)
    assert.equal(row.platform, 'line')
    const del = await call('DELETE', `/bridge/v1/me/identities/${row.id}`, { headers: emp.headers })
    assert.equal(del.status, 200)
    assert.equal((await call('GET', '/bridge/v1/identity', { headers: S, query: { platform: 'line', teamId: 'T1', userId: source.userId } })).body.linked, false)
  })

  test('personal bot registration is BFF only (the page never has the secret)', async () => {
    const emp = await employee('inspector')
    const body = { platform: 'weixin', botId: `wx-${uniq()}@im.bot` }
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: emp.headers, body })).body.error, 'bff_only')
    assert.equal((await call('POST', '/bridge/v1/me/personal-bots', { headers: { ...emp.headers, 'x-bff-secret': TEST_BFF_SECRET }, body })).status, 201)
    assert.ok((await server.app.store.listAudit({ action: 'bff_only.refused' })).length >= 1, 'the refusal is audited')
  })

  test('login is throttled per login id; a device session uses a bearer token', async () => {
    const loginId = `nobody-${uniq()}`
    for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/api/auth/login', { body: { loginId, password: 'wrong-password' } })).status, 401)
    assert.equal((await call('POST', '/api/auth/login', { body: { loginId, password: 'wrong-password' } })).body.error, 'too_many_attempts')
    const bearer = await call('POST', '/api/auth/login', { body: { loginId: 'root', password: 'root-password-1', mode: 'bearer' } })
    assert.equal((await call('GET', '/api/me', { headers: { authorization: `Bearer ${bearer.body.token}` } })).body.user.role, 'admin')
  })
})

describe('configuration (no database needed)', () => {
  test('the configuration refuses the databases of other systems; only *_test databases are reset', async () => {
    for (const name of ['care', 'care_ui', 'care_test', 'care_joint', 'bridge_demo', 'postgres']) {
      assert.throws(() => loadConfig({ EQUIPMENT_DATABASE_URL: `postgres://u:p@127.0.0.1:5432/${name}` }), /refuses/)
    }
    await assert.rejects(resetTestDatabase('postgres://u:p@127.0.0.1:5432/equipment_inspection'), /only databases matching/)
    await assert.rejects(resetTestDatabase('postgres://u:p@127.0.0.1:5432/bridge_demo_test'), /protected/)
    assert.throws(() => loadConfig({ NODE_ENV: 'production', EQUIPMENT_DATABASE_URL: 'postgres://u:p@h/equipment_inspection' }), /required when NODE_ENV=production/)
    assert.throws(() => loadConfig({}), /EQUIPMENT_DATABASE_URL is required/)
  })
})

describe('seed', { skip }, () => {
  test('the fictional seed runs only on an empty database', async () => {
    assert.equal(await seedIfEmpty({ pool: server.pool, auth: server.app.auth, password: 'x' }), false)
  })
})

describe('pii-scan: the roster check (hooks.piiScan)', { skip }, () => {
  test('a staff name in the text is personal data (category only); a plain sentence is not', async () => {
    const hit = await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text: '今日は テスト 管理 さんに確認する' } })
    assert.deepEqual([hit.status, hit.body.containsPersonalData, hit.body.kinds], [200, true, ['staff_name']])
    assert.ok(!JSON.stringify(hit.body).includes('テスト'), 'the name itself is never returned')
    // the roster has 「テスト 管理」 (with a space): written without the space, it is still found
    const joined = await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text: '今日はテスト管理さんに確認する' } })
    assert.deepEqual([joined.status, joined.body.kinds], [200, ['staff_name']])
    const plain = await call('POST', '/bridge/v1/pii-scan', { headers: S, body: { text: '点検の結果は先に要点を3行で書く' } })
    assert.deepEqual([plain.status, plain.body.containsPersonalData], [200, false])
  })
})
