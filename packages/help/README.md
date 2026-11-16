# @dsh-bridge/help

Employees ask the AI secretary on SNS "how do I …?", "where is …?". This package lets a business system answer **from its own manual**,
with **the right screen's URL**, for **the asker's role** — and keeps the manual in step with the screens in CI. Japanese / Chinese work
without a tokenizer (character bigrams). No runtime dependency; the only I/O is reading a manual folder you name.

```
manual (Markdown)  →  index (JSON, in CI)  →  search API (server-kit help, or your own route)  →  AI tool (dsh-core help-tool)
                                                                                                   →  【ご案内】 answer + link guard
```

## The manual format

One screen = one section: an `## ` heading, an anchor `<a id="manual-…"></a>`, a table, a short summary, then subsections.

```markdown
## Monitoring
<a id="manual-cm-monitoring"></a>

| 項目 | 内容 |
|---|---|
| URL | `/cm/monitoring`（detail：`/cm/monitoring/:id`） |
| メニュー | Workspace › Group › Monitoring |
| 使える役割 | … (checked against the screen's guard in CI) |
| 関連する画面 | [Benefit](#manual-cm-benefit) |
| キーワード | the words people ask with, 5–10 |

One to three sentences.

### できること / ### 操作の流れ / ### 注意・決まりごと / ### よくある質問 (- **Q. …** / A. …)
```

Row names are `DEFAULT_LABELS` (Japanese and English; pass `labels` to change them). A mobile-app section has 「アプリの画面」 (screen id,
tab) instead of URL; a channel section may list 「関係する画面」. Lines marked 「（要確認）」 become `unconfirmed` (the AI says to ask the
administrator). Next to the chapters (`NN-name.md`): `_synonyms.yml` (one group a line, `- [word, …]`, the first word is the manual's
own) and `_exclude.txt` (routes without a section, with a reason).

## Parts

| module | exports | what it does |
|---|---|---|
| `manual` | `parseChapter`, `parseManual`, `parseSynonyms`, `parseExclusions`, `DEFAULT_LABELS`, `UNCONFIRMED_RE` | Markdown → sections `{ id, chapter, title, menu, paths, screens, app, roleText, keywords, summary, can, steps, notes, qa, related, unconfirmed }` |
| `files` | `readManualDir(dir)` | `{ files, synonyms, exclusions }` |
| `routes` | `routePattern`, `routeOf`, `listPath` | screen patterns (`:id`, trailing `/*`); a detail screen links its list |
| `build` | `buildHelpIndex({ chapters, routes, roles, appRoles?, appChapters?, publicSections?, synonyms? })`, `serializeIndex`, `setManifestWebRoutes` | the index: **roles from the business system's route table** (`[{ path, roles, caps?, open? }]`), never from the manual's text; `public` sections (sign-in, SNS linking) for senders that are not linked; deterministic (CI compares it). `setManifestWebRoutes` writes the manifest's `web.routes` (the link guard's list) |
| `check` | `checkAnchors`, `checkSectionPaths`, `checkCoverage`, `checkRoleText`, `checkMenuLabels`, `checkLinks`, `checkLinksAreRoutes` | CI: every path is a route, every route and menu item has a section (or an exclusion), 「使える役割」 names every role the guard admits, the menu label matches, anchors are unique, links resolve, the links the system sends (notices, manifest entities) are routes. Each returns a list of problems |
| `search` | `createSearcher`, `searchManual`, `answerOf`, `normalize`, `terms`, `expandQuery`, `canUse` | NFKC + kana folding, character-bigram BM25F (title / keywords ×3, FAQ questions ×2, body ×1, a question that is a title ×1.5), fillers stripped, synonyms added. `found` needs a score (scaled by the manual's size) **and** coverage of the question's own terms. Per role: `prefer` chapters, `demote` screens the asker cannot open. An answer has `url` only when the role may open the screen (`alt` = whom to ask otherwise) and `manualUrl` (`manualPage`, default `/help/{chapter}#{id}`) |
| `service` | `createHelpService(index, { webBase, roleLabels, prefer, demote, manualPage, altText })` | `{ search(question, { role, limit, publicOnly }), section(id, { role }) }` — the server-kit `help` option |

## Wiring it

1. **Manual and CI** (business repo): write `docs/manual/NN-*.md`; a script builds the index from the manual and **your route table**
   (where the screens' guards are: e.g. the app's router), commits it, and fails CI when it is stale; a test runs the `check*` functions.
   Reference: care-ai-native `tools/manual-index.mjs` and `services/care-api/test/help-manual.test.mjs`; the minimal one:
   `examples/equipment-inspection/src/help.mjs` and `test/help.test.mjs`.
2. **API**: server-kit `createBridgeApp({ …, help: createHelpService(index, { webBase, roleLabels }) })` serves
   `GET /bridge/v1/help/search`, `/help/public`, `/help/sections/:sectionId` (optional operations of Bridge v1). `help.onQuestion` may keep
   a log (your rules: no personal data). A system with its own API serves the same shapes (ケアビリング: `/api/help/*`, v1 aliases).
3. **Manifest**: declare the tool and the capability:
   ```yaml
   help:
     tool: myapp_help_search          # a read tool on GET /bridge/v1/help/search (declared under tools)
     manualPage: /help/{chapter}#{id} # optional
   web:
     routes: ['/', '/orders', '/orders/:id', '/help/*']   # the screens an AI answer may link (setManifestWebRoutes)
   ```
   The DSH generates `myapp_help_search` as the manual search (`@dsh-bridge/dsh-core` help-tool: its rendering, URL rules, refused
   arguments). Add `helpRules(<tool>)` (`HELP_RULES_JA`) to the AI employee's persona.
4. **DSH**: bridge-identity answers a sender that is not linked yet from the public sections (`paths.publicHelp`, only for an application
   whose manifest has `help`) and runs the link guard on every AI answer (`linkGuard.webUrl`, manifest `web.routes`).
5. **Web**: `@dsh-bridge/web-kit/core` `manualChapters` / `parseMarkdown` render the same Markdown on the business web's help page
   (`manualPage`), without HTML injection.

Tests: `node --test test/*.test.mjs` (on the fictional manual of `examples/equipment-inspection/manual`).
