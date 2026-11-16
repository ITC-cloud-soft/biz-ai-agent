# @dsh-bridge/plugin-identity（DSH プラグイン `bridge-identity`）

IM の発信者（dsh-im がプラットフォームのイベントから作る信頼できる `ImSource`）を、業務アプリケーションの職員に対応付ける。
連携コード・アクセス判定（連携済みの職員だけ AI を使える）・共用ボットの窓口内のアプリ切り替えを持つ。業務の語は持たない。

## 役割
- **アクセス制御**：`ctx.dshIm.setAccessResolver`。連携済みは `allow`、未連携は `deny` と案内
  （既定「…業務Webで連携コードを発行し、『連携 123456』と送信してください…」）。同じアカウントへの案内は `guideIntervalSeconds` に 1 回。
  業務 API に届かないときも拒否（「接続できません」）。どのアプリケーションにも属さないボットは API を呼ばずに拒否。
- **グループ会話**（`ImSource.conversationKind` が `direct` 以外）：既定 `deny`。AI は動かず、業務 API にも照会せず、固定の案内
  `messages.groupChat`（既定「業務の内容は個別チャットでお尋ねください。」。@dsh-bridge/dsh-core の `GROUP_CHAT_GUIDE`）だけを返す
  （同じ会話には `guideIntervalSeconds` に 1 回）。発言者本人の権限で答えても、答えがグループの他のメンバーに見えるため。
  アプリケーションごとにレジストリの `applications[].groupChat: allow`、全体はプラグインの `groupChat: allow` で従来どおり（発言者ごと）にできる。
  bridge-tools も同じ判定で業務ツールを拒否する（二重の守り）。`conversationKind` の無い発信元（IM 以外）は 1:1 として扱う。
- **照会はボットごと**：業務 API の照会（`paths.identity`）に、受信したボットの `botId` を足す（キャッシュもボットごと。連携・無効化では
  そのアカウントの全ボット分を消す）。業務システムは、`botId` が登録済みの個人ボットなら連携先がその持ち主のときだけ連携済みを返す
  （同じワークスペースの別の職員が他人の個人ボットに話しかけても通さない。判定は業務システム側、`docs/GUIDELINE.md` d.9）。
- **連携コード**：`ctx.dshIm.claimReplies` で「<キーワード> 123456」（全角数字可、キーワードは `linkKeywords`、既定 `連携`）を
  agent に渡さず処理 → そのアプリケーションの `paths.link`（v1 は `POST /bridge/v1/identities/link`）。`source.botId` も送る。
  グループ会話では受け付けない（DM での再発行を案内）・アカウントごとに 10 分 `linkAttemptsPerWindow` 回まで・
  404 / 410（無効・期限切れ）・409（連携済み）・429（試行過多）をそれぞれ返事にする。
- **email は通知だけ**：差出人は詐称できる（dsh-im は DKIM / DMARC を検証しない）ので、連携コードは「メールでは連携できません」、
  AI の利用は返信なしで拒否（詐称された宛先へ送り返さない）。業務 API にも照会しない。
- **解除**：bridge-events の `sns_identity.unlinked {identityId, userId, platform}` で、その職員・プラットフォームのキャッシュを即時に消し
  （解除前に始まった照会の結果もキャッシュしない）、`onUnlinked` の購読者（bridge-tools の委託トークン）に知らせる。
  イベントの `applicationId` のアプリケーションの分だけ。
- **会話の振り分け（共用ボット）**：`src/app-switch.js`。レジストリで `{ platform: weixin, botId, multiApp: true }` のボットだけ。

| 送る | 返事（例：設備点検・備品予約の 2 アプリ） |
|---|---|
| `#一覧` | 【アプリ一覧】このチャットで使える業務アプリ：／・設備点検（#点検）← いま／・備品予約（#予約）／… |
| `#備品予約`（name・aliases・id・namespace。全角 ＃ 可） | 【備品予約】備品予約に切り替えました。…（未連携なら連携の案内を添える） |
| `#いま` / `#ヘルプ` | いまのアプリ / 使い方（例は このチャットのアプリの名前） |

  普通の発言は dsh-im の会話ルーター（`setConversationRouter`）が「いまのアプリ」を `ImSource.applicationId` に載せ、
  アプリケーションごとの DSH 会話に入る。返信・通知は【アプリ名】で始まる。通知への返信（引用・直後の返信）はその通知のアプリへ。
  状態は `switchStatePath`（既定 `$DSH_HOME/integrations/bridge-identity/app-switch.json`）。

## サービス
- 提供：`ctx.bridgeIdentity` — `resolve(source)` → `{linked, orgId, user?:{id, role, displayName}}`（`cacheTtlSeconds` の短期キャッシュ・
  同時照会の集約）、`forSession(sessionId)` → `{source, linked, user?, applicationId}` / `null`（DSH Web の owner 会話など）、
  `invalidate(source)`、`onUnlinked(fn)`、`applicationOf(source)`、`currentApplication(source)`、`stats()`、`api.baseUrl()` / `api.hasServiceToken()`（既定のアプリケーション）。
- inject：`dshIm`（bridge fork の dsh-im：`sourceForTurn` / `setAccessResolver` / `claimReplies` / `setConversationRouter`。無いものは警告して縮退）。
- 任意：`bridgeApps`（@dsh-bridge/dsh-core のレジストリ。無ければプラグイン設定の 1 件）、`bridgeEvents`（解除のイベント）。

## 設定（Config）
| 項目 | 既定 | 説明 |
|---|---|---|
| `apiUrl` / `serviceToken` / `applicationName` | — | レジストリ（bridge-apps）が無いときの 1 件（Bridge v1 の経路） |
| `cacheTtlSeconds` | 60 | 連携状態キャッシュ |
| `linkKeywords` | `[連携]` | 連携コードのキーワード（例 `[link, 連携]`）。案内は先頭の語 |
| `unlinkedReply` | 案内文 | 未連携への返信（レジストリの `applications[].messages.unlinkedReply` が優先） |
| `messages` | {} | 返事の上書き：`unavailable` / `linked`（`{displayName}` 可）/ `invalidCode` / `alreadyLinked` / `groupNotAllowed` / `tooMany` / `failed` / `noApplication` / `emailNotLinkable` / `groupChat`（レジストリの `messages.<key>` が優先） |
| `groupChat` | deny | グループ会話で AI を使わせるか（`deny`：固定の案内だけ / `allow`：発言者ごとの判定）。レジストリの `applications[].groupChat` が優先 |
| `guideIntervalSeconds` | 600 | 同じ未連携アカウントへ案内を再送しない秒数 |
| `linkAttemptsPerWindow` | 5 | 連携コードの試行上限（10 分・アカウントごと） |
| `switchReplyWindowSeconds` | 600 | 共用ボット：通知の後、引用なしの最初の返信を通知のアプリに結び付ける秒数 |
| `switchStatePath` | `$DSH_HOME/...` | 共用ボットの状態の保存先 |
| `switchWords` | 日本語＋英語 | 切り替えコマンドの語 `{ list, current, help }`（例 `list: [apps, メニュー]`） |
| `switchMessages` | {} | 共用ボットの返事の上書き（`listTitle` / `listFooter` / `helpTitle` / `helpExample`＝使い方の「#アプリ名（例 …）」の例。既定はこのチャットの最初のアプリの切り替え名） |
| `publicHelp` | `{ enabled: true, perWindow: 10 }` | 未連携の発信者の質問（1:1）に、アプリケーションの経路 `paths.publicHelp`（v1 は `GET /bridge/v1/help/public`、Bridge v1 の任意の操作・server-kit の `help`。ケアビリングは compat の `/api/ai/help/public`）で公開の節を引き、**AI を使わずに**【ご案内】の形で答えて連携の案内を添える（manifest に `help` があるアプリケーションだけ。署名は AI 社員の呼び名つき）。経路が無い・見つからない・上限（10 分・アカウントごと）のときは従来の案内 |
| `linkGuard` | `{ enabled: true }` | AI の答え（IM のターン）を送る前のリンクの検査（dsh-im の `setAnswerFilter`、@dsh-bridge/dsh-core の `createLinkGuard`）：`webUrl`（既定のアプリケーション）／`webUrls.<id>` の業務 Web の URL は manifest の `web.routes` の画面だけを残し、ほかのホストは `allowHosts` だけを残す（他は「（リンクを省きました）」）。`webUrl` か `web.routes` が無いアプリケーションでは何もしない（fail open。routes があって URL が無いアプリケーションは、最初の答えのときに 1 回だけ警告する。**すべてのアプリケーションについて書く**：2 つ目以降は `webUrls.<id>`） |

システムの使い方の答え（care-ai-native `docs/design/SNS_HELP_QA.md`）：連携済みの職員の質問は AI がマニュアルのツールで答え（リンクはこの検査を通る）、未連携の発信者には `publicHelp` が公開の節だけで答える。

## 拡張点
- 文面：`messages` / `unlinkedReply`（プラグイン）と、レジストリの `applications[].messages`（アプリケーションごと）。
- 語：`linkKeywords`・`switchWords`。日本語の既定はそのまま。
- 部品：`createIdentityService` / `createRateLimiter` / `linkPattern` / `installAppSwitch` / `createSwitchParser` を export（ctx 無しで使える）。

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `identity.test.mjs`（連携・案内・email・解除・キーワード）、
`multi-app.test.mjs`（2 アプリ・アプリごとの経路・strict）、`shared-bot.test.mjs`（共用ボットの切り替え・通知への返信・委託の分離・永続化）、
`group-chat.test.mjs`（グループ会話の拒否と案内・上書き・レジストリの allow）、
`help.test.mjs`（リンクの検査・未連携の発信者への公開の節の答え・経路が無い／無効／上限）。
業務 API は node:http のモック、データは架空。
