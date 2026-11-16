# 04 Writing and validating the manifest

Source of truth: `docs/GUIDELINE.en.md` b.1, d.2, d.5, `packages/protocol/README.md`, JSON Schema (in `packages/protocol`).
Sample to start from: `examples/equipment-inspection/bridge.manifest.yaml` (recommended) or `packages/protocol/manifests/example.manifest.yaml`.
(`packages/protocol/manifests/equipment-inspection.manifest.yaml` is a copy for validation and does not include the manual tool. Start from the one in examples.)

## 1. Sections and what to write

| Section | What to write | Notes |
|---|---|---|
| `bridge` / `version` | `bridge: 1`, the manifest version (SemVer or a date) | The etag is derived from the content |
| `system` | `id` (= the app id in DSH), `name`, `locale`, `timezone` | The id equals `applications[].id` in the registry |
| `roles` | Per role: `label`, `scope`, `delegation: none | read | propose` | The upper limit of AI delegation. Map every role in the conformance fixtures (M3) |
| `entities` | Data kinds and their personal-data classification (none < personal < financial < sensitive < health), `link` | Also declare `approval` and `sns_identity` |
| `audienceRules` | Names and descriptions of the recipient rules | Resolution is done by the business system's `recipientsFor`. DSH does not create recipients |
| `events` | Per type: `label`, `aggregate`, `payload` (**allow-list**), `severity`, `audience`, `notify`, `playbook` | The payload holds only IDs, dates, counts and states |
| `templates` | Notification wording: `intent` (info / action / urgent / approval / consult), `action` for action / urgent, `description`, `params` types | Parameters are numbers, dates, times and the like only (there is no free-text string type) |
| `tools` | The AI's business tools: `name` (`<namespace>_*`), `http`, `access: read | propose`, `roles`, `pii`, `input` | Writes are always `access: propose` (`POST /bridge/v1/proposals`) |
| `playbooks` | Automatic tasks: `agent`, `trigger`, `instructions` (state the prohibitions), `tools`, `audience`, `delegation`, `delivery`, `guard`, `enabled: false` | `agent` becomes a preset in the product profile |
| `reports` | Scheduled reports: `cron`, `audience`, `sections`, `sectionsByRole` | When read via delegation, only the sections for the role |
| `help` / `web.routes` | The manual search tool; the path types of the business web app's screens | Link checking needs `web.routes` (write it even if you do not use the manual) |

## 2. The 3 events that must be declared (MUST)

server-kit and business code write with these payload keys, so without them unlinking and approval creation fail, and conformance L9, A1–A4 and E2 fail.

```yaml
entities:
  approval:     { label: Approval, pii: none }
  sns_identity: { label: Chat link, pii: personal }
events:
  approval.requested:
    { label: Approval request for …, aggregate: approval, severity: info, internal: approvals_im, audience: { rule: <approver rule> },
      payload: [approvalId, subjectType, subjectId, requiredRole, expiresAt] }
  approval.decided:
    { label: Approval decision for …, aggregate: approval, severity: info, internal: approvals_im,
      payload: [approvalId, subjectType, subjectId, decision, status, channel, decidedByUserId] }
  sns_identity.unlinked:
    { label: Chat link removed, aggregate: sns_identity, severity: info, internal: identity, payload: [identityId, userId, platform] }
```

The source of truth for the list is `INTERNAL_EVENTS` in `@dsh-bridge/protocol`. `approval.decided` may also be a notification event without `internal` (same payload).

## 3. Validation (put it in CI)

```sh
node <framework>/packages/protocol/bin/bridge-validate.mjs manifest bridge.manifest.yaml --strict
```

- Without `--strict`, it exits 0 even with warnings, so always add it when judging a pass.
- Besides the schema, it checks cross-references (tool roles exist, playbook tools exist, notifying events have an audience and a declared template,
  `<class>=each` playbooks are triggered by an event…) and payload keys and template parameter names that look like personal data (`residentName`, `comment`, `memo`, etc.; `…Id` is fine).
- Business tests may also confirm that `validateManifest(m).warnings` is empty (sample `test/domain.test.mjs`).

## 4. Judgment calls when writing

- **Tool roles**: do not exceed what employees in that role can see in the business web app. The AI's permission is "AI allow-list (tool roles) ∩ employee's role".
- **Event granularity**: only changes used by notifications, automatic tasks and reports. Do not put names, contact details, free text, health information or amount breakdowns in the payload.
- **Wording**: every template has an `intent`; action / urgent have an `action` (what you are asking for). Factual sentences contain only counts and dates. The frame (label, greeting, signature, link) is added by the plugin.
- **Playbook instructions**: state that it decides nothing, does not write names or personal data into memos or reports, reads business data only through tools, and ends quietly if there is nothing
  (the "Instruction rules" in `<framework>/profile/template/auto-tasks/README.md`). Ship with `enabled: false`; the operator enables it.
- **Night time**: only kinds that may be delivered at night (such as safety checks) get `notify.quiet: exempt`. Frequent kinds use digest sending (`digestMinutes`).
- **Versions**: within v1, only add. Do not delete event types that are no longer emitted; mark them `deprecated: true`.
