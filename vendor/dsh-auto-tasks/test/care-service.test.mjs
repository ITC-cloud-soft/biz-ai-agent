/**
 * @care fork：ctx.autoTasks（list / trigger / emit）、事件触发、dedupeKey 持久化去重、
 * 投递 idempotencyKey、相对 URL 客户端、进程内 dsh-proactive 服务、回环开关。
 */
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-care-'))
process.env.DSH_HOME = HOME
beforeEach(() => { process.env.DSH_HOME = HOME })

const plugin = await import('../lib/index.js')
const { proactiveBackend } = await import('../lib/backends.js')
const { normalizeConfig } = await import('../lib/config-schema.js')
const runsLib = await import('../lib/runs.js')

function makeHost({ imSend, scheduleCreate } = {}) {
  const host = {
    provided: new Map(),
    schedules: [],
    sends: [],
    tools: new Map(),
    handler: null,
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, cb) { return cb(ctx) },
    provide(name, value) { host.provided.set(name, value); return () => host.provided.delete(name) },
    get(name) {
      if (name !== 'dshIm') return undefined
      return {
        async send(botId, targetId, text, options) {
          host.sends.push({ botId, targetId, text, options })
          return imSend ? imSend(host.sends.length, options) : { sent: true }
        },
        listBots: async () => [],
        listTargets: async () => [],
      }
    },
    tools: { register(def) { host.tools.set(def.name, def); return () => host.tools.delete(def.name) } },
    schedule: {
      async create(sessionId, request) {
        if (scheduleCreate) await scheduleCreate(sessionId, request)
        const id = `sch-${host.schedules.length + 1}`
        host.schedules.push({ id, sessionId, request })
        return { id }
      },
      async delete() {},
      async catalog() { return [] },
    },
    webServer: { register(route) { host.handler = route.handler; return () => { host.handler = null } } },
  }
  host.ctx = ctx
  return host
}

function req(method, url, body, headers = {}, remoteAddress = '127.0.0.1') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url, headers, socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
async function call(host, method, url, body, { headers = { 'x-auto-tasks-client': 'cli' }, remote } = {}) {
  const r = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = String(b) } }
  await host.handler(req(method, url, body, headers, remote), r)
  return { status: r.statusCode, json: JSON.parse(r.body) }
}

async function createTask(host, extra = {}) {
  const r = await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 'sess-1', name: 'care-task', instruction: '未提出の記録を確認する', enabled: true,
    delivery: { channels: [{ botId: 'bot1', targetId: 'tgt1' }] },
    feedback: { deliverOn: ['done', 'failed', 'needsDecision'], respectQuietHours: false },
    guard: { maxRunsPerDay: 0 },
    ...extra,
  })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  return r.json.task
}

test('care: apply() provides ctx.autoTasks with list/trigger/emit', () => {
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const svc = host.provided.get('autoTasks')
  assert.ok(svc, 'autoTasks provided')
  assert.equal(svc.contractVersion, 1)
  for (const m of ['list', 'trigger', 'emit']) assert.equal(typeof svc[m], 'function')
})

test('care: event task is created without a core schedule; invalid eventTypes rejected', async () => {
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const task = await createTask(host, { trigger: { type: 'event', eventTypes: ['approval.requested', ' record.* '] } })
  assert.deepEqual(task.trigger, { type: 'event', eventTypes: ['approval.requested', 'record.*'] })
  assert.equal(task.scheduleId, null)
  assert.equal(host.schedules.length, 0)
  const bad = await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 's', name: 'x', instruction: 'y', trigger: { type: 'event', eventTypes: [] },
  })
  assert.equal(bad.status, 400)
  const bad2 = await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 's', name: 'x', instruction: 'y', trigger: { type: 'event', eventTypes: ['bad type!'] },
  })
  assert.equal(bad2.status, 400)
  // list() filters by eventType (exact + wildcard)
  const svc = host.provided.get('autoTasks')
  assert.ok((await svc.list({ eventType: 'approval.requested' })).some((t) => t.id === task.id))
  assert.ok((await svc.list({ eventType: 'record.overdue' })).some((t) => t.id === task.id))
  assert.ok(!(await svc.list({ eventType: 'import.failed' })).some((t) => t.id === task.id))
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('care: emit wakes matching enabled event tasks once per dedupeKey (persisted)', async () => {
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const svc = host.provided.get('autoTasks')
  const a = await createTask(host, { name: 'A', trigger: { type: 'event', eventTypes: ['approval.*'] } })
  const b = await createTask(host, { name: 'B', trigger: { type: 'event', eventTypes: ['import.failed'] } })
  const c = await createTask(host, { name: 'C(disabled)', enabled: false, trigger: { type: 'event', eventTypes: ['approval.requested'] } })

  const first = await svc.emit('approval.requested', { approvalId: 'A12', amount: 1000 }, 'evt-1')
  assert.deepEqual(first.triggered, [a.id])
  assert.deepEqual(first.deduped, [])
  assert.deepEqual(first.skipped, [{ taskId: c.id, reason: 'disabled' }])
  assert.equal(host.schedules.length, 1)
  const wake = host.schedules[0]
  assert.equal(wake.sessionId, 'sess-1')
  assert.equal(wake.request.after_seconds, 1)
  assert.match(wake.request.prompt, /事件 approval\.requested/)
  assert.match(wake.request.prompt, new RegExp(`runId: "${first.runs[0].runId}"`))
  assert.match(wake.request.prompt, /"approvalId": "A12"/)

  const again = await svc.emit('approval.requested', { approvalId: 'A12' }, 'evt-1')
  assert.deepEqual(again.triggered, [])
  assert.deepEqual(again.deduped, [a.id])
  assert.equal(again.runs[0].runId, first.runs[0].runId)
  assert.equal(host.schedules.length, 1, 'no second wake for the same dedupeKey')

  // A fresh service instance (≈ host restart) still sees the persisted key.
  const fresh = plugin.createAutoTasksService(host.ctx)
  const replay = await fresh.emit('approval.requested', {}, 'evt-1')
  assert.deepEqual(replay.deduped, [a.id])
  assert.equal(host.schedules.length, 1)
  const ledger = JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'runs.json'), 'utf8'))
  assert.ok(ledger.some((r) => r.dedupeKey === 'evt-1' && r.taskId === a.id && r.scheduleId === 'sch-1'))

  // No dedupeKey → every emit wakes.
  await svc.emit('import.failed', { file: 'x.csv' })
  await svc.emit('import.failed', { file: 'x.csv' })
  assert.equal(host.schedules.filter((s) => s.request.title.includes('import.failed')).length, 2)
  await assert.rejects(() => svc.emit('approval.*', {}), (e) => e.code === 'invalid_event_type')
  for (const t of [a, b, c]) await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: t.id })
})

test('care: trigger validates, dedupes (incl. concurrent calls) and rolls back failed schedules', async () => {
  let failNext = false
  const host = makeHost({ scheduleCreate: async () => { if (failNext) { failNext = false; throw new Error('boom') } } })
  plugin.apply(host.ctx, {})
  const svc = host.provided.get('autoTasks')
  const task = await createTask(host, { trigger: { type: 'event', eventTypes: ['x.y'] } })

  await assert.rejects(() => svc.trigger('at_missing', { reason: 'r' }), (e) => e.code === 'not_found')
  await assert.rejects(() => svc.trigger(task.id, { reason: '' }), (e) => e.code === 'invalid_reason')

  const [r1, r2] = await Promise.all([
    svc.trigger(task.id, { reason: 'approval A1', dedupeKey: 'approval:A1' }),
    svc.trigger(task.id, { reason: 'approval A1', dedupeKey: 'approval:A1' }),
  ])
  assert.equal(r1.runId, r2.runId)
  assert.deepEqual([r1.deduped, r2.deduped].sort(), [false, true])
  assert.equal(host.schedules.length, 1)
  assert.match(host.schedules[0].request.prompt, /手动\/程序触发（reason: approval A1）/)

  failNext = true
  await assert.rejects(() => svc.trigger(task.id, { reason: 'r', dedupeKey: 'k-fail' }), /boom/)
  const retry = await svc.trigger(task.id, { reason: 'r', dedupeKey: 'k-fail' })
  assert.equal(retry.deduped, false, 'failed schedule must not leave a dedupe record')

  await call(host, 'POST', '/auto-tasks/api/tasks/toggle', { id: task.id, enabled: false })
  await assert.rejects(() => svc.trigger(task.id, { reason: 'r' }), (e) => e.code === 'task_disabled')
  // a replay of an already-run key still answers deduped even after disabling
  assert.equal((await svc.trigger(task.id, { reason: 'r', dedupeKey: 'approval:A1' })).deduped, true)
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('care: report delivery carries one idempotencyKey across retries; a run is delivered once', async () => {
  const host = makeHost({ imSend: (n) => (n === 1 ? { sent: false } : { sent: true }) })
  plugin.apply(host.ctx, {})
  const svc = host.provided.get('autoTasks')
  const task = await createTask(host, { trigger: { type: 'event', eventTypes: ['approval.requested'] } })
  const { runId } = await svc.trigger(task.id, { reason: 'approval A9', dedupeKey: 'approval:A9:u1' })

  const report = host.tools.get('auto_task_report')
  assert.ok(report.parameters.properties.runId, 'report tool accepts runId')
  const out = await report.execute({ taskId: task.id, runId, status: 'done', summary: '承認待ち 1 件を通知しました' })
  assert.equal(out.ok, true)
  assert.equal(out.delivered, 1)
  assert.equal(host.sends.length, 2, 'first attempt failed, second succeeded')
  const keys = host.sends.map((s) => s.options.idempotencyKey)
  assert.equal(keys[0], keys[1])
  assert.equal(keys[0], `auto-tasks:${task.id}:k:approval:A9:u1:bot1:tgt1`)
  assert.equal(host.sends[0].options.format, 'markdown')

  const dup = await report.execute({ taskId: task.id, runId, status: 'done', summary: 'again' })
  assert.equal(dup.delivered, 0)
  assert.match(dup.text, /不重复推送/)
  assert.equal(host.sends.length, 2, 'duplicate report for the same run is not pushed')

  const reports = (await call(host, 'GET', '/auto-tasks/api/reports')).json.reports
  assert.equal(reports[0].deferred, 'duplicateRun')
  assert.equal(reports[0].runId, runId)
  const runs = (await call(host, 'GET', '/auto-tasks/api/runs')).json.runs
  const run = runs.find((r) => r.runId === runId)
  assert.ok(run.deliveredReportId)
  assert.equal(run.reportIds.length, 2)
  assert.equal(run.payloadText, undefined, 'payload is not exposed by /api/runs')
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('care: dsh-im answering deduped:true counts as delivered (no retry)', async () => {
  const host = makeHost({ imSend: () => ({ sent: false, deduped: true }) })
  plugin.apply(host.ctx, {})
  const task = await createTask(host)
  const out = await host.tools.get('auto_task_report').execute({ taskId: task.id, status: 'done', summary: 'ok' })
  assert.equal(out.delivered, 1)
  assert.equal(host.sends.length, 1)
  assert.match(host.sends[0].options.idempotencyKey, new RegExp(`^auto-tasks:${task.id}:p:rp_`))
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('care: HTTP /api/tasks/trigger and /api/events/emit mirror the service', async () => {
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const task = await createTask(host, { trigger: { type: 'event', eventTypes: ['deadline.near'] } })
  const t1 = await call(host, 'POST', '/auto-tasks/api/tasks/trigger', { id: task.id, reason: 'manual', dedupeKey: 'd1' })
  assert.equal(t1.status, 200)
  assert.equal(t1.json.deduped, false)
  const t2 = await call(host, 'POST', '/auto-tasks/api/tasks/trigger', { id: task.id, reason: 'manual', dedupeKey: 'd1' })
  assert.equal(t2.json.deduped, true)
  const missing = await call(host, 'POST', '/auto-tasks/api/tasks/trigger', { id: 'nope', reason: 'x' })
  assert.equal(missing.status, 404)
  const e1 = await call(host, 'POST', '/auto-tasks/api/events/emit', { eventType: 'deadline.near', payload: { n: 1 }, dedupeKey: 'e1' })
  assert.deepEqual(e1.json.triggered, [task.id])
  const noHeader = await call(host, 'POST', '/auto-tasks/api/events/emit', { eventType: 'deadline.near' }, { headers: {} })
  assert.equal(noHeader.status, 403)
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('care: loopback fence stays on by default; api.allowNonLoopback opts out', async () => {
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const r = await call(host, 'GET', '/auto-tasks/api/health', undefined, { remote: '10.0.0.5' })
  assert.equal(r.status, 403)
  const open = makeHost()
  plugin.apply(open.ctx, { api: { allowNonLoopback: true } })
  const ok = await call(open, 'GET', '/auto-tasks/api/health', undefined, { remote: '10.0.0.5' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.version, '0.2.0')
  assert.equal(ok.json.careVersion, '0.2.0-care.1')
  assert.equal(normalizeConfig({}).config.api.allowNonLoopback, false)
})

test('care: proactive backend prefers the in-process ctx.dshProactive service', async () => {
  const calls = []
  const alarm = { id: 'alarm-x', sessionId: 's1', prompt: 'p', createdAt: '2026-10-25T00:00:00.000Z' }
  const svc = {
    async state() { return { alarms: [alarm] } },
    async action(action, sessionId) { calls.push({ action, sessionId }); return { ok: true, snapshot: { alarms: [alarm] } } },
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('fetch must not be used') }
  try {
    const backend = proactiveBackend({ get: (n) => (n === 'dshProactive' ? svc : undefined) })
    assert.equal(await backend.available(), true)
    assert.equal((await backend.createAlarm('s1', { prompt: 'p', after_seconds: 60 })).id, 'alarm-x')
    assert.equal(await backend.cancelAlarm('s1', 'alarm-x'), true)
    assert.deepEqual(calls.map((c) => c.action.kind), ['create', 'cancel'])
    assert.equal((await backend.state()).alarms.length, 1)
    const failing = proactiveBackend({ get: () => ({ state: svc.state, action: async () => ({ ok: false, error: { code: 'invalid_trigger', message: 'bad' } }) }) })
    await assert.rejects(() => failing.createAlarm('s1', { prompt: 'p' }), /bad/)
  } finally {
    globalThis.fetch = oldFetch
  }
})

test('care: client bundle uses relative URLs and the scoped ModuleLoader id', () => {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(code.includes('"@care/dsh-auto-tasks"') || code.includes("'@care/dsh-auto-tasks'"))
  assert.ok(!/["'`]\/auto-tasks\/api/.test(code), 'no absolute /auto-tasks/api URL')
  assert.ok(code.includes('auto-tasks/api'))
  assert.ok(code.includes('document.baseURI'))
})

test('care: runs helpers — event matching, dedupe key validation, TTL pruning', () => {
  assert.equal(runsLib.matchesEventType('*', 'a.b'), true)
  assert.equal(runsLib.matchesEventType('a.*', 'a.b.c'), true)
  assert.equal(runsLib.matchesEventType('a.*', 'ab.c'), false)
  assert.equal(runsLib.matchesEventType('a.b', 'a.b'), true)
  assert.equal(runsLib.normalizeEventTypes(['a', 'a', 'b.*']).join(), 'a,b.*')
  assert.equal(runsLib.normalizeEventTypes('a'), null)
  assert.equal(runsLib.normalizeDedupeKey('  '), undefined)
  assert.throws(() => runsLib.normalizeDedupeKey('x'.repeat(201)), (e) => e.code === 'invalid_dedupe_key')
  const now = Date.parse('2026-10-25T00:00:00.000Z')
  const old = { runId: 'r1', taskId: 't', at: '2026-09-01T00:00:00.000Z', source: 'trigger', reason: 'x', dedupeKey: 'k' }
  const fresh = { ...old, runId: 'r2', at: '2026-10-24T00:00:00.000Z' }
  assert.deepEqual(runsLib.pruneRuns([old, fresh], now).map((r) => r.runId), ['r2'])
  assert.equal(runsLib.findDedupedRun([old], 't', 'k', now), undefined)
  assert.equal(runsLib.findDedupedRun([fresh], 't', 'k', now).runId, 'r2')
  assert.match(runsLib.renderPayload({ s: 'x'.repeat(5000) }), /truncated/)
})
