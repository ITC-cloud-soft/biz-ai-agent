# @dsh-bridge/web-kit

React + TypeScript parts for the **business web app** of a system on the Biz Assistant Framework (packages `@dsh-bridge/*`), generalized from
care-ai-native `apps/care-web` (IM bot connection page, self-service SNS linking, notification preferences, platform labels;
since 2026-10-29 also the administrators' AI employee profile page and the manual renderer).
A library: no app shell, no router, no icon library, no business branding. Text is Japanese with an override map; colours
are CSS variables.

| part | what | generalized from (care-ai-native) |
|---|---|---|
| `ImBotsShell` | settings › IM bot connection: channel list with live `connection.status` pills, main / other groups, one channel's dsh-im SettingsTab, one notice when the gateway itself is down. `mode="admin"` (organisation bots, `excludeBotIds` hides the employees' personal bots) or `mode="personal"` (the employee's own bots through the BFF's personal RPC) | `src/pages/ImBots.tsx` |
| `ImEmbed`, `ChannelPanel` | the area where dsh-im's vendor settings components render (styles, translator, 「詳細設定」, error boundary) | `src/im/ImEmbed.tsx` |
| `createImRuntime`, `channelDefs`, `installStyleCapture` | the runtime the vendor components need: `<style>` → adoptedStyleSheets (CSP `style-src 'self'`), the translator chain, lazy channel loaders, the WeChat QR panels | `src/im/runtime.ts`, `src/im/weixin.tsx` |
| `SnsLinkPage` | settings › SNS linking (every employee, **own links only**): ① my own bots on every personal channel (`personalChannels`; legacy: personal WeChat by QR), ② org bots by link code, ③ my links (unlink), ④ notification preferences | `src/pages/SnsLink.tsx` |
| `WeixinConnect`, `useLinkCode` / `LinkCodeBox` | personal WeChat QR flow (BFF endpoints + the fork's panels) and the 6-digit link code with countdown | `src/components/WeixinConnect.tsx`, `LinkCode.tsx` |
| `NotifyPrefsCard` | the employee's own notification types + quiet hours (types from the server / manifest, descriptions from the host) | `src/components/NotifyPrefsCard.tsx` |
| `PlatformBadge`, `platformLabel` | Japanese platform labels | `src/lib/im-platforms.ts` |
| `AiProfilePage` | administrators › the AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md): nickname, first person, tone, company introduction, personality, background, speaking examples, per-AI-employee overrides (`agents`), the preview of the signature and of the system prompt section (fixed rules first; `personaPreview` = dsh-core `renderPersona`), the server's field errors (`rule_override` / `personal_data` in Japanese), the versions with 「この版に戻す」. Props `appName`, `endpoint` (default `/bridge/v1/admin/ai-profile`; restore `<endpoint>/versions/<n>/restore`) or `client`, `agents: [{ id: <preset id>, name }]`, `showRules`, `formatUser`, `title`, `description`, `links`. Strings `aiProfile.*` | — |
| `ExternalConnectorsPage` | administrators › the AI employee's external connectors (docs/AI_EMPLOYEE_PROFILE.md §3): the emergency stop, the connectors (name, kind, https base URL, allowed hosts, auth, timeout, calls per minute, on / off, the operations as JSON), 「ひな形から追加」 (default `BILLING_SOFTWARE_TEMPLATE`: a billing software's read of a month's import status), the secret (a password field, sent once; the list shows the hint only), the connection test (a read: status, timing, field names), the rules (event / cron, conditions and input as JSON, mode, approvers, allowPii, on / off) and the run log. Props `base` (default `/bridge/v1/admin`) or `client`, `templates`, `roleLabels`, `formatUser`, `title`, `description`, `links`. Strings `conn.*` (field errors `conn.err.<code>`) | — |
| `AssistantMarkdown` | an AI assistant's answer as safe Markdown (bold, italic, headings, lists, tables, code, links; never HTML). Props `text`, `origin` (default `location.origin`), `allowedHosts` (external links, new tab, `rel="noopener noreferrer"`), `allowedPrefixes` (own paths, default `['/']`), `onNavigate` (the host's router), `headingOffset` (default 2: `#` → h3) | — |
| `AssistantAttachmentPicker`, `useAssistantAttachments` | files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md): choose, drag and drop, paste an image, thumbnails / names / sizes / ×, the limits and types, images refused with the reason when the model cannot read them, 「送信中…」, the privacy line. `const h = useAssistantAttachments({ settings, images })` (`settings` = `normAttachmentSettings(<GET attachment-settings>)`, `images` = the agent's `capabilities.images`), `<AssistantAttachmentPicker handle={h} busy={sending} />`, `onPaste={h.onPaste}` / `{...h.dropProps}` on the host's text box or panel, `h.message()` → `attachments: [{ name, mediaType, data }]`, `h.clear()` after sending, `h.showError(code)` for the BFF's refusal. Strings `attach.*` | — |
| `AttachmentSettingsCard` | administrators › which roles may attach files and which types. Props `roles: [{ id, label, help? }]`, `types?`, `endpoint` (default `/bridge/v1/admin/assistant/attachment-settings`) or `client`, `title`, `subtitle`, `onSaved`. Strings `attachSettings.*` | — |
| `WebKitProvider` / `useWebKit` | strings + overrides, platform labels, API clients, runtime, toast / confirm hooks of the host | — |
| `@dsh-bridge/web-kit/core` | the pure logic (`*-core.ts`, no React / DOM): `platforms-core`, `strings-core`, `rpc-core`, `me-im-core`, `notify-core`, `link-code-core`, `im-runtime-core`, `ai-profile-core` (`createAiProfileClient`, `personaPreview`, `signaturePreview`, draft helpers), `help-markdown-core` (`manualChapters`, `parseMarkdown`, `sectionsOf`; manual and answers), `assistant-markdown-core` (`parseAssistantMarkdown`, `assistantLinkHref`), `assistant-attachments-core` (`planAdd`, `attachmentTypeOf`, `sniffMatches`, `fileToBase64`, `normAttachmentSettings`, `createAttachmentSettingsClient`, `ASSISTANT_ATTACHMENT_LIMITS`), `external-connectors-core` (`createConnectorsClient`, `ConnectorsError`, `BILLING_SOFTWARE_TEMPLATE`, `emptyConnector`, `emptyRule`, `SECRET_FIELDS`) | `src/im/rpc.ts`, `src/lib/meIm.ts`, `notify-core.ts`, `im-platforms.ts` |

Files: `src/core/*.ts` (logic), `src/components/*.tsx`, `src/im/runtime.ts`, `src/styles.css`, `src/im/im-theme.css`.
The package ships TypeScript sources (`exports` point at `.ts`); the host's bundler (Vite, …) compiles them. Imports between
the sources carry the `.ts` extension, so Node can run the core with type stripping (the tests do).

## Use it

```tsx
import '@dsh-bridge/web-kit/styles.css'
import '@dsh-bridge/web-kit/im-theme.css'
import { WebKitProvider, SnsLinkPage, ImBotsShell, createImRuntime, channelDefs, DEFAULT_CHANNELS, createMeImClient, createAdminRpc } from '@dsh-bridge/web-kit'

// the dsh-im fork's client components (vendor/dsh-im/plugin-src/client) and a language pack: the HOST's bundler loads them
const runtime = createImRuntime({
  loadVendor: async () => {
    const [i18n, meta, styles, ja] = await Promise.all([
      import('<vendor>/dsh-im/plugin-src/client/i18n.js'),
      import('<vendor>/dsh-im/plugin-src/client/channel-card-meta.js'),
      import('<vendor>/dsh-im/plugin-src/client/styles.js'),
      import('<dsh language pack>/locales/ja/dsh-im.json'),
    ])
    return { i18n, meta, styles, dict: ja }
  },
  loadWeixin: async () => {
    const [panels, api, styles] = await Promise.all([
      import('<vendor>/dsh-im/plugin-src/client/channels/weixin/index.js'),
      import('<vendor>/dsh-im/plugin-src/client/channels/weixin/api.js'),
      import('<vendor>/dsh-im/plugin-src/client/channels/weixin/styles.js'),
    ])
    return { panels, api, styles }
  },
})
const channels = channelDefs(DEFAULT_CHANNELS, {
  slack: () => import('<vendor>/dsh-im/plugin-src/client/channels/slack/index.js'),
  line: () => import('<vendor>/dsh-im/plugin-src/client/channels/line/index.js'),
  // ... only the channels you offer
})

<WebKitProvider
  runtime={runtime}
  meIm={createMeImClient({ base: '/bridge/v1', weixinBase: '/api/me/im/weixin' })}   // same origin, the employee's session
  adminRpc={createAdminRpc('/dsh/api/dsh-im')}                                         // the BFF's DSH gateway (@dsh-bridge/gateway)
  strings={{ 'sns.title': '外部アカウント連携' }}                                       // any STRINGS_JA key
  platformLabels={{ line: 'LINE 公式' }}
  toast={(kind, title, detail) => myToast(kind, title, detail)}
  confirm={(o) => myConfirmDialog(o)}
>
  <SnsLinkPage isAdmin={user.role === 'admin'} imBotsLink={<a href="/settings/im">IM ボット接続</a>}
    notify={{ role: user.role, labels: manifestEventLabels, types: myNotifyTypeDefs, groups: myGroups }} />
  {/* administrators */}
  <ImBotsShell channels={channels} selected={search.get('channel')} onSelect={(id) => setSearch({ channel: id })}
    onOpenAdvanced={() => navigate('/settings/ai')} links={<a href="/settings/sns">SNS 連携</a>} />
</WebKitProvider>
```

- **Endpoints.** `createMeImClient` talks to the business system's Bridge v1 `me` endpoints (`GET /me/identities`,
  `POST /me/link-codes`, `DELETE /me/identities/{id}`, `GET / PUT /me/notification-preferences`) — exactly what
  `@dsh-bridge/server-kit` serves — and, for the personal WeChat QR, to the BFF (`<weixinBase>/begin | poll | verify | cancel`,
  `DELETE <weixinBase>/identities/{id}`; the BFF checks the bot is the employee's own). `weixinBase: null` hides ①.
  Older snake_case rows (`team_id`, `external_id`, …) are accepted. 404 / 405 / 501 / 503 are shown as 「準備中」.
- **Personal bots (care-ai-native IM_PERSONAL_BOTS, S1).** `<SnsLinkPage personalChannels={channelDefs(PERSONAL_CHANNELS, loaders)}
  personalRpc={createPersonalRpc()} />` embeds `ImBotsShell mode="personal"`: the same vendor tabs, but the RPC goes to the
  BFF's `POST /api/me/im/rpc/<channel>` (same envelope), which must enforce the rules (per-channel allowlist, own bots only,
  answers cut to the employee's bots, create-only with registration and rollback, …) — the kit only hides the parts an
  employee cannot change (`PERSONAL_HIDDEN_SETTINGS` through the fork's `BotSettingsContext.hiddenSettings`). A successful
  create carries `personalBotCreated: { botId }` next to `value`; the page then shows a link code. `createMeImClient({ unlinkBase })`
  sends every unlink to the BFF (it also deletes the employee's own bot); `listMyPersonalBots` (Bridge v1 `/me/personal-bots`)
  words the unlink dialog. The administrator's page: `<ImBotsShell excludeBotIds={personalBotIds} />` (`withoutBots` /
  `excludingBots` filter every answer).
- **Strings.** `STRINGS_JA` holds every text; `strings` overrides any key; `{name}` placeholders. Notification types: the
  server lists the notified types (the manifest's `notify` events); `notify.types` adds labels / help / roles / groups,
  `notify.labels` fallback labels (e.g. `manifest.events[type].label`), `notify.defaultOff`, `notify.quietKeys`,
  `notify.groupFallback` (heading of types without a group), `notify.defaultQuiet` (quiet hours before / without a saved
  setting; extra keys = the server's own quiet-hour flags, always present after `normPrefs`), `notify.invalidAt`
  (`'hint'` | `'field'`: where "start = end" is reported), `notify.extraQuietRows(draft, set, { types })`.
  Some texts are rendered **rich** (`rt`): placeholders may be elements and `**bold**` spans are allowed — `sns.step2` /
  `weixin.step2` (`{command}`), `sns.codeNotice` (`{admin}` = `sns.adminHint` for administrators, whose `{link}` is
  `imBotsLink`), the status pills (`{connected}/{configured}`).
- **Styling.** `styles.css` defines `--dbw-*` variables on `:where(:root)` (light) and under `[data-dbw-theme="dark"]`; map
  them to your tokens. `im-theme.css` maps the fork's `--dsh-im-*` / `--dsw-alias-*` tokens to `--dbw-*` inside `.dbw-im-embed`;
  pass `dark` to `ImEmbed` / `ImBotsShell` / `SnsLinkPage` for the fork's dark hook.
- **A host with its own design system** keeps its look without forking the components:
  `ui={{ Card, Notice, Pill, Button, Switch, Skeleton, ErrorBox, DataTable, Empty, Preparing, PageHeader, TimeField, TextField, SelectField, Icon }}`
  (any subset of `WebKitUi`; icons are semantic `IconName`s such as `'shield'`, `'bell'`, `'trash'` that the host maps to its
  icon set), `classNames={{ steps: 'my-steps', prefRow: styles.prefRow, … }}` (the layout elements, `DEFAULT_CLASS_NAMES`),
  `formatDateTime={(v) => …}`. Without them, styles.css is not needed (import only `im-theme.css` and map `--dbw-*` inside
  `.dbw-im-embed` to your tokens). ケアビリング's adapter is the reference: care-ai-native `apps/care-web/src/im/webkit.tsx`.
- **Security rules kept from care-web.** Own connections only (the server enforces it; nothing here names another employee);
  the employees' personal bots never appear on the administrator's page (`excludeBotIds`); the BFF secret never reaches the browser; vendor styles go
  through constructable stylesheets so the CSP can stay `style-src 'self'`.

## The manual on a help page

`@dsh-bridge/web-kit/core` `manualChapters(files, { basePath })`, `parseMarkdown`, `sectionsOf`: the manual of `@dsh-bridge/help`
(`docs/manual/NN-*.md`, e.g. imported with Vite `import.meta.glob(…, { query: '?raw' })`) as a tree of blocks and inlines that the page
renders as elements (no HTML injection); chapter links go to `<basePath>/<chapter>#<anchor>`, heading ids are the section anchors
(the `manualUrl` of the AI's answers). The same reader, with option `breaks` (line breaks kept) and `linkHref` (the host's link rule), also
reads the AI assistant's answers (`AssistantMarkdown`); it knows headings to `######`, `*italic*`, fenced code blocks, the first number of an
ordered list and escaped `\|` in table cells.

## The AI assistant panel (not part of this package)

The right-hand 「AI アシスタント」 panel of a business web talks to `@dsh-bridge/plugin-assistant` **through the BFF only**: the
BFF gets a ticket for the logged-in employee (`POST /bridge/v1/assistant/tickets`, `x-bff-secret`) and calls
`gateway.rpc('/assistant', '<method>', { ticket, agent, text?, context? }, { plugin: 'bridge-assistant' })` of
`@dsh-bridge/gateway` — DSH route `POST /api/bridge-assistant/assistant`, method `bridge-assistant/assistant`, allow-list entry
`{ plugin: 'bridge-assistant', channel: '/assistant', methods: ['agents.list', 'conversation.get', 'message.send', 'message.cancel', 'conversation.reset'] }`.
The browser never sees the ticket or the DSH cookie. Error codes to map to Japanese in the host: `ticket-invalid`,
`api-unavailable` (the business API did not answer), `rate-limited`, `agent-busy`, `agent-unknown`, `application-unknown`,
`text-too-long`, `bad-request`, `harness-unavailable`; for files: `too_many_files`, `file_too_large`, `total_too_large`, `unsupported_type`,
`type_mismatch`, `no_text`, `attachments_not_allowed`, `images_not_supported`, `invalid_attachment`, `attachment_prepare_failed` (strings `attach.err.<code>`).
Show the answers with `AssistantMarkdown` and the file picker with `AssistantAttachmentPicker`; the BFF checks the files with
`prepareAssistantAttachments` of `@dsh-bridge/gateway` and sends them as `message.send { attachments }`.

## Tests

```
pnpm --filter @dsh-bridge/web-kit test     # node --test test/*.test.mjs, then tsc --noEmit
```

`core.test.mjs` (labels, strings, link codes, runtime catalog, "no business branding in src"), `rpc-core.test.mjs`
(envelope, Japanese errors, a real HTTP round trip, channel status), `me-im-notify.test.mjs` (the `me` client against a real
`@dsh-bridge/server-kit` system — the test toy of server-kit — and the notification logic), `ai-profile.test.mjs` (the preview gives the same text as
dsh-core `renderPersona` / `signatureOf`, the limits are the protocol's, the client against server-kit on port 20184), `help-markdown.test.mjs`
(the manual as blocks and inlines, anchors, no HTML), `assistant-core.test.mjs` (answers: blocks, link rule, no HTML; the picker's checks, base64, settings).
`tsc --noEmit` type-checks every component (strict, `erasableSyntaxOnly`).
