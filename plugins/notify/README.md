# @dsh-bridge/plugin-notify（DSH プラグイン `bridge-notify`）

業務イベントの IM 通知の汎用エンジン。**受信者・本人の通知設定・おやすみ時間（通知を控える時間帯）・文面の材料（件数・日付・時刻）は業務システムが決める**
（Bridge プロトコル `GET /bridge/v1/notifications/for-event/{eventId}?platforms=…`）。このプラグインは「いつ・どのボットで・何通に分けて・どの文面で送るか」だけ。

## 流れ
1. bridge-events が通知イベントを渡す：設定 `notifyTypes`、manifest の `events.<type>.notify`、文面モジュールの `types`。
2. そのアプリケーションの `notificationRecipients` → 受信者 `{userId, identity:{platform, externalId, teamId?, botId?}, template, params, link, quietHours}`。
   届かない・5xx は throw（bridge-events が再試行）、404 はスキップ。
3. 受信者ごとに DSH のストレージサービス（domain `bridge_notify`、table `pending`、キー `<eventId>:<userId>`、既定以外は `<applicationId>|…`）。再配送・再解決は重複として捨てる。
4. flush（受信時・期限の時刻・`flushIntervalSeconds` ごと・起動時）
   - **短時間のまとめ送信**（`digestTypes`）：同じ人・同じ種別を、最後のイベントから `realtimeSettleSeconds`（15 秒）、遅くとも最初のイベントから
     `realtimeDigestSeconds`（2 分）で 1 通に。束の全イベントの params を文面に渡す（件数・月の集計）。
   - **定期のまとめ送信**：`digestWindows.<type>`（分。0 = まとめない）→ 無ければ manifest の `notify.digestMinutes`。
     どちらも `digestMinutes`（既定 30 分）で頭打ち。`digestMinutes: 0` はどの種別もまとめない（検証用）。
   - **即時**：それ以外。
   - **おやすみ時間**：受信者の `quietHours`（本人設定）の時間帯に入っていれば、終わるまで延期。manifest の `notify.quiet: exempt` の種別は延期しない。`honorQuietHours: false` は検証専用。
   - 送信（既定 `deliveryMode: card`）：`ctx.dshIm.sendCard({ botId, to: { userId }, card（ボタン無し）, idempotencyKey: notify:<eventId>:<userId> })`。
     まとめ送信ではキーの eventId に束の最大の eventId を使う。一度送り始めた束の構成は固定し、再試行でも同じキー（二重送信しない）。`text` は登録済み配信先への `send` → unknown-target なら sendCard。
   - **ボット**：①連携の `botId`（そのアプリケーションのボットのときだけ）②`bots` / `applications.<id>.bots` ③レジストリの `bots` ④`listBots()` のうち
     レジストリでそのアプリケーションに解決されるもの。他のアプリケーションのボットからは送らない。
   - **配信先の優先順位**：既定は `DEFAULT_PLATFORM_PRIORITY`（@dsh-bridge/dsh-core。dsh-im の全プラットフォーム、email を除く）。プロトコル v1 の上限 10 件を超えるときはボットのあるプラットフォームを優先。
   - **失敗**：指数バックオフで `maxAttempts` 回。`classifyDeliveryError`（dsh-core）で理由が分かるもの——WeChat の会話コンテキスト無し
     （即時 `undeliverable`）・iLink の拒否（`undeliverableRetries` 回で undeliverable）・宛先不正・ボット未接続（通常の再試行 → failed）・
     レート制限 / LINE の月間上限（Retry-After 以上待ち、最後は failed）——は理由（errorCode）付き。黙って捨てない。
5. 結果を `notificationDeliveries` に報告 `{userId, eventIds, status: sent|failed|undeliverable, channel, messageRef?, errorCode?}`。失敗は `reports` に残して再試行。

## AI 秘書の文面
どの通知も 1 行目に【ご報告】【対応のお願い】【至急】（ほかに【承認のお願い】【ご相談】）と件名、日本時間のあいさつ、事実、▶ お願いしたいこと（または「ご対応は不要です」）、
リンク、署名「— <アプリ名> AI 秘書」（AI 社員の呼び名があれば「— <呼び名>（<アプリ名> AI 秘書）」。呼び名は業務システムのプロフィール
（bridge-apps の `app.aiProfile()`、bridge-persona）から取り、通知・自動タスクの報告・定時報告の固定の文面と既定の指示に付ける）
（枠は @dsh-bridge/dsh-core の `frameMessage` / `noticeCard`）。文面の決め方（`src/templates.js`）：
1. **文面モジュール**（下の拡張点）：`render(input)` か `templates[<template>]`。
2. **manifest の templates**：`templates.<template>.description` の `{param}` を数値・日付・時刻だけで埋める（他は「—」）、`intent`（info / action / urgent / approval / consult）、
   `action`（お願いしたいこと）、件名は `events.<type>.label`。まとめ送信では `{count}` を束の件数以上にする。
3. どちらにも無ければ既定（【ご報告】<アプリ名> / 業務 Web に新しいお知らせがあります）。

業務固有の日本語の文面（ケアビリングの記録・請求・シフト…の文面と意図の表）はこのプラグインに入れない。各アプリケーションが文面モジュールとして持つ。

## 拡張点：文面モジュール
```js
// my-app-templates.js（templateModules: [{ module: 'my-app/notify-templates', application: my-app }]）
export const types = ['reservation.overdue']            // manifest に無くても通知する種別（bridge-events の購読にも足す）
export const templates = {                               // 事実の文だけ。枠（ラベル・あいさつ・署名・リンク）は bridge-notify が付ける
  'reservation.overdue': ({ count, params, items }) => ({
    title: '返却期限の超過', text: `返却期限を過ぎた予約が ${count} 件あります。`,
    intent: 'action', ask: '業務 Web の「予約」で確認してください。', due: undefined, note: undefined,  // 値か ({count, params, items}) => 値
  }),
}
export function render({ template, type, count, params, items, url, now, signature, manifest, appName, nickname }) {
  // signature は「— <アプリ名> AI 秘書」、AI 社員の呼び名があれば「— <呼び名>（<アプリ名> AI 秘書）」（nickname は呼び名、無ければ ''）
  // 1 通を丸ごと組み立てたいとき（例：定時報告のイベント → frameReport(head, lines, { url, now, signature })）。null なら次へ
  return null
}
```
- 読み込み：設定 `templateModules`（パッケージ名・相対 / 絶対パス・file: URL、`application` 省略で全アプリケーション）、
  または別のプラグインから `ctx.bridgeNotify.registerTemplates(applicationId | null, module)`。アプリケーション専用 → 共通 → manifest の順。
- ヘルパー：`frameFact` / `frameReport` / `renderManifestMessage` / `absoluteLink`（`@dsh-bridge/plugin-notify/templates`）、
  `safe` / `int` / `mmdd` / `hhmm` / `yearMonth` など（`@dsh-bridge/plugin-notify/format`：数値と日付形式以外は通さない）。

## 定時報告（AI 社員）のエンジン（`src/ai-report.js`）
- 設定した役割（`aiReportRoles`、既定 admin / manager）の職員がボットとの個別チャットで「定時報告 オン / オフ / テスト」（キーワードは `aiReportCommand`）
  → その会話に dsh-proactive の business アラーム（cron、`respect_quiet_hours: false`、IM 配信先 `deliver_to`）。本人確認・役割はそのアプリケーションの API。
- 時刻：アプリケーションの `paths.reportSettings` があれば業務システムの設定（`{times: [HH:MM], timeZone}`）、無ければ manifest の `reports.*.cron`（毎日のもの）。
- **差し替えられる報告のテンプレート**（AI への指示）：`applications.<id>.aiReportPrompt` → `aiReportPrompt` → manifest の `reports.*.playbook` の instructions →
  既定の指示（`<namespace>_*` のツールで確認し【定時のご報告】の形で 1 通）。先頭に `【定時業務報告】`（アラームの識別）を付ける。
- `ctx.bridgeNotify.aiReportOwner(sessionId)`：bridge-tools の gate が、報告のターンで本人の委託（読み取りだけ）を使うために読む。
- **宛先の保証**（dsh-proactive の `setWakeGuard` / `setDeliveryGuard` があれば登録する。vendor/dsh-proactive FORK #14・#15）：
  - 起動の直前：本人が今も在職・連携済み（そのアプリケーションの identity。個人ボットはその持ち主だけ）・同じ 1:1 の会話・`aiReportRoles` の役割か。
    違えば起動せず（skipped）、その会話の定時報告を止める（アラームを取り消し、本人の記録を消す → `aiReportOwner` も null）。業務 API に届かないときはその回だけ起動しない。
  - IM へ送る直前：送り先は本人の 1:1 の配信先（`reportTargetId` と本人のボット）だけ。本文は `aiReportGuard`：`screen`（既定。@dsh-bridge/dsh-core の
    `screenOutboundText` が金額・敬称つきの人名・電話番号などの連絡先・業務 Web 以外の URL・長すぎる文・健康情報の語（`HEALTH_WORDS`）を見つけたら、全文を固定の文面に置き換える）/
    `template`（常に固定の文面：【定時のご報告】・あいさつ・業務 Web のダッシュボードで確認・リンク `aiReportLink`・署名）/ `off`。
  - 定時報告以外の business アラームの IM 送信：`proactiveDelivery`（`allow` 既定 / `deny`）。

## audience 配信（自動タスクの報告）
`ctx.autoTasks.setAudienceDelivery` を登録。playbook タスク（`applicationId` と `audience`）の報告を、起動したイベントの受信者（そのアプリケーションが
解決した人。domain `bridge_notify_audience` に 7 日）それぞれの連携先へ、そのアプリケーションのボットから AI 秘書の形（`frameAiText`）で届ける。
受信者が分からない（cron 起動・通知しない種別）ときは `handled: false`（auto-tasks が登録済みの配信先に送る）。
`applications.<id>.audienceFallback: none` なら受信者が分からないときも `handled: true`・何も送らない（固定の配信先に回さない。`status().audienceSuppressed`）。
`applications.<id>.audienceText: template` なら AI の summary を送らず、状態ごとの固定の文面（`audienceTemplate`：needsDecision → 【対応のお願い】<タスク名>、
failed / done → 【ご報告】<タスク名>）と業務 Web のリンク（`audienceLink`、既定 `/`）だけを送る（受信者は委託した職員と別の人になりうるため。summary は DSH の自動タスクの報告に残る）。

## サービス
- 提供：`ctx.bridgeNotify` — `ready`、`handleEvent(event)`、`flushNow()`、`status()`、`deliverAudience(input)`、`registerTemplates(appId, module)`、
  `aiReportOwner(sessionId)`、`aiReport.{enable, disable, status, fire}(source)`。
- inject：`dshIm`（bridge fork：`sendCard` の `to.userId` と `idempotencyKey`、`claimReplies`、`listTargets` / `createTarget`）、`storageDomain`。
- 任意：`bridgeApps`、`bridgeEvents`、`autoTasks`、`dshProactive`。

## 設定（Config）
`enabled`、`apiUrl` / `serviceToken` / `applicationName`（レジストリが無いとき）、`notifyTypes`、`platformPriority`、`bots`、`webUrl`（相対リンクに前置）、
`applications.<id>`（`platformPriority` / `bots` / `webUrl` / `aiReportPrompt` / `aiReportRoles` / `aiReportGuard` / `aiReportLink` / `audienceFallback` / `audienceText` / `audienceLink`）、`digestTypes`、`digestWindows`、`digestMinutes`（30）、`realtimeSettleSeconds`（15）、
`realtimeDigestSeconds`（120）、`honorQuietHours`（true）、`flushIntervalSeconds`（30）、`maxAttempts`（8）、`retryBaseSeconds`（30）、`maxRetrySeconds`（3600）、
`undeliverableRetries`（3）、`deliveryMode`（card）、`templateModules`、`aiReport`（true）、`aiReportCommand`（定時報告）、`aiReportPrompt`、`aiReportRoles`、`aiReportGuard`（screen）、`proactiveDelivery`（allow）、
`audienceFallback` / `audienceText`（全アプリケーション向け。`applications.<id>` の同じ項目が優先。`applicationOptionsFrom(config)`）。
どちらにも書かないときの既定：`audienceFallback`（`channels`＝auto-tasks の固定の配信先に回す）、`audienceText`（`summary`＝AI の summary）、
`audienceLink`（`/`）、`aiReportLink`（`/`）。framework の profile の雛形は直下に `audienceFallback: none`・`audienceText: template` を書く。

製品での推奨（受信者の保証。`docs/GUIDELINE.md` d.8。profile の雛形の値）：`proactiveDelivery: deny`、`audienceFallback: none`・`audienceText: template`、
`aiReportGuard: screen`（または `template`）。あわせて dsh-proactive の `deliveryGuard: required`・`modelTools: reclaim`、dsh-auto-tasks の
`restrictDelivery: true`・`mail: false`、dsh-im の `forwardPluginSources: []`。

既存の導入先を引き継ぐための設定（新しい導入先では既定のままにする）：

| 項目 | 既定 | 説明 |
|---|---|---|
| `stateDomain` | `bridge_notify` | 送信待ち・送信記録の domain 名。定時報告は `<name>_ai_report`、自動タスクの報告は `<name>_audience` |
| `apiErrorPrefix`（`applications.<id>.apiErrorPrefix` で上書き） | `api` | 送信が業務 API のエラーで失敗したときの errorCode：`<prefix>_unreachable` / `<prefix>_<HTTP status>` |
| `applications.<id>.audienceSource` | `notification` | 自動タスクの報告の受信者：`notification` = そのイベントの通知で解決した人を記録して使う / `resolve` = 報告のたびに業務システムに解決させる（業務システムが「通知済みの人を除く」などを判断する場合） |
| `aiReportMessages` | {} | 定時報告のコマンドへの返事の上書き（`notLinked` / `role` / `direct` / `noTimes` / `unavailable` / `failed` / `noApplication` / `fired`） |
| `aiReportTargetPrefix` | `bridge-report` | 定時報告の dsh-im の配信先 ID の接頭辞（`<prefix>-<hash>`） |

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `notify.test.mjs`（即時・短時間のまとめ送信・定期のまとめ送信・おやすみ時間と exempt・再起動・冪等・失敗・ボット・プラットフォーム）、
`report.test.mjs`（届かない理由・定時報告のエンジン）、`templates.test.mjs`（文面モジュール・カード）、`multi-app.test.mjs`（2 アプリ・audience 配信・定時報告の結び付け）、`deployment-options.test.mjs`（stateDomain・apiErrorPrefix・audienceSource・定時報告の返事と配信先 ID）、
`report-guard.test.mjs`（定時報告の起動の守り・送信の守りと本文の検査、自動タスクの報告の固定の文面・audienceFallback）、
`nickname.test.mjs`（署名に AI 社員の呼び名：通知・自動タスクの報告・定時報告、文面モジュールの `nickname` / `signature`）。
fixture は架空の設備点検の manifest。
