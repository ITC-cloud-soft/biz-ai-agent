# 09 Summary of the rules (MUST / SHOULD)

Source of truth: `docs/GUIDELINE.en.md` section d (d.1–d.13). This is a summary for review. When in doubt, read the original.

## d.1 The AI does not decide

- MUST AI tools are only read (GET) or propose (`POST /bridge/v1/proposals`). Business write APIs return 403 to delegations.
- MUST Code on the DSH side (toolModules, templateModules, custom plugins) does not touch the business DB or the business system's secrets, and uses only `kit.requestJson` / `kit.proposeTool`.
- MUST Finalizing, approving, issuing, paying and sending are done by people in the business system. Accepting or rejecting a proposal is also done only by people, once.
- MUST The AI does not decide or write amounts (do not put amounts in proposal arguments).
- MUST Write the prohibitions in the playbook and in the AI employee's instructions (finalize nothing, do not write personal data in notes or reports, read business data only through tools).

## d.2 Keep personal data out

- MUST Event payloads carry only IDs, dates, counts and states (an allowlist per type). Do not include names, contact details, free text, health information or amount breakdowns.
- MUST Template arguments are only numbers, dates, times, months and flags.
- MUST Links are business web app paths containing only IDs (the business web app authorizes again when the link is opened).
- SHOULD Validate the manifest in CI, and have the business system check strings with `/pii-scan`.

## d.3 Idempotency and once-only

- MUST Every send has an idempotency key. Event processing is at-least-once, so receivers tolerate duplicates (`dedupeKey`).
- MUST An approval is finalized by the decision of any one person, and all other cards become invalid. Cards are also invalidated when the decision is made on the web.
- MUST Link codes, card tokens and reply codes are single-use. Wrong attempts are counted and lead to a lock.

## d.4 Time

- MUST Respect the person's quiet hours. Only types marked `notify.quiet: exempt` may be delivered at night.
- SHOULD Send frequent types as digests.

## d.5 AI secretary message wording

- A label on line 1 (Report, Action requested, Urgent, Approval requested, Consultation; the exact label strings are in GUIDELINE d.5). Facts are counts and dates only. Do not use names. Then either a "▶ What we ask" line or "No action is needed". A signature.
- `intent` on every template, `action` for action / urgent.

## d.6 Platforms

- Chats without buttons use reply codes. Record the reason a send failed (bot not connected, invalid destination, monthly limit, etc.). email is for notifications only.

## d.7 Secrets and environment

- MUST Do not write tokens or secrets in yml, the repository or logs. Settings hold only the names of environment variables.
- MUST Run DSH in an isolated home. Do not expose the launch token to the browser.
- MUST Tests use only fictitious data, test values and loopback. Do not use the demo environment or production ports and DBs.

## d.8 Recipient guarantees and outbound settings

- MUST The business system decides the recipients. Send to everyone in a role only when the event really concerns the whole organization. If the scope is not decided, do not send.
- MUST Do not let the AI choose destinations (leave no model tool that can specify a destination).
- MUST Do not handle business in group conversations (`groupChat: deny`).
- MUST Delegation in turns with no sender is a narrow employee per kind of work (`<class>`) or the person in the triggering event (`<class>=each`).
- MUST Do not send AI free text to anyone other than the person themself (automatic task reports use fixed wording; scheduled reports go only to the person's 1:1).
- MUST Keep the template's closed values. Open them only by explicit opt-in with a reason comment.
- SHOULD Do not rely too much on the body check (`screenOutboundText`). The core of the defense is structure (read only counts, send only to the person's 1:1).

## d.9 Personal bots

- MUST Each employee configures only their own connections. Do not build screens or APIs that view, create or remove other people's connections (administrators included).
- MUST Personal bots are created and changed through the BFF's self-service RPC (allowlist, only the person's own botId, `createOnly`).
- MUST Only the BFF, right after a successful createOnly creation, attaches the secret to `POST /me/personal-bots`.
- MUST In identity lookups, a personal bot counts as linked only when the link belongs to its owner.

## d.10–d.13 Optional features

- Memory: do not store personal data (a double check before storing; if the check cannot be reached, do not store). Systems that hold names use `hooks.piiScan`. Personal memories are for the person only.
- Profile: the business system is the source of truth, only administrators edit it, with versions and an audit. `validateAiProfile`. It does not change the rules. Show that it is an AI.
- Attachments: determine the type by extension and leading bytes, do not store, pass as reference information, safe Markdown, decide how scanned PDFs are handled.
- External connectors: secrets only in the business system, the AI only reads, writes need approval, https and allowed hosts only, records contain only IDs, counts and states.

## Additional commitments for the agent using this skill

- Do not rewrite anything inside the framework. File an issue for anything missing.
- Do not create or enter secret values on the user's behalf (the user enters bot credentials, tokens and keys).
- Do not run conformance or tests against production or the demo environment.
- Do not say it "connects without changing anything". Write what needs to be added in the plan.
