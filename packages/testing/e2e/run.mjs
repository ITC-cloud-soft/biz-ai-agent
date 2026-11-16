#!/usr/bin/env node
// Framework end-to-end test: the example business system (examples/equipment-inspection) + the framework profile
// (profile/template made into a product profile) + the framework plugins on a REAL DSH, with a mock LLM and a mock LINE.
// No real IM, no real model, no real keys: every secret is generated per run.
//
//   FW_TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres pnpm run e2e [-- --keep] [-- --reuse-home] [-- --json-only]
//
// 1. PostgreSQL: a temporary database fw_equipment_e2e_test (dropped before and after). The server and credentials come
//    from FW_TEST_DATABASE_URL (or EQUIPMENT_DATABASE_URL); only the server / credentials are used, never its database.
// 2. examples/equipment-inspection on its own port (scheduler off, fictional seed, generated service token / BFF secret /
//    seed password) and a tiny second Bridge application "example-app" (a recording stub) to prove application isolation.
// 3. profile/template → a product profile in .work/ (placeholders filled for equipment-inspection, the hand-written propose
//    tool via toolModules, the playbook preset facility-inspection, e2e timings) → profile/scripts/install.mjs --source
//    --framework-root --auto-task-delegate line:<manager> into an isolated home (.dsh-home-e2e; never ~/.dsh), then the
//    real DSH CLI with a --patch overlay (mock LLM provider) and @dsh-bridge/gateway in front (LINE webhook path, server RPC).
//    The DSH CLI is a local copy of the pinned version (.dsh-cli/<version>, installed with npm on first use; the global DSH
//    is never used or changed) unless DSH_BIN points at another bin.js (packages/testing/src/dsh-cli.mjs).
// 4. Scenarios (PASS / FAIL per scenario and a JSON result in .work/result.json):
//    a  unlinked LINE user gets the guide (no LLM), also for a business question (no tool, no delegation, no business data);
//       link code from the app (link page + API) → 「連携 123456」 links
//    b  a question → the AI calls a manifest-generated read tool (facility_list_overdue) under the employee's delegation
//    c  inspection.overdue → bridge-events → bridge-notify → the linked users' LINE with the AI 秘書 frame
//       (【対応のお願い】, ▶ line, — 設備点検 AI 秘書)
//    d  repair request → approval card on the approver's LINE → button decides it in the app → card updated to 【ご報告】;
//       a second request is rejected with the reply code (「差戻 123456 理由」)
//    e  manifest playbook overdue_followup (deployed by bridge-events, enabled with install.mjs --enable-auto-tasks <id>,
//       delegate from --auto-task-delegate) runs once per event and proposes via facility_propose_reschedule; its report reaches
//       the event's audience as the fixed text only (the template profile is closed by default: audienceText template, …)
//    g  link guard on the real DSH (bridge-identity → dsh-im setAnswerFilter): the AI's answer keeps the business web's screen
//       (manifest web.routes) and loses the outside link before it reaches LINE
//    f  isolation: another application's tool is refused in this conversation (no token sent there), a read tool outside
//       the employee's role is refused, a delegation token cannot write
// 5. Cleanup: only the processes started here, the database, the isolated home (--keep keeps them; --reuse-home keeps
//    the installed profile dependencies between runs).
//
// Ports (override with FW_E2E_PORTS="app=19741,dsh=3241,llm=3242,line=3243,gateway=3244,other=3245"): never 3080, 3180,
// 8790, 3010, 19720, 19730. Home: FW_E2E_HOME (default <framework>/.dsh-home-e2e).

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshGateway, fromValue } from '../../gateway/src/index.mjs'
import { dropDatabase, ensureDatabase, loadPg } from '../../server-kit/src/store/pg.mjs'
import { pickDshBin } from '../src/dsh-cli.mjs'
import { assertIsolatedHome, assertPortsUsable, redactor, startDsh } from '../src/dsh-home.mjs'
import { dshHostClient } from '../src/dsh-host.mjs'
import { flexSummary, lineWebhookSender, randomLineUserId, startMockLine } from '../src/mock-line.mjs'
import { startMockLlm } from '../src/mock-llm.mjs'
import { printStory } from './story.mjs'
import { sanitizedEnv, sleep, startProcess, waitFor } from '../src/procs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FRAMEWORK = resolve(here, '..', '..', '..')
const WORK = process.env.FW_E2E_WORK ? resolve(FRAMEWORK, process.env.FW_E2E_WORK) : join(here, '.work')
const args = new Set(process.argv.slice(2))
const KEEP = args.has('--keep')
const REUSE_HOME = args.has('--reuse-home') // keep the installed profile dependencies between runs (install.mjs still refreshes the framework packages)
const JSON_ONLY = args.has('--json-only')
let DSH // the DSH CLI bin.js (preflight)
const STORY = args.has('--story') // print the conversation as a chat transcript at the end (pnpm demo)

const PORT_KEYS = ['app', 'dsh', 'llm', 'line', 'gateway', 'other']
function parsePorts(raw) {
  const out = {}
  for (const part of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, value] = part.split('=')
    if (!PORT_KEYS.includes(key) || !/^\d{2,5}$/.test(value ?? '')) throw new Error(`FW_E2E_PORTS: bad entry ${part}`)
    out[key] = Number(value)
  }
  return out
}
const PORTS = { app: 19741, dsh: 3241, llm: 3242, line: 3243, gateway: 3244, other: 3245, ...parsePorts(process.env.FW_E2E_PORTS) }
const FORBIDDEN_PORTS = [3080, 3180, 8790, 3010, 19720, 19730]
const HOME = resolve(FRAMEWORK, process.env.FW_E2E_HOME || '.dsh-home-e2e')
const PROFILE = 'fw-e2e'
const APP_ID = 'equipment-inspection'
const APP_NAME = '設備点検'
const PLAYBOOK_TASK = `pb_${APP_ID}_overdue_followup`
// the fixed text of an automatic-task report (bridge-notify audienceTemplate, needsDecision)
const AUTO_TASK_REPORT = /AI が自動処理で、確認していただきたい内容をまとめました。/
const DB_NAME = 'fw_equipment_e2e_test'
const PROTECTED_DATABASES = ['care', 'care_ui', 'care_test', 'care_joint', 'bridge_demo', 'bridge_demo_test', 'equipment_inspection']
const SERVER_URL = process.env.FW_TEST_DATABASE_URL || process.env.EQUIPMENT_DATABASE_URL || ''
const dbUrl = (() => { if (!SERVER_URL) return ''; const u = new URL(SERVER_URL); u.pathname = `/${DB_NAME}`; return u.toString() })()

// test values generated per run (never real keys)
const SECRETS = {
  service: `e2e-svc-${randomBytes(24).toString('hex')}`,
  bff: `e2e-bff-${randomBytes(24).toString('hex')}`,
  seedPassword: `E2e-${randomBytes(12).toString('hex')}`,
  otherService: `e2e-other-svc-${randomBytes(24).toString('hex')}`,
  llmKey: `e2e-mock-llm-${randomBytes(8).toString('hex')}`,
  lineSecret: randomBytes(16).toString('hex'),
  lineToken: `e2eMockLineToken${randomBytes(24).toString('base64url')}`,
}
const LINE_BOT_USER = randomLineUserId()
const LINE_USERS = { manager: randomLineUserId(), inspector: randomLineUserId(), stranger: randomLineUserId() }

const log = (...m) => { if (!JSON_ONLY) console.log(...m) }
const redactAll = redactor(Object.values(SECRETS))
const results = []
const said = [] // what the people did, for --story: { at, who, text | action, replyToken? }
const t0 = Date.now()
function record(scenario, step, ok, evidence = {}, note = '') {
  const status = ok === 'skip' ? 'skip' : ok ? 'pass' : 'fail'
  results.push({ scenario, step, status, evidence, ...(note ? { note } : {}) })
  log(`${status.toUpperCase().padEnd(4)}  [${scenario}] ${step}${note ? ` — ${note}` : ''}`)
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

const APP = `http://127.0.0.1:${PORTS.app}`
const EVIL_LINK = 'https://evil.example/phish?from=e2e' // the scripted answer's outside link (scenario g)
const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`
async function call(method, path, { cookie, body, headers = {} } = {}) {
  const h = { ...headers }
  if (cookie) h.cookie = cookie
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(`${APP}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data, text }
}
function must(r, expected, label) {
  const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected
  if (!ok) throw new Error(`${label}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`)
  return r.data
}
async function login(loginId) {
  const res = await fetch(`${APP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: SECRETS.seedPassword }) })
  if (res.status !== 200) throw new Error(`login ${loginId} -> ${res.status}`)
  return res.headers.get('set-cookie').split(';')[0]
}
const todayJst = (plusDays = 0) => new Date(Date.now() + 9 * 3600_000 + plusDays * 86_400_000).toISOString().slice(0, 10)

// ── lifecycle ───────────────────────────────────────────────────────────────

const cleanups = []
const procs = {}
let db = null
async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch (error) { log(`cleanup: ${error.message}`) }
  }
}
async function query(sql, params = []) {
  if (!db) {
    const pg = await loadPg()
    db = new pg.Client({ connectionString: dbUrl })
    await db.connect()
    cleanups.push(async () => { await db?.end(); db = null })
  }
  return (await db.query(sql, params)).rows
}

async function preflight() {
  await assertPortsUsable(PORTS, { forbidden: FORBIDDEN_PORTS })
  assertIsolatedHome(HOME)
  mkdirSync(WORK, { recursive: true })
  for (const f of ['dsh.log', 'app.log', 'install.log']) rmSync(join(WORK, f), { force: true })
  // a local copy of the pinned DSH CLI (.dsh-cli/<version>, installed on first use) or $DSH_BIN; never the global one.
  // pickDshBin sets process.env.DSH_BIN, so install.mjs runs `dsh plugin install` with the same CLI.
  DSH = pickDshBin({ framework: FRAMEWORK, log }).bin
}

async function startApp() {
  const protectedNames = PROTECTED_DATABASES
  await dropDatabase(dbUrl, { protectedNames })
  await ensureDatabase(dbUrl, { protectedNames })
  cleanups.push(async () => {
    if (KEEP) return log(`kept database ${DB_NAME}`)
    await dropDatabase(dbUrl, { protectedNames })
    log(`dropped database ${DB_NAME}`)
  })
  procs.app = startProcess('equipment', process.execPath, [join(FRAMEWORK, 'examples', 'equipment-inspection', 'src', 'server.mjs')], {
    cwd: join(FRAMEWORK, 'examples', 'equipment-inspection'),
    env: sanitizedEnv({
      EQUIPMENT_PORT: String(PORTS.app), EQUIPMENT_HOST: '127.0.0.1', EQUIPMENT_DATABASE_URL: dbUrl,
      EQUIPMENT_SERVICE_TOKEN: SECRETS.service, EQUIPMENT_BFF_SECRET: SECRETS.bff,
      EQUIPMENT_SCHEDULER: '0', EQUIPMENT_SEED: '1', EQUIPMENT_SEED_PASSWORD: SECRETS.seedPassword,
    }),
    logFile: join(WORK, 'app.log'), redact: redactAll,
  })
  cleanups.push(() => procs.app.stop())
  await waitFor(async () => {
    if (procs.app.child.exitCode !== null) throw new Error(`equipment-inspection exited: ${procs.app.tail.slice(-5).join(' | ')}`)
    return (await fetch(`${APP}/bridge/v1/health`)).ok
  }, { timeoutMs: 30_000, label: 'equipment-inspection /bridge/v1/health' })
}

/** A second Bridge application that only records what reaches it (it must receive nothing from the equipment conversation). */
async function startOtherApp() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, delegation: Boolean(req.headers['x-delegation-token']), service: req.headers['x-service-token'] === SECRETS.otherService })
    res.writeHead(404, { 'content-type': 'application/json', 'bridge-protocol': '1' })
    res.end('{"ok":false,"error":"not_found"}')
  })
  await new Promise((r) => server.listen(PORTS.other, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }))
  return { requests }
}

// ── the product profile (made from profile/template the way profile/README.md describes) ─────────────────────

const slash = (p) => p.replace(/\\/g, '/')
function makeProductProfile() {
  const src = join(WORK, 'profile-src')
  rmSync(src, { recursive: true, force: true })
  cpSync(join(FRAMEWORK, 'profile', 'template'), src, { recursive: true })
  const file = join(src, 'cordis.patch.yml')
  let text = readFileSync(file, 'utf8')
  const replace = (from, to, label) => {
    if (!(typeof from === 'string' ? text.includes(from) : from.test(text))) throw new Error(`profile template changed: ${label} not found`)
    text = text.replace(from, to)
  }
  // 1. the registry: equipment-inspection (default, every bot) + a second application whose bot is not this LINE bot
  const start = text.indexOf('    applications:\n')
  const end = text.indexOf('    # compat:', start)
  if (start < 0 || end < 0) throw new Error('profile template changed: bridge-apps applications block not found')
  text = text.slice(0, start) + [
    '    applications:',
    `      - id: ${APP_ID}`,
    `        name: ${APP_NAME}`,
    '        namespace: facility',
    '        default: true',
    '        paths: v1',
    '        apiUrlEnv: INSPECTION_API_URL',
    '        serviceTokenEnv: INSPECTION_SERVICE_TOKEN',
    '        manifestUrl: /bridge/v1/manifest',
    `        manifestFile: ${JSON.stringify(slash(join(FRAMEWORK, 'examples', 'equipment-inspection', 'bridge.manifest.yaml')))}`,
    '        generateTools: true',
    '        agents: [facility-inspection]',
    '        bots: []',
    '      - id: example-app',
    '        name: 日報',
    '        paths: v1',
    '        apiUrlEnv: EXAMPLE_APP_API_URL',
    '        serviceTokenEnv: EXAMPLE_APP_SERVICE_TOKEN',
    '        manifestFile: pkg:@dsh-bridge/protocol/manifests/example.manifest.yaml',
    '        generateTools: true',
    '        bots: [{ platform: slack, botId: e2e-example-slack-bot }]',
    '',
  ].join('\n') + text.slice(end)
  // 2. the remaining placeholders (preset persona)
  text = text.split('<アプリ名>').join(APP_NAME).split('<namespace>').join('facility')
  // 3. e2e timings: no digest windows, no quiet hours (independent of the clock), fast event polling
  replace(/^ {4}digestMinutes: 30 .*$/m, '    digestMinutes: 0\n    honorQuietHours: false', 'bridge-notify digestMinutes')
  // 3b. the link guard: the business web of the default application (scenario g)
  replace('    # linkGuard:\n', `    linkGuard:\n      webUrl: ${APP}\n`, 'bridge-identity linkGuard')
  // 4. the hand-written propose tool: into the template's own bridge-tools entry (which keeps groupChat: deny)
  replace("    groupChat: deny\n    # toolModules:\n    #   - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: equipment-inspection }\n",
    `    groupChat: deny\n    toolModules:\n      - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: ${APP_ID} }\n`, 'bridge-tools toolModules')
  const presetAt = text.indexOf('- insert:\n    - id: preset-business-assistant')
  if (presetAt < 0) throw new Error('profile template changed: preset-business-assistant not found')
  const preset = text.slice(presetAt)
  text = text.slice(0, presetAt) + [
    '# ── e2e product settings ──',
    '- id: bridge-events',
    '  config:',
    '    pollIntervalSeconds: 1',
    '    maxBackoffSeconds: 5',
    '',
  ].join('\n') + preset + '\n'
    // 5. the preset of the manifest playbook (agent: facility-inspection): the same business-only preset
    + preset.replace('id: preset-business-assistant', 'id: preset-facility-inspection').replace('id: business-assistant', 'id: facility-inspection')
      .replace('order: 1', 'order: 2').replace(`name: ${APP_NAME} アシスタント（AI社員）`, `name: ${APP_NAME} 点検フォロー（AI社員）`)
  if (/:\s*<[^>]+>/.test(text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'))) throw new Error('placeholders left in the e2e product profile')
  writeFileSync(file, text, 'utf8')
  return src
}

function runInstall(src, extra = []) {
  const r = spawnSync(process.execPath, [
    join(FRAMEWORK, 'profile', 'scripts', 'install.mjs'), '--source', src, '--home', HOME, '--profile', PROFILE, '--framework-root', FRAMEWORK, ...extra,
  ], { cwd: FRAMEWORK, encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME }, timeout: 600_000, windowsHide: true })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(join(WORK, 'install.log'), redactAll(out), { flag: 'a' })
  if (r.status !== 0) throw new Error(`install.mjs ${extra.join(' ')} failed (exit ${r.status}): ${redactAll(out).slice(-800)}`)
  return out
}

function writeOverlay() {
  const file = join(WORK, 'overlay.yml')
  writeFileSync(file, `# e2e overlay (run.mjs writes it per run; the product profile is not changed): the mock model
- id: llm-pi-ai
  config:
    providers:
      e2e-mock:
        displayName: e2e mock (OpenAI compatible)
        apiKeyEnv: FW_E2E_MOCK_LLM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${PORTS.llm}/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: mock-bridge
            name: mock-bridge
- id: agent-default-model
  config:
    provider: e2e-mock
    model: mock-bridge
`, 'utf8')
  return file
}

function removeHome() {
  if (KEEP) return log(`kept the isolated DSH home ${HOME}`)
  if (REUSE_HOME) {
    for (const name of ['sessions', 'storages', 'integrations', 'im', 'auto-tasks', 'proactive', 'logs', 'workspace', 'agents', '.credentials.yaml']) rmSync(join(HOME, name), { recursive: true, force: true })
    return log(`cleared the runtime state of ${HOME} (profile dependencies kept: --reuse-home)`)
  }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  log(`removed the isolated DSH home ${HOME}`)
}

async function installAndStartDsh(src) {
  const installed = existsSync(join(HOME, 'profiles', PROFILE, 'node_modules', '@dsh-bridge', 'plugin-tools'))
  if (!REUSE_HOME || !installed) rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  else for (const name of ['sessions', 'storages', 'integrations', 'im', 'auto-tasks', 'proactive', 'logs', 'workspace', 'agents', '.credentials.yaml', 'INSTALLED.json']) rmSync(join(HOME, name), { recursive: true, force: true })
  cleanups.push(removeHome)
  // the delegation of automatic tasks: the manager's LINE account (linked in scenario a, before any automatic task runs)
  const out = runInstall(src, ['--auto-task-delegate', `line:${LINE_USERS.manager}`])
  const patch = readFileSync(join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8')
  const toolsEntries = patch.match(/^- id: bridge-tools/gm)?.length ?? 0
  record('setup', 'install.mjs --source <product profile> --framework-root --auto-task-delegate: one bridge-tools entry with toolModules + delegation', toolsEntries === 1
    && /toolModules:/.test(patch) && /unattendedPolicy: delegate/.test(patch) && !/template placeholders left/.test(out), {
    bridgeToolsEntries: toolsEntries, toolModules: /toolModules:/.test(patch), delegation: /unattendedPolicy: delegate/.test(patch), placeholderWarning: /template placeholders left/.test(out),
  })
  const { proc, token } = await startDsh({
    bin: DSH, home: HOME, profile: PROFILE, port: PORTS.dsh, patch: writeOverlay(), publicUrl: `${GATEWAY}/dsh/`,
    logFile: join(WORK, 'dsh.log'), secrets: Object.values(SECRETS),
    env: {
      INSPECTION_API_URL: APP, INSPECTION_SERVICE_TOKEN: SECRETS.service,
      EXAMPLE_APP_API_URL: `http://127.0.0.1:${PORTS.other}`, EXAMPLE_APP_SERVICE_TOKEN: SECRETS.otherService,
      BRIDGE_WEB_PUBLIC_URL: GATEWAY,
      CARE_DSH_IM_LINE_API_BASE: `http://127.0.0.1:${PORTS.line}`, // the dsh-im fork's loopback-only test override (fork name kept)
      FW_E2E_MOCK_LLM_KEY: SECRETS.llmKey,
    },
  })
  procs.dsh = proc
  cleanups.push(() => proc.stop())
  return token
}

async function startGateway(token) {
  const gateway = createDshGateway({
    target: `http://127.0.0.1:${PORTS.dsh}`,
    mountPath: '/dsh',
    getSessionUser: async () => null, // no browser path in this test
    isAllowed: () => false,
    launchToken: fromValue(token),
    logger: { info() {}, warn: (...m) => log('[gateway]', ...m.map(redactAll)), error: (...m) => log('[gateway]', ...m.map(redactAll)) },
    publicPaths: ['/dsh-hooks/line'],
    rpcAllowlist: [
      { channel: '/line', methods: ['connection.status', 'bot.bind-credentials'] },
      { plugin: 'bridge-assistant', channel: '/assistant', methods: ['agents.list', 'conversation.get', 'message.send', 'message.cancel', 'conversation.reset'] },
    ],
  })
  const server = http.createServer(async (req, res) => {
    if (await gateway.handleRequest(req, res)) return
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  await new Promise((r) => server.listen(PORTS.gateway, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }))
  return gateway
}

// ── the mock LLM script ─────────────────────────────────────────────────────

const llmTrace = [] // automatic-task steps seen by the script
function firstArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = firstArray(v)
      if (found) return found
    }
  }
  return null
}
const parseJson = (text) => { try { return JSON.parse(text) } catch { return null } }

/** The automatic task turn of the manifest playbook (prompt `[自动任务 <taskId>]`, payload = the business event). */
function playbookScript({ userText: raw, toolCalls, toolResults, findTool }) {
  const quoted = /reminder_prompt_json: ("(?:[^"\\]|\\.)*")/.exec(raw)?.[1]
  let userText = raw
  if (quoted) { try { userText = JSON.parse(quoted) } catch { /* keep raw */ } }
  const task = /\[自动任务 (\S+)\]/.exec(userText)?.[1]
  if (!task) return null
  const runId = /runId: (\S+)/.exec(userText)?.[1]
  const lastCall = toolCalls.at(-1)?.function?.name ?? ''
  const last = toolResults.at(-1)?.content ?? ''
  const report = (status, summary) => ({ toolCall: { name: findTool('auto_task_report') ?? 'auto_task_report', arguments: { taskId: task, ...(runId ? { runId } : {}), status, summary } } })
  const silent = (reason) => ({ toolCall: { name: findTool('auto_task_silent') ?? 'auto_task_silent', arguments: { taskId: task, ...(runId ? { runId } : {}), reason } } })
  if (/auto_task_(report|silent)$/.test(lastCall)) return { text: '報告しました。' }
  if (task !== PLAYBOOK_TASK) return report('failed', `E2E: unexpected automatic task ${task}`)
  const equipmentId = /equipmentId\\?"\s*:\s*\\?"([0-9a-f-]{36})/i.exec(userText)?.[1]
  if (!equipmentId) return silent('no equipmentId in the trigger data')
  const list = findTool('facility_list_overdue')
  const propose = findTool('facility_propose_reschedule')
  if (!list || !propose) return report('failed', `E2E: tools missing (list ${Boolean(list)}, propose ${Boolean(propose)})`)
  if (toolCalls.length === 0) { llmTrace.push({ step: 'start', task, equipmentId }); return { toolCall: { name: list, arguments: {} } } }
  if (lastCall.endsWith('facility_list_overdue')) {
    const item = (firstArray(parseJson(last)) ?? []).find((x) => x?.equipmentId === equipmentId)
    llmTrace.push({ step: 'list', found: Boolean(item), excerpt: last.slice(0, 160) })
    if (!item) return /"ok":\s*true/.test(last) ? silent('already inspected') : report('failed', `一覧を取得できませんでした（${last.slice(0, 80)}）`)
    return { toolCall: { name: propose, arguments: { equipmentId, dueOn: todayJst(7), reason: '担当の点検員の予定に合わせて 1 週間後に点検' } } }
  }
  if (lastCall.endsWith('facility_propose_reschedule')) {
    const proposal = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(last)?.[1]
    llmTrace.push({ step: 'propose', proposal: proposal ?? null, excerpt: last.slice(0, 200) })
    if (!proposal) return report('failed', `提案を作成できませんでした（${last.slice(0, 80)}）`)
    return report('needsDecision', `【対応のお願い】点検期限を過ぎた設備（ID ${equipmentId.slice(0, 8)}）の次回点検日の変更を提案しました（提案ID ${proposal.slice(0, 8)}）。\n▶ お願いしたいこと：設備責任者が業務 Web の「AI 提案」で確認し、採択または却下してください。`)
  }
  return report('failed', `E2E: unexpected tool result (${lastCall})`)
}

function llmScript(ctx) {
  const { body, userText, toolResults, findTool } = ctx
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: '設備点検の確認' } // session titles etc.
  const auto = playbookScript({ ...ctx, toolCalls: ctx.toolCalls ?? [] })
  if (auto) return auto
  const flow = (name, toolArgs, finish) => {
    const tool = findTool(name)
    if (!tool) return { text: `E2E: ${name} がツール一覧にありません。` }
    if (toolResults.length === 0) return { toolCall: { name: tool, arguments: toolArgs } }
    return { text: finish(toolResults.at(-1).content) }
  }
  if (/期限切れの点検/.test(userText)) {
    return flow('facility_list_overdue', {}, (content) => {
      const list = /"ok":\s*true/.test(content) ? firstArray(parseJson(content)) : null
      return list ? `期限切れの点検は ${list.length} 件です（${list.map((x) => x.code).join(', ')}）。` : `点検の一覧を取得できませんでした（${content.slice(0, 200)}）`
    })
  }
  if (/リンクの確認/.test(userText)) return { text: `点検一覧は ${APP}/ です。詳しくは ${EVIL_LINK} もどうぞ。` }
  if (/日報も見せて/.test(userText)) {
    return flow('example_app_list_reports', {}, (content) => (/belongs to application|not allowed|refus/i.test(content)
      ? `日報のツールはこの会話では使えません（${content.slice(0, 200)}）` : `E2E: 想定外に取得できました（${content.slice(0, 120)}）`))
  }
  return { text: 'E2E 模擬応答です。' }
}

// ── scenarios ───────────────────────────────────────────────────────────────

const messageText = (entry) => (entry?.messages ?? []).map((m) => (m.type === 'text' ? m.text : m.type === 'flex' ? [m.altText, ...flexSummary(m).texts].join('\n') : '')).join('\n')
const toUser = (event, userId) => (e) => (e.kind === 'reply' && e.replyToken === event.replyToken) || (e.kind === 'push' && e.to === userId)
const delegationsIssued = async (userId) => Number((await query("select count(*)::int as n from bridge_audit_log where action = 'delegation.issued' and target = $1", [userId]))[0].n)

let mocks = null
const actors = {}

async function main() {
  if (!SERVER_URL) {
    console.error('FW_TEST_DATABASE_URL is not set: postgres://<user>:<password>@127.0.0.1:5432/postgres (only the server and credentials are used)')
    process.exit(2)
  }
  await preflight()
  log('— setup')
  await startApp()
  for (const loginId of ['admin', 'manager', 'inspector1']) {
    const cookie = await login(loginId)
    const me = must(await call('GET', '/api/me', { cookie }), 200, `me ${loginId}`)
    actors[loginId] = { id: me.user.id, cookie }
  }
  const other = await startOtherApp()
  log(`equipment-inspection :${PORTS.app} (db ${DB_NAME}), example-app stub :${PORTS.other}`)

  const llm = await startMockLlm({ port: PORTS.llm, script: llmScript, expectKey: SECRETS.llmKey, model: 'mock-bridge' })
  cleanups.push(() => llm.close())
  const line = await startMockLine({ port: PORTS.line, channelAccessToken: SECRETS.lineToken, botUserId: LINE_BOT_USER })
  cleanups.push(() => line.close())
  mocks = { llm, line, other }

  const src = makeProductProfile()
  const token = await installAndStartDsh(src)
  const gateway = await startGateway(token)
  const host = await dshHostClient({ port: PORTS.dsh, token })
  log(`DSH :${PORTS.dsh} (home ${HOME}, profile ${PROFILE}); gateway :${PORTS.gateway}`)

  await waitFor(async () => (await gateway.rpc('/line', 'connection.status', {})).ok, { timeoutMs: 90_000, stepMs: 1000, label: 'dsh-im /line RPC' })
  const bound = await gateway.rpc('/line', 'bot.bind-credentials', { channelSecret: SECRETS.lineSecret, channelAccessToken: SECRETS.lineToken }, { timeoutMs: 60_000 })
  if (!bound.ok) throw new Error(`LINE bind failed: ${JSON.stringify(bound.error)}`)
  const status = await waitFor(async () => {
    const s = await gateway.rpc('/line', 'connection.status', {})
    return s.ok && s.value?.bots?.some((b) => b.connected) ? s.value : null
  }, { timeoutMs: 30_000, stepMs: 500, label: 'LINE bot connected' })
  const statusText = JSON.stringify(status)
  record('setup', 'LINE bot bound through the gateway server RPC (mock LINE API); secrets not echoed', !statusText.includes(SECRETS.lineSecret) && !statusText.includes(SECRETS.lineToken), {
    botId: status.bots[0].botId, botInfoCalls: line.log.filter((e) => e.kind === 'info').length,
  })
  const webhook = lineWebhookSender({ url: `${GATEWAY}/dsh-hooks/line`, channelSecret: SECRETS.lineSecret, botUserId: LINE_BOT_USER })
  const say = async (who, text, pattern, { timeoutMs = 90_000 } = {}) => {
    const at = Date.now()
    const sent = await webhook.text(LINE_USERS[who], text)
    said.push({ at, who, text, replyToken: sent.event?.replyToken })
    const reply = await line.waitForMessage((e) => toUser(sent.event, LINE_USERS[who])(e) && (!pattern || pattern.test(messageText(e))), { since: at, timeoutMs })
    return { status: sent.status, reply, text: reply ? messageText(reply) : null, at }
  }

  // ── a: guide, link page, link code ──────────────────────────────────────
  {
    const llmBefore = llm.requests.length
    const r = await say('stranger', 'こんにちは', /連携/, { timeoutMs: 30_000 })
    await sleep(500)
    record('a', 'unlinked LINE user → the link guide only (no agent, no LLM call)', r.status === 200 && r.reply && /連携 123456|連携コード/.test(r.text) && llm.requests.length === llmBefore, {
      webhookStatus: r.status, reply: r.text, via: r.reply?.kind, llmRequests: llm.requests.length - llmBefore,
    })
    // a business question from the same unlinked user: nothing but the guide (bridge-identity sends it at most once per
    // guideIntervalSeconds, so here usually nothing at all) — no model, no tool, no delegation, no business data
    const codes = (must(await call('GET', '/api/inspections/overdue', { cookie: actors.manager.cookie }), 200, 'overdue').items ?? []).map((x) => x.code).filter(Boolean)
    const issuedBefore = Number((await query("select count(*)::int as n from bridge_audit_log where action = 'delegation.issued'"))[0].n)
    const llmBefore2 = llm.requests.length
    const q = await say('stranger', '期限切れの点検は？', null, { timeoutMs: 8_000 })
    await sleep(2_000)
    const issuedAfter = Number((await query("select count(*)::int as n from bridge_audit_log where action = 'delegation.issued'"))[0].n)
    const strangerTexts = line.log.filter((e) => e.at >= q.at && e.to === LINE_USERS.stranger).map(messageText)
    const leaked = codes.filter((code) => strangerTexts.some((t) => t.includes(code)))
    record('a', 'unlinked LINE user asks a business question → at most the guide: no LLM call, no delegation issued, no business data on LINE',
      q.status === 200 && strangerTexts.every((t) => /連携/.test(t)) && llm.requests.length === llmBefore2 && issuedAfter === issuedBefore && codes.length > 0 && leaked.length === 0, {
        webhookStatus: q.status, messagesToTheSender: strangerTexts, llmRequests: llm.requests.length - llmBefore2, delegationsIssued: issuedAfter - issuedBefore, overdueCodes: codes.length, leakedCodes: leaked,
      })
    const page = await fetch(`${APP}/`)
    const html = await page.text()
    const linked = {}
    for (const [who, loginId] of [['manager', 'manager'], ['inspector', 'inspector1']]) {
      said.push({ at: Date.now(), who, action: 'アプリで「連携コードを発行」' })
      const code = must(await call('POST', '/bridge/v1/me/link-codes', { cookie: actors[loginId].cookie }), [200, 201], `link code ${loginId}`).code
      const ok = await say(who, `連携 ${code}`, /連携/, { timeoutMs: 30_000 })
      const ids = must(await call('GET', '/bridge/v1/me/identities', { cookie: actors[loginId].cookie }), 200, 'identities').identities ?? []
      linked[who] = { reply: ok.text, identity: ids.find((i) => i.platform === 'line' && (i.externalId ?? i.external_id) === LINE_USERS[who]) ?? null }
    }
    record('a', 'link page served; employee issues a code (POST /bridge/v1/me/link-codes) → 「連携 123456」 on LINE → linked (manager, inspector1)',
      page.status === 200 && /連携コード/.test(html) && Object.values(linked).every((l) => /連携が完了/.test(l.reply ?? '') && l.identity), {
        linkPage: { status: page.status, hasLinkCodeButton: /連携コード/.test(html) },
        linked: Object.fromEntries(Object.entries(linked).map(([k, v]) => [k, { reply: v.reply, platform: v.identity?.platform ?? null, botId: v.identity?.botId ?? null }])),
      })
  }

  // ── b: a manifest-generated read tool under the employee's delegation ───────────────────
  {
    const truth = must(await call('GET', '/api/inspections/overdue', { cookie: actors.manager.cookie }), 200, 'overdue').items
    const before = await delegationsIssued(actors.manager.id)
    const reqBefore = llm.requests.length
    const r = await say('manager', '期限切れの点検は？', /期限切れの点検|取得できません/)
    const reqs = llm.requests.slice(reqBefore)
    const toolReq = reqs.find((q) => q.decision?.toolCall)
    const toolResult = reqs.find((q) => q.toolResults.length)?.toolResults.at(-1)?.content ?? ''
    const after = await delegationsIssued(actors.manager.id)
    const count = Number(/(\d+) 件/.exec(r.text ?? '')?.[1] ?? NaN)
    const leaks = [SECRETS.service, 'bdg_', 'x-delegation-token'].filter((s) => toolResult.includes(s))
    record('b', '「期限切れの点検は？」→ facility_list_overdue (generated from the manifest) with the manager\'s delegation → LINE answer matches the app',
      r.reply && toolReq?.decision.toolCall.name.endsWith('facility_list_overdue') && count === truth.length && after > before && leaks.length === 0 && reqs.every((q) => q.authorized), {
        reply: r.text, expected: truth.length, toolCall: toolReq?.decision?.toolCall ?? null,
        businessToolsOffered: toolReq?.toolNames?.filter((n) => /facility_|example_app_/.test(n)) ?? null,
        delegationsIssued: after - before, leaksInToolResult: leaks, toolResultExcerpt: toolResult.slice(0, 200),
      })
  }

  // ── g: the link guard on the real DSH (bridge-identity's answer filter through dsh-im setAnswerFilter) ───────────────
  {
    const r = await say('manager', 'リンクの確認', /点検一覧/)
    const text = r.text ?? ''
    record('g', 'link guard: the AI answer keeps the business web screen (web.routes "/") and the outside link is removed before LINE',
      r.reply && text.includes(`${APP}/`) && !text.includes('evil.example') && text.includes('（リンクを省きました）'), { reply: text })
  }

  // ── f: isolation (another application, the role scope of a delegation, no writes with a delegation) ─────────────
  {
    // bridge-events polls every application's event stream, and bridge-reader its document reads, with that application's
    // service token (no delegation); that is not a tool call
    const toolTraffic = (from) => other.requests.slice(from).filter((q) => q.delegation || !/^\/bridge\/v1\/(events|manifest|document-reads)\b/.test(q.path))
    const otherBefore = other.requests.length
    const r = await say('manager', '日報も見せて', /使えません|想定外|ツール一覧/)
    record('f', 'another application\'s tool (example_app_list_reports) is refused in the equipment conversation; no delegation / tool call reaches that application',
      r.reply && /belongs to application "equipment-inspection"/.test(r.text) && toolTraffic(otherBefore).length === 0 && other.requests.every((q) => !q.delegation), {
        reply: r.text?.slice(0, 300) ?? null, toolRequestsToOtherApplication: toolTraffic(otherBefore), eventPolls: other.requests.length - otherBefore,
      })
    const reqBefore = llm.requests.length
    const before = await delegationsIssued(actors.inspector1.id)
    const denied = await say('inspector', '期限切れの点検は？', /期限切れの点検|取得できません/)
    const toolResult = llm.requests.slice(reqBefore).find((q) => q.toolResults.length)?.toolResults.at(-1)?.content ?? ''
    record('f', 'a read tool outside the employee\'s role (inspector → facility_list_overdue) is refused by the business system',
      denied.reply && /取得できません/.test(denied.text) && /403|not.?permitted|role/i.test(toolResult) && !/"items"/.test(toolResult), {
        reply: denied.text?.slice(0, 300) ?? null, toolResultExcerpt: toolResult.slice(0, 240), delegationsIssued: (await delegationsIssued(actors.inspector1.id)) - before,
      })
    // the token itself: minted for the manager's LINE account, then misused
    const minted = must(await call('POST', '/bridge/v1/delegations', { headers: { 'x-service-token': SECRETS.service }, body: { source: { platform: 'line', userId: LINE_USERS.manager } } }), [200, 201], 'delegation')
    const tokenValue = minted.token ?? minted.delegationToken
    const write = await call('POST', '/api/equipment', { headers: { 'x-service-token': SECRETS.service, 'x-delegation-token': tokenValue }, body: { code: 'E2E-001', name: 'x', intervalDays: 30, nextDueOn: todayJst(30) } })
    const noService = await call('GET', '/api/equipment', { headers: { 'x-delegation-token': tokenValue } })
    const otherApp = await fetch(`http://127.0.0.1:${PORTS.other}/api/reports`, { headers: { 'x-service-token': SECRETS.otherService, 'x-delegation-token': tokenValue } })
    record('f', 'a delegation token cannot write (403 delegation_not_permitted), is useless without the service token, and is not accepted by another application',
      write.status === 403 && write.data?.error === 'delegation_not_permitted' && noService.status === 401 && otherApp.status >= 400, {
        write: { status: write.status, error: write.data?.error ?? null }, withoutServiceToken: noService.status, otherApplication: otherApp.status,
      })
  }

  // ── e (part 1): the manifest playbook was deployed by bridge-events; enable it with install.mjs ──────────────
  {
    const deployed = await waitFor(async () => {
      const tasks = (await host.autoTasks('GET', '/tasks')).data?.tasks ?? []
      return tasks.find((t) => t.id === PLAYBOOK_TASK) ?? null
    }, { timeoutMs: 60_000, stepMs: 1000, label: `${PLAYBOOK_TASK} deployed` }).catch(() => null)
    const out = runInstall(src, ['--skip-install', '--enable-auto-tasks', PLAYBOOK_TASK])
    // operational field (like the auto-tasks UI): report without waiting for quiet hours, so the test does not depend on the clock
    const file = join(HOME, 'auto-tasks', 'tasks.json')
    const tasks = JSON.parse(readFileSync(file, 'utf8')).map((t) => (t.id === PLAYBOOK_TASK ? { ...t, feedback: { ...t.feedback, respectQuietHours: false } } : t))
    writeFileSync(file, JSON.stringify(tasks, null, 2), 'utf8')
    const listed = ((await host.autoTasks('GET', '/tasks')).data?.tasks ?? []).find((t) => t.id === PLAYBOOK_TASK)
    record('e', 'bridge-events deployed the manifest playbook (disabled); install.mjs --enable-auto-tasks pb_… enables it with its agent as session preset (delegate kept)',
      deployed && deployed.enabled === false && listed?.enabled === true && listed.sessionPreset === 'facility-inspection' && /kept the automatic-task delegation/.test(out), {
        deployed: deployed ? { enabled: deployed.enabled, source: deployed.source?.kind, tools: deployed.source?.tools, audience: deployed.audience } : null,
        afterInstall: listed ? { enabled: listed.enabled, sessionPreset: listed.sessionPreset, sessionId: listed.sessionId } : null,
      })
  }

  // ── c + e: one inspection.overdue event → notification (c) and the playbook (e) ─────────────────────
  {
    const at = Date.now()
    const proposalsBefore = must(await call('GET', '/bridge/v1/proposals', { cookie: actors.manager.cookie }), 200, 'proposals').proposals ?? []
    said.push({ at: Date.now(), who: 'system', action: '業務システム：点検の期限切れを検出（inspection.overdue）' })
    const scan = must(await call('POST', '/api/admin/overdue-scan', { cookie: actors.manager.cookie }), 200, 'overdue scan')
    const eventId = scan.created?.[0]?.eventId
    const notice = (who) => line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS[who] && /点検期限/.test(messageText(e)) && !AUTO_TASK_REPORT.test(messageText(e)), { since: at, timeoutMs: 90_000 })
    const [toManager, toInspector] = await Promise.all([notice('manager'), notice('inspector')])
    const framed = (entry) => {
      const text = entry ? messageText(entry) : ''
      return { text, ok: /【対応のお願い】/.test(text) && /^▶ お願いしたいこと/m.test(text) && text.includes(`— ${APP_NAME} AI 秘書`) }
    }
    const m = framed(toManager)
    const i = framed(toInspector)
    record('c', 'inspection.overdue → bridge-events → bridge-notify → LINE of the linked recipients (manager, assignee) in the AI 秘書 frame',
      scan.created?.length === 1 && m.ok && i.ok && !line.log.some((e) => e.at >= at && e.to === LINE_USERS.stranger), {
        eventId, created: scan.created?.length ?? 0, manager: m.text, inspector: i.text,
      })

    // e: the automatic task ran on this event and proposed through the hand-written propose tool
    const proposal = await waitFor(async () => {
      const list = must(await call('GET', '/bridge/v1/proposals', { cookie: actors.manager.cookie }), 200, 'proposals').proposals ?? []
      return list.find((p) => !proposalsBefore.some((b) => b.id === p.id) && p.kind === 'inspection_reschedule') ?? null
    }, { timeoutMs: 150_000, stepMs: 1000, label: 'playbook proposal' }).catch(() => null)
    // the template profile closes the automatic-task report (bridge-notify audienceText: template): the fixed text, never the AI's summary
    const report = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.manager && AUTO_TASK_REPORT.test(messageText(e)), { since: at, timeoutMs: proposal ? 60_000 : 1000 })
    const runs = (await host.autoTasks('GET', `/runs?taskId=${PLAYBOOK_TASK}`)).data?.runs ?? []
    const run = runs.find((x) => String(x.eventId ?? '') === String(eventId)) ?? runs[0] ?? null
    const replay = run?.dedupeKey ? await host.autoTasks('POST', '/events/emit', { eventType: 'inspection.overdue', payload: { id: eventId }, dedupeKey: run.dedupeKey }) : null
    const runsAfter = (await host.autoTasks('GET', `/runs?taskId=${PLAYBOOK_TASK}`)).data?.runs ?? []
    const audit = proposal ? await query("select actor from bridge_audit_log where action = 'proposal.created' and target = $1", [proposal.id]) : []
    const task = ((await host.autoTasks('GET', '/tasks')).data?.tasks ?? []).find((t) => t.id === PLAYBOOK_TASK)
    record('e', 'the playbook ran once for the event (replay deduped) and proposed facility_propose_reschedule on behalf of the delegate (manager)',
      proposal && proposal.status === 'pending_review' && runs.length === 1 && run?.eventType === 'inspection.overdue'
        && replay?.data?.deduped?.includes(PLAYBOOK_TASK) && runsAfter.length === 1 && audit[0]?.actor === `ai:${actors.manager.id}`
        && llmTrace.some((t) => t.step === 'propose' && t.proposal) && Boolean(task?.sessionId), {
        proposal: proposal ? { kind: proposal.kind, status: proposal.status, payload: proposal.payload } : null,
        runs: runs.length, run: run ? { eventType: run.eventType, eventId: run.eventId ?? null, applicationId: run.applicationId ?? null } : null,
        replayDeduped: replay?.data?.deduped ?? null, runsAfterReplay: runsAfter.length, proposalAuditActor: audit[0]?.actor === `ai:${actors.manager.id}` ? 'ai:<manager>' : audit[0]?.actor ?? null,
        dedicatedSession: Boolean(task?.sessionId), trace: llmTrace.map((t) => t.step),
      })
    const aiSummaryLeaked = line.log.some((e) => e.at >= at && /次回点検日の変更を提案/.test(messageText(e)))
    record('e', 'the playbook report reached the event\'s audience (manager) on LINE as the fixed AI 秘書 text (audienceText: template; the AI summary never reaches IM)',
      Boolean(report) && /【対応のお願い】点検期限超過のフォロー/.test(messageText(report)) && /▶ お願いしたいこと/.test(messageText(report))
        && messageText(report).includes(`— ${APP_NAME} AI 秘書`) && !aiSummaryLeaked && !line.log.some((e) => e.at >= at && e.to === LINE_USERS.stranger), {
        report: report ? messageText(report) : null, aiSummaryLeaked,
      })
  }

  // ── d: approval card → button decides → card updated; reply code rejects ─────────────────────
  {
    const equipment = must(await call('GET', '/api/equipment', { cookie: actors.admin.cookie }), 200, 'equipment').equipment
    const fe = equipment.find((x) => x.code === 'FE-002') ?? equipment[0]
    const request = async (estimatedCost) => {
      const at = Date.now()
      said.push({ at, who: 'inspector', action: `アプリで修理依頼を登録（見積 ${estimatedCost} 円）` })
      const created = must(await call('POST', '/api/repair-requests', { cookie: actors.inspector1.cookie, body: { equipmentId: fe.id, estimatedCost, detail: 'E2E: 点検で不具合' } }), 201, 'repair request')
      const card = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.manager && e.messages.some((x) => x.type === 'flex') && /承認のお願い/.test(messageText(e)), { since: at, timeoutMs: 90_000 })
      const flex = card ? flexSummary(card.messages.find((x) => x.type === 'flex')) : null
      const approvalId = created.approval.id
      await waitFor(async () => (await query('select 1 from bridge_approval_delivery where approval_id = $1 and sent_at is not null', [approvalId])).length > 0, { timeoutMs: 20_000, stepMs: 300, label: 'delivery sent' }).catch(() => null)
      return { approvalId, card, flex, text: card ? messageText(card) : '' }
    }
    const statusOf = async (approvalId) => (await query('select status, decision_channel from approval where id = $1', [approvalId]))[0] ?? null
    const toInspector = (since) => line.log.filter((e) => e.at >= since && e.to === LINE_USERS.inspector && /承認のお願い/.test(messageText(e))).length

    const first = await request(12000)
    const approve = first.flex?.buttons.find((b) => b.type === 'postback' && /approve/.test(b.data ?? ''))
    record('d', 'repair request → approval.requested → bridge-approvals → 【承認のお願い】 card with buttons and a reply code on the approver\'s LINE (not the requester)',
      Boolean(first.card && approve) && /【承認のお願い】/.test(first.text) && /承認 \d{6}/.test(first.text) && first.text.includes(`— ${APP_NAME} AI 秘書`) && toInspector(t0) === 0, {
        approvalId: first.approvalId, buttons: first.flex?.buttons.map((b) => ({ label: b.label, type: b.type })) ?? null, card: first.text,
      })
    let decided = null
    let updated = null
    let ack = null
    if (approve) {
      const at = Date.now()
      const pressed = await webhook.postback(LINE_USERS.manager, approve.data)
      said.push({ at, who: 'manager', action: 'カードの［承認］を押す', replyToken: pressed.event?.replyToken })
      ack = await line.waitForMessage(toUser(pressed.event, LINE_USERS.manager), { since: at, timeoutMs: 30_000 })
      decided = await waitFor(async () => { const s = await statusOf(first.approvalId); return s?.status === 'approved' ? s : null }, { timeoutMs: 20_000, label: 'approved' }).catch(() => null)
      updated = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.manager && /【ご報告】/.test(messageText(e)) && /承認済み/.test(messageText(e)), { since: at, timeoutMs: 30_000 })
    }
    record('d', 'the approver presses 承認 → decided in the app (approved, channel IM) → the card is updated to 【ご報告】…（承認済み）',
      Boolean(ack && /承認しました/.test(messageText(ack)) && decided && updated), {
        ack: ack ? messageText(ack) : null, approval: decided, updatedCard: updated ? messageText(updated).slice(0, 200) : null,
      })

    const second = await request(34000)
    const code = /差戻 (\d{6})/.exec(second.text)?.[1]
    let rejected = null
    let reply = null
    let updated2 = null
    if (code) {
      const r = await say('manager', `差戻 ${code} 見積額の内訳を確認してください`, /差戻/, { timeoutMs: 30_000 })
      reply = r.text
      rejected = await waitFor(async () => { const s = await statusOf(second.approvalId); return s?.status === 'rejected' ? s : null }, { timeoutMs: 20_000, label: 'rejected' }).catch(() => null)
      updated2 = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.manager && /【ご報告】/.test(messageText(e)) && /差戻し済み/.test(messageText(e)), { since: r.at, timeoutMs: 30_000 })
    }
    record('d', 'a second request is rejected with the reply code (「差戻 123456 理由」) → rejected in the app → card updated (差戻し済み)',
      Boolean(code && /差戻しました/.test(reply ?? '') && rejected && updated2), {
        replyCodeInCard: Boolean(code), reply, approval: rejected, updatedCard: updated2 ? messageText(updated2).slice(0, 200) : null,
      })
  }
}

let fatal = null
try {
  await main()
} catch (error) {
  fatal = error
  record('setup', 'e2e setup / run', false, {
    error: redactAll(error.stack ?? error.message), dshTail: procs.dsh?.tail.slice(-20).map(redactAll), appTail: procs.app?.tail.slice(-8).map(redactAll),
  })
} finally {
  await cleanup()
}

const SCENARIOS = { a: 'unlinked guide → link code → linked', b: 'question → generated read tool under delegation', c: 'inspection.overdue → AI 秘書 notification', d: 'approval card → button / reply code → card updated', e: 'manifest playbook → one run per event → proposal', f: 'delegation isolation', g: 'link guard on IM answers' }
const byScenario = Object.fromEntries(Object.keys(SCENARIOS).map((k) => {
  const steps = results.filter((r) => r.scenario === k)
  return [k, steps.length && steps.every((r) => r.status === 'pass') ? 'pass' : 'fail']
}))
const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
const ok = !fatal && !counts.fail && Object.values(byScenario).every((s) => s === 'pass')
const summary = {
  ok,
  at: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - t0) / 1000),
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, label]) => [k, { label, status: byScenario[k] }])),
  counts,
  environment: {
    app: `127.0.0.1:${PORTS.app} (db ${DB_NAME})`, dsh: `127.0.0.1:${PORTS.dsh} home ${HOME} profile ${PROFILE}`, gateway: PORTS.gateway,
    mockLlm: PORTS.llm, mockLine: PORTS.line, otherApplication: PORTS.other,
    llmRequests: mocks?.llm.requests.length ?? null, lineApiCalls: mocks?.line.log.length ?? null,
  },
  results,
}
mkdirSync(WORK, { recursive: true })
if (mocks) {
  writeFileSync(join(WORK, 'llm-requests.json'), redactAll(JSON.stringify(mocks.llm.requests, null, 2)) + '\n', 'utf8')
  writeFileSync(join(WORK, 'line-api.json'), redactAll(JSON.stringify(mocks.line.log, null, 2)) + '\n', 'utf8')
}
if (STORY && mocks) printStory({ said, lineLog: mocks.line.log, users: LINE_USERS })
writeFileSync(join(WORK, 'result.json'), redactAll(JSON.stringify(summary, null, 2)) + '\n', 'utf8')
if (!JSON_ONLY) {
  console.log('\n== framework e2e ==')
  for (const [k, label] of Object.entries(SCENARIOS)) console.log(`${byScenario[k] === 'pass' ? 'PASS' : 'FAIL'}  ${k}  ${label}`)
  console.log(`\n${JSON.stringify(counts)}  ${summary.durationSeconds}s  → ${join(WORK, 'result.json')}`)
}
console.log(JSON.stringify({ ok: summary.ok, scenarios: Object.fromEntries(Object.entries(byScenario)), counts, durationSeconds: summary.durationSeconds }))
process.exit(ok ? 0 : 1)
