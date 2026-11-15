// bridge-graph — "why did this reach me?" as an AI employee tool (see README.md).
//
// A bridge-tools TOOL MODULE (registered before the manifest's generated read tools, behind the same delegation gate):
//
//   # the product profile's cordis.patch.yml
//   - id: bridge-tools
//     name: '@dsh-bridge/plugin-tools'
//     config:
//       toolModules:
//         - module: '@dsh-bridge/plugin-graph'
//           application: leave-requests
//
// The manifest of the business system declares the endpoint as a read tool (delegation × role, like every read tool):
//   tools:
//     - { name: <namespace>_graph_neighbors, http: GET /bridge/v1/graph/neighbors, access: read, roles: [...], pii: none }
import { graphWhyToolSpec } from './tool.js'

export const name = 'bridge-graph'
export const graphWhyToolName = (namespace) => `${namespace}_graph_why`

/** The tools of one application (kit = the helper bridge-tools passes to a tool module). */
export function createGraphTools(kit, { toolName = null } = {}) {
  const namespace = kit?.namespace
  if (!namespace && !toolName) throw new Error('bridge-graph: the application has no namespace')
  const app = typeof kit.application === 'function' ? kit.application() : null
  const spec = graphWhyToolSpec({ name: toolName ?? graphWhyToolName(namespace), requestJson: kit.requestJson, application: kit.application, systemName: app?.name ?? 'the business system' })
  return [typeof kit.defineTool === 'function' ? kit.defineTool(spec) : spec]
}

export default function graphTools(kit) {
  return createGraphTools(kit)
}

export { graphWhyToolSpec, renderWhy, GRAPH_NEIGHBORS_PATH } from './tool.js'
