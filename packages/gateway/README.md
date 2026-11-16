# @dsh-bridge/gateway

業務 Web の BFF に組み込み、DSH の設定画面を業務 Web の `/dsh/*` で安全に表示するための認証ゲートウェイ。
ESM・Node の組み込みモジュールのみ。構成の全体は `docs/ARCHITECTURE.md`。

```js
import { createDshGateway, gatewayOptionsFromEnv } from '@dsh-bridge/gateway'

const env = gatewayOptionsFromEnv(process.env)          // null = 未設定（/dsh は 503 にする）
const gateway = env && createDshGateway({
  target: env.target,                                   // DSH_URL（既定 http://127.0.0.1:3180）
  mountPath: env.mountPath,                             // DSH_MOUNT_PATH（既定 /dsh）
  publicPaths: env.publicPaths,                         // DSH_PUBLIC_HOOK_PATHS の完全一致パス
  publicPrefixes: env.publicPrefixes,                   // DSH_PUBLIC_HOOK_PATHS の '/wecom-app-callback/*'
  launchToken: env.launchToken,                         // DSH_LAUNCH_LOG / DSH_SUPERVISE=1 / DSH_LAUNCH_TOKEN
  getSessionUser: async (req) => /* 業務 API のログイン確認（例 GET /api/auth/me）を req の cookie で呼ぶ */ null,
  isAllowed: (u) => u?.role === 'admin',
  rpcAllowlist: [/* 下記 */],
})

http.createServer(async (req, res) => {
  if (gateway && await gateway.handleRequest(req, res)) return   // ← /api/* を業務 API に流すより「前」に呼ぶ
  // ... 静的配信 / 業務 API プロキシ
}).on('upgrade', async (req, socket, head) => {
  if (gateway && await gateway.handleUpgrade(req, socket, head)) return
  socket.destroy()
})
```

- `/dsh` → 308 `/dsh/`。`getSessionUser` が null → 401、`isAllowed` が false → 403（JSON）。cross-site / 他オリジンの `Origin` → 403。
- launch token → cookie 交換はサーバ側。DSH の cookie はメモリ内 jar にだけ持ち、ブラウザには出さない（`Set-Cookie` は吸収）。ブラウザの
  cookie・`Authorization`・`x-service-token`・`x-bff-secret`・`x-delegation-token`・`x-bridge-actor`（旧名 `x-care-actor`）は DSH に転送しない
  （`DEFAULT_STRIP_REQUEST_HEADERS`。業務固有のヘッダは `stripRequestHeaders` で足す）。
- DSH が 401 を返したら（再起動・期限切れ）自動で再交換し、GET/HEAD/upgrade は 1 回だけ再送する。
- 応答に `X-Frame-Options: SAMEORIGIN` と `Content-Security-Policy: frame-ancestors 'self'` を付ける（上流のフレーム埋め込みポリシーは上書き）。
- `rootPaths`（既定 `DEFAULT_ROOT_PATHS`）：マウントを無視して絶対 URL を叩くプラグイン（dsh-proactive・dsh-auto-tasks）の経路も同じ認可で中継する。

テスト：`node --test --test-isolation=none test/*.test.mjs`（ルートでは `pnpm test:gateway`）。試験サーバ：`examples/trial-server.mjs`（:3190、固定の偽 admin）。

## 環境変数（`gatewayOptionsFromEnv` / `launchTokenFromEnv` / `readEnv`）

ゲートウェイ本体（`createDshGateway`）は環境変数を読まない。BFF が同じ名前を使えるように、読み方をここにまとめる。

| 名前 | 意味 | 旧名（読むのは新しい名前が空のときだけ） |
|---|---|---|
| `DSH_URL` | DSH の listener（既定 `http://127.0.0.1:3180`） | |
| `DSH_MOUNT_PATH` | BFF 内のマウント（既定 `/dsh`） | |
| `DSH_LAUNCH_LOG` | DSH の起動ログ（`dsh web: ...?token=`）のファイル → `fromFile` | |
| `DSH_SUPERVISE=1` | BFF が DSH を子プロセスとして起動する → `supervise`（`DSH_HOME` 必須。個人の `~/.dsh` は使わない） | |
| `DSH_HOME` / `DSH_PROFILE` / `DSH_BIN` | supervise する DSH のホーム・製品 profile 名（既定 `bridge`）・CLI の場所 | |
| `DSH_PUBLIC_URL` / `PUBLIC_ORIGIN` | supervise する DSH の `--public-url`（既定 `<PUBLIC_ORIGIN>/dsh/`、`PUBLIC_ORIGIN` の既定 `http://127.0.0.1:3010`） | |
| `DSH_LAUNCH_TOKEN` | launch token の値（または `?token=` 付き URL）→ `fromEnv` | |
| `DSH_PUBLIC_HOOK_PATHS` | カンマ区切りの公開 webhook（`/dsh-hooks/line,/dsh-hooks/teams,/wecom-app-callback/*`） | |
| `DSH_WECOM_APP_CALLBACK_URL` | `/wecom-app-callback/*` の転送先（既定 `DSH_URL` のホストの 30987） | |
| `BRIDGE_API_URL` | BFF が前に立つ業務 API（supervise する DSH にも `BRIDGE_API_URL` として渡す） | `CARE_API_URL` |
| `BRIDGE_BFF_SECRET` | 業務 API と共有する BFF 専用の秘密（`x-bff-secret`） | `CARE_BFF_SECRET` |
| `BRIDGE_DSH_WORKSPACE` | supervise する DSH の作業ディレクトリ（既定 `<DSH_HOME>/workspace`） | `CARE_DSH_WORKSPACE` |

旧名はケアビリング（最初の利用者）の BFF との互換のため（`ENV_ALIASES`）。supervise する DSH の環境に旧名が必要なら
`launchTokenFromEnv(env, { childEnv: { CARE_API_URL: ... } })` で足す。launch token の優先順は `DSH_LAUNCH_LOG` → `DSH_SUPERVISE=1` →
`DSH_LAUNCH_TOKEN`。どれも無く `DSH_URL` も無ければ `gatewayOptionsFromEnv` は `null`（BFF は `/dsh` を 503 `dsh_gateway_not_configured` にする）。

## 公開 webhook パス（`publicPaths` / `publicPrefixes`）

```js
createDshGateway({
  // ...
  ...splitPublicHooks(process.env.DSH_PUBLIC_HOOK_PATHS, { dshUrl: process.env.DSH_URL }), // 例: '/dsh-hooks/line,/dsh-hooks/teams'
})
```

- **完全一致**のパス名への **POST だけ**を、BFF の認証なしで DSH に転送する（オリジン直下のパスのまま。マウント配下のパスは指定不可）。同じパスへの他メソッドは 405、`/dsh-hooks/line/` や `/dsh-hooks/line/x` のような近いパスは対象外（BFF に落ちる）。
- ブラウザの cookie・actor ヘッダ・`x-service-token`・`forwarded` 系ヘッダは落とし、**DSH の cookie は注入しない**（launch token 交換も起きない）。`Authorization`（Teams の Bot Framework JWT）と `X-Line-Signature` はそのまま渡す。上流の `Set-Cookie` は返さない。
- `publicPrefixes`：WeCom（企業微信）の自社開発アプリのコールバック `/wecom-app-callback/<botId>/<secret>`（dsh-im の別 listener、既定ポート 30987）。接頭辞の下は 1〜4 個の単純なセグメントだけ、パスと query はそのまま（WeCom が署名する）、既定は GET（URL 検証）+ POST。
- 署名検証は DSH 側（dsh-im の `/dsh-hooks/line` = HMAC-SHA256、`/dsh-hooks/teams` = Bot Framework JWT、wecom-app = msg_signature）で行う。未指定なら空（何も公開しない）。

## サーバ側 RPC（`gateway.rpc`、許可リスト必須）

admin 以外の利用者が自分の画面（例：「IM 連携」で自分の WeChat を QR 接続）から dsh-im の管理 RPC を使うとき、BFF はブラウザを `/dsh/*` に通さず、サーバ側でこれを呼ぶ。

```js
const gateway = createDshGateway({
  // ...
  rpcAllowlist: [
    { channel: '/weixin', methods: ['provision.begin', 'provision.poll', 'provision.verify', 'provision.cancel', 'bot.delete'] },
    // dsh-im 以外のプラグイン：業務 Web の AI アシスタント（@dsh-bridge/plugin-assistant。POST /api/bridge-assistant/assistant、method bridge-assistant/assistant）
    { plugin: 'bridge-assistant', channel: '/assistant', methods: ['agents.list', 'conversation.get', 'message.send', 'message.cancel', 'conversation.reset'] },
  ],
})
const result = await gateway.rpc('/weixin', 'provision.begin', {}, { signal })
const answer = await gateway.rpc('/assistant', 'message.send', { ticket, agent: 'business-assistant', text }, { plugin: 'bridge-assistant' })
// ticket = POST /bridge/v1/assistant/tickets of the business system for the employee's own web session (BFF only).
// Errors of the assistant: ticket-invalid / api-unavailable（業務 API に届かない）/ rate-limited / agent-busy / text-too-long / ...（plugin-assistant README）
// agents.list の各 agent の displayName = AI 社員の呼び名（パネルの見出し）。harness-unavailable は DSH の Harness（typertGateway）に届かないとき
// → { ok: true, value } | { ok: false, error: { code, message } }（DSH-IM の result をそのまま返す）
```

- `POST {target}/api/dsh-im{channel}`（`plugin` 指定時は `/api/<plugin><channel>`）に `{ type: 'client-request', rpcId, method, payload: { method, payload } }` を送り、`server-response` の `result` だけを返す。owner cookie はゲートウェイが注入し、戻り値・例外に cookie は含まれない。DSH が 401（再起動・期限切れ）なら launch token を再交換して 1 回だけ再送する。
- **許可リスト外は DSH に送らずに拒否**（`error.code === 'rpc_not_allowed'`）。既定は空 = すべて拒否。それ以外の失敗は `dsh_rpc_failed`（`status` 付き）/ `dsh_rpc_timeout`。
- WeChat の method 名（`vendor/dsh-im/plugin-src/host/channels/weixin/rpc.mjs` の `WEIXIN_ENDPOINTS`）：QR 作成 `provision.begin` `{}`（または `{ locale: 'zh-CN' }`）、状態確認 `provision.poll` `{ attemptId }`、確認コード入力 `provision.verify` `{ attemptId, verifyCode }`（4〜8 桁。求められた場合のみ）、中止 `provision.cancel` `{ attemptId }`、ボット削除 `bot.delete` `{ botId, confirm: true }`。
- **所有者の確認は BFF の責任**：ゲートウェイは「どの利用者のボットか」を知らない。`bot.delete` の `botId` がその利用者自身の接続であることを BFF（業務 API の連携記録）で確かめてから呼ぶこと。

## AI アシスタントの添付（`prepareAssistantAttachments`、`@dsh-bridge/gateway/assistant-attachments`）

業務 Web のパネルから `POST /api/assistant/messages` に `attachments: [{ name, mediaType, data（base64） }]` が来たときの BFF の部品（docs/ASSISTANT_ATTACHMENTS.md）。
依存なしの純粋な関数で、ネットワークには触らない（業務システムへの呼び出しは `callPrepare` として BFF が渡す）。

```js
import { prepareAssistantAttachments, DEFAULT_ATTACHMENT_PROMPT } from '@dsh-bridge/gateway'
const r = await prepareAssistantAttachments({
  files: body.attachments,                    // ブラウザの [{ name, mediaType, data }]
  settings,                                   // 任意：GET /bridge/v1/assistant/attachment-settings の { enabled, types }
  imagesSupported: agent.capabilities?.images, // 任意：false なら画像を断る（null = 分からない → 通す）
  limits,                                     // 任意：{ maxFiles, maxFileBytes, maxTotalBytes }（小さくするだけ）
  // 本人の cookie と x-bff-secret を付けて POST /bridge/v1/assistant/attachments/prepare（画像は data なし、文書は data 付き）
  callPrepare: (body) => callBusiness('POST', '/bridge/v1/assistant/attachments/prepare', body, { cookie, bffSecret }),
})
if (!r.ok) return send(r.status, { ok: false, error: r.error, details: r.details })   // 403 / 422 / 502
await gateway.rpc('/assistant', 'message.send', { ticket, agent, text, attachments: r.attachments }, { plugin: 'bridge-assistant' })
```

- 先に確かめること：件数（5）・1 ファイル 10 MB・合計 20 MB（デコード後）・名前・base64・拡張子と先頭バイトの一致・設定の種類・モデルの画像対応。
  業務システムも同じことをもう一度確かめる（文書の中身・マクロ付きの Office など、深い検査はそちら）。
- 戻り値：`{ ok: true, attachments, summary: { count, types, totalBytes }, labels: [{ name, kind }] }`。`attachments` は message.send の形
  （画像 `{ kind:'image', mediaType, data, name }`、文書 `{ kind:'document', name, kind2, text, truncated, pageImages? }`）。失敗は `{ ok: false, error, status, details? }`
  （`attachmentErrorStatus`：`attachments_not_allowed` 403、業務システムに届かない `attachment_prepare_failed` 502、ほかは 422）。
- ファイル名・中身はログに出さない（`summary` は件数・種類・大きさだけ）。文が空なら `DEFAULT_ATTACHMENT_PROMPT`（bridge-assistant も同じ文を使う）。
- スキャンの PDF（OCR）：業務システムが返した文書の `pageImages`（JPEG のページ、`MAX_SCANNED_PAGES` = 10 まで、形の正しいものだけ）を文書の添付に付けて渡す。
  `labels` には `scannedPages`（枚数）。`imagesSupported === false` のときは `images_not_supported`（`details.reason: 'scanned_pdf'`）。

## supervise（DSH を BFF の子プロセスとして動かす）

`supervise({ command, args, env, cwd })` は DSH を起動して stdout から launch token を読み、予期しない終了では再起動する（間隔は倍々で最大 30 秒）。
ログに流す行は token を伏せる（`redactToken`）。`resolveDshBin()` は `DSH_BIN` → `pnpm root -g` → `npm root -g` の順に `@deepseek-ai/dsh/lib/bin.js` を探す
（Windows の `.cmd` を shell 経由で起動しない：shell を殺すと本体が残るため）。
