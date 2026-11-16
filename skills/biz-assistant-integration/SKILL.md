---
name: biz-assistant-integration
description: >-
  Step-by-step guide for bringing the Biz Assistant Framework (Biz Assistant, packages @dsh-bridge/*, repository https://github.com/ITC-cloud-soft/biz-ai)
  into a business system. Covers both building a new business system on top of the framework and adding a "bridge" to an existing business system
  (the Bridge v1 endpoints, the manifest, each employee's own chat link, recipient rules, a transactional outbox, approvals and reports) so that it works with AI employees,
  and guides the work through assessment → plan → implementation → verification (strict manifest validation, conformance 52 / 52, profile checks).
  Use it for requests such as "integrate Biz Assistant Framework", "integrate Biz Assistant Framework into an app", "connect Biz Assistant Framework to our existing system",
  "add AI employees to our business system", "make our business system work with AI employees", "implement Bridge v1", "write a manifest", "server-kit hooks",
  "pass the conformance suite", "register in the DSH profile".
---

# Bringing the Biz Assistant Framework into a business system

This skill is the procedure for putting the Biz Assistant Framework into a business system (an IT system with employees, roles and a login)
so that it works with **AI employees** (an AI assistant for each employee that notifies, asks, and drafts in chat, while people decide).

- **The source of truth is the documentation in the framework repository.** This skill summarizes the route and the key decisions; always check details and current values in the repository.
  - `docs/GUIDELINE.en.md` (also in Japanese, the original: `docs/GUIDELINE.md`, and Chinese: `docs/GUIDELINE.zh-CN.md`) (development guideline: steps in b, extension points in c, rules in d, testing in e, versioning in f, FAQ in g)
  - `docs/ARCHITECTURE.md` (structure, flows, recipient guarantees, safety commitments)
  - `packages/protocol/README.md` (Bridge v1, manifest, the 52 conformance items), `packages/server-kit/README.md`, `packages/web-kit/README.md`, `plugins/*/README.md`
  - Example: `examples/equipment-inspection` (a business system newly built on server-kit; conformance 52 / 52)
- Detailed procedures are split into `references/` in this folder. Read only what you need right now (see "Which reference to read" below).

## 0. First steps

1. **Get the framework locally** (if you cannot read it, check access with the user):

   ```sh
   git clone https://github.com/ITC-cloud-soft/biz-ai.git framework
   cd framework && git log -1 --format='%h %cs'     # record which version the work is based on
   pnpm install && pnpm test && pnpm validate      # Node 22.19 or later, pnpm 10. First confirm the framework itself passes
   ```

   From here on, the framework checkout is written as `<framework>`. `@dsh-bridge/*` is on npm (0.1.0); the checkout is still the
   source of truth for documents and checks (see "Location and dependencies" in `references/02-new-system.md`).
2. **Read "Connecting an existing business system: checklist" at the top of `docs/GUIDELINE.en.md` and the diagram in section b.** The steps of this skill correspond to them.
3. **Read the target business system**: language and framework, login and sessions, the employee and role tables, business APIs (reads and writes), approval rules,
   state-changing operations (where transactions are opened), scheduled jobs, and whether there is a business web app and a server side for it (BFF).

## 1. Choose a path

| Situation | Path | Main reference |
|---|---|---|
| A business system you are about to build | **New**: build on server-kit (the kit owns the Bridge part; you write the business logic, hooks, manifest and screens) | `references/02-new-system.md` (GUIDELINE b.0) |
| Existing, Node.js, and you may change its code | **Existing + server-kit**: mount `createBridgeApp` on the existing server and wire hooks to the existing tables and functions | `references/03-existing-system.md` |
| Existing, already has APIs that do the same job | **Existing + aliases**: mount `/bridge/v1` on the existing routes as aliases (add whatever is missing) | `references/03-existing-system.md` (GUIDELINE b.2') |
| Existing, not Node.js | **Existing + own implementation**: implement `packages/protocol/openapi/bridge-v1.yaml` in that language and verify it with conformance | `references/03-existing-system.md` |
| Existing, and no code changes at all are wanted | **External mode (trial)**: put a dedicated bridge service outside. Requires the existing system to have an IdP, APIs callable as the user, notification of changes after commit, and approval and write APIs | `references/03-existing-system.md` (GUIDELINE b.10, EXTERNAL_LAYER_FEASIBILITY.md) |
| Too much to add (only screens, no APIs) | Rebuild as new, or move business functions to a new system one at a time | `references/01-assessment.md` |

When unsure, run the assessment in `references/01-assessment.md` first, show the result to the user and let them decide.

## 2. How to proceed (same order on every path)

At the start of the work, copy `templates/integration-plan.md` to create the plan, and update the status of each item.

1. **Assessment and plan** (`references/01-assessment.md`): tabulate the 13 checklist items as "exists / add / alias" and estimate how much must be added.
   Decide **one business function** to handle first (for example, invoice approval or inspection due dates). List the points that need the user's decision (see "What the user decides" below).
2. **Write and validate the manifest** (`references/04-manifest.md`): roles and delegation ceilings, events and payload allowlists, message wording, tools, playbooks, reports.
   The 3 events for approval and unlinking are required. `bridge-validate manifest --strict` exits 0.
3. **Implement the business side** (`references/05-business-side.md`): hooks (`employees`, `authenticate`, `isSessionLive`, `recipientsFor`, `approvals`,
   `proposalKinds`, `reports`, `piiScan`), `readToolPolicy` on the AI's read GETs, and writes only from a human session.
4. **Write events in the transaction** (same reference): the business row and `kit.emitEvent` in the same `kit.tx`.
5. **The 52 conformance items** (`references/10-verification.md`): against a TEST environment. Align fixtures with the copy of the roles and the hooks.
6. **Register in the DSH product profile** (`references/06-dsh-profile.md`): copy `profile/template`, the registry, the bot, outbound settings kept at their closed values,
   the `linkGuard` URL in every app, and the AI employee presets.
7. **Business web app and BFF** (`references/07-web-and-bff.md`): screens for chat link, notification settings, approvals, AI proposals and AI employee settings, the gateway, and the BFF's secret rules.
8. **Automatic tasks** (second half of `references/06-dsh-profile.md`): decide the delegation class and the employee, then enable the playbooks.
9. **Optional features** (`references/08-optional-features.md`): answering how-to questions from the manual, roster checks for long-term memory, the AI employee profile, attachments, external connectors, scanned documents.
10. **Confirm the definition of done with commands** (`references/10-verification.md`): manifest, conformance, business tests, manual, profile, outbound settings, type checks.

Before and after each step, review that nothing violates `references/09-rules.md` (summary of MUST / SHOULD).

## 3. Rules to keep (key points; full text in GUIDELINE section d)

- **Do not modify the inside of the framework** (`packages/*`, `plugins/*`, `vendor/*`, `profile/template`, `profile/scripts`). Fill gaps with hooks,
  tool/wording modules, plugin and profile settings, and the product's copy of the profile. If something is truly missing, file an issue against the framework.
- **The AI only reads and proposes**: the AI's tools are only GETs and `POST /bridge/v1/proposals`. Business write APIs return 403 to delegation. Do not let the AI decide amounts.
- **The business system decides the recipients**: decide the scope with `recipientsFor`, and check each person, one by one, with the same function as the web authorization: "can this person see the same object in the business web app?"
  If the scope cannot be determined, do not send.
- **Keep personal data out of events and messages**: payloads carry only IDs, dates, counts and states; message arguments are only numbers and dates; links are paths containing only IDs.
- **Chat links are made only by the employee themselves, on the system's own login**: do not build a separate identity check. Not even an administrator can create someone else's link.
- **Do not write secrets in the repository, yml, logs or chat**: write only the environment variable names in the configuration. Have the user enter the secret values.
- **Keep outbound settings at the template's closed values**: the only thing that may open them is an explicit opt-in (change that line and leave the reason in a comment).
- **Test only with fictional data, loopback and a TEST environment.** Do not point at production or demo ports or DBs. Run DSH in an isolated home (do not use your personal `~/.dsh`).
- **Do not say "it connects without changing anything"**: state in the plan what is added to the existing system.

## 4. What the user decides

Do not decide the following by guessing; write the options and a recommendation in the plan and wait for the user's decision.

- The first business function to handle and what the AI may read (the manifest's `tools` and each tool's `roles`, and `delegation: none | read | propose` per role)
- Which events to notify and their recipient rules (to whom, in what scope), and which kinds are delivered at night too (`notify.quiet: exempt`)
- The kinds of proposals the AI may make, and the roles that may accept them
- The delegation class for automatic tasks and the employee delegated to (do not pick a broad role), or `<class>=each`
- Whether any outbound setting is opened (opt-in), and why
- Which chat to use (the organization's bot or personal bots) and which AI model to use
- Whether to adopt the optional features (manual, profile, attachments, external connectors), and how to handle scanned PDFs (OCR engine / model / do not read)

## 5. Which reference to read

| What you need to know now | What to read |
|---|---|
| What to add to an existing system, and which path | `references/01-assessment.md` |
| Repository layout and dependencies when building new | `references/02-new-system.md` |
| How to mount on an existing system (server-kit, aliases, other languages, external) | `references/03-existing-system.md` |
| Writing and validating the manifest | `references/04-manifest.md` |
| Implementing hooks, events, recipients, approvals, proposals and reports | `references/05-business-side.md` |
| DSH profile, registry, outbound settings, automatic tasks | `references/06-dsh-profile.md` |
| Business web app screens and BFF rules | `references/07-web-and-bff.md` |
| Manual, memory, profile, attachments, external connectors, documents | `references/08-optional-features.md` |
| Summary of MUST / SHOULD | `references/09-rules.md` |
| Conformance, definition of done, final checklist | `references/10-verification.md` |
| Plan template | `templates/integration-plan.md` |

## 6. Finishing

- Report the results of the definition of done (`references/10-verification.md`) with the commands and a summary of their output. Write "not verified" for anything you did not check (such as confirmation in a real chat or with a real model).
- Leave in the plan what was added, what was decided, any settings opened (opt-in) and why, and the remaining work.
- Write down the framework version (commit) the work was based on. When the framework version goes up, check GUIDELINE section f (versioning) and the changes.
