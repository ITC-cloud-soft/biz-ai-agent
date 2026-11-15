// API keys of the settings: an ENVIRONMENT VARIABLE NAME (recommended; the value lives in the environment / secret store), or a key
// typed on the settings screen, stored sealed with AES-256-GCM under the master key AGENT_SETTINGS_KEY (32 bytes, hex or base64).
// Without a master key no key can be stored (only variable names). A key is never returned by the API (only set / source / hint).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const MASTER_KEY_ENV = 'AGENT_SETTINGS_KEY'

export function masterKeyFrom(env = process.env) {
  const raw = env?.[MASTER_KEY_ENV]
  if (!raw) return null
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) throw new Error(`${MASTER_KEY_ENV} must be 32 bytes (64 hex characters or base64)`)
  return buf
}

export function seal(masterKey, plain) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', masterKey, iv)
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

export function unseal(masterKey, sealed) {
  if (!masterKey || typeof sealed !== 'string' || !sealed.startsWith('v1:')) return null
  const buf = Buffer.from(sealed.slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', masterKey, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

/** The key of one model setting: the environment variable first, then the stored (sealed) key. */
export function resolveKey(cfg, { env = process.env, masterKey = null } = {}) {
  if (cfg?.apiKeyEnv && env?.[cfg.apiKeyEnv]) return env[cfg.apiKeyEnv]
  if (cfg?.apiKey) {
    try { return unseal(masterKey, cfg.apiKey) } catch { return null }
  }
  return null
}

/** What the API shows about a key: never the key. */
export function keyStatus(cfg, { env = process.env, masterKey = null } = {}) {
  if (cfg?.apiKeyEnv && env?.[cfg.apiKeyEnv]) return { set: true, source: 'env', hint: null }
  if (cfg?.apiKey) {
    let plain = null
    try { plain = unseal(masterKey, cfg.apiKey) } catch { plain = null }
    return plain ? { set: true, source: 'stored', hint: `…${plain.slice(-4)}` } : { set: false, source: 'stored', hint: null, error: 'cannot_unseal' }
  }
  return { set: false, source: null, hint: null }
}
