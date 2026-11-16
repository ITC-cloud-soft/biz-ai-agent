# examples/care-billing — ケアビリング, the first user of the framework (no business code)

ケアビリング (care-billing: 介護事業所の請求・訪問記録・シフト・帳票) is the system the framework was extracted from. Its business
code stays in its own repository (`care-ai-native`, read-only from here). This directory keeps only what a DSH deployment and the
framework need to know about it:

| path | what |
|---|---|
| [`manifest/`](manifest/README.md) | `care-billing.manifest.yaml` (system id `care-billing`, namespace `care`, version 2026-10-29: 5 roles, 71 events (1 deprecated), 92 templates, 46 audience rules, 27 tools (the manual search `care_help_search` included), 5 playbooks, report `daily_status`, `help`, 130 `web.routes`) and the care-api ↔ v1 route table (`care-api-v1-aliases.md` / `.json`) |
| [`registry/bridge-apps.yaml`](registry/bridge-apps.yaml) | the `bridge-apps` registry entry of `@dsh-bridge/dsh-core` for a DSH product profile, plus the plugin extension modules |
| [`extensions/README.md`](extensions/README.md) | the care-specific plugin extensions as a reference listing: the template intent table (92), the tool list (`care_*`, 28), playbooks and delegation classes, presets — with links to the care-ai-native sources |
| `test/care-billing.test.mjs` | keeps this directory consistent: the manifest validates, the registry entry parses and names the manifest's system id / namespace, the extension tables equal the manifest |

The links `../../../care-ai-native/…` below assume both repositories side by side (`C:\work\deepseek-im\care-ai-native` and
`C:\work\deepseek-im\framework`).

## framework の部品 → ケアビリングでの実装場所

ケアビリングは framework より前に書かれたため、同じ役割の部品を自前で持っている。業務システムを framework につなぐときに
どの部品を使い、ケアビリングではそれがどこに実装されているかの対応表（業務コードは移していない）。

### 業務システム側（L2・L5：`@dsh-bridge/server-kit` と hooks）

| framework の部品 | ケアビリングでの実装場所（care-ai-native） | 備考 |
|---|---|---|
| `/bridge/v1` の配信（`createBridgeApp`）・既存 API への別名（`registerAliasRoutes`） | [services/care-api/src/routes/bridge.mjs](../../../care-ai-native/services/care-api/src/routes/bridge.mjs) | care-api は既存の `/api/ai/*` などのルートに v1 を別名で載せる（対応表：[manifest/care-api-v1-aliases.md](manifest/care-api-v1-aliases.md)）。`listMyIdentities` だけ `shape`（snake_case → camelCase） |
| manifest の配信（`loadManifest`・etag・304） | 同上 `careManifest()` / `etagMatches()` | 正は [services/care-api/bridge/care-billing.manifest.yaml](../../../care-ai-native/services/care-api/bridge/care-billing.manifest.yaml)（別名表 `care-api-v1-aliases.json` も同じ場所）。ここの [manifest/](manifest/README.md) はそのコピー |
| `bridge-protocol: 1` ヘッダ・エラーの形式（エンベロープ）・`/bridge/v1/health` | [services/care-api/src/app.mjs](../../../care-ai-native/services/care-api/src/app.mjs)（dispatcher）、[errors.mjs](../../../care-ai-native/services/care-api/src/errors.mjs) | |
| principal と gate（`service` / `delegated` / `user`、ルートごとの方針） | [services/care-api/src/app.mjs](../../../care-ai-native/services/care-api/src/app.mjs)（`route(…, roles, …, { delegated })`、`x-delegation-token`）、[authz.mjs](../../../care-ai-native/services/care-api/src/authz.mjs)（`CAN`） | 委託で呼べるのは GET の読み取りだけ（manifest の tools の roles と一致：care-sync.test.mjs） |
| hooks.`authenticate` / `isSessionLive`（本人のセッション） | [services/care-api/src/auth.mjs](../../../care-ai-native/services/care-api/src/auth.mjs)（署名付きセッション）、[repo/mobile-auth.mjs](../../../care-ai-native/services/care-api/src/repo/mobile-auth.mjs)（端末） | |
| hooks.`employees`（職員・役割・有効／無効） | [services/care-api/src/repo/users.mjs](../../../care-ai-native/services/care-api/src/repo/users.mjs) | 役割 admin / manager / billing / staff / care_manager |
| 連携コード・SNS 連携・個人ボット（identity routes） | [services/care-api/src/repo/identity.mjs](../../../care-ai-native/services/care-api/src/repo/identity.mjs)（`createLinkCode` / `linkIdentity` / `resolveIdentity` / `identityStats`）、[repo/im-bots.mjs](../../../care-ai-native/services/care-api/src/repo/im-bots.mjs) | 連携コード 10 分・1 回限り、メールは連携不可（`NOTIFY_ONLY_PLATFORMS`）。個人ボットは全チャネル、照会は `botId` 付きで持ち主だけ（server-kit の `identityOf` と同じ規則、IM_PERSONAL_BOTS §4） |
| 委託トークン（`/delegations`、5 分） | 同上 `issueDelegation`（`DELEGATION_TTL_SECONDS`） | 事件ごとの委託 `{ event: { id } }`（`EVENT_DELEGATION_TYPES`、U10）もここ |
| AI アシスタントのチケット（`/assistant/tickets` / `/assistant/delegations`） | [services/care-api/src/routes/insights.mjs](../../../care-ai-native/services/care-api/src/routes/insights.mjs)、[repo/insights.mjs](../../../care-ai-native/services/care-api/src/repo/insights.mjs) | |
| イベントの outbox と型ごとの payload 許可リスト（`createEventWriter`） | [services/care-api/src/events.mjs](../../../care-ai-native/services/care-api/src/events.mjs)（`AI_EVENT_TYPES`、manifest の `events.<type>.payload` からの許可リスト＋全体の許可リスト） | `GET /api/ai/events` = v1 `/events` |
| hooks.`recipientsFor`（通知の受信者・型付きの引数） | [services/care-api/src/repo/notifications.mjs](../../../care-ai-native/services/care-api/src/repo/notifications.mjs)（`ruleFor` / `decideRecipients` / `resolveNotificationRecipients`）、関門 [repo/notify-scope.mjs](../../../care-ai-native/services/care-api/src/repo/notify-scope.mjs)（`checkRecipients`） | 受信者は事件の対象（利用者・事業所）の範囲だけ、関門で Web と同じ判定（NOTIFY_RECIPIENTS §1・§2）。本人の設定・既通知の除外・おやすみ時間（通知を控える時間帯）もここ（`DEFAULT_OFF_TYPES` / `QUIET_EXEMPT_TYPES`） |
| 配信記録（`/notifications/deliveries`）・本人の通知設定（`/me/notification-preferences`） | 同上 `recordNotificationDelivery` / `getMyNotificationPreferences` / `updateMyNotificationPreferences`、[routes/notifications.mjs](../../../care-ai-native/services/care-api/src/routes/notifications.mjs) | |
| hooks.`approvals`（承認の規則・決定） | [services/care-api/src/repo/approvals.mjs](../../../care-ai-native/services/care-api/src/repo/approvals.mjs)（`decisionError` / `applyDecision`：Web と IM で同じ規則） | 状態 requested / notified / partially_approved が kit の `pending`（`approvals.state`） |
| 承認カードの配信・1 回限りのトークン・返信コード（approval routes） | [services/care-api/src/repo/im-approvals.mjs](../../../care-ai-native/services/care-api/src/repo/im-approvals.mjs)（`createDeliveries` / `markDeliverySent` / `imDecision`、`MAX_REPLY_CODE_FAILURES`） | |
| hooks.`proposalKinds`（AI 提案の種類・採択） | [services/care-api/src/repo/ai.mjs](../../../care-ai-native/services/care-api/src/repo/ai.mjs)（`PROPOSAL_KINDS` / `DELEGATED_PROPOSAL_ROLES`）＋各業務の提案ルート（careplan・documents・banking・staff-ops・caremanager-box・billing-import の `routes/*.mjs`） | |
| hooks.`reports`（定時報告の件数） | [services/care-api/src/repo/business-report.mjs](../../../care-ai-native/services/care-api/src/repo/business-report.mjs)、[routes/business-report.mjs](../../../care-ai-native/services/care-api/src/routes/business-report.mjs) | manifest の report `daily_status` |
| `/pii-scan` | [services/care-api/src/repo/pii.mjs](../../../care-ai-native/services/care-api/src/repo/pii.mjs) | 長期記憶（care-memory）が保存の前に呼ぶ（`/api/ai/pii-scan`） |
| `help`（マニュアルの検索、任意） | [services/care-api/src/routes/help.mjs](../../../care-ai-native/services/care-api/src/routes/help.mjs)、[repo/help.mjs](../../../care-ai-native/services/care-api/src/repo/help.mjs)、索引 [src/help/manual-index.json](../../../care-ai-native/services/care-api/src/help/manual-index.json)（[tools/manual-index.mjs](../../../care-ai-native/tools/manual-index.mjs) が `@dsh-bridge/help` で作る） | `/api/help/search`・`/api/ai/help/public` が v1 の別名。マニュアルは `docs/manual`（164 節）。質問の記録は個人情報の検査を通った文だけ・90 日（`sql/095`） |
| AI 社員のプロフィールの経路（任意） | [services/care-api/src/routes/ai-profile.mjs](../../../care-ai-native/services/care-api/src/routes/ai-profile.mjs)、[repo/ai-profile.mjs](../../../care-ai-native/services/care-api/src/repo/ai-profile.mjs)、`sql/096_ai_profile.sql`（`ai_profile_version`） | `GET /api/ai/ai-profile`（サービス、etag）・管理の `/api/ai-profile`（v1 の別名）。検査は `validateAiProfile`、監査は版の番号だけ（care-ai-native `docs/design/AI_PROFILE_CARE.md`） |
| 回数制限・監査（store の throttle / audit） | [services/care-api/src/throttle-db.mjs](../../../care-ai-native/services/care-api/src/throttle-db.mjs)、[audit.mjs](../../../care-ai-native/services/care-api/src/audit.mjs) | |
| store（PostgreSQL の Bridge 表） | [services/care-api/src/db.mjs](../../../care-ai-native/services/care-api/src/db.mjs) と care-api のマイグレーション | ケアビリングの表名は `sns_identity` / `ai_event` など（kit は `bridge_*`） |

### DSH 側（L3・L4：`@dsh-bridge/dsh-core` と `plugins/*`）

ケアビリングの DSH 側は framework のプラグインをそのまま使う（2026-10 に自前の care-* プラグインから移行）。ケアビリング固有のものは
製品 profile の設定と、プラグインの拡張点に渡すモジュール（care-tools・care-notify）と、plugin-memory の設定（care-memory）だけ。

| framework の部品 | ケアビリングでの使い方（care-ai-native） | 備考 |
|---|---|---|
| `@dsh-bridge/dsh-core`（レジストリ `bridge-apps`・API クライアント・委託・tools-sdk・app-switch） | [dsh/runtime-profile/cordis.patch.yml](../../../care-ai-native/dsh/runtime-profile/cordis.patch.yml) の `bridge-apps` | 登録の例：[registry/bridge-apps.yaml](registry/bridge-apps.yaml)。care-api の `/api/ai/*` 経路は `compat: [care-billing-paths]`（`paths: legacy`） |
| `plugins/identity`（連携コード・アクセス判定・共用ボットのアプリ切替） | 同上 `bridge-identity` | 未連携の案内（設定 › SNS連携）、`switchStatePath`（移行前の保存先） |
| `plugins/tools`（委託 gate・manifest からの読取ツール・提案ツール） | 同上 `bridge-tools` ＋ ツールモジュール [plugins/care-tools/](../../../care-ai-native/plugins/care-tools/README.md) | `care_*` 29 本（manifest 27 ＋ モジュールだけ 2。マニュアルの検索 `care_help_search` を含む。一覧：[extensions/README.md](extensions/README.md)）。自動タスクの上限 `unattendedTools`・拒否の文言 `toolKind` / `denyHints` |
| `plugins/events`（アプリごとのカーソル・auto-tasks への emit・playbook のデプロイ） | 同上 `bridge-events` | 通知の種別は care-notify の一覧、`stateDomain: care_events` |
| 自動タスクの playbook（manifest `playbooks`） | [dsh/runtime-profile/auto-tasks/](../../../care-ai-native/dsh/runtime-profile/auto-tasks/README.md)（計画書下書き・兆候メモ・モニタリングの下書き・記録の構造化・請求ドラフトの抜け）、[proactive.config.json](../../../care-ai-native/dsh/runtime-profile/proactive.config.json) | `care_visit_plan_draft` / `care_signal_note` / `care_monitoring_draft` / `business_patrol` / `daily_status_narrative` |
| `plugins/notify`（受信者の解決・短時間のまとめ送信・おやすみ時間・AI 秘書の枠・定時報告） | 同上 `bridge-notify` ＋ 文面モジュール [plugins/care-notify/](../../../care-ai-native/plugins/care-notify/README.md) | 文面：[templates.js](../../../care-ai-native/plugins/care-notify/src/templates.js)、意図：[secretary.js](../../../care-ai-native/plugins/care-notify/src/secretary.js) `TEMPLATE_INTENTS`（表：[extensions/README.md](extensions/README.md)）、定時報告の指示：[ai-report.js](../../../care-ai-native/plugins/care-notify/src/ai-report.js) |
| `plugins/approvals`（承認カード・ボタン／返信コード・アプリ間の分離） | 同上 `bridge-approvals` | `actionPrefix: care_approval`（送付済みのカードのボタン）、本文は出さない（`showBusinessBody: false`） |
| `plugins/assistant`（業務 Web の右パネルから本人の権限で質問） | 同上 `bridge-assistant` | 管理 RPC の名前 `care-assistant`（care-web の BFF）。パネルの見出しは呼び名（`displayName`） |
| `plugins/memory`（長期記憶） | [plugins/care-memory/](../../../care-ai-native/plugins/care-memory/README.md)（`createMemoryPlugin` の設定だけ。bundle `@care/dsh-care-memory`） | 以前のツール名 `care_memory_*`・保存先 `care_memory` / `care_memory_recall`、scope を省くと事業所の記憶、個人の記憶と振り返りも |
| `plugins/persona`（AI 社員のプロフィール） | 同上 `bridge-persona`（bundle `@dsh-bridge/plugin-persona`） | 呼び名は care-api のプロフィール（管理 › AI 社員の設定）。署名「— さくら（ケアビリング AI 秘書）」（care-notify の文面も呼び名つき） |
| `packages/gateway`（BFF → DSH の認証付きプロキシ・RPC 許可リスト） | BFF [apps/care-web/serve.mjs](../../../care-ai-native/apps/care-web/serve.mjs)（`x-bff-secret`）、本人用 RPC [apps/care-web/me-im-rpc.mjs](../../../care-ai-native/apps/care-web/me-im-rpc.mjs)（`POST /api/me/im/rpc/<channel>`：許可リスト・持ち主の確認・応答の絞り込み・`createOnly`） | 本人用 RPC は framework の部品ではない（GUIDELINE d.9） |
| `profile/`（製品 profile・agent プリセット・install.mjs） | [dsh/runtime-profile/](../../../care-ai-native/dsh/runtime-profile/README.md)（`cordis.patch.yml`：`preset-care-billing` など。`scripts/install.mjs` は framework の install.mjs を既定値付きで呼び、固定の配信先の指定を拒否する） | 送信の設定はすべて閉じている（`groupChat: deny`・`audienceFallback: none`・`audienceText: template`・`proactiveDelivery: deny`・`modelTools: reclaim`・`deliveryGuard: required`・`restrictDelivery: true`・`mail: false`・`forwardPluginSources: []`） |

### 業務 Web 側（`@dsh-bridge/web-kit`）

ケアビリングの care-web はこれらの部品を直接使い、文言・リンク・API の経路・通知の種類だけを渡す薄い包みを持つ。
UI 部品（Card・Button など）とレイアウトのクラス名は `WebKitProvider` の `ui` / `classNames` でケアビリングのものに差し替えている。

| framework の部品 | ケアビリングでの使い方（care-ai-native） |
|---|---|
| `WebKitProvider`（UI 部品・クラス名・文言・日時の書式の差し替え） | [apps/care-web/src/im/webkit.tsx](../../../care-ai-native/apps/care-web/src/im/webkit.tsx)（`CareWebKit`）、[webkit.module.css](../../../care-ai-native/apps/care-web/src/im/webkit.module.css)、[theme.css](../../../care-ai-native/apps/care-web/src/im/theme.css)（`--dbw-*` → ケアビリングのトークン） |
| `ImBotsShell` / `ChannelPanel` / `createImRuntime`（IM ボット接続：dsh-im の設定タブ） | [apps/care-web/src/pages/ImBots.tsx](../../../care-ai-native/apps/care-web/src/pages/ImBots.tsx)（`?channel=`・関連カード・詳細設定の案内）、[src/im/runtime.ts](../../../care-ai-native/apps/care-web/src/im/runtime.ts)・[rpc.ts](../../../care-ai-native/apps/care-web/src/im/rpc.ts) |
| `SnsLinkPage`（本人の SNS 連携：自分のボット（全チャネル、本人モードの `ImBotsShell`）・連携コード・自分の連携の一覧と解除） | [apps/care-web/src/pages/SnsLink.tsx](../../../care-ai-native/apps/care-web/src/pages/SnsLink.tsx)、[lib/meIm.ts](../../../care-ai-native/apps/care-web/src/lib/meIm.ts)（`MeImClient`：care-api の `/api/sns-identities…`） |
| `NotifyPrefsCard` / `notify-core`（本人の通知設定） | [lib/notify-core.ts](../../../care-ai-native/apps/care-web/src/lib/notify-core.ts)（種類・グループ・既定オフはケアビリング固有：web-kit には `notifyTypes` で渡す。未打刻の行は `extraQuietRows`） |
| `platform-labels`（プラットフォームの表示名・連携コードを使うプラットフォーム） | [lib/im-platforms.ts](../../../care-ai-native/apps/care-web/src/lib/im-platforms.ts)（web-kit の core を再 export） |
| `AiProfilePage`（管理者の「AI 社員の設定」） | [pages/settings/AiProfile.tsx](../../../care-ai-native/apps/care-web/src/pages/settings/AiProfile.tsx)（`/settings/ai-profile`、ケアビリングの AI 社員 4 つを `agents` に、保存は care-api の `/api/ai-profile`） |
| `manualChapters` / `parseMarkdown`（ヘルプ画面） | [pages/Help.tsx](../../../care-ai-native/apps/care-web/src/pages/Help.tsx)、[lib/markdown-core.ts](../../../care-ai-native/apps/care-web/src/lib/markdown-core.ts)（web-kit core を再 export） |
| 承認・AI 提案の画面（framework には無い：業務ごとに作る） | [pages/Approvals.tsx](../../../care-ai-native/apps/care-web/src/pages/Approvals.tsx)、[pages/Proposals.tsx](../../../care-ai-native/apps/care-web/src/pages/Proposals.tsx)、AI アシスタント [components/assistant/AssistantPanel.tsx](../../../care-ai-native/apps/care-web/src/components/assistant/AssistantPanel.tsx) |

## Registering ケアビリング in a DSH profile

[`registry/bridge-apps.yaml`](registry/bridge-apps.yaml) is the entry to paste into the product profile's `cordis.patch.yml`
(`profile/template`). With a second application on the same DSH (for example
[`examples/equipment-inspection`](../equipment-inspection/README.md)),
list the bots of every application (`strict: true`); a personal WeChat bot shared by both is listed in both with
`multiApp: true`. The API URL and the service token are read per call from `CARE_API_URL` / `CARE_SERVICE_TOKEN`; never put a
token in the yml.

## Tests

```
pnpm --filter @dsh-bridge/example-care-billing test
```
