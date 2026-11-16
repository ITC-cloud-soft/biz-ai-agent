# @dsh-bridge/plugin-tools（DSH プラグイン `bridge-tools`）

DSH の AI 社員が使う業務ツールを、委託 gate 付きで載せる汎用プラグイン。**業務の状態は変えない**：業務 API の GET と、
人が業務 Web で採択するまで何も変わらない「提案」の POST だけ。権限・承認・金額・監査は業務システムが持つ。

## 何を載せるか（アプリケーションごと）
1. **manifest から生成する読み取りツール**：manifest の `tools` のうち `access: read` の `GET <path>`（と `open: true`）。
   引数は manifest の `input`（JSON Schema）だけ、パス引数は URL エンコード、出力は `{ok, data}`（render は 4000 字で切る）。
   名前空間（`<namespace>_*`）の外・`propose`・GET 以外は作らない。bridge-apps の `generateTools: true` のアプリケーションは bridge-apps が作るので除く。
   manifest の `help.tool` に挙げた読み取りツールは、マニュアルの検索として作る（dsh-core の help-tool：【ご案内】の描き方・URL を渡す引数の拒否・
   開けない画面の URL を省く。`@dsh-bridge/help`、`docs/GUIDELINE.md` b.8）。
2. **手書きのツール**（主に提案ツール）：`toolModules`（パッケージ名・パス）か、別のプラグインから `ctx.bridgeTools.register(appId, factory)`。
3. 見本：`@dsh-bridge/plugin-tools/examples/equipment-inspection` — 設備点検の `facility_propose_reschedule`（次回点検日の変更の提案。
   `POST /bridge/v1/proposals {kind: inspection_reschedule, payload: {equipmentId, dueOn, reason?}}`）。
   設備点検の読み取り（`facility_list_equipment` / `facility_list_overdue`）は manifest から生成される。

業務固有のツール（ケアビリングの請求・記録・計画書・文言チェックなど）はこのプラグインに入れない。各アプリケーションのリポジトリで
ツールモジュールとして書き、`toolModules` で読み込む。

## 委託 gate（呼び出しごとの認可。@dsh-bridge/dsh-core の tools-sdk）
- IM 発信者：bridge-identity の `forSession(sessionId)` → 連携済み職員 → そのアプリケーションの `paths.delegations` で委託トークン
  （(アプリケーション, 発信元) ごとにキャッシュ、期限前に取り直し）。業務 API には `x-service-token` と `x-delegation-token`。
  401 は 1 回だけ取り直して再試行、404（連携解除）はキャッシュを捨てて拒否。
- グループ会話（発信元の `conversationKind` が `direct` 以外）のターン：既定は拒否（`groupChat: deny`。委託トークンも取らない・`ai-readonly` にも落とさない）。
  拒否の文はモデルに「業務の内容は個別チャットでお尋ねください。」だけを返すよう指示する。`groupChat: allow`（プラグイン / `applications.<id>` /
  レジストリの `applications[].groupChat`。この順で先に書いたものが優先）で、従来どおりターンごとの発信者の委託にできる。
- 会話（ボット）のアプリケーションとツールのアプリケーションが違えば拒否（委託トークンも取らない）。トークンは発行したアプリケーションにしか送らない。
- 業務 Web の AI アシスタント（bridge-assistant）の会話：本人がパネルから送ったターンの間だけ、本人の委託。
- 定時報告（bridge-notify の `aiReportOwner` と dsh-proactive の business モードの起動）：その会話で本人が有効にしたときだけ、本人の委託で読み取りのみ。
- 自動タスク（IM 発信者のいない event / schedule のターン）：`unattendedPolicy: delegate` と `unattendedOnBehalfOf`（またはレジストリの
  `delegation`）のときだけ、auto-tasks に登録された会話に限り、その職員の委託で読み取りと、**その会話のタスクの `source.tools`
  （playbook の tools）に挙がった提案だけ**。`source.tools` を持つタスクが無ければ `unattendedDefaultTools`（既定なし）。
- 自動タスクの委託の分類（playbook の `delegation` → タスクの `source.delegation`。いま動いている回は `ctx.autoTasks.activeRun(sessionId)`、
  回の外はその会話のタスクの分類が 1 種類のときだけ）：`<class>` は `unattendedDelegates.<class>` の職員（無ければ `unattendedOnBehalfOf`）。
  `<class>=each` は**回ごとに、その回の起動事件の本人の委託**（業務システムが `POST delegations {event: {id}}` に対して発行する。呼び出し側は
  職員を選べない。(アプリケーション, 事件) ごとにキャッシュ）。導入先が `unattendedDelegates.<class>: each` と書いたときだけ（install.mjs
  `--auto-task-delegate <class>=each`）。回の外・事件の無い回・別のアプリケーションの回・業務システムが発行しない事件は拒否（既定の職員で代えない）。
  `unattendedWarnRoles` の役割の職員の委託で動いたら一度だけ警告を残す（動作は止めない）。
- 未連携・発信元なし：既定は拒否。`unlinkedPolicy: ai-readonly` なら読み取りだけを AI 自身（mode: ai）の権限で許す。提案は常に拒否。
- 読み取りツールは GET しか呼べない（書き込みは提案ツールだけ）。`bridge-identity` の `onUnlinked` で解除された職員のトークンを捨てる。

## サービス
- 提供：`ctx.bridgeTools` — `ready`、`refresh()`、`register(applicationId, factory | tools)`、`list()` → `[{application, name, access, generated}]`、`gate(applicationId)`。
- inject：`tools`（DSH の tools.register）。任意：`bridgeApps`、`bridgeIdentity`、`bridgeAssistant`、`bridgeNotify`、`dshProactive`、`autoTasks`。

## 設定（Config）
| 項目 | 既定 | 説明 |
|---|---|---|
| `apiUrl` / `serviceToken` / `applicationName` / `namespace` | — | レジストリが無いときの 1 件 |
| `only` | 全部 | ツールを載せるアプリケーション ID |
| `generate` | true | manifest の読み取りツールを生成する |
| `unlinkedPolicy` | deny | `deny` / `ai-readonly` |
| `groupChat` | deny | グループ会話のターンで業務ツールを使わせるか（`deny` / `allow`） |
| `unattendedPolicy` / `unattendedOnBehalfOf` | deny | 既定のアプリケーションの自動タスクの委託（他は `applications.<id>` かレジストリの `delegation`） |
| `unattendedDelegates` | — | 委託の分類ごとの職員 `{ <class>: {platform, userId, teamId?} \| each }`（`each` は `<class>=each` の playbook に起動事件ごとの委託を許す） |
| `unattendedWarnRoles` | [] | 自動タスクがこの役割の職員の委託で動いたら一度だけ警告する |
| `unattendedDefaultTools` | [] | `source.tools` の無い自動タスクで許す提案 |
| `unattendedTools` | 全提案ツール | 自動タスクで使ってよい提案ツールの上限（この順で拒否の文言に並ぶ。空の一覧は未設定と同じ）。playbook の `source.tools` に書いても、ここに無い提案は拒否 |
| `toolKind` | `<アプリ名> tools` | 拒否の文言でのツールの呼び名（`… <toolKind> run only on behalf of a linked employee; <hint>`） |
| `denyHints` | `DEFAULT_DENY_HINTS` | 拒否の文言の案内 `{ linked, noSender }`（業務 Web の連携画面の名前など） |
| `applications.<id>` | {} | `unlinkedPolicy` / `groupChat` / `unattendedPolicy` / `unattendedOnBehalfOf` / `unattendedDelegates` / `unattendedWarnRoles` / `unattendedDefaultTools` / `unattendedTools` / `toolKind` / `denyHints` の上書き |
| `toolModules` | [] | `[{ module, application? }]`。module の default export が `(kit) => tools`（`application` を export すれば省略可） |

## 拡張点：ツールモジュール
```js
// my-app-tools.js
export const application = 'my-app'
export default (kit) => [
  kit.defineTool({ name: 'myapp_count_open', description: 'Read-only: …', async execute() {
    return { ok: true, data: await kit.requestJson('myapp_count_open', '/api/open-items') } } }),
  kit.proposeTool({ name: 'myapp_propose_close', kind: 'close_item', description: 'propose closing one item.',
    parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    forbidden: ['amount'], forbiddenReason: 'amounts are computed by the business system' }),
]
```
`kit`：`applicationId`・`application()`・`namespace`・`requestJson(tool, path, query?, {method, body})`（そのアプリケーションの API と、
呼び出しの委託トークン）・`text(lines)`・`args`（string / date / integer の検証）・`principal()`・`defineTool`・`proposeTool`。
`defineProposeTool(spec, { requestJson })` は単体でも使える（未知の引数・forbidden はエラー、payload は `validate` で作る、結果は提案の ID・種類・状態だけ）。

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `delegation`（委託・キャッシュ・401・解除・設定の 1 件）、`auto-proposals`（source.tools の制限）、
`multi-app`（2 アプリ・名前空間・only / generate）、`assistant`（アシスタントの会話）、`tools`（生成・GET のみ・見本の提案ツール・定時報告の呼び出し元）、
`group-chat`（グループ会話のターンの拒否と allow の上書き）、`delegation-classes`（委託の分類と `<class>=each` の事件ごとの委託）。
fixture は `test/fixtures/equipment-inspection.manifest.yaml`（架空）。

## 外部連携のツール（docs/AI_EMPLOYEE_PROFILE.md §3）

業務システムが `paths.connectorCatalog`（`GET /bridge/v1/connectors/catalog`）で出す操作の一覧から、`<namespace>_ext_<接続先>_<操作>` を作る
（設定 `connectorTools: true`、`connectorRefreshSeconds: 60` ごとに取り直して増えた操作を足す）。

- 読む操作（access: read）：`POST <paths.connectorRun>` を本人の委託で呼ぶ。業務システムが外部の API を呼び、許可リストの項目だけ返す。
  read のツールが POST してよいのはこの経路だけ（`requestJson(..., { connectorRun: true })`、他の経路は tools-sdk が断る）。
- 書く操作（access: propose）：提案だけ（v1 は `POST /bridge/v1/proposals` の kind `connector_write`、ケアビリングは承認の依頼）。人が承認してから業務システムが実行する。
- 引数は操作の入力の形（平らな object）だけ。実行のたびに一覧にまだあるか確かめる（消えた・止めた操作は動かさない）。役割は業務システムが確かめる。
- AI は接続先の URL・API キー・応答の本文を知らない。
