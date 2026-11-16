// Mutation tests: the conformance checks must PASS on a correct mock and FAIL when one invariant is deliberately broken.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createTarget } from '../conformance/lib/target.mjs'
import { buildContext } from '../conformance/lib/context.mjs'
import { collectChecks, executeCheck } from '../conformance/suite.mjs'
import { loadManifestFile } from '../src/manifest.mjs'
import { SERVICE_TOKEN, startMockBridge } from './mock-bridge.mjs'

const MANIFEST = fileURLToPath(new URL('../manifests/example.manifest.yaml', import.meta.url))
const IDS = ['L1', 'L3', 'L4', 'D1', 'E2']

async function run(flaws = {}) {
  const mock = await startMockBridge(flaws)
  const target = createTarget({
    name: 'mock',
    baseUrl: mock.base,
    serviceToken: SERVICE_TOKEN,
    bffSecret: 'mock-bff',
    loadManifest: async () => ({ manifest: loadManifestFile(MANIFEST), source: 'example manifest' }),
    loadFixtures: async () => ({
      platform: `t${Math.random().toString(16).slice(2, 10)}`,
      roles: ['admin', 'manager', 'staff'],
      employees: { admin: mock.newUser('admin'), manager: mock.newUser('manager'), staff: mock.newUser('staff') },
      newEmployee: async (role) => mock.newUser(role),
      hooks: {
        produceEvents: async () => {
          mock.emit('report.submitted', { reportId: 'r-1', authorUserId: 'u-1', ...(flaws.leakNamesInEvents ? { residentName: 'Taro Yamada' } : {}) })
          mock.emit('approval.requested', { approvalId: 'a-1' })
        },
      },
    }),
  })
  try {
    await target.start()
    const ctx = buildContext(target)
    const out = {}
    for (const check of collectChecks().filter((c) => IDS.includes(c.id))) out[check.id] = (await executeCheck(target, check, ctx)).state
    return out
  } finally {
    await mock.stop()
  }
}

describe('conformance checks detect deliberate violations', () => {
  test('a correct system passes the probed checks', async () => {
    assert.deepEqual(await run(), { L1: 'pass', L3: 'pass', L4: 'pass', D1: 'pass', E2: 'pass' })
  })
  const cases = [
    ['unlinkedHint', 'L1', 'an unlinked lookup leaks a hint (invariant 2)'],
    ['linkCodeFromBody', 'L3', 'the link code takes its employee from the request body (invariants 1 and 5)'],
    ['reuseCode', 'L4', 'a link code can be used twice (invariant 1)'],
    ['delegateUnlinked', 'D1', 'a delegation token is issued for an unlinked sender (invariant 2)'],
    ['leakNamesInEvents', 'E2', 'an event payload carries a resident name (invariant 4)'],
  ]
  for (const [flaw, id, what] of cases) {
    test(`${id} fails when ${what}`, async () => {
      const result = await run({ [flaw]: true })
      assert.equal(result[id], 'fail', `${id} should detect: ${what}`)
      for (const other of IDS.filter((x) => x !== id)) assert.equal(result[other], 'pass', `${other} must be unaffected by the ${flaw} flaw`)
    })
  }
})
