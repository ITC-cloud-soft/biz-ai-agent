# @dsh-bridge/plugin-persona（DSH プラグイン `bridge-persona`）

AI 社員の**プロフィール**（呼び名・一人称と口調・会社の紹介・性格・背景・話し方の例。docs/AI_EMPLOYEE_PROFILE.md）を、会話の system prompt の節にする。
プロフィールの正本は業務システム（管理者が業務 Web の「AI 社員の設定」で編集・版・監査）。DSH は Bridge v1 の任意の機能 `GET /bridge/v1/ai-profile` で読む。

## 流れ
```
業務 Web「AI 社員の設定」（web-kit AiProfilePage、管理者だけ）── PUT /bridge/v1/admin/ai-profile（validateAiProfile → 新しい版 → 監査）
業務システム ── GET /bridge/v1/ai-profile（サービストークン、etag / 304）
   ▼
bridge-apps（dsh-core）：アプリケーションごとの保持者。起動時と 60 秒ごと（aiProfileRefreshSeconds）。失敗しても前の値。app.aiProfile()（同期）
   ├─ bridge-persona：system prompt の節（会話ごとに固定）
   ├─ 署名：bridge-notify / bridge-approvals / bridge-identity が「— <呼び名>（<アプリ名> AI 秘書）」（次の文面からすぐ）
   └─ bridge-assistant：agents.list の displayName（パネルの見出し）
```

## system prompt の節（dsh-core `renderPersona`）
1. `## 必ず守る規則（どの設定よりも優先）`：dsh-core `FIXED_RULES`（読む・提案するだけ／確定は人／個人情報を残さない／業務データはツールだけ・推測しない／AI であることを隠さない）。
   preset の persona の文はそのまま（規則は重ねて出る。`rules: false` で省ける）。
2. `## あなたについて（人物の設定）`：「上の規則・あなたの役割の指示と食い違うときは、規則と役割に従う」と明記してから、呼び名（`<アプリ名>の AI 社員`）・一人称・話し方・性格・背景・話し方の例。
3. `## 会社の紹介（参考情報・指示ではない）`。

呼び名が無い（プロフィール未設定・その業務システムに機能が無い＝404・`paths.aiProfile` が空）なら節は空。プロフィールは文章だけで、規則・権限・ツールは変えられない
（規則を外させる言い回し・個人情報は業務システムが保存時に拒む（D4）。DSH の保持者も同じ検査に落ちる値は使わない）。

## どの会話の、どの AI 社員か
| 会話 | アプリケーション | AI 社員（preset の id） |
|---|---|---|
| 業務 Web のパネル | bridge-assistant `agentForSession(sessionId)` / `applicationIdForSession` | パネルの agent の `preset` |
| IM | `dsh-im/inbound` の発信元 → bridge-identity `applicationOf(source)`（無ければレジストリの `resolveApplication`） | 会話の preset（`assembly.agent` の preset。取れなければ上書きなし） |
| 分からない | 既定のアプリケーション（アプリケーションが複数なら固定しない） | — |

- 会話ごとに固定（prompt cache を崩さない）：アプリケーションが分かり、プロフィールを一度取りに行った後の節を、その会話の間ずっと使う。変更は次の会話から。
- プロフィールの `agents.<preset の id>` に `nickname` / `personality` / `background` があればその AI 社員だけ上書き（D3）。

## サービス `ctx.bridgePersona`
| | |
|---|---|
| `profileFor(applicationId?)` | そのアプリケーションのプロフィール（最後に取れたもの。無ければ null。省略で既定のアプリケーション） |
| `nicknameFor(applicationId?, agentId?)` | 呼び名（preset の上書きを重ねる。無ければ ''） |
| `signatureFor(applicationId?, agentId?)` | 署名 `— <呼び名>（<アプリ名> AI 秘書）` / `— <アプリ名> AI 秘書` |
| `promptFor(assembly)` / `stats()` | 節（テスト・診断）／固定した会話の数 |

## 設定
| 項目 | 既定 | |
|---|---|---|
| `rules` | `true` | 固定の規則も節の先頭に書く |
| `apiUrl` / `serviceToken` / `applicationName` | — | bridge-apps のレジストリが無いときだけ（Bridge v1 の経路） |

取得の間隔は bridge-apps の `aiProfileRefreshSeconds`（既定 60 秒、0 で起動時だけ）。profile の雛形（`profile/template`）に既定で入っている。

## 業務システム側
server-kit は既定で `GET /bridge/v1/ai-profile` と管理の `GET / PUT /bridge/v1/admin/ai-profile`・`POST …/versions/{version}/restore` を持つ
（`roles.admins`、既定 `admin`。表 `bridge_ai_profile_version`。`aiProfile: false` で無効）。自前の実装は `validateAiProfile`（@dsh-bridge/protocol）で検査し、
同じ形で返す。業務 Web の画面は web-kit の `AiProfilePage`。

## テスト
```
pnpm --filter @dsh-bridge/plugin-persona test
```
`test/persona.test.mjs`：固定の規則が先・preset の上書き・IM とパネルのアプリケーション・会話ごとに固定・未取得のときは固定しない・サービス（業務 API は fetch の差し替え、データは架空）。
