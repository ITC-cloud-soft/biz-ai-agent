/**
 * @care fork #17：DSH 0.2.2 的核心 ScheduleService（create({ title, prompt, timing, target }, actorSessionId) / edit / catalog 的 target）。
 * 插件内部仍按 0.2.1 的形状调用，scheduleApi() 只在宿主服务有 `edit` 时换成新形状；0.2.1 的宿主（以及其它测试里的假宿主）原样调用。
 * 另外：0.2.2 向相关会话注入的 [SCHEDULE CHANGE] 通知（source.kind 也是 'schedule'）不改变 activeRun。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// shares the process with the other test files (--test-isolation=none): point DSH_HOME at our own directory in each test
const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-schedule-022-'))
const plugin = await import('../lib/index.js')

function writeTasks(tasks) {
  mkdirSync(join(HOME, 'auto-tasks'), { recursive: true })
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf8')
  writeFileSync(join(HOME, 'auto-tasks', 'runs.json'), '[]', 'utf8')
}
const tasksOnDisk = () => JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'tasks.json'), 'utf8'))

function task(id, extra = {}) {
  return {
    id,
    name: `試験 ${id}`,
    instruction: '試験の指示',
    enabled: true,
    approval: 'auto',
    wakeBackend: 'schedule',
    triggerMode: 'schedule',
    proactiveAlarmId: null,
    scheduleId: null,
    trigger: { type: 'event', eventTypes: ['order.review_requested'] },
    sessionId: 'sess-a',
    workspacePath: null,
    delivery: { channels: [] },
    feedback: { deliverOn: ['failed', 'needsDecision'], respectQuietHours: false, quietHours: null },
    guard: { maxRunsPerDay: 50, maxConsecutiveFailures: 5, autoPause: true, requireEvidence: false },
    applicationId: 'shop-orders',
    source: { kind: 'template', tools: ['shop_list_orders'] },
    ...extra,
  }
}

/** A fake DSH 0.2.2 ScheduleService: create(request, actorSessionId) / edit / catalog with targets. */
function schedule022() {
  const calls = []
  const rows = new Map()
  let n = 0
  return {
    calls,
    rows,
    async create(request, actorSessionId) {
      calls.push({ op: 'create', request, actorSessionId })
      const id = `sch-${++n}`
      const row = { id, kind: request.timing.kind, title: request.title, prompt: request.prompt, target: request.target, status: 'active', involvedSessionIds: [request.target.sessionId] }
      rows.set(id, row)
      return row
    },
    async edit(request, actorSessionId) {
      calls.push({ op: 'edit', request, actorSessionId })
      if (request.action !== 'delete') throw new Error('unexpected edit')
      return rows.delete(request.id) ? { id: request.id, deleted: true } : { id: request.id, deleted: false, code: 'schedule_not_found' }
    },
    async catalog() { return [...rows.values()] },
    async run() { throw new Error('not used') },
    async view() { throw new Error('not used') },
  }
}

function makeHost(service) {
  process.env.DSH_HOME = HOME
  const host = { provided: new Map(), listeners: [], handler: null }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, cb) { return cb(ctx) },
    provide(name, value) { host.provided.set(name, value); return () => host.provided.delete(name) },
    get() { return undefined },
    tools: { register() { return () => {} } },
    schedule: service,
    on(name, listener, options) {
      host.listeners.push({ name, listener, options })
      return () => { host.listeners = host.listeners.filter((l) => l.listener !== listener) }
    },
    webServer: { register(route) { host.handler = route.handler; return () => { host.handler = null } } },
  }
  plugin.resetActiveRunsForTest()
  plugin.apply(ctx, {})
  host.svc = host.provided.get('autoTasks')
  host.fire = (sessionId, event) => { for (const l of host.listeners.filter((x) => x.name === 'session/event')) l.listener({ id: sessionId }, event) }
  return host
}

async function call(host, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = { method, url, headers: { 'x-auto-tasks-client': 'cli' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
  const res = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = String(b) } }
  await host.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

const message = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'schedule' } } })

test('scheduleTiming: exactly one 0.2.1 timing key becomes the 0.2.2 { kind, … } timing', () => {
  assert.deepEqual(plugin.scheduleTiming({ title: 't', prompt: 'p', after_seconds: 1 }), { kind: 'after', after_seconds: 1 })
  assert.deepEqual(plugin.scheduleTiming({ every_seconds: 3600 }), { kind: 'every', every_seconds: 3600 })
  assert.deepEqual(plugin.scheduleTiming({ daily: { time: '09:00:00', time_zone: 'Asia/Tokyo' } }), { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Tokyo' } })
  assert.deepEqual(plugin.scheduleTiming({ cron: { expression: '0 9 * * 1', time_zone: 'UTC' } }), { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } })
  assert.throws(() => plugin.scheduleTiming({ title: 't' }), /exactly one schedule timing/)
  assert.throws(() => plugin.scheduleTiming({ after_seconds: 1, every_seconds: 60 }), /exactly one schedule timing/)
})

test('scheduleApi: a 0.2.1 service (no edit) is used as is', () => {
  const old = { async create() {}, async delete() {}, async catalog() { return [] } }
  assert.equal(plugin.scheduleApi(old), old)
})

test('0.2.2: an event run creates a one-shot delivery to the task session, acting as that session (no [SCHEDULE CHANGE] notice there)', async () => {
  writeTasks([task('at_022')])
  const service = schedule022()
  const host = makeHost(service)
  const result = await host.svc.emit('order.review_requested', { id: 7 }, 'shop-orders:7', { applicationId: 'shop-orders', eventId: '7' })
  assert.equal(result.runs.length, 1)
  assert.equal(service.calls.length, 1)
  const [{ request, actorSessionId }] = service.calls
  assert.deepEqual(request.timing, { kind: 'after', after_seconds: 1 })
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'sess-a' })
  assert.equal(actorSessionId, 'sess-a')
  assert.match(request.title, /order\.review_requested/)
  assert.match(request.prompt, new RegExp(`runId: ${result.runs[0].runId}`))
  assert.equal(Object.hasOwn(request, 'after_seconds'), false, 'no 0.2.1 key leaks into the 0.2.2 request')

  // the delivery claims the turn; a [SCHEDULE CHANGE] notice for the same id does not end or move it
  const id = [...service.rows.keys()][0]
  host.fire('sess-a', { type: 'turn/start', data: { turn: 1 } })
  host.fire('sess-a', message(['[SCHEDULE REMINDER]', 'This message was scheduled earlier.', `schedule_id_json: ${JSON.stringify(id)}`,
    'occurrence_at: 2026-11-14T07:00:01.000Z', `reminder_prompt_json: ${JSON.stringify(request.prompt)}`].join('\n')))
  assert.equal(host.svc.activeRun('sess-a')?.runId, result.runs[0].runId)
  host.fire('sess-a', message(['[SCHEDULE CHANGE]', 'A scheduled task involving this session was changed outside this session.', 'change: deleted',
    `schedule_id_json: ${JSON.stringify(id)}`, 'schedule_title_json: "x"'].join('\n')))
  assert.equal(host.svc.activeRun('sess-a')?.runId, result.runs[0].runId)
})

test('0.2.2: a scheduled task is armed on its session, listed, and removed with edit(delete)', async () => {
  writeTasks([])
  const service = schedule022()
  const host = makeHost(service)
  const created = await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 'sess-b', name: 'daily check', instruction: '毎朝確認する', enabled: true,
    trigger: { type: 'daily', dailyTime: '09:00:00', timeZone: 'Asia/Tokyo' },
    delivery: { channels: [] }, feedback: { deliverOn: ['failed'], respectQuietHours: false },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const { request, actorSessionId } = service.calls.at(-1)
  assert.deepEqual(request.timing, { kind: 'daily', daily: { time: '09:00:00', time_zone: 'Asia/Tokyo' } })
  assert.deepEqual(request.target, { kind: 'session', sessionId: 'sess-b' })
  assert.equal(actorSessionId, 'sess-b')
  const scheduleId = created.json.task.scheduleId
  assert.ok(service.rows.has(scheduleId))

  const listed = await call(host, 'GET', '/auto-tasks/api/tasks?sessionId=sess-b')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.tasks.length, 1)

  const removed = await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: created.json.task.id })
  assert.equal(removed.status, 200, JSON.stringify(removed.json))
  const edit = service.calls.find((c) => c.op === 'edit')
  assert.deepEqual(edit, { op: 'edit', request: { id: scheduleId, action: 'delete' }, actorSessionId: 'sess-b' })
  assert.equal(service.rows.has(scheduleId), false)
  assert.equal(tasksOnDisk().length, 0)
})
