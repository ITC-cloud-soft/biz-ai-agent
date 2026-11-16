import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { buildContext } from '../conformance/lib/context.mjs'
import { createHttpTarget } from '../conformance/adapters/http.mjs'
import { collectChecks, executeCheck } from '../conformance/suite.mjs'
import { SERVICE_TOKEN, startMockBridge } from './mock-bridge.mjs'

test('the generic HTTP adapter loads a fixtures module and runs checks against a native /bridge/v1 server', async () => {
  const mock = await startMockBridge()
  globalThis.__bridgeMock = mock
  try {
    const target = await createHttpTarget({
      BRIDGE_BASE_URL: mock.base,
      BRIDGE_SERVICE_TOKEN: SERVICE_TOKEN,
      BRIDGE_FIXTURES: fileURLToPath(new URL('./mock-fixtures.mjs', import.meta.url)),
      BRIDGE_MANIFEST_FILE: fileURLToPath(new URL('../manifests/example.manifest.yaml', import.meta.url)),
    })
    await target.start()
    assert.equal(target.manifestSource.endsWith('example.manifest.yaml'), true, 'falls back to BRIDGE_MANIFEST_FILE when /manifest is not served')
    const ctx = buildContext(target)
    const results = {}
    for (const check of collectChecks().filter((c) => ['P1', 'L1', 'L3', 'D1', 'L5', 'S1'].includes(c.id))) results[check.id] = (await executeCheck(target, check, ctx)).state
    // L5 / S1 need a hook / an operation the mock does not have: skipped or failing, never silently passing
    assert.deepEqual([results.P1, results.L1, results.L3, results.D1, results.L5], ['pass', 'pass', 'pass', 'pass', 'skip'])
    assert.notEqual(results.S1, 'pass')
    assert.equal(target.protocolHeaderViolations.length, 0)
    await target.stop()
  } finally {
    delete globalThis.__bridgeMock
    await mock.stop()
  }
})
