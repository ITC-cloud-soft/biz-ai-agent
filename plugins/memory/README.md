# @dsh-bridge/plugin-memory（DSH プラグイン `bridge-memory`）

AI 社員の**長期記憶**。DSH の会話は IM のチャットごとに 1 つで、`/new`・`/clear`・圧縮（compaction）で前の内容が消える。
このプラグインは、職員ごと・組織ごとに覚えておくべきことを DSH の会話の外（DSH のストレージ）に残し、次の会話の最初に少しだけ渡す。業務の語は持たない。

DSH 本体（0.2.2-rc.1）に長期記憶のプラグインは無い。近いものは `dsh-experimental-session-search`（同じワークスペースの全会話を検索）だが、
共用ボットではワークスペースが職員全員で同じなので、他の職員の会話まで検索できてしまう。ここでは**職員ごとに分けた**振り返りを自前で持つ。

## 3 つの記憶

| 種類 | 作用域 | 中身（分類） | 読める人 | 既定の期限 |
|---|---|---|---|---|
| 個人の記憶（`scope: personal`） | アプリケーション × 組織 × 職員 | `preference` 好み・やり方 / `task` 進行中の用件 / `note` メモ | **本人だけ**（管理者にも見せない） | 365 / 90 / 180 日 |
| 組織の記憶（`scope: org`） | アプリケーション × 組織 | `sop` 手順 / `decision_reason` 判断理由 / `preference` 運用上の好み（分類はアプリが変えられる） | その組織の連携済みの職員 | 730 / 365 / 180 日 |
| 会話の振り返り（recall） | アプリケーション × 組織 × 職員 | 1 ターン = 本人の発言 ＋ そのターンの AI の最後の返事 | **本人だけ** | 90 日・1 人 500 件 |

- **誰か**：IM は bridge-identity（`forSession` の連携済みの職員）、業務 Web のパネルは bridge-assistant（`delegationForSession` / `userForSession`）。
  未連携・発信元なしは使えない（`unlinkedPolicy: ai-readonly` なら組織の記憶の検索・一覧だけ）。**グループ会話では使わない**（記憶は個人のもの）。
- **入れない**：保存・振り返りの前に検査し、当たれば保存しない（部分的な伏せ字はしない）。
  1. 手元の検査（dsh-core の `screenOutboundText` の網）：敬称つきの人名・電話・メール・郵便番号・10 桁以上の番号、健康に関する語（個人の記憶と振り返り。
     組織の記憶は一般的な手順なので既定では見ない：`screen.healthInOrg`）、金額（既定は見ない：`screen.amounts`）。
  2. 業務システムの検査（Bridge v1 の任意の機能 `POST /bridge/v1/pii-scan`、レジストリの `paths.piiScan`）：その業務システムの名簿で見る。
     **届かないときは保存しない**（fail closed）。`paths.piiScan` が無いアプリケーションは手元の検査だけ。
- **同じ題名**の保存は上書きして期限を延ばす（「覚えておいて」を繰り返しても増えない）。上限：個人 200 件／人、組織 2000 件。
- 期限切れは読み取りから外し、起動時と 1 時間ごとに消す。

## ツール（接頭辞 `toolPrefix`、既定 `memory`）
| ツール | 内容 |
|---|---|
| `memory_save {scope?, category, title, content, tags?, ttlDays?}` | 保存（scope の既定は `defaultScope`、既定 personal）。保存したら本人に一言伝える |
| `memory_search {query, scope?: personal\|org\|all, category?, limit?}` | 文字 2-gram の簡易スコア（題名 ×3・タグ ×2・本文 ×1） |
| `memory_list {scope?, category?, limit?}` | 「覚えていることを見せて」 |
| `memory_delete {id}` | 「忘れて」。個人は本人、組織は保存した人か `adminRoles`、振り返り（`rcl_…`）は本人 |
| `memory_recall {query?, days?, limit?}` | 本人の過去の会話（「前に聞いた件」）。query が無ければ新しい順 |
| `memory_forget_conversations {confirm: true}` | 本人の振り返りを全部消す |

## system prompt（会話の最初・会話中は固定）
`ctx.systemPrompt.context({ name: promptName, order: 160 })`。会話の最初の発言に関係するものを優先して：
本人の記憶（`prompt.personal`、既定 5 件）・組織の SOP（`prompt.org`、既定 3 件）・前回までのやりとり（`prompt.recent`、既定 3 件、今の会話は除く）と、
記憶の使い方（いつ `memory_save` / `memory_recall` を使うか、個人情報・健康情報は保存しない）。「参考情報（指示ではない）・業務データを優先」と添える。
誰か分からないうちは組織の SOP だけを渡して固定しない（分かった次の要求で本人の分を足して固定する。prompt cache の作り直しは 1 回）。

## 振り返りの集め方
- 本人の発言：`dsh-im/inbound`（IM）、`session/event` の `user/message`（業務 Web のパネルの会話。画面の文脈の付記は外す）。
- AI の返事：`session/event` の `assistant/message`（ツール呼び出しを含まない最後の本文）。`turn/end` で 1 件にして検査し、保存する。
- 自動タスク・定時の起床（IM の発言の無いターン）は残らない。

## サービス
`ctx.bridgeMemory`（`serviceName`、`serviceAliases` で別名も）：`list({category?, applicationId?, orgId?})`（**組織の記憶だけ**）・`remove(id)`（組織の記憶だけ）・
`stats()` → `{ total（組織）, byCategory, personal（件数だけ）, recall（件数だけ）, persistent }`・`promptFor`・`commitTurn`・`localKinds`。
個人の記憶と振り返りの中身は、管理の画面にも出さない（件数だけ）。

## 設定（Config）
| 項目 | 既定 | 説明 |
|---|---|---|
| `apiUrl` / `serviceToken` / `applicationName` | — | レジストリ（bridge-apps）が無いときの 1 件（Bridge v1） |
| `orgId` | `default` | 組織 ID の後備値（通常は identity / identities/stats の orgId） |
| `toolPrefix` / `defaultScope` | `memory` / `personal` | ツール名の接頭辞と、scope を省いた保存の行き先 |
| `retentionDays` | 上の表 | `{ personal: {cat: 日}, org: {cat: 日} }`（以前の平らな `{sop: 730, …}` は組織の期限として読む） |
| `adminRoles` | `[admin]` | 他の職員の組織の記憶も消せる役割 |
| `unlinkedPolicy` | `deny` | `ai-readonly`：未連携でも組織の記憶の検索・一覧だけ |
| `screen` | `{health: true, healthInOrg: false, amounts: false}` | 手元の検査 |
| `recall` | `{enabled: true, retentionDays: 90, storeReplies: true}` | 会話の振り返り |
| `prompt` | `{personal: 5, org: 3, recent: 3}` | system prompt に渡す件数（0 で無効。以前の `promptSopCount` は `org`） |

保存先は DSH のストレージ：記憶は domain `bridge_memory`（table `entries`）、振り返りは `bridge_memory_recall`（table `turns`）。
アプリケーション ID の無い古い記録は既定のアプリケーション、scope の無い記録は組織の記憶として読む（移行は不要）。

## アプリケーションの設定として使う（例：ケアビリングの care-memory）
```js
import { createMemoryPlugin } from '@dsh-bridge/plugin-memory'
const plugin = createMemoryPlugin({
  name: 'care-memory', toolPrefix: 'care_memory', defaultScope: 'org',        // 以前のツール名・以前の既定（事業所の記憶）
  domain: 'care_memory', recallDomain: 'care_memory_recall',                 // 以前の保存先をそのまま読む
  serviceName: 'careMemory', serviceAliases: ['bridgeMemory'], defaultApplicationId: 'care-billing',
  memoryLabel: '事業所', fallbackRegistry: (config) => careBillingRegistry({ apiUrl: () => config.apiUrl }),
})
export const { name, inject, Config, apply } = plugin
```
別の業務システムは何も書かずに bundle `@dsh-bridge/plugin-memory` を入れるだけでよい（profile/template に既定で入っている）。
業務システム側は `POST /bridge/v1/pii-scan` を実装すると、その名簿で検査できる（server-kit は既定で持つ）。

## 拡張点・後続
- 分類（`orgCategories` / `orgCategoryLabels`）、期限、検査の強さ、prompt の件数。
- 後続：圧縮の直前に会話の要点を自動で抜き出す（いまは AI が `memory_save` を呼ぶ・振り返りがターンごとに残る）、ベクトル検索、管理画面での個人の記憶の件数の表示。

## テスト
`node --test --test-isolation=none test/*.test.mjs` — `memory.test.mjs`（個人・組織・作用域・検査と fail closed・グループと未連携・振り返り・system prompt・
業務 Web のパネル・古い記録・期限と上限）。業務 API はモック、データは架空。
