// AI 社員の外部連携（docs/AI_EMPLOYEE_PROFILE.md §3）：接続先（connector）・操作（operation）・規則（rule）の形・上限・保存前の検査と、
// 規則の条件の評価・入力の差し込み・応答の項目の許可リスト。業務システム（server-kit・自前の実装）・web-kit・DSH が同じものを使う。
//
// - 接続先の秘密（API キー・パスワード・クライアントの秘密）はここの形に入らない（業務システムが暗号化して別に持つ）。
// - 操作の入力は JSON Schema の小さな部分集合（平らな object、値は文字列・数・真偽）。AI のツールの引数にもそのまま使う。
// - 規則の条件は等号・含む・大小・存在だけ（コードは書けない）。差し込みは `{payload.x}` の形だけ。
// - 検査の結果は { field, code } だけ（入力の値そのものは返さない）。
import { validateSchema } from './jsonschema.mjs'

export const CONNECTOR_KINDS = Object.freeze(['own', 'third_party'])
export const CONNECTOR_AUTH_TYPES = Object.freeze(['none', 'api_key', 'bearer', 'basic', 'oauth2_client'])
/** 個人情報の区分（manifest の pii と同じ）。high は規則で使うのに管理者の明示の許可（rule.allowPii）が要る。 */
export const CONNECTOR_PII = Object.freeze(['none', 'personal', 'financial', 'sensitive', 'health'])
export const CONNECTOR_PII_HIGH = Object.freeze(['financial', 'sensitive', 'health'])
export const OPERATION_EFFECTS = Object.freeze(['read', 'write'])
export const OPERATION_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export const RULE_MODES = Object.freeze(['approval', 'auto', 'propose-by-ai'])
export const CONDITION_OPS = Object.freeze(['eq', 'contains', 'gt', 'lt', 'exists'])
export const RULE_NOTIFY = Object.freeze(['none', 'info', 'action'])
export const INPUT_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean'])
/** 実行の結果の状態（実行の記録・通知に使う。本文は残さない）。 */
export const RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'refused', 'pending_approval', 'proposed', 'rejected', 'skipped'])

export const CONNECTOR_LIMITS = Object.freeze({
  id: 40, name: 60, description: 300, reason: 200, operations: 20, allowedHosts: 10, path: 300, inputProperties: 20, responseFields: 50,
  conditions: 10, inputMap: 20, template: 300, headerName: 60, username: 120, clientId: 200, scope: 200,
  timeoutMs: Object.freeze({ min: 1000, max: 10_000, default: 10_000 }),
  ratePerMinute: Object.freeze({ min: 1, max: 600, default: 30 }),
  maxResponseBytes: Object.freeze({ min: 1024, max: 1024 * 1024, default: 256 * 1024 }),
  responseItems: 100, responseString: 500,
})

export const CONNECTOR_ID_RE = /^[a-z][a-z0-9-]{0,39}$/
const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/
const RESPONSE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\])?){0,5}$/
const PATH_VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]{0,39})\}/g
const TEMPLATE_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5})\}/g
const WHOLE_TEMPLATE_RE = /^\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5})\}$/
const HEADER_RE = /^[A-Za-z0-9-]{1,60}$/
const ROLE_RE = /^[a-z][a-z0-9_]{0,39}$/
const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]'])
/** 条件の評価・差し込みで使える最上位の名前（event = 起動した事件、payload = その中身、now = 定時の時刻）。 */
export const RULE_DATA_ROOTS = Object.freeze(['event', 'payload', 'now'])

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim() : v)

function collector() {
  const errors = []
  return { errors, add: (field, code, extra) => errors.push({ field, code, ...(extra ?? {}) }) }
}

function unknownKeys(obj, allowed, prefix, add) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) add(prefix ? `${prefix}.${k}` : k, 'unknown_field')
}

function readText(obj, key, field, max, add, { required = false } = {}) {
  const v = obj[key]
  if (v === undefined || v === null || v === '') { if (required) add(field, 'required'); return '' }
  if (typeof v !== 'string') { add(field, 'invalid'); return '' }
  const s = text(v)
  if (required && !s) add(field, 'required')
  if (s.length > max) add(field, 'too_long')
  return s
}

function readInt(obj, key, field, { min, max, default: def }, add) {
  const v = obj[key]
  if (v === undefined || v === null) return def
  if (!Number.isInteger(v) || v < min || v > max) { add(field, 'invalid'); return def }
  return v
}

function readRoles(v, field, add) {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 20 || v.some((r) => typeof r !== 'string' || !ROLE_RE.test(r))) { add(field, 'invalid'); return [] }
  return [...new Set(v)]
}

/** URL の host（ポートつき、小文字）。https 以外（開発の localhost の http は allowLocalhost のときだけ）・資格情報つき・query つきは null。 */
export function connectorHostOf(value, { allowLocalhost = false } = {}) {
  let url
  try { url = new URL(String(value)) } catch { return { error: 'invalid' } }
  if (url.username || url.password) return { error: 'invalid' }
  if (url.search || url.hash) return { error: 'invalid' }
  const local = LOCAL_HOSTS.includes(url.hostname)
  if (url.protocol === 'https:') {
    if (local && !allowLocalhost) return { error: 'host_not_allowed' }
    return { host: url.host.toLowerCase(), url }
  }
  if (url.protocol === 'http:' && local && allowLocalhost) return { host: url.host.toLowerCase(), url }
  return { error: 'not_https' }
}

function validateInputSchema(input, field, add) {
  if (input === undefined || input === null) return { type: 'object', properties: {}, required: [], additionalProperties: false }
  if (!isRec(input) || (input.type !== undefined && input.type !== 'object')) { add(field, 'invalid'); return null }
  unknownKeys(input, ['type', 'properties', 'required', 'additionalProperties', 'description'], field, add)
  if (input.additionalProperties !== undefined && input.additionalProperties !== false) add(`${field}.additionalProperties`, 'invalid')
  const props = input.properties ?? {}
  if (!isRec(props)) { add(`${field}.properties`, 'invalid'); return null }
  const names = Object.keys(props)
  if (names.length > CONNECTOR_LIMITS.inputProperties) add(`${field}.properties`, 'too_many')
  const properties = {}
  for (const name of names) {
    const f = `${field}.properties.${name}`
    const p = props[name]
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name) || !isRec(p)) { add(f, 'invalid'); continue }
    unknownKeys(p, ['type', 'description', 'enum', 'maxLength', 'minLength', 'pattern', 'format', 'minimum', 'maximum'], f, add)
    if (!INPUT_TYPES.includes(p.type)) { add(`${f}.type`, 'invalid'); continue }
    const out = { type: p.type }
    if (p.description !== undefined) out.description = readText(p, 'description', `${f}.description`, CONNECTOR_LIMITS.description, add)
    if (p.enum !== undefined) {
      if (!Array.isArray(p.enum) || !p.enum.length || p.enum.length > 50 || p.enum.some((x) => !['string', 'number', 'boolean'].includes(typeof x))) add(`${f}.enum`, 'invalid')
      else out.enum = [...p.enum]
    }
    for (const k of ['maxLength', 'minLength']) {
      if (p[k] === undefined) continue
      if (p.type !== 'string' || !Number.isInteger(p[k]) || p[k] < 0 || p[k] > 2000) add(`${f}.${k}`, 'invalid'); else out[k] = p[k]
    }
    if (p.type === 'string' && out.maxLength === undefined) out.maxLength = 500
    for (const k of ['minimum', 'maximum']) {
      if (p[k] === undefined) continue
      if (!['number', 'integer'].includes(p.type) || typeof p[k] !== 'number' || !Number.isFinite(p[k])) add(`${f}.${k}`, 'invalid'); else out[k] = p[k]
    }
    if (p.pattern !== undefined) {
      let ok = typeof p.pattern === 'string' && p.pattern.length <= 200 && p.type === 'string'
      if (ok) try { new RegExp(p.pattern, 'u') } catch { ok = false }
      if (!ok) add(`${f}.pattern`, 'invalid'); else out.pattern = p.pattern
    }
    if (p.format !== undefined) {
      if (p.type !== 'string' || !['date', 'date-time'].includes(p.format)) add(`${f}.format`, 'invalid'); else out.format = p.format
    }
    properties[name] = out
  }
  let required = []
  if (input.required !== undefined) {
    if (!Array.isArray(input.required) || input.required.some((r) => typeof r !== 'string' || !Object.hasOwn(properties, r))) add(`${field}.required`, 'invalid')
    else required = [...new Set(input.required)]
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 操作 1 つ。effect: read（読む）/ write（書く・送る）。write は AI のツールでは実行せず、提案か規則の承認を通る（D5）。
 * autoRun：管理者が「承認なしで自動で実行してよい」にした write（冪等なものだけ、理由が必須）。read は常に自動でよい。
 */
export function validateOperation(input, { field = 'operation' } = {}) {
  const { errors, add } = collector()
  if (!isRec(input)) return { ok: false, operation: null, errors: [{ field, code: 'invalid' }] }
  unknownKeys(input, ['id', 'name', 'description', 'method', 'path', 'input', 'responseFields', 'pii', 'effect', 'idempotent', 'roles', 'autoRun'], field, add)
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) add(`${field}.id`, 'required')
  else if (!CONNECTOR_ID_RE.test(id)) add(`${field}.id`, 'invalid')
  const name = readText(input, 'name', `${field}.name`, CONNECTOR_LIMITS.name, add, { required: true })
  const description = readText(input, 'description', `${field}.description`, CONNECTOR_LIMITS.description, add)
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET'
  if (!OPERATION_METHODS.includes(method)) add(`${field}.method`, 'invalid')
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (!path) add(`${field}.path`, 'required')
  else if (!path.startsWith('/') || path.length > CONNECTOR_LIMITS.path || /\.\.|\/\/|[?#\s\\]/.test(path)) add(`${field}.path`, 'invalid')
  const schema = validateInputSchema(input.input, `${field}.input`, add)
  const pathVars = [...path.matchAll(PATH_VAR_RE)].map((m) => m[1])
  if (schema) {
    for (const v of pathVars) {
      if (!schema.properties[v]) add(`${field}.path`, 'path_var_undeclared', { name: v })
      else if (!schema.required.includes(v)) schema.required.push(v)
    }
  }
  let responseFields = []
  if (input.responseFields !== undefined && input.responseFields !== null) {
    if (!Array.isArray(input.responseFields) || input.responseFields.length > CONNECTOR_LIMITS.responseFields) add(`${field}.responseFields`, 'invalid')
    else {
      responseFields = [...new Set(input.responseFields.map((x) => (typeof x === 'string' ? x.trim() : x)))]
      responseFields.forEach((p, i) => { if (typeof p !== 'string' || !RESPONSE_PATH_RE.test(p)) add(`${field}.responseFields[${i}]`, 'invalid') })
    }
  }
  const pii = input.pii ?? 'none'
  if (!CONNECTOR_PII.includes(pii)) add(`${field}.pii`, 'invalid')
  const effect = input.effect ?? (method === 'GET' ? 'read' : 'write')
  if (!OPERATION_EFFECTS.includes(effect)) add(`${field}.effect`, 'invalid')
  if (effect === 'read' && !['GET', 'POST'].includes(method)) add(`${field}.effect`, 'invalid') // a read is GET (or a search by POST)
  const idempotent = input.idempotent === undefined ? method === 'GET' : input.idempotent
  if (typeof idempotent !== 'boolean') add(`${field}.idempotent`, 'invalid')
  const roles = readRoles(input.roles, `${field}.roles`, add)
  let autoRun = { allowed: false, reason: null }
  if (input.autoRun !== undefined && input.autoRun !== null) {
    if (!isRec(input.autoRun)) add(`${field}.autoRun`, 'invalid')
    else {
      unknownKeys(input.autoRun, ['allowed', 'reason'], `${field}.autoRun`, add)
      const allowed = input.autoRun.allowed === true
      const reason = readText(input.autoRun, 'reason', `${field}.autoRun.reason`, CONNECTOR_LIMITS.reason, add)
      if (allowed && effect === 'write' && idempotent !== true) add(`${field}.autoRun.allowed`, 'auto_needs_idempotent')
      if (allowed && effect === 'write' && !reason) add(`${field}.autoRun.reason`, 'reason_required')
      autoRun = { allowed: allowed && effect === 'write', reason: allowed && effect === 'write' ? reason : null }
    }
  }
  const operation = { id, name, description, method, path, input: schema, responseFields, pii, effect, idempotent: idempotent === true, roles, autoRun }
  return errors.length ? { ok: false, operation: null, errors } : { ok: true, operation, errors: [] }
}

/**
 * 接続先 1 つ（操作つき）。秘密は持たない（auth には種類とヘッダー名・利用者名・トークンの URL・クライアント ID だけ）。
 * baseUrl は https だけ（開発の localhost は allowLocalhost のとき）。送ってよいホストは allowedHosts（空なら baseUrl のホスト）。
 */
export function validateConnector(input, { allowLocalhost = false } = {}) {
  const { errors, add } = collector()
  if (!isRec(input)) return { ok: false, connector: null, errors: [{ field: 'connector', code: 'invalid' }] }
  unknownKeys(input, ['id', 'name', 'kind', 'description', 'baseUrl', 'allowedHosts', 'auth', 'timeoutMs', 'ratePerMinute', 'maxResponseBytes', 'enabled', 'operations'], '', add)
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) add('id', 'required')
  else if (!CONNECTOR_ID_RE.test(id)) add('id', 'invalid')
  const name = readText(input, 'name', 'name', CONNECTOR_LIMITS.name, add, { required: true })
  const kind = input.kind ?? 'third_party'
  if (!CONNECTOR_KINDS.includes(kind)) add('kind', 'invalid')
  const description = readText(input, 'description', 'description', CONNECTOR_LIMITS.description, add)
  let baseUrl = ''
  let baseHost = null
  if (typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) add('baseUrl', 'required')
  else {
    const r = connectorHostOf(input.baseUrl.trim(), { allowLocalhost })
    if (r.error) add('baseUrl', r.error)
    else { baseHost = r.host; baseUrl = `${r.url.origin}${r.url.pathname.replace(/\/+$/, '')}` }
  }
  let allowedHosts = []
  if (input.allowedHosts !== undefined && input.allowedHosts !== null) {
    if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length > CONNECTOR_LIMITS.allowedHosts) add('allowedHosts', 'invalid')
    else {
      input.allowedHosts.forEach((h, i) => {
        const v = typeof h === 'string' ? h.trim().toLowerCase() : ''
        if (!/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:[0-9]{1,5})?$/.test(v)) add(`allowedHosts[${i}]`, 'invalid')
        else allowedHosts.push(v)
      })
    }
  }
  allowedHosts = [...new Set(allowedHosts)]
  if (baseHost && !allowedHosts.length) allowedHosts = [baseHost]
  if (baseHost && allowedHosts.length && !allowedHosts.includes(baseHost)) add('baseUrl', 'host_not_allowed')
  const auth = { type: 'none' }
  const a = input.auth ?? { type: 'none' }
  if (!isRec(a) || !CONNECTOR_AUTH_TYPES.includes(a.type)) add('auth.type', 'invalid')
  else {
    auth.type = a.type
    unknownKeys(a, ['type', 'headerName', 'username', 'tokenUrl', 'clientId', 'scope'], 'auth', add)
    if (a.type === 'api_key') {
      const h = a.headerName === undefined ? 'x-api-key' : a.headerName
      if (typeof h !== 'string' || !HEADER_RE.test(h) || /^(host|content-length|cookie|connection|transfer-encoding)$/i.test(h)) add('auth.headerName', 'invalid')
      else auth.headerName = h.toLowerCase()
    }
    if (a.type === 'basic') auth.username = readText(a, 'username', 'auth.username', CONNECTOR_LIMITS.username, add, { required: true })
    if (a.type === 'oauth2_client') {
      auth.clientId = readText(a, 'clientId', 'auth.clientId', CONNECTOR_LIMITS.clientId, add, { required: true })
      auth.scope = readText(a, 'scope', 'auth.scope', CONNECTOR_LIMITS.scope, add) || null
      const r = typeof a.tokenUrl === 'string' && a.tokenUrl.trim() ? connectorHostOf(a.tokenUrl.trim(), { allowLocalhost }) : { error: 'required' }
      if (r.error) add('auth.tokenUrl', r.error)
      else if (!allowedHosts.includes(r.host)) add('auth.tokenUrl', 'host_not_allowed')
      else auth.tokenUrl = r.url.href
    }
  }
  const timeoutMs = readInt(input, 'timeoutMs', 'timeoutMs', CONNECTOR_LIMITS.timeoutMs, add)
  const ratePerMinute = readInt(input, 'ratePerMinute', 'ratePerMinute', CONNECTOR_LIMITS.ratePerMinute, add)
  const maxResponseBytes = readInt(input, 'maxResponseBytes', 'maxResponseBytes', CONNECTOR_LIMITS.maxResponseBytes, add)
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') add('enabled', 'invalid')
  const operations = []
  const ops = input.operations ?? []
  if (!Array.isArray(ops)) add('operations', 'invalid')
  else {
    if (ops.length > CONNECTOR_LIMITS.operations) add('operations', 'too_many')
    const seen = new Set()
    ops.slice(0, CONNECTOR_LIMITS.operations).forEach((op, i) => {
      const r = validateOperation(op, { field: `operations[${i}]` })
      if (!r.ok) { errors.push(...r.errors); return }
      if (seen.has(r.operation.id)) { add(`operations[${i}].id`, 'duplicate'); return }
      seen.add(r.operation.id)
      operations.push(r.operation)
    })
  }
  const connector = {
    id, name, kind, description, baseUrl, allowedHosts, auth, timeoutMs, ratePerMinute, maxResponseBytes, enabled: input.enabled !== false, operations,
  }
  return errors.length ? { ok: false, connector: null, errors } : { ok: true, connector, errors: [] }
}

/** 5 項目の cron（分 時 日 月 曜日。* / 数 / 範囲 / 列挙 / 刻み、名前なし）。 */
export function parseCron(expr) {
  const parts = typeof expr === 'string' ? expr.trim().split(/\s+/) : []
  if (parts.length !== 5) return null
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  const fields = []
  for (let i = 0; i < 5; i += 1) {
    const [lo, hi] = ranges[i]
    const set = new Set()
    for (const piece of parts[i].split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(piece)
      if (!m) return null
      const from = m[1] === '*' ? lo : Number(m[2])
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : from)
      const step = m[4] ? Number(m[4]) : 1
      if (from < lo || to > hi || from > to || step < 1) return null
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v)
    }
    fields.push(set)
  }
  return fields
}

/** { minute, hour, day, month, weekday }（その地域の時刻）が cron に当たるか。 */
export function cronMatches(expr, at) {
  const f = parseCron(expr)
  if (!f) return false
  return f[0].has(at.minute) && f[1].has(at.hour) && f[2].has(at.day) && f[3].has(at.month) && f[4].has(at.weekday)
}

function validateCondition(c, field, add) {
  if (!isRec(c)) { add(field, 'invalid'); return null }
  unknownKeys(c, ['field', 'op', 'value'], field, add)
  const path = typeof c.field === 'string' ? c.field.trim() : ''
  if (!FIELD_PATH_RE.test(path) || !RULE_DATA_ROOTS.includes(path.split('.')[0])) add(`${field}.field`, 'invalid')
  if (!CONDITION_OPS.includes(c.op)) { add(`${field}.op`, 'invalid'); return null }
  if (c.op === 'exists') return { field: path, op: 'exists' }
  if (c.op === 'gt' || c.op === 'lt') {
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) add(`${field}.value`, 'invalid')
  } else if (!['string', 'number', 'boolean'].includes(typeof c.value) || (typeof c.value === 'string' && c.value.length > 200)) add(`${field}.value`, 'invalid')
  return { field: path, op: c.op, value: c.value }
}

/**
 * 規則 1 つ（§3.3）。trigger は event（manifest の事件）か cron のどちらか。when は all / any の条件（最大 10）。
 * action.input は操作の入力の名前 → 値（文字列の中の `{payload.x}` を差し込む）。mode：approval（既定）/ auto / propose-by-ai。
 * write を auto にできるのは、操作の autoRun.allowed（管理者が理由を書いて許した冪等な操作）のときだけ。
 * 個人情報の区分の高い操作（financial / sensitive / health）は allowPii: true が要る。
 * @param {object} ctx { connectors: 正規化した接続先の一覧, events?: 事件の名前の一覧（無ければ確かめない）, roles?: 役割の一覧 }
 */
export function validateRule(input, { connectors = [], events = null, roles = null } = {}) {
  const { errors, add } = collector()
  if (!isRec(input)) return { ok: false, rule: null, errors: [{ field: 'rule', code: 'invalid' }] }
  unknownKeys(input, ['id', 'name', 'enabled', 'trigger', 'when', 'action', 'mode', 'approvers', 'notify', 'allowPii'], '', add)
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) add('id', 'required')
  else if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) add('id', 'invalid')
  const name = readText(input, 'name', 'name', CONNECTOR_LIMITS.name, add, { required: true })
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') add('enabled', 'invalid')
  const trigger = {}
  const t = input.trigger
  if (!isRec(t)) add('trigger', 'required')
  else {
    unknownKeys(t, ['event', 'cron'], 'trigger', add)
    const hasEvent = t.event !== undefined && t.event !== null && t.event !== ''
    const hasCron = t.cron !== undefined && t.cron !== null && t.cron !== ''
    if (hasEvent === hasCron) add('trigger', 'invalid')
    if (hasEvent) {
      if (typeof t.event !== 'string' || !/^[a-z][a-z0-9_.]{0,80}$/.test(t.event)) add('trigger.event', 'invalid')
      else if (Array.isArray(events) && !events.includes(t.event)) add('trigger.event', 'unknown_event')
      else trigger.event = t.event
    }
    if (hasCron) {
      if (!parseCron(t.cron)) add('trigger.cron', 'invalid')
      else trigger.cron = t.cron.trim().split(/\s+/).join(' ')
    }
  }
  let when = null
  if (input.when !== undefined && input.when !== null) {
    if (!isRec(input.when)) add('when', 'invalid')
    else {
      unknownKeys(input.when, ['all', 'any'], 'when', add)
      when = {}
      let n = 0
      for (const k of ['all', 'any']) {
        if (input.when[k] === undefined) continue
        if (!Array.isArray(input.when[k])) { add(`when.${k}`, 'invalid'); continue }
        n += input.when[k].length
        when[k] = input.when[k].map((c, i) => validateCondition(c, `when.${k}[${i}]`, add)).filter(Boolean)
      }
      if (n > CONNECTOR_LIMITS.conditions) add('when', 'too_many')
      if (!n) when = null
    }
  }
  const mode = input.mode ?? 'approval'
  if (!RULE_MODES.includes(mode)) add('mode', 'invalid')
  const action = { connector: '', operation: '', input: {} }
  let op = null
  const a = input.action
  if (!isRec(a)) add('action', 'required')
  else {
    unknownKeys(a, ['connector', 'operation', 'input'], 'action', add)
    const c = connectors.find((x) => x.id === a.connector)
    if (!c) add('action.connector', 'unknown_connector')
    else {
      action.connector = c.id
      op = c.operations.find((o) => o.id === a.operation) ?? null
      if (!op) add('action.operation', 'unknown_operation')
      else action.operation = op.id
    }
    const map = a.input ?? {}
    if (!isRec(map) || Object.keys(map).length > CONNECTOR_LIMITS.inputMap) add('action.input', 'invalid')
    else {
      for (const [k, v] of Object.entries(map)) {
        const f = `action.input.${k}`
        if (op && !op.input.properties[k]) { add(f, 'unknown_field'); continue }
        if (typeof v === 'string') {
          if (v.length > CONNECTOR_LIMITS.template) { add(f, 'too_long'); continue }
          const bad = [...v.matchAll(/\{([^}]*)\}/g)].some((m) => !FIELD_PATH_RE.test(m[1]) || !RULE_DATA_ROOTS.includes(m[1].split('.')[0]))
          if (bad) { add(f, 'invalid'); continue }
        } else if (!['number', 'boolean'].includes(typeof v)) { add(f, 'invalid'); continue }
        action.input[k] = v
      }
      if (op) for (const r of op.input.required) if (action.input[r] === undefined) add(`action.input.${r}`, 'required')
    }
  }
  let approvers = null
  if (input.approvers !== undefined && input.approvers !== null) {
    if (!isRec(input.approvers) || typeof input.approvers.role !== 'string' || !ROLE_RE.test(input.approvers.role)) add('approvers.role', 'invalid')
    else if (Array.isArray(roles) && !roles.includes(input.approvers.role)) add('approvers.role', 'unknown_role')
    else approvers = { role: input.approvers.role }
  }
  if (op) {
    const write = op.effect === 'write'
    if (mode === 'auto' && write && !op.autoRun.allowed) add('mode', 'auto_not_allowed')
    if ((mode === 'approval' || mode === 'propose-by-ai') && !approvers && (input.approvers === undefined || input.approvers === null)) add('approvers.role', 'required')
    if (CONNECTOR_PII_HIGH.includes(op.pii) && input.allowPii !== true) add('allowPii', 'pii_not_allowed')
  }
  const notify = { onSuccess: 'info', onFailure: 'action' }
  if (input.notify !== undefined && input.notify !== null) {
    if (!isRec(input.notify)) add('notify', 'invalid')
    else {
      unknownKeys(input.notify, ['onSuccess', 'onFailure'], 'notify', add)
      for (const k of ['onSuccess', 'onFailure']) {
        if (input.notify[k] === undefined) continue
        if (!RULE_NOTIFY.includes(input.notify[k])) add(`notify.${k}`, 'invalid'); else notify[k] = input.notify[k]
      }
    }
  }
  if (input.allowPii !== undefined && typeof input.allowPii !== 'boolean') add('allowPii', 'invalid')
  const rule = { id, name, enabled: input.enabled !== false, trigger, when, action, mode, approvers, notify, allowPii: input.allowPii === true }
  return errors.length ? { ok: false, rule: null, errors } : { ok: true, rule, errors: [] }
}

/** data の中の a.b.c（無ければ undefined）。 */
export function valueAt(data, path) {
  let v = data
  for (const k of String(path).split('.')) {
    if (!isRec(v) || !Object.hasOwn(v, k)) return undefined
    v = v[k]
  }
  return v
}

function holds(c, data) {
  const v = valueAt(data, c.field)
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null && v !== ''
    case 'eq': return v === c.value || (['string', 'number'].includes(typeof v) && ['string', 'number'].includes(typeof c.value) && String(v) === String(c.value))
    case 'contains': return typeof v === 'string' ? v.includes(String(c.value)) : Array.isArray(v) ? v.some((x) => x === c.value || String(x) === String(c.value)) : false
    case 'gt': return v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > c.value
    case 'lt': return v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) < c.value
    default: return false
  }
}

/** 規則の条件（正規化した when、null = 常に真）が data（{ event, payload, now }）で成り立つか。 */
export function evaluateWhen(when, data) {
  if (!when) return true
  const all = when.all ?? []
  const any = when.any ?? []
  return all.every((c) => holds(c, data)) && (!any.length || any.some((c) => holds(c, data)))
}

/** 規則の action.input に data を差し込む：値が `{x.y}` だけなら元の型のまま、文の中の `{x.y}` は文字（無い値は空）。 */
export function renderRuleInput(map, data) {
  const out = {}
  for (const [k, v] of Object.entries(map ?? {})) {
    if (typeof v !== 'string') { out[k] = v; continue }
    const whole = WHOLE_TEMPLATE_RE.exec(v)
    if (whole) { const x = valueAt(data, whole[1]); if (x !== undefined && x !== null) out[k] = x; continue }
    out[k] = v.replace(TEMPLATE_RE, (_, p) => { const x = valueAt(data, p); return x === undefined || x === null || typeof x === 'object' ? '' : String(x) })
  }
  return out
}

/** 操作の入力の検査（JSON Schema）。→ { ok, errors: [{ field, code }] }（値は返さない）。 */
export function checkOperationInput(operation, input) {
  if (!isRec(input)) return { ok: false, errors: [{ field: 'input', code: 'invalid' }] }
  const r = validateSchema(operation.input, input)
  if (r.valid) return { ok: true, errors: [] }
  return { ok: false, errors: r.errors.map((e) => ({ field: `input${e.path.replaceAll('/', '.')}`, code: e.keyword === 'required' ? 'required' : e.keyword === 'additionalProperties' ? 'unknown_field' : 'invalid' })) }
}

/**
 * 操作 → 送る要求：{ method, path（差し込み済み・エンコード済み）, query, body }。path の変数以外は GET / DELETE なら query、他は JSON の本文。
 */
export function buildOperationRequest(operation, input = {}) {
  const used = new Set()
  const path = operation.path.replace(PATH_VAR_RE, (_, name) => { used.add(name); return encodeURIComponent(String(input[name] ?? '')) })
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !used.has(k) && v !== undefined && v !== null))
  const inQuery = operation.method === 'GET' || operation.method === 'DELETE'
  return { method: operation.method, path, query: inQuery ? rest : {}, body: inQuery ? null : rest }
}

function leaf(v) {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.length > CONNECTOR_LIMITS.responseString ? `${v.slice(0, CONNECTOR_LIMITS.responseString)}…` : v
  return undefined // objects / arrays at a leaf are never passed (name the leaves)
}

function pickInto(dst, src, segs) {
  const [head, ...rest] = segs
  const arr = head.endsWith('[]')
  const key = arr ? head.slice(0, -2) : head
  if (!isRec(src) || !Object.hasOwn(src, key)) return
  const v = src[key]
  if (arr) {
    if (!Array.isArray(v)) return
    if (!Array.isArray(dst[key])) dst[key] = []
    v.slice(0, CONNECTOR_LIMITS.responseItems).forEach((item, i) => {
      if (!rest.length) { const x = leaf(item); if (x !== undefined) dst[key][i] = x; return }
      if (!isRec(dst[key][i])) dst[key][i] = {}
      pickInto(dst[key][i], item, rest)
    })
    return
  }
  if (!rest.length) { const x = leaf(v); if (x !== undefined) dst[key] = x; return }
  if (!isRec(dst[key])) dst[key] = {}
  pickInto(dst[key], v, rest)
}

/** 応答のうち許可リストの項目だけ（葉は文字・数・真偽・null。配列は 100 件まで、文字は 500 字まで）。許可リストが空なら {}。 */
export function pickResponseFields(value, fields = []) {
  const out = {}
  for (const f of fields) pickInto(out, value, f.split('.'))
  return out
}

/** AI のツールの名前：`<namespace>_ext_<接続先>_<操作>`（- は _。64 字を超えるなら null）。 */
export function connectorToolName(namespace, connectorId, operationId) {
  const name = `${namespace}_ext_${connectorId}_${operationId}`.replace(/-/g, '_')
  return /^[a-z][a-z0-9_]{1,63}$/.test(name) ? name : null
}
