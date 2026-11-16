/**
 * 无宿主冒烟测试：用假的 ctx 直接加载 lib/index.js，覆盖 P1–P4 的 API 与工具。
 * 运行：node test/host-smoke.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-smoke-'))
process.env.DSH_HOME = home

const results = []
const check = (label, cond, extra = '') => {
  results.push({ label, ok: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
}

// ---- fake host -------------------------------------------------------------
const tools = new Map()
const sent = []
const createdSchedules = []
let catalog = []
let webHandler = null

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
  inject(_deps, cb) { return cb(ctx) },
  get(name) {
    if (name !== 'dshIm') return undefined
    return {
      async send(botId, targetId, text, options) {
        sent.push({ botId, targetId, text, options })
        return { sent: true }
      },
      async listBots() { return [{ botId: 'bot1', channel: 'weixin' }] },
      async listTargets() { return [{ targetId: 't1', name: '测试目标', kind: 'user', route: { toUserId: 'u1' } }] },
    }
  },
  tools: {
    register(def) { tools.set(def.name, def); return () => tools.delete(def.name) },
  },
  schedule: {
    async create(sessionId, request) {
      if (request.cron && !request.cron.expression) throw new Error('invalid cron')
      const id = `sch-${createdSchedules.length + 1}`
      createdSchedules.push({ id, sessionId, request })
      return { id }
    },
    async delete() { return { ok: true } },
    async catalog() { return catalog },
  },
  webServer: {
    register(route) { webHandler = route.handler; return () => { webHandler = null } },
  },
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
plugin.apply(ctx, {})
check('plugin exports name', plugin.name === 'dsh-auto-tasks', plugin.name)
check('4 tools registered', tools.size === 4, String(tools.size))
check('http handler installed', typeof webHandler === 'function')

// ---- http helpers ----------------------------------------------------------
function req(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    headers: { 'x-auto-tasks-client': 'cli', 'x-auto-tasks-confirm': '1' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
function res() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = String(b) },
  }
}
async function call(method, path, body) {
  const r = res()
  await webHandler(req(method, path, body), r)
  let json = null
  try { json = JSON.parse(r.body) } catch { /* ignore */ }
  return { status: r.statusCode, json }
}

// ---- P1: create + test delivery + deliverOn --------------------------------
let r = await call('GET', '/auto-tasks/api/health')
check('health ok + version 0.2.0', r.json?.ok === true && r.json?.version === '0.2.0', r.json?.version)

r = await call('POST', '/auto-tasks/api/delivery/test', { botId: 'bot1', targetId: 't1' })
check('P1 test delivery -> sent', r.json?.ok === true && sent.length === 1)

r = await call('POST', '/auto-tasks/api/tasks', {
  sessionId: 'session-test',
  name: '任务A',
  instruction: '做点什么并汇报',
  enabled: true,
  delivery: { channels: [{ botId: 'bot1', targetId: 't1', format: 'markdown' }] },
  feedback: { deliverOn: ['failed'], respectQuietHours: false },
  guard: { maxConsecutiveFailures: 1 },
})
const taskA = r.json?.task
check('create task A', r.status === 200 && !!taskA?.id, taskA?.id)

let report = await tools.get('auto_task_report').execute({ taskId: taskA.id, status: 'done', summary: '完成' })
const reportsAfterDone = await call('GET', '/auto-tasks/api/reports?limit=5')
const lastDone = reportsAfterDone.json.reports[0]
check('P1 deliverOn filters done (deferred=status, no send)',
  lastDone.deferred === 'status' && lastDone.delivered.length === 0)

report = await tools.get('auto_task_report').execute({ taskId: taskA.id, status: 'failed', summary: '失败' })
const reportsAfterFail = await call('GET', '/auto-tasks/api/reports?limit=5')
const lastFail = reportsAfterFail.json.reports[0]
check('P1 delivery on failed + retry metadata',
  lastFail.delivered.length === 1 && lastFail.delivered[0].ok === true && lastFail.delivered[0].attempts === 1)

// 连续失败自动暂停（阈值为 1）
r = await call('GET', '/auto-tasks/api/tasks?sessionId=session-test')
check('P2 auto-pause after failure threshold', r.json.tasks[0].enabled === false && !!r.json.tasks[0].pauseReason,
  r.json.tasks[0].pauseReason)

// ---- P2: quiet hours + unread full count -----------------------------------
r = await call('POST', '/auto-tasks/api/tasks', {
  sessionId: 'session-test',
  name: '任务B',
  instruction: '静默巡检',
  enabled: false,
  delivery: { channels: [{ botId: 'bot1', targetId: 't1' }] },
  feedback: { deliverOn: ['done'], respectQuietHours: true, quietHours: { start: '00:00', end: '23:59', timeZone: 'UTC' } },
})
const taskB = r.json.task
await tools.get('auto_task_report').execute({ taskId: taskB.id, status: 'done', summary: '免打扰测试' })
r = await call('GET', '/auto-tasks/api/reports?limit=1')
check('P2 quiet hours defers delivery', r.json.reports[0].deferred === 'quietHours')

r = await call('GET', '/auto-tasks/api/reports?limit=1')
check('P2 unread counts whole ledger', typeof r.json.unread === 'number' && r.json.unread >= 1, String(r.json.unread))
const readRes = await call('POST', '/auto-tasks/api/reports/read', { ids: [] })
check('P2 mark all read', readRes.json.unread === 0)

// ---- P4: evidence gate -----------------------------------------------------
// the artifact the gate looks for lives in a throwaway workspace (no machine-specific path)
const evidenceWs = join(home, 'evidence-workspace')
mkdirSync(join(evidenceWs, 'docs'), { recursive: true })
writeFileSync(join(evidenceWs, 'docs', 'e2e-marker.txt'), 'smoke\n')
r = await call('POST', '/auto-tasks/api/tasks', {
  sessionId: 'session-test',
  name: '任务C',
  instruction: '需要证据',
  enabled: false,
  workspacePath: evidenceWs.split('\\').join('/'),
  guard: { requireEvidence: true },
})
const taskC = r.json.task
await tools.get('auto_task_report').execute({ taskId: taskC.id, status: 'done', summary: '假完成' })
r = await call('GET', '/auto-tasks/api/reports?limit=1')
check('P4 evidence gate downgrades missing artifacts',
  r.json.reports[0].status === 'needsDecision' && r.json.reports[0].verifyFailed)

await tools.get('auto_task_report').execute({ taskId: taskC.id, status: 'done', summary: '真完成', artifacts: ['docs/e2e-marker.txt'] })
r = await call('GET', '/auto-tasks/api/reports?limit=1')
check('P4 evidence gate accepts existing artifact', r.json.reports[0].status === 'done')

// ---- P4: approve -> schedule ----------------------------------------------
r = await call('GET', '/auto-tasks/api/reports?limit=10')
const needs = r.json.reports.find((x) => x.status === 'needsDecision' && x.taskId === taskC.id)
const beforeApprove = createdSchedules.length
r = await call('POST', '/auto-tasks/api/reports/approve', { id: needs.id })
check('P4 approve schedules a real run',
  r.status === 200 && createdSchedules.length === beforeApprove + 1 &&
  createdSchedules.at(-1).request.after_seconds === 1)

// ---- P3: inbox -------------------------------------------------------------
const inbox = join(home, 'auto-tasks', 'inbox')
mkdirSync(inbox, { recursive: true })
writeFileSync(join(inbox, 'lead.eml'), [
  'From: client@example.com',
  'Subject: 想了解报价',
  'Date: 2026-10-24T10:00:00+08:00',
  '',
  '你好，我们是某某公司，想了解你们的报价与交付周期。',
].join('\n'), 'utf8')

r = await call('GET', '/auto-tasks/api/inbox')
check('P3 inbox lists eml candidate', r.json.items.length === 1 && r.json.items[0].from === 'client@example.com')
r = await call('POST', '/auto-tasks/api/inbox/adopt', { file: 'lead.eml', sessionId: 'session-test' })
const adopted = r.json.task
check('P3 adopt creates disabled task', r.status === 200 && adopted.enabled === false && adopted.source.kind === 'inbox')
check('P3 adopted file moved to adopted/',
  !existsSync(join(inbox, 'lead.eml')) && readdirSync(join(inbox, 'adopted')).length === 1)
r = await call('GET', '/auto-tasks/api/inbox')
check('P3 inbox empty after adopt', r.json.items.length === 0)

// ---- P0/可靠性: update keeps old schedule on bad trigger -------------------
r = await call('POST', '/auto-tasks/api/tasks', {
  sessionId: 'session-test', name: '任务D', instruction: 'x', enabled: true,
  trigger: { type: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
})
const taskD = r.json.task
const bad = await call('POST', '/auto-tasks/api/tasks/update', {
  id: taskD.id, trigger: { type: 'cron', expr: '', timeZone: 'Asia/Shanghai' },
})
check('reliability: invalid update rejected', bad.status === 400)

// ---- 汇总 ------------------------------------------------------------------
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  for (const f of failed) console.log('FAILED:', f.label, f.extra)
  process.exitCode = 1
}
rmSync(home, { recursive: true, force: true })



