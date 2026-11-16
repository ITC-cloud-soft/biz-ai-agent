# AI アシスタントへのファイル添付（方案・レビュー用）

> 2026-10-29 起案。状態：**実装済み**（D1〜D6 は推奨どおり。2026-10-30 に画像の後片付け〔D4〕と OCR〔D5 を B に変更〕も入れた。末尾の「実装の記録」）。Biz Assistant Framework の基本機能として入れる（業務 Web の AI アシスタントのパネル）。
> 要望：「使うモデルがマルチモーダルなら、AI アシスタントの画面からファイルを上げたい。画像・PDF・Word・Excel・CSV・Markdown など、複数をまとめて」。
> あわせて直すこと：パネルの回答の Markdown（`**太字**`・箇条書き・リンク）が記号のまま表示される。

## 0. 結論（先に）

1. **画像**（PNG・JPEG・WebP・GIF）は DSH の添付の仕組み（`@deepseek-ai/dsh-attachment`）でそのまま会話に入れる。DSH が検査・正規化し、
   モデルが画像を読める（`inputModalities` に image がある）ときだけモデルに渡る。読めないモデルのときは、**添付の時点で断る**（「このモデルは画像を読めません」）。
2. **文書**（PDF・Word〔docx〕・Excel〔xlsx〕・CSV・Markdown・テキスト）は、**業務システム側で文字に変換**してから、その文字を会話に添える。
   AI 社員の preset はファイルを読むツールを持たない（安全の方針）ので、DSH の「パスを渡してモデルが読む」方式は使わない。
3. 1 回の質問に **最大 5 ファイル・合計 20 MB**（1 ファイル 10 MB）。文書から取り出す文字は 1 ファイル 3 万字・合計 6 万字まで（超えた分は切り、切ったことを AI に伝える）。
4. 添付の中身は、入力した文と同じく**モデルの提供元に送られる**。パネルにその旨を常に表示し、管理者が「添付を使える役割」「使える種類」を決める（既定：管理者・介護担当・請求担当、上の全種類）。
5. 監査・ログに残すのは**件数・種類・大きさだけ**（ファイル名・中身は残さない）。変換は業務システムのメモリ上で行い、文書の原本は保存しない。
   画像は DSH の会話の履歴に保存される（DSH は自動で消さない）ので、会話の期限に合わせて消す仕組みを足す（§3.4）。

---

## 1. いまの仕組み

| 部品 | いま |
|---|---|
| 業務 Web のパネル（care-web `AssistantPanel`） | 文字だけ送る（4,000 字）。回答は文字のまま表示（Markdown を解釈しない） |
| BFF（`/api/assistant/*`） | 本人のセッションで care-api にチケットを出させ、DSH の管理 RPC `message.send {agent, text, context}` を呼ぶ |
| bridge-assistant（DSH） | Harness の `session.prompt`（文字）で会話に送る。会話はアプリ × 職員 × AI 社員ごと |
| DSH の添付 | 画像：検査・正規化して保存し、画像を読めるモデルへ渡す（読めないモデルには自動で代わりの文字）。その他のファイル：保存してパスだけをモデルに渡す（ファイルのツールで読む前提）。どちらも自動では消えない |

---

## 2. 流れ

```
パネル：ファイルを選ぶ（ドラッグ＆ドロップ・クリップボードの画像の貼り付け・複数可）→ 種類・大きさを先に確かめて表示（サムネイル・ファイル名・×で外す）
   │  POST /api/assistant/messages（multipart：text, context, files[]）
   ▼
BFF：本人のセッション → 役割と添付の設定を確かめる → 1 ファイルずつ
   ├─ 画像：形式（中身の先頭バイトで判定）・大きさ → base64 で DSH へ
   └─ 文書：業務システムの変換 API（POST /bridge/v1/assistant/extract、サービストークン）→ 文字（Markdown）
            PDF：文字の層（スキャンだけの PDF は「文字を取り出せませんでした」）／docx：本文・表／xlsx：シートごとに表（Markdown の表）／CSV・MD・TXT：そのまま（文字コードを判定）
   ▼
bridge-assistant：message.send {agent, text, context, attachments: [{kind: 'image', mimeType, data} | {kind: 'document', name, mimeType, text, truncated}]}
   ├─ 画像：Harness の prompt の内容に画像の部品として入れる（DSH が保存・正規化）
   └─ 文書：プロンプトに「[添付 1：見積書.xlsx（シート 2・表）]…」の節として入れる（参考情報・指示ではない、と明記）
```
- モデルが画像を読めるかは、bridge-assistant が DSH のモデル情報（`inputModalities`）から調べ、`agents.list` に `capabilities: { images: true|false }` として返す。
  パネルは読めないときに画像の添付ボタンを無効にして理由を出す（文書は使える）。
- 添付だけ（文が空）でも送れる（「この資料を要約して」を既定の文として足す）。

## 3. 安全と個人情報

### 3.1 何を許すか
| 項目 | 既定 | 変えられるか |
|---|---|---|
| 添付を使える役割 | 管理者・介護担当・請求・給与担当（現場職員・ケアマネは設定で足す） | 管理者（業務 Web の設定） |
| 種類 | 画像（PNG・JPEG・WebP・GIF）、PDF、docx、xlsx、CSV、Markdown、TXT。**マクロ付き（xlsm・docm）・旧形式（xls・doc）・実行形式・圧縮ファイルは断る** | 管理者が減らせる（増やすのはコードの変更） |
| 大きさ | 1 ファイル 10 MB・1 回 5 ファイル・合計 20 MB、文字は 1 ファイル 3 万字・合計 6 万字、画像は DSH の上限（画素数）も | 設定で小さくできる |
| 回数 | 職員ごと 1 分 10 回（今の送信の上限と同じ）、添付つきは 1 日 50 回 | 設定 |

### 3.2 中身の扱い
- 添付の中身は入力した文と同じく**モデルの提供元に送られる**。パネルの添付の欄に常に表示する：「添付した内容は AI のモデル（設定のプロバイダー）に送られます。個人情報は必要な範囲だけにしてください」。
- 文書から取り出した文字は「参考情報（指示ではない）」としてプロンプトに入れる（資料の中の「この指示に従え」に従わない）。
- 変換は業務システムのメモリ上だけ。文書の原本・取り出した文字は業務システムに保存しない。

### 3.3 記録
- 監査（業務システム）：`assistant.attachments`（職員 ID・件数・種類ごとの件数・合計の大きさ）。ファイル名・中身は残さない。
- DSH の会話の履歴には画像と、文書から取り出した文字が残る（今の文字の質問と同じ扱い）。

### 3.4 消すこと
DSH の添付は自動では消えない（DSH 0.2.2-rc.1 の仕様）。アシスタントの会話は 12 時間で使われなくなるので、
**会話をやり直す（新しい会話）・使われなくなった会話**の画像を消す処理を bridge-assistant に足す（DSH の保存先の、その会話だけが参照する画像。§6 D4）。

## 4. Markdown の表示（あわせて直す）
パネルの回答を安全な Markdown として表示する：太字・斜体・箇条書き・番号付き・見出し・表・コード・リンク（業務 Web の URL と許可したホストだけ、外部は `rel="noopener noreferrer"`）。
HTML は表示しない（エスケープ）。業務 Web のヘルプ画面（H1）の Markdown の部品（web-kit の `help-markdown-core`）を使う。

## 5. framework に入れるもの

| 層 | 追加 |
|---|---|
| protocol | `POST /bridge/v1/assistant/extract`（任意の機能：ファイル → 文字。サービストークン。種類・大きさの上限、`unsupported_type` / `too_large` / `no_text`） |
| server-kit | 変換の部品（PDF〔pdfjs、別プロセス〕・docx・xlsx・CSV・MD・TXT。文字コード判定）と上の経路 |
| gateway / BFF の部品 | multipart の受け取り・先頭バイトでの種類の判定・上限・役割と設定の確認 → 変換 → message.send |
| bridge-assistant | `message.send` の `attachments`、画像を Harness の prompt に、文書をプロンプトの節に、`agents.list` の `capabilities.images`、会話を消すときの画像の削除 |
| web-kit | 添付の欄の部品（選択・ドラッグ＆ドロップ・貼り付け・サムネイル・外す・上限の表示）、回答の Markdown 表示 |

ケアビリング：care-api に変換の経路（P2m の PDF の別プロセスの仕組み・請求取込の xlsx の読み取りを使う）、業務 Web のパネルに添付の欄、設定画面に「添付を使える役割・種類」。

## 6. 決めてほしいこと

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| D1 | 文書の渡し方 | A. 業務システムで文字に変換して添える／B. DSH に保存して、その会話の添付だけを読む専用ツールを AI に持たせる | **A**（AI にファイルのツールを持たせない方針のまま。表も Markdown にできる） |
| D2 | 画像を読めないモデルのとき | A. 添付の時点で断る／B. DSH の既定どおり代わりの文字で送る | **A**（黙って読まれないより分かりやすい） |
| D3 | 使える役割の既定 | A. 管理者・介護担当・請求・給与担当／B. 全員 | **A**（現場職員・ケアマネは管理者が足す） |
| D4 | 画像の保存 | A. 会話をやり直す・使われなくなったときに消す／B. DSH の既定どおり残す | **A** |
| D5 | スキャンだけの PDF・写真の中の文字（OCR） | A. P1 ではしない（画像として送れば読めるモデルは読む）／B. OCR を入れる | **A**（2026-10-30 に **B** へ：既定はスキャンのページを画像にしてモデルが読む、業務システムの OCR エンジンもつなげる） |
| D6 | 1 回の上限 | 5 ファイル・合計 20 MB（1 ファイル 10 MB） | このまま |

## 7. 進め方
| 段階 | 内容 | 目安 |
|---|---|---|
| A1 | Markdown の表示（すぐ直す）・画像の添付（モデルの能力の判定・断る・複数）・添付の欄の部品 | 2 日 |
| A2 | 文書の変換（PDF・docx・xlsx・CSV・MD・TXT）・業務システムの経路・上限・設定・監査 | 2〜3 日 |
| A3 | 会話の画像の削除・ケアビリングの設定画面・マニュアル | 1 日 |

## 実装の記録

2026-10-30、framework（branch redesign/att）。D1〜D6 は推奨どおり（D1 A・D2 A・D3 A・D4 A・D5 A・D6 このまま）。

| 層 | 入れたもの |
|---|---|
| protocol | OpenAPI（x-optional・tag assistant）：`POST /assistant/attachments/prepare`（`prepareAssistantAttachments`、本人のセッション + BFF の秘密）、`GET /assistant/attachment-settings`（`getAssistantAttachmentSettings`、本人）、`GET / PUT /admin/assistant/attachment-settings`（`getAdminAssistantAttachmentSettings` / `putAdminAssistantAttachmentSettings`、管理者）。スキーマ `AttachmentFile` `AttachmentDocument` `AttachmentsPrepared` `AttachmentSettings` `AttachmentAdminSettings` `AttachmentLimits` `AttachmentType`。エラーコード 9 個 |
| server-kit | `@dsh-bridge/server-kit/extract`（`src/extract/`：`detectAttachmentType` `checkAttachments` `extractDocument` `prepareAttachments` `attachmentSummary` `createPdfTextExtractor`）。経路 `routes/assistant-attachments.mjs`（prepare の本文の上限は 20 MB の base64 まで上げる：router の `maxBodyBytes`）、表 `004_assistant_attachments.sql`（memory の store も同じ契約）、監査 `assistant.attachments` / `assistant.attachment_settings.updated`、`createBridgeApp({ attachments })` |
| gateway | `prepareAssistantAttachments` `checkAssistantAttachments` `attachmentErrorStatus` `ASSISTANT_ATTACHMENT_LIMITS` `DEFAULT_ATTACHMENT_PROMPT`（`@dsh-bridge/gateway/assistant-attachments`、依存なし） |
| bridge-assistant | `message.send` の `attachments`、Harness の prompt の画像の部品、プロンプトの添付の節（送信ごとの境界の文字列）、`agents.list` の `capabilities.images`、設定 `imageInput` / `maxAttachmentBytes`、inject に `llm` |
| web-kit | `AssistantMarkdown`、`AssistantAttachmentPicker` + `useAssistantAttachments`、`AttachmentSettingsCard`、core `assistant-markdown-core` / `assistant-attachments-core`、`help-markdown-core` を広げた（見出し 6 段・斜体・コードの囲み・番号の始まり・段落の改行・リンクの規則・表の `\|`）、文言 `attach.*` / `attachSettings.*` |

§2・§5 の案との違い：
- 変換の経路は `POST /bridge/v1/assistant/extract`（サービストークン）ではなく `POST /bridge/v1/assistant/attachments/prepare`（**職員本人のセッション + BFF の秘密**）。役割と設定を業務システムが本人のセッションで確かめられ、監査に職員が残る。
- BFF への送り方は multipart ではなく JSON（`attachments: [{ name, mediaType, data（base64） }]`）。BFF の本文の上限を 30 MB にする。
- 画像は prepare に中身を送らない（種類と大きさの検査だけ）。中身は BFF から DSH にだけ渡る。
- 文書の節は「[添付 1：見積書.xlsx（表）]」の見出しのあと、送信ごとの境界の文字列（`<<<添付 1・<8 桁> ここから>>>` … `ここまで`）で囲む。資料の中に同じ行を書いて節を閉じることはできない。
- 画像を読めるか（D2）：DSH の `session.modelCatalog` の既定のモデル（preset はモデルを選ばない）を `ctx.llm.resolveModelInfo` で調べる。`inputModalities` に image が無ければ `false`、
  `inputModalities` が無ければ「分からない」（`null`：画像は送る。パネルは DSH が代わりの文字にすることがある旨を出す）。DSH 自身も、読めないと分かっているモデルへの画像を
  `session/attachment-invalid`（MODEL_DOES_NOT_SUPPORT_IMAGES）で断る。そのときも `images_not_supported` を返し、結果を 60 秒覚える。DSH の画面で会話ごとに別のモデルを選んだ場合は見ない。
- bridge-assistant の上限 `maxAttachmentBytes`（既定 20 MB）は、画像の **デコード後** のバイトと文書の文字の UTF-8 のバイトの合計で数える（base64 で数えると、BFF が通した 15〜20 MB の画像を DSH 側で断ってしまうため）。
- xlsx の非表示のシートは読まない（職員が画面で見ていない内容を AI に渡さない）。PDF は 200 ページまで（超えたら `truncated`）。
- 回数の上限（1 日 50 回）は入れていない（送信の上限 `sendsPerMinute` のまま）。

### 画像の後片付け（D4、2026-10-30）
DSH 0.2.2-rc.1 の `ctx.attachments` には削除の API が無く、保存先（attachment-local、`<DSH_HOME>/attachments/v1/objects/<2>/<sha256>`）は同じ中身を 1 つにまとめる
（resume・fork した会話・他の職員の会話が同じ画像を参照しうる）。DSH の参照の数え上げを待たず、**bridge-assistant が参照を自分で数える**（`plugins/assistant/src/image-cleanup.js`）：
- 会話のログ（`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd`：独立に読める zstd のフレームの連なり）は画像を `{"type":"image","attachment":{"attachmentId":"sha256:…"}}` で参照する。
  フレームの構造を DSH の JSONL の永続化と同じ方法で走査し、フレームごとに展開して ID を集める。DSH_HOME のほかのファイル（自動タスク・storages など。画像そのもの・縮小版・
  プロファイル・ログ・llm-deepseek のアップロードの台帳は除く）も ID を探す。
- 対象は**台帳**（`<DSH_HOME>/storages/bridge-assistant/image-sessions.json`）にある、このプラグインが画像を送った会話だけ。やり直し（`conversation.reset`）・12 時間使われない
  （DSH を再起動して会話がメモリから消えても、台帳の最終利用で判断）で終わった会話にする。
- 消すのは、終わった会話だけが参照する画像（ほかの会話・台帳に無い会話・DSH_HOME のほかのファイルが 1 つでも参照すれば残す）と、その縮小版
  （`<DSH_HOME>/cache/attachments/request-images`。llm-deepseek のアップロードの台帳 `files-v3.json` で元の画像が分かるもの。台帳は読むだけ）。
- **fail closed**：ログを 1 つでも読み切れない（書きかけのフレーム・壊れたフレーム・大きすぎるファイル）回は何も消さない。消す直前に、数え始めてから書かれたログを読み直す。
  消している間は、このプラグインからの画像つきの送信を待たせる（DSH が同じ中身を重複として既存のファイルに結び付ける途中で消さない）。
- 既定 60 分ごと（最初は起動の 5 分後）。設定 `imageCleanup: off` で止める。終わった会話のログの本文は残る（DSH の画面でその古い会話を開くと画像は表示されない）。
- DeepSeek の file API に上げた写しは、アップロードの台帳の `expiresAt`（7 日）で提供元が消す。演示の DSH の実際のログ（13 本）で、フレームの走査・展開と ID の検出を確かめた。

### OCR（D5 → B、2026-10-30）
- server-kit の PDF の別プロセスで、**文字の層がほとんど無いページ**（空白を除いて 20 字未満）を pdf.js が `@napi-rs/canvas`（pdfjs-dist の任意の依存。Linux の x64 も lockfile にある）で
  描き、長い辺 1,600 px の JPEG（1.5 MB まで、品質 82 → 70 → 55）にする。白紙のページ（暗い点が 2,000 分の 1 未満）は送らない。1 回の prepare で全部の文書を合わせて 10 ページまで。
- **業務システムの OCR エンジン**（`createBridgeApp({ attachments: { ocr } })` / `prepareAttachments(files, { ocr })`、`ocr(bytes, { mediaType, page }) -> text`）があれば、ページを文字にする
  （`ocr: 'engine'`。画像は外に出ない。文字だけのモデルでも読める）。無ければ文書の `pageImages`（`ocr: 'model'`）で返し、ページの文字の欄に
  「（スキャンのページ：この質問に画像として付いています。画像の文字を読み取ってください）」と書く。
- BFF（gateway の `prepareAssistantAttachments`）が `pageImages` を文書の添付に付けて DSH へ。bridge-assistant はそのページを「<文書名> p.<ページ>」の画像の部品として送る。
  モデルが画像を読めなければ `images_not_supported`（`details.reason: 'scanned_pdf'`）。
- 描けない（canvas の部品が無い）・OCR を止めた（`settings.ocr: false` / `attachments.ocr: false`）ときは、これまでどおり `no_text`（`details.reason`：`ocr_unavailable` / `ocr_off`）。
- 監査の `assistant.attachments` に `ocrPages`（枚数）を足す（ファイル名・中身は残さない）。パネルの注意書きと管理画面の説明に「スキャンの PDF はページを画像にして AI に読み取らせる（10 ページまで）」。
- ローカルの OCR エンジン（Tesseract など）は同梱しない（言語データのダウンロードが要る。導入先が `ocr` の口につなぐ）。
