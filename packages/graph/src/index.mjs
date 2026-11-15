// @dsh-bridge/graph — the semantic graph of a Bridge v1 business system (see README.md):
// the skeleton from the manifest (pure) + GET /bridge/v1/graph/neighbors (IDs and types, filtered by the asker's rights).
export { buildManifestGraph, graphIndex } from './skeleton.mjs'
export { explainReach } from './explain.mjs'
export { GRAPH_NEIGHBORS_PATH, GRAPH_ENDPOINT, MAX_NEIGHBORS, SPECIAL_TYPES, registerGraph } from './routes.mjs'
