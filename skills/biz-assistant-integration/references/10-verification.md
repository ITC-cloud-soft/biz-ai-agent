# 10 Verification: conformance, Definition of Done, final checklist

Sources of truth: `docs/GUIDELINE.en.md` b.4, "Checklist", "Definition of Done (verified by commands)", section e, `packages/protocol/README.md` (the list of 52 items).

## 1. conformance suite (52 items)

```sh
BRIDGE_BASE_URL=http://127.0.0.1:<port of the TEST environment> \
BRIDGE_SERVICE_TOKEN=<test value> BRIDGE_BFF_SECRET=<test value> \
BRIDGE_FIXTURES=./test/fixtures.mjs BRIDGE_MANIFEST_FILE=./bridge.manifest.yaml \
node --test <framework>/packages/protocol/conformance/http.test.mjs        # the same as bridge-validate conformance
```

- Run it against the **TEST environment** (never against production or the demo environment). Use test values generated fresh every time.
- In CI, follow the form of the sample's `examples/equipment-inspection/test/conformance.test.mjs` (startup, temporary DB and cleanup in one test).
- Systems that want to start themselves and prepare the DB, or rewrite old paths, use an application adapter (`BRIDGE_ADAPTER=./my-app.adapter.mjs`, sample `conformance/adapters/example-adapter.mjs`).

### fixtures (copy `conformance/fixtures.example.mjs`; the real one is the sample's `test/fixtures.mjs`)

- `employees`: three people, `admin`, `manager` and `staff` (logged in). `newEmployee(role)` maps the generic roles `admin`, `manager`, `staff` and `billing` to your own roles:
  - `admin` = an administrator who can run reports right away (who still cannot see other people's links)
  - `manager` = a role that can read reports, approve, and accept proposals
  - `staff` / `billing` = ordinary roles that cannot read reports
  - `roles` lists every role in the manifest (M3)
- `capabilities`: `approvals: true` (with `false`, A1–A4 are skipped), `personalBots` (with `false`, B1–B4 are skipped), `personalBotPlatform`.
- Two proposal samples: one the delegated role can create (`proposalSample`: PR1, PR2) and one it cannot (`proposalForbiddenSample`: PR3).
- hooks: `expireLinkCode`, `expireDelegation`, `revokeSession`, `deactivateEmployee`, `emitNotifiableEvent` (creates an event **whose recipients include that employee**),
  `createPendingApproval`, `produceEvents`, `tryEmitEvent`, `writeProbes` (lists every business write API).
- Items without a hook are **skipped**. The release condition is no skips.

### Items that often fail and why

| Failing items | Common cause |
|---|---|
| R1–R3, P4, L9, D6, D7, S2, S4, D3 | No reports (`reports` in the manifest and `hooks.reports`) |
| A1–A4 | No approval hooks, `capabilities.approvals: false`, `approvals.get` returns snake_case rows |
| L9, E2 | One of the 3 internal events (`approval.requested`, `approval.decided`, `sns_identity.unlinked`) is not declared |
| D4 | The roles in `readToolPolicy` differ from `tools[].roles` in the manifest |
| D5 | A write API lets delegations through, `writeProbes` is incomplete |
| M3 | The fixtures' `roles` is missing roles from the manifest |
| N1–N3 | The `emitNotifiableEvent` event does not include that employee as a recipient, strings in `paramsFor` |
| S4 | No `isSessionLive` |

## 2. Definition of Done (verified by commands)

| # | What | Command | Pass |
|---|---|---|---|
| 1 | manifest | `node <framework>/packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict` | exit 0 |
| 2 | conformance | Section 1 above | `52 passed, 0 known gaps, 0 skipped` |
| 3 | The business system's own tests | `node --test test/*.test.mjs` (on Windows, `--test-isolation=none`) | All pass (minimum content: section 5 of `05-business-side.md`) |
| 4 | Manual (if used) | In the business tests, `checkAnchors`, `checkSectionPaths`, `checkCoverage`, `checkRoleText` and `checkLinks` are empty; if the index is committed, `serializeIndex(buildHelpIndex(...))` matches | Empty, equal |
| 5 | Product profile | `node <framework>/profile/scripts/install.mjs --source <product profile> --home <temporary directory> --profile <name> --skip-install` | No `template placeholders left` warning |
| 6 | Outbound settings | `node <framework>/profile/scripts/check.mjs <product profile>/cordis.patch.yml` (`--allow <rule>` only for intended opt-ins; hand-written automatic-task delegation needs `--allow unattendedPolicy`) | exit 0 |
| 7 | Fixed delivery targets are rejected | Add `--auto-task-target x` to the command in 5 | exit 2 |
| 8 | Business web app | `tsc --noEmit` | No errors |
| 9 | Only when you changed the framework | `pnpm validate` and `pnpm test` in `<framework>` | ok, fail 0 |

- The framework's e2e (`pnpm run e2e`) is currently for the sample only. The completion of a new system or a connected system is judged by 1–8.
- Checks with a real chat and real models are manual. If they were not done, write "not verified" in the report.

## 3. Final checklist (a copy of the GUIDELINE "Checklist"; check the original for the latest)

- [ ] `bridge-validate manifest --strict` exits 0
- [ ] Every state change uses `kit.tx` + `emitEvent` (when external, the ingestion rules)
- [ ] For a new system: the location and dependencies follow one of the options in b.0, and nothing inside the framework has been rewritten
- [ ] The 3 internal events are declared
- [ ] conformance 52 / 52, empty `knownGaps`, no skips
- [ ] Registry: `system.id` = app id, tools are `<namespace>_*`, all bots listed (`strict: true`), tokens only as environment variable names
- [ ] Message wording: `intent` on every template, `action` for action / urgent
- [ ] DSH-side code uses only `kit.requestJson` / `kit.proposeTool`
- [ ] Business web app: screens for chat linking, notification settings, approvals and proposals. The BFF secret only on the BFF's own calls
- [ ] Automatic tasks: delegation classes and employees (or `each`), prohibitions in the playbooks, presets for `agent`
- [ ] Recipients: for every notification event, the scope is decided and checked at the gate; if it cannot be decided, nothing is sent
- [ ] Outbound settings: the template's closed values. Opt-ins have reasons
- [ ] No names, free text, health information or Japanese sentences in payloads or arguments
- [ ] If personal bots are used: self-service RPC, `createOnly`, excluded from the admin list
- [ ] Link checking: the `linkGuard` URL for every app, and `web.routes` in the manifest
- [ ] With two or more apps: for each non-default app, `webUrl`, `bots`, `agents[].application`, `webUrls` and delegation
- [ ] If optional features are used: manual CI, `hooks.piiScan`, `AiProfilePage`, attachment settings and the handling of scanned PDFs, and for external connectors `secretKey`, approval and the rules task
