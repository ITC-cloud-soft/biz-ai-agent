// Process, environment, isolated DSH home and auto-task template helpers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertIsolatedHome, assertPortsUsable, dshEnv, installAutoTaskTemplates, launchTokenOf, portFree, prepareIsolatedHome, redactor, sanitizedEnv,
  startProcess, waitFor,
} from '../src/index.mjs'

test('sanitizedEnv drops secrets and existing DSH / Bridge / legacy settings; extra values are kept', () => {
  const env = sanitizedEnv({ DSH_HOME: '/tmp/h', KEEP: '1' }, {
    source: { PATH: '/bin', OPENAI_API_KEY: 'x', DSH_HOME: '/personal', BRIDGE_API_URL: 'u', CARE_SERVICE_TOKEN: 't', MYAPP_SECRET_URL: 's', MYAPP_URL: 'v' },
    drop: /^MYAPP_/,
  })
  assert.deepEqual(env, { PATH: '/bin', DSH_HOME: '/tmp/h', KEEP: '1' })
})

test('isolated DSH home: the personal ~/.dsh is refused; reset removes runtime state but keeps profiles/', () => {
  assert.throws(() => assertIsolatedHome(join(homedir(), '.dsh')), /personal DSH home/)
  assert.throws(() => assertIsolatedHome(join(homedir(), '.dsh', 'profiles')), /personal DSH home/)
  assert.throws(() => assertIsolatedHome(''), /required/)
  const root = mkdtempSync(join(tmpdir(), 'bridge-testing-'))
  try {
    const home = join(root, '.dsh-home-unit')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'p'), { recursive: true })
    writeFileSync(join(home, '.credentials.yaml'), 'x: 1')
    const r = prepareIsolatedHome(home)
    assert.equal(existsSync(join(home, 'sessions')), false)
    assert.equal(existsSync(join(home, '.credentials.yaml')), false)
    assert.equal(existsSync(join(home, 'profiles', 'p')), true)
    assert.equal(existsSync(r.workspace) && existsSync(r.agents), true)
    const env = dshEnv(home, { BRIDGE_API_URL: 'http://127.0.0.1:1' })
    assert.equal(env.DSH_HOME, r.home)
    assert.equal(env.BRIDGE_DSH_WORKSPACE, r.workspace)
    assert.equal(env.BRIDGE_API_URL, 'http://127.0.0.1:1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('launch token parsing and redaction', () => {
  assert.equal(launchTokenOf('dsh web: http://127.0.0.1:3186/?token=abcdefghijklmnop1234'), 'abcdefghijklmnop1234')
  assert.equal(launchTokenOf('nothing'), null)
  const redact = redactor(['test-secret-value'])
  assert.equal(redact('GET /?token=abcdefghijklmnop1234 Bearer abc.def test-secret-value'), 'GET /?token=<redacted> Bearer <redacted> <redacted>')
})

test('startProcess (redacted tail) / waitFor / ports', async () => {
  const lines = []
  const proc = startProcess('child', process.execPath, ['-e', 'console.log("ready http://x/?token=abcdefghijklmnop1234"); setTimeout(() => {}, 60000)'], {
    env: sanitizedEnv(), redact: redactor(), onLine: (l) => lines.push(l),
  })
  try {
    await waitFor(() => lines.length > 0, { timeoutMs: 10_000, label: 'first line' })
    assert.equal(lines[0], 'ready http://x/?token=abcdefghijklmnop1234', 'onLine sees the raw line')
    assert.deepEqual(proc.tail, ['ready http://x/?token=<redacted>'], 'the kept tail is redacted')
  } finally {
    await proc.stop()
  }
  assert.notEqual(proc.child.exitCode === null && proc.child.signalCode === null, true, 'stopped')
  await assert.rejects(waitFor(() => false, { timeoutMs: 50, stepMs: 10, label: 'never' }), /timed out waiting for never/)
  assert.equal(typeof (await portFree(0)), 'boolean')
  await assert.rejects(assertPortsUsable({ demo: 3080 }, { forbidden: [3080], portFree: async () => true }), /reserved/)
  await assert.rejects(assertPortsUsable({ x: 1 }, { portFree: async () => false }), /in use/)
})

test('installAutoTaskTemplates: template-owned fields are overwritten, operational fields kept, unbound tasks enabled with a preset', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-templates-'))
  try {
    const dir = join(root, 'auto-tasks')
    mkdirSync(join(dir, 'proposals'), { recursive: true })
    const tpl = { id: 'tpl-a', name: 'A', instruction: 'do a', trigger: { type: 'event', events: ['report.overdue'] }, approval: { mode: 'none' }, feedback: { onSuccess: true } }
    writeFileSync(join(dir, 'a.json'), JSON.stringify(tpl))
    writeFileSync(join(dir, 'proposals', 'b.json'), JSON.stringify({ id: 'tpl-b', name: 'B', instruction: 'do b', trigger: { type: 'event', events: ['x.y'] }, sessionPreset: 'example-assistant' }))
    const home = join(root, 'home')
    const first = installAutoTaskTemplates(home, dir, { sessionId: 's1', unbound: ['tpl-b'] })
    assert.deepEqual([first.installed, first.updated], [['tpl-a', 'tpl-b'], []])
    let tasks = JSON.parse(readFileSync(first.tasksFile, 'utf8'))
    assert.deepEqual(tasks.map((t) => [t.id, t.enabled, t.sessionId]), [['tpl-a', true, 's1'], ['tpl-b', true, '']])
    tasks[0].enabled = false
    tasks[0].guard = { maxRunsPerDay: 3 }
    writeFileSync(first.tasksFile, JSON.stringify(tasks))
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ ...tpl, instruction: 'do a v2' }))
    const second = installAutoTaskTemplates(home, dir, {})
    assert.deepEqual(second.updated, ['tpl-a', 'tpl-b'])
    tasks = JSON.parse(readFileSync(second.tasksFile, 'utf8'))
    assert.equal(tasks[0].instruction, 'do a v2')
    assert.equal(tasks[0].enabled, false, 'operational fields are kept')
    assert.deepEqual(tasks[0].guard, { maxRunsPerDay: 3 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
