// Conformance fixtures for expense-claims (the BRIDGE_FIXTURES module of the generic HTTP adapter of @dsh-bridge/protocol).
// The instance runs in the same process (test/conformance.test.mjs puts it in globalThis.__expenseClaims): employees and
// claims are created through the system's OWN API; only what no API offers on purpose — the bootstrap admin, making time pass
// (a claim's submission moved into the past) and trying the event writer with a bad payload — uses the instance directly.
import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, createEventWriter, EventRejected, loadManifest, sha256, todayIn } from '@dsh-bridge/server-kit'
import { APPROVAL_LIMIT_YEN, MANIFEST_FILE, TIME_ZONE } from '../src/app.mjs'

/** The suite speaks some generic role names; they map onto this system's roles. */
const ROLE_OF = { admin: 'admin', manager: 'manager', staff: 'staff', billing: 'staff' }
class Rollback extends Error {}

export default async function createFixtures({ baseUrl }) {
  const app = globalThis.__expenseClaims
  if (!app) throw new Error('start the instance in this process first (test/conformance.test.mjs)')
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const emitEvent = createEventWriter(manifest)
  const rnd = () => randomBytes(4).toString('hex')
  const today = () => todayIn(TIME_ZONE)
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

  async function newEmployee(role, { managerId = null } = {}) {
    const real = ROLE_OF[role]
    if (!real) throw new Error(`no role mapping for "${role}"`)
    const loginId = `cf-${real}-${rnd()}`
    const password = `pw-${randomBytes(12).toString('hex')}`
    const displayName = `Test ${real} ${rnd()}`
    const created = expect(await http('POST', '/api/admin/users', root.headers, { loginId, password, role: real, displayName, ...(managerId ? { managerId } : {}) }), 201, 'create employee')
    probes.push(displayName, loginId)
    return { id: created.user.id, role: real, headers: { cookie: await cookieOf(loginId, password) } }
  }

  /** A claim on the web: small (the claimant's manager decides) or large (an administrator decides). */
  const claimFor = async (emp, { large = false } = {}) => expect(await http('POST', '/api/expense-claims', emp.headers, {
    spentOn: addDays(today(), -3), category: large ? 'lodging' : 'transport', amountYen: large ? APPROVAL_LIMIT_YEN + 15_000 : 4_800, note: 'Conformance test claim',
  }), 201, 'claim')

  /** expense.claim_waiting for an approver: a claim of their own team member (manager) or a large one (admin), 4 days old. */
  async function waitingEventFor(approver) {
    if (approver && approver.role === 'staff') throw new Error('expense.claim_waiting goes to the approver only: a staff member is never told')
    const asManager = approver?.role === 'manager'
    const claimant = await newEmployee('staff', asManager ? { managerId: approver.id } : {})
    const { claim } = await claimFor(claimant, { large: !asManager })
    // making time pass: the claim was submitted 4 days ago (more than 3)
    Object.assign(app.data.claims.get(claim.id), { createdAt: new Date(Date.now() - 4 * 86_400_000), submittedOn: addDays(today(), -4) })
    const scan = expect(await http('POST', '/api/admin/waiting-scan', root.headers, {}), 200, 'waiting scan')
    const hit = scan.created.find((x) => x.claimId === claim.id)
    if (!hit) throw new Error('the scan did not emit expense.claim_waiting for the new claim')
    return { eventId: hit.eventId, type: 'expense.claim_waiting' }
  }

  const admin = await newEmployee('admin')
  const manager = await newEmployee('manager', { managerId: admin.id })
  const staff = await newEmployee('staff', { managerId: manager.id })
  const employees = { admin, manager, staff }
  let claimant = null

  return {
    platform: `t${rnd()}`,
    personalBotPlatform: 'weixin',
    capabilities: { personalBots: true, approvals: true },
    roles: Object.keys(manifest.roles),
    employees,
    newEmployee: (role) => newEmployee(role),
    probes: async () => [...probes],
    hooks: {
      latestEventCursor: () => app.store.latestEventId(),
      expireLinkCode: (emp) => app.store.expireLinkCodes(emp.id),
      expireDelegation: (token) => app.store.expireDelegation(sha256(token)),
      revokeSession: async (emp) => { expect(await http('POST', '/api/auth/logout', emp.headers), 200, 'logout') },
      deactivateEmployee: async (emp) => { expect(await http('PATCH', `/api/admin/users/${emp.id}`, root.headers, { active: false }), 200, 'deactivate') },
      // the audience of expense.claim_waiting is the claim's approver (the claimant's manager, or an administrator)
      emitNotifiableEvent: async ({ employee }) => waitingEventFor(employee),
      // a large claim: ANY active administrator but the claimant may decide it (a fresh manager is nobody's manager)
      createPendingApproval: async () => {
        claimant ??= await newEmployee('staff')
        return { approvalId: (await claimFor(claimant, { large: true })).approval.id, approverRole: 'admin' }
      },
      produceEvents: async () => {
        claimant ??= await newEmployee('staff')
        await claimFor(claimant)
        await waitingEventFor(null)
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
      // an administrator's AI (a fresh administrator: they see every claim) proposes a correction; the kit's reviewers are the
      // administrators (they may reject it); only the claimant could ACCEPT it (test/app.test.mjs)
      proposalSample: async () => {
        const who = await newEmployee('staff')
        const { claim } = await claimFor(who)
        return { role: 'admin', reviewerRole: 'admin', kind: 'expense_correct_claim', payload: { claimId: claim.id, category: 'supplies', reasonCode: 'category_mismatch' } }
      },
      // the audit sample is for administrators' AI only
      proposalForbiddenSample: async () => ({ role: 'staff', kind: 'expense_audit_sample', payload: { claimId: randomUUID(), reasonCode: 'random_sample' } }),
      writeProbes: [
        { method: 'POST', path: '/api/expense-claims', body: { spentOn: today(), category: 'transport', amountYen: 1000, note: 'probe' } },
        { method: 'POST', path: '/api/approvals/{id}/decision', body: { action: 'approve' } },
        { method: 'POST', path: `/api/expense-claims/${randomUUID()}/corrections/{id}/decision`, body: { action: 'accept' } },
        { method: 'POST', path: '/api/admin/users', body: { loginId: 'probe-user', password: 'probe-password', role: 'admin', displayName: 'x' } },
        { method: 'PATCH', path: '/api/admin/users/{id}', body: { active: false } },
        { method: 'POST', path: '/api/admin/waiting-scan', body: {} },
        { method: 'PUT', path: '/bridge/v1/me/notification-preferences', body: { types: {} } },
      ],
    },
    stop: async () => {},
  }
}

export const knownGaps = {}
