# Biz Assistant Framework integration plan for <business system name>

- Created: YYYY-MM-DD / Owner:
- Framework based on: `<commit>` of https://github.com/ITC-cloud-soft/biz-ai (YYYY-MM-DD)
- Path: New / Existing + server-kit / Existing + aliases / Existing + own implementation (language: ) / External mode (trial)
- First business function to handle:

## 1. Assessment (13 items)

| # | What to add | Verdict (exists / alias / add) | Evidence (file, function, table) | Estimated amount to add | Status |
|---|---|---|---|---|---|
| 1 | Read APIs and an endpoint that receives proposals | | | | |
| 2 | manifest | add | — | | |
| 3 | Each employee's own chat link (on the system's own login) | | | | |
| 4 | Recipient rules | | | | |
| 5 | Events in the same transaction | | | | |
| 6 | Employees and roles | | | | |
| 7 | Approval rules (in one place) | | | | |
| 8 | Session check | | | | |
| 9 | Manual (recommended) | | | | |
| 10 | Personal data check of the roster (recommended) | | | | |
| 11 | AI employee profile (recommended) | | | | |
| 12 | Scheduled reports | | | | |
| 13 | External connectors (optional) | | | | |

The 4 capabilities if external mode is chosen: IdP ( ) / APIs callable as the user ( ) / notification of changes after commit ( ) / approval and write APIs ( ) → type: A / B / C

## 2. What the user decides (record the decision and the date)

| Item | Options | Recommendation | Decision |
|---|---|---|---|
| What the AI may read (tools and roles, delegation per role) | | | |
| Events to notify, recipient rules, handling at night | | | |
| Proposal kinds and the roles that may accept them | | | |
| Delegation class and employee for automatic tasks (or each) | | | |
| Outbound settings to open (opt-in) and why | None (recommended) | | |
| Chat, bot and AI model to use | | | |
| Optional features (manual, profile, attachments, external connectors) and handling of scanned PDFs | | | |

## 3. Manifest design

- system.id / namespace:
- Roles:
- Events (type, payload allowlist, recipient rules):
- Templates (intent, action, argument types):
- Tools (read / propose, roles):
- Playbooks (trigger, tools, delegation, prohibited actions):
- Reports (sections, times, per role):

## 4. Progress

| Step | Content | Status | Notes |
|---|---|---|---|
| 1 | manifest (--strict exit 0) | | |
| 2 | hooks / aliases / own implementation | | |
| 3 | Events in the transaction | | |
| 4 | conformance 52 / 52 (skip 0) | | |
| 5 | DSH profile (closed values, linkGuard, presets) | | |
| 6 | Business web app and BFF | | |
| 7 | Automatic tasks | | |
| 8 | Optional features | | |

## 5. Definition of done results

| # | What | Command | Result |
|---|---|---|---|
| 1 | manifest | | |
| 2 | conformance | | |
| 3 | Business tests | | |
| 4 | Manual | | |
| 5 | Product profile | | |
| 6 | Outbound settings (check.mjs) | | |
| 7 | Rejection of fixed destinations | | |
| 8 | Business web app (tsc) | | |

Not verified (such as confirmation in a real chat or with a real model):

## 6. What was added to the existing system (for explanation)

(Do not write "it connects without changing anything". List the APIs, tables, screens and settings that were added.)
