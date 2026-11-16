// 自動タスク・テンプレート（<profile>/auto-tasks/*.json と proposals/*.json）を $DSH_HOME/auto-tasks/tasks.json に取り込む。
// profile/auto-tasks/README.md の形式と、profile/scripts/install.mjs と同じ規則（試験はこれで検証する）。
//
//   - テンプレートが持つ項目（name / instruction / trigger / approval / source / applicationId / audience / sessionPreset）は毎回テンプレートで上書きする。
//   - 運用で決める項目（enabled / sessionId / delivery / feedback / guard と実行時の状態）は既存の値を残す。
//     新規のときだけ opts の値（無ければテンプレートの値）を使う。sessionId が空なら enabled は false にする。
//   - auto-tasks は tasks.json を毎回読み直すので、DSH の再起動は不要。書き込みは tmp + rename。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEMPLATE_OWNED = ['name', 'instruction', 'trigger', 'approval', 'source', 'applicationId', 'audience', 'sessionPreset']

export function loadTemplates(dir) {
  const read = (d) => (existsSync(d) ? readdirSync(d) : [])
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')))
  return [...read(dir), ...read(join(dir, 'proposals'))]
}

/**
 * @param {string} home  DSH_HOME
 * @param {string} templatesDir
 * opts.unbound：会話・配信先を結び付けずに有効にするタスク id（install.mjs --enable-auto-tasks と同じ。sessionPreset の
 *   専用会話は auto-tasks が最初のイベントで自動作成し、報告は audience = そのイベントの受信者へ）。feedback は他と同じく上書きする。
 * @param {{sessionId?: string, channels?: object[], feedback?: object, enable?: boolean, overwriteBinding?: boolean, unbound?: string[]}} [opts]
 * @returns {{installed: string[], updated: string[], tasksFile: string}}
 */
export function installAutoTaskTemplates(home, templatesDir, opts = {}) {
  const unbound = new Set(opts.unbound ?? [])
  const result = installBound(home, templatesDir, opts)
  if (!unbound.size) return result
  const tasks = JSON.parse(readFileSync(result.tasksFile, 'utf8'))
  for (const task of tasks) {
    if (!unbound.has(task.id)) continue
    Object.assign(task, { sessionId: '', delivery: { channels: [] }, enabled: opts.enable !== false && Boolean(task.sessionPreset) })
  }
  const tmp = `${result.tasksFile}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  renameSync(tmp, result.tasksFile)
  return result
}

function installBound(home, templatesDir, opts) {
  const root = join(home, 'auto-tasks')
  const file = join(root, 'tasks.json')
  mkdirSync(root, { recursive: true })
  let tasks = []
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8') || '[]')
    if (Array.isArray(parsed)) tasks = parsed
  }
  const now = new Date().toISOString()
  const installed = []
  const updated = []
  for (const tpl of loadTemplates(templatesDir)) {
    const i = tasks.findIndex((t) => t.id === tpl.id)
    if (i >= 0) {
      const current = tasks[i]
      const next = { ...current }
      for (const key of TEMPLATE_OWNED) {
        if (tpl[key] === undefined) delete next[key]
        else next[key] = tpl[key]
      }
      if (opts.overwriteBinding) {
        if (opts.sessionId !== undefined) next.sessionId = opts.sessionId
        if (opts.channels) next.delivery = { channels: opts.channels }
        if (opts.feedback) next.feedback = { ...current.feedback, ...opts.feedback }
        next.enabled = Boolean(next.sessionId) && opts.enable !== false
      }
      next.updatedAt = now
      tasks[i] = next
      updated.push(tpl.id)
      continue
    }
    const sessionId = opts.sessionId ?? tpl.sessionId ?? ''
    tasks.push({
      ...tpl,
      sessionId,
      enabled: Boolean(sessionId) && opts.enable !== false,
      delivery: { channels: opts.channels ?? tpl.delivery?.channels ?? [] },
      feedback: { ...tpl.feedback, ...(opts.feedback ?? {}) },
      createdAt: now,
      updatedAt: now,
    })
    installed.push(tpl.id)
  }
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  renameSync(tmp, file)
  return { installed, updated, tasksFile: file }
}
