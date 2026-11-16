// Generic adapter: a business system that serves /bridge/v1 natively.
//
//   BRIDGE_BASE_URL        origin of the system (https://biz.example.com)
//   BRIDGE_SERVICE_TOKEN   its x-service-token (the DSH side secret)
//   BRIDGE_BFF_SECRET      its x-bff-secret (needed for personal bots and assistant tickets)
//   BRIDGE_FIXTURES        path of an ES module: export default async function createFixtures({ baseUrl, serviceToken, bffSecret, env }) -> Fixtures
//                          (it may also export `knownGaps` = { checkId: reason }); see conformance/fixtures.example.mjs and the README
//   BRIDGE_BASE_PATH       default /bridge/v1
//   BRIDGE_MANIFEST_FILE   used when GET /manifest is not served
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTarget } from '../lib/target.mjs'

export const enabled = Boolean(process.env.BRIDGE_BASE_URL && process.env.BRIDGE_SERVICE_TOKEN && process.env.BRIDGE_FIXTURES)

export async function createHttpTarget(env = process.env) {
  const file = isAbsolute(env.BRIDGE_FIXTURES) ? env.BRIDGE_FIXTURES : resolve(process.cwd(), env.BRIDGE_FIXTURES)
  const mod = await import(pathToFileURL(file).href)
  if (typeof mod.default !== 'function') throw new Error(`${env.BRIDGE_FIXTURES} must export default async function createFixtures(ctx)`)
  return createTarget({
    name: env.BRIDGE_BASE_URL,
    baseUrl: env.BRIDGE_BASE_URL,
    serviceToken: env.BRIDGE_SERVICE_TOKEN,
    bffSecret: env.BRIDGE_BFF_SECRET ?? '',
    basePath: env.BRIDGE_BASE_PATH || '/bridge/v1',
    manifestFile: env.BRIDGE_MANIFEST_FILE ?? '',
    knownGaps: mod.knownGaps ?? {},
    loadFixtures: (t) => mod.default({ baseUrl: t.baseUrl, serviceToken: t.serviceToken, bffSecret: t.bffSecret, env }),
  })
}
