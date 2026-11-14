// bridge-knowledge — the business system's knowledge search as an AI employee tool (see README.md).
//
// It is a bridge-tools TOOL MODULE: bridge-tools registers it for an application BEFORE it generates the manifest's read tools,
// behind the same delegation gate (who is asking → their delegation → the business system checks role and visibility).
//
//   # the product profile's cordis.patch.yml
//   - id: bridge-tools
//     name: '@dsh-bridge/plugin-tools'
//     config:
//       toolModules:
//         - module: '@dsh-bridge/plugin-knowledge'
//           application: leave-requests
//
// The manifest of the business system declares the tool (so delegations may call the endpoint, role by role):
//   tools:
//     - { name: <namespace>_knowledge_search, http: GET /bridge/v1/knowledge/search, access: read, roles: [...], pii: none }
import { createSourceLedger } from './ledger.js'
import { knowledgeToolSpec, KNOWLEDGE_SEARCH_PATH } from './tool.js'

export const name = 'bridge-knowledge'
export const TOOL_SUFFIX = 'knowledge_search'

/** The knowledge tool name of an application: '<namespace>_knowledge_search'. */
export const knowledgeToolName = (namespace) => `${namespace}_${TOOL_SUFFIX}`

/** The ledger shared by the tools this module creates (a reply guard reads it: ledger.recent(sessionId)). */
export const ledger = createSourceLedger()

/**
 * The tools of one application. kit = the helper bridge-tools passes to a tool module (defineTool, requestJson, namespace,
 * application). The manifest must declare a read tool with this name on GET /bridge/v1/knowledge/search.
 */
export function createKnowledgeTools(kit, { path = KNOWLEDGE_SEARCH_PATH, toolName = null, sources = ledger } = {}) {
  const namespace = kit?.namespace
  if (!namespace && !toolName) throw new Error('bridge-knowledge: the application has no namespace')
  const app = typeof kit.application === 'function' ? kit.application() : null
  const spec = knowledgeToolSpec({ name: toolName ?? knowledgeToolName(namespace), path, requestJson: kit.requestJson, systemName: app?.name ?? 'the business system', ledger: sources })
  return [typeof kit.defineTool === 'function' ? kit.defineTool(spec) : spec]
}

/** The tool module entry point for bridge-tools' toolModules. */
export default function knowledgeTools(kit) {
  return createKnowledgeTools(kit)
}

export { knowledgeToolSpec, renderKnowledge, toKnowledgeResult, KNOWLEDGE_SEARCH_PATH } from './tool.js'
export { checkCitations, ensureCitations, sourcesBlock } from './citations.js'
export { createSourceLedger } from './ledger.js'
export { KNOWLEDGE_RULES_EN, KNOWLEDGE_RULES_JA, knowledgeRules } from './rules.js'
