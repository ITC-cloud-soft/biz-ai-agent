# @dsh-bridge/testing

Test helpers for systems built on the DSH Business Bridge. Nothing here talks to a real model or a real IM platform: every
mock listens on `127.0.0.1` (port `0` = a free port; use the returned `url`) and records what it received.

| module | exports | what it is |
|---|---|---|
| `mock-llm` | `startMockLlm({ script, expectKey?, model? })`, `conversationTail`, `findTool` | OpenAI Chat Completions compatible server (`/v1/models`, `/v1/chat/completions`, `stream: true` SSE with `tool_calls` deltas). A **script** decides each answer: `({ body, userText, toolResults, toolCalls, findTool }) => ({ toolCall: { name, arguments } } \| { text })`. Point a DSH LLM provider (`openai-completions`) at `url`. |
| `mock-line` | `startMockLine({ channelAccessToken, botUserId? })`, `lineWebhookSender`, `signLineBody`, `flexSummary`, `randomLineUserId` | LINE Messaging API (`/v2/bot/info`, reply, push with `X-Line-Retry-Key` dedupe, loading). `lineWebhookSender` posts signed webhooks to a public hook path (`/dsh-hooks/line`). vendor/dsh-im is pointed at it with its test override `CARE_DSH_IM_LINE_API_BASE` (the fork's variable name, loopback only). |
| `mock-ilink` | `startMockIlink({ accountId?, ownerUserId?, holdMs? })` | Personal WeChat iLink API (QR that confirms at once, long-poll `getupdates`, `sendmessage`). `inbound(from, text, { quote })` queues a user message. Override in the fork: `CARE_DSH_IM_WEIXIN_API_BASE`. |
| `mock-wecom` | `startMockWecom({ corpId? })`, `wecomEncrypt`, `randomEncodingAesKey` | WeCom self-built app API (`gettoken`, `message/send`) and the callback side: `callback(app, url, from, text)` encrypts like WXBizMsgCrypt and POSTs to dsh-im's `/wecom-app-callback/<botId>/<secret>`. `createApp(agentId)` makes fresh test credentials. |
| `procs` | `startProcess`, `waitFor`, `sleep`, `portFree`, `killTree`, `sanitizedEnv`, `SECRET_ENV_RE` | child processes with redacted logs, polling, port checks, an environment without real keys / tokens / DB URLs / existing `DSH_*` `BRIDGE_*` `CARE_*` settings. |
| `dsh-home` | `prepareIsolatedHome`, `assertIsolatedHome`, `dshEnv`, `startDsh`, `launchTokenOf`, `redactor`, `assertPortsUsable`, `RUNTIME_STATE_ENTRIES` | an isolated DSH home (`<repo>/.dsh-home-<name>`; the personal `~/.dsh` is refused), the child environment for it, starting DSH on it and waiting for the launch token, refusing reserved ports. |
| `dsh-host` | `dshHostClient({ port, token })` | minimal client of a running DSH: launch-token exchange, host RPC (`session.create` ...), dsh-im management RPC, auto-tasks HTTP. |
| `auto-task-templates` | `loadTemplates`, `installAutoTaskTemplates` | install auto-task templates (`profile/auto-tasks` format) into `$DSH_HOME/auto-tasks/tasks.json` the way `profile/scripts/install.mjs` does. |

```js
import { startMockLlm, startMockLine, prepareIsolatedHome, startDsh } from '@dsh-bridge/testing'
import { resolveDshBin } from '@dsh-bridge/gateway'

const llm = await startMockLlm({ script: ({ findTool }) => ({ toolCall: { name: findTool('example_app_list_reports'), arguments: {} } }) })
const line = await startMockLine({ channelAccessToken: 'test-line-access-token' })
const { home } = prepareIsolatedHome('.dsh-home-mytest')
const { proc, token } = await startDsh({ bin: resolveDshBin(), home, profile: 'my-product', port: 3199, env: { CARE_DSH_IM_LINE_API_BASE: line.url } })
// ... drive the scenario, then
await proc.stop(); await line.close(); await llm.close()
```

Rules for scenario tests: only test values (generated per run), only loopback, an isolated home, never the ports of a demo or
production deployment (`assertPortsUsable(ports, { forbidden: [...] })`). Business scenarios stay in the business system's
repository; this package only has the generic parts. There is no Slack mock yet.

Tests: `node --test --test-isolation=none test/*.test.mjs` (root: `pnpm test:testing`).

## Framework end-to-end test (`e2e/run.mjs`, root: `pnpm run e2e`)

The whole framework on a **real DSH** (the globally installed DSH CLI), with the mocks above and nothing real:

```sh
FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres pnpm run e2e        # [-- --keep | --reuse-home | --json-only | --story]
pnpm demo                    # the same run with a throwaway PostgreSQL container (Docker) and --story: the conversation at the end
```

- `examples/equipment-inspection` on its own port with a temporary database `fw_equipment_e2e_test` (only the server and
  credentials of `FW_TEST_DATABASE_URL` — or `EQUIPMENT_DATABASE_URL` — are used; the database is dropped before and after),
  generated service token / BFF secret / seed password, scheduler off. A recording stub plays a second application (`example-app`).
- `profile/template` is made into a product profile in `e2e/.work/profile-src` (placeholders filled for equipment-inspection,
  `toolModules` with `@dsh-bridge/plugin-tools/examples/equipment-inspection`, the playbook preset `facility-inspection`, e2e
  timings) and installed with `profile/scripts/install.mjs --source --framework-root --auto-task-delegate line:<manager>` into an
  isolated home (`<framework>/.dsh-home-e2e`, `FW_E2E_HOME`; never `~/.dsh`). DSH runs with a `--patch` overlay for the mock
  model, behind `@dsh-bridge/gateway` (public LINE webhook path, server-side RPC to bind the LINE bot).
- Scenarios, each PASS / FAIL, plus a JSON summary (last stdout line) and `e2e/.work/result.json`: **a** unlinked guide → link
  code (link page / API) → 「連携 123456」; **b** question → manifest-generated `facility_list_overdue` under the employee's
  delegation; **c** `inspection.overdue` → bridge-notify → LINE with 【対応のお願い】 / ▶ / `— 設備点検 AI 秘書`; **d** repair
  request → approval card → button (and reply code) decides it in the app → card updated to 【ご報告】; **e** the manifest playbook
  `overdue_followup` (deployed by bridge-events, enabled with `install.mjs --enable-auto-tasks pb_equipment-inspection_overdue_followup`)
  runs once per event (a replay is deduped) and proposes with `facility_propose_reschedule`; **f** another application's tool is
  refused (nothing reaches it), a read tool outside the role is refused, a delegation token cannot write.
- Ports `FW_E2E_PORTS` (default `app=19741,dsh=3241,llm=3242,line=3243,gateway=3244,other=3245`; 3080 / 3180 / 8790 / 3010 /
  19720 / 19730 are refused). Cleanup: the processes started by the run, the database and the home (`--reuse-home` keeps the
  installed profile dependencies for the next run, `--keep` keeps everything). Exit code 0 = all scenarios passed, 2 = no database URL.
