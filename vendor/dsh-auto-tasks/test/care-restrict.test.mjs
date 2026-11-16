/**
 * @care fork #16（N1b）：restrictDelivery（报告只按业务应用解析的收件人投递，不回退到固定目标；只接受任务自己会话的汇报）、
 * mail: false（没有邮件工具 / 邮件 API）。默认（未配置）时行为不变（care-bridge.test.mjs）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-restrict-'))
const plugin = await import('../lib/index.js')
const schema = await import('../lib/config-schema.js')

function makeHost(config) {
  process.env.DSH_HOME = HOME
  const host = { provided: new Map(), schedules: [], sends: [], tools: new Map(), handler: null, logs: [] }
  const ctx = {
    logger: { info(m) { host.logs.push(m) }, warn(m) { host.logs.push(m) }, error() {} },
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
  plugin.apply(ctx, config)
  host.svc = host.provided.get('autoTasks')
  return host
}

async function call(host, method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method, url, headers: { 'x-auto-tasks-client': 'cli', ...headers }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
  const r = { statusCode: 0, body: '', setHeader() {}, end(b) { this.body = String(b) } }
  await host.handler(request, r)
  return { status: r.statusCode, json: JSON.parse(r.body) }
}

const tasksOnDisk = () => JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'tasks.json'), 'utf8'))
const execIn = (sessionId) => ({ agent: { session: { id: sessionId } } })

test('#16 config: restrictDelivery (default false) and mail (default true) are known keys', () => {
  assert.deepEqual(schema.normalizeConfig({}).config, { wakeBackendDefault: 'schedule', api: { requireClientHeader: true, allowNonLoopback: false }, restrictDelivery: false, mail: true })
  const out = schema.normalizeConfig({ restrictDelivery: true, mail: false })
  assert.deepEqual([out.config.restrictDelivery, out.config.mail, out.warnings], [true, false, []])
})

test('#16 restrictDelivery: no fixed-channel fallback (handled:false / unregistered / no audience) — nothing is sent, the reason is logged', async () => {
  const host = makeHost({ restrictDelivery: true, mail: false })
  await host.svc.deployPlaybooks('care-billing', { f: { label: 'F', trigger: { events: ['x.happened'] }, instructions: 'x', audience: { rule: 'managers' } } })
  const all = tasksOnDisk().map((t) => (t.id === 'pb_care-billing_f'
    ? { ...t, enabled: true, sessionId: 'sess-task', delivery: { channels: [{ botId: 'b-static', targetId: 't-static' }] }, feedback: { ...t.feedback, respectQuietHours: false } }
    : t))
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(all), 'utf8')
  const report = host.tools.get('auto_task_report')
  let handled = false
  const off = host.svc.setAudienceDelivery(async () => (handled ? { handled: true, results: [{ channel: 'im', userId: 'u1', ok: true }] } : { handled: false, reason: 'no_recipients' }))
  const e1 = await host.svc.emit('x.happened', {}, 'care-billing:1', { applicationId: 'care-billing', eventId: 1, matchUnscoped: false })
  const out = await report.execute({ taskId: 'pb_care-billing_f', runId: e1.runs[0].runId, status: 'needsDecision', summary: 's' }, execIn('sess-task'))
  assert.equal(out.ok, true)
  assert.match(out.text, /未投递/)
  assert.equal(host.sends.length, 0, 'never the fixed channel')
  assert.ok(host.logs.some((m) => /not delivered \(restrictDelivery/.test(String(m))))
  // handled by the business application: delivered there
  handled = true
  const e2 = await host.svc.emit('x.happened', {}, 'care-billing:2', { applicationId: 'care-billing', eventId: 2, matchUnscoped: false })
  const ok = await report.execute({ taskId: 'pb_care-billing_f', runId: e2.runs[0].runId, status: 'needsDecision', summary: 's' }, execIn('sess-task'))
  assert.equal(ok.delivered, 1)
  off()
  // unregistered audience delivery: still nothing
  const e3 = await host.svc.emit('x.happened', {}, 'care-billing:3', { applicationId: 'care-billing', eventId: 3, matchUnscoped: false })
  await report.execute({ taskId: 'pb_care-billing_f', runId: e3.runs[0].runId, status: 'failed', summary: 's' }, execIn('sess-task'))
  assert.equal(host.sends.length, 0)
  // a task without applicationId / audience (operator-made): never its channels
  const made = (await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 'sess-op', name: 'op', instruction: 'x', enabled: true, trigger: { type: 'event', eventTypes: ['y.happened'] },
    delivery: { channels: [{ botId: 'b2', targetId: 't2' }] }, feedback: { respectQuietHours: false }, guard: { maxRunsPerDay: 0 },
  })).json.task
  await report.execute({ taskId: made.id, status: 'done', summary: 'z' }, execIn('sess-op'))
  assert.equal(host.sends.length, 0)
  // the operator's test delivery to a fixed target is refused too
  assert.equal((await call(host, 'POST', '/auto-tasks/api/delivery/test', { botId: 'b', targetId: 't' })).status, 403)
  for (const t of tasksOnDisk()) await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: t.id })
})

test('#16 restrictDelivery: auto_task_report / auto_task_silent are accepted only from the task\'s own conversation', async () => {
  const host = makeHost({ restrictDelivery: true })
  const made = (await call(host, 'POST', '/auto-tasks/api/tasks', {
    sessionId: 'sess-own', name: 'own', instruction: 'x', enabled: true, trigger: { type: 'event', eventTypes: ['z.happened'] },
    feedback: { respectQuietHours: false }, guard: { maxRunsPerDay: 0 },
  })).json.task
  for (const name of ['auto_task_report', 'auto_task_silent']) {
    const args = name === 'auto_task_report' ? { taskId: made.id, status: 'done', summary: 's' } : { taskId: made.id, reason: 'r' }
    for (const exec of [execIn('sess-someone-else'), undefined]) {
      const out = await host.tools.get(name).execute(args, exec)
      assert.equal(out.ok, false, name)
      assert.match(out.text, /只能在它自己的会话里汇报/)
    }
    assert.equal((await host.tools.get(name).execute(args, execIn('sess-own'))).ok, true, name)
  }
  for (const t of tasksOnDisk()) await call(host, 'POST', '/auto-tasks/api/tasks/delete', { id: t.id })
})

test('#16 mail: false — no auto_task_mail tool, the mail API is closed; the default keeps both', async () => {
  const closed = makeHost({ mail: false })
  assert.equal(closed.tools.has('auto_task_mail'), false)
  assert.ok(closed.tools.has('auto_task_report'))
  assert.equal((await call(closed, 'POST', '/auto-tasks/api/mail/send', { to: 'a@example.test', subject: 's', text: 't' }, { 'x-auto-tasks-confirm': '1' })).status, 403)
  assert.equal((await call(closed, 'GET', '/auto-tasks/api/mail/status')).status, 403)
  const open = makeHost({})
  assert.equal(open.tools.has('auto_task_mail'), true)
  assert.equal((await call(open, 'GET', '/auto-tasks/api/mail/status')).status, 200)
})
