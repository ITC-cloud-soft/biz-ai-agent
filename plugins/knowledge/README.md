# @dsh-bridge/plugin-knowledge (bridge-knowledge)

The DSH side of the knowledge layer. The business system's permission-aware search
([`@dsh-bridge/knowledge`](../../packages/knowledge)) becomes an AI employee tool, `<namespace>_knowledge_search`.

- **Run as the employee who asked.** The plugin is a **bridge-tools tool module**, so bridge-tools wraps it in its delegation gate
  (IM sender or web assistant → that employee's delegation → the business system). The business system decides, on every call, what
  this employee may read. The plugin keeps **no index and no document text**.
- **Answers must cite.** Results are numbered `[n]`, each with its source screen URL exactly as the business system returned it.
  The tool output tells the model to cite every statement and to end with `Sources:`. `checkCitations(answer, sources)` judges an
  answer (evals, tests); `ensureCitations` repairs one that cites nothing. `ledger.recent(sessionId)` keeps the sources of a
  conversation for 10 minutes, in memory, for a reply guard.
- **No choosing whose rights.** Arguments such as `role`, `userId`, `documentId` or `url` are refused. `found=false` tells the model
  to say so, not to guess, and never hints that other documents exist.

```yaml
# the product profile's cordis.patch.yml
- id: bridge-tools
  name: '@dsh-bridge/plugin-tools'
  config:
    toolModules:
      - module: '@dsh-bridge/plugin-knowledge'
        application: leave-requests
```

The business manifest declares the tool, which is what lets delegations call the endpoint, role by role:

```yaml
tools:
  - name: leave_knowledge_search
    http: GET /bridge/v1/knowledge/search
    access: read
    roles: [admin, manager, staff]
    pii: none
```

Add `knowledgeRules('<namespace>_knowledge_search')` (English) or `knowledgeRules(name, KNOWLEDGE_RULES_JA)` to the AI employee's
persona.

The plugin has not yet run inside a live DSH home. The pilot's `test/plugin.test.mjs` drives it through dsh-core's `defineTool`,
`guardTool`, `createToolRequester` and `createBusinessApi` against the running pilot, with real delegations.

## The citation guard (`@dsh-bridge/plugin-knowledge/guard`)

A DSH plugin (cordis, `inject: ['dshIm']`) that installs an answer filter with `ctx.dshIm.setAnswerFilter`. dsh-im runs every
registered filter in registration order, each on the previous one's output, so the guard runs **next to** bridge-identity's
link guard (list the guard first, so the link guard sees the final text). When the knowledge tool returned sources in this turn
of the conversation, an answer that does not cite them is repaired with `ensureCitations`; the sources are then forgotten, so a
later answer that used no knowledge is never touched.

It is installed through the package's **bundle** (`cordis.patch.yml`, `- insert: bridge-knowledge-guard`): add the package to the
product profile's `package.json` (`dependencies`) and to `dsh.profile.bundles` after `@dsh-bridge/plugin-identity`. A plain
`- id: … name: …` entry in the profile's `cordis.patch.yml` is NOT enough (that form only configures an entry a bundle inserted).

**Needs the dsh-im fix**: the framework's dsh-im fork implements `setAnswerFilter` but its `dshIm` service object does not pass it on
(`vendor/dsh-im/plugin-src/host/index.mjs`), so on a real DSH no answer filter is installed — neither this guard nor
bridge-identity's link guard. `e2e/run.mjs --patch-dsh-im` proves the one-line fix in an isolated home.
