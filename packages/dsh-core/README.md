# @dsh-bridge/dsh-core

DSH side core of the Biz Assistant Framework (L3 in `docs/ARCHITECTURE.md`; packages `@dsh-bridge/*`). One DSH can host several business applications;
this package knows which application a bot belongs to, talks to each application's Bridge API, keeps delegation tokens per
application and gives business tool plugins a common SDK. Private, ESM, no runtime dependencies besides
`@dsh-bridge/protocol` (peer: manifest validation). `@deepseek-ai/schemastery` is used for the plugin config schema when DSH
provides it.

The core carries **no business-system names**: no default application id, no environment variable names, no route table other
than Bridge v1. What the first user (ケアビリング) needed before it moved to v1 is an explicit compatibility profile,
`@dsh-bridge/dsh-core/compat/care-billing-paths` (see "Compatibility profile" below).

## Modules

| module | exports | what it does |
|---|---|---|
| `registry` | `createApplicationRegistry`, `fallbackRegistry`, `V1_PATHS`, `registerPathProfile`, `pathProfile`, `pathProfileNames`, `DEFAULT_APPLICATION_ID` (`'default'`), `MULTI_APP_PLATFORMS` | application registry; `resolveApplication({platform, botId})` from **config only**; per application API client, manifest holder, delegation policy, tool namespace; path profiles (`'v1'` built in) |
| `api` | `createBusinessApi`, `BridgeApiError` (+ `BridgeUnreachableError`, `BridgeHttpError`, `BridgeProtocolError`), `apiSource`, `sourceKey` | business API client: `x-service-token`, `x-delegation-token`, `bridge-protocol` response header check (a response without the header is accepted), typed errors (`kind`: unreachable / http / invalid_body / protocol / request, with `status`, `code`, `applicationId`), retries of idempotent calls on 502/503/504 / transport errors (`retries`, default 0), timeout. No built-in URL or token: `defaultBaseUrl` / `defaultServiceToken` (value or function) are opt-in |
| `manifest` | `createManifestHolder`, `checkManifest`, `resolveManifestFile` | manifest from `manifestUrl` (`GET /bridge/v1/manifest`, `If-None-Match` / `etag`, 304), validated with `validateManifest`; `system.id` must equal the application id; an invalid or unreachable manifest never replaces the last valid one; falls back to the bundled `manifestFile` (`pkg:<package>/<path>`, e.g. `pkg:@dsh-bridge/protocol/manifests/example.manifest.yaml`) |
| `delegation` | `createDelegationCache`, `delegationKey`, `eventDelegationKey`, `eventIdForRequest` | delegation tokens keyed by **(applicationId, source)**; per-event delegations (`getForEvent(applicationId, eventId, mint)` → `POST delegations { event: { id } }`, keyed by (applicationId, event)); refresh 30 s before expiry, at most 5 minutes; `forgetUser(userId, platform, applicationId)`; concurrent requests share one mint |
| `session` | `sessionKey`, `parseSessionKey`, `conversationKeyOf` | session key `(applicationId, platform, botId, conversationKey)` |
| `app-switch` | `createAppSwitch`, `parseSwitchCommand`, `appPrefix`, `withAppPrefix` | shared bots (personal WeChat): current application per conversation, `#一覧` / `#<アプリ名>` / `#いま`, 【アプリ名】, reply-to-notification binding (below) |
| `tools-sdk` | `defineTool`, `createDelegationGate`, `createToolRequester`, `guardTool`, `registerTools`, `manifestTools`, `registerManifestTools`, `autoTaskSessionChecker`, `autoTaskRunResolver`, `parseDelegationSpec`, `DELEGATION_SPEC_RE`, `currentPrincipal`, `sessionIdOf`, `DEFAULT_DENY_HINTS` | the delegation gate (trusted sender → employee → delegation token per application; a group conversation is refused unless its policy is `allow`); automatic tasks by delegation class (the active run's `source.delegation`: `<class>` → `unattendedDelegates.<class>` else the default delegate, `<class>=each` → a per-event delegation for the run's triggering event, only when the class is opted in with `each`; outside a run only when the conversation's tasks have one class; `unattendedWarnRoles` logs once); tool namespaces; read tools generated from manifest `tools`. `toolKind` (default `'business tools'`) and `denyHints` carry the wording |
| `apps` | `appPath`, `hasPath`, `singleApplicationRegistry`, `registryGetter`, `applicationOfEvent`, `scopedKey`, `createBotResolver` | route templates per application (`{eventId}` etc.), one API client as a one-application registry (id `default`, v1 paths, unless given), the application of an event, storage keys that stay unchanged for the default application, the sending bot of an application per platform (never another application's bot) |
| `help-tool` | `helpToolSpec`, `toHelpResult`, `renderHelp`, `HELP_RULES_JA`, `helpRules` | the manual search tool (`@dsh-bridge/help` on the business side): `manifestTools` generates the manifest's `help.tool` with it; read-only, refuses URL / answer arguments, drops the `url` of a screen the asker cannot open, renders the sections and the URLs exactly as given; `helpRules(tool)` = the persona rules (answer only from the sections, copy URLs, found=false → say so) |
| `link-guard` | `createLinkGuard`, `routePattern`, `DEFAULT_LINK_REPLACEMENT` | the links an AI answer may carry: on the business web URL only the paths of the manifest's `web.routes` (`:name` = one segment, a trailing `/*` = any sub path; query and fragment kept), other hosts only from `allowHosts`; the rest becomes 「（リンクを省きました）」. No routes or no base URL → keeps everything. bridge-identity runs it on every AI answer of an IM turn (dsh-im `setAnswerFilter`) |
| `secretary` | `frameMessage`, `frameAiText`, `noticeCard`, `signatureOf`, `greetingAt`, `INTENT_LABELS`, `HELP_LABEL`, ... | IM wording frame: 【ご報告】/【対応のお願い】/【至急】/【承認のお願い】/【ご相談】/【定時のご報告】/【ご案内】 (the last: an answer to a how-to question, intent `info`; intents `info` / `action` / `urgent` / `approval` / `consult`; `intentOfHead` maps a head back), greeting by local time, signature **`— <アプリ名> AI 秘書`** (`— AI 秘書` without a name; plugins pass `app.name`), with the AI employee's nickname **`— <呼び名>（<アプリ名> AI 秘書）`** (`signatureOf(name, nickname)`) |
| `persona` / `ai-profile` | `renderPersona`, `nicknameOf`, `profileForAgent`, `FIXED_RULES`, `TONE_TEXT`, `appSignature(app, agentId?)`, `appNickname`, `createAiProfileHolder`, `AI_PROFILE_REFRESH_SECONDS` (60) | the AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md): the system prompt section (fixed rules first, then the persona as settings that cannot override them, the company as reference); the holder per application reads `paths.aiProfile` (`GET /bridge/v1/ai-profile`, etag / 304, a failure or a profile failing `validateAiProfile` keeps the previous value, 404 or no path = none). `app.aiProfile()` is synchronous (the last profile or null), `registry.refreshAiProfiles()` |
| `connectors` | `createConnectorCatalogHolder`, `normalizeCatalogEntry`, `connectorPath`, `isConnectorRunPath`, `connectorToolName`, `CONNECTOR_REFRESH_SECONDS` (60) | the external connectors' catalog (docs/AI_EMPLOYEE_PROFILE.md §3): `paths.connectorCatalog` (`GET /bridge/v1/connectors/catalog`, etag / 304, 404 = none), `paths.connectorRun` (the only POST a read tool may make: `requestJson(..., { method: 'POST', connectorRun: true })` on that path), `paths.connectorPropose` (v1: `/bridge/v1/proposals` kind `connector_write`; ケアビリング: its own propose route) |
| `outbound` | `isGroupConversation`, `groupChatPolicy`, `GROUP_CHAT_GUIDE`, `screenOutboundText`, `ROLE_WORDS`, `HEALTH_WORDS` | what may leave the AI to IM (N1b): a conversation whose `conversationKind` is not `direct` is a group (default policy `deny`; the tools gate refuses business tools there, bridge-identity answers only `GROUP_CHAT_GUIDE`「業務の内容は個別チャットでお尋ねください。」); `screenOutboundText(text, {allowedUrlPrefixes})` → `{ok, reasons}` flags amounts (円 / ¥), honorific person names (漢字・カタカナ + 様 / さん / 氏 …, role words allowed), contacts (phone, postal code, e-mail), URLs outside the allowed prefixes, too long / empty text, health words (`HEALTH_WORDS`: general terms for illnesses, symptoms, medication, vital signs, hospital visits and a body temperature like 37.5℃; `healthWords` replaces the list, `[]` switches it off) — reason codes only, never the matched text. Callers replace the whole text by a fixed template (no partial redaction) |
| `delivery` | `classifyDeliveryError`, `DEFAULT_PLATFORM_PRIORITY`, `NOTIFY_ONLY_PLATFORMS`, `MAX_REQUEST_PLATFORMS` | why an IM send failed (WeChat context expired, bad target, bot offline, quota) and the default platform order |
| `runtime` | `cfg`, `makeLogger`, `whenServices`, `onDispose`, `openDomain`, `loadSchemastery`, `backoffDelay`, `normalizeText`, `objectSchema` | Cordis helpers shared by the plugins |
| `plugin` | `name = 'bridge-apps'`, `Config`, `apply`, `applyCompat`, `registryService`, `watchRegistry`, `SERVICE_NAMES`, `COMPAT_PROFILES` | the package is also the DSH plugin `bridge-apps`: it provides **`ctx.bridgeApps`** (the registry), refreshes manifests every `manifestRefreshSeconds` and the AI employee's profiles at start-up and every `aiProfileRefreshSeconds` (default 60), and registers generated manifest tools for applications with `generateTools: true` (identity from `ctx.bridgeIdentity`, assistant sessions from `ctx.bridgeAssistant`; when `@dsh-bridge/plugin-tools` is loaded its gate `ctx.bridgeTools.gate(<id>)` authorizes them, so the automatic-task delegation and report owners apply to generated and hand-written tools alike) |

### Registry config

```yaml
- id: bridge-apps
  name: '@dsh-bridge/dsh-core'
  config:
    strict: false                 # true: a bot that no application lists belongs to no application (denied)
    manifestRefreshSeconds: 600
    aiProfileRefreshSeconds: 60   # the AI employee's profile (paths.aiProfile = GET /bridge/v1/ai-profile, etag / 304; 0 = start-up only)
    pathProfiles: {}              # optional: { <name>: { identity, link, delegations, ... } } for systems not (yet) on /bridge/v1
    compat: []                    # optional: [care-billing-paths] (see below)
    applications:
      - id: equipment-inspection  # = manifest system.id
        name: 設備点検
        label: inspection API     # name used in error messages (default "<id> API")
        namespace: facility       # tool names <namespace>_* (default: id with - → _, i.e. equipment_inspection)
        default: true             # the default application; without `bots` it receives every unassigned bot
        paths: v1                 # 'v1' (default) | a path profile name | { base?: <profile>, identity, link, delegations, ... }
                                  # v1 also lists the optional piiScan, aiProfile, publicHelp (an empty path turns that capability off)
                                  # and helpSearch (the manual tool itself calls its manifest tools[].http)
        apiUrlEnv: INSPECTION_API_URL          # read per call; falls back to apiUrl
        apiUrl: http://127.0.0.1:19730
        serviceTokenEnv: INSPECTION_SERVICE_TOKEN   # read per call; never put a real token in the yml
        manifestUrl: /bridge/v1/manifest      # relative to apiUrl, or absolute
        manifestFile: ./manifests/equipment-inspection.manifest.yaml   # or pkg:<package>/<path>
        bots: []                  # [{ platform, botId, multiApp? }] (dsh-im bot ids)
        aliases: []               # extra names for 「#<name>」 on shared bots
        agents: []                # agent preset ids of this application
        delegation:               # automatic tasks (no IM sender): whose delegation, per application
          unattendedPolicy: deny  # deny | delegate
          # unattendedOnBehalfOf: { platform: line, userId: <IM user id of the employee> }
          # unattendedDelegates: { planning: { platform: line, userId: <id> }, inspector: each }   # per delegation class
        generateTools: false      # register read tools generated from the manifest
        messages: { unlinkedReply: ... }      # optional IM wording override per application
        groupChat: deny           # optional: deny (default) | allow — business in group conversations (bridge-identity / bridge-tools)
        retries: 0
        timeoutMs: 10000
```

Start-up refuses: two applications with the same id, one bot in two applications (unless `multiApp` everywhere on a
`MULTI_APP_PLATFORMS` platform), two defaults, bot entries without `platform` / `botId`, an unknown path profile, an unknown
`compat` profile. An application never reads an environment variable it was not given by name (`apiUrlEnv` /
`serviceTokenEnv`, or `envFallback` of `fallbackRegistry`).

## How multi-application routing works

1. dsh-im builds the trusted `ImSource` (`platform`, `botId`, `userId`, `conversationId`, ...) from the platform event.
   Message text is never used for routing.
2. `registry.resolveApplication(source)` maps `(platform, botId)` to an application: an exact `bots` entry first, otherwise
   the default application when it lists no bots (the single-application deployment), otherwise `null`.
3. **@dsh-bridge/plugin-identity** (one access resolver for all applications) resolves the application from the bot. No
   application → denied (no API call). Otherwise the identity lookup (`paths.identity`) and the link code (`paths.link`) go to
   that application's API with that application's service token. Caches, guide throttles and link rate limits are per
   (application, account). `forSession()` returns `applicationId`. `sns_identity.unlinked` clears only the application of the
   event.
4. **tools-sdk** gate (one per application): a conversation whose `applicationId` is another application is refused before any
   token is requested; a bot without an application is refused. Delegations are minted at the tool's application
   (`paths.delegations`) and cached under `(applicationId, source)`. Every principal carries its `applicationId`; the requester
   refuses to send a token to any other application. Assistant sessions belong to the assistant's application; the scheduled
   report owner must resolve to the same application; automatic task sessions only count for tasks without `applicationId` or
   with the same one.
5. Read tools can only `GET`; only `propose` tools can `POST` (a proposal). There is no `write` access.

## Adding an application

1. **Manifest.** The business system serves `GET /bridge/v1/manifest` (service token, `etag`) and/or ships a manifest file;
   `system.id` is the application id. Validate it in CI: `node packages/protocol/bin/bridge-validate.mjs manifest x.manifest.yaml`.
   Name its tools `<namespace>_*`; tools outside the namespace are never generated (no application can shadow another's tools).
2. **Implement the v1 endpoints** (`packages/protocol/openapi/bridge-v1.yaml`, or `@dsh-bridge/server-kit`) and pass the
   conformance suite.
3. **Bots.** Create the application's own bot in dsh-im (WeCom self-built app, Slack app, LINE official account, Teams bot)
   and note its dsh-im `botId`. Personal WeChat allows one bot per account: list it in several applications with `multiApp: true`.
4. **Registry entry** in the product profile `cordis.patch.yml` (`bridge-apps` → `applications`, see `profile/`). Once more than
   one application exists, list the bots of every application (or `strict: true`) so that a new bot is not silently served by
   the default application.
5. Restart DSH. Employees link themselves in the application's web UI and send 「連携 123456」 to **its** bot. Read tools
   generated from the manifest appear as `<namespace>_*`; hand-written tools use `defineTool` + `registerTools` +
   `createDelegationGate` in a plugin of their own, bound to the application id.

## Writing a tool plugin

```js
import { createDelegationGate, createToolRequester, defineTool, fallbackRegistry, registerTools, watchRegistry } from '@dsh-bridge/dsh-core'

export function apply(ctx, config) {
  // ctx.bridgeApps when the bridge-apps plugin is loaded, otherwise this one-application registry (created once)
  const registry = watchRegistry(ctx, fallbackRegistry({ id: 'equipment-inspection', namespace: 'facility', apiUrl: () => config.apiUrl }))
  const application = () => registry().get('equipment-inspection')
  const { requestJson } = createToolRequester({ application })
  const gate = createDelegationGate({ application, registry, identity: () => ctx.bridgeIdentity, requestJson, toolKind: 'facility tools' })
  registerTools(ctx.tools, gate, [
    defineTool({ name: 'facility_list_overdue', access: 'read', description: 'Read-only: ...',
      execute: async (args) => requestJson('facility_list_overdue', '/api/inspections/overdue', { limit: args.limit }) }),
  ], { application: application() })
}
```

## Shared bots: personal WeChat in-window switching

Personal WeChat (iLink) allows ONE bot per WeChat account, so one bot carries several applications; WeCom self-built apps,
Slack, LINE and Teams stay **one bot = one window per application**.

```yaml
    applications:
      - id: example-app
        name: 日報
        bots:
          - { platform: wecom-app, botId: <日報 WeCom app> }
          - { platform: weixin, botId: <personal WeChat bot>, multiApp: true }
      - id: equipment-inspection
        name: 設備点検
        aliases: [点検]
        bots:
          - { platform: wecom-app, botId: <設備点検 WeCom app> }
          - { platform: weixin, botId: <personal WeChat bot>, multiApp: true }   # the same bot, multiApp in EVERY listing
```

- Registry: a bot may appear in several applications only if every listing says `multiApp: true` and only on
  `MULTI_APP_PLATFORMS` (`weixin`). `resolveApplication(source)` for a shared bot: `source.applicationId` (set by dsh-im's
  conversation router; ignored unless the bot carries that application) → `setApplicationSelector` selectors → the shared
  default (the registry default if it carries the bot, else the first listing). Also `applicationsForBot`, `isMultiAppBot`,
  `sharedDefaultApplication`, `sharedBots` (on `ctx.bridgeApps` too).
- `app-switch`: current application per conversation, `#一覧` / `#いま` / `#ヘルプ` / `#<name|alias|id|namespace>` (full-width ＃
  accepted, one word only), 【アプリ名】 prefix, notifications recorded with `noteNotification` so that a reply **quoting** one
  within `quoteRetentionMs` (7 days), or the **first message after it** within `replyWindowMs` (10 min; commands excluded),
  routes to its application. `snapshot()` / `restore()` for persistence. Pure, no I/O.
- @dsh-bridge/plugin-identity wires it (dsh-im conversation router, `#…` commands on shared bots, a registry selector,
  persistence under `$DSH_HOME/integrations/`).
- dsh-im scopes the conversation key: `p2p:<user>:app:<applicationId>` → one DSH session per (application, bot, conversation).

## Compatibility profile: `compat/care-billing-paths`

ケアビリング, the first user, ran on its own `/api/ai/*` routes and `CARE_*` environment variables before it served `/bridge/v1`.
Those defaults are **not** part of the core; they are available, clearly named, for deployments that still need them:

```js
import {
  enableCareBillingPaths, careBillingRegistry, careBillingSingleApplicationRegistry, createCareApi,
  CARE_BILLING_PATHS, CARE_BILLING_DEFAULTS, CARE_BILLING_DENY_HINTS, LEGACY_SERVICE_NAMES,
} from '@dsh-bridge/dsh-core/compat/care-billing-paths'
```

In the profile: `bridge-apps` → `compat: [care-billing-paths]` registers the path profiles `legacy` / `care-billing-legacy` and
also accepts the old service names `ctx.careIdentity` / `ctx.careAssistant`.

| before (care-ai-native `packages/bridge-dsh`) | now |
|---|---|
| `legacyRegistry()` (care-billing, `CARE_API_URL` / `CARE_SERVICE_TOKEN`, `/api/ai/*`, default URL `http://127.0.0.1:8788`) | core: `fallbackRegistry({ id, apiUrl, serviceToken, envFallback, defaultBaseUrl, paths })`; compat: `careBillingRegistry()` (alias `legacyRegistry`) |
| `LEGACY_PATHS`, `paths: legacy` | compat: `CARE_BILLING_PATHS` (alias `LEGACY_PATHS`); `paths: legacy` after `enableCareBillingPaths()` / `compat: [care-billing-paths]` |
| `DEFAULT_APPLICATION_ID = 'care-billing'` | `'default'`; compat: `CARE_BILLING_APPLICATION_ID` |
| `singleApplicationRegistry(api)` → care-billing / ケアビリング / care-api / care / legacy paths | → `default` / v1 paths (options override); compat: `careBillingSingleApplicationRegistry(api)` |
| `createCareApi`, `CareApiError` (main entry) | compat only; core `createBusinessApi` has no env fallback, label `business API` |
| `DEFAULT_SECRETARY_NAME = 'ケアビリング'` | `''` → `— AI 秘書`; pass the application name: `signatureOf(app.name)` |
| tools-sdk `toolKind: 'care tools'`, deny hint naming `個人設定 › SNS 連携（自分の分）` | `'business tools'`, generic hint; compat: `CARE_BILLING_DENY_HINTS` |
| plugin services `careIdentity` / `careAssistant` | `bridgeIdentity` / `bridgeAssistant` (+ old names with `compat: [care-billing-paths]`) |

## Tests

`node --test --test-isolation=none test/*.test.mjs` (root: `pnpm test:core`). Fake business APIs on `node:http`; two
applications in one registry; `test/generic.test.mjs` proves the core has no care defaults, the other files also exercise the
compatibility profile. No network, no real keys.
