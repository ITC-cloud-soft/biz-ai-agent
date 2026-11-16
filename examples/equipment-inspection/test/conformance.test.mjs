// The Bridge v1 conformance suite of @dsh-bridge/protocol against equipment-inspection, through the GENERIC HTTP adapter
// (the path any business system takes: BRIDGE_BASE_URL + BRIDGE_FIXTURES). The instance is started here on an
// ephemeral port with its own temporary database (fw_equipment_test, dropped at the end).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SKIP_REASON, startTestServer, TEST_BFF_SECRET, TEST_DATABASE_URL, TEST_SERVICE_TOKEN } from './helpers.mjs'

if (SKIP_REASON) {
  test('equipment-inspection conformance (52 checks)', { skip: SKIP_REASON }, () => {})
} else {
  // the suite and its generic adapter live in the protocol package (located through its package.json)
  const protocolDir = dirname(fileURLToPath(import.meta.resolve('@dsh-bridge/protocol/package.json')))
  const { collectChecks, runSuite } = await import(pathToFileURL(join(protocolDir, 'conformance', 'suite.mjs')).href)
  const { createHttpTarget } = await import(pathToFileURL(join(protocolDir, 'conformance', 'adapters', 'http.mjs')).href)

  const server = await startTestServer()
  after(() => server.stop())

  const target = await createHttpTarget({
    BRIDGE_BASE_URL: server.base,
    BRIDGE_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    BRIDGE_BFF_SECRET: TEST_BFF_SECRET,
    BRIDGE_FIXTURES: fileURLToPath(new URL('./fixtures.mjs', import.meta.url)),
    EQUIPMENT_DATABASE_URL: TEST_DATABASE_URL,
  })
  runSuite(target)

  test('equipment-inspection passes EVERY conformance check: no failure, no skip, no known gap', () => {
    const all = collectChecks().map((c) => c.id).sort()
    assert.deepEqual(Object.keys(target.knownGaps), [], 'no known gaps declared')
    assert.deepEqual(target.results.filter((r) => r.state !== 'pass').map((r) => `${r.id} ${r.state}: ${r.note}`), [])
    assert.deepEqual(target.results.map((r) => r.id).sort(), all, 'every check of the suite ran')
    assert.equal(target.manifestSource, 'GET /manifest', 'the manifest came from GET /bridge/v1/manifest')
    console.log(`# conformance: ${target.results.filter((r) => r.state === 'pass').length} / ${all.length} checks passed`)
  })
}
