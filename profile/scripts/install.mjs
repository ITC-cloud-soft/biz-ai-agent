#!/usr/bin/env node
// 製品 profile を隔離した DSH_HOME に展開し、依存をインストールする。
//
//   node profile/scripts/install.mjs [--home <dir>] [--profile <name>] [--source <profile dir>] [--framework-root <dir>] [--skip-install]
//     [--enable-auto-tasks [<taskId,...>]] [--disable-auto-tasks [<taskId,...>]]
//     [--auto-task-delegate <platform>:<userId>[:<teamId>] | <class>=<platform>:<userId>[:<teamId>]|each,... | off]
//   （--auto-task-session / --auto-task-bot / --auto-task-target は拒否する。下記）
//
// 既定: --home <framework>/.dsh-home  --profile bridge  --source <framework>/profile/template
// ~/.dsh（利用者の個人 DSH）には絶対に書かない。
//
// --source は製品ごとの profile ディレクトリ（profile/template を写して作ったもの。package.json / cordis.patch.yml / cordis.yml /
// pnpm-workspace.yaml / [pnpm-lock.yaml] / proactive.config.json / auto-tasks/）。package.json の {{FRAMEWORK_ROOT}} は
// framework の絶対パス（--framework-root、既定はこのスクリプトの 2 つ上）に置き換える。
//
// 自動タスク（auto-tasks/*.json と auto-tasks/proposals/*.json。auto-tasks/README.md）
//   --enable-auto-tasks [ids]   テンプレートのタスクを有効にする（ids 省略 = 全部）。会話が未結合でも、テンプレートの
//                               sessionPreset の専用会話を auto-tasks が最初のイベントで自動作成する（固定の配信先は不要。
//                               報告は audience = そのイベントの受信者の連携先へ、提案そのものは業務システムの AI 提案として届く）
//                               ids には tasks.json に既にあるテンプレート以外のタスク（bridge-events が manifest の playbooks から
//                               デプロイした pb_<applicationId>_<playbookId>）も書ける。会話が未結合なら playbook の agent を
//                               sessionPreset にする（名指ししたときだけ。ids 省略ではテンプレートだけ）
//   --disable-auto-tasks [ids]  無効にする
//   --auto-task-delegate p:u    自動タスクのターンを誰の委託で動かすか（bridge-tools の unattendedPolicy=delegate /
//                               unattendedOnBehalfOf。業務システムで IM 連携済みの職員）。off で既定の拒否に戻す。
//                               profile の patch に書き、再インストールでも引き継ぐ
//                               分類ごと：planning=line:U1,billing=line:U2,inspector=each（playbook の委託の分類 source.delegation
//                               ごとの職員 = bridge-tools の unattendedDelegates。default=<p>:<u> は分類の職員が無いときの既定）。
//                               <class>=each は、その分類の playbook（source.delegation <class>=each）に、起動事件の本人ごとの
//                               委託（業務システムが事件に対して発行する）を許す。委託先に広い役割（管理者など）を選ばないこと
//                               （業務システムの役割はここでは分からない。bridge-tools の unattendedWarnRoles が実行時に警告する）
//   --auto-task-session / --auto-task-bot / --auto-task-target   （従来の、既存の会話・固定の配信先への結び付け）拒否する（exit 2）。
//                               自動タスクの報告は業務システムが決めた受信者だけに届ける（bridge-notify の audience）：固定の配信先
//                               （botId + targetId）は業務システムの受信者の規則を通らず、既存の会話（IM の会話でありうる）に結び付けると
//                               自動タスクの回の AI の文がその会話にそのまま流れる。会話はテンプレートの sessionPreset で専用のものを開く
//                               （docs/ARCHITECTURE.md §7.2 の 10。ケアビリングの dsh/runtime-profile/scripts/install.mjs と同じ）

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DELEGATION_TARGET, carryUserManaged, describeDelegation, parseDelegation, readDelegation, withDelegation } from './patch-preserve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frameworkDefault = resolve(here, '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

// fixed delivery targets / binding to an existing conversation: never (the business system decides every recipient)
const LEGACY_BINDING = ['--auto-task-session', '--auto-task-bot', '--auto-task-target'].filter((name) => process.argv.includes(name))
if (LEGACY_BINDING.length) {
  console.error(`${LEGACY_BINDING.join(' / ')}: not available — automatic-task reports go only to the recipients the business system resolves `
    + '(bridge-notify audience; docs/ARCHITECTURE.md §7.2); the templates open their own conversation (sessionPreset). Use --enable-auto-tasks.')
  process.exit(2)
}

const profileSrc = resolve(arg('--source', join(here, '..', 'template')))
const frameworkRoot = resolve(arg('--framework-root', frameworkDefault))
const FRAMEWORK_TOKEN = '{{FRAMEWORK_ROOT}}'
const FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
if (!existsSync(join(profileSrc, 'package.json')) || !existsSync(join(profileSrc, 'cordis.patch.yml'))) {
  console.error(`not a profile directory (needs package.json and cordis.patch.yml): ${profileSrc}`)
  process.exit(2)
}
const sourceManifest = JSON.parse(readFileSync(join(profileSrc, 'package.json'), 'utf8'))
const EXPECTED_DSH = sourceManifest.dshBridge?.expectedDsh ?? '0.2.2-rc.1'
const delegationTarget = { ...DEFAULT_DELEGATION_TARGET, ...(sourceManifest.dshBridge?.delegation ?? {}) }
/** package.json の {{FRAMEWORK_ROOT}} → framework の絶対パス（/ 区切り。pnpm の file: は Windows でも / を受け付ける）。 */
const withFrameworkRoot = (text) => text.split(FRAMEWORK_TOKEN).join(frameworkRoot.replace(/\\/g, '/'))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** `--flag [a,b]`：無ければ null、値が無い（次が別の --flag）なら 'all'、値があれば Set。 */
function listArg(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const value = process.argv[i + 1]
  if (value === undefined || value.startsWith('--')) return 'all'
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean))
}

const home = resolve(arg('--home', process.env.DSH_HOME || join(frameworkDefault, '.dsh-home')))
const profile = arg('--profile', 'bridge')
const skipInstall = process.argv.includes('--skip-install')
const enableTasks = listArg('--enable-auto-tasks')
const disableTasks = listArg('--disable-auto-tasks')
let delegation // undefined = 変更しない（前回の値を引き継ぐ）、null = 解除、object = 設定
if (process.argv.includes('--auto-task-delegate')) {
  try {
    delegation = parseDelegation(arg('--auto-task-delegate', ''))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
}

const personal = resolve(homedir(), '.dsh').toLowerCase()
const lowered = home.toLowerCase()
if (lowered === personal || lowered.startsWith(personal + sep) || lowered.startsWith(personal + '/')) {
  console.error(`refusing to install into the personal DSH home (${personal}); pass --home <isolated dir>`)
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile) || ['web', 'headless', 'acp', 'sdk', 'sdk-minimal', 'tui', 'desktop'].includes(profile)) {
  console.error(`invalid profile name ${JSON.stringify(profile)} (shipped names are reserved)`)
  process.exit(2)
}

const marker = join(home, 'INSTALLED.json')
const installedState = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {}

const dest = join(home, 'profiles', profile)
mkdirSync(dest, { recursive: true })
mkdirSync(join(home, 'agents'), { recursive: true })
mkdirSync(join(home, 'workspace'), { recursive: true })
for (const file of FILES) {
  const source = join(profileSrc, file)
  if (!existsSync(source)) continue
  const target = join(dest, file)
  // 設定画面からの変更（プリセット編集・各種設定）は profile の cordis.patch.yml に書き戻される。
  // 前回インストールした内容から変わっていれば、上書き前にバックアップを残す。
  if (file === 'cordis.patch.yml' && existsSync(target)) {
    const current = readFileSync(target, 'utf8')
    if (sha256(current) !== installedState[profile]?.patchSha256 && current !== readFileSync(source, 'utf8')) {
      const backup = `${target}.bak-${Date.now()}`
      cpSync(target, backup)
      console.warn(`warning: ${target} had local changes (e.g. saved from the settings UI); backed up to ${backup}`)
    }
    // モデル設定（管理画面で保存した既定モデル・プロバイダー）だけは引き継ぐ（patch-preserve.mjs）
    const { text, carried } = carryUserManaged(current, readFileSync(source, 'utf8'))
    // 自動タスクの委託（導入先ごとの値）も引き継ぐ。--auto-task-delegate があればその値に置き換える
    const previous = readDelegation(current, delegationTarget)
    const next = delegation === undefined ? previous : delegation
    writeFileSync(target, withDelegation(text, next, delegationTarget))
    if (carried.length) console.log(`kept model settings saved from the settings UI: ${carried.join(', ')}`)
    if (next && delegation === undefined) {
      console.log(next.classes
        ? `kept the automatic-task delegation (${delegationTarget.id} unattendedDelegates: ${describeDelegation(next)})`
        : `kept the automatic-task delegation (${delegationTarget.id} unattendedOnBehalfOf: ${next.platform})`)
    }
    continue
  }
  if (file === 'cordis.patch.yml' && delegation) {
    writeFileSync(target, withDelegation(readFileSync(source, 'utf8'), delegation, delegationTarget))
    continue
  }
  if (file === 'package.json') {
    writeFileSync(target, withFrameworkRoot(readFileSync(source, 'utf8')))
    continue
  }
  cpSync(source, target)
}
const installedPatch = readFileSync(join(dest, 'cordis.patch.yml'), 'utf8')
const activeDelegation = readDelegation(installedPatch, delegationTarget)
// 雛形の <placeholder> が残っていれば知らせる（コメント行と行末のコメント〔`bots: []  # botId: <id>` の例〕は除く。bridge-apps は不正な id で起動を拒否する）
{
  const left = installedPatch.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, '')).filter((l) => !/^\s*#/.test(l) && /:\s*<[^>]+>/.test(l)).map((l) => l.trim())
  if (left.length) console.warn(`warning: template placeholders left in ${join(dest, 'cordis.patch.yml')}:\n  ${left.slice(0, 8).join('\n  ')}${left.length > 8 ? `\n  (+${left.length - 8} more)` : ''}`)
}
if (delegation !== undefined) {
  console.log(delegation
    ? `automatic tasks run on behalf of ${describeDelegation(delegation)} (${delegationTarget.id} unattendedPolicy=delegate; restart DSH to apply)`
    : `automatic-task delegation removed (${delegationTarget.id} unattendedPolicy=deny; restart DSH to apply)`)
}
// compatibility.json（バージョン互換チェックの免除リスト）は置かない＝免除なし。
console.log(`profile files -> ${dest}`)

// 自動タスクのテンプレート（auto-tasks/*.json と auto-tasks/proposals/*.json）→ $DSH_HOME/auto-tasks/tasks.json。
// テンプレートの持つ項目（name / instruction / trigger / approval / source / applicationId / audience / sessionPreset）だけを
// 毎回上書きし、運用項目（有効化・配信先・会話・feedback・guard・実行時の状態）は残す。
// 既定では新しいタスクは無効（会話も委託も未設定のため）。--enable-auto-tasks で有効にする（auto-tasks/README.md）。
{
  const TEMPLATE_OWNED = ['name', 'instruction', 'trigger', 'approval', 'source', 'applicationId', 'audience', 'sessionPreset']
  const dirs = [join(profileSrc, 'auto-tasks'), join(profileSrc, 'auto-tasks', 'proposals')]
  const file = join(home, 'auto-tasks', 'tasks.json')
  mkdirSync(join(home, 'auto-tasks'), { recursive: true })
  const tasks = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8') || '[]') : []
  const now = new Date().toISOString()
  const templates = dirs.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(d, name), 'utf8'))))
  const picks = (sel, id) => sel === 'all' || (sel instanceof Set && sel.has(id))
  // A template whose source.delegation is per person ('<class>=each', e.g. care_manager=each: one run per employee with that
  // employee's own delegation, which the business system issues for the triggering event) never runs under a single unattended
  // delegate: --enable-auto-tasks without ids leaves it off with a warning; naming its id enables it, and its tool calls are allowed
  // only once --auto-task-delegate opts its class in (<class>=each).
  const perPerson = (tpl) => /(^|=)each$/.test(String(tpl.source?.delegation ?? ''))
  const eachClassOf = (task) => /^([a-z][a-z0-9_]{0,39})=each$/.exec(String(task?.source?.delegation ?? ''))?.[1] ?? null
  const optedIn = (cls) => activeDelegation?.classes?.[cls] === 'each'
  const warnNotOptedIn = (task) => {
    const cls = eachClassOf(task)
    if (task.enabled && cls && !optedIn(cls)) {
      console.warn(`warning: ${task.id} runs with a per-person delegation (source.delegation ${task.source.delegation}) but --auto-task-delegate does not enable ${cls}=each: its business tool calls will be refused`)
    }
  }
  for (const sel of [enableTasks, disableTasks]) {
    const unknown = sel instanceof Set ? [...sel].filter((id) => !templates.some((t) => t.id === id) && !tasks.some((t) => t.id === id)) : []
    if (unknown.length) console.warn(`warning: unknown auto-task id(s): ${unknown.join(', ')} (known: ${[...new Set([...templates, ...tasks].map((t) => t.id))].join(', ')})`)
  }
  const summary = []
  for (const tpl of templates) {
    const i = tasks.findIndex((t) => t.id === tpl.id)
    const cur = i >= 0 ? tasks[i] : null
    const next = cur ? { ...cur } : { ...tpl, createdAt: now }
    for (const key of TEMPLATE_OWNED) {
      if (tpl[key] === undefined) delete next[key]
      else next[key] = tpl[key]
    }
    if (!cur) next.enabled = Boolean(next.sessionId) // a new task starts disabled unless its template binds a conversation
    if (picks(enableTasks, tpl.id) && enableTasks === 'all' && perPerson(tpl)) {
      console.warn(`warning: ${tpl.id} runs with a per-person delegation (source.delegation ${tpl.source.delegation}); --enable-auto-tasks without ids leaves it off (name it to enable it)`)
    } else if (picks(enableTasks, tpl.id)) {
      // 会話が未結合でも sessionPreset があれば auto-tasks が専用会話を自動作成する
      next.enabled = Boolean(next.sessionId || next.sessionPreset)
      if (next.enabled && next.pausedAt) Object.assign(next, { pausedAt: null, pauseReason: null, failureStreak: 0 })
      if (!next.enabled) console.warn(`warning: ${tpl.id} has neither a session nor a sessionPreset; it stays disabled (give the template a sessionPreset)`)
    }
    if (picks(disableTasks, tpl.id)) next.enabled = false
    next.updatedAt = now
    if (cur) tasks[i] = next
    else tasks.push(next)
    summary.push(`  ${next.enabled ? 'on ' : 'off'} ${tpl.id} [${(tpl.trigger?.eventTypes ?? []).join(', ')}] `
      + `${next.sessionId ? 'session bound' : next.sessionPreset ? `session: opened on first event (${next.sessionPreset})` : 'no session'}`)
  }
  // 既に tasks.json にある、テンプレート以外のタスク（例：bridge-events が manifest の playbooks からデプロイした
  // pb_<applicationId>_<playbookId>。新規は無効）は、id を名指ししたときだけ有効 / 無効にする（--enable-auto-tasks だけでは触らない）。
  // 会話が未結合なら playbook の agent（source.agent）を sessionPreset にして、最初のイベントで専用会話を自動作成させる。
  for (const task of tasks) {
    if (templates.some((t) => t.id === task.id)) continue
    const enable = enableTasks instanceof Set && enableTasks.has(task.id)
    const disable = disableTasks instanceof Set && disableTasks.has(task.id)
    if (!enable && !disable) continue
    if (enable) {
      if (!task.sessionId && !task.sessionPreset && typeof task.source?.agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(task.source.agent)) {
        task.sessionPreset = task.source.agent
      }
      task.enabled = Boolean(task.sessionId || task.sessionPreset)
      if (task.enabled && task.pausedAt) Object.assign(task, { pausedAt: null, pauseReason: null, failureStreak: 0 })
      if (!task.enabled) console.warn(`warning: ${task.id} has neither a session nor a sessionPreset / agent; it stays disabled (the playbook needs an agent)`)
    }
    if (disable) task.enabled = false
    task.updatedAt = now
    summary.push(`  ${task.enabled ? 'on ' : 'off'} ${task.id} [${(task.trigger?.eventTypes ?? []).join(', ')}] (${task.source?.kind ?? 'task'}) `
      + `${task.sessionId ? 'session bound' : task.sessionPreset ? `session: opened on first event (${task.sessionPreset})` : 'no session'}`)
  }
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  renameSync(tmp, file)
  console.log(`auto-task templates -> ${file}\n${summary.join('\n')}`)
  for (const task of tasks) warnNotOptedIn(task)
  if (tasks.some((t) => t.enabled && /-template$|^bridge-playbook$/.test(String(t.source?.kind ?? ''))) && !activeDelegation) {
    console.warn(`warning: automatic tasks are enabled but no delegation is configured (${delegationTarget.id} unattendedPolicy=deny): `
      + 'their business tool calls will be refused. Pass --auto-task-delegate <platform>:<userId> (an employee linked in the business system through IM).')
  }
}

// dsh-proactive は行 config を読まず $DSH_HOME/proactive/config.json を読む。
// 初回だけ製品の既定値（日本語プロンプト・Asia/Tokyo）を置く。管理者が画面から保存した値は上書きしない。
const proactiveConfig = join(home, 'proactive', 'config.json')
if (!existsSync(proactiveConfig)) {
  mkdirSync(join(home, 'proactive'), { recursive: true })
  if (existsSync(join(profileSrc, 'proactive.config.json'))) {
    cpSync(join(profileSrc, 'proactive.config.json'), proactiveConfig)
    console.log(`proactive defaults -> ${proactiveConfig}`)
  }
}

const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents') }
// DSH_BIN（@deepseek-ai/dsh/lib/bin.js。pnpm demo / pnpm e2e は版を固定したローカルの CLI を渡す）があればそれを node で直接起動し、
// 無ければ PATH の dsh（Windows の .cmd を含むため shell 経由）。
const DSH_BIN = process.env.DSH_BIN && existsSync(process.env.DSH_BIN) ? process.env.DSH_BIN : null
const run = (args, options = {}) => DSH_BIN
  ? spawnSync(process.execPath, [DSH_BIN, ...args], { env, ...options })
  : spawnSync(['dsh', ...args].join(' '), { env, shell: true, ...options })

const version = run(['--version'], { encoding: 'utf8' })
const actual = (version.stdout || '').trim()
if (actual !== EXPECTED_DSH) {
  console.warn(`warning: dsh --version is ${JSON.stringify(actual)}, profile is pinned for ${EXPECTED_DSH}`)
}

if (!skipInstall) {
  // file: 依存（@dsh-bridge/* / vendor の fork）は pnpm がハードリンクで入れるため、ソースの更新方法によっては
  // 古い内容が残る。毎回消して入れ直す。
  const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
  for (const [pkg, spec] of Object.entries(manifest.dependencies || {})) {
    if (String(spec).startsWith('file:')) rmSync(join(dest, 'node_modules', ...pkg.split('/')), { recursive: true, force: true })
  }
  // `dsh plugin --profile <name> <pnpm-args>` は profile ディレクトリで pnpm を実行する公式経路。
  const r = run(['plugin', '--profile', profile, 'install'], { stdio: 'inherit', cwd: home })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

writeFileSync(marker, JSON.stringify({
  ...installedState,
  [profile]: {
    at: new Date().toISOString(),
    dsh: actual,
    source: profileSrc,
    frameworkRoot,
    patchSha256: sha256(readFileSync(join(dest, 'cordis.patch.yml'), 'utf8')),
  },
}, null, 2) + '\n')
console.log(`done. start with (cwd = ${home}):
  DSH_HOME=${home} DSH_AGENTS_HOME=${join(home, 'agents')} dsh --profile ${profile} --no-open --host 127.0.0.1 --port 3180 --public-url http://127.0.0.1:3190/dsh/`)
