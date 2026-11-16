# ケアビリング — manifest and protocol mapping

ケアビリング (care-billing, repository `care-ai-native`) is the first business system on the DSH Business Bridge. Its business code
stays in its own repository; this directory keeps what the framework needs to describe and test against it.

| file | what |
|---|---|
| `care-billing.manifest.yaml` | The manifest of ケアビリング (system id `care-billing`, tool namespace `care`), derived from the care-api / plugin code. No personal data. A byte-identical **copy**: the source of truth is care-ai-native `services/care-api/bridge/care-billing.manifest.yaml` (what care-api serves at `GET /bridge/v1/manifest`). |
| `care-api-v1-aliases.md` / `.json` | Which care-api route implements each Bridge v1 operation (formerly the `x-care-alias` annotations inside `bridge-v1.yaml`; the framework's OpenAPI no longer carries them). The JSON is a copy of care-ai-native `services/care-api/bridge/care-api-v1-aliases.json`, which care-api reads at start-up (`applyAliasTable(loadOpenApi(), table, { extension: 'x-care-alias' })`). |

care-ai-native's `services/care-api/bridge/test/manifest.test.mjs` fails when either copy here differs from its source (when the
two repositories are side by side). When ケアビリング changes its manifest or alias table, copy the new files here.

Validate the manifest (also done by `packages/protocol/test/validators.test.mjs` when this directory exists) and print the alias
table:

```
node packages/protocol/bin/bridge-validate.mjs manifest examples/care-billing/manifest/care-billing.manifest.yaml
node packages/protocol/bin/bridge-validate.mjs aliases --table examples/care-billing/manifest/care-api-v1-aliases.json --label care-api
```

In a DSH product profile: `manifestFile: <path to the manifest>` in the `bridge-apps` registry entry (`id: care-billing`), or let
care-api serve it at `GET /bridge/v1/manifest`.

## Conformance against care-api

care-api is tested with an **application adapter** (see `packages/protocol/README.md`, "Plugging in an application adapter"). The
adapter starts care-api with its own test helpers on a throw-away test database and provides the fixtures and hooks; the suite talks
to `/bridge/v1` directly. It lives in care-ai-native (`services/care-api/bridge/conformance/care-api.adapter.mjs`) because it
imports care-api's code, and exports the adapter contract (`enabled(env)`, `skipReason`, `createTarget(env)`):

```
# in care-ai-native, with a migrated TEST database (never the demo databases)
DATABASE_URL=postgres://…/<test database> pnpm run test:bridge            # services/care-api/bridge/test/*.test.mjs
# or through this framework's generic entry point
DATABASE_URL=… BRIDGE_ADAPTER=services/care-api/bridge/conformance/care-api.adapter.mjs \
  node --test <framework>/packages/protocol/conformance/http.test.mjs
```

The drift test that keeps the manifest equal to the care code (`services/care-api/bridge/test/care-sync.test.mjs`: events =
`AI_EVENT_TYPES`, payload keys, notification types, templates, roles, tools, playbook texts, aliases = real routes) reads
care-ai-native's sources and therefore also stays there.
