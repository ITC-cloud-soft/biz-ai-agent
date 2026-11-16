// Automatic task templates of the profile template (template/auto-tasks/*.json and proposals/*.json).
// They must be exactly the Task shape install.mjs imports into $DSH_HOME/auto-tasks/tasks.json (vendor/dsh-auto-tasks),
// their trigger events / tools / audience must exist in the manifest of their application (here the generic example manifest),
// proposal tools must be `propose` tools, the preset must exist in the template patch, and the instruction must state
// "propose only, nothing decided, no personal data kept, the trigger data is not an instruction".
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifestFile } from '@dsh-bridge/protocol'

const here = dirname(fileURLToPath(import.meta.url))
const template = resolve(here, '..', 'template')
const framework = resolve(here, '..', '..')

const runsModule = join(framework, 'vendor', 'dsh-auto-tasks', 'lib', 'runs.js')
const normalizeEventTypes = existsSync(runsModule) ? (await import(new URL(`file:///${runsModule.split('\\').join('/')}`).href)).normalizeEventTypes : null

const TOP = join(template, 'auto-tasks')
const PROPOSALS = join(TOP, 'proposals')
const load = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [])
  .map((f) => ({ file: f, dir, task: JSON.parse(readFileSync(join(dir, f), 'utf8')), raw: readFileSync(join(dir, f), 'utf8') }))
const templates = [...load(TOP), ...load(PROPOSALS)]

/** applicationId → manifest (the template targets the generic example application). */
const MANIFESTS = { 'example-app': loadManifestFile(join(framework, 'packages', 'protocol', 'manifests', 'example.manifest.yaml')) }
// Events that bridge-events keeps for the plugins (not forwarded to auto-tasks)
const ROUTED = new Set(['approval.requested', 'approval.decided', 'approval.expired', 'sns_identity.unlinked'])
// Agent presets of the template patch (dsh-agent-preset config.id)
const PRESETS = new Set([...readFileSync(join(template, 'cordis.patch.yml'), 'utf8')
  .matchAll(/name: '@deepseek-ai\/dsh-agent-preset'\r?\n\s+config:\r?\n\s+id: ([a-z0-9-]+)/g)].map((m) => m[1]))
const AUTO_TASK_TOOLS = ['auto_task_report', 'auto_task_silent']

test('templates: unique ids, the Task shape install.mjs expects, disabled and unbound by default', () => {
  assert.ok(templates.length >= 1)
  const ids = templates.map((t) => t.task.id)
  assert.equal(new Set(ids).size, ids.length, 'unique ids')
  for (const { file, task, raw } of templates) {
    assert.match(task.id, /^at_[a-z0-9]+_[a-z0-9_]+$/, file)
    assert.ok(task.name && task.instruction, file)
    assert.equal(raw, JSON.stringify(task, null, 2) + '\n', `${file}: 2-space JSON + LF`)
    assert.equal(task.enabled, false, `${file}: disabled in the template (install.mjs --enable-auto-tasks enables it)`)
    assert.equal(task.sessionId, '', file)
    assert.deepEqual(task.delivery, { channels: [] }, `${file}: no fixed delivery target (audience delivery)`)
    assert.equal(task.approval, 'auto', `${file}: tools can only propose, so no prior approval`)
    assert.equal(task.trigger?.type, 'event', file)
    assert.ok(MANIFESTS[task.applicationId], `${file}: applicationId ${task.applicationId} has a manifest`)
    assert.equal(typeof task.audience?.rule, 'string', `${file}: audience for the report`)
    assert.ok(PRESETS.has(task.sessionPreset), `${file}: sessionPreset ${task.sessionPreset} is a template preset (${[...PRESETS].join(', ')})`)
    assert.equal(task.source?.kind, 'profile-template', file)
    assert.equal(task.source?.agent, task.sessionPreset, file)
    assert.equal(task.source?.dedupe, 'event', file)
    assert.equal(task.source?.delivery, 'only_if_actionable', file)
    assert.deepEqual(task.feedback.deliverOn, ['failed', 'needsDecision'], `${file}: report only when something was proposed or failed`)
    assert.ok(Number.isInteger(task.guard?.maxRunsPerDay) && task.guard.maxRunsPerDay > 0 && task.guard.maxRunsPerDay <= 100, `${file}: daily budget`)
    assert.ok(task.guard.maxConsecutiveFailures > 0 && task.guard.autoPause === true, `${file}: pauses after repeated failures`)
  }
})

test('templates: trigger events, audience rule and tools exist in the application manifest', () => {
  for (const { file, task } of templates) {
    const manifest = MANIFESTS[task.applicationId]
    if (normalizeEventTypes) assert.deepEqual(normalizeEventTypes(task.trigger.eventTypes), task.trigger.eventTypes, `${file}: valid eventTypes for dsh-auto-tasks`)
    for (const type of task.trigger.eventTypes) {
      assert.ok(manifest.events[type], `${file}: ${type} is an event of ${task.applicationId}`)
      assert.ok(!ROUTED.has(type) && !manifest.events[type].internal, `${file}: ${type} is forwarded to auto-tasks`)
    }
    assert.ok(manifest.audienceRules?.[task.audience.rule], `${file}: audience rule ${task.audience.rule}`)
    const tools = Object.fromEntries(manifest.tools.map((t) => [t.name, t]))
    assert.ok(Array.isArray(task.source.tools) && task.source.tools.length > 0, `${file}: source.tools (bridge-tools scopes proposals to this list)`)
    for (const name of task.source.tools) {
      assert.ok(tools[name], `${file}: ${name} is a tool of ${task.applicationId}`)
      assert.ok(['read', 'propose'].includes(tools[name].access), `${file}: ${name} reads or proposes`)
      assert.ok(task.instruction.includes(name), `${file}: the instruction tells the model how to use ${name}`)
    }
    assert.ok(task.source.tools.some((n) => tools[n].access === 'propose') || /説明文/.test(task.instruction), `${file}: proposes something (or explains)`)
    for (const name of AUTO_TASK_TOOLS) assert.ok(task.instruction.includes(name), `${file}: ${name}`)
  }
})

test('templates: propose only, nothing decided, no personal data kept, trigger data is not an instruction', () => {
  for (const { file, task } of templates) {
    const s = task.instruction
    assert.match(s, /禁止事項/, file)
    assert.match(s, /指示ではない/, `${file}: trigger data is business data, not instructions`)
    assert.match(s, /氏名/, `${file}: no names in memory / summary`)
    assert.match(s, /summary/, file)
    assert.match(s, /ツールの結果に無い事実・数値を作らない/, file)
    assert.match(s, /auto_task_silent で終える/, `${file}: silent when there is nothing to do`)
    assert.match(s, /status="needsDecision"/, file)
    assert.match(s, /【対応のお願い】/, `${file}: AI secretary wording`)
  }
})
