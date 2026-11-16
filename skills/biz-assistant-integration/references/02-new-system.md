# 02 Building a new business system on the framework

Source of truth: `docs/GUIDELINE.en.md` b.0, the sample `examples/equipment-inspection` (README, src, test, manual).

## 1. Location and dependencies

`@dsh-bridge/*` is published on npm (https://www.npmjs.com/org/dsh-bridge). Inside the framework, dependencies between packages are `workspace:*`.

| Location | How to declare the dependency | Suited for |
|---|---|---|
| Inside the framework workspace: `examples/<system-id>/` | `"@dsh-bridge/server-kit": "workspace:*"` etc. Run `pnpm install` at the framework root | Prototyping and verification |
| A separate repository (product) | `npm install @dsh-bridge/server-kit` (and `@dsh-bridge/web-kit` for the web app). Pin the version the work was verified with | Products |
| A separate repository, needing a framework change that is not released yet | First run `pnpm install` in `<framework>`. Write `"@dsh-bridge/server-kit": "file:<framework>/packages/server-kit"` etc. and install with **npm** (`npm install`) | Trying unreleased changes |

- pnpm's `file:` cannot resolve the `workspace:*` inside and stops with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. Use npm for `file:` dependencies.
- `pg` is a peer of server-kit (add it to the business system's dependencies if you use the PostgreSQL store).
- web-kit is distributed as `.ts`, so load it with the business web app's bundler (Vite, etc.).

## 2. File layout (split the same way as the sample)

```
bridge.manifest.yaml      the system's self-description (system.id = the DSH app id)           → 04-manifest.md
src/config.mjs            environment variables only (secret defaults are for development only; required in production; rejects other systems' DB names)
src/auth.mjs              its own login and sessions: authenticate(req), isSessionLive
src/domain.mjs            business rules. State changes via kit.tx + kit.emitEvent; the approval rule (mayDecide) in one place
src/hooks.mjs             employees, recipientsFor, approvals, proposalKinds, reports, piiScan (, eventDelegations) → 05-business-side.md
src/routes.mjs            business API (/api/*): AI reads use kit.readToolPolicy, writes use { allow: ['user'] }
src/help.mjs              manual → index → createHelpService                                   → 08-optional-features.md
src/app.mjs, server.mjs   createBridgeApp + store.migrate() + business migrations, startScheduler
src/migrations/*.sql      business tables (bridge_* are created by the kit)
manual/NN-*.md            1 screen = 1 section
test/fixtures.mjs         conformance fixtures                                                 → 10-verification.md
test/conformance.test.mjs the suite with the generic HTTP adapter (copy the sample's file of the same name and adapt it)
test/*.test.mjs           business tests
<product>/dsh-profile/    a copy of profile/template, plus hand-written tool and wording modules → 06-dsh-profile.md
web/                      business web app (React + web-kit)                                   → 07-web-and-bff.md
bff/                      the business web app's BFF (@dsh-bridge/gateway)
```

- There is no sample for `web/` and `bff/` inside the framework (the sample has only a single plain-JS screen). The rules for building them are in `07-web-and-bff.md`.
  The business system can also serve its screens without a BFF, but then the BFF-only operations (web assistant, personal bot registration) are unavailable (do not substitute for them by exposing secrets to the browser).

## 3. Build order

1. Read and run the sample `examples/equipment-inspection` (`<framework>` GUIDELINE a.2: PostgreSQL, `EQUIPMENT_DATABASE_URL`, `pnpm --filter @dsh-bridge/example-equipment-inspection start`).
2. Create a new repository (or `examples/<id>/`) and lay out the files as above. Copy the **structure and coding style** from the sample; make the business content your own.
3. Write `bridge.manifest.yaml` and pass `bridge-validate manifest --strict` (04).
4. Write the business tables, business rules (domain), hooks and routes (05). Every state change goes through `kit.tx` + `emitEvent`.
5. Write and pass the business tests and conformance (generic HTTP adapter) (10).
6. The DSH profile (06), the business web app and BFF (07), automatic tasks (06), optional features (08).

## 4. Rules

- **MUST NOT** modify the framework's internals (`packages/*`, `plugins/*`, `vendor/*`, `profile/template`, `profile/scripts`) for your own system
  (the same applies when placing it in `examples/<id>`). Fill gaps with hooks, `toolModules` / `templateModules`, plugin and profile settings, and the product's copy of the profile.
- Role names are free (map them to the suite's generic roles `admin`, `manager`, `staff`, `billing` in the conformance fixtures).
- Read secrets from environment variables in `src/config.mjs` and reject the defaults in production (see the sample's `src/config.mjs`).
