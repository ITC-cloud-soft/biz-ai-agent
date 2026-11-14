// Conformance fixtures for leave-requests (the BRIDGE_FIXTURES module of the generic HTTP adapter of @dsh-bridge/protocol).
// The instance runs in the same process (test/conformance.test.mjs puts it in globalThis.__leaveRequests): employees and
// business data are created through the system's OWN API; only what no API offers on purpose — the bootstrap admin,
// making time pass and trying the event writer with a bad payload — uses the instance directly.
import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, createEventWriter, EventRejected, loadManifest, sha256, todayIn } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE } from '../src/app.mjs'

/** The suite speaks some generic role names; they map onto this system's roles. */
const ROLE_OF = { admin: 'admin', manager: 'manager', staff: 'staff', billing: 'staff' }
class Rollback extends Error {}

export default async function createFixtures({ baseUrl }) {
  const app = globalThis.__leaveRequests
  if (!app) throw new Error('start the instance in this process first (test/conformance.test.mjs)')
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const emitEvent = createEventWriter(manifest)
  const rnd = () => randomBytes(4).toString('hex')
  const today = () => todayIn('UTC')
  const probes = []

  const http = async (method, path, headers = {}, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
  const expect = (r, status, what) => {
    if (r.status !== status) throw new Error(`${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  const cookieOf = async (loginId, password) => {
    const r = await http('POST', '/api/auth/login', {}, { loginId, password })
    expect(r, 200, `login ${loginId}`)
    return r.headers.get('set-cookie').split(';')[0]
  }

  // the bootstrap administrator (the only employee written directly)
  const rootPassword = `pw-${randomBytes(12).toString('hex')}`
  const rootUser = await app.createUser({ loginId: `cf-root-${rnd()}`, password: rootPassword, role: 'admin', displayName: `Test Root ${rnd()}` })
  const root = { id: rootUser.id, role: 'admin', headers: { cookie: await cookieOf(rootUser.loginId, rootPassword) } }

  async function newEmployee(role) {
    const real = ROLE_OF[role]
    if (!real) throw new Error(`no role mapping for "${role}"`)
    const loginId = `cf-${real}-${rnd()}`
    const password = `pw-${randomBytes(12).toString('hex')}`
    const displayName = `Test ${real} ${rnd()}`
    const created = expect(await http('POST', '/api/admin/users', root.headers, { loginId, password, role: real, displayName }), 201, 'create employee')
    probes.push(displayName, loginId)
    return { id: created.user.id, role: real, headers: { cookie: await cookieOf(loginId, password) } }
  }

  const leaveFor = async (emp) => expect(await http('POST', '/api/leave-requests', emp.headers, { startsOn: addDays(today(), 10), endsOn: addDays(today(), 11) }), 201, 'leave request')

  async function unansweredEventFor(employee) {
    const requester = employee?.role === 'staff' ? employee : await newEmployee('staff')
    const { leaveRequest } = await leaveFor(requester)
    const scan = expect(await http('POST', '/api/admin/unanswered-scan', root.headers, { minDays: 0 }), 200, 'unanswered scan')
    const hit = scan.created.find((x) => x.leaveRequestId === leaveRequest.id)
    if (!hit) throw new Error('the scan did not emit leave.unanswered for the new request')
    return { eventId: hit.eventId, type: 'leave.unanswered' }
  }

  const employees = { admin: await newEmployee('admin'), manager: await newEmployee('manager'), staff: await newEmployee('staff') }
  let requester = null

  return {
    platform: `t${rnd()}`,
    personalBotPlatform: 'weixin',
    capabilities: { personalBots: true, approvals: true },
    roles: Object.keys(manifest.roles),
    employees,
    newEmployee,
    probes: async () => [...probes],
    hooks: {
      latestEventCursor: () => app.store.latestEventId(),
      expireLinkCode: (emp) => app.store.expireLinkCodes(emp.id),
      expireDelegation: (token) => app.store.expireDelegation(sha256(token)),
      revokeSession: async (emp) => { expect(await http('POST', '/api/auth/logout', emp.headers), 200, 'logout') },
      deactivateEmployee: async (emp) => { expect(await http('PATCH', `/api/admin/users/${emp.id}`, root.headers, { active: false }), 200, 'deactivate') },
      // the audience of leave.unanswered is the requester and the managers: a staff member is told as the requester
      emitNotifiableEvent: async ({ employee }) => unansweredEventFor(employee),
      createPendingApproval: async () => {
        requester ??= await newEmployee('staff')
        return { approvalId: (await leaveFor(requester)).approval.id, approverRole: 'manager' }
      },
      produceEvents: async () => {
        requester ??= await newEmployee('staff')
        await leaveFor(requester)
        await unansweredEventFor(null)
      },
      // never leaves an event behind: an accepted write is rolled back
      tryEmitEvent: async ({ type, payload }) => {
        try {
          await app.store.tx(async (t) => {
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
        const staff = await newEmployee('staff')
        const { leaveRequest } = await leaveFor(staff)
        // a manager's AI may propose new dates for anyone's pending request (staff: only for their own)
        return { role: 'manager', reviewerRole: 'manager', kind: 'leave_new_dates', payload: { leaveRequestId: leaveRequest.id, startsOn: addDays(today(), 20), endsOn: addDays(today(), 21) } }
      },
      proposalForbiddenSample: async () => {
        const staff = await newEmployee('staff')
        const { leaveRequest } = await leaveFor(staff)
        return { role: 'staff', kind: 'leave_cancel', payload: { leaveRequestId: leaveRequest.id } }
      },
      writeProbes: [
        { method: 'POST', path: '/api/leave-requests', body: { startsOn: '2030-01-01', endsOn: '2030-01-02' } },
        { method: 'POST', path: '/api/approvals/{id}/decision', body: { action: 'approve' } },
        { method: 'POST', path: '/api/admin/users', body: { loginId: 'probe-user', password: 'probe-password', role: 'admin', displayName: 'x' } },
        { method: 'PATCH', path: '/api/admin/users/{id}', body: { active: false } },
        { method: 'POST', path: '/api/admin/unanswered-scan', body: {} },
        { method: 'PUT', path: '/bridge/v1/me/notification-preferences', body: { types: {} } },
      ],
    },
    stop: async () => {},
  }
}

export const knownGaps = {}
