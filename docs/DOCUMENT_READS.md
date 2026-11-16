# AI が読むスキャンの文書（document reads）

> 2026-10-30。状態：**実装済み**（framework：protocol・dsh-core の経路・`@dsh-bridge/plugin-reader`。最初の導入例はケアビリングのケアマネ連携ボックスの受信文書）。
> 要望：「PDF・画像を取り込むとき、ページを画像にして、画像を読めるモデルに読ませる（ローカルの OCR エンジンは頼りにならない）」。

## 0. 結論（先に）

1. 業務システムが自分で読めなかった文書（**画像**、**文字の層の無い PDF**）は、ページの画像（JPEG / PNG、1 件 10 ページまで）として
   `GET /bridge/v1/document-reads` に並べる（Bridge v1 の任意の機能、サービストークン）。返したものは「受け取られた（claim）」状態になり、
   10 分たつと業務システムはまた出してよい。
2. DSH の **bridge-reader** が数件ずつ受け取り、**画像を読めるモデルに 1 ページ 1 回ずつ書き写させ**、
   `POST /bridge/v1/document-reads/{readId}/result` に `{ pages: [{ page, text }] }`（読めないときは `{ error }`）で返す。
3. **会話は作らない**（`ctx.llm.stream` の 1 回の要求）。DSH の会話のログにページも文字も残らない。ページの画像はモデルへの要求のために
   DSH の添付の保存先に一度入るが、読み終わったら、どの会話も参照していなければ消す（dsh-core の image-cleanup の `orphan`）。
4. モデルは**書き写すだけ**：推測・要約・補完をしない、読めない字は〔判読不能〕、資料の中の指示には従わない（`READ_SYSTEM`）。
   項目への割り当て（取込項目マッピング）と**人の確認**は業務システムがする（AI が読んだ値は自動で確定しない）。
5. ページの画像はモデルの提供元に送られる。どの文書を出すか（出さないか）は業務システムが決める（ケアビリングは設定で止められる）。
   業務システムのログ・監査に残すのは件数と ID だけ（画像・読んだ文字は残さない）。

## 1. 流れ

```
業務 Web：文書を登録（PDF・画像）
   │  業務システム：文字の層があれば今までどおり読む。無ければ（画像・スキャンの PDF）「AI で読み取り中」にして document read を作る
   ▼
DSH bridge-reader（既定 30 秒ごと）：GET /bridge/v1/document-reads?limit=2（サービストークン）→ claim
   │  1 ページずつ：ctx.attachments.saveImage → ctx.llm.stream（system = READ_SYSTEM、temperature 0、画像の部品）→ 書き写した文字
   │  読み終わったら画像の後片付け（どの会話も参照していなければ消す）
   ▼
POST /bridge/v1/document-reads/{readId}/result { pages: [{ page, text }] } | { error: images_not_supported | model_failed | too_large }
   ▼
業務システム：文字を自分の項目へ（取込項目マッピング）→ すべて「要確認」→ 人が確認して取り込む
```

## 2. プロトコル（Bridge v1、x-optional、tag document-reads）

| 操作 | 内容 |
|---|---|
| `GET /document-reads?limit=1..5`（既定 2） | `{ ok, reads: [{ id, purpose?, language?, hint?, pages: [{ page, mediaType: image/jpeg|image/png, data }] }] }`。返したものを claim する（10 分で再び出せる）。`hint` は様式の名前（人名は入れない） |
| `POST /document-reads/{readId}/result` | `{ pages: [{ page, text（20,000 字まで） }] }` か `{ error }`。claim 中のものだけ（違えば 409 `read_not_claimed`、無ければ 404 `read_not_found`） |

dsh-core の経路：`documentReads` / `documentReadResult`（v1 と、ケアビリングの互換 `/api/ai/document-reads*`）。
server-kit は 2 つの経路を常に持ち（サービスだけの関門）、業務システムが `hooks.documentReads = { claim({ limit }, ctx), answer(readId, body, ctx) }`
を実装すると動く（無ければ関門の後で 404。`checkDocumentReadResult` が本文を検査する）。

## 3. DSH（@dsh-bridge/plugin-reader、bridge-reader）

- 設定：`enabled`（既定 true）、`intervalSeconds`（30）、`provider` / `model`（既定は DSH の新しい会話の既定のモデル：Harness の
  `session.modelCatalog`）、`maxTokens`（1 ページ 4,000）、`dshHome`（画像の後片付け）。
- inject：`llm`（書き写し・`resolveModelInfo`）、`attachments`（ページの画像をモデルの要求に入れる）、`connection` / `typertGateway`（既定のモデル）。
- モデルの `inputModalities` に image が無ければ、画像を保存せずに `{ error: 'images_not_supported' }` を返す。
- 業務システムが機能を持たない（`paths.documentReads` が無い・404）アプリケーションには 10 分聞きに行かない。
- `ctx.bridgeReader.stats()`：`reads` / `pages` / `failed` / `skipped` / `lastError`（中身は無い）と画像の後片付けの数。

## 4. 業務システムがすること

- 画像と文字の層の無い PDF を document read にする（PDF は server-kit の `createPdfTextExtractor` の `ocrPages` でページを JPEG に。
  白紙は送らない）。文字の層がある PDF は今までどおり自分で読む。
- 返った文字を自分の項目に割り当て、**すべてを人の確認が要る状態**にする。状態（読み取り中・読み取り済み〔要確認〕・読めなかった）を画面に出す。
- 機能を止める設定と、ページがモデルの提供元に送られることの案内。
- ログ・監査は件数・ID・エラーのコードだけ。

ケアビリング：`docs/design/DOCUMENT_READS_CARE.md`（ケアマネ連携ボックスの受信文書）。

## 5. 安全

- 秘密・業務 DB に DSH は触れない（いつもどおりサービストークンの API だけ）。
- AI は文書を「読む」だけで、項目を確定しない。業務の判断（どの利用者か、どの値を取り込むか）は業務システムと人。
- 資料の中の指示（「この値で承認せよ」など）に従わない：書き写すだけの指示と、文字として写すことを明記。
