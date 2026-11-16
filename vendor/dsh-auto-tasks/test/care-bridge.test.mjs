/**
 * @care fork（Bridge 多应用，BRIDGE_STAGE2_PLAN B2-plugins）：deployPlaybooks（applicationId / audience）、
 * emit 的应用作用域、按收件人投递（setAudienceDelivery），以及没有 applicationId 的旧任务行为不变。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 他のテストファイルと同じプロセスで走る（--test-isolation=none）ので、DSH_HOME は各テストの最初に自分の一時ディレクトリへ向ける。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-bridge-'))

const plugin = await import('../lib/index.js')

function makeHost() {
  process.env.DSH_HOME = HOME
  const host = { provided: new Map(), schedules: [], sends: [], tools: new Map(), handler: null }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    inject(_deps, cb) { return cb(ctx) },
    provide(name, value) { host.provided.set(name, value); return () => host.provided.delete(name) },
    get(name) {
      if (name !== 'dshIm') return undefined
      return {
        async send(botId, targetId, text, options) { host.sends.push({ botId, targetId, text, options }); return { sent: true } },
        listBots: async () => [],
        listTargets: async () => [],
      }
    },
    tools: { register(def) { host.tools.set(def.name, def); return () => host.tools.delete(def.name) } },
    schedule: {
      async create(sessionId, request) { const id = `sch-${host.schedules.length + 1}`; host.schedules.push({ id, sessionId, request }); return { id } },
      async delete() {},
      async catalog() { return [] },
    },
    webServer: { register(route) { host.handler = route.handler; return () => { host.handler = null } } },
  }
  host.ctx = ctx
  plugin.apply(ctx, {})
  host.svc = host.provided.get('autoTasks')
  return host
}

async function call(host, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method, url, headers: { 'x-auto-tasks-client': 'cli' }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  const r = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = String(b) } }
  await host.handler(request, r)
  return { status: r.statusCode, json: JSON.parse(r.body) }
}

const tasksOnDisk = () => JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'tasks.json'), 'utf8'))

const PLAYBOOKS = {
  overdue_followup: {
    label: '期限切れ点検のフォロー',
    agent: 'facility-inspection',
    trigger: { events: ['inspection.overdue'] },
    instructions: '期限切れの点検を確認し、対応が必要なら担当者に知らせる。',
    tools: ['bridge_demo_list_overdue'],
    audience: { rule: 'inspectors' },
    delivery: 'only_if_actionable',
    approval: 'none',
    guard: { maxRunsPerDay: 10 },
    enabled: false,
  },
  morning_patrol: { label: '朝の巡回', trigger: { cron: '0 9 * * *' }, instructions: '巡回する', audience: { rule: 'managers' } },
}

test('bridge: deployPlaybooks creates disabled event tasks with applicationId / audience, merges idempotently, skips cron playbooks', async () => {
  const host = makeHost()
  const first = await host.svc.deployPlaybooks('bridge-demo', PLAYBOOKS, { version: '2026-10-26', applicationName: 'デモ' })
  assert.deepEqual(first.created, ['pb_bridge-demo_overdue_followup'])
  assert.deepEqual(first.skipped, [{ playbook: 'morning_patrol', reason: 'cron playbooks run on dsh-proactive' }])
  const task = tasksOnDisk().find((t) => t.id === 'pb_bridge-demo_overdue_followup')
  assert.equal(task.enabled, false)
  assert.equal(task.applicationId, 'bridge-demo')
  assert.deepEqual(task.audience, { rule: 'inspectors' })
  assert.deepEqual(task.trigger, { type: 'event', eventTypes: ['inspection.overdue'] })
  assert.equal(task.name, '【デモ】期限切れ点検のフォロー')
  assert.equal(task.approval, 'auto')
  assert.deepEqual(task.feedback.deliverOn, ['failed', 'needsDecision'], 'only_if_actionable')
  assert.equal(task.guard.maxRunsPerDay, 10)
  assert.equal(task.source.kind, 'bridge-playbook')

  // the operator binds a session and enables it; a redeploy keeps operator-owned fields
  const upd = await call(host, 'POST', '/auto-tasks/api/tasks/update', { id: task.id, enabled: true, delivery: { channels: [{ botId: 'b0', targetId: 't0' }] } })
  assert.equal(upd.status, 200)
  const t2 = tasksOnDisk().find((t) => t.id === task.id)
  t2.sessionId = 'sess-demo'
  const all = tasksOnDisk().map((t) => (t.id === task.id ? { ...t2 } : t))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(all), 'utf8')
  assert.deepEqual((await host.svc.deployPlaybooks('bridge-demo', PLAYBOOKS, { version: '2026-10-26', applicationName: 'デモ' })).unchanged, [task.id])
  const changed = { ...PLAYBOOKS, overdue_followup: { ...PLAYBOOKS.overdue_followup, instructions: '新しい指示' } }
  assert.deepEqual((await host.svc.deployPlaybooks('bridge-demo', changed, { version: '2026-10-27', applicationName: 'デモ' })).updated, [task.id])
  const t3 = tasksOnDisk().find((t) => t.id === task.id)
  assert.equal(t3.instruction, '新しい指示')
  assert.equal(t3.enabled, true)
  assert.equal(t3.sessionId, 'sess-demo')
  assert.deepEqual(t3.delivery.channels, [{ botId: 'b0', targetId: 't0' }])
  assert.deepEqual((await host.svc.list({ applicationId: 'bridge-demo' })).map((t) => t.id), [task.id])

  // a playbook removed from the manifest: its enabled task is disabled (never deleted)
  const gone = await host.svc.deployPlaybooks('bridge-demo', { morning_patrol: PLAYBOOKS.morning_patrol })
  assert.deepEqual(gone.disabled, [task.id])
  assert.equal(tasksOnDisk().find((t) => t.id === task.id).enabled, false)
  await assert.rejects(() => host.svc.deployPlaybooks('Bad App', {}), (e) => e.code === 'invalid_application')
  await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: task.id })
})

test('bridge: emit scope wakes only the tasks of the event\'s application; unscoped tasks only for the default application', async () => {
  const host = makeHost()
  const mk = async (name, extra = {}) => (await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 'sess-1', name, instruction: 'x', enabled: true, trigger: { type: 'event', eventTypes: ['approval.requested'] },
    feedback: { respectQuietHours: false }, guard: { maxRunsPerDay: 0 }, ...extra,
  })).json.task
  const legacy = await mk('legacy')
  // tasks of applications (as deployed from playbooks)
  await host.svc.deployPlaybooks('care-billing', { a: { trigger: { events: ['approval.requested'] }, instructions: 'care' } })
  await host.svc.deployPlaybooks('bridge-demo', { a: { trigger: { events: ['approval.requested'] }, instructions: 'demo' } })
  const all = tasksOnDisk().map((t) => (t.applicationId ? { ...t, enabled: true, sessionId: `sess-${t.applicationId}` } : t))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(all), 'utf8')

  // old callers (no scope): every listening task, as before
  const plain = await host.svc.emit('approval.requested', {}, 'k-0')
  assert.deepEqual(plain.triggered.sort(), [legacy.id, 'pb_bridge-demo_a', 'pb_care-billing_a'].sort())
  // the default application's event: its own tasks + the unscoped (template) ones
  const care = await host.svc.emit('approval.requested', {}, '7', { applicationId: 'care-billing', eventId: '7', matchUnscoped: true })
  assert.deepEqual(care.triggered.sort(), [legacy.id, 'pb_care-billing_a'].sort())
  // another application's event: only its tasks
  const demo = await host.svc.emit('approval.requested', {}, 'bridge-demo:7', { applicationId: 'bridge-demo', eventId: '7', matchUnscoped: false })
  assert.deepEqual(demo.triggered, ['pb_bridge-demo_a'])
  const runs = JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'runs.json'), 'utf8'))
  const run = runs.find((r) => r.runId === demo.runs[0].runId)
  assert.equal(run.applicationId, 'bridge-demo')
  assert.equal(run.eventId, '7')
  for (const t of tasksOnDisk()) await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: t.id })
})

test('bridge: reports of an application task with an audience go to the audience delivery; static channels otherwise / as fallback', async () => {
  const host = makeHost()
  await host.svc.deployPlaybooks('bridge-demo', { f: { label: 'F', trigger: { events: ['inspection.overdue'] }, instructions: 'x', audience: { rule: 'inspectors' } } })
  const all = tasksOnDisk().map((t) => (t.id === 'pb_bridge-demo_f'
    ? { ...t, enabled: true, sessionId: 'sess-demo', delivery: { channels: [{ botId: 'b-static', targetId: 't-static' }] }, feedback: { ...t.feedback, respectQuietHours: false } }
    : t))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(all), 'utf8')
  const calls = []
  let handled = true
  const off = host.svc.setAudienceDelivery(async (input) => {
    calls.push(input)
    return handled ? { handled: true, results: [{ channel: 'im', botId: 'W2', userId: 'u1', ok: true }] } : { handled: false, reason: 'no_recipients' }
  })
  const emitted = await host.svc.emit('inspection.overdue', { applicationId: 'bridge-demo' }, 'bridge-demo:41', { applicationId: 'bridge-demo', eventId: 41, matchUnscoped: false })
  const runId = emitted.runs[0].runId
  const report = host.tools.get('auto_task_report')
  const out = await report.execute({ taskId: 'pb_bridge-demo_f', runId, status: 'needsDecision', summary: '期限切れ 2 件' })
  assert.ok(out.ok !== false, JSON.stringify(out))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].task.applicationId, 'bridge-demo')
  assert.deepEqual(calls[0].task.audience, { rule: 'inspectors' })
  assert.equal(calls[0].run.eventId, '41')
  assert.equal(calls[0].run.eventType, 'inspection.overdue')
  assert.match(calls[0].text, /期限切れ 2 件/)
  assert.equal(calls[0].idempotencyKey, 'auto-tasks:pb_bridge-demo_f:k:bridge-demo:41:audience:')
  assert.equal(host.sends.length, 0, 'not sent to the static channel')

  // not handled (no recipients): the task's static channel is used, as before
  handled = false
  const e2 = await host.svc.emit('inspection.overdue', {}, 'bridge-demo:42', { applicationId: 'bridge-demo', eventId: 42, matchUnscoped: false })
  await report.execute({ taskId: 'pb_bridge-demo_f', runId: e2.runs[0].runId, status: 'needsDecision', summary: 'x' })
  assert.deepEqual(host.sends.map((s) => [s.botId, s.targetId]), [['b-static', 't-static']])
  off()
  // unregistered: static channels
  const e3 = await host.svc.emit('inspection.overdue', {}, 'bridge-demo:43', { applicationId: 'bridge-demo', eventId: 43, matchUnscoped: false })
  await report.execute({ taskId: 'pb_bridge-demo_f', runId: e3.runs[0].runId, status: 'needsDecision', summary: 'y' })
  assert.equal(calls.length, 2)
  assert.equal(host.sends.length, 2)
  for (const t of tasksOnDisk()) await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: t.id })
})
