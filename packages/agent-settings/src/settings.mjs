// The settings document (agent-settings.json in the data directory): defaults, strict validation of a change, the public view.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { keyStatus, seal } from './secrets.mjs'

export const MODES = Object.freeze(['bm25f', 'rag', 'graph'])
export const KINDS = Object.freeze(['openai', 'azure-openai'])
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/
const ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/

export class SettingsError extends Error {
  constructor(code, message = code) { super(message); this.code = code; this.status = 400 }
}

export function defaultSettings({ adminRoles = ['admin'] } = {}) {
  const model = () => ({ kind: 'openai', baseUrl: '', model: '', apiKeyEnv: '', apiKey: null })
  return {
    version: 1,
    llm: { base: model(), embedding: { enabled: false, ...model(), dimensions: null } },
    knowledge: { mode: 'bm25f' },
    sns: { requireApproval: true, approverRoles: [...adminRoles], reportRoles: [...adminRoles], reportOn: { rebuilt: true, failures: true } },
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function keys(o, allowed, where) {
  if (!isObj(o)) throw new SettingsError('invalid_settings', `${where}: an object is required`)
  const bad = Object.keys(o).filter((k) => !allowed.includes(k))
  if (bad.length) throw new SettingsError('invalid_settings', `${where}: unknown key(s) ${bad.join(', ')}`)
}
function url(v, where) {
  if (v === '') return ''
  let u
  try { u = new URL(String(v)) } catch { throw new SettingsError('invalid_url', `${where}: not a URL`) }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new SettingsError('invalid_url', `${where}: http(s) only, no credentials in the URL`)
  return u.toString().replace(/\/+$/, '')
}
function roleList(v, roles, where) {
  if (!Array.isArray(v) || !v.length || v.some((r) => !roles.includes(r))) throw new SettingsError('invalid_roles', `${where}: one or more declared roles`)
  return [...new Set(v)]
}

function applyModel(cur, patch, where, { masterKey, embedding = false }) {
  keys(patch, ['kind', 'baseUrl', 'model', 'apiKeyEnv', 'apiKey', ...(embedding ? ['enabled', 'dimensions'] : [])], where)
  const out = { ...cur }
  if (patch.kind !== undefined) { if (!KINDS.includes(patch.kind)) throw new SettingsError('invalid_kind', `${where}.kind`); out.kind = patch.kind }
  if (patch.baseUrl !== undefined) out.baseUrl = url(patch.baseUrl, `${where}.baseUrl`)
  if (patch.model !== undefined) { if (patch.model !== '' && !MODEL_RE.test(String(patch.model))) throw new SettingsError('invalid_model', `${where}.model`); out.model = String(patch.model) }
  if (patch.apiKeyEnv !== undefined) { if (patch.apiKeyEnv !== '' && !ENV_RE.test(String(patch.apiKeyEnv))) throw new SettingsError('invalid_env_name', `${where}.apiKeyEnv: an environment variable NAME like AZURE_OPENAI_KEY`); out.apiKeyEnv = String(patch.apiKeyEnv) }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === '' || patch.apiKey === null) out.apiKey = null
    else {
      if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 400 || /\s/.test(patch.apiKey)) throw new SettingsError('invalid_key', `${where}.apiKey`)
      if (!masterKey) throw new SettingsError('key_storage_disabled', `${where}.apiKey: set AGENT_SETTINGS_KEY to store keys, or give an environment variable name`)
      out.apiKey = seal(masterKey, patch.apiKey)
    }
  }
  if (embedding) {
    if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw new SettingsError('invalid_settings', `${where}.enabled`); out.enabled = patch.enabled }
    if (patch.dimensions !== undefined) {
      if (patch.dimensions !== null && (!Number.isInteger(patch.dimensions) || patch.dimensions < 1 || patch.dimensions > 8192)) throw new SettingsError('invalid_settings', `${where}.dimensions`)
      out.dimensions = patch.dimensions
    }
  }
  return out
}

/** current + a change (PUT body) → the new settings. Throws SettingsError (400). */
export function applySettingsPatch(current, patch, { roles, masterKey = null } = {}) {
  keys(patch, ['llm', 'knowledge', 'sns'], 'settings')
  const next = structuredClone(current)
  if (patch.llm !== undefined) {
    keys(patch.llm, ['base', 'embedding'], 'llm')
    if (patch.llm.base !== undefined) next.llm.base = applyModel(next.llm.base, patch.llm.base, 'llm.base', { masterKey })
    if (patch.llm.embedding !== undefined) next.llm.embedding = applyModel(next.llm.embedding, patch.llm.embedding, 'llm.embedding', { masterKey, embedding: true })
  }
  if (patch.knowledge !== undefined) {
    keys(patch.knowledge, ['mode'], 'knowledge')
    if (patch.knowledge.mode !== undefined) { if (!MODES.includes(patch.knowledge.mode)) throw new SettingsError('invalid_mode', 'knowledge.mode: bm25f | rag | graph'); next.knowledge.mode = patch.knowledge.mode }
  }
  if (patch.sns !== undefined) {
    keys(patch.sns, ['requireApproval', 'approverRoles', 'reportRoles', 'reportOn'], 'sns')
    if (patch.sns.requireApproval !== undefined) { if (typeof patch.sns.requireApproval !== 'boolean') throw new SettingsError('invalid_settings', 'sns.requireApproval'); next.sns.requireApproval = patch.sns.requireApproval }
    if (patch.sns.approverRoles !== undefined) next.sns.approverRoles = roleList(patch.sns.approverRoles, roles, 'sns.approverRoles')
    if (patch.sns.reportRoles !== undefined) next.sns.reportRoles = roleList(patch.sns.reportRoles, roles, 'sns.reportRoles')
    if (patch.sns.reportOn !== undefined) {
      keys(patch.sns.reportOn, ['rebuilt', 'failures'], 'sns.reportOn')
      for (const [k, v] of Object.entries(patch.sns.reportOn)) { if (typeof v !== 'boolean') throw new SettingsError('invalid_settings', `sns.reportOn.${k}`); next.sns.reportOn[k] = v }
    }
  }
  if (next.knowledge.mode === 'rag' && patch.knowledge?.mode === 'rag' && !next.llm.embedding.enabled) throw new SettingsError('embedding_required', 'knowledge.mode rag needs an embedding model (llm.embedding.enabled)')
  return next
}

/** What GET /api/agent/settings shows: everything but the keys (their status instead). */
export function publicSettings(s, { env, masterKey } = {}) {
  const model = (m) => {
    const { apiKey: _hidden, ...rest } = m
    return { ...rest, key: keyStatus(m, { env, masterKey }) }
  }
  return { ...s, llm: { base: model(s.llm.base), embedding: model(s.llm.embedding) }, keyStorage: Boolean(masterKey) }
}

export function loadSettings(file, defaults) {
  if (!existsSync(file)) return structuredClone(defaults)
  const s = JSON.parse(readFileSync(file, 'utf8'))
  return { ...structuredClone(defaults), ...s, llm: { ...defaults.llm, ...s.llm }, knowledge: { ...defaults.knowledge, ...s.knowledge }, sns: { ...defaults.sns, ...s.sns } }
}

/** Atomic write (temp file + rename). */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}
