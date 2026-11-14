// The optional Bridge v1 capability `knowledge`, registered on server-kit's router (no change to server-kit).
//
//   GET /bridge/v1/knowledge/search?q=&limit=     the employee (web session) or the AI acting as them (delegation)
//
// Who may call it: server-kit's gate with kit.readToolPolicy — an employee of any declared role on the web; a delegation only
// when the manifest declares a read tool `GET /bridge/v1/knowledge/search` for the employee's role (delegation × role, like
// every business read tool). Without that tool in the manifest every delegation gets 403 (fail closed). The service principal
// alone (no employee) gets 403 human_required: there is no "public" knowledge in this MVP.
// What it returns: only the chunks the asking employee may read (the search removes the others before ranking).
import { fail } from '@dsh-bridge/server-kit'

export const KNOWLEDGE_SEARCH_PATH = '/bridge/v1/knowledge/search'
export const KNOWLEDGE_ENDPOINT = `GET ${KNOWLEDGE_SEARCH_PATH}`
export const KNOWLEDGE_QUERY_MAX = 200

function questionOf(query) {
  const q = String(query?.get?.('q') ?? '').trim()
  if (!q) fail(400, 'q_required')
  return q.slice(0, KNOWLEDGE_QUERY_MAX)
}
function limitOf(query) {
  const raw = query?.get?.('limit')
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 5) fail(400, 'invalid_limit')
  return n
}

/**
 * registerKnowledge(bridge, service, { onQuestion? }) — bridge = the result of createBridgeApp ({ router, kit }).
 * onQuestion({ question, role, channel, found, chunkIds }, ctx): the business's own log (its rules: no personal data kept).
 * @returns {{ path: string, delegatedRoles: string[] }}
 */
export function registerKnowledge(bridge, service, { onQuestion = null } = {}) {
  const { router, kit } = bridge ?? {}
  if (!router || !kit) throw new TypeError('registerKnowledge: pass the result of createBridgeApp ({ router, kit })')
  if (typeof service?.search !== 'function') throw new TypeError('registerKnowledge: a knowledge service (createKnowledgeService) is required')
  const delegatedRoles = kit.allowlist[KNOWLEDGE_ENDPOINT] ?? []
  if (!delegatedRoles.length) {
    kit.log?.(`[knowledge] the manifest declares no read tool "${KNOWLEDGE_ENDPOINT}": the AI (delegations) cannot search knowledge`)
  }
  const policy = kit.readToolPolicy(KNOWLEDGE_ENDPOINT, [...kit.declaredRoles])

  router.add('GET', KNOWLEDGE_SEARCH_PATH, policy, async ({ principal, query }) => {
    const q = questionOf(query)
    const limit = limitOf(query)
    const asker = { id: String(principal.user.id), role: principal.user.role }
    const result = await service.search(q, { asker, limit })
    const results = Array.isArray(result?.results) ? result.results : []
    try {
      await onQuestion?.({ question: q, role: asker.role, channel: principal.kind === 'delegated' ? 'ai' : 'web', found: results.length > 0, chunkIds: results.map((r) => r.id) }, kit.ctx())
    } catch (error) {
      kit.log?.(`[knowledge] onQuestion failed: ${error?.message ?? error}`)
    }
    return { status: 200, body: { ok: true, query: q, found: results.length > 0, results } }
  })
  return { path: KNOWLEDGE_SEARCH_PATH, delegatedRoles: [...delegatedRoles] }
}
