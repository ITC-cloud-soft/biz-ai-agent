/**
 * @care fork #15：ctx.autoTasks.activeRun(sessionId) — the triggered run whose wake message the current turn of a session claimed
 * (tracked from the host's 'session/event': turn/start → the schedule's user/message → turn/end). The business tools' delegation
 * gate uses it to know which run (and which business event) a tool call belongs to (per-event delegation `<class>=each`).
 * Also: deployPlaybooks copies the playbook's delegation class into source.delegation; emit without a scope takes the event id
 * from the payload.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// shares the process with the other test files (--test-isolation=none): point DSH_HOME at our own directory in each test
const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-active-run-'))
const plugin = await import('../lib/index.js')

function eventTask(id, extra = {}) {
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
    source: { kind: 'template', delegation: 'sales_rep=each', tools: ['shop_list_orders'] },
    ...extra,
  }
}

function writeTasks(tasks) {
  mkdirSync(join(HOME, 'auto-tasks'), { recursive: true })
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf8')
  writeFileSync(join(HOME, 'auto-tasks', 'runs.json'), '[]', 'utf8')
}
const tasksOnDisk = () => JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'tasks.json'), 'utf8'))

/** A fake host with ctx.on('session/event', …, { global: true }); host.fire(sessionId, event) plays one session event. */
function makeHost({ on = true } = {}) {
  process.env.DSH_HOME = HOME
  const host = { provided: new Map(), schedules: [], listeners: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    inject() { return undefined },
    provide(name, value) { host.provided.set(name, value); return () => host.provided.delete(name) },
    get() { return undefined },
    tools: { register() { return () => {} } },
    schedule: {
      async create(sessionId, request) { const id = `sch-${Math.random().toString(36).slice(2, 10)}`; host.schedules.push({ id, sessionId, request }); return { id } },
      async delete() {},
      async catalog() { return [] },
    },
    ...(on ? {
      on(name, listener, options) {
        host.listeners.push({ name, listener, options })
        return () => { host.listeners = host.listeners.filter((l) => l.listener !== listener) }
      },
    } : {}),
  }
  plugin.resetActiveRunsForTest()
  plugin.apply(ctx, {})
  host.svc = host.provided.get('autoTasks')
  host.fire = (sessionId, event) => { for (const l of host.listeners.filter((x) => x.name === 'session/event')) l.listener({ id: sessionId }, event) }
  return host
}

/** The wake message the core schedule puts into the session (dsh-schedule renderReminderFraming). */
function wakeMessage(schedule, { scheduleId = schedule.id } = {}) {
  const text = ['[SCHEDULE REMINDER]', 'This message was scheduled earlier.', `schedule_id_json: ${JSON.stringify(scheduleId)}`,
    'occurrence_at: 2026-10-20T07:00:01.000Z', `reminder_prompt_json: ${JSON.stringify(schedule.request.prompt)}`].join('\n')
  return { type: 'user/message', data: { id: `m-${scheduleId}`, content: [{ type: 'text', text }], source: { kind: 'schedule' } } }
}

test('activeRun: the run whose wake message the turn claimed, from the claim until the turn ends (event id, application, delegation class)', async () => {
  writeTasks([eventTask('at_mon')])
  const host = makeHost()
  assert.equal(host.listeners.length, 1)
  assert.deepEqual(host.listeners[0].options, { global: true })
  const a = await host.svc.emit('order.review_requested', { id: 41, type: 'order.review_requested', payload: { userId: 'u-1' } }, 'shop-orders:41', { applicationId: 'shop-orders', eventId: '41' })
  const b = await host.svc.emit('order.review_requested', { id: 42, type: 'order.review_requested', payload: { userId: 'u-2' } }, 'shop-orders:42', { applicationId: 'shop-orders', eventId: '42' })
  assert.equal(host.schedules.length, 2)
  assert.equal(host.svc.activeRun('sess-a'), undefined, 'nothing runs before a turn claims a wake message')

  // turn 1 claims the first wake message
  host.fire('sess-a', { type: 'turn/start', data: { turn: 1 } })
  host.fire('sess-a', wakeMessage(host.schedules[0]))
  const first = host.svc.activeRun('sess-a')
  assert.deepEqual({ ...first, startedAt: undefined }, {
    runId: a.runs[0].runId, taskId: 'at_mon', sessionId: 'sess-a', startedAt: undefined,
    eventType: 'order.review_requested', eventId: '41', applicationId: 'shop-orders', delegation: 'sales_rep=each',
  })
  assert.ok(Date.parse(first.startedAt) > 0)
  // tool calls of the same turn see the same run; other sessions see nothing
  host.fire('sess-a', { type: 'tool/call', data: { turn: 1, name: 'shop_list_orders' } })
  assert.equal(host.svc.activeRun('sess-a').eventId, '41')
  assert.equal(host.svc.activeRun('sess-b'), undefined)
  // the turn ends: no active run
  host.fire('sess-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(host.svc.activeRun('sess-a'), undefined)

  // turn 2 claims the second wake message: the other event
  host.fire('sess-a', { type: 'turn/start', data: { turn: 2 } })
  host.fire('sess-a', wakeMessage(host.schedules[1]))
  assert.deepEqual([host.svc.activeRun('sess-a').runId, host.svc.activeRun('sess-a').eventId], [b.runs[0].runId, '42'])
  // a returned copy cannot change the tracked run
  host.svc.activeRun('sess-a').eventId = '999'
  assert.equal(host.svc.activeRun('sess-a').eventId, '42')
  // a new turn without a wake message ends the previous run
  host.fire('sess-a', { type: 'turn/start', data: { turn: 3 } })
  assert.equal(host.svc.activeRun('sess-a'), undefined)
})

test('activeRun: only a schedule wake message of a run of a task bound to that session counts; a message from someone else ends it', async () => {
  writeTasks([eventTask('at_mon'), eventTask('at_other', { sessionId: 'sess-other', trigger: { type: 'event', eventTypes: ['other.event'] } })])
  const host = makeHost()
  await host.svc.emit('order.review_requested', { id: 7 }, 'k7', { applicationId: 'shop-orders', eventId: '7' })
  await host.svc.emit('other.event', { id: 8 }, 'k8', { applicationId: 'shop-orders', eventId: '8' })
  const [mine, other] = host.schedules
  // the wake message of another session's run played in sess-a: ignored
  host.fire('sess-a', { type: 'turn/start', data: { turn: 1 } })
  host.fire('sess-a', wakeMessage(other))
  assert.equal(host.svc.activeRun('sess-a'), undefined)
  // a schedule message that names no known run (e.g. a reminder the model set itself): nothing
  host.fire('sess-a', { type: 'turn/start', data: { turn: 2 } })
  host.fire('sess-a', wakeMessage({ id: 'sch-unknown', request: { prompt: 'remind me' } }))
  assert.equal(host.svc.activeRun('sess-a'), undefined)
  // the run of this session
  host.fire('sess-a', { type: 'turn/start', data: { turn: 3 } })
  host.fire('sess-a', wakeMessage(mine))
  assert.equal(host.svc.activeRun('sess-a').eventId, '7')
  // runtime context injected by the host does not end it; a message typed by someone does
  host.fire('sess-a', { type: 'user/message', data: { content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } } })
  assert.equal(host.svc.activeRun('sess-a').eventId, '7')
  host.fire('sess-a', { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'web', rpcId: 'r1' } } })
  assert.equal(host.svc.activeRun('sess-a'), undefined)
  // the runId line of the reminder prompt identifies the run when the schedule id is not in the ledger (yet)
  host.fire('sess-a', { type: 'turn/start', data: { turn: 4 } })
  host.fire('sess-a', wakeMessage(mine, { scheduleId: 'sch-not-recorded' }))
  assert.equal(host.svc.activeRun('sess-a').eventId, '7')
  // a garbled message: nothing (and the previous one ends)
  host.fire('sess-a', { type: 'user/message', data: { content: 'schedule_id_json: {oops', source: { kind: 'schedule' } } })
  assert.equal(host.svc.activeRun('sess-a'), undefined)
})

test('activeRun: emit without a scope takes the event id from the payload; a host without ctx.on tracks nothing', async () => {
  writeTasks([eventTask('at_mon', { applicationId: undefined })])
  const host = makeHost()
  await host.svc.emit('order.review_requested', { id: 55, type: 'order.review_requested' }, 'k55')
  host.fire('sess-a', { type: 'turn/start', data: { turn: 1 } })
  host.fire('sess-a', wakeMessage(host.schedules[0]))
  const run = host.svc.activeRun('sess-a')
  assert.equal(run.eventId, '55')
  assert.equal(run.applicationId, undefined)
  // a payload id that is not an integer or a short token is not an event id
  await host.svc.emit('order.review_requested', { id: 'has spaces' }, 'k56')
  host.fire('sess-a', { type: 'turn/start', data: { turn: 2 } })
  host.fire('sess-a', wakeMessage(host.schedules[1]))
  assert.equal(host.svc.activeRun('sess-a').eventId, undefined)

  writeTasks([eventTask('at_mon')])
  const bare = makeHost({ on: false })
  assert.equal(typeof bare.svc.activeRun, 'function')
  await bare.svc.emit('order.review_requested', { id: 60 }, 'k60', { applicationId: 'shop-orders', eventId: '60' })
  assert.equal(bare.svc.activeRun('sess-a'), undefined)
})

test('deployPlaybooks: the playbook delegation class goes into source.delegation (only a valid <class> / <class>=each)', async () => {
  writeTasks([])
  const host = makeHost()
  const base = { trigger: { events: ['order.review_requested'] }, instructions: '注文の確認の返信を提案する。', tools: ['shop_list_orders'], audience: { rule: 'order_owner' } }
  const r = await host.svc.deployPlaybooks('shop-orders', {
    per_rep: { ...base, delegation: 'sales_rep=each' },
    sales: { ...base, delegation: 'sales' },
    none: { ...base },
    bad: { ...base, delegation: 'Sales Rep' },
  })
  assert.deepEqual(r.created.sort(), ['pb_shop-orders_bad', 'pb_shop-orders_none', 'pb_shop-orders_per_rep', 'pb_shop-orders_sales'])
  const byId = Object.fromEntries(tasksOnDisk().map((t) => [t.id, t]))
  assert.equal(byId['pb_shop-orders_per_rep'].source.delegation, 'sales_rep=each')
  assert.equal(byId['pb_shop-orders_sales'].source.delegation, 'sales')
  assert.equal('delegation' in byId['pb_shop-orders_none'].source, false)
  assert.equal('delegation' in byId['pb_shop-orders_bad'].source, false)
  // changing the class updates the task (template-owned)
  const again = await host.svc.deployPlaybooks('shop-orders', { per_rep: { ...base, delegation: 'sales' }, sales: { ...base, delegation: 'sales' }, none: base, bad: { ...base, delegation: 'Sales Rep' } })
  assert.deepEqual(again.updated, ['pb_shop-orders_per_rep'])
})
