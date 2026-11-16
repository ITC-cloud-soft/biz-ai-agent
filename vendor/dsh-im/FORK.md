> **Maintained for @dsh-bridge.** This fork is vendored in the DSH Business Bridge framework (`vendor/dsh-im`) and maintained
> for the `@dsh-bridge/*` packages and plugins. It was started for ケアビリング (care-ai-native, the first user of the framework);
> the package name and the test-only `CARE_*` environment overrides are kept so that existing profiles keep working.
> This file was `CARE_FORK.md`; code comments that cite "CARE_FORK #n" refer to the numbered changes below. Content unchanged.

# @care/dsh-im — care-ai-native fork of dsh-im

| 項目 | 値 |
|---|---|
| fork 名 / 版 | `@care/dsh-im` `5.6.0-care.1`（`private: true`、npm へは publish しない） |
| 上游 | `@xmanrui/dsh-im` 5.6.0（MIT）、<https://github.com/xmanrui/dsh-im> tag `v5.6.0` = commit `3bd60c94ed0e5f53a1cefc4395d0a96529d3c712` |
| 一致確認 | npm 公開物（`~/.dsh/profiles/web/node_modules/@xmanrui/dsh-im`）の全 487 ファイルが tag `v5.6.0`（LF チェックアウト）と一致。`npm install && npm run build` で再生成した `lib/index.js`・`lib/client.js` も公開物とバイト一致 |
| 契約 | `docs/design/AI_PLANE_CONTRACTS.md` §1 |

## ビルドとテスト

```sh
cd vendor/dsh-im
npm install                 # vendor は pnpm workspace 外
npm run build               # plugin-src/client/build.mjs → lib/client.js, plugin-src/host/build.mjs → lib/index.js（esbuild）
npm run test:care           # fork 追加分（test/care/*.test.mjs）
npm test                    # 上游テスト + care テスト
node scripts/verify-package.mjs
```

- 実行時に読まれるのは `lib/`。**`src/`・`plugin-src/` を変えたら必ず `npm run build`**。
- Git チェックアウトは LF で行うこと（`core.autocrlf=true` だと文字列定数に CR が混ざり、ビルド結果が公開物と一致しない）。
- **Windows でのテスト結果（2026-10-26 再検証）**
  - 上游 `v5.6.0` の未変更チェックアウト（LF、`npm test`、前処理なし）は Windows 11 / Node 24 で **4606 件中 44〜45 件失敗**：`update-service` 37〜38、`queued-message-durability` 1〜2（実行ごとに変わる）、`feishu/bridge` 1、`feishu/lark-sdk-handshake-patch` 1、`image-input` 1。**fork 由来の退行ではない**（上游でも同じ失敗）。CRLF でチェックアウトすると i18n 系が更に 2 件落ちる（上の注意を参照）。
  - 原因は全て Windows 固有で、上游テストの書き方か実行環境にある。
    - `update-service` 37 件 / `queued-message-durability` 2 件：Windows は他のハンドルが開いているファイルへの `rename` を `EPERM` で拒否する（テストが `state.json` を読みながら書き込みが走る）。`update-service` は `state-unavailable` → `recovery-required` に落ち、各テストが 4 秒のタイムアウトまで待つ。
    - `feishu/bridge`（workspace titles）：メッセージ本文は JSON 文字列なので Windows のパスはバックスラッシュがエスケープされ、`includes(path)` が一致しない。
    - `image-input`：Windows にはパーミッションビットがなく `stat().mode` が `0o666`。
    - `lark-sdk-handshake-patch`：この環境では `esbuild.exe` が `%TEMP%` 配下への出力で `Access is denied`（`C:\work` 配下は書ける。`TEMP`/`TMP` を別ディレクトリにすると成功）。
  - fork での対処（上游テストの書き換えは最小限）：
    - `src/channels/shared/rename-retry.mjs`（新規）の `renameReplacing()`：Windows の `EPERM`/`EBUSY`/`EACCES` だけ 10ms 間隔で最大 30 回再試行（他 OS・他のエラーは即 throw）。`update-service` の `writeJson`、`ConversationStateStore`、`QqStateStore` の原子的書き込みに適用。ウイルス対策・検索インデクサが同じ瞬間にファイルを開いている場合の状態保存失敗も防ぐ。他の store の `rename` は未変更（必要になったら同じ関数に差し替える）。
    - テスト 3 件を Windows 対応に最小修正（各 1〜12 行）：`feishu/bridge`（JSON エスケープ後のパスで照合）、`image-input`（`win32` ではモード検査を省略）、`lark-sdk-handshake-patch`（`win32` で `esbuild` が `%TEMP%` に書けないときだけ **skip** と表示。理由付き）。
  - 結果：`npm test` **4693 件中 失敗 0・skip 17**（上游由来の skip 16 + lark 1。所要約 21 秒。以前は `update-service` のタイムアウトで約 170 秒）、`npm run test:care` 77 件全件成功（`rename-retry` の 4 件を追加）。
  - `lark-sdk-handshake-patch` を skip でなく実行するには `TEMP`/`TMP` を書き込み可能な別ディレクトリにして `npm test`（Linux / macOS は影響なし）。
  - `npm test` は前処理 `test/support/care-fork-env.mjs`（`DSH_IM_ALLOW_SELF_UPDATE=1`）付き。これが無いと fork で無効化した自己更新を上游の update テストが検査できず、`update-service` は 50 件中 48 件失敗する。前処理は `update-service` 以外のテストの挙動を変えない（care テストは前処理の有無にかかわらず全件成功）。
  - 負荷が高い環境（`npm test` を複数同時に走らせる等）では `feishu/bridge` などのタイミング依存テストが落ちたり、全体が停止することがある。単独で再実行すること。

## 公開 API（ctx.dshIm への追加。既存メソッドはそのまま）

| API | 形 |
|---|---|
| `careExtensionsVersion` | `1` |
| `sourceForTurn(sessionId)` | `ImSource \| null`。その Session で現在処理中の IM 由来ターンの来源。ターン終了（ask 完了または `turn/end`）で消える |
| `ctx.on('dsh-im/inbound', e)` | `e = { sessionId, source: ImSource, text }`。プロンプトを Session に投入する直前に Host イベントとして emit |
| `setAccessResolver(fn)` | `fn(source) → 'allow' \| 'deny' \| { deny: true, reply }`（Promise 可）。10 秒タイムアウト・例外は deny。複数登録時は最後のものが有効（dispose で一つ前に戻る） |
| `sendCard({ botId, to:{userId?\|conversationId?}, card, idempotencyKey, applicationId? })` | `→ { messageRef, delivered: true, deduped }`。同じ key の 2 回目以降は `{ messageRef: <初回の messageRef>, delivered: true, deduped: true }`。並行呼び出しも 1 回だけ送る。`applicationId`（共用ボット）は textFallback 送信時に会話ルーターの `decorateOutbound` へ |
| `updateCard(messageRef, card)` | Slack は `chat.update`、Telegram は `editMessageText` + キーボード差し替え（actions 空ならボタン削除）、Teams は activity update、LINE は新しい Flex を push、飛書 / Lark はカードを `PATCH im/v1/messages/:id`（拒否されたら同じ会話へ新しいカード）、その他は新しいテキストメッセージとして送る |
| `onAction(prefix, handler)` | 最長一致の prefix に配送。`e = { actionId, value, source, messageRef, respond(text), openReasonDialog?, inputText? }`（`openReasonDialog` は Slack のみ。`inputText` はボタンの `input` に書かれた文：Teams は Action.ShowCard 内の Input.Text、飛書 / Lark は form。飛書が form を拒否したら入力欄なしで送り直す。B-028） |
| `claimReplies(matcher, handler)` | `matcher(text, source) → boolean`、`handler({ text, source, reply(text) })` |
| `send(botId, targetId, text, { idempotencyKey?, applicationId?, format?, signal? })` | `idempotencyKey` 指定時のみ `→ { sent: true, deduped }`（key 未指定なら上游と完全に同じ呼び出し）。`applicationId`（共用ボット）は会話ルーターの `decorateOutbound` に渡し、チャネルには渡さない。`targetId` に `{ userId }` / `{ conversationId }` を渡すと sendCard の textFallback と同じ規則でチャネルの配信先に変換する（下記「飛書以外の全プラットフォーム対応」） |
| `setConversationRouter(router)` | 共用ボット（個人 WeChat）の会話ごとの業務アプリケーション。`router = { route({ source, text, replyTo }) → { applicationId } \| null, decorateReply?(source, text) → string, decorateOutbound?({ botId, to, targetId, text, applicationId, kind }) → string }`（関数だけなら route）。5 秒タイムアウト・例外は「割り当てなし」。最後の登録が有効。下記「共用ボット」 |
| `listBots()`（上游のまま） | `Promise<Array<{ botId: string, channel: string }>>`。`channel` は `'weixin' \| 'feishu' \| 'dingtalk' \| 'wecom' \| 'wecom-app' \| 'qq' \| 'slack' \| 'telegram' \| 'discord' \| 'whatsapp' \| 'imessage' \| 'email' \| 'matrix' \| 'line' \| 'teams'`（`line`・`teams` は fork 追加） |

**Disposable の形**：返り値は**関数**（呼ぶと解除、初回 `true`・2 回目以降 `false`）で、同じ関数が `.dispose()` と `[Symbol.dispose]()` も持つ。`d()` / `d.dispose()` のどちらでもよい。

**ImSource**：`{ platform, botId, teamId?, userId, userName?, conversationId, conversationKind: 'direct'|'group', messageId, at, threadId? }`。値はすべてプラットフォームのイベント（Socket Mode envelope、Bot API update、iLink メッセージ等）から取り、本文テキストからは取らない。`messageId` はプラットフォームのメッセージ ID（Slack は `ts`、Telegram は `message_id`、ボタン押下は `action_ts` / callback query id）。`conversationId` は送信先に使える ID（Slack はチャンネル ID、スレッドは `threadId`）。`applicationId?`（`^[a-z][a-z0-9-]{1,62}$`）は会話ルーターだけが付ける（共用ボットの会話の業務アプリケーション）。

### 入站の判定順序

```
入站標準化（ImSource 生成）
 → 会話ルーター（設定時。共用ボットだけ ImSource.applicationId を付ける。以降の全段がこの source を見る）
 → claimReplies（最初に一致したもの。handler に渡して終了。未連携ユーザーの「連携 123456」もここで受かる）
 → accessResolver（設定時。deny なら reply を返して終了）
 → チャンネルのアクセス設定（コマンド権限・明示 allowlist）
 → agent
ボタン（Slack block_actions / Telegram callback / LINE postback / Teams Action / 企業微信 template_card_event / 飛書 card.action.trigger）は別経路で onAction に直接届き、resolver・agent は通らない。
```

- 会話ごとに直列化（遅い resolver でも同じ会話の順序は崩れない）。
- claimReplies / onAction / deny の対象メッセージは **agent Session に入らない**（プロンプト・transcript・session-sync のいずれにも出ない）。
- claimReplies・onAction のハンドラはアクセス判定を通らずに呼ばれる。**認可はハンドラ側（care-api）で行う**こと。

### カード内容を agent に入れない

- カードはチャンネル API で直接送る（Slack driver / Telegram driver）か、proactive 配信（`transient: true`）で送る。agent Session のイベントにはならないので session-sync にも乗らない。
- 送ったカードは「カードメッセージ記録」（7 日保存）に残し、ユーザーがカードに**返信・引用**した場合（Slack スレッド返信の親取得、Telegram `reply_to_message`、微信の引用）は、その引用をプロンプトから外す（`isCardReply`）。メッセージ ID 一致、またはカード本文の部分文字列（4 文字以上）一致で判定。
- 微信の proactive 送信は通常「引用復元用」に送信文を保存するが、カード送信（`transient`）は保存しない。
- Slack の通知用 `text` には `textFallback`（返信コード）を入れない（ボタンがあるため）。Telegram 本文にも入れない。`textFallback` はボタンの無いチャンネルでだけ送る。
- 残る注意点：グループに送ったカードは、群履歴ツール（group history）でプラットフォームから読める場合がある。**承認カードは DM（`to.userId`）で送ること**。

## 行為変更（上游との違い）

1. **アクセスの既定が「閉」**（`accessDefault: 'closed'`）。resolver 未設定のとき、アクセス設定が `open`（Slack / Discord / DingTalk / WeCom / iMessage / Matrix の既定、Telegram の compatible、QQ グループ等）でも**誰も通さない**。通るのは owner 絡みの privileged ID（微信 `ownerUserId`、飛書 owner、DingTalk 承認済み送信者、QQ owner、WhatsApp 自アカウント、Discord owner）と、設定画面の allowlist に明示的に入っている ID（`open` モードで保存されている allowlist も owner の明示付与として扱う。例：Telegram の `allowedUsers`）だけ。Slack には privileged ID が無いので、resolver か allowlist が無い限り Slack は全員拒否になる。
   - 拒否は無言（上游の allowlist 拒否と同じ）。
   - 上游の挙動に戻すには profile の dsh-im 設定に `accessDefault: legacy-open`（または環境変数 `DSH_IM_ACCESS_DEFAULT=legacy-open`）。
   - 設定画面の表示（「開放」）は変えていない。表示と実際の挙動がずれるので注意。
2. resolver が `allow` を返した送信者は、アクセス設定の allowlist に居なくても通る（メンバー判定を resolver が置き換える）。ただし**コマンド権限は設定画面の通り**。
3. ~~resolver 設定時、gate を持つチャンネル以外（飛書）は「閉」の判定~~ → WS P3 で飛書 / Lark にも gate を入れたので、**全チャンネルで resolver の判定が「閉」の owner・allowlist 判定を置き換える**（下記「飛書 / Lark 対応（WS P3）」）。
4. Slack manifest に `interactivity.is_enabled: true` と scope `im:write` を追加（既存アプリは manifest 更新と再インストールが必要。`im:write` は `to.userId` 宛てカードの DM を開くため）。
5. dsh-proactive などプラグイン由来のターンを IM に転送する設定 `forwardPluginSources`（既定 `[]` = 上游どおり転送しない）。
6. 自己更新（設定画面の「更新」）は無効。npm に問い合わせない（`DSH_IM_ALLOW_SELF_UPDATE=1` でのみ有効。上游の update テスト用）。
7. client の loader id は `@care/dsh-im`（パッケージ名）。plugin インスタンス id は互換のため `xmanrui-dsh-im` のまま。

## 設定（profile の `cordis.patch.yml`、id `xmanrui-dsh-im`）

| key | 既定 | 意味 |
|---|---|---|
| `accessDefault` | `closed` | `legacy-open` で上游の開放既定に戻す |
| `forwardPluginSources` | `[]` | 例 `['dsh-proactive']`。Session 同期が有効な IM 宛先へ、そのプラグインが起こしたターンの最終回答を転送（framing は転送しない）。**業務の製品では `[]` のままにする**：写した答えは bridge-notify の送信の守り（宛先は本人の 1:1・本文の検査）を通らない。定時報告は dsh-proactive の `deliver_to` と送信の守りだけで届ける（framework `docs/GUIDELINE.md` d.8。`profile/template` はまだ `[dsh-proactive]`） |
| `deliveryRetentionDays` | `7` | 冪等記録・カード記録の保存日数（7 未満は 7） |
| `deliveryStorePath` | `$DSH_HOME/integrations/dsh-im/care-delivery.json` | 冪等記録（JSON） |

## 変更ファイルと理由

| ファイル | 変更 | 上游 PR 候補 |
|---|---|---|
| `src/channels/shared/im-extensions.mjs`（新規） | 拡張ハブ：ImSource 正規化、入站 gate（claims → resolver、会話ごと直列化）、ターン来源の記録と `dsh-im/inbound`、onAction、Slack モーダル待ち、カード driver 登録、sendCard/updateCard、カード引用判定 | ① ② ③ ④ |
| `src/channels/shared/im-card.mjs`（新規） | Card 検証、Block Kit / Telegram キーボード / テキスト描画、messageRef（自己記述的な不透明文字列 `dshim:v1:…`） | ③ |
| `src/channels/shared/delivery-idempotency-store.mjs`（新規） | 冪等・カード記録の JSON ストア（7 日保持、原子的書き込み、プロセス内の並行重複は共有） | ③ ⑤ |
| `src/channels/shared/inbound-access.mjs` | `resolverVerdict` と既定閉モード | ② |
| `src/channels/shared/text-harness-bridge.mjs` | `imSourceFor()`、`accept()` の gate ラッパ（元処理は `#acceptMessage`）、カード引用の除去、Telegram カード押下 → onAction（`acceptCallback`） | ① ② ④ |
| `src/channels/shared/workspace-session.mjs` | `askInWorkspaceSession({ imSource })`：プロンプト投入直前に来源を記録、ask 完了で解除（reply timeout 時は `turn/end` で解除） | ① |
| `src/channels/slack/slack-runtime.mjs` | `interactive` envelope（block_actions / view_submission / view_closed）の処理、`openReasonDialog`（views.open、本人以外の送信は無視）、Block Kit カード driver、ImSource ヒント（teamId・ts） | ③ ④ |
| `src/channels/slack/slack-api.mjs` | `postMessage/updateMessage` の `blocks`、`openDirectConversation`、`openView` | ③ ④ |
| `src/channels/slack/manifest.mjs` | interactivity・`im:write` | ④ |
| `src/channels/telegram/telegram-runtime.mjs` | カード driver（inline keyboard、callback_data = `dc:<cardId>:<index>` ≤ 64B）、ImSource ヒント | ③ |
| `src/channels/telegram/telegram-api.mjs` | inline keyboard の URL ボタン | ③ |
| `src/channels/weixin/weixin-bridge.mjs` / `weixin-runtime.mjs` | gate・来源・カード引用の除去、`transient` 送信は引用復元用に保存しない | ① ② ⑤ |
| `src/channels/{dingtalk,wecom,wecom-app,qq}/*-bridge.mjs` | gate（claims / resolver）と来源 | ① ② |
| `plugin-src/host/care-extensions.mjs`（新規） | Host 配線：ハブ設定、`dsh-im/inbound` emit、テキストチャンネル向けフォールバック送信、`send({ idempotencyKey })`、ターン境界の追跡 | ① ③ ⑤ |
| `plugin-src/host/index.mjs` | `dshIm` サービスへ追加メソッドを公開、session-sync へ設定を渡す | ③ |
| `plugin-src/host/session-sync-coordinator.mjs` | `forwardPluginSources`（`plugin:<name>` / 旧 `{kind:'plugin', plugin}`）、ターン境界コールバック | ⑥ |
| `plugin-src/host/delivery-service.mjs` | `send()` の `transient` を channel へ渡す | ⑤ |
| `plugin-src/host/update-runtime.mjs` / `update-service.mjs` | 自己更新の無効化 | （fork 専用） |
| `src/channels/shared/rename-retry.mjs`（新規）、`conversation-state-store.mjs`、`qq/state-store.mjs`、`update-service.mjs` の `writeJson` | Windows の `rename` `EPERM`/`EBUSY`/`EACCES` を短く再試行（状態保存の取りこぼし防止） | （上游へ提案可。Windows のみ効く） |
| `test/channels/feishu/bridge.test.mjs`、`test/image-input.test.mjs`、`test/channels/feishu/lark-sdk-handshake-patch.test.mjs` | Windows 対応の最小修正（JSON エスケープ、モードビット、`%TEMP%` 書き込み不可時の skip） | （上游へ提案可） |
| `plugin-src/client/build.mjs` | loader id をパッケージ名から取る | （fork 専用。上游では同値） |
| `package.json` / `cordis.patch.yml` | 名前・版・`upstream` 記録・`test:care`・テスト前処理 | （fork 専用） |
| `scripts/verify-package.mjs`、`test/client-i18n-bundle.test.mjs`、`test/support/care-fork-env.mjs` | パッケージ名変更と自己更新無効化への追従 | （fork 専用） |
| `src/channels/{discord,imessage,wecom}/*`・`delivery-adapter.mjs`・`im-card.mjs` ほか | 飛書以外の全プラットフォーム対応（Discord DM、iMessage グループ、企業微信 AI ボットのカード、ユーザー宛て updateCard）。下記 WS P2 の表 | ③ ⑥ |
| `src/channels/feishu/{bridge,feishu-runtime,feishu-cards}.mjs`・`im-extensions.mjs` | 飛書 / Lark の入站 gate（claims / resolver / 来源記録）、ネイティブ interactive カードの driver と card.action.trigger → onAction、カード引用の除去。下記 WS P3 の表 | ① ② ③ ④ |
| `test/care/*` | care テスト（node:test、Slack Socket Mode envelope / Telegram update のモック） | 各 PR に同梱 |

## 上游へ提案する PR（予定）

1. **Trusted inbound source for tools**：`ImSource`・`sourceForTurn()`・`dsh-im/inbound` イベント（`askInWorkspaceSession` に来源を渡す）。
2. **Pluggable access resolver + default-closed option**：`setAccessResolver()` と `accessDefault`（上游では既定 `legacy` のまま提案）。
3. **Rich card delivery API**：`sendCard/updateCard`（Block Kit / Telegram keyboard / text fallback）と冪等キー。
4. **Slack interactivity**：Socket Mode `interactive` envelope、`onAction`、`views.open` モーダル。manifest 更新。
5. **Reply claims for all text channels**：`claimReplies()`（飛書の `consumeInbound` を他チャンネルにも一般化する形）。
6. **Idempotent proactive send**：`send({ idempotencyKey })`、`transient` 送信。
7. **Forward plugin-originated turns**：`forwardPluginSources`（dsh-proactive の結果を IM へ）。

## 未対応・既知の制限

- **飛書 / Lark**：WS P3 で対応（claims / resolver / 来源記録 / ネイティブカード / ユーザー宛て proactive）。残る制限は下記「飛書 / Lark 対応（WS P3）」の「既知の制限」。
- **LINE / Teams**：実装済み（下記「LINE / Microsoft Teams チャネル」）。チャネル固有の制限はその節を参照。
- **Discord グループ**：runtime が受理前に独自にアクセス判定するため、resolver で許可されても上游のスレッド作成経路を通らず元チャンネルで処理される。
- プラットフォーム別の制限（WeChat の context、Teams の事前 1:1、LINE の上限、QQ・企業微信の能動送信、Discord DM、iMessage の macOS、Email の未認証 From）は下記「飛書以外の全プラットフォーム対応」の「既知の制限」。
- **Telegram 音声**：resolver 許可だけの送信者（allowlist 外）の音声は文字起こし前のアクセス判定で弾かれ、空の本文になる。
- 同じ Session に IM 以外（デスクトップ・proactive）のターンが**同時に**走っている場合、`sourceForTurn` は直近に投入された IM プロンプトの来源を返す。busy 時の steer は既定閉では privileged / allowlist の送信者だけ。
- `openReasonDialog` は Slack のみ。trigger_id の有効期限が 3 秒なので、handler は外部呼び出しの前に開くこと。モーダルの応答待ちは最大 15 分（それ以降は `null`）。
- ボタンの無いチャンネルの `updateCard` は「編集」ではなく新規送信。
- 冪等性は「成功後に記録」。プロバイダが受理した直後にプロセスが落ちると、その 1 通だけ再送されうる。
- Slack 既存アプリは manifest 更新・再インストールが必要（interactivity と `im:write`）。

## LINE / Microsoft Teams チャネル（Phase 3 WS-K）

`docs/design/PHASE3_CONTRACTS.md` §3。どちらも上游には無い fork 独自チャネルで、公開 HTTPS の webhook で受信する（Socket Mode / long polling ではない）。

### 受信経路と判定順序

```
POST /dsh-hooks/line   … X-Line-Signature = base64(HMAC-SHA256(channel secret, 生 body))、timingSafeEqual
POST /dsh-hooks/teams  … Authorization: Bearer <JWT>（Bot Framework OpenID metadata → JWKS、RS256、
                          iss=https://api.botframework.com、aud=App ID、exp/nbf（±5 分）、鍵の endorsements に channelId、
                          JWT の serviceurl = activity.serviceUrl）
  → webhook hub（src/channels/shared/webhook-hub.mjs）が各 bot の runtime に順に渡す
     LINE: 署名が一致した bot / Teams: JWT の aud が App ID と一致した bot（その後に完全検証。失敗は 401）
  → 文字メッセージ: 標準化（ImSource）→ claimReplies → accessResolver → チャネルのアクセス設定 → agent
  → LINE postback / Teams Action.Submit・Action.Execute: onAction に直接（resolver・agent は通らない）
```

- どの bot にも一致しない要求は 401。GET などは 405、1 MiB 超は 413。応答は即時（LINE は 200 `{}`、Teams invoke は `{statusCode:200,type:'application/vnd.microsoft.activity.message',value:''}`）で、処理は非同期。
- 再送（LINE `isRedelivery`、Teams の同一 activity）は `webhookEventId` / activity id と状態ストアの `hasSeen` で 1 回だけ処理。
- 単一テナント設定の Teams bot は、activity の tenant が一致しなければ 403。`channelId` は既定 `msteams` のみ受理。

### ImSource

| | LINE | Teams |
|---|---|---|
| platform | `line` | `teams` |
| userId | 送信者の LINE userId（`U…`）。グループでも送信者本人。userId の無いイベントは捨てる | 送信者の AAD objectId（`from.aadObjectId`）。無いものは捨てる |
| teamId | なし | tenantId（`channelData.tenant.id`） |
| conversationId | 1:1 = userId、グループ = groupId（`C…`）、複数人トーク = roomId（`R…`） | `conversation.id` |
| conversationKind | user → direct、group/room → group | personal → direct、groupChat/channel → group |
| messageId | message.id（postback は webhookEventId） | activity.id |

グループは既存方針どおり「宛先指定されたものだけ」：LINE は自 bot への mention（`isSelf`）、Teams は recipient 宛の `<at>` mention。mention 部分は本文から除く。

### 送信

- **LINE**：reply token が未使用かつ受信から 50 秒以内なら reply、それ以外（期限切れ・400・429）は push。push は毎回 `X-Line-Retry-Key` を付け、429/5xx/通信断は同じキーで再試行（409 = 受理済みとして成功扱い）。`sendCard` のキーは `idempotencyKey` から決定的に作る UUID（`lineRetryKey('card:<key>:<batch>')`）。reply は 429 だけ再試行。トークンバケットで既定 30 req/s/bot。1:1 では応答中にローディング表示（`/v2/bot/chat/loading/start`）。
- **Teams**：`login.microsoftonline.com/{tenantId | botframework.com}/oauth2/v2.0/token`（client_credentials、scope `https://api.botframework.com/.default`、期限 5 分前まで cache）→ `{serviceUrl}/v3/conversations/{id}/activities[/{replyToId}]`。412/429/502/503/504 は Retry-After を尊重して再試行、401 はトークンを取り直して 1 回だけ再送。既定 7 req/s/bot。serviceUrl は https のみ（検証済み activity から学習した値だけ使う）。

### カード

- **LINE Flex Message**（bubble）：title / fields（baseline box）/ body / footer、ボタンは **postback**。`data` には `{"a": actionId, "v": value}` **だけ**を入れる。300 文字を超える場合のみ、カード記録の参照 `dc:<cardId>:<index>` に置き換える（中身は 7 日保存のカード記録から引く）。danger は赤、link は uri ボタン。`updateCard` は LINE が編集できないため新しい Flex を push。
- **Teams Adaptive Card 1.4**：FactSet・TextBlock、ボタンは `Action.Execute`（verb = actionId）＋ fallback `Action.Submit`。どちらも `data = { dshImAction: { actionId, value } }`。`updateCard` は activity update（PUT）。
- `sendCard({ to: { userId } })` は、LINE は userId に push、Teams はその AAD ユーザーが過去に bot と 1:1 で話した会話参照（`integrations/dsh-teams/bots/<botId>/references.json`、秘密値なし）を使う。参照が無ければ `invalid-target`（Teams の制約：先にユーザーから話しかける必要がある）。
- `onAction` の `messageRef`：LINE は postback に元メッセージ ID が無いので会話のみ（messageId null）。Teams は `replyToId`（カード activity）。

### 管理 RPC（care-web からも利用可）

`registerManagementRpc` で **`/line`**・**`/teams`** を登録（DSH 上の経路は `POST /api/dsh-im/line`、`/api/dsh-im/teams`。エンベロープは他チャネルと同じ `client-request` / `server-response`）。エンドポイント名は `shared/rpc.mjs` の `TOKEN_BOT_ENDPOINTS` と同じ（thinking 系 3 つは無し）。

| endpoint | payload | 説明 |
|---|---|---|
| `connection.status` | `{}`（他のキー不可） | 下記 status |
| `bot.bind-credentials` | LINE: `{ channelSecret, channelAccessToken }`<br>Teams: `{ appId, appPassword, tenantId? }` | 検証して保存・起動。応答は status |
| `bot.reconnect` | `{ botId, sendTest? }` | 再接続。`sendTest: true` で直近の 1:1 相手に接続テスト文を送り、`testMessage` を付ける |
| `bot.delete` | `{ botId, confirm: true }` | 停止し、credentials・設定・会話状態を削除 |
| `bot.access-policy.set` | `{ botId, policy }` | アクセス設定（既存と同じ形） |
| `bot.alias.set` / `bot.workspace.set` / `bot.model.set` / `bot.agent-preset.set` / `bot.context-enhancement.set` / `bot.message-mode.set` | 既存チャネルと同じ | 上級設定 |

検証（違反は `bad-request`）：
- botId：LINE `^line_[a-f0-9]{24}$`、Teams `^teams_[a-f0-9]{24}$`（プラットフォーム ID の SHA-256 から導出）。
- LINE `channelSecret`：32 桁 16 進。`channelAccessToken`：`^[A-Za-z0-9+/=._-]{20,4096}$`（長期トークン）。保存前に `GET /v2/bot/info` で検証し、bot の userId を ID にする。※ channel secret は API で検証できないので、誤っていると webhook が 401 になる（status の `stats.webhooksRejected` は増えない＝どの bot にも一致しないため。LINE Developers の「検証」ボタンで確認する）。
- Teams `appId`：GUID。`appPassword`：1〜1024 文字。`tenantId`：省略・空・null ならマルチテナント（`botframework.com`）、指定時は GUID（単一テナント）。保存前にアプリトークン取得で検証。

エラー code（`message` は中国語。care-web は code で写像すること）：

| code | 意味 |
|---|---|
| `bad-request` | payload 不正（上記） |
| `cancelled` | 呼び出し側が中止 |
| `line-initializing` / `teams-initializing` | 起動中 |
| `line-startup-config-invalid` / `-startup-permission-denied` / `-startup-failed`（teams も同様） | 設定ファイル破損・権限・起動失敗 |
| `invalid-token` | LINE がアクセストークンを拒否（401） |
| `forbidden` | LINE が 403 |
| `identity-mismatch` | 保存済み bot とトークンの bot が違う |
| `line-network-error` / `teams-network-error` | LINE API / Microsoft login・Bot Connector に到達できない・5xx・429 |
| `invalid-credentials` | Microsoft login が App ID / password / tenant を拒否 |
| `workspace-*` | ワークスペース設定の既存エラー |
| `line-operation-failed` / `teams-operation-failed` | その他 |

status（秘密値・`*Ref`・`platformId` は `sanitize` で除去。値は保存しない）：

```js
{ schemaVersion: 1, revision, webhookPath: '/dsh-hooks/line', state: 'disconnected'|'connected'|'degraded'|'offline',
  totals: { configured, connected },
  bots: [{ botId, state, connected, configured: true, webhookPath,
           bot: { name, username,            // LINE: basicId（先頭 @ なし）
                  idMasked,
                  appId, tenantMode: 'single'|'multi', tenantId },   // Teams のみ
           health: { status, summary, lastCheckedAt, lastConnectedAt, lastWebhookAt },
           stats: { messagesReceived, messagesReplied, webhooksRejected },
           lastMessageError, error,
           workspace, model, agentPreset, contextEnhancement, busyMessageMode, accessPolicy, alias… }] }
```

**webhook URL の表示**：status の `webhookPath`（`/dsh-hooks/line`・`/dsh-hooks/teams`）を、利用者がブラウザで開いている**公開オリジン**に連結して表示する（`location.origin + webhookPath`）。DSH 本体の設定画面も同じ方法で表示し、コピー用ボタンを付けている。

### 設定画面

IM ボット画面のチャネル一覧に「LINE」「Microsoft Teams」を追加（Slack の次）。既存の token チャネルと同じページ部品（ボット一覧・再接続・削除・別名・ワークスペース・モデル・プリセット・文脈強化・アクセス設定・投递設定）に、複数項目の接続フォームと webhook URL 表示を付けたもの（`plugin-src/client/channels/{line,teams}/`、`shared/webhook-channel.js`）。秘密値は `type=password` で入力し、保存後は表示しない（`idMasked` のみ）。日本語は `plugins/dsh-lang-ja/locales/ja/dsh-im.json` に追記（既存キーは変更なし）。**`plugins/dsh-lang-ja` の `node scripts/build.mjs` で `lib/client.js` を再生成するまで日本語は反映されない**（WS-K の書き込み範囲外のため未実行。未反映の間は英語表示）。

### 本番に必要な設定

1. 公開 HTTPS：業務 Web（BFF）のオリジンで `/dsh-hooks/line`・`/dsh-hooks/teams` を受ける。BFF は `createDshGateway({ publicPaths: (process.env.DSH_PUBLIC_HOOK_PATHS || '').split(',').filter(Boolean) })`、環境変数 `DSH_PUBLIC_HOOK_PATHS=/dsh-hooks/line,/dsh-hooks/teams`。ゲートウェイはこれらの POST だけを認証なし・cookie なしで DSH に転送する（`packages/dsh-gateway/README.md`）。
2. LINE Developers：Messaging API チャネルの Channel secret と長期 Channel access token を IM ボット画面で登録 → Webhook URL `https://<公開オリジン>/dsh-hooks/line` を設定、「Webhook の利用」オン、応答メッセージ（自動応答）オフ、グループ利用時は「グループ・複数人トークへの参加を許可」。
3. Azure Bot：Messaging endpoint `https://<公開オリジン>/dsh-hooks/teams`、Microsoft Teams チャネルを有効化、Entra ID アプリのクライアントシークレット。単一テナントなら Tenant ID も登録。Teams アプリ（manifest）を組織に配布する。
4. 送信先：DSH ホストから `api.line.me`、`login.microsoftonline.com`、`login.botframework.com`、各 `smba.trafficmanager.net` へ HTTPS 出口が必要。
5. 試験用の差し替え（本番では設定しない）：profile の dsh-im 設定 `line.apiBaseUrl`、`teams.loginBase` / `teams.openIdMetadataUrl` / `teams.allowInsecureServiceUrl`。

### 追加・変更ファイル（WS-K）

| ファイル | 内容 |
|---|---|
| `src/channels/line/*`（新規） | Messaging API クライアント・署名検証・retry key（`line-api.mjs`）、runtime（webhook・postback・Flex・reply/push）、controller・config・state |
| `src/channels/teams/*`（新規） | JWT/JWKS 検証・アプリトークン（`teams-auth.mjs`）、Connector REST・会話参照（`teams-api.mjs`）、runtime、controller・config・state |
| `src/channels/shared/webhook-hub.mjs`・`webhook-bot-controller.mjs`・`webhook-config-store.mjs`・`rest-client.mjs`（新規） | webhook 受信の振り分け、複数秘密値の controller、設定ストア、HTTP・レート制限・再試行 |
| `src/channels/shared/im-card.mjs` | `lineFlexMessage` / `linePostbackData` / `parseLinePostbackData`、`teamsAdaptiveCard` / `parseTeamsActionData` |
| `src/channels/shared/im-extensions.mjs` | driver の `sendCard` helpers に `idempotencyKey` を渡す（LINE retry key 用） |
| `src/channels/shared/{command-catalog,harness-approval,session-channel-labels}.mjs`、`i18n-{en,ru}/webhook.mjs` | line/teams をチャネル表に追加、host 文言 |
| `plugin-src/host/webhook-http.mjs`（新規）・`index.mjs` | `/dsh-hooks/line`・`/dsh-hooks/teams` を webServer に登録、チャネル起動 |
| `plugin-src/host/channels/{line,teams}/*`・`shared/webhook-{production,rpc}.mjs`（新規） | production 配線、`/line`・`/teams` 管理 RPC |
| `plugin-src/host/{delivery-adapter,delivery-suggestions,care-extensions,sidebar-settings}.mjs`、`channels/shared/{access-policy-production,startup-error}.mjs` | 配信先（LINE: user/group/room、Teams: conversation）、カード fallback、サイドバー判定、初期アクセス方針、起動エラー |
| `plugin-src/client/channels/{line,teams}/*`・`shared/webhook-channel.js`（新規）、`index.js`・`channel-logos.js`・`session-channel-logos.js`・`access-policy-settings.js`・`delivery-settings.js`・`styles.js`・`i18n.js`・`i18n-ru.js` | 設定画面 |
| `test/care/{line-care,teams-care,webhook-host}.test.mjs`（新規） | モック端点のみ |
| `test/{host,host-language-bundle,update-rpc,client-ui,client-delivery-settings}.test.mjs`、`test/channels/shared/startup.test.mjs` | チャネル数・一覧に line/teams を追加（fork 専用の追従） |

### テスト（2026-10-25、Windows）

- `npm run test:care`：65 件全件成功（新規 33 件：署名の正常・改ざん・別 secret・欠落、JWT の正常・改ざん payload・別鍵・期限切れ・iss/aud/serviceUrl/alg/kid/endorsement 不一致、アプリトークン（単一/マルチテナント・cache・拒否）、postback / Action.Submit / Action.Execute → onAction（resolver・agent を通らない）、Flex / Adaptive Card 生成、claimReplies → resolver → agent の順序、既定閉、reply→push フォールバック、同じ retry key での再試行と 409、sendCard の冪等、activity update、単一テナント拒否、RPC 検証・秘密値非返却・webhookPath、配信先）。
- `npm test`：4681 件中 39 件失敗。すべて上游ベースラインの既知失敗（`update-service`・Feishu handshake・QQ durability・Feishu workspace titles・image-input の Windows ファイルモード）で、新規の失敗なし。
- 隔離環境（`.dsh-home-k`、DSH 3184、profile `care` を同 home に展開）で読み込みを確認：IM ボット画面に LINE / Microsoft Teams が表示され、両方の接続フォーム（webhook URL 表示つき）が開く。コンソールエラーなし。`POST /dsh-hooks/line`（不正署名）→ 401、`GET /dsh-hooks/teams` → 405、`POST /dsh-hooks/teams`（不正 JWT）→ 401。確認後に停止。

### 未対応・既知の制限（LINE / Teams）

- 受信は文字メッセージのみ（LINE の画像・スタンプ・ファイル、Teams の添付は無視）。送信も文字とカードのみ（ファイル送信なし）。
- LINE はメッセージ編集ができないため `updateCard` は新規送信。postback には元メッセージ ID が無い。
- Teams の proactive 送信は、相手が先に bot へ話しかけて会話参照がある場合だけ（Graph によるアプリ事前インストールは未対応）。`openReasonDialog`（理由入力モーダル）は Slack のみ（Teams の Task Module、LINE の LIFF は未対応）。
- Action.Execute の応答でカードを差し替える（Universal Actions の refresh）ことはしない（`respond()` はテキスト返信、更新は `updateCard`）。
- Bot Framework Emulator のトークン（別 issuer）・政府クラウド（GCC High / DoD）・sovereign cloud は未対応。
- LINE の channel secret は保存時に検証できない（webhook の署名検証で初めて分かる）。
- 公開 webhook は DSH プロセスごとに 1 経路。複数 DSH を負荷分散する構成は未考慮。

## 設定画面の部品の再利用（WS-Q）

care-web（`apps/care-web/src/im/`）が `plugin-src/client` の部品を直接 import して使うための追加（`docs/design/IM_ADMIN_UI.md` §1.2）。DSH 本体の設定画面の見た目・挙動は変えていない（色は全て既定値＝元の色）。

### WeChat 扫码パネル（`plugin-src/client/channels/weixin/index.js` の具名 export）

`WeixinSettingsTab` 内部で使っていた関数に `export` を付けただけ（中身・呼び出し方は従来どおり）。文言は `h()` 経由で辞書翻訳される。CSS は `installImStyles()` + `installWeixinStyles()` が前提で、祖先に `.dim-panel`（QR 枠・手順・ボタンの共通スタイル）と `.dxw-page`（`--dxw-accent` 等）が必要。

| 部品 | props | 説明 |
|---|---|---|
| `QrPanel` | `{ provision, now, busy, onRefresh(), onCancel() }` | QR 表示。`provision` は `normalizeProvisioning()`（`weixin/api.js`）の結果：`status: 'pending' \| 'scanned' \| 'expired'`、`expiresAt`（epoch ms）、`qrCodeDataUrl?`（`safeQrSource` を通る data URL のみ表示）、`verificationUrl?`（weixin.qq.com / wechat.com の https のみ「備用リンク」に出す）、`durationMs?`（進捗バーの分母、既定 5 分）。`now` は現在時刻（ms）で、**呼び出し側が 1 秒程度ごとに再描画**して残り時間を進める（本体は `useAnimationFrameScheduler`）。`expiresAt <= now` または `status === 'expired'` で期限切れ表示と「重新生成二维码」（`onRefresh`）。`qrCodeDataUrl` が変わると画像エラー状態をリセット |
| `VerificationPanel` | `{ provision, busy, onSubmit(code), onCancel() }` | 配对码入力（`status === 'needs_verification'`）。`code` は 4〜8 桁の数字文字列（それ以外は送信不可）。`provision.attemptId` が変わると入力をクリア |
| `ProgressPanel` | `{ scanned?, busy?, onCancel? }` | 待機表示。`scanned` 偽 = 「QR 準備中」（`status === 'starting'`）、真 = 「確認済み・接続中」（`'connecting'`）。`onCancel` を渡したときだけ取消ボタンを出す |
| `ProvisionError` | `{ provision, busy, onRetry(), onClose() }` | 失敗表示（`'failed' \| 'expired' \| 'cancelled'`）。`provision.error`（`{ code, message, details? }`）を `WeixinConnectionError` で出す |

RPC（`/weixin` の `provision.begin` / `provision.poll` / `provision.verify` / `provision.cancel`。endpoint 名は `WEIXIN_ENDPOINTS`）と状態遷移は `WeixinSettingsTab` の実装（`startProvisioning` / `submitVerification` / `cancelProvisioning` とポーリング）をそのまま参照すること。

### 色トークン（color tokens）

写死だった色を CSS 変数にした。**どれも `var(--name, 元の色)` の形で、未定義なら DSH の元の色**。DSH 自身のトークン（`--dsw-alias-*`）で既に書かれていた箇所は変えていない。

共通：

| 変数 | 既定 | 使う所 | 暗色フック時 |
|---|---|---|---|
| `--dsh-im-accent` | `#1677ff` | 共通パネルの主ボタン（扫码接入・恢复・主操作）、帮助ボタン、進捗バー、spinner、QR 枠、工作区「编辑」 | （変えない） |
| `--dsh-im-accent-strong` | `#0958d9` | 主ボタン hover | `#3b8cff` |
| `--dsh-im-accent-text` | `#0f5fce` | 帮助ボタン hover の文字、飞书语音保存 hover | `#69a7ff` |
| `--dsh-im-accent-muted` | `#4d93f8` | 手順の番号 | — |
| `--dsh-im-on-accent` | `#fff`（weixin は `white`） | 主ボタン・保存ボタン上の文字、スイッチのつまみ | — |
| `--dsh-im-border-strong` | `#aeb3bb` | 二次ボタン hover の枠 | `#5c6370` |
| `--dsh-im-status-idle` | `#aeb3bb` | 未接続の状態ドット | `#6b7280` |
| `--dsh-im-input-border` | `#86909c` | 「手动接入」ボタンの枠 | — |
| `--dsh-im-input-border-strong` | `#4e5969` | 同 hover・押下、凭据入力の focus 枠 | `#a9b1bd` |
| `--dsh-im-track` | `#eef0f3`（進捗）/ `#e6e8eb`（spinner） | 進捗バー・spinner の下地 | `rgb(255 255 255 / 12%)` |
| `--dsh-im-logo-border` | `#e5e6eb`（Matrix アバターは `#e2eae7`） | 白地のロゴ・アバターの枠（Slack / LINE / Teams / Matrix） | — |
| `--dsh-im-brand-feishu` | `#3370ff` | 飞书语音保存 hover の下地 | — |

チャネルのブランド色（各チャネルページの `--ddt-accent` / `--ddt-accent-deep` / `--ddt-accent-wash`、WeChat は `--dxw-accent` / `--dxw-accent-dark`）：`--dsh-im-brand-<ch>`（主色：主ボタン背景・進捗・強調）、`-strong`（hover・淡色地の上の文字）、`-wash`（淡色地）。

| `<ch>` | brand | strong | wash | 暗色フック時 |
|---|---|---|---|---|
| `weixin` | `#07c160` | `#05994c` | — | — |
| `dingtalk` | `#1677ff` | `#0958d9` | `#eaf3ff` | strong `#3b8cff`（`-light` `#2997ff` はアバター・ブランドマークのグラデーション始点） |
| `qq` | `#1677ff` | `#0958d9` | `#eaf3ff` | strong `#3b8cff` |
| `wecom` | `#3370ff` | `#245bdb` | `#eef4ff` | strong `#5689ff` |
| `wecom-app` | `#07c160` | `#059a4c` | `#eefaf3` | — |
| `slack` | `#4a154b` | `#321033` | `#f7eef7` | brand `#b746b9`、strong `#d162d3` |
| `telegram` | `#229ed9` | `#1687bd` | `#eaf7fd` | —（brand はスイッチ ON の色にも使う） |
| `discord` | `#5865f2` | `#4752c4` | `#eef0ff` | strong `#7983f5` |
| `whatsapp` | `#25d366` | `#128c7e` | `#eafbf0` | — |
| `email` | `#2f6fd0` | `#24559f` | `#eef4fd` | strong `#5d8fda` |
| `imessage` | `#32a852` | `#248a40` | `#edf9f0` | — |
| `matrix` | `#1a8f6f` | `#12654f` | `#eef8f4` | strong `#1da07c` |
| `line` | `#06c755` | `#05a647` | `#e8f9ee` | — |
| `teams` | `#5b5fc7` | `#4f52b2` | `#eef0fb` | strong `#8487d5` |

暗色フック時は全チャネルの `-wash` が `color-mix(in srgb, <brand> 16%, transparent)`（slack・teams は 18%）になる。

ロゴタイル・アバター（`--dsh-im-logo-<ch>`、暗色でも変えない＝識別色）：`weixin #07c160`、`dingtalk #1677ff`、`qq #1677ff`、`telegram #229ed9`、`discord #5865f2`、`whatsapp #25d366`、`matrix #0dbd8b`、`office` / `imessage` / `email` / `slack` / `matrix-avatar` はグラデーション（値は各 styles の既定値）、`wecom #3370ff`・`wecom-app #07c160`（白地の上のグリフ色）、`line` / `teams` `#fff`。

**暗色テーマでの使い方**：祖先要素に `data-dsh-im-theme="dark"` を付けると上表「暗色フック時」の値になる（`styles.js` 先頭の `[data-dsh-im-theme="dark"]` ブロック。DSH 本体はこの属性を付けないので見た目は変わらない）。個別に変えたいときは祖先で変数を直接上書きする（例：`.imEmbed { --dsh-im-accent: var(--primary); --dsh-im-brand-slack: var(--primary); }`）。

トークン化していないもの：QR 枠の白地とその上の文字（QR は白地が必要）、期限切れオーバーレイの白文字、ロゴタイル上の白いグリフ、`channel-logos.js` の SVG ロゴ本体の配色、`session-channel-logos.js`（DSH サイドバーのセッション行）、`ds-bot-avatar*`、影（`rgb(31 35 41 / …)`）。

### 入力検証エラー（validation reason）

管理 RPC がペイロードを拒否したとき、**`code: 'bad-request'` はそのまま**（上游テスト・既存の写像との互換）で、`reason`（下表）と、原因の入力が特定できるときは `field`（ペイロードのキー名）を付ける。`message` は reason ごとの中国語原文（辞書キー）になり、DSH の画面では en / ru / ja に翻訳される（以前は `bot.bind-credentials requires …` などの英語で、辞書に無かった）。

```js
{ ok: false, error: { code: 'bad-request', reason: 'invalid-app-token', field: 'appToken', message: 'App Token 格式不正确（应以 xapp- 开头），请检查后重新填写。' } }
```

| reason | 意味 | `field` |
|---|---|---|
| `invalid-payload` | 形が不正（オブジェクトでない・未知のキー・未知の endpoint・型違い） | — |
| `missing-field` | 必須項目が未入力（未指定・null・空白のみ） | 例 `token`、`botToken`、`appPassword`、`userId` |
| `invalid-bot-token` | Bot Token の形式違い（Telegram / Discord の `token`、Slack の `botToken`＝`xoxb-`） | `token` / `botToken` |
| `invalid-app-token` | Slack App Token の形式違い（`xapp-`） | `appToken` |
| `invalid-credential` | その他の凭据の形式違い（LINE `channelSecret`・`channelAccessToken`、Teams `appId`・`appPassword`・`tenantId`、Matrix `homeserver`・`accessToken`・`userId`・`password`、QQ `appId`・`appSecret`、WeCom `botId`・`secret`、WeCom 自社アプリ `corpId` 等、DingTalk `clientId`・`clientSecret`、Feishu `appId`・`appSecret`） | 各キー |
| `invalid-bot-id` | `botId` が不正（画面の状態が古い等） | `botId` |
| `confirmation-required` | `bot.delete` に `confirm: true` が無い | `confirm` |
| `invalid-attempt` | 扫码などの接入手続き（attempt）が不正・失効 | `attemptId` |
| `invalid-verification-code` | WeChat 配对码が 4〜8 桁の数字でない | `verifyCode` |
| `invalid-setting` | 上級設定（ワークスペース・モデル・別名など）の値が不正。`message` は従来どおりの中国語（既に辞書にある） | — |

- 対象：`/telegram`・`/discord`（`shared/rpc.mjs`）、`/slack`、`/line`・`/teams`（`shared/webhook-rpc.mjs`）、`/matrix`、`/qq`、`/wecom`、`/wecom-app`、`/dingtalk`、`/weixin`、`/whatsapp`、`/feishu`。それ以外（office・delivery・inbound TTL・group triggers 等）は従来どおり `reason` なし。
- 実装：`src/channels/shared/validation-reason.mjs`（`VALIDATION_REASONS`、`VALIDATION_MESSAGES`、`validationMessage(reason)`、`credentialFailure`、`validationError` / `validationRejected`）。各チャネルの検証関数は変えず、拒否時に endpoint・payload・凭据の定義から reason を割り出す。
- クライアント：`normalizeConnectionError`（`plugin-src/client/connection-error.js` と `channels/weixin/api.js`）が `reason`・`field` を残し、既知の reason なら `message` を `validationMessage(reason)` に置き換える（ホストの文面に依らず reason で翻訳）。補助として `validationReasonFields(error)` を export。care-web は `reason` で写像するか、`localizeText(validationMessage(reason))` を使う。
- 辞書：上表の 9 文（`invalid-setting` 以外）を `i18n.js`（EN）・`i18n-ru.js`（RU）・`plugins/dsh-lang-ja/locales/ja/dsh-im.json`（JA、追記のみ）に追加。`plugins/dsh-lang-ja/reference/{en,zh}/dsh-im.json` は fork の `lib/client.js` を `scripts/harvest-en.mjs --bundle` で収集した結果（既存キーは無変更、9 キー追加）。

### 変更ファイル（WS-Q）

| ファイル | 内容 |
|---|---|
| `plugin-src/client/channels/weixin/index.js` | `QrPanel`・`VerificationPanel`・`ProgressPanel`・`ProvisionError` を export |
| `plugin-src/client/styles.js`、`channels/{dingtalk,qq,wecom,wecom-app,slack,telegram,discord,whatsapp,email,imessage,matrix,office,feishu,weixin}/styles.js`、`channels/{line,teams}/index.js` | 色トークン化と暗色フック |
| `src/channels/shared/validation-reason.mjs`（新規） | reason の定義と判定 |
| `plugin-src/host/channels/{shared/rpc,shared/webhook-rpc,slack/rpc,line/rpc,teams/rpc,matrix/rpc,qq/rpc,wecom/rpc,wecom-app/rpc,dingtalk/rpc,weixin/rpc,whatsapp/rpc,feishu/rpc}.mjs` | 拒否応答に reason / field |
| `plugin-src/client/connection-error.js`、`channels/weixin/api.js`、`i18n.js`、`i18n-ru.js` | reason による文言差し替え、EN / RU 辞書 |
| `test/client-ui.test.mjs`、`test/channels/dingtalk/client-ui.test.mjs` | CSS の色の期待値を `var(--dsh-im-…, 元の色)` に追従（fork 専用） |
| `test/care/settings-reuse.test.mjs`（新規） | 上記 3 点のテスト |

### テスト（2026-10-25、Windows）

- `node --test test/care/*.test.mjs`：70 件全件成功（新規 5 件）。i18n の `client-i18n-{bundle,dynamic,ru}.test.mjs`・`history-i18n.test.mjs`：36 件全件成功。
- `npm test`：4686 件中 43 件失敗。すべて上游ベースラインの既知失敗（`update-service`・Feishu handshake / workspace titles・QQ/Telegram durability・image-input の Windows ファイルモード）で、新規の失敗なし。`node scripts/verify-package.mjs` 成功。
- `plugins/dsh-lang-ja`：`node scripts/build.mjs` 後、`node --test test/*.test.mjs` 11 件全件成功。

## e2e 用の LINE API base 上書き（Phase 4 WS-U）

`docs/design/PHASE4_CONTRACTS.md` §4。模擬 E2E（`e2e/run.mjs`）で LINE Messaging API を mock に向けるための**試験専用**の環境変数。追加のみで、既存の挙動は変えていない。

| 変数 | 既定 | 意味 |
|---|---|---|
| `CARE_DSH_IM_LINE_API_BASE` | 未設定（= 効果なし、`https://api.line.me`） | LINE チャネルの API base（`/v2/bot/info`・reply・push・loading と、`bot.bind-credentials` の資格情報検証）をこの URL に向ける |

- 受け付けるのは **http(s) の loopback オリジンだけ**（ホストが `127.0.0.1` / `localhost` / `[::1]`、資格情報・クエリ・フラグメントなし。パスは可、末尾 `/` は除去）。それ以外（外部ホスト・`10.x`・`127.0.0.1.evil.example`・`file:` 等）は **無視して警告を出し**、本物の `api.line.me` のまま動く（任意ホストへアクセストークンを送らせない）。
- 有効になったときは起動時に `[dsh-im:line] CARE_DSH_IM_LINE_API_BASE is set: … (test override)` を警告ログに出す。
- profile の `line.apiBaseUrl`（WS-K の既存キー）が設定されていればそちらが優先。本番では両方とも設定しない。

| ファイル | 変更 |
|---|---|
| `plugin-src/host/channels/line/index.mjs` | `LINE_API_BASE_ENV`・`lineApiBaseFromEnv()` を追加し、`createProductionController` で `config.apiBaseUrl` が無いときだけ使う |
| `test/care/line-api-base-env.test.mjs`（新規） | 未設定・loopback の受理・非 loopback 等の拒否（3 件） |
| `lib/index.js` | `node plugin-src/host/build.mjs` で再生成（変更前のソースで再ビルドすると既存の `lib/index.js` とバイト一致することを確認済み。差分は上記と minify 名の付け替えのみ） |

テスト（2026-10-25、Windows）：`npm run test:care` 73 件全件成功（新規 3 件）。`e2e/run.mjs` で DSH 実プロセス上の動作（上書きの警告ログ、mock への bot info・reply・push）を確認。

## 共用ボット：同じ窓口内のアプリケーション切り替え（Stage 2 B2-wechat）

`docs/design/BRIDGE_ARCHITECTURE.md` §15・`docs/design/BRIDGE_STAGE2_PLAN.md` の B2-wechat。個人 WeChat（iLink）は 1 つの微信アカウントに 1 ボットしか持てないので、1 つのボットに複数の業務アプリケーションを載せ、**アプリケーションごとに別の DSH Session** にする。どのボットが共用か・どのアプリケーションを載せるかは DSH 側（`@dsh-bridge/dsh-core` の登録簿の `multiApp: true`、care-identity の会話ルーター）が決める。fork は「アプリケーション ID を運ぶ」だけで、ルーター未登録なら挙動は従来と同じ。

- `ctx.dshIm.setConversationRouter(router)`（上の公開 API 表）。入站 gate の**最初**に `route({ source, text, replyTo })` を呼び、返った `applicationId` を ImSource に載せる（`normalizeImSource` は形式の正しい `applicationId` だけ残す）。claims・access resolver・agent ターン・`sourceForTurn()`・`dsh-im/inbound` は全部この source を見る。ルーター例外・タイムアウト（5 秒）は「割り当てなし」（従来どおり）。
- weixin bridge：`replyTo`（iLink の引用 `ref_msg`、引用本文が無ければ送信記録から復元）をルーターに渡す。会話鍵は `scopedConversationKey(p2p:<user>, source)` = `p2p:<user>:app:<applicationId>` → (アプリケーション, ボット, 会話) ごとの Session。`/new` などの会話コマンドも今のアプリケーションの Session に効く。`:` を含むので配信先の候補（`deliverySuggestionFromConversationKey`）には解釈されない（共用ボットのアプリ別 Session は Session 同期の対象外）。
- 返信：agent の回答・claims の返信・拒否の返信は `decorateReply(source, text)`（care-identity は【アプリ名】を付ける）。
- 通知：`send(..., { applicationId })` と `sendCard({ applicationId })` の textFallback は `decorateOutbound` を通る（【アプリ名】と、通知への返信の結び付けのための記録）。`applicationId` はチャネルには渡さない。
- 他のチャネル（企業微信自建アプリ・Slack・LINE・Teams 等）は 1 アプリケーション 1 ボット：ルーターは `null` を返し、鍵・来源・返信は従来どおり（登録簿は `weixin` 以外の `multiApp` を起動時に拒否する）。

### e2e 用の iLink base 上書き

| 変数 | 既定 | 意味 |
|---|---|---|
| `CARE_DSH_IM_WEIXIN_API_BASE` | 未設定（= 効果なし） | 個人 WeChat の iLink 呼び出し（扫码・`getupdates`・`sendmessage` 等）をこの loopback オリジンの mock に向ける（`e2e/multi-app.mjs`） |

- 受け付けるのは **http(s) の loopback オリジンだけ**（`127.0.0.1` / `localhost` / `[::1]`、資格情報・クエリ・フラグメントなし）。それ以外は無視して警告し、信頼する host は本物の `*.weixin.qq.com` / `*.wechat.com` のまま。有効時は `[dsh-im:weixin] CARE_DSH_IM_WEIXIN_API_BASE is set: … (test override)` を警告ログに出す。本番では設定しない。

### 変更ファイル（B2-wechat）

| ファイル | 変更 |
|---|---|
| `src/channels/shared/im-extensions.mjs` | `setConversationRouter` / `routeSource` / `decorateReply` / `decorateOutbound` / `hasConversationRouter`、`scopedConversationKey`、ImSource の `applicationId`、gate の `replyTo` と routed source（`proceed(decision, source)`）、sendCard の textFallback の decorate |
| `src/channels/weixin/weixin-bridge.mjs` | 引用をルーターへ、routed source の会話鍵（`scopedConversationKey`）、回答の `decorateReply` |
| `src/channels/weixin/weixin-api.mjs` / `weixin-controller.mjs` | `CARE_DSH_IM_WEIXIN_API_BASE`（`weixinTestApiBase` / `weixinQrBaseUrl`） |
| `plugin-src/host/care-extensions.mjs` / `index.mjs` | `send` の `applicationId`（decorate してから除く）、`ctx.dshIm.setConversationRouter` |
| `test/care/shared-bot.test.mjs`（新規） | 6 件：applicationId の正規化と鍵、共用ボットでアプリ別 Session・【】・引用、claims / 拒否の返信と失敗時の既定、企業微信（ルーター null で不変）、send / sendCard の decorate、iLink base の上書き |
| `lib/index.js` | `npm run build` で再生成（`lib/client.js` は不変） |

テスト（2026-10-27、Windows）：`npm run test:care` 83 件全件成功（新規 6 件）、`npm test` 4699 件中 失敗 0・skip 17、`node scripts/verify-package.mjs` 成功。`e2e/multi-app.mjs`（DSH 実プロセス、mock iLink・mock 企業微信）で確認。

## 飛書以外の全プラットフォーム対応（WS P2）

利用者決定：**飛書（Feishu/Lark）以外の dsh-im の全チャネル**で care 連携（入站 gate・連携コード・proactive 通知・カード）が動くこと。読み取り監査で見つかった不足を最小変更で埋めた。既存チャネルの上游挙動は、下に明記したもの以外変えていない。

### 変更点

1. **Discord：ユーザー宛て proactive**。配信先 kind に `user`（route `{ userId }`、snowflake のみ）を追加。runtime は `POST /users/@me/channels`（`DiscordApi.createDirectMessageChannel`）で DM チャンネルを開き（bot ごとに userId→channelId を最大 1,000 件キャッシュ）、そこへ送る。`fallbackDraftTarget('discord', { userId })` = `{ kind: 'user', route: { userId } }`（`conversationId` 指定時は従来どおり `channel`）。これで `sendCard({ to: { userId } })`・`send(botId, { userId }, …)` が Discord DM に届く。
2. **`send(botId, { userId } | { conversationId }, text, opts)`**：sendCard の `to` と同じ形を受け付け、sendCard の textFallback と同じ規則（`fallbackDraftTarget`）でチャネルの配信先に変換して送る（保存済み配信先が無くても連携ユーザーへ送れる）。文字列の targetId・`{ kind, route }` は従来どおり（以前は `{ userId }` は `bad-request` だったので互換）。`idempotencyKey` の意味は同じ（`send:<botId>:<key>`、bot ごと）。
3. **textFallback カードの `updateCard` が同じユーザーへ届く**：`to.userId` 宛てに送った fallback カードの messageRef に `u: 1`（decode 後 `toUser: true`）を記録し、`updateCard` は `{ userId }` 宛てに新規送信する。以前は `{ conversationId: <userId> }` として送っていたため、DingTalk（`openConversationId`）・QQ（`groupOpenId`）・Matrix（room）・Discord（channel）ではユーザー ID を会話 ID と取り違えて届かなかった。
4. **iMessage：グループの判定**。`normalizeIMessage` は chat GUID の受信者記号が `+`（`iMessage;+;chat…` / `any;+;chat…`）なら `kind: 'group'`（1:1 は `…;-;<handle>`。`delivery-suggestions` と同じ規則）。以前は全会話が direct だったので、グループ内の「連携 123456」も DM として扱われ得た。**挙動変更**：グループ会話はアクセス設定の group scope で判定され、会話鍵が `group:<guid>` になる（既存のグループ会話は新しい Session になる）。`addressed` は従来どおり常に true（iMessage にメンションは無い）。
5. **iMessage：`to.userId` の送信先**。`MacOSMessagesApi.sendText` は chat GUID の最後の `;` 区切り（または `address`）を buddy として AppleScript で送るので、ImSource の `userId`（送信者ハンドル）をそのまま `chatGuid` にしてよい（`iMessage;-;<handle>` と同じ相手）。既存の対応をコードで確認したうえでコメントを付け、グループ GUID（`;+;`）宛ての fallback だけ `invalid-target` にした（buddy として送れず AppleScript エラーになるため）。
6. **企業微信 AI ボット（`wecom`）のネイティブカード**：既存のテンプレートカード送受信（`sendMessage(template_card)`・`event.template_card_event`）を使って card driver を登録。ボタン 1〜6 個のカード → `button_interaction`（`task_id = dshim_<cardId>`、ボタン key = action の index、7 日保存のカード記録で actionId・value に戻す）。押下は `onAction` に直接届く（resolver・agent・メニュー処理を通らない。`markSeen` で重複排除）。`respond(text)` は同じ会話へ markdown。ボタン 0 個（通知）と 7 個以上は markdown の textFallback。**カード本文（`sub_title_text`）には textFallback（返信コード）も残す**（実テナントでボタン押下の到達を確認していないため、文字返信の経路を残す）。`updateCard` は driver を持たず、新しい文字メッセージとして同じ相手へ（上記 3）。runtime 停止で driver は解除。

### 判断して変えなかったもの

- **Discord の ImSource に `teamId`（guild_id）は付けない**。care 側の身元キーは `platform|teamId|userId`（`packages/bridge-dsh/src/api-client.js`）で、連携コードは DM（guild なし）で受けるため、guild のメッセージに teamId を付けると同じ人が別の身元になる。Discord の user ID はグローバルに一意なので teamId は不要。
- **企業微信 AI ボットの `teamId`（corpId）は付けない**。AI ボットのコールバックに corpId が含まれず取得できない。仮に付けると既存の連携済みユーザーの身元キー（teamId なし）が変わる。
- **企業微信自建アプリ（`wecom-app`）・DingTalk のネイティブカードは未対応（textFallback ＋ 返信コードが正式な経路）**。wecom-app の受信は `subscribe`/`enter_chat` 以外のイベントを処理せず `template_card_event` の受け口が無い。DingTalk のカード（`dingtalk-card-stream.mjs`・メニューカード）はカードテンプレートと `outTrackId` に結び付いた既存メニュー用で、任意のボタンを持つカードを作る仕組みが無い。どちらも既存のコールバック基盤で onAction へ確実に渡せないため実装しなかった。
- **Email**：runtime の挙動は変えていない。**`From` は認証されていない**（SPF/DKIM/DMARC を検証しない。ImSource の `userId` は `From` のアドレスそのもの）ので、email の ImSource で本人確認・承認をしてはいけない。care 側（P1）は email を通知専用にする。

### プラットフォーム別の挙動（care 連携）

| platform | ImSource（userId / teamId / conversationId / kind） | 連携コード（DM のみ） | proactive `to.userId` → 配信先 | カード |
|---|---|---|---|---|
| `weixin` | wxid / — / wxid / direct | ✓ | `user` `{ toUserId }` | textFallback |
| `wecom`（AI ボット） | userid / — / userid か chatid / single→direct・group→group | ✓ | `user` `{ chatId: userid }` | **ネイティブ**（テンプレートカード、返信コード併記） |
| `wecom-app` | userid / — / userid / direct のみ | ✓ | `user` `{ chatId }` | textFallback |
| `dingtalk` | staffId / senderCorpId / staffId か cid / 1→direct・2→group | ✓ | `user` `{ userId: staffId }` | textFallback |
| `qq` | user_openid（グループは member_openid）/ appId / openid / c2c→direct・group→group | ✓ | `user` `{ userOpenId }` | textFallback |
| `whatsapp` | JID / — / JID / `@g.us`→group | ✓ | `user` `{ jid }`（`@s.whatsapp.net`/`@lid`） | textFallback |
| `matrix` | `@user:server` / — / room id / DM→direct | ✓ | `dm` `{ userId }`（runtime が DM room を解決） | textFallback |
| `discord` | user id / — / channel id / guild→group | ✓ | **`user` `{ userId }`（DM を開いて送る）** | textFallback |
| `imessage` | handle / — / chat GUID / **`;+;`→group** | ✓ | `user` `{ chatGuid: handle }` | textFallback |
| `email` | From アドレス（**未認証**）/ — / address / direct | （care 側で通知専用） | `user` `{ address }` | textFallback |
| `slack` / `telegram` / `line` / `teams` | 既存の節を参照 | ✓ | Slack は driver が DM を開く・Telegram は chat・LINE は push・Teams は会話参照 | ネイティブ |
| `feishu`（飛書・Lark 共通、WS P3） | open_id / tenant_key / chat_id / p2p→direct・それ以外→group | ✓ | `user` `{ openId }`（receive_id_type `open_id`） | **ネイティブ**（interactive カード 2.0、返信コード併記） |

- 1 つの DSH に同じプラットフォームの bot を複数置ける：ImSource・冪等キー（`send:<botId>:…`・`card:<key>`）・card driver・Discord の DM キャッシュはすべて bot（安定した `botId`）単位。
- 入站の判定順序は全チャネル共通：会話ルーター → claimReplies → accessResolver → チャネルのアクセス設定 → agent（`test/care/platforms-care.test.mjs` で各チャネルを確認）。

### 既知の制限（プラットフォーム別）

- **WeChat（個人、iLink）**：proactive 送信はそのユーザーから最後に受けた `context_token` を使う。iLink が受け付けるのは相手の最後の発言から一定時間（一般に 24 時間とされる。**未検証**）以内で、それを過ぎた通知は届かない可能性がある。
- **Teams**：proactive は相手が先に bot と 1:1 で話して会話参照がある場合だけ（Graph による事前インストールは未対応）。
- **LINE**：push はプランの月間メッセージ数上限に数えられる（上限超過は 429）。reply token が使えるときは reply を使う。
- **QQ**：c2c / グループへの能動メッセージは QQ 開放平台の配信ポリシー（回数・期間・審査）に従う。**fork では未検証**。グループの送信者 ID は `member_openid` で、c2c の `user_openid` とは別の値になる（DM で連携した人をグループで同一人物と判定できない）。
- **企業微信 AI ボット**：能動送信とテンプレートカードのボタン押下の到達は**実テナントで未検証**（モックのみ）。ボタン押下後のカード更新（`update_template_card`）はしない（押下は `respond` の文字返信で応答）。`sub_title_text` は 500 文字で切る（企業微信の推奨長はもっと短い）。ボタンの style は primary=1・その他=2（danger の赤は付けない）。
- **企業微信自建アプリ**：能動送信はアプリの可視範囲のユーザーだけ。カードは文字のみ。
- **DingTalk**：ユーザー宛ては `robotCode` の単聊送信。カードは文字のみ。
- **Discord**：DM は bot と相手が少なくとも 1 つのサーバー（guild）を共有し、相手がサーバーメンバーからの DM を許可している場合だけ送れる（拒否は Discord エラー 50007 → `delivery-failed`）。グループの判定は既存の制限（上記「Discord グループ」）のまま。
- **iMessage**：「ゲートウェイ」は DSH を動かす **macOS 上の Messages.app**（`chat.db` の読み取り＝フルディスクアクセス、AppleScript の自動化許可が必要）。Windows / Linux の DSH では動かない。グループへの送信は上游どおり buddy 宛てなので、グループでの返信は送信者への 1:1 になる。グループ GUID 宛ての proactive は `invalid-target`。
- **WhatsApp**：Web の関連付けデバイスとして動くので、アカウントが切断・ログアウトされると届かない。ユーザー ID は JID（`@lid` の場合あり）。
- **Matrix**：DM room が無い相手には runtime が DM room を作る。
- **Email**：`From` は未認証（上記）。

### 追加・変更ファイル（WS P2）

| ファイル | 変更 |
|---|---|
| `src/channels/discord/discord-api.mjs` | `createDirectMessageChannel({ userId })`（`POST users/@me/channels`） |
| `src/channels/discord/discord-runtime.mjs` | `sendProactiveText` の kind `user`（DM チャンネルを開いてキャッシュ） |
| `plugin-src/host/delivery-adapter.mjs` | Discord の配信先 kind `user`（route `{ userId }`、snowflake 検査） |
| `plugin-src/host/care-extensions.mjs` | `fallbackDraftTarget`（Discord user、iMessage グループ GUID の拒否）、`send` の `{ userId }` / `{ conversationId }` |
| `src/channels/shared/im-card.mjs`・`im-extensions.mjs` | messageRef の `toUser`、fallback の `updateCard` をユーザー宛てに |
| `src/channels/imessage/imessage-api.mjs` | `;+;` の chat GUID を `kind: 'group'` に |
| `src/channels/wecom/wecom-cards.mjs` | `wecomCareCard`（button_interaction）、`WECOM_CARE_TASK_PREFIX`・`WECOM_CARE_BUTTON_LIMIT` |
| `src/channels/wecom/wecom-bridge.mjs` | `sendCareCard`、`template_card_event` の `dshim_` → onAction |
| `src/channels/wecom/wecom-runtime.mjs` | card driver の登録・解除（`extensions` 注入可） |
| `test/care/platforms-care.test.mjs`（新規） | WeCom AI ボット・DingTalk・QQ・WhatsApp・Matrix・Discord・iMessage：ルーター → claims → resolver → agent の順序、連携コードは DM のみ（グループの同じ文は resolver へ）、ImSource の形（7 件） |
| `test/care/proactive-care.test.mjs`（新規） | `send({ userId }, { idempotencyKey })` の配信先と重複排除（同じプラットフォームの 2 bot を含む）、sendCard の textFallback（返信コード）と `updateCard` の宛先、Discord API / runtime の DM、iMessage の buddy、WeCom のテンプレートカードとボタン → onAction（resolver・agent を通らない）（7 件） |
| `test/care/im-extensions.test.mjs` | fallback の messageRef に `toUser`、update は `{ userId }` 宛て（上記 3 への追従） |
| `lib/index.js` | `npm run build` で再生成（`lib/client.js` は不変） |

テスト（2026-10-27、Windows 11 / Node 24）：`npm run test:care` **97 件全件成功**（新規 14 件）、`npm test` **4713 件中 失敗 0・skip 17**、`node scripts/verify-package.mjs` 成功。すべてモック（実ネットワーク・実アカウントなし）。

未検証（実プラットフォームでの確認が必要）：企業微信 AI ボットのテンプレートカード送信とボタン押下の到達・`sub_title_text` の長さ制限、Discord DM の作成（相手のプライバシー設定・共有サーバー）、iMessage の実 macOS での buddy 宛て送信とグループ GUID の形式、QQ・企業微信・WeChat の能動送信ポリシー。

## 飛書 / Lark 対応（WS P3）

利用者決定：**飛書（Feishu）と Lark も、他のプラットフォームと同じように** care 連携（入站 gate・連携コード・ターン来源・proactive 通知・カード）が動くこと。WS P2 と同じ方針（最小変更、上游の挙動は下に明記したもの以外変えない）。

### 身元の決定（ImSource）

| 項目 | 値 | 理由 |
|---|---|---|
| platform | **`feishu`**（Lark も同じ） | コード上の違いは SDK の接続先（`domain: 'lark'` → `Domain.Lark`）だけで、イベント形・ID 体系・配信 API は同一。Lark と飛書はテナントが別なので tenant（teamId）で区別される。配信チャネル名・`listBots()` の `channel` も `feishu` のまま |
| userId | **open_id**（`sender.sender_id.open_id`、ボタンは `operator.open_id`） | 全イベントに必ず含まれ、追加の権限が要らない。配信 route（`{ openId }`、`receive_id_type: open_id`）と同じ値なので連携した人へそのまま送れる。user_id は `contact:user.employee_id:readonly` が無いと欠け、union_id は配信に使えない。**open_id はアプリ（bot）ごとに別の値**（下記制限） |
| teamId | tenant_key（SDK が展開した v2 header の `tenant_key`、無ければ `sender` / `operator` の `tenant_key`） | アプリが入っているテナント。同じテナントの人はどのイベントでも同じ値 |
| botId | multi-bot controller の `config.id`（App ID ごとに固定、`bindCredentials` で同じ App ID なら再利用） | 1 アプリ = 1 窓口 = 1 botId |
| conversationId | `message.chat_id`（DM も p2p chat の `oc_…`） | そのまま送信先（`receive_id_type: chat_id`）に使える |
| conversationKind | `chat_type === 'p2p'` → direct、それ以外 → group | 連携コードは direct だけで受ける（care 側の matcher）。不明な種類は安全側の group |
| messageId / threadId / at | `message_id` / `thread_id` / `create_time`（ms） | ボタンは `event_id`（無ければ `open_message_id`） |

### 変更点

1. **入站 gate**（`bridge.mjs` の `#accept`）：テキストが agent に届く経路は、長連接の `im.message.receive_v1` → `FeishuHarnessBridge.accept()` の 1 つだけ（コマンド・バッチ `/send`・メニュー番号・音声・busy 時の steer もすべてここを通る）。上游の受理処理は `#acceptMessage` に名前を変えて残し、その前に **会話ルーター → claimReplies → accessResolver** を置いた（`imExtensions.gate`、会話ごとに直列化。ボット送信者・旧 allowlist・群の @ 必須モード・既読のフィルタは上游と同じ順で先に適用）。claims / deny されたメッセージは既読にして終了（agent・Session に入らない）。claims / deny の返信は元メッセージへの reply。
2. **resolver の判定が「閉」の規則を置き換える**：gate の `resolverVerdict: 'allow'` を `evaluateInboundAccess` に渡す（受理時と、音声を文字起こしした後のコマンド権限の再判定の両方）。allowlist・owner に居なくても通り、コマンド権限は設定画面のまま（他チャネルと同じ）。resolver 未設定なら従来どおり既定「閉」（owner・allowlist のみ）。
3. **ターン来源**：`askInWorkspaceSession` の 4 か所（step push・ストリームなし・ネイティブストリーム・ストリーム失敗時のテキスト）すべてに `imSource` を渡す。`sourceForTurn()` と `dsh-im/inbound` が飛書でも出る。gate を通った source（ルーターの applicationId 付き）を messageId ごとに保持（最大 500）して使う。
4. **カード引用の除去**：`parent_id` / `root_id` が hub の送ったカード（messageId 一致）なら、その参照を外してから処理する（引用されたカード本文・返信コードがプロンプトに入らない）。
5. **ネイティブ interactive カード**（`feishu-runtime.mjs` が接続完了時に bot ごとに driver を登録、停止で解除）：
   - `sendCard`：`to.userId` → `receive_id_type: open_id`、`to.conversationId` → `chat_id`。カードは schema 2.0（`config.update_multi: true`、header に title、fields・body・footer は **plain_text のみ**＝lark_md を解釈させない、ボタンは `behaviors: [{ type: 'callback', value: { dshim: 'dc:<cardId>:<index>' } }]`、link は `open_url`）。style は primary / danger / default。**textFallback（返信コード）もカード内に残す**（アプリが `card.action.trigger` を購読していない・未修復でも文字返信で操作できるように）。
   - ボタン押下（長連接の `card.action.trigger`）：`value.dshim` を持つものだけ `onCardAction` の先頭で横取りし、7 日保存のカード記録（`resolveCardAction`）で actionId・value に戻して **`onAction` に直接**渡す（resolver・チャネルのアクセス設定・メニュー処理・agent を通らない。Slack / LINE / Teams / 企業微信と同じ写像）。記録に無い参照・別 bot のカードは無視、同じ `event_id` の再配信は 1 回だけ。`respond(text)` は押されたカードへの reply。source の `conversationKind` は送信時の記録（`to.userId` → direct、`to.conversationId` → group）。
   - `updateCard`：`PATCH im/v1/messages/:message_id` で差し替え（新しいボタンの写像も登録）。飛書が拒否したら（古すぎる・撤回済み等）同じ会話（chat_id）へ新しいカードを送る。hub は driver が返した新しい messageId もカード記録に残す。
   - external-consumer モード（`consumeInbound` で他プラグインが受信を独占）の bot には driver を登録しない（そのモードでは `card.action.trigger` を誰も受けないため）。カードは textFallback。
6. **proactive 送信**：配信先 `{ kind: 'user', route: { openId } }`（`receive_id_type: open_id`）と `fallbackDraftTarget('feishu', { userId })` は既存のものがそのまま使えたので delivery-adapter は変更なし。`send(botId, { userId }, text, { idempotencyKey })` と sendCard の textFallback（driver 未接続時）は open_id へ届く。冪等キーは `send:<botId>:<key>`（bot ごと）。
7. **複数アプリ**：runtime・bridge・Lark SDK client・card driver・gate の直列化キー・カード記録はすべて botId 単位。別アプリのカードのボタンが別の接続に届いても無視する。

### 判断して変えなかったもの

- **external-consumer モードの受信には gate を掛けない**：そのモードでは dsh-im の agent に届かず、受信を独占したプラグインがアクセス判定に責任を持つ（care からは使っていない）。
- **Harness の承認・質問カード（`approve:` / `reject:` / `answer:` ボタン）は従来どおりチャネルのアクセス設定で判定**（resolver を見ない。他チャネルの承認ボタンも同じ）。resolver だけで許可された人は文字返信で答えられる（文字は gate を通る）。
- `userName` は付けない（`im.message.receive_v1` に送信者名が無い）。
- HTTP webhook 受信は fork に無い（長連接のみ）。

### 既知の制限（飛書 / Lark）

- **open_id はアプリごとに別の値**：同じ人でもアプリ A と B では別の身元（別々に連携が必要）。通知は**その人が連携したアプリ（bot）から**送ること（別アプリの open_id を使うと飛書がエラー）。これは「1 アプリ = 1 窓口」の前提どおり。
- 実プラットフォームで**未検証**（モックのみ）：care カード（plain_text のみの 2.0 カード・`open_url` ボタン・`update_multi`）の表示、care カードのボタン押下の `card.action.trigger` 到達（アプリにコールバック購読が必要。`/repair` で追加）、care カードの `message.patch`（飛書の編集可能期間・回数の上限）、`tenant_key` がすべてのイベントに入っていること、Lark（国際版）での同じ挙動。
- ボタンの「DM / グループ」の別は送信時の記録で、`updateCard` の写像はプロセス内メモリ（再起動後の更新カードは `to.userId` かどうかで判断、それ以外は group 扱い）。`to.conversationId` に DM の chat_id を渡したカードも group 扱い（安全側。onAction の認可は userId で行う）。
- グループに送ったカードは他の参加者も押せる（onAction ハンドラが押した人の userId で認可すること）。承認カードは `to.userId` で DM に送る。
- 既定「閉」での busy 時の steer、Telegram 等と同じ `sourceForTurn` の同時実行の制限は共通の節のとおり。

### 追加・変更ファイル（WS P3）

| ファイル | 変更 |
|---|---|
| `src/channels/feishu/bridge.mjs` | `imSourceFor()`、gate 付き `#accept`（上游の処理は `#acceptMessage`）、`resolverVerdict`（受理時・音声の再判定）、4 か所の `askInWorkspaceSession` に `imSource`、カード引用の除去、`sendCareCard` / `updateCareCard`、`card.action.trigger` の `dshim` → onAction（`extensions` 注入可） |
| `src/channels/feishu/feishu-runtime.mjs` | bridge へ `extensions`、接続完了時に card driver を登録・停止で解除 |
| `src/channels/feishu/feishu-cards.mjs` | `feishuCareCard`（schema 2.0、plain_text、callback / open_url ボタン）、`FEISHU_CARE_ACTION_KEY` |
| `src/channels/shared/im-extensions.mjs` | `resolveCardAction` が記録の `conversationKind` を返す、driver の `updateCard` が返した messageId をカード記録に残す（他の driver は何も返さないので不変） |
| `test/care/feishu-care.test.mjs`（新規） | 8 件：ルーター → claims → resolver → agent の順序・連携コードは DM のみ・ImSource の形・ターン来源と `dsh-im/inbound`、遅い resolver でも会話内の順序を保つ、resolver の allow / deny が既定「閉」を置き換える（コマンド権限は設定どおり）、カード引用の除去、カード driver（描画・open_id 宛て・冪等・ボタン → onAction で resolver を通らない・再配信と偽参照の無視・patch・patch 拒否時の再送・停止で解除）、2 アプリ（飛書と Lark ドメイン）の分離、`send({ userId })` の open_id route と bot ごとの冪等・textFallback、描画が plain_text のみ |
| `lib/index.js` | `npm run build` で再生成（`lib/client.js` は不変） |

テスト（2026-10-27、Windows 11 / Node 24）：`npm run test:care` **105 件全件成功**（新規 8 件）、`npm test` **4721 件中 失敗 0・skip 17**、`node scripts/verify-package.mjs` 成功。既存の `test/channels/feishu/*` 834 件も全件成功（変更なし）。すべてモック（実ネットワーク・実アカウントなし）。

## 新規作成のみ（createOnly、S1 2026-10-28）

care-ai-native `docs/design/IM_PERSONAL_BOTS.md` §3・§5。botId はプラットフォームの ID から決まるため、既存のボットと同じ認証情報で作成を呼ぶと、そのボットが上書きされる（上游どおり）。個人ボットの画面（care-web BFF `/api/me/im/rpc/<channel>`）は作成を必ず `createOnly: true` で呼び、既存のボット（組織ボット・他人の個人ボット）を奪えないようにする。

### 契約

- ペイロードのキー `createOnly`（省略可。指定するなら boolean。`true` のときだけ挙動が変わる。boolean 以外は `bad-request`）：
  - `bot.bind-credentials`：`/telegram`・`/discord`（`shared/rpc.mjs`）、`/slack`、`/line`・`/teams`（`shared/webhook-rpc.mjs`）、`/matrix`、`/wecom`、`/qq`、`/dingtalk`、`/feishu`
  - `bot.bind`：`/wecom-app`
  - `provision.begin`：`/weixin`、`/whatsapp`、`/wecom`、`/qq`、`/dingtalk`、`/feishu`（attempt の記録に残す）
- `createOnly: true` で、導出したボットの身元が既にあるとき（各 controller が使う照合：`getByPlatformId`・`get(botId)`・`getByAccountId`・`getByCorpAgent`・`getByRemoteBotId`・`getByAppId`・`getByClientId`、飛書は appId の一致）は**何も変えない**（認証情報の書き込み・設定の保存・runtime の起動をしない）：
  - 作成 RPC：`{ ok: false, error: { code: 'bot-exists', message: t('该账号已接入为机器人，未作任何更改。'), details: {} } }`。`diagnosticRpcResult` は cause の code が `bot-exists` ならそのまま返す（`<channel>-operation-failed` に変えない）。Matrix は `operationError` で同じ形。
  - QR：attempt は `status: 'failed'`・`error.code: 'bot-exists'` で終わる（`provision.poll` / `provision.verify` の結果に出る。`botId` は付けない＝既存のボットの ID を教えない）。WeChat の `binded_redirect`（上游は既存のボットのどれかを `alreadyConnected` で返す）も、`createOnly` なら同じ失敗。WhatsApp は新しい linked-device の認証フォルダを消し、既存のボットの session はそのまま。飛書は登録の `error`（`registration.error.code`）が `bot-exists`、`provision.poll` の値に `error: { code, message }` を足す（この場合だけ）。
- `createOnly` が無い・`false` のときは上游と同じ（再接続・上書き）。RPC からの controller 呼び出しも、キーが無ければ従来と同じ引数。
- 接続できた QR の `provision.poll`（WeChat は `provision.verify` も）の結果には `botId` が付く：WeChat・WhatsApp・企業微信・QQ・DingTalk は `publicAttempt` の `botId`、飛書は poll の値の `botId`（いずれも上游どおり。変更なし）。
- 文言：`src/channels/shared/i18n-{en,ru}/webhook.mjs` に 1 文追加。dsh-lang-ja は care-web がコードで写像するので未追加。

### 既知の制限

- 企業微信・QQ・DingTalk の `bot.bind-credentials` は、上游どおり実行中の QR attempt を先に取り消す（`createOnly` でも同じ。ボットの設定は変えない）。
- 判定は「保存済みの設定があるか」。設定ファイルを消して認証情報だけ残った状態は「無い」と判定する（上游の再作成と同じ）。
- 飛書の QR 登録は上游でも毎回新しいアプリを作る（`createOnly: true` を飛書の登録 API に渡している）ので、既存の appId に当たるのは実質、手動の bind だけ。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `src/channels/shared/create-only.mjs`（新規） | `BOT_EXISTS`・`BOT_EXISTS_MESSAGE`・`validCreateOnly`・`assertCreatable`・`botExistsError`・`botExistsPublicError`・`botExistsResult` |
| `src/channels/shared/connection-error.mjs` | `diagnosticRpcResult` が `bot-exists` をそのまま返す |
| `src/channels/shared/{token-bot-controller,webhook-bot-controller}.mjs`、`src/channels/{slack/slack-controller,matrix/matrix-controller,wecom-app/wecom-app-controller}.mjs` | bind の `createOnly` |
| `src/channels/{wecom/wecom-controller,qq/qq-controller,dingtalk/dingtalk-controller}.mjs` | bind と QR（`startProvisioning({ createOnly })`、活性化の前に判定、attempt を `bot-exists` で失敗） |
| `src/channels/weixin/weixin-controller.mjs`、`src/channels/whatsapp/whatsapp-controller.mjs` | QR（`binded_redirect` を含む） |
| `src/channels/feishu/{multi-bot-controller,registration-manager}.mjs` | bind と QR 登録（`startRegistration({ createOnly })`、`onCredentials` の `bot-exists` を登録の error に残す） |
| `plugin-src/host/channels/{shared/rpc,shared/webhook-rpc,slack,matrix,wecom-app,wecom,qq,dingtalk,weixin,whatsapp,feishu}/rpc.mjs` | ペイロード検証に `createOnly`、controller へ渡す（キーが無ければ従来の呼び出し）、飛書の公開エラー表と poll の `error` |
| `src/channels/shared/i18n-{en,ru}/webhook.mjs` | 文言 1 件 |
| `test/care/create-only.test.mjs`（新規） | 13 件（下記） |
| `lib/index.js`・`lib/client.js` | `npm run build` で再生成（`lib/client.js` の差分は package.json の `files` が `FORK.md` になっていたのが未反映だった 1 行のみ） |

### テスト

`test/care/create-only.test.mjs`（モックのみ）：補助関数（boolean 検査・`diagnosticRpcResult` の素通し）、Telegram（2 回目の作成が `bot-exists`・設定と認証情報と runtime が不変・boolean 以外は `bad-request`・キー無し／`false` は上書き）、Slack、LINE、Matrix、企業微信 自建アプリ（`bot.bind`）、企業微信（bind と QR）、QQ（bind）、DingTalk（bind と QR）、飛書（bind と QR 登録、既存ボットの owner も増えない）、WeChat（既存アカウントの QR・`binded_redirect`。キー無しは上游どおり）、WhatsApp（QR。新しい認証フォルダだけ消す、`connection.status` は従来どおりキー不可）。

テスト（2026-10-28、Windows 11 / Node 24）：`npm run test:care` **118 件全件成功**（新規 13 件。前回 105 件）、`npm test` **4734 件中 失敗 0・skip 17**（前回 4721 件）、`node scripts/verify-package.mjs` 成功。すべてモック（実ネットワーク・実アカウントなし）。

## 本人モード（hiddenSettings、S1 2026-10-28）

care-ai-native `docs/design/IM_PERSONAL_BOTS.md` §2・§5。業務 Web の「SNS 連携」で、職員が自分のボットを DSH-IM の設定画面の部品で設定するとき（web-kit `ImBotsShell` `mode="personal"`）、本人が変えられない部分を出さない。**守りは業務 Web の BFF**（許可リスト・持ち主の確認・応答の絞り込み）で、ここは表示の整理だけ。DSH 本体の設定画面は `hiddenSettings` を渡さないので、見た目・挙動は従来どおり。

- `BotSettingsContext`（`plugin-src/client/bot-settings-context.js` に移動。`channel-card-meta.js` は同じ物を re-export）の値に任意の `hiddenSettings: string[]`。
- 名前と対象：`advanced`（`BotSettingsButton`＝「更多设置」）、`workspace`（`WorkspaceEditor`）、`model`（`ModelEditor`）、`agentPreset`（`AgentPresetEditor`）、`contextEnhancement`（`ContextEnhancementEditor`）、`appSettings`（企業微信 自建アプリの代理地址・公网回调基址：カードの設定欄と接続フォームの 2 項目）、`callbackSecretReset`（同「重置密钥」）。
- 実装：各エディタは `hideable(name, Panel)` で包んだ（中身は従来の関数のまま、名前だけ `…Panel`）。`useSettingHidden(name)` を export。
- テスト：`test/care/personal-mode.test.mjs`（4 件。Telegram のカードで「更多设置」・作業フォルダ・プリセット・文脈強化・モデルが消え、別名・再接続・削除は残る／指定した部分だけ消える、企業微信 自建アプリのカードで代理・回调基址の欄と「重置密钥」が消え、回调 URL は残る、`BotSettingsButton`・`hideable`・`useSettingHidden`）。

| ファイル | 内容 |
|---|---|
| `plugin-src/client/bot-settings-context.js`（新規） | `BotSettingsContext`・`useSettingHidden`・`hideable` |
| `plugin-src/client/channel-card-meta.js` | context の re-export、`BotSettingsButton` の `advanced` |
| `plugin-src/client/{workspace-editor,model-setting,agent-preset,context-enhancement}.js` | 各エディタを `hideable` で包む |
| `plugin-src/client/channels/wecom-app/index.js` | `AppSettingsEditor`（`appSettings`）、接続フォームの代理・回调基址（`appSettings`）、「重置密钥」（`callbackSecretReset`） |
| `test/care/personal-mode.test.mjs`（新規） | 上記 |
| `lib/client.js` | `npm run build` で再生成 |

テスト（2026-10-28、Windows 11 / Node 24、createOnly と本人モードの後）：`npm run test:care` **122 件全件成功**（本人モード 4 件を足して 118 → 122）、`npm test` **4738 件中 失敗 0・skip 17**。`lib/` は `npm run build` 済み。

## 答えの絞り込みと未連携の発信者の文（H1 2026-10-29）

care-ai-native `docs/design/SNS_HELP_QA.md` §4.3・D1。SNS でシステムの使い方を聞かれたとき、AI の答えのリンクを業務システムの画面だけにし（bridge-identity のリンクの検査）、未連携の発信者には AI を使わずに公開の節で答える（bridge-identity の publicHelp）ための口。何も登録しなければ従来どおり。

- `setAnswerFilter(filter)`（`ctx.dshIm` にも公開。**2026-11-15 まで実際には公開されていなかった**。下の「ctx.dshIm に setAnswerFilter が無かった」）：IM のターン（信頼できる発信元のあるターン）の最終の答えを、チャネルが送る前に `filter({ sessionId, source, text })` に通す（登録順。文字列以外を返す・例外・時間切れは元の文のまま、ログに残す）。`hasAnswerFilter()`・`filterAnswer()`。適用は `askInWorkspaceSession`（Web UI・コマンドのターン、時間切れの後の遅延配信は対象外）。
- 接入の判定器（`setAccessResolver`）は第 2 引数に `{ text }`（前後の空白を除いたメッセージ）を受け取る。従来の 1 引数の判定器はそのまま動く。

| ファイル | 内容 |
|---|---|
| `src/channels/shared/im-extensions.mjs` | `setAnswerFilter`・`hasAnswerFilter`・`filterAnswer`・`reset` で消す、`resolveAccess(source, { text })`・`decideRouted` が文を渡す |
| `src/channels/shared/workspace-session.mjs` | IM のターンの答えを `filterAnswer` に通す |
| `plugin-src/host/care-extensions.mjs` | `ctx.dshIm.setAnswerFilter` |
| `test/care/answer-filter.test.mjs`（新規） | 3 件（IM のターンだけ・順番と失敗時・判定器の文） |
| `lib/index.js` | `npm run build` で再生成（`lib/client.js` は不変） |

## Lark で QR 作成（2026-11-01）

飛書の QR（`accounts.feishu.cn` で始めた登録）を Lark（国際版）の携帯アプリで読むと、Lark 側でアプリは作成・公開されるが、資格情報を device code に返す最後の段階で「Couldn't create app」になる。Lark の accounts ホスト（`accounts.larksuite.com`、日本リージョンの `passport-jp.larksuite.com`）で始めた QR は、開いた時点の `app_registration/ack` が 400 で「Link expired」。どちらも Lark 日本リージョンの租户（2026-11-01、株式会社アイテーシー）で再現し、別の租户では上游のままの流れ（飛書で始めて `domain_switched` で Lark へ）が成功していた。原因は Lark 側（租户・リージョン）で、こちらのコードでは直せない。

- Host（RPC）：`provision.begin` が `domain: 'feishu' | 'lark'`（省略は `feishu`、他の値は bad-request）を受ける。`lark` なら `registerApp` に `domain: 'accounts.larksuite.com'` を渡す。登録の結果に `tenant_brand` が無いときは、始めたドメインをボットの `domain` にする。設定画面からは使っていない（一度入れた QR の切り替えボタンは、上の租户で効かなかったので外した）。
- 設定画面は上游のまま。Lark の日本リージョンのように QR が使えない租户には、次の節の `feishuQr` で手動の設定だけにする。

| ファイル | 内容 |
|---|---|
| `src/channels/feishu/multi-bot-controller.mjs` | `startRegistration({ createOnly, domain })`、`#acceptCredentials` のドメインの決め方 |
| `plugin-src/host/channels/feishu/rpc.mjs` | `provision.begin` の `domain` の検査と受け渡し |
| `test/care/feishu-lark-domain.test.mjs`（新規） | 5 件（Lark の開始ホスト・既定のまま・不正な値・`tenant_brand` 無し・飛書からの切り替え） |
| `lib/index.js` | `npm run build` で再生成 |

## QR の作成を隠す（feishuQr、2026-11-01）

ホストが `BotSettingsContext.hiddenSettings` に `feishuQr` を入れると、飛書 / Lark の設定画面から QR の経路を外す（ケアビリングは管理者の IM ボット接続・本人の SNS 連携の両方で渡す。上の節の理由で日本の Lark では QR の作成が完了しない）。

- 見出しの「扫码接入机器人」、ボットのカードの「补全权限」（権限の補全の QR）を出さない。
- ボットが無いとき、空の画面（「生成飞书二维码」）の代わりに手動の設定（App ID・App Secret）を開いた状態で出す。アプリのプラットフォームの既定は Lark（選び直せる）。
- Host に QR の試行が残っていても表示せず、手動の設定のボタンも押せるままにする（上游は QR の試行中は手動の設定を押せない）。
- 群メッセージの権限の QR（群の設定、「更多设置」の中）はそのまま。

| ファイル | 内容 |
|---|---|
| `plugin-src/client/channels/feishu/index.js` | `useSettingHidden("feishuQr")`：見出し・空の画面・カードの補全・QR の面・手動の設定の既定 |
| `plugin-src/client/bot-settings-context.js` | 名前の一覧に `feishuQr` |
| `test/care/feishu-qr-hidden.test.mjs`（新規） | 4 件（カード・見出し・ボット無しで手動が開く（Lark・残った QR を出さない）・指定なしは上游のまま） |
| `lib/client.js` | `npm run build` で再生成 |

## DSH 0.2.2-rc.1（2026-11-15）

- `package.json` の `dsh.compatibility.dsh` を `0.2.2-rc.1` に、`dshReleases` に `"0.2.2-rc.1": "compatible"` を追加（`0.2.0-rc.2` / `0.2.1-rc.2` は残す）。開発依存の `@deepseek-ai/cordis` を `4.1.0`（DSH 0.2.2-rc.1 の版）に。`npm run build` で `lib/`（package.json を内包）を再生成。実行時のコードは変更なし。
- DSH 0.2.2 は bundle の `engines.dsh` / dsh の peerDependencies で互換性を検査するが、この fork はどちらも持たないので検査の対象外（`dsh.compatibility` は DSH 本体は読まない）。
- 更新パネルの文言「dsh-im 5.0.0 仅支持 DSH 0.2.1-rc.2。」は上游の版ごとの互換表の 1 行（履歴）なので変えない。fork では自己更新は無効。
- `npm test` 4752 件中 失敗 0・skip 17（Windows 11 / Node 24）、`node scripts/verify-package.mjs` 成功。framework の `pnpm demo`（実 DSH 0.2.2-rc.1）15 / 15。

## ctx.dshIm に setAnswerFilter が無かった（修正 2026-11-15）

- 症状：`installCareExtensions()` は `setAnswerFilter` を返していたが、Host の `ctx.provide('dshIm', …)`（`plugin-src/host/index.mjs`）が一覧に入れていなかった。実 DSH では `ctx.dshIm.setAnswerFilter` が `undefined` で、**回答フィルターが一つも入らなかった**（bridge-identity の linkGuard、biz-ai-agent の引用チェック）。bridge-identity は info ログを出して答えをそのまま送っていた。H1（2026-10-29）から 11-15 まで。単体テストはどれも `imExtensions` か偽の `dshIm` を直接使っていたので気づかなかった。biz-ai-agent の実 DSH e2e（`0e9d18b`）で発見。
- 影響の範囲：AI の答えに含まれる URL の制限（業務 Web の `web.routes` の画面と `allowHosts` 以外を省く）が効いていなかった。**未連携の発信者の拒否（`setAccessResolver`）は公開されていて、影響なし**。
- 修正：`setAnswerFilter: care.setAnswerFilter` を `dshIm` に追加、`npm run build`（`lib/index.js` の 1 か所だけ変わる。`lib/client.js` は不変）。bridge-identity は関数が無いとき warn を出す（以前は info）。
- 再発防止：`test/care/host-service-surface.test.mjs`（新規 3 件）— `installCareExtensions()` が返す名前が**全部** `ctx.dshIm` にあること、`ctx.dshIm.setAnswerFilter` で入れたフィルターが IM のターンに効き dispose で外れること、**ビルド済みの `lib/index.js`**（DSH が実際に読むもの）の `dshIm` も全部の名前を持つこと（`npm run build` 忘れも落ちる）。framework の実 DSH e2e にシナリオ g（linkGuard が LINE への答えから外部リンクを省く）と、シナリオ a に「未連携の人が業務の質問をしても案内だけ（LLM・委任・業務データなし）」を追加。
- 修正前：新しいテスト 3 件とも失敗、framework の `pnpm demo` はシナリオ g が FAIL（外部リンクがそのまま LINE へ）。修正後：`npm test` 4755 件中 失敗 0・skip 17（Windows 11 / Node 24）、`pnpm demo`（実 DSH 0.2.2-rc.1）17 / 17。
