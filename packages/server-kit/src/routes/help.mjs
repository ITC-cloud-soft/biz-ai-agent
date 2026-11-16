// How-to questions answered from the business system's manual (optional capability: the `help` option). Without it the routes
// still pass the gate first (401 / 403 as declared) and then answer 404 not_found, like every optional Bridge v1 route.
//   GET /bridge/v1/help/search?q=&limit=      an employee, its delegation (the SNS AI secretary / AI assistant), or the service principal
//                                             (no employee → the public sections only)
//   GET /bridge/v1/help/sections/:sectionId   one section (404 unknown; without an employee only a public one)
//   GET /bridge/v1/help/public?q=&limit=      the service principal only: the answer to a sender that is not linked yet (public sections)
// The answer follows the asker's role: a screen the asker cannot open carries no URL, only whom to ask (`alt`). The kit never builds
// a URL itself: the help service gives the manual's own screen paths on the business web's URL (@dsh-bridge/help createHelpService).
// help.onQuestion({ question, role, channel, found, sectionIds }, ctx) lets the business keep a log (its own rules: no personal data).
import { fail } from '../http.mjs'

export const HELP_QUERY_MAX = 200
const SECTION_ID = 'manual-[a-z0-9-]{1,60}'

const roleOf = (principal) => (principal.kind === 'user' || principal.kind === 'delegated' ? principal.user?.role ?? null : null)
const channelOf = (principal) => (principal.kind === 'delegated' ? 'ai' : principal.kind === 'service' ? 'public' : 'web')

function question(query) {
  const q = String(query?.get?.('q') ?? query?.q ?? '').trim()
  if (!q) fail(400, 'q_required')
  return q.slice(0, HELP_QUERY_MAX)
}
const limitOf = (query) => {
  const raw = query?.get?.('limit') ?? query?.limit
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 5) fail(400, 'invalid_limit')
  return n
}

export function registerHelp(router, kit) {
  const help = kit.help
  const needHelp = () => { if (!help) fail(404, 'not_found') }
  const ANYONE = { allow: ['user', 'delegated', 'service'] }
  const SERVICE_ONLY = { allow: ['service'] }

  async function answer(principal, query, { publicOnly = false } = {}) {
    needHelp()
    const q = question(query)
    const role = publicOnly ? null : roleOf(principal)
    const result = await help.search(q, { role, limit: limitOf(query), publicOnly: publicOnly || !role })
    try {
      await help.onQuestion?.({ question: q, role, channel: channelOf(principal), found: Boolean(result.found), sectionIds: result.results.map((r) => r.id) }, kit.ctx())
    } catch (error) {
      kit.log?.(`[server-kit] help: onQuestion failed: ${error?.message ?? error}`)
    }
    return { status: 200, body: { ok: true, query: q, found: Boolean(result.found), results: result.results } }
  }

  router.add('GET', '/bridge/v1/help/search', ANYONE, ({ principal, query }) => answer(principal, query))
  router.add('GET', '/bridge/v1/help/public', SERVICE_ONLY, ({ principal, query }) => answer(principal, query, { publicOnly: true }))
  router.add('GET', '/bridge/v1/help/sections/:sectionId', ANYONE, async ({ principal, params }) => {
    needHelp()
    const section = await help.section(params.sectionId, { role: roleOf(principal) })
    if (!section) fail(404, 'not_found')
    return { status: 200, body: { ok: true, section } }
  }, { patterns: { sectionId: SECTION_ID } })
}
