// The Bridge v1 conformance suite of @dsh-bridge/protocol against equipment-loans, through the GENERIC HTTP adapter
// (BRIDGE_BASE_URL + BRIDGE_FIXTURES — the path any business system takes). No database: the instance runs in this process.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startServer } from '../src/app.mjs'

const SERVICE_TOKEN = 'loans-test-service-token-0000000000'
const BFF_SECRET = 'loans-test-bff-secret-00000000000000'

const protocolDir = dirname(fileURLToPath(import.meta.resolve('@dsh-bridge/protocol/package.json')))
const { collectChecks, runSuite } = await import(pathToFileURL(join(protocolDir, 'conformance', 'suite.mjs')).href)
const { createHttpTarget } = await import(pathToFileURL(join(protocolDir, 'conformance', 'adapters', 'http.mjs')).href)

const server = await startServer({ serviceToken: SERVICE_TOKEN, bffSecret: BFF_SECRET })
globalThis.__equipmentLoans = server.app
after(() => server.stop())

const target = await createHttpTarget({
  BRIDGE_BASE_URL: server.base,
  BRIDGE_SERVICE_TOKEN: SERVICE_TOKEN,
  BRIDGE_BFF_SECRET: BFF_SECRET,
  BRIDGE_FIXTURES: fileURLToPath(new URL('./fixtures.mjs', import.meta.url)),
})
runSuite(target)

test('equipment-loans passes EVERY conformance check: no failure, no skip, no known gap', () => {
  const all = collectChecks().map((c) => c.id).sort()
  assert.deepEqual(Object.keys(target.knownGaps), [], 'no known gaps declared')
  assert.deepEqual(target.results.filter((r) => r.state !== 'pass').map((r) => `${r.id} ${r.state}: ${r.note}`), [])
  assert.deepEqual(target.results.map((r) => r.id).sort(), all, 'every check of the suite ran')
  assert.equal(target.manifestSource, 'GET /manifest', 'the manifest came from GET /bridge/v1/manifest')
  console.log(`# conformance: ${target.results.filter((r) => r.state === 'pass').length} / ${all.length} checks passed`)
})
