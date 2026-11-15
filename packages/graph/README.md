# @dsh-bridge/graph

The semantic graph of a Bridge v1 business system (biz-ai-agent, week 4). Interface: [`docs/GRAPH_API.md`](../../docs/GRAPH_API.md).

- **Skeleton = the manifest** (`buildManifestGraph`, pure, also as `@dsh-bridge/graph/pure`): roles, entities, events, audience
  rules, tools, playbooks, reports and the edges between them. No model, no extraction; the same for every asker.
- **Instances = the business system's relations**: `registerGraph(bridge, { canRead, neighbors })` adds
  `GET /bridge/v1/graph/neighbors?entity=&id=` on server-kit's router: IDs and types only, the asker's rights on the object and
  on every neighbor, 404 for "not yours" and "does not exist" alike.
- **Why did this reach me?** `explainReach(graph, { ref, viewer, neighbors })` combines both into reasons, each naming the
  manifest rule it comes from. It never invents one: no rule, kind `none`.
- Conformance: `@dsh-bridge/graph/conformance` (G-01…G-07).
