// Conformance fixtures for equipment-loans (the BRIDGE_FIXTURES module of the generic HTTP adapter of @dsh-bridge/protocol).
// The instance runs in the same process (test/conformance.test.mjs puts it in globalThis.__equipmentLoans): employees, items
// and loans are created through the system's OWN API; only what no API offers on purpose — the bootstrap admin, making time
// pass (a loan's days moved into the past) and trying the event writer with a bad payload — uses the instance directly.
import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, createEventWriter, EventRejected, loadManifest, sha256, todayIn } from '@dsh-bridge/server-kit'
import { MANIFEST_FILE } from '../src/app.mjs'

/** The suite speaks some generic role names; they map onto this system's roles. */
const ROLE_OF = { admin: 'admin', manager: 'manager', staff: 'staff', billing: 'staff' }
class Rollback extends Error {}

export default async function createFixtures({ baseUrl }) {
  const app = globalThis.__equipmentLoans
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

  // every loan gets its own item, so bookings never clash
  let tag = 0
  const newItem = async (highValue) => expect(await http('POST', '/api/admin/equipment', root.headers, {
    assetTag: `CF-${String(++tag).padStart(4, '0')}`, kind: highValue ? 'camera' : 'projector', highValue,
  }), 201, 'item').item
  /** A loan that waits for a manager (a high-value item) or one booked at once (a standard item, 2 days). */
  const loanFor = async (emp, { highValue = true } = {}) => {
    const item = await newItem(highValue)
    return expect(await http('POST', '/api/loans', emp.headers, { itemId: item.id, startsOn: addDays(today(), 10), dueOn: addDays(today(), 11) }), 201, 'loan')
  }

  async function overdueEventFor(employee) {
    const borrower = employee?.role === 'staff' ? employee : await newEmployee('staff')
    const { loan } = await loanFor(borrower, { highValue: false })
    // making time pass: the loan started 5 days ago and was due 2 days ago
    Object.assign(app.data.loans.get(loan.id), { startsOn: addDays(today(), -5), dueOn: addDays(today(), -2) })
    const scan = expect(await http('POST', '/api/admin/overdue-scan', root.headers, {}), 200, 'overdue scan')
    const hit = scan.created.find((x) => x.loanId === loan.id)
    if (!hit) throw new Error('the scan did not emit loan.overdue for the new loan')
    return { eventId: hit.eventId, type: 'loan.overdue' }
  }

  const employees = { admin: await newEmployee('admin'), manager: await newEmployee('manager'), staff: await newEmployee('staff') }
  let borrower = null

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
      // the audience of loan.overdue is the borrower and the managers: a staff member is told as the borrower
      emitNotifiableEvent: async ({ employee }) => overdueEventFor(employee),
      createPendingApproval: async () => {
        borrower ??= await newEmployee('staff')
        return { approvalId: (await loanFor(borrower)).approval.id, approverRole: 'manager' }
      },
      produceEvents: async () => {
        borrower ??= await newEmployee('staff')
        await loanFor(borrower)
        await overdueEventFor(null)
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
        const { loan } = await loanFor(staff)
        // a manager's AI may propose new dates for anyone's waiting loan (staff: only for their own)
        return { role: 'manager', reviewerRole: 'manager', kind: 'loan_new_dates', payload: { loanId: loan.id, startsOn: addDays(today(), 20), dueOn: addDays(today(), 21) } }
      },
      proposalForbiddenSample: async () => {
        const staff = await newEmployee('staff')
        const { loan } = await loanFor(staff)
        return { role: 'staff', kind: 'loan_cancel', payload: { loanId: loan.id } }
      },
      writeProbes: [
        { method: 'POST', path: '/api/loans', body: { itemId: randomUUID(), startsOn: '2030-01-01', dueOn: '2030-01-02' } },
        { method: 'POST', path: '/api/loans/{id}/return', body: {} },
        { method: 'POST', path: '/api/approvals/{id}/decision', body: { action: 'approve' } },
        { method: 'POST', path: '/api/admin/equipment', body: { assetTag: 'PRB-0001', kind: 'laptop', highValue: false } },
        { method: 'POST', path: '/api/admin/users', body: { loginId: 'probe-user', password: 'probe-password', role: 'admin', displayName: 'x' } },
        { method: 'PATCH', path: '/api/admin/users/{id}', body: { active: false } },
        { method: 'POST', path: '/api/admin/overdue-scan', body: {} },
        { method: 'PUT', path: '/bridge/v1/me/notification-preferences', body: { types: {} } },
      ],
    },
    stop: async () => {},
  }
}

export const knownGaps = {}
