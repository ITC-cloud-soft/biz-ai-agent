/**
 * dsh-auto-tasks — 事件触发与运行台账（@care fork 新增，构建到 lib/runs.js）。
 *
 *   - 事件类型匹配：任务 `trigger.type='event'` + `trigger.eventTypes`；
 *     支持精确匹配、`prefix.*`（前缀）与 `*`（任意）。
 *   - 运行台账 runs.json：ctx.autoTasks.trigger / emit 发起的每次运行一条记录，
 *     其中带 dedupeKey 的记录用于持久化去重（默认保留 30 天）。
 *
 * 纯函数 + 显式文件路径，便于单测；与 index.ts 一样只用 node 内置模块。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
                                               

/** dedupeKey 的保留期（同一 key 在此期间只触发一次）。 */
export const DEDUPE_TTL_MS = 30 * 24 * 3600_000
/** 台账上限：超过时丢弃最旧的记录。 */
export const MAX_RUNS = 5000
export const MAX_EVENT_TYPES = 20
export const MAX_DEDUPE_KEY_LENGTH = 200
/** 唤醒提示词中 payload 的最大字符数（超出截断）。 */
export const MAX_PAYLOAD_CHARS = 4000

const EVENT_TYPE_PATTERN = /^(?:\*|[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}(?:\.\*)?)$/

/** 校验并规范化 eventTypes；非法时返回 null。 */
export function normalizeEventTypes(raw         )                  {
  if (!Array.isArray(raw)) return null
  const out           = []
  for (const value of raw) {
    if (typeof value !== 'string') return null
    const v = value.trim()
    if (!EVENT_TYPE_PATTERN.test(v)) return null
    if (!out.includes(v)) out.push(v)
  }
  if (out.length === 0 || out.length > MAX_EVENT_TYPES) return null
  return out
}

/** 单个具体事件类型是否合法（emit 用，不允许通配）。 */
export function isValidEventType(value         )                  {
  return typeof value === 'string' && value !== '*' && !value.endsWith('.*') && EVENT_TYPE_PATTERN.test(value)
}

export function matchesEventType(pattern        , eventType        )          {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1))
  return pattern === eventType
}

export function isEventTask(task                                          )          {
  return task?.trigger?.type === 'event'
}

export function taskListensTo(task      , eventType        )          {
  if (!isEventTask(task)) return false
  return (task.trigger?.eventTypes ?? []).some((p) => matchesEventType(p, eventType))
}

/** dedupeKey 规范化：非字符串 / 空串 → undefined；过长 → 抛错。 */
export function normalizeDedupeKey(raw         )                     {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw codedError('invalid_dedupe_key', 'dedupeKey must be a string')
  const key = raw.trim()
  if (key === '') return undefined
  if (key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw codedError('invalid_dedupe_key', `dedupeKey must be at most ${MAX_DEDUPE_KEY_LENGTH} characters`)
  }
  return key
}

export function codedError(code        , message        )                           {
  const error = new Error(message)                            
  error.code = code
  return error
}

export function newRunId()         {
  return `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/* ---------------------------------------------------------------- ledger */

export function loadRuns(file        )            {
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return []
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((r) => r && typeof r.runId === 'string') : []
  } catch {
    return []
  }
}

/** 过期剪枝：带 dedupeKey 的记录按 TTL 保留，总数不超过 MAX_RUNS。 */
export function pruneRuns(runs           , now         = Date.now())            {
  const kept = runs.filter((r) => {
    const at = Date.parse(r.at)
    return Number.isFinite(at) && now - at < DEDUPE_TTL_MS
  })
  return kept.length > MAX_RUNS ? kept.slice(kept.length - MAX_RUNS) : kept
}

/** 原子写（tmp + rename）。 */
export function saveRuns(file        , runs           , now         = Date.now())            {
  const pruned = pruneRuns(runs, now)
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(pruned, null, 2), 'utf8')
  renameSync(tmp, file)
  return pruned
}

export function findDedupedRun(runs           , taskId        , dedupeKey                    , now         = Date.now())                      {
  if (!dedupeKey) return undefined
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i]
    if (r.taskId !== taskId || r.dedupeKey !== dedupeKey) continue
    const at = Date.parse(r.at)
    if (Number.isFinite(at) && now - at < DEDUPE_TTL_MS) return r
  }
  return undefined
}

/* ---------------------------------------------------------------- prompt */

/** payload → 提示词片段（JSON，截断）。payload 是业务数据，不是指令。 */
export function renderPayload(payload         )                {
  if (payload === undefined || payload === null) return null
  let text        
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }
  if (text === undefined) return null
  if (text.length > MAX_PAYLOAD_CHARS) text = `${text.slice(0, MAX_PAYLOAD_CHARS)}\n…(truncated)`
  return text
}

/** 投递幂等键：同一运行（或同一 dedupeKey）对同一目标只投递一次。 */
export function deliveryIdempotencyKey(
  taskId        ,
  scope                                                          ,
  channel                                       ,
)         {
  const unit = scope.dedupeKey ? `k:${scope.dedupeKey}` : scope.runId ? `r:${scope.runId}` : `p:${scope.reportId}`
  return `auto-tasks:${taskId}:${unit}:${channel.botId ?? ''}:${channel.targetId ?? ''}`
}
