# bridge-graph (`@dsh-bridge/plugin-graph`)

A bridge-tools **tool module** for the AI employee: `<namespace>_graph_why { entity, id }` — "why did this approval /
notification / report reach me?".

- It builds the skeleton from the manifest the AI plane already holds, calls `GET /bridge/v1/graph/neighbors` **with the
  employee's own delegation**, and returns the reasons from `explainReach` (each with its manifest rule) and the screen links.
- 404 (missing or not theirs, the same answer) → `found: false`; arguments that try to pick whose rights (`role`, `userId`, …)
  are refused. It keeps nothing.
- The manifest must declare the endpoint as a read tool (`GET /bridge/v1/graph/neighbors`), role by role; without it, every
  delegation gets 403.

```yaml
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    toolModules:
      - { module: '@dsh-bridge/plugin-graph', application: leave-requests }
```
