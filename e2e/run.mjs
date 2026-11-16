#!/usr/bin/env node
// biz-ai-agent end to end on a REAL DSH: the leave-requests pilot (memory store, in this process) + the framework's product
// profile template + bridge-knowledge (tool module and citation guard) + bridge-graph, with a mock model and a mock LINE.
// No real IM, no real model, no real keys (every secret is generated per run), no database.
//
//   node e2e/run.mjs [--keep]           (npm run e2e)    BIZ_AI_FRAMEWORK=<framework checkout> (default ../framework)
//
// It reuses the framework's own e2e parts (packages/testing: the pinned DSH CLI in <framework>/.dsh-cli, the isolated home,
// mock LLM / LINE; packages/gateway; profile/template and profile/scripts/install.mjs) exactly as framework/packages/testing/
// e2e/run.mjs does, only with this repository's application and plugins:
//   - @dsh-bridge/plugin-knowledge is installed into the profile as a file: dependency; its tool module and its citation guard
//     (@dsh-bridge/plugin-knowledge/guard, a cordis plugin) load from that one copy, so they share the source ledger
//   - @dsh-bridge/plugin-graph is a toolModules entry by file URL (it needs @dsh-bridge/graph from this workspace)
// Scenarios (PASS / FAIL each, JSON in e2e/.work/result.json):
//   k1  staff: a rule question → leave_knowledge_search with the staff member's delegation → LINE answer with the citation guard's
//       "Sources:" (the handbook screen) and the link guard's removal of a foreign link
//   k2  staff: a managers-only rule → found=false (nothing restricted in the tool result); k3 the manager: the restricted rule
//   s1  the settings plugin: an administrator uploads a document → the approval card reaches the OTHER administrator on LINE →
//       they press 承認 there → published → the knowledge.updated report reaches the administrators on LINE;
//       s2 staff then get the new document as a source
//   g1  a leave request on the web → the approval card reaches the manager on LINE; "why did this reach me?" →
//       leave_graph_why with the manager's delegation → the manifest's reasons; g2 another staff member → not found
// Ports (BIZ_AI_E2E_PORTS="app=19751,dsh=3251,llm=3252,line=3253,gateway=3254"); the framework e2e's and demo ports are refused.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..')
const FRAMEWORK = resolve(process.env.BIZ_AI_FRAMEWORK || join(REPO, '..', 'framework'))
if (!existsSync(join(FRAMEWORK, 'profile', 'template', 'cordis.patch.yml'))) {
  console.error(`the framework checkout was not found at ${FRAMEWORK} (set BIZ_AI_FRAMEWORK)`)
  process.exit(2)
}
const fw = (p) => import(pathToFileURL(join(FRAMEWORK, p)).href)
const { pickDshBin } = await fw('packages/testing/src/dsh-cli.mjs')
const { assertIsolatedHome, assertPortsUsable, redactor, startDsh } = await fw('packages/testing/src/dsh-home.mjs')
const { flexSummary, lineWebhookSender, randomLineUserId, startMockLine } = await fw('packages/testing/src/mock-line.mjs')
const { startMockLlm } = await fw('packages/testing/src/mock-llm.mjs')
const { sleep, waitFor } = await fw('packages/testing/src/procs.mjs')
const { createDshGateway, fromValue } = await fw('packages/gateway/src/index.mjs')
const { startServer } = await import(pathToFileURL(join(REPO, 'examples', 'leave-requests-knowledge', 'src', 'app.mjs')).href)

const KEEP = process.argv.includes('--keep')
// --serve: after the scenarios, keep the pilot (with the DSH gateway), DSH and the mocks running for a person to look at
const SERVE = process.argv.includes('--serve')
const WORK = join(here, '.work')
const HOME = resolve(REPO, '.dsh-home-e2e')
const PROFILE = 'biz-ai-agent-e2e'
const APP_ID = 'leave-requests'
const APP_NAME = 'Leave Requests'
const PORTS = { app: 19751, dsh: 3251, llm: 3252, line: 3253, gateway: 3254 }
for (const part of String(process.env.BIZ_AI_E2E_PORTS ?? '').split(',').filter(Boolean)) {
  const [k, v] = part.split('=')
  if (!(k in PORTS) || !/^\d{2,5}$/.test(v ?? '')) throw new Error(`BIZ_AI_E2E_PORTS: bad entry ${part}`)
  PORTS[k] = Number(v)
}
const FORBIDDEN_PORTS = [3080, 3180, 8790, 3010, 19720, 19730, 19741, 3241, 3242, 3243, 3244, 3245]
const WEB = `http://127.0.0.1:${PORTS.app}`
const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`
const SECRETS = {
  service: `e2e-svc-${randomBytes(24).toString('hex')}`,
  bff: `e2e-bff-${randomBytes(24).toString('hex')}`,
  password: `E2e-${randomBytes(12).toString('hex')}`,
  llmKey: `e2e-mock-llm-${randomBytes(8).toString('hex')}`,
  lineSecret: randomBytes(16).toString('hex'),
  lineToken: `e2eMockLineToken${randomBytes(24).toString('base64url')}`,
}
const LINE_BOT_USER = randomLineUserId()
const LINE_USERS = { admin: randomLineUserId(), admin2: randomLineUserId(), manager: randomLineUserId(), staff1: randomLineUserId(), staff2: randomLineUserId() }
const redactAll = redactor(Object.values(SECRETS))
const slash = (p) => p.replace(/\\/g, '/')
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

const results = []
function record(scenario, step, ok, evidence = {}) {
  const status = ok ? 'pass' : 'fail'
  results.push({ scenario, step, status, evidence })
  console.log(`${status.toUpperCase().padEnd(4)}  [${scenario}] ${step}`)
  if (!ok) console.log(`      ${redactAll(JSON.stringify(evidence)).slice(0, 900)}`)
}
const cleanups = []
async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch (error) { console.log(`cleanup: ${error.message}`) }
  }
}

// ── the product profile: profile/template made into one for leave-requests + this repository's plugins ─────────────────
function makeProductProfile() {
  const src = join(WORK, 'profile-src')
  rmSync(src, { recursive: true, force: true })
  cpSync(join(FRAMEWORK, 'profile', 'template'), src, { recursive: true })
  const file = join(src, 'cordis.patch.yml')
  let text = readFileSync(file, 'utf8')
  const replace = (from, to, label) => {
    if (!text.includes(from)) throw new Error(`profile template changed: ${label} not found`)
    text = text.replace(from, to)
  }
  const start = text.indexOf('    applications:\n')
  const end = text.indexOf('    # compat:', start)
  if (start < 0 || end < 0) throw new Error('profile template changed: bridge-apps applications block not found')
  text = text.slice(0, start) + [
    '    applications:',
    `      - id: ${APP_ID}`,
    `        name: ${APP_NAME}`,
    '        namespace: leave',
    '        default: true',
    '        paths: v1',
    '        apiUrlEnv: LEAVE_API_URL',
    '        serviceTokenEnv: LEAVE_SERVICE_TOKEN',
    '        manifestUrl: /bridge/v1/manifest',
    `        manifestFile: ${JSON.stringify(slash(join(REPO, 'examples', 'leave-requests-knowledge', 'bridge.manifest.yaml')))}`,
    '        generateTools: false                # bridge-tools generates the read tools AFTER the hand-written ones (no name clash)',
    '        bots: []',
    '',
  ].join('\n') + text.slice(end)
  text = text.split('<アプリ名>').join(APP_NAME).split('<namespace>').join('leave')
  replace('    # linkGuard:\n    #   webUrl: <business web URL of the default application>          # e.g. https://app.example.com\n',
    `    linkGuard:\n      webUrl: ${WEB}\n`, 'bridge-identity linkGuard')
  const knowledgeModule = pathToFileURL(join(HOME, 'profiles', PROFILE, 'node_modules', '@dsh-bridge', 'plugin-knowledge', 'src', 'index.js')).href
  const graphModule = pathToFileURL(join(REPO, 'plugins', 'graph', 'src', 'index.js')).href
  replace("    # toolModules:\n    #   - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: equipment-inspection }\n",
    `    toolModules:\n      - { module: '${knowledgeModule}', application: ${APP_ID} }\n      - { module: '${graphModule}', application: ${APP_ID} }\n`, 'bridge-tools toolModules')
  if (/^ {4}digestMinutes: 30 .*$/m.test(text)) text = text.replace(/^ {4}digestMinutes: 30 .*$/m, '    digestMinutes: 0\n    honorQuietHours: false')
  const presetAt = text.indexOf('- insert:\n    - id: preset-business-assistant')
  if (presetAt < 0) throw new Error('profile template changed: preset-business-assistant not found')
  text = `${text.slice(0, presetAt)}- id: bridge-events\n  config:\n    pollIntervalSeconds: 1\n    maxBackoffSeconds: 5\n\n${text.slice(presetAt)}`
  if (/:\s*<[^>]+>/.test(text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'))) throw new Error('placeholders left in the e2e product profile')
  writeFileSync(file, text, 'utf8')
  const pkgFile = join(src, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.dependencies['@dsh-bridge/plugin-knowledge'] = `file:${slash(join(REPO, 'plugins', 'knowledge'))}`
  // its bundle inserts the citation guard (after bridge-identity, so the link guard's filter is registered first)
  pkg.dsh.profile.bundles.push('@dsh-bridge/plugin-knowledge')
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  return src
}

function runInstall(src) {
  const r = spawnSync(process.execPath, [
    join(FRAMEWORK, 'profile', 'scripts', 'install.mjs'), '--source', src, '--home', HOME, '--profile', PROFILE, '--framework-root', FRAMEWORK,
  ], { cwd: FRAMEWORK, encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME }, timeout: 600_000, windowsHide: true })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(join(WORK, 'install.log'), redactAll(out))
  if (r.status !== 0) throw new Error(`install.mjs failed (exit ${r.status}): ${redactAll(out).slice(-1200)}`)
  return out
}

// Before framework d8b3538 the dsh-im fork's `dshIm` service object (plugin-src/host/index.mjs ctx.provide('dshIm', …)) did not
// pass setAnswerFilter on, so NO answer filter was installed on a real DSH — neither bridge-identity's link guard nor the citation
// guard (found by this e2e). The [upstream] step checks it. --patch-dsh-im is only for an OLDER framework checkout: it adds the
// missing line to the copy installed in THIS isolated home (the file is replaced, never written through a pnpm hardlink); with
// d8b3538 or later it does nothing.
const PATCH_DSH_IM = process.argv.includes('--patch-dsh-im')
const DSH_IM_SERVICE_END = /setConversationRouter:([A-Za-z_$][\w$]*)\.setConversationRouter\}/
function dshImExposesAnswerFilter() {
  const file = join(HOME, 'profiles', PROFILE, 'node_modules', '@care', 'dsh-im', 'lib', 'index.js')
  const text = readFileSync(file, 'utf8')
  const m = DSH_IM_SERVICE_END.exec(text)
  if (!m) throw new Error('dsh-im build changed: the dshIm service object was not found')
  return { file, text, m, exposed: new RegExp(`setAnswerFilter:${m[1].replace('$', '\\$')}\\.setAnswerFilter`).test(text) }
}
function patchDshIm() {
  const { file, text, m, exposed } = dshImExposesAnswerFilter()
  if (exposed) return false
  rmSync(file, { force: true })
  writeFileSync(file, text.replace(m[0], `setConversationRouter:${m[1]}.setConversationRouter,setAnswerFilter:${m[1]}.setAnswerFilter}`), 'utf8')
  return true
}

function writeOverlay() {
  const file = join(WORK, 'overlay.yml')
  writeFileSync(file, `# e2e overlay: the mock model
- id: llm-pi-ai
  config:
    providers:
      e2e-mock:
        displayName: e2e mock (OpenAI compatible)
        apiKeyEnv: BIZ_AI_E2E_MOCK_LLM_KEY
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

async function startGateway(token) {
  const gateway = createDshGateway({
    target: `http://127.0.0.1:${PORTS.dsh}`,
    mountPath: '/dsh',
    getSessionUser: async () => null,
    isAllowed: () => false,
    launchToken: fromValue(token),
    logger: { info() {}, warn: (...m) => console.log('[gateway]', ...m.map(redactAll)), error: (...m) => console.log('[gateway]', ...m.map(redactAll)) },
    publicPaths: ['/dsh-hooks/line'],
    rpcAllowlist: [{ channel: '/line', methods: ['connection.status', 'bot.bind-credentials'] }],
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

// ── the mock model: decides from the employee's words and the tool results (nothing real) ────────────────────────────
const FOREIGN = 'https://evil.example/leave'
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
function llmScript({ body, userText, toolResults, findTool }) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: 'Leave question' } // titles and the like
  const flow = (name, args, finish) => {
    const tool = findTool(name)
    if (!tool) return { text: `E2E: ${name} is not in the tool list.` }
    if (toolResults.length === 0) return { toolCall: { name: tool, arguments: args } }
    return { text: finish(toolResults.at(-1).content) }
  }
  if (/carry over/i.test(userText)) {
    // an answer WITHOUT citations and with a foreign link: the citation guard and the link guard must repair it
    return flow('leave_knowledge_search', { question: 'Can I carry over unused leave days?' },
      (c) => (/found=false/.test(c) ? 'The documents have nothing on that.' : `Up to 5 unused days carry over and must be used by 31 March. More at ${FOREIGN}`))
  }
  if (/lockers/i.test(userText)) {
    return flow('leave_knowledge_search', { question: 'Where are the lockers?' }, (c) => (/found=false/.test(c) ? 'The documents have nothing on that.' : `The lockers are on the second floor [1].

Sources:
[1] ${/## \[1\] (.+)/.exec(c)?.[1] ?? ''} — ${/url: (\S+)/.exec(c)?.[1] ?? ''}`))
  }
  if (/blackout/i.test(userText)) {
    return flow('leave_knowledge_search', { question: 'year-end blackout: how many people of one team may be on leave' },
      (c) => {
        if (/found=false/.test(c)) return 'The documents you can read have nothing on that. Please ask the administrator.'
        const url = /url: (\S+)/.exec(c)?.[1] ?? ''
        return `During the year-end blackout at most 2 people of one team may be on leave [1].\n\nSources:\n[1] ${/## \[1\] (.+)/.exec(c)?.[1] ?? ''} — ${url}`
      })
  }
  const why = /why did approval (\S+) reach me/i.exec(userText)
  if (why) {
    const id = UUID.exec(why[1])?.[1] ?? why[1]
    return flow('leave_graph_why', { entity: 'approval', id }, (c) => {
      if (/found=false/.test(c)) return 'I could not find that approval for you.'
      const reasons = c.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/ \[rule: [^\]]*\]$/, ''))
      return `It reached you because:\n${reasons.join('\n')}`
    })
  }
  return { text: 'E2E mock answer.' }
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────────────────
const messageText = (e) => (e?.messages ?? []).map((m) => (m.type === 'text' ? m.text : m.type === 'flex' ? [m.altText, ...flexSummary(m).texts].join('\n') : '')).join('\n')
const toUser = (event, userId) => (e) => (e.kind === 'reply' && e.replyToken === event.replyToken) || (e.kind === 'push' && e.to === userId)

async function main() {
  await assertPortsUsable(PORTS, { forbidden: FORBIDDEN_PORTS })
  assertIsolatedHome(HOME)
  mkdirSync(WORK, { recursive: true })
  for (const f of ['dsh.log', 'install.log']) rmSync(join(WORK, f), { force: true })
  const DSH = pickDshBin({ framework: FRAMEWORK, log: console.log }).bin

  console.log('— setup')
  rmSync(join(WORK, 'agent-data'), { recursive: true, force: true })
  let dshToken = null // the DSH launch token, known once DSH runs (the pilot's DSH gateway asks for it per exchange)
  const srv = await startServer({
    port: PORTS.app, serviceToken: SECRETS.service, bffSecret: SECRETS.bff, webBase: WEB, dataDir: join(WORK, 'agent-data'), agentEnv: {},
    dsh: { target: `http://127.0.0.1:${PORTS.dsh}`, launchToken: async () => { if (!dshToken) throw new Error('DSH not started'); return dshToken } },
  })
  cleanups.push(() => srv.stop())
  const people = {}
  for (const [loginId, role] of [['manager', 'manager'], ['staff1', 'staff'], ['staff2', 'staff'], ['admin', 'admin'], ['admin2', 'admin']]) {
    const u = await srv.app.createUser({ loginId, password: SECRETS.password, role, displayName: `E2E ${loginId}` })
    const res = await fetch(`${WEB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: SECRETS.password }) })
    people[loginId] = { id: u.id, cookie: res.headers.get('set-cookie').split(';')[0] }
  }
  const call = async (method, path, { cookie, body } = {}) => {
    const res = await fetch(`${WEB}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const t = await res.text()
    return { status: res.status, data: t ? JSON.parse(t) : null }
  }

  const llm = await startMockLlm({ port: PORTS.llm, script: llmScript, expectKey: SECRETS.llmKey, model: 'mock-bridge' })
  cleanups.push(() => llm.close())
  const line = await startMockLine({ port: PORTS.line, channelAccessToken: SECRETS.lineToken, botUserId: LINE_BOT_USER })
  cleanups.push(() => line.close())

  const src = makeProductProfile()
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  cleanups.push(() => (KEEP ? console.log(`kept ${HOME}`) : rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })))
  runInstall(src)
  const patch = readFileSync(join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8')
  record('setup', 'install.mjs: the profile has the knowledge + graph tool modules, the citation guard and the link guard URL',
    /plugin-knowledge\/src\/index\.js/.test(patch) && /plugins\/graph\/src\/index\.js/.test(patch) && /plugin-knowledge/.test(readFileSync(join(HOME, 'profiles', PROFILE, 'package.json'), 'utf8')) && patch.includes(`webUrl: ${WEB}`)
      && existsSync(join(HOME, 'profiles', PROFILE, 'node_modules', '@dsh-bridge', 'plugin-knowledge', 'src', 'guard.js')), {})
  const exposedBefore = dshImExposesAnswerFilter().exposed
  record('upstream', 'the installed dsh-im passes setAnswerFilter on in its dshIm service (else no link guard and no citation guard run)', exposedBefore || PATCH_DSH_IM, {
    exposedByTheFramework: exposedBefore, patchedInThisHome: PATCH_DSH_IM ? patchDshIm() : false,
  })

  const { proc, token } = await startDsh({
    bin: DSH, home: HOME, profile: PROFILE, port: PORTS.dsh, patch: writeOverlay(), publicUrl: `${GATEWAY}/dsh/`,
    logFile: join(WORK, 'dsh.log'), secrets: Object.values(SECRETS),
    env: {
      LEAVE_API_URL: WEB, LEAVE_SERVICE_TOKEN: SECRETS.service, BRIDGE_WEB_PUBLIC_URL: WEB,
      CARE_DSH_IM_LINE_API_BASE: `http://127.0.0.1:${PORTS.line}`, BIZ_AI_E2E_MOCK_LLM_KEY: SECRETS.llmKey,
    },
  })
  cleanups.push(() => proc.stop())
  dshToken = token
  const gateway = await startGateway(token)
  await waitFor(async () => (await gateway.rpc('/line', 'connection.status', {})).ok, { timeoutMs: 90_000, stepMs: 1000, label: 'dsh-im /line RPC' })
  const bound = await gateway.rpc('/line', 'bot.bind-credentials', { channelSecret: SECRETS.lineSecret, channelAccessToken: SECRETS.lineToken }, { timeoutMs: 60_000 })
  if (!bound.ok) throw new Error(`LINE bind failed: ${JSON.stringify(bound.error)}`)
  await waitFor(async () => {
    const s = await gateway.rpc('/line', 'connection.status', {})
    return s.ok && s.value?.bots?.some((b) => b.connected) ? s.value : null
  }, { timeoutMs: 30_000, stepMs: 500, label: 'LINE bot connected' })
  const dshLog = () => (existsSync(join(WORK, 'dsh.log')) ? readFileSync(join(WORK, 'dsh.log'), 'utf8') : '')
  const moduleErrors = dshLog().split('\n').filter((l) => /toolModules|tool module|bridge-knowledge|bridge-graph/i.test(l) && /fail|error|cannot|missing/i.test(l)).slice(0, 5)
  record('setup', 'DSH started on the isolated home; no error from the tool modules or the citation guard', moduleErrors.length === 0, { moduleErrors })

  const webhook = lineWebhookSender({ url: `${GATEWAY}/dsh-hooks/line`, channelSecret: SECRETS.lineSecret, botUserId: LINE_BOT_USER })
  const say = async (who, text, pattern, { timeoutMs = 90_000 } = {}) => {
    const at = Date.now()
    const reqBefore = llm.requests.length
    const sent = await webhook.text(LINE_USERS[who], text)
    const reply = await line.waitForMessage((e) => toUser(sent.event, LINE_USERS[who])(e) && (!pattern || pattern.test(messageText(e))), { since: at, timeoutMs })
    const reqs = llm.requests.slice(reqBefore)
    await sleep(3000)
    const all = line.log.filter((e) => e.at >= at && toUser(sent.event, LINE_USERS[who])(e)).map((e) => ({ kind: e.kind, text: messageText(e).slice(0, 400) }))
    return {
      all,
      text: reply ? messageText(reply) : null,
      toolCall: reqs.find((q) => q.decision?.toolCall)?.decision.toolCall ?? null,
      toolResult: reqs.find((q) => q.toolResults.length)?.toolResults.at(-1)?.content ?? '',
    }
  }

  // link the three employees' LINE accounts (each one on their own login: link code → 「連携 123456」)
  const linked = {}
  for (const who of ['admin', 'admin2', 'manager', 'staff1', 'staff2']) {
    const code = (await call('POST', '/bridge/v1/me/link-codes', { cookie: people[who].cookie })).data?.code
    const r = await say(who, `連携 ${code}`, /連携/, { timeoutMs: 30_000 })
    linked[who] = r.text
  }
  record('setup', 'admin, admin2, manager, staff1, staff2 linked their LINE accounts with their own link codes', Object.values(linked).every((t) => /連携が完了/.test(t ?? '')), linked)

  // the settings screen's SNS page: dsh-im through the pilot's own DSH gateway (administrators only)
  {
    const rpc = (cookie) => fetch(`${WEB}/dsh/api/dsh-im/line`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${Date.now()}`, method: 'dsh-im/line', payload: { method: 'connection.status', payload: {} } }) }) // web-kit buildEnvelope
    const admin = await rpc(people.admin.cookie)
    const body = admin.ok ? await admin.json() : null
    const staff = await rpc(people.staff1.cookie)
    const anon = await rpc(null)
    const shell = await fetch(`${WEB}/agent-settings`, { headers: { cookie: people.admin.cookie } })
    const gatewayInShell = (await shell.text()).includes('"gateway":{"rpcBase":"/dsh/api/dsh-im"}')
    record('sns', "the settings screen's SNS page reaches dsh-im through the pilot's DSH gateway: the admin sees the LINE bot connected; staff and anonymous are refused",
      admin.ok && body?.result?.ok === true && (body.result.value?.bots ?? body.result.value?.snapshot?.bots ?? []).some((b) => b.connected) && [401, 403].includes(staff.status) && [401, 403].includes(anon.status) && gatewayInShell,
      { admin: admin.status, connected: (body?.result?.value?.bots ?? body?.result?.value?.snapshot?.bots ?? []).filter((b) => b.connected).length, staff: staff.status, anonymous: anon.status, shell: shell.status, gatewayInShell })
  }
  // k1: a rule question as staff1
  {
    const r = await say('staff1', 'Can I carry over unused leave?', /carry over|nothing/i)
    const source = `${WEB}/handbook/leave-policy#carry-over`
    record('k1', 'staff1 → leave_knowledge_search (delegated) → LINE answer: the citation guard appended the handbook source, the link guard removed the foreign link',
      r.toolCall?.name?.endsWith('leave_knowledge_search') && r.toolResult.includes(source) && /Sources:/.test(r.text ?? '') && (r.text ?? '').includes(source) && !(r.text ?? '').includes('evil.example'),
      { reply: r.text, all: r.all, toolCall: r.toolCall, toolResultExcerpt: r.toolResult.slice(0, 200) })
  }
  // k2 / k3: the managers-only rule
  {
    const s = await say('staff1', 'What is the year-end blackout rule?', /blackout|nothing/i)
    record('k2', 'staff1 asks a managers-only rule → found=false; nothing of the restricted section in the tool result or the answer',
      /found=false/.test(s.toolResult) && !s.toolResult.includes('approval-rules') && !/at most 2 people/.test(s.text ?? '') && /nothing/.test(s.text ?? ''),
      { reply: s.text, toolResultExcerpt: s.toolResult.slice(0, 300) })
    const m = await say('manager', 'What is the year-end blackout rule?', /blackout|nothing/i)
    record('k3', 'the manager asks the same → the restricted rule with its source on the handbook screen',
      m.toolResult.includes(`${WEB}/handbook/leave-policy#approval-rules`) && (m.text ?? '').includes(`${WEB}/handbook/leave-policy#approval-rules`),
      { reply: m.text, toolResultExcerpt: m.toolResult.slice(0, 300) })
  }
  // s1 / s2: the settings plugin — a document approved on SNS, the report on SNS, then used by the AI
  {
    const at = Date.now()
    const up = await call('POST', '/api/agent/documents', { cookie: people.admin.cookie, body: { title: 'Office lockers', roles: ['admin', 'manager', 'staff'], keywords: ['locker', 'key'], text: '## Lockers {#lockers}\nLockers are on the second floor. The facilities desk hands out the keys.' } })
    const docId = up.data?.document?.id
    const card = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.admin2 && e.messages.some((x) => x.type === 'flex') && /Knowledge document/.test(messageText(e)), { since: at, timeoutMs: 90_000 })
    const flex = card ? flexSummary(card.messages.find((x) => x.type === 'flex')) : null
    const approve = flex?.buttons.find((b) => b.type === 'postback' && /approve/.test(b.data ?? ''))
    const toUploader = line.log.filter((e) => e.at >= at && e.to === LINE_USERS.admin && /Knowledge document/.test(messageText(e))).length
    record('s1', 'admin uploads a document on the settings screen → approval.requested → the approval card reaches admin2 on LINE (never the uploader)',
      up.status === 201 && up.data.document.status === 'pending' && Boolean(approve) && toUploader === 0, { upload: up.status, card: card ? messageText(card).slice(0, 300) : null, toUploader })
    let published = null
    let report = null
    if (approve) {
      const pressedAt = Date.now()
      await webhook.postback(LINE_USERS.admin2, approve.data)
      published = await waitFor(async () => ((await call('GET', '/api/agent/documents', { cookie: people.admin.cookie })).data?.documents ?? []).find((d) => d.id === docId && d.status === 'published') ?? null, { timeoutMs: 30_000, stepMs: 500, label: 'published' }).catch(() => null)
      report = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.admin && /knowledge was rebuilt/i.test(messageText(e)), { since: pressedAt, timeoutMs: 60_000 })
    }
    const reportToStaff = line.log.filter((e) => e.at >= at && [LINE_USERS.staff1, LINE_USERS.staff2, LINE_USERS.manager].includes(e.to) && /knowledge was rebuilt/i.test(messageText(e))).length
    record('s1', 'admin2 presses 承認 on LINE → the document is published → the knowledge.updated report (counts only) reaches the administrators on LINE, nobody else',
      Boolean(published && report) && reportToStaff === 0, { published: Boolean(published), report: report ? messageText(report).slice(0, 300) : null, reportToStaff })
    const r = await say('staff1', 'Where are the lockers?', /lockers|nothing/i)
    record('s2', 'staff1 asks on LINE → the newly approved document is the source (its handbook screen)',
      r.toolResult.includes(`${WEB}/handbook/${docId}#lockers`) && (r.text ?? '').includes(`${WEB}/handbook/${docId}#lockers`), { reply: r.text, toolResultExcerpt: r.toolResult.slice(0, 300) })
  }
  // g1 / g2: an approval reaches the manager; why?
  {
    const at = Date.now()
    const req = await call('POST', '/api/leave-requests', { cookie: people.staff1.cookie, body: { startsOn: day(10), endsOn: day(12) } })
    const approvalId = req.data?.approval?.id
    const card = await line.waitForMessage((e) => e.kind === 'push' && e.to === LINE_USERS.manager && /Leave request|休暇|承認|Approve/i.test(messageText(e)), { since: at, timeoutMs: 60_000 })
    record('g1', 'staff1 requests leave on the web → approval.requested → the approval card reaches the manager on LINE (bridge-events → bridge-approvals)',
      req.status === 201 && Boolean(card), { request: req.status, card: card ? messageText(card).slice(0, 300) : null })
    const w = await say('manager', `Why did approval ${approvalId} reach me?`, /reached you|could not find/i)
    record('g1', '"why did this approval reach me?" → leave_graph_why with the manager\'s delegation → the manifest\'s reasons (required role, approval.requested audience)',
      w.toolCall?.name?.endsWith('leave_graph_why') && /decision by the role Manager \(manager\)/.test(w.text ?? '') && /approval\.requested/.test(w.text ?? '') && !/E2E staff1/.test(w.text ?? ''),
      { reply: w.text, toolCall: w.toolCall, toolResultExcerpt: w.toolResult.slice(0, 400) })
    const o = await say('staff2', `Why did approval ${approvalId} reach me?`, /reached you|could not find/i)
    record('g2', 'another staff member asks about the same approval → not found (the same as an approval that does not exist)',
      /found=false/.test(o.toolResult) && /could not find/.test(o.text ?? ''), { reply: o.text, toolResultExcerpt: o.toolResult.slice(0, 300) })
  }
  await sleep(300)
  if (SERVE) {
    console.log(`
— serving: ${WEB}/login (admin / admin2 / manager / staff1 / staff2, password in e2e/.work/serve.txt) → ${WEB}/agent-settings ; Ctrl+C to stop`)
    writeFileSync(join(WORK, 'serve.txt'), `${WEB}/login
password: ${SECRETS.password}
`, { mode: 0o600 })
    await new Promise((r) => { process.once('SIGINT', r); process.once('SIGTERM', r) })
  }
}

let failed = false
try {
  await main()
} catch (error) {
  failed = true
  console.log(`ERROR ${redactAll(error.stack ?? String(error))}`)
} finally {
  const summary = { ok: !failed && results.length > 0 && results.every((r) => r.status === 'pass'), pass: results.filter((r) => r.status === 'pass').length, fail: results.filter((r) => r.status === 'fail').length, results }
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, 'result.json'), redactAll(JSON.stringify(summary, null, 2)))
  await cleanup()
  console.log(`# e2e: ${summary.pass} pass, ${summary.fail} fail${failed ? ' (aborted)' : ''}`)
  process.exit(summary.ok ? 0 : 1)
}
