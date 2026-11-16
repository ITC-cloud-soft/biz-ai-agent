// Conformance fixtures for equipment-inspection (the BRIDGE_FIXTURES module of the generic HTTP adapter of
// @dsh-bridge/protocol: conformance/adapters/http.mjs).
//
//   BRIDGE_BASE_URL=http://127.0.0.1:19730 BRIDGE_SERVICE_TOKEN=... BRIDGE_BFF_SECRET=... \
//   BRIDGE_FIXTURES=examples/equipment-inspection/test/fixtures.mjs EQUIPMENT_DATABASE_URL=postgres://.../fw_equipment_test \
//   node --test packages/protocol/conformance/http.test.mjs
//
// Employees and business data are created through the system's OWN business API (an admin session); only what no API
// offers on purpose - the bootstrap admin, making time pass (expire a link code / delegation) and trying the event
// writer with a bad payload - goes through the TEST database (the kit's store). Run it against a test instance only.
import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, createEventWriter, createPool, createPostgresStore, databaseName, EventRejected, loadManifest, sha256, todayIn } from '@dsh-bridge/server-kit'
import { createAuth } from '../src/auth.mjs'
import { MANIFEST_FILE } from '../src/app.mjs'

/** The suite speaks some generic role names (staff, billing); they map onto this system's roles. */
const ROLE_OF = { admin: 'admin', manager: 'manager', inspector: 'inspector', staff: 'inspector', billing: 'inspector' }

class Rollback extends Error {}

export default async function createFixtures({ baseUrl, env }) {
  const url = env.EQUIPMENT_DATABASE_URL
  if (!url) throw new Error('EQUIPMENT_DATABASE_URL (the TEST database of the instance under test) is required')
  if (!databaseName(url).endsWith('_test')) throw new Error('the conformance fixtures run against a *_test database only')
  const pool = await createPool(url, { max: 3 })
  const store = createPostgresStore({ pool })
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const emitEvent = createEventWriter(manifest)
  const today = () => todayIn(manifest.system.timezone)
  const rnd = () => randomBytes(4).toString('hex')
  const probes = []

  const http = async (method, path, headers = {}, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
  const expect = (r, status, what) => {
    if (r.status !== status) throw new Error(`${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  const login = async (loginId, password) => {
    const r = await http('POST', '/api/auth/login', {}, { loginId, password })
    expect(r, 200, `login ${loginId}`)
    return r.headers.get('set-cookie').split(';')[0]
  }

  // the bootstrap administrator (the only employee written directly; everything else goes through the business API)
  const rootLogin = `cf-root-${rnd()}`
  const rootPassword = `pw-${randomBytes(12).toString('hex')}`
  const rootUser = await createAuth({ pool }).createUser(pool, { loginId: rootLogin, password: rootPassword, role: 'admin', displayName: `試験 管理 ${rnd()}` })
  const root = { id: rootUser.id, role: 'admin', headers: { cookie: await login(rootLogin, rootPassword) } }

  async function newEmployee(role) {
    const real = ROLE_OF[role]
    if (!real) throw new Error(`no role mapping for "${role}"`)
    const loginId = `cf-${real}-${rnd()}`
    const password = `pw-${randomBytes(12).toString('hex')}`
    const displayName = `試験 ${real} ${rnd()}`
    const created = expect(await http('POST', '/api/admin/users', root.headers, { loginId, password, role: real, displayName }), 201, 'create employee')
    probes.push(displayName, loginId)
    return { id: created.user.id, role: real, headers: { cookie: await login(loginId, password) } }
  }

  async function newEquipment({ dueInDays = 30, assignee = null } = {}) {
    const name = `試験設備 ${rnd()}`
    probes.push(name)
    const body = { code: `CF-${rnd()}`, name, location: `試験棟 ${rnd()}`, intervalDays: 30, nextDueOn: addDays(today(), dueInDays), assigneeUserId: assignee }
    return expect(await http('POST', '/api/equipment', root.headers, body), 201, 'create equipment').equipment
  }

  let requester = null
  async function pendingApproval() {
    requester ??= await newEmployee('inspector')
    const eq = await newEquipment()
    const r = expect(await http('POST', '/api/repair-requests', requester.headers, { equipmentId: eq.id, estimatedCost: 35000, detail: '試験の修理依頼' }), 201, 'repair request')
    return r.approval.id
  }

  async function overdueEventFor(employee) {
    const eq = await newEquipment({ dueInDays: -3, assignee: employee?.id ?? null })
    const scan = expect(await http('POST', '/api/admin/overdue-scan', root.headers, {}), 200, 'overdue scan')
    const hit = scan.created.find((x) => x.equipmentId === eq.id)
    if (!hit) throw new Error('the overdue scan did not emit inspection.overdue for the new equipment')
    return { eventId: hit.eventId, type: 'inspection.overdue' }
  }

  const employees = { admin: await newEmployee('admin'), manager: await newEmployee('manager'), inspector: await newEmployee('inspector') }
  employees.staff = employees.inspector

  return {
    platform: `t${rnd()}`,
    personalBotPlatform: 'weixin',
    capabilities: { personalBots: true, approvals: true },
    roles: Object.keys(manifest.roles),
    employees,
    newEmployee,
    probes: async () => [...probes],
    hooks: {
      latestEventCursor: () => store.latestEventId(),
      expireLinkCode: (emp) => store.expireLinkCodes(emp.id),
      expireDelegation: (token) => store.expireDelegation(sha256(token)),
      revokeSession: async (emp) => { expect(await http('POST', '/api/auth/logout', emp.headers), 200, 'logout') },
      deactivateEmployee: async (emp) => { expect(await http('PATCH', `/api/admin/users/${emp.id}`, root.headers, { active: false }), 200, 'deactivate') },
      emitNotifiableEvent: async ({ employee }) => overdueEventFor(employee),
      createPendingApproval: async () => ({ approvalId: await pendingApproval(), approverRole: 'manager' }),
      produceEvents: async () => {
        const eq = await newEquipment()
        expect(await http('POST', '/api/inspections', root.headers, { equipmentId: eq.id, result: 'ng', note: '試験の点検' }), 201, 'inspection')
        await pendingApproval()
        await overdueEventFor(null)
      },
      // never leaves an event behind: an accepted write is rolled back
      tryEmitEvent: async ({ type, payload }) => {
        try {
          await store.tx(async (t) => {
            await emitEvent(t, { type, aggregateType: 'conformance', aggregateId: randomUUID(), payload })
            throw new Rollback()
          })
          return { accepted: true }
        } catch (error) {
          if (error instanceof Rollback) return { accepted: true }
          if (error instanceof EventRejected) return { accepted: false, reason: error.reason }
          throw error
        }
      },
      proposalSample: async () => {
        const eq = await newEquipment()
        return { role: 'inspector', reviewerRole: 'manager', kind: 'inspection_reschedule', payload: { equipmentId: eq.id, dueOn: addDays(today(), 14) } }
      },
      proposalForbiddenSample: async () => {
        const eq = await newEquipment()
        return { role: 'inspector', kind: 'equipment_retire', payload: { equipmentId: eq.id } }
      },
      writeProbes: [
        { method: 'POST', path: '/api/equipment', body: { code: 'CF-PROBE', name: 'x', intervalDays: 30, nextDueOn: '2030-01-01' } },
        { method: 'POST', path: '/api/inspections', body: { equipmentId: '00000000-0000-4000-8000-000000000000', result: 'ok' } },
        { method: 'POST', path: '/api/repair-requests', body: { equipmentId: '00000000-0000-4000-8000-000000000000', estimatedCost: 1 } },
        { method: 'POST', path: '/api/approvals/{id}/decision', body: { action: 'approve' } },
        { method: 'POST', path: '/api/admin/users', body: { loginId: 'probe-user', password: 'probe-password', role: 'admin', displayName: 'x' } },
        { method: 'PATCH', path: '/api/admin/users/{id}', body: { active: false } },
        { method: 'POST', path: '/api/admin/overdue-scan', body: {} },
        { method: 'PUT', path: '/bridge/v1/me/notification-preferences', body: { types: {} } },
      ],
    },
    stop: async () => { await pool.end() },
  }
}

export const knownGaps = {}
