// Bridge v1 conformance against ANY business system that serves /bridge/v1.
//   BRIDGE_BASE_URL=https://biz.example.com  BRIDGE_SERVICE_TOKEN=...  BRIDGE_BFF_SECRET=...
//   BRIDGE_FIXTURES=./my-fixtures.mjs  [BRIDGE_BASE_PATH=/bridge/v1] [BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml]
//   node --test packages/protocol/conformance/http.test.mjs
//
// Application adapter (a system that needs more than fixtures: start it, rewrite v1 paths onto older routes, adapt shapes):
//   BRIDGE_ADAPTER=./my-adapter.mjs node --test packages/protocol/conformance/http.test.mjs
//   my-adapter.mjs: export const enabled = true|false (optional, default true)
//                   export async function createTarget(env) -> createTarget({...}) from '@dsh-bridge/protocol/conformance/target'
//   See README "Plugging in an application adapter".
import { test } from 'node:test'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './suite.mjs'
import { createHttpTarget, enabled } from './adapters/http.mjs'

const adapterFile = process.env.BRIDGE_ADAPTER
if (adapterFile) {
  const file = isAbsolute(adapterFile) ? adapterFile : resolve(process.cwd(), adapterFile)
  const adapter = await import(pathToFileURL(file).href)
  if (typeof adapter.createTarget !== 'function') throw new Error(`${adapterFile} must export async function createTarget(env)`)
  const on = adapter.enabled === undefined ? true : (typeof adapter.enabled === 'function' ? adapter.enabled(process.env) : adapter.enabled)
  if (on) runSuite(await adapter.createTarget(process.env))
  else test(`bridge v1 conformance via ${adapterFile}`, { skip: adapter.skipReason ?? 'the adapter is not enabled in this environment' }, () => {})
} else if (enabled) runSuite(await createHttpTarget())
else test('bridge v1 conformance against BRIDGE_BASE_URL', { skip: 'BRIDGE_BASE_URL (and BRIDGE_SERVICE_TOKEN, BRIDGE_FIXTURES) are not set' }, () => {})
