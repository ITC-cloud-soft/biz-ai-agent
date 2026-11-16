# @dsh-bridge/plugin-events（DSH プラグイン `bridge-events`）

業務アプリケーションのイベントの流れ（Bridge プロトコル `GET /bridge/v1/events?after=&limit=`）を取り込み、DSH 内の受け手（bridge-* プラグイン・dsh-auto-tasks）に配る。

## 動作
- **アプリケーションごとに 1 本**の取り込み（レジストリ `ctx.bridgeApps` の増減に追随。無ければプラグイン設定の 1 件）。経路はそのアプリケーションの `paths.events`。
- 配るイベントには取り込んだアプリケーションの **`applicationId`** を付ける（業務システムが本文に書いた値は上書きする＝信頼できる値）。
- カーソル・処理数・dead letter は DSH のストレージサービス（domain `bridge_events` の global）に **1 件ごとに**保存：既定のアプリケーションは直下、他は `applications[<id>]`。
- **少なくとも 1 回**：成功したイベントまでしかカーソルを進めない。失敗は指数バックオフ（`pollIntervalSeconds` → `maxBackoffSeconds`）、
  同じイベントが `maxAttemptsPerEvent` 回失敗したら dead letter（直近 20 件）に記録して先へ。1 つのアプリケーションが落ちても他は止まらない。
- 振り分け
  - `approval.requested` / `approval.decided` / `approval.expired` → `subscribe()` の受け手（bridge-approvals）。受け手が未登録なら失敗扱い（起動順の競合で取りこぼさない）。
  - `sns_identity.unlinked` → bridge-identity（受け手必須・autoTasks には渡さない）。
  - 通知イベント：設定 `notifyEvents` の種別と、manifest が `events.<type>.notify` と宣言した種別（`manifestNotify`）→ 通知の受け手（bridge-notify。
    `subscribeManifestNotify`）に渡し、続けて autoTasks にも渡す。受け手が未登録なら起動後 `notifyGraceSeconds` の間だけ失敗扱い、その後は autoTasks だけ。
    同じ handler が種別でも manifest 通知でも購読していれば 1 回だけ渡す。
  - それ以外 → `ctx.autoTasks.emit(type, event, dedupeKey, { applicationId, eventId, matchUnscoped })`。dedupeKey は既定のアプリケーションは
    `event.id`、他は `<applicationId>:<event.id>`。applicationId 付きのタスクは同じアプリケーションのイベントだけ、付いていないタスク（profile の
    テンプレート）は既定のアプリケーションのイベントだけで起動する。autoTasks が無ければログを残してスキップ（カーソルは進む）。
- **playbook のデプロイ**：manifest の `playbooks`（イベント起動）を `ctx.autoTasks.deployPlaybooks(applicationId, playbooks, {version, applicationName})` で
  自動タスクとしてデプロイ（新規は無効のまま）。manifest の版が変わったときだけ。`deployPlaybooks: all | others | none`。
- ストレージサービスが開けない場合はカーソルをメモリに持って動き、`persistent: false` を返す。

## サービス
- 提供：`ctx.bridgeEvents` — `subscribe(types, handler)` → 解除関数、`subscribeManifestNotify(handler)`、`status()`（既定のアプリケーションのカーソル・
  処理数・直近エラー・連続失敗・dead letter ＋ `applications.<id>`・`dispatch` の統計）、`pollNow(applicationId?)`、`pollAll()`、`ready`。
- inject：`storageDomain`。任意：`bridgeApps`、`autoTasks`。

## 設定（Config）
`enabled`（true）、`apiUrl` / `serviceToken` / `applicationName`（レジストリが無いとき）、`pollIntervalSeconds`（5）、`maxBackoffSeconds`（300）、
`batchSize`（100、最大 500）、`maxAttemptsPerEvent`（8）、`notifyEvents`（[]）、`manifestNotify`（`all` / `others` / `none`、既定 all）、
`notifyGraceSeconds`（120）、`deployPlaybooks`（`all` / `others` / `none`、既定 all）。
`stateDomain`（既定 `bridge_events`）：カーソルを保存する domain 名。別の名前で動いていた導入先のカーソル・dead letter を引き継ぐときだけ変える
（例：移行前の自前のプラグインが `<name>_events` に保存していた。再配送しない）。
既定のアプリケーションの通知種別を manifest でなく自前の一覧で扱う構成（profile のテンプレートが正本の場合など）は
`manifestNotify: others` と `notifyEvents`、`deployPlaybooks: others` にする。

## 拡張点
- 受け手：`subscribe(types, handler)` / `subscribeManifestNotify(handler)`（任意のプラグイン）。
- 部品：`createEventPump` / `createDispatcher` / `createStateStores` / `deployApplicationPlaybooks` / `manifestNotifies` を export。

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `events.test.mjs`（カーソル・at-least-once・dead letter・バックオフ・通知の待ち）、
`multi-app.test.mjs`（2 アプリ・アプリごとの経路とカーソル・manifest 通知・playbook のデプロイ・重複しない配達）。fixture は架空の設備点検の manifest。
