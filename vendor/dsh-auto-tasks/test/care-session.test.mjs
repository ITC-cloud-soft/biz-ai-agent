/**
 * @care fork #14：sessionPreset を持つ事件タスクは、会話が未結合でも最初の運行の前に専用の DSH 会話を開設して
 * tasks.json に書き戻す（宿主 Harness = connection 服務 + Typert gateway。care-assistant / dsh-im と同じ呼び方）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 他のテストファイルと同じプロセスで走る（--test-isolation=none）ので、DSH_HOME は各テストの最初に自分の一時ディレクトリへ向ける。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-session-'))
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
    trigger: { type: 'event', eventTypes: ['visit_record.returned'] },
    sessionId: '',
    workspacePath: null,
    delivery: { channels: [] },
    feedback: { deliverOn: ['failed', 'needsDecision'], respectQuietHours: false, quietHours: null },
    guard: { maxRunsPerDay: 10, maxConsecutiveFailures: 5, autoPause: true, requireEvidence: false },
    ...extra,
  }
}

function writeTasks(tasks) {
  mkdirSync(join(HOME, 'auto-tasks'), { recursive: true })
  writeFileSync(join(HOME, 'auto-tasks', 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf8')
}
const tasksOnDisk = () => JSON.parse(readFileSync(join(HOME, 'auto-tasks', 'tasks.json'), 'utf8'))

/** gateway: Typert gateway の偽物（invoke / stream）。failCreate で session.create を失敗させる。 */
function makeHost({ gateway = true, failCreate = false, delayMs = 0 } = {}) {
  process.env.DSH_HOME = HOME
  const host = { provided: new Map(), schedules: [], invokes: [], peers: 0 }
  const typertGateway = {
    async invoke(req) {
      host.invokes.push({ namespace: req.namespace, method: req.method, args: req.args, peer: Boolean(req.peer) })
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      if (req.namespace === 'workspace' && req.method === 'create') return { workspace: { workspaceId: 'ws-1', path: req.args.request.path } }
      if (req.namespace === 'session' && req.method === 'create') {
        if (failCreate) throw new Error('preset not found')
        return { sessionId: `sess-${host.invokes.filter((i) => i.method === 'create' && i.namespace === 'session').length}` }
      }
      return {}
    },
    async stream() {
      return (async function* () { yield { type: 'baseline', value: { items: [{ path: '/elsewhere', workspaceId: 'ws-0' }] } } })()
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    // 偽の宿主には connection だけがある（webServer は無い＝HTTP API は登録されない）
    inject(deps, cb) { return deps.every((d) => ['connection', 'typertGateway'].includes(d)) ? cb(ctx) : undefined },
    provide(name, value) { host.provided.set(name, value); return () => host.provided.delete(name) },
    get() { return undefined },
    connection: { createPeer: () => { host.peers += 1; return { dispose() {} } } },
    ...(gateway ? { typertGateway } : {}),
    tools: { register() { return () => {} } },
    schedule: {
      async create(sessionId, request) { const id = `sch-${host.schedules.length + 1}`; host.schedules.push({ id, sessionId, request }); return { id } },
      async delete() {},
      async catalog() { return [] },
    },
  }
  plugin.apply(ctx, {})
  host.svc = host.provided.get('autoTasks')
  return host
}

test('sessionPreset: the first event opens one dedicated session (preset, workspace, title) and binds it in tasks.json', async () => {
  writeTasks([eventTask('at_s1', { sessionPreset: 'care-record-review' })])
  const host = makeHost()
  // 同じタスクへの同時の事件 2 件 → 会話は 1 つだけ開設する
  const [a, b] = await Promise.all([
    host.svc.emit('visit_record.returned', { id: 1 }, 'ev-1'),
    host.svc.emit('visit_record.returned', { id: 2 }, 'ev-2'),
  ])
  assert.deepEqual(a.triggered, ['at_s1'])
  assert.deepEqual(b.triggered, ['at_s1'])
  const creates = host.invokes.filter((i) => i.namespace === 'session' && i.method === 'create')
  assert.equal(creates.length, 1, 'one session for the task')
  assert.equal(creates[0].args.request.agentPreset, 'care-record-review')
  assert.equal(creates[0].args.request.workspaceId, 'ws-1', 'workspace created for the cwd when the baseline has none')
  assert.ok(creates[0].peer, 'called as an owner peer')
  const rename = host.invokes.find((i) => i.namespace === 'session' && i.method === 'rename')
  assert.match(rename.args.request.title, /^自動タスク：試験 at_s1/)
  assert.deepEqual(host.schedules.map((s) => s.sessionId), ['sess-1', 'sess-1'])
  assert.equal(tasksOnDisk()[0].sessionId, 'sess-1')
  // 以後は結合済みの会話を使う（新しい会話は開かない）
  const c = await host.svc.emit('visit_record.returned', { id: 3 }, 'ev-3')
  assert.deepEqual(c.triggered, ['at_s1'])
  assert.equal(host.invokes.filter((i) => i.namespace === 'session' && i.method === 'create').length, 1)
  // care-tools が使う list({sessionId}) でこの会話が自動タスクの会話として見える
  assert.deepEqual((await host.svc.list({ sessionId: 'sess-1' })).map((t) => t.id), ['at_s1'])
})

test('sessionPreset: no preset, no Harness or a failing session.create → skipped as no_session (no run is recorded)', async () => {
  writeTasks([eventTask('at_plain'), eventTask('at_s2', { sessionPreset: 'care-billing' })])
  const noGateway = makeHost({ gateway: false })
  const r1 = await noGateway.svc.emit('visit_record.returned', { id: 1 }, 'ev-a')
  assert.deepEqual(r1.triggered, [])
  assert.deepEqual(r1.skipped.map((s) => [s.taskId, s.reason]), [['at_plain', 'no_session'], ['at_s2', 'no_session']])
  assert.equal(noGateway.schedules.length, 0)

  const failing = makeHost({ failCreate: true })
  const r2 = await failing.svc.emit('visit_record.returned', { id: 2 }, 'ev-b')
  assert.deepEqual(r2.skipped.map((s) => [s.taskId, s.reason]), [['at_plain', 'no_session'], ['at_s2', 'no_session']])
  assert.equal(tasksOnDisk().find((t) => t.id === 'at_s2').sessionId, '', 'nothing bound after a failure')
  // 失敗した事件は台帳に残らない＝同じ dedupeKey で再試行できる
  const ok = makeHost()
  const r3 = await ok.svc.emit('visit_record.returned', { id: 2 }, 'ev-b')
  assert.deepEqual(r3.triggered, ['at_s2'])
  assert.equal(tasksOnDisk().find((t) => t.id === 'at_s2').sessionId, 'sess-1')
})

test('sessionPreset: an invalid preset id is never sent to the host; a disabled task never opens a session', async () => {
  writeTasks([eventTask('at_bad', { sessionPreset: '../x y' }), eventTask('at_off', { sessionPreset: 'care-billing', enabled: false })])
  const host = makeHost()
  const r = await host.svc.emit('visit_record.returned', { id: 1 }, 'ev-x')
  assert.deepEqual(r.skipped.map((s) => [s.taskId, s.reason]), [['at_bad', 'no_session'], ['at_off', 'disabled']])
  assert.equal(host.invokes.length, 0)
})
