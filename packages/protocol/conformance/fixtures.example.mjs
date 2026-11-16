// Fixtures for the Bridge conformance suite: how the suite gets employees, sessions and test data out of YOUR system.
// Copy this file, fill it in, and point BRIDGE_FIXTURES at it. It must only ever run against a TEST instance.
//
// Everything the suite does through /bridge/v1 uses the protocol itself. What the protocol cannot do (create employees,
// log them in, make time pass, create business data) comes from these fixtures.
//
// export default async function createFixtures({ baseUrl, serviceToken, bffSecret, env }) -> Fixtures
//
// Fixtures (required)
//   platform                 unique IM platform name for this run, /^[a-z][a-z0-9_-]{1,31}$/ (so a shared test instance is not polluted)
//   roles                    every role id of your manifest (the suite probes every role's delegation ceiling)
//   employees                { <role>: Employee } one logged-in, ACTIVE, NOT linked employee per role. Must include admin, manager, staff.
//   newEmployee(role)        creates a fresh active employee of that role with its own login session -> Employee
//     Employee = { id, role, headers }   headers = what an employee's own session sends ({ cookie: '...' } or { authorization: 'Bearer ...' })
// Fixtures (optional, each enables more checks; a missing one SKIPS the checks that need it)
//   personalBotPlatform      platform name that supports personal bots (e.g. 'weixin'); capabilities.personalBots = false turns B1-B4 off
//   capabilities             { personalBots?: boolean, approvals?: boolean }
//   probes()                 async -> string[] of personal strings that exist in your test data (names, kana, ...) and must NEVER appear
//                            in events, IM parameters, links or approval cards
//   hooks.latestEventCursor()                    async -> the highest event id (default: the suite pages through /events)
//   hooks.expireLinkCode(employee)               make that employee's unused link code expire        (checks L5)
//   hooks.expireDelegation(token)                make that delegation token expire                   (check D6)
//   hooks.revokeSession(employee)                end the employee's web session (logout)             (check S4)
//   hooks.deactivateEmployee(employee)           deactivate the employee                             (checks D7, S5)
//   hooks.emitNotifiableEvent({ employee, platform })  async -> { eventId, type }: write a business event whose notification
//                                                audience includes `employee` (checks N1-N3)
//   hooks.createPendingApproval()                async -> { approvalId, approverRole }: an approval that an employee of
//                                                approverRole may decide (checks A1-A4)
//   hooks.produceEvents()                        make the system emit a few different event types (check E2)
//   hooks.tryEmitEvent({ type, payload })        async -> { accepted }: try to write an event through the system's own event
//                                                writer; it must refuse a non-whitelisted key / undeclared type (check E3)
//   hooks.proposalSample()                       async -> { role, reviewerRole, kind, payload }: a proposal an employee of
//                                                `role` (through a delegation) may create and `reviewerRole` may decide (PR1-PR2)
//   hooks.proposalForbiddenSample()              async -> { role, kind, payload }: a proposal `role` must NOT be allowed to create (PR3)
//   hooks.writeProbes                            [{ method, path, body? }] business write endpoints a delegation must never reach
//                                                ({name} placeholders get random UUIDs)                    (checks D5, S3)
//   stop()                                       cleanup

import { randomUUID } from 'node:crypto'

export default async function createFixtures({ baseUrl, env }) {
  // Example only: replace with calls into YOUR test instance (admin API, seed scripts, direct DB access ...).
  const login = async (email, password) => {
    const res = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
    return res.headers.get('set-cookie').split(';')[0]
  }
  const newEmployee = async (role) => {
    const email = `${role}-${randomUUID().slice(0, 8)}@test.invalid`
    const password = `pw-${randomUUID()}`
    // ... create the employee in your test instance here (admin API / SQL) ...
    return { id: '<id of the created employee>', role, headers: { cookie: await login(email, password) } }
  }
  const roles = ['admin', 'manager', 'staff']
  const employees = {}
  for (const role of roles) employees[role] = await newEmployee(role)
  return {
    platform: `t${randomUUID().slice(0, 8)}`,
    roles,
    employees,
    newEmployee,
    capabilities: { personalBots: false, approvals: false },
    hooks: {},
    probes: async () => [],
    env,
  }
}

export const knownGaps = {}
