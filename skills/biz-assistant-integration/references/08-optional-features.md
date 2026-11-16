# 08 Optional features

Sources of truth: `docs/GUIDELINE.en.md` b.8, b.9, d.10–d.13, `packages/help/README.md`, `plugins/memory/README.md`, `plugins/persona/README.md`, `plugins/reader/README.md`,
`docs/AI_EMPLOYEE_PROFILE.md`, `docs/ASSISTANT_ATTACHMENTS.md`, `docs/DOCUMENT_READS.md`.

## 1. Answer how-to questions over chat (manual, b.8)

1. **Manual**: one screen = one section (`## Screen name`, `<a id="manual-…"></a>`, a table: URL, menu, roles that can use it, related screens, keywords; body: what you can do, steps, cautions, FAQ).
   The format is in `packages/help/README.md`. Synonyms go in `_synonyms.yml`; routes without a section go in `_exclude.txt` (write the reason).
2. **Index and CI**: read the manual and the business system's **route table** (`[{ path, roles }]`, from the router and Guards), run `buildHelpIndex`, and commit the JSON.
   In CI, compare against `serializeIndex(buildHelpIndex(...))` and confirm that the `check*` functions (routes, coverage, roles, menu names, anchors, links) return empty.
   Write the manifest's `web.routes` with the same script (`setManifestWebRoutes`). With few screens, the sample's simplified form (build the index at startup and only run `check*`) is fine.
3. **API**: `createBridgeApp({ help: createHelpService(index, { webBase, roleLabels, manualPage }) })`. If you log questions, keep no personal data.
4. **manifest**: `help: { tool: <ns>_help_search }` and that tool (`GET /bridge/v1/help/search`, read, all roles). Paste the `helpRules('<ns>_help_search')` text into the persona.
5. **DSH**: the business web app URL in `linkGuard` (every app).
6. **Business web app**: a help screen at `manualPage` (default `/help/{chapter}#{id}`). That route also goes in `web.routes`.

Rules: answer only from the sections returned (if nothing is found, say so). Use the returned URLs as they are. For a screen the person cannot open, do not give the URL; tell them whom to ask.

## 2. Long-term memory (bridge-memory, d.10)

- Included in the template by default. The business system has `POST /bridge/v1/pii-scan` (server-kit has it by default: a shape check).
- **Systems that hold names implement `hooks.piiScan`** (search the roster for names [family name, given name, kana] and return only the categories). The shape check does not know names.
- Memory holds only preferences, ongoing matters and notes (personal), and procedures, reasons for decisions and operational preferences (organization). No business data, personal data or health information.
- To change the name, categories or retention, use `createMemoryPlugin` (do not fork).

## 3. AI employee profile (bridge-persona, d.11)

- server-kit has `GET /bridge/v1/ai-profile` and the admin routes by default (`roles.admins`; disable with `aiProfile: false`). In your own implementation, check with `validateAiProfile`, and keep versions and an audit (version numbers only).
- An admin-only "AI employee settings" screen in the business web app (`AiProfilePage`, one nickname by default).
- The profile does not change permissions, tools or safety rules. The signature "— <nickname> (<app name> AI secretary)" shows that it is an AI. Avoid nicknames that could be confused with real people.

## 4. File attachments to the AI assistant (d.12)

- server-kit has `/bridge/v1/assistant/attachments/prepare`, `attachment-settings` and the admin routes by default. In your own implementation, use `@dsh-bridge/server-kit/extract`.
- **Decide how scanned PDFs are handled** (the user's decision): an OCR engine function in `createBridgeApp({ attachments: { ocr } })` (images do not leave) / omitted = sent to the model as images / `false`.
  If you handle documents with personal or health information, use engine or `false`.
- The BFF uses `prepareAssistantAttachments`; the panel has `AssistantAttachmentPicker` and the sentence "Attached content is sent to the AI model."; answers use `AssistantMarkdown`; administrators get `AttachmentSettingsCard`.
- Determine the type from both the extension and the leading bytes. Limits: 5 files, 10 MB, 20 MB in total (they may be lowered). Neither the original nor the converted text is stored.

## 5. External connectors (connections, operations, rules, b.9, d.13)

1. `createBridgeApp({ connectors: { secretKey } })`: `secretKey` has at least 32 characters and comes from an environment variable (do not write it in the repository or yml; the default value is rejected in production). `store.migrate()` creates the tables.
2. Rules: `kit.connectors.tick()` in `startScheduler` (every minute). The trigger is an event or cron; `mode` is `approval` (default) / `auto` (reads, and idempotent writes allowed with a reason) / `propose-by-ai`.
3. Write operations need human approval: the AI creates a `connector_write` proposal. `onApprovalNeeded` hands it to the business system's approval mechanism.
4. DSH: bridge-tools creates `<namespace>_ext_<connection>_<operation>`. Do not write connection URLs or secrets in the DSH profile.
5. Business web app: an admin-only `ExternalConnectorsPage`. The BFF forwards `/bridge/v1/admin/connector*` with the person's cookie as is.
6. Start with one or two reads. Connections are https and allowed hosts only. Records, audit and IM notices contain only IDs, counts and states.

## 6. The AI reads scanned documents (bridge-reader)

- The business system lists documents it could not read (images, PDFs without a text layer) as page images (up to 10 pages each) in `GET /bridge/v1/document-reads`,
  and receives bridge-reader's transcription at `POST /bridge/v1/document-reads/{readId}/result`.
- Put every field built from the returned text in a state that **needs human confirmation** (never finalize automatically). Page images are sent to the model provider, so provide a setting to stop this and explain it on the screen.
