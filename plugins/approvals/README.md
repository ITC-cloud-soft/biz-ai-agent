# @dsh-bridge/plugin-approvals（DSH プラグイン `bridge-approvals`）

業務システムの承認依頼を IM に届け、ボタンまたは文字返信で決定する。承認の正本・権限・期限は業務システム。

## 流れ（経路はレジストリの `paths`。既定は Bridge v1）
1. `approval.requested`（bridge-events）→ ボットのあるプラットフォームだけを `platformPriority`（既定 `DEFAULT_PLATFORM_PRIORITY`、email は使わない）順に、
   最大 10 件を `POST /bridge/v1/approvals/{id}/deliveries {platforms}` に **1 回だけ**。業務システムが各承認者に連携済みの最優先のプラットフォームで delivery を 1 件発行。
   - 既存 delivery のプラットフォームがリストにあれば `reused`（再送しない）。リストから外れたプラットフォームの delivery は業務システムが無効にするので、旧カードを
     【ご報告】…（無効）に更新し、別のプラットフォームの新 delivery は `approval:<id>:<userId>:<deliveryId>` のキーで送り直す。
2. `ctx.dshIm.sendCard`（`idempotencyKey = approval:<id>:<userId>`、既定以外は `approval:<applicationId>:<id>:<userId>`）。送信ボットは承認者が
   連携に使ったボット（そのアプリケーションのもの）→ 設定 → レジストリ → listBots。ボタン actionId は `bridge_approval:approve|reject:<deliveryId>`
   （既定以外は `<applicationId>/<deliveryId>`）、value は deliveryId だけ。送付前に記録・索引する（直後のボタン操作でも引ける）。
3. ボタン（`onAction('bridge_approval:')`）→ `POST /bridge/v1/approvals/{id}/im-decision {token, action, comment?, source, channelMessageId}`。
   差戻の理由（B-028）：① カードの入力欄（差戻のボタンに `input`。Teams は Input.Text、Feishu / Lark は form）に書いた文
   （`e.inputText`）→ ② `openReasonDialog`（Slack のモーダル）→ ③ どちらも無い・空のときは、その人が同じ会話へ 10 分以内に送る
   **次の文**を理由として受け取る（「取消」でやめる。LINE など文字だけのチャネルもこれで番号なしに差戻しできる）。
   「差戻 123456 理由」の文字返信も使える（番号と理由の間の空白は無くてよい）。
4. 文字返信（`claimReplies`、語は `replyWords`、既定 承認 / 差戻、全角可）→ `POST /bridge/v1/approvals/im-decisions {replyCode, action, comment?, source}`。
   承認の特定と本人照合は業務システム。差戻で理由が無ければ送らずに案内。
5. 結果・エラーは日本語で返信（`identity_mismatch` / `invalid_reply_code`（残り回数）/ `role_not_permitted` / `self_approval_forbidden` / `delivery_locked` /
   `too_many_attempts` / `already_<status>` / `delivery_used` / `delivery_revoked` / `expired` / 到達不能など。`decisionErrorMessage`）。
6. 決定成功時と `approval.decided`（executed = 承認 / rejected / cancelled）・`approval.expired` で関連カードを全部 `updateCard`（ボタンを消し【ご報告】…（承認済み）など）。
   冪等。更新できない理由が分かるもの（WeChat のコンテキスト切れ・宛先不正）は理由を残して諦め、イベントの流れを止めない。一時的な失敗はイベントごと再試行。

## 分離と秘密
- card token と replyCode はプラグイン内部（DSH のストレージサービスの domain `bridge_approvals`）だけ。ボタン・カード本文・LLM 文脈に出さない。決定・取消・期限切れで消し、記録は 7 日で削除。
- token / 返信コードは**発行したアプリケーションにしか送らない**：ボタンはカードを送ったボットか同じアプリケーションのボットからだけ、返信コードは手元の記録で
  発行元を確かめ、別のアプリケーションのボットに送られたコードは送らずに断る（手元に無いコードは会話のアプリケーションへ）。
- deliveries は業務システム側で冪等（`reused: true` で同じ token）なので、ローカル状態を失っても再処理で復元できる。

## 文面（AI 秘書）
依頼カード：件名【承認のお願い】<何の承認か（業務システムのカード件名から「の承認依頼」を外したもの）>、本文はあいさつ・
▶ お願いしたいこと（期限は expiresAt があるときだけ）・ボタンの説明・業務システムの本文（「ご参考：…」。`showBusinessBody: false` で出さない）、
footer に返信コードの案内と署名「— <アプリ名> AI 秘書」（AI 社員の呼び名があれば「— <呼び名>（<アプリ名> AI 秘書）」。業務システムのプロフィール、bridge-persona）。項目（fields）とリンク（`webUrl` の `{id}`）は業務システム / 設定のもの。
業務システムはカードに任意の `wording`（`lead`・`ask`・`buttons.approve / reject`・`replies.approved / rejected`・
`statusBody.approved / rejected / expired / cancelled`。各 300 字まで、`cardWording`）を付けられ、その承認だけ、あいさつの後の一文・
お願いしたいこと・ボタンの説明・ボタン／返信の結果の返事・更新したカードの本文をその文にする（無い項目は既定の文。件名は変えない）。

## サービス
- 提供：`ctx.bridgeApprovals` — `ready`、`handleEvent(event)`、`status()`、`platformPriority()`。
- inject：`dshIm`（bridge fork：`sendCard` / `updateCard` / `onAction` / `claimReplies`）、`storageDomain`。任意：`bridgeApps`、`bridgeEvents`。

## 設定（Config）
`apiUrl` / `serviceToken` / `applicationName`（レジストリが無いとき）、`platformPriority`、`bots`（プラットフォーム → botId）、`webUrl`（`{id}` を承認 ID に置換）、
`showBusinessBody`（true）、`replyWords`（`{approve: [承認], reject: [差戻]}`。ボタンの表示名と返信コードの案内も同じ語）、
`applications.<id>`（`platformPriority` / `bots` / `webUrl` / `showBusinessBody`）。
`messages`（業務システムのエラーコード → 返事の文。例 `identity_not_linked: …業務Webの「設定」画面で連携してください。`。`MSG.code` の項目を置き換える。
`invalid_reply_code` には残り回数が後ろに付く）。
`actionPrefix`（既定 `bridge_approval:`）・`stateDomain`（既定 `bridge_approvals`）：別の名前で動いていた導入先を引き継ぐときだけ変える
（送付済みのカードのボタン ID と送付記録をそのまま使う。`actionPrefix` は起動時に決まるので変えたら再起動）。

## 拡張点
- 語：`replyWords`。文面の定数は `MSG`（export）、エラーの文は `messages` で上書き。
- 部品：`createApprovalsIm`（ctx 無し）、`replyMatcher`、`parseActionTarget`、`actionPrefixOf` / `actionPattern`、`decisionErrorMessage(error, overrides)`、`normalizeStatus`、`approvalSubject`。

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `approvals.test.mjs`（bridge-events と組み合わせた E2E：カード・ボタン・ダイアログ・返信コード・
エラー・期限切れ・取消・再起動・状態の復元・プラットフォームの変更・届かないカード）、`linked-bot.test.mjs`（連携に使ったボット・email を使わない）、
`multi-app.test.mjs`（2 アプリ・アプリごとの経路・token / 返信コードの分離・`replyWords`）。データは架空。
