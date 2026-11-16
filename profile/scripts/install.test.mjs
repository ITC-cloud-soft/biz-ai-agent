// install.mjs: profile files, {{FRAMEWORK_ROOT}}, automatic tasks and delegation (--skip-install; temporary isolated homes only).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDelegation } from './patch-preserve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const INSTALL = join(here, 'install.mjs')
const TEMPLATE = join(here, '..', 'template')
const FRAMEWORK = resolve(here, '..', '..')
const SECOND = 'at_example_second'
const IDS = ['at_example_report_overdue', SECOND]

function install(home, ...args) {
  // DSH_HOME is not passed (--home is explicit). The `dsh --version` warning only goes to stderr.
  const env = { ...process.env }
  delete env.DSH_HOME
  const r = spawnSync(process.execPath, [INSTALL, '--home', home, '--skip-install', ...args], { encoding: 'utf8', env, timeout: 60_000 })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}
const tasksOf = (home) => Object.fromEntries(JSON.parse(readFileSync(join(home, 'auto-tasks', 'tasks.json'), 'utf8')).map((t) => [t.id, t]))
const patchOf = (home, profile = 'bridge') => readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
const slash = (p) => p.split('\\').join('/')

/** A product profile made from the template, with a second automatic task in proposals/. */
function productSource(root) {
  const src = join(root, 'my-profile')
  cpSync(TEMPLATE, src, { recursive: true })
  mkdirSync(join(src, 'auto-tasks', 'proposals'), { recursive: true })
  const first = JSON.parse(readFileSync(join(src, 'auto-tasks', 'example-report-overdue.json'), 'utf8'))
  writeFileSync(join(src, 'auto-tasks', 'proposals', 'second.json'), JSON.stringify({
    ...first, id: SECOND, name: 'second', trigger: { type: 'event', eventTypes: ['report.submitted'] }, source: { ...first.source, template: 'second' },
  }, null, 2) + '\n')
  return src
}

test('install.mjs: template files are installed, {{FRAMEWORK_ROOT}} is filled, placeholders are reported', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const r = install(home)
    assert.equal(r.code, 0, r.out)
    const dest = join(home, 'profiles', 'bridge')
    for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) assert.ok(existsSync(join(dest, f)), f)
    const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(JSON.stringify(manifest).includes('{{FRAMEWORK_ROOT}}'), false)
    assert.equal(manifest.dependencies['@dsh-bridge/dsh-core'], `file:${slash(FRAMEWORK)}/packages/dsh-core`)
    assert.equal(manifest.dependencies['@dsh-bridge/plugin-tools'], `file:${slash(FRAMEWORK)}/plugins/tools`)
    assert.ok(manifest.dsh.profile.bundles.includes('@dsh-bridge/plugin-identity'))
    assert.equal(patchOf(home), readFileSync(join(TEMPLATE, 'cordis.patch.yml'), 'utf8'))
    assert.match(r.out, /template placeholders left/)
    assert.match(r.out, /id: <application-id>/)
    assert.ok(existsSync(join(home, 'proactive', 'config.json')))
    assert.ok(existsSync(join(home, 'agents')) && existsSync(join(home, 'workspace')))
    assert.equal(tasksOf(home).at_example_report_overdue.enabled, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install.mjs: refuses the personal ~/.dsh, a reserved profile name and a directory that is not a profile', () => {
  const personal = install(join(homedir(), '.dsh'))
  assert.equal(personal.code, 2)
  assert.match(personal.out, /refusing to install into the personal DSH home/)
  const nested = install(join(homedir(), '.dsh', 'x'))
  assert.equal(nested.code, 2)
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    assert.equal(install(join(root, 'home'), '--profile', 'web').code, 2)
    const notProfile = install(join(root, 'home'), '--source', root)
    assert.equal(notProfile.code, 2)
    assert.match(notProfile.out, /not a profile directory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: templates (top level + proposals/) are imported disabled; --enable-auto-tasks enables them without a session or delivery target', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  const home = join(root, 'home')
  const src = productSource(root)
  const run = (...args) => install(home, '--source', src, '--profile', 'my-product', ...args)
  const patch = () => patchOf(home, 'my-product')
  try {
    const first = run()
    assert.equal(first.code, 0, first.out)
    let tasks = tasksOf(home)
    assert.deepEqual(Object.keys(tasks).sort(), IDS)
    for (const t of Object.values(tasks)) {
      assert.equal(t.enabled, false, `${t.id} disabled by default`)
      assert.equal(t.applicationId, 'example-app')
      assert.ok(t.sessionPreset && t.audience?.rule, t.id)
    }
    assert.equal(readDelegation(patch()), null, 'no delegation by default (bridge-tools deny)')

    const enabled = run('--enable-auto-tasks', '--auto-task-delegate', 'feishu:ou_test0001')
    assert.equal(enabled.code, 0, enabled.out)
    tasks = tasksOf(home)
    for (const id of IDS) {
      assert.equal(tasks[id].enabled, true, `${id} enabled`)
      assert.equal(tasks[id].sessionId, '', `${id}: the session is opened by auto-tasks on the first event`)
      assert.deepEqual(tasks[id].delivery, { channels: [] })
    }
    assert.match(enabled.out, /session: opened on first event \(business-assistant\)/)
    assert.doesNotMatch(enabled.out, /no delegation is configured/)
    assert.deepEqual(readDelegation(patch()), { platform: 'feishu', userId: 'ou_test0001' })
    assert.match(patch(), /^- id: bridge-tools\r?\n  name: '@dsh-bridge\/plugin-tools'\r?\n  config:\r?\n    unattendedPolicy: delegate\r?$/m)

    // operational state (bound session, feedback, auto-pause) survives a reinstall; template-owned fields come back
    const file = join(home, 'auto-tasks', 'tasks.json')
    const edited = JSON.parse(readFileSync(file, 'utf8')).map((t) => (t.id === 'at_example_report_overdue'
      ? { ...t, sessionId: 'sess-bound', feedback: { ...t.feedback, respectQuietHours: false }, instruction: 'tampered', pausedAt: '2026-10-27T00:00:00Z', pauseReason: 'failures', failureStreak: 5, enabled: false }
      : t))
    writeFileSync(file, JSON.stringify(edited, null, 2), 'utf8')
    const again = run()
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /kept the automatic-task delegation \(bridge-tools/)
    tasks = tasksOf(home)
    const rec = tasks.at_example_report_overdue
    assert.equal(rec.sessionId, 'sess-bound')
    assert.equal(rec.feedback.respectQuietHours, false)
    assert.notEqual(rec.instruction, 'tampered', 'template-owned fields are restored')
    assert.equal(rec.enabled, false, 'a paused task stays off without --enable-auto-tasks')
    assert.equal(tasks[SECOND].enabled, true, 'enabled state is kept')
    assert.deepEqual(readDelegation(patch()), { platform: 'feishu', userId: 'ou_test0001' }, 'delegation kept on reinstall')

    // enable some (also clears the auto-pause), disable some
    const some = run('--enable-auto-tasks', 'at_example_report_overdue', '--disable-auto-tasks', `${SECOND},at_unknown`)
    assert.equal(some.code, 0, some.out)
    assert.match(some.out, /unknown auto-task id\(s\): at_unknown/)
    tasks = tasksOf(home)
    assert.equal(tasks.at_example_report_overdue.enabled, true)
    assert.equal(tasks.at_example_report_overdue.pausedAt, null)
    assert.equal(tasks.at_example_report_overdue.failureStreak, 0)
    assert.equal(tasks[SECOND].enabled, false)

    // removing the delegation warns while tasks are enabled (their tool calls would be refused)
    const off = run('--auto-task-delegate', 'off')
    assert.equal(off.code, 0, off.out)
    assert.equal(readDelegation(patch()), null)
    assert.equal(patch().match(/^- id: bridge-tools/gm).length, 1, 'the template entry (groupChat deny) stays')
    assert.doesNotMatch(patch(), /^ {4}unattendedPolicy/m)
    assert.match(off.out, /no delegation is configured/)
    assert.equal(patch(), readFileSync(join(src, 'cordis.patch.yml'), 'utf8'), 'back to the product patch')

    const bad = run('--auto-task-delegate', 'feishu')
    assert.equal(bad.code, 2)
    assert.match(bad.out, /--auto-task-delegate must be/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: the delegation entry follows dshBridge.delegation of the profile (e.g. an older tools plugin id)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const src = productSource(root)
    const manifest = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
    manifest.dshBridge.delegation = { id: 'my-tools', name: '@my/dsh-tools' }
    writeFileSync(join(src, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const home = join(root, 'home')
    const r = install(home, '--source', src, '--auto-task-delegate', 'slack:U1:T1')
    assert.equal(r.code, 0, r.out)
    const text = patchOf(home)
    assert.match(text, /^- id: my-tools\r?\n  name: '@my\/dsh-tools'/m)
    assert.deepEqual(readDelegation(text, { id: 'my-tools' }), { platform: 'slack', userId: 'U1', teamId: 'T1' })
    assert.equal(readDelegation(text), null, 'the default target (bridge-tools) is not used')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: the legacy --auto-task-session / --auto-task-bot / --auto-task-target binding (fixed delivery targets) is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const home = join(root, 'home')
    const src = productSource(root)
    for (const args of [
      ['--auto-task-session', 'sess-legacy', '--auto-task-bot', 'line_x', '--auto-task-target', 'target-manager'],
      ['--auto-task-target', 'target-manager'],
      ['--auto-task-bot', 'line_x'],
      ['--enable-auto-tasks', '--auto-task-session', 'sess-legacy'],
    ]) {
      const r = install(home, '--source', src, ...args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
      assert.match(r.out, /not available — automatic-task reports go only to the recipients the business system resolves/)
      assert.equal(existsSync(join(home, 'auto-tasks', 'tasks.json')), false, 'nothing is installed')
      assert.equal(existsSync(join(home, 'profiles')), false, 'nothing is installed')
    }
    // without them the same profile installs, every task disabled and with no delivery target
    const ok = install(home, '--source', src, '--enable-auto-tasks')
    assert.equal(ok.code, 0, ok.out)
    for (const task of Object.values(tasksOf(home))) {
      assert.equal(task.sessionId ?? '', '')
      assert.deepEqual(task.delivery?.channels ?? [], [])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: a template with a per-person delegation (source.delegation <class>=each) is enabled only by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const home = join(root, 'home')
    const src = productSource(root)
    const first = JSON.parse(readFileSync(join(src, 'auto-tasks', 'example-report-overdue.json'), 'utf8'))
    const EACH = 'at_example_each'
    writeFileSync(join(src, 'auto-tasks', 'proposals', 'each.json'), JSON.stringify({
      ...first, id: EACH, name: 'each', trigger: { type: 'event', eventTypes: ['report.requested'] }, source: { ...first.source, template: 'each', delegation: 'inspector=each' },
    }, null, 2) + '\n')
    const all = install(home, '--source', src, '--enable-auto-tasks', '--auto-task-delegate', 'feishu:ou_test0002')
    assert.equal(all.code, 0, all.out)
    let tasks = tasksOf(home)
    for (const id of IDS) assert.equal(tasks[id].enabled, true, id)
    assert.equal(tasks[EACH].enabled, false, 'not run under the single unattended delegate')
    assert.match(all.out, /at_example_each runs with a per-person delegation \(source\.delegation inspector=each\)/)
    const named = install(home, '--source', src, '--enable-auto-tasks', EACH)
    assert.equal(named.code, 0, named.out)
    tasks = tasksOf(home)
    assert.equal(tasks[EACH].enabled, true)
    assert.equal(tasks[EACH].source.delegation, 'inspector=each', 'template-owned source kept')
    // enabled, but the single delegate does not opt its class in: told that its tool calls will be refused
    assert.match(named.out, /at_example_each runs with a per-person delegation \(source\.delegation inspector=each\) but --auto-task-delegate does not enable inspector=each/)
    // per class: the default delegate plus inspector=each (bridge-tools unattendedDelegates), kept on reinstall
    const classes = install(home, '--source', src, '--auto-task-delegate', 'default=feishu:ou_test0002,planning=line:Uplan0001,inspector=each')
    assert.equal(classes.code, 0, classes.out)
    assert.doesNotMatch(classes.out, /does not enable inspector=each/)
    assert.match(classes.out, /automatic tasks run on behalf of default=feishu:ou_tes…, planning=line:Uplan0…, inspector=each/)
    assert.deepEqual(readDelegation(patchOf(home)), {
      platform: 'feishu', userId: 'ou_test0002', classes: { planning: { platform: 'line', userId: 'Uplan0001' }, inspector: 'each' },
    })
    assert.match(patchOf(home), /^    unattendedDelegates:\r?\n      planning:\r?\n        platform: "line"\r?\n        userId: "Uplan0001"\r?\n      inspector: each\r?$/m)
    const again = install(home, '--source', src)
    assert.match(again.out, /kept the automatic-task delegation \(bridge-tools unattendedDelegates: default=feishu:ou_tes…, planning=line:Uplan0…, inspector=each\)/)
    assert.deepEqual(readDelegation(patchOf(home)).classes.inspector, 'each')
    const bad = install(home, '--source', src, '--auto-task-delegate', 'inspector=everyone')
    assert.notEqual(bad.code, 0)
    assert.match(bad.out, /--auto-task-delegate must be/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: a manifest playbook deployed by bridge-events (pb_<app>_<playbook>) is enabled only by name; its agent becomes the session preset', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const home = join(root, 'home')
    const src = productSource(root)
    assert.equal(install(home, '--source', src).code, 0)
    // what @dsh-bridge/plugin-events → ctx.autoTasks.deployPlaybooks leaves in tasks.json (new playbook tasks are disabled)
    const file = join(home, 'auto-tasks', 'tasks.json')
    const PB = 'pb_equipment-inspection_overdue_followup'
    const deployed = {
      id: PB, name: '【設備点検】点検期限超過のフォロー', instruction: 'x', trigger: { type: 'event', eventTypes: ['inspection.overdue'] }, approval: 'auto',
      source: { kind: 'bridge-playbook', applicationId: 'equipment-inspection', playbook: 'overdue_followup', agent: 'facility-inspection', tools: ['facility_propose_reschedule'] },
      applicationId: 'equipment-inspection', audience: { rule: 'assignee_and_managers' }, enabled: false, sessionId: '', delivery: { channels: [] },
    }
    writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), deployed], null, 2), 'utf8')

    const all = install(home, '--source', src, '--enable-auto-tasks')
    assert.equal(all.code, 0, all.out)
    assert.equal(tasksOf(home)[PB].enabled, false, '--enable-auto-tasks without ids only touches the templates')

    const named = install(home, '--source', src, '--enable-auto-tasks', PB, '--auto-task-delegate', 'line:Utest0001')
    assert.equal(named.code, 0, named.out)
    assert.doesNotMatch(named.out, /unknown auto-task id/)
    let pb = tasksOf(home)[PB]
    assert.equal(pb.enabled, true)
    assert.equal(pb.sessionPreset, 'facility-inspection', 'the playbook agent opens the dedicated conversation')
    assert.equal(pb.instruction, 'x', 'playbook-owned fields are left to bridge-events')
    assert.ok(named.out.includes(`on  ${PB} [inspection.overdue] (bridge-playbook) session: opened on first event (facility-inspection)`), named.out)

    const again = install(home, '--source', src)
    assert.equal(again.code, 0, again.out)
    assert.equal(tasksOf(home)[PB].enabled, true, 'kept on reinstall')

    const off = install(home, '--source', src, '--disable-auto-tasks', PB, '--auto-task-delegate', 'off')
    assert.equal(off.code, 0, off.out)
    pb = tasksOf(home)[PB]
    assert.equal(pb.enabled, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install.mjs: --auto-task-delegate keeps a product bridge-tools entry (toolModules) and writes the delegation into it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-install-'))
  try {
    const src = productSource(root)
    // the product fills in the template's bridge-tools entry (groupChat deny + its tool modules)
    const template = readFileSync(join(src, 'cordis.patch.yml'), 'utf8')
    const entry = "- id: bridge-tools\n  name: '@dsh-bridge/plugin-tools'\n  config:\n    groupChat: deny\n"
    assert.ok(template.includes(entry), 'the template has one bridge-tools entry')
    const product = template.replace(entry, `${entry}    toolModules:\n      - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: equipment-inspection }\n`)
    writeFileSync(join(src, 'cordis.patch.yml'), product)
    const home = join(root, 'home')
    const r = install(home, '--source', src, '--auto-task-delegate', 'line:Utest0002')
    assert.equal(r.code, 0, r.out)
    const text = patchOf(home)
    assert.equal(text.match(/^- id: bridge-tools/gm).length, 1)
    assert.match(text, /toolModules:\n      - \{ module: '@dsh-bridge\/plugin-tools\/examples\/equipment-inspection'/)
    assert.match(text, /^- id: bridge-tools\n  name: '@dsh-bridge\/plugin-tools'\n  config:\n(?: {4}.*\n)*? {4}groupChat: deny\n/m, 'groupChat deny kept')
    assert.deepEqual(readDelegation(text), { platform: 'line', userId: 'Utest0002' })
    const again = install(home, '--source', src)
    assert.equal(again.code, 0, again.out)
    assert.equal(patchOf(home), text, 'reinstall: the same patch (delegation kept, toolModules kept)')
    assert.equal(install(home, '--source', src, '--auto-task-delegate', 'off').code, 0)
    assert.equal(patchOf(home), product, 'off: back to the product patch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
