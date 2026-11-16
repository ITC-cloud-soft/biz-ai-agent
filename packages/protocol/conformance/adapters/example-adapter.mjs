// Example APPLICATION ADAPTER for the conformance suite (copy it into your application's repository).
//
// The generic HTTP adapter (adapters/http.mjs) is enough for a system that serves /bridge/v1 natively and can be reached at a
// base URL: it only needs a fixtures module. An application adapter is for everything else:
//   - start / stop the system under test (spawn it on a free port, with a throw-away test database),
//   - rewrite v1 requests onto routes the system still serves under older paths (aliasTable / pickAlias / fillTemplate),
//   - adapt documented response shapes (normalize),
//   - provide fixtures and hooks straight from the system's own test helpers.
//
// Run:  BRIDGE_ADAPTER=./conformance/my-adapter.mjs node --test node_modules/@dsh-bridge/protocol/conformance/http.test.mjs
// This file is NOT executed by the protocol package's own tests (it has no system to start).
import { createTarget as createSuiteTarget } from '../lib/target.mjs'
import { fillTemplate, matchOperation, pickAlias } from '../../src/openapi.mjs'

/** false (or a function of env) skips the suite with skipReason, e.g. when the test database is not configured. */
export const enabled = (env) => Boolean(env.MY_APP_TEST_DATABASE_URL)
export const skipReason = 'MY_APP_TEST_DATABASE_URL is not set'

export async function createTarget(env) {
  let server = null
  return createSuiteTarget({
    name: 'my-app (/bridge/v1)',
    baseUrl: `http://127.0.0.1:${env.MY_APP_TEST_PORT || 19999}`,
    serviceToken: env.MY_APP_TEST_SERVICE_TOKEN || 'test-service-token',
    bffSecret: env.MY_APP_TEST_BFF_SECRET || 'test-bff-secret',
    async start() {
      // server = await startMyApp({ port, databaseUrl: env.MY_APP_TEST_DATABASE_URL })
    },
    async stop() {
      await server?.close?.()
    },
    // Only for systems that map v1 onto their own older routes (an annotated copy of the OpenAPI with an `x-alias` list):
    rewrite(req, target) {
      const m = matchOperation(target.doc, req.method, req.path)
      const alias = m && pickAlias(m.operation.op['x-alias'] ?? [], req.headers['x-delegation-token'] ? 'delegated' : 'service')
      if (!alias || alias.status === 'missing') return req
      return { ...req, method: alias.method, path: fillTemplate(alias.path, m.params), query: { ...(alias.query ?? {}), ...req.query } }
    },
    knownGaps: {},
    loadFixtures: async () => ({
      platform: `t${Math.random().toString(16).slice(2, 10)}`,
      roles: ['admin', 'manager', 'staff'],
      employees: {}, // { admin: { id, role, headers }, ... } from the system's own test helpers
      newEmployee: async () => { throw new Error('newEmployee: create an employee through the system under test') },
      hooks: {},
    }),
  })
}
