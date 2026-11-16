// The secrets of external connectors (docs/AI_EMPLOYEE_PROFILE.md §3.1, §3.4): API keys, passwords, client secrets.
// Kept by the business system only, encrypted at rest (AES-256-GCM, the connector id as additional data so a sealed value
// cannot be moved to another connector). The screen shows the last 4 characters only; DSH, the AI and the logs never see them.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** Which secret fields an auth type needs (the screen asks for exactly these). */
export const SECRET_FIELDS = Object.freeze({ none: [], api_key: ['token'], bearer: ['token'], basic: ['password'], oauth2_client: ['clientSecret'] })
export const SECRET_MAX = 4096

/**
 * A 32-byte key from the operator's key material (an environment variable of 32+ characters, or 32+ bytes): HKDF-SHA-256 with a
 * fixed label, so the same material gives the same key and other uses of the material get other keys.
 */
export function connectorSecretKey(material) {
  const raw = Buffer.isBuffer(material) ? material : Buffer.from(String(material ?? ''), 'utf8')
  if (raw.length < 32) throw new TypeError('connectorSecretKey: the key material must be at least 32 bytes / characters')
  return Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'dsh-bridge/connector-secret/v1', 32))
}

/** Seals a secret object ({ token } / { password } / { clientSecret }) for one connector → 'v1.<iv>.<tag>.<ciphertext>' (base64url). */
export function sealSecret(key, connectorId, secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`connector:${connectorId}`))
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/** Opens a sealed secret (null when it is not one of ours, was moved to another connector or the key changed). */
export function openSecret(key, connectorId, sealed) {
  const parts = typeof sealed === 'string' ? sealed.split('.') : []
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'))
    decipher.setAAD(Buffer.from(`connector:${connectorId}`))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
    const text = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** The hint shown on the screen: the last 4 characters of the main secret value (shorter than 8: nothing). */
export function secretHint(secret) {
  const v = Object.values(secret ?? {}).find((x) => typeof x === 'string' && x) ?? ''
  return v.length >= 8 ? `…${v.slice(-4)}` : '…'
}

/**
 * Checks the secret entered for an auth type → { ok, secret, errors: [{ field, code }] } (never the value).
 * Only the fields of SECRET_FIELDS[authType]; each a non-empty string of at most 4096 characters, no line breaks.
 */
export function checkSecret(authType, input) {
  const fields = SECRET_FIELDS[authType]
  if (!fields) return { ok: false, secret: null, errors: [{ field: 'auth.type', code: 'invalid' }] }
  if (!fields.length) return { ok: false, secret: null, errors: [{ field: 'secret', code: 'not_needed' }] }
  const errors = []
  const isRec = input && typeof input === 'object' && !Array.isArray(input)
  if (!isRec) return { ok: false, secret: null, errors: [{ field: 'secret', code: 'invalid' }] }
  for (const k of Object.keys(input)) if (!fields.includes(k)) errors.push({ field: `secret.${k}`, code: 'unknown_field' })
  const secret = {}
  for (const f of fields) {
    const v = input[f]
    if (typeof v !== 'string' || !v.trim()) errors.push({ field: `secret.${f}`, code: 'required' })
    else if (v.length > SECRET_MAX || /[\r\n]/.test(v)) errors.push({ field: `secret.${f}`, code: 'invalid' })
    else secret[f] = v.trim()
  }
  return errors.length ? { ok: false, secret: null, errors } : { ok: true, secret, errors: [] }
}
