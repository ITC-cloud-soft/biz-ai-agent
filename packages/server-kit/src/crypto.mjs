// Tokens, hashes and passwords. Opaque tokens are shown once and stored only as SHA-256 hashes.
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
export const hmac = (key, value) => createHmac('sha256', key).update(String(value)).digest()

/** Token prefixes used by the kit (readable in logs, never secret themselves). */
export const TOKEN_PREFIX = Object.freeze({ delegation: 'bdg', ticket: 'btk', card: 'bcd' })

/** Opaque bearer-style token with a readable prefix. */
export const newToken = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`

export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

/** Constant-time comparison of two strings of any length (compares their hashes). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** scrypt password hash for apps that keep their own user table ("scrypt$<salt hex>$<key hex>"). */
export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scryptAsync(String(password), salt, 32)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false
  const key = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), 32)
  const expected = Buffer.from(keyHex, 'hex')
  return expected.length === key.length && timingSafeEqual(key, expected)
}

/** Hash that a verifyPassword() of a missing user can be run against (constant work: no user enumeration by timing). */
export const DUMMY_PASSWORD_HASH = 'scrypt$00$00'

/** Link codes are 6 digits: the stored hash is keyed so a leaked table alone does not reveal live codes. */
export const linkCodeHash = (key, code) => hmac(key, `link-code:${code}`).toString('hex')

/**
 * Approval card secrets are DERIVED from the delivery id with the server key: repeating the delivery request returns
 * the same token / reply code (idempotent for sendCard) while only the token hash is stored.
 */
export const cardToken = (key, deliveryId) => `${TOKEN_PREFIX.card}_${hmac(key, `card-token:${deliveryId}`).toString('base64url')}`
export const cardReplyCode = (key, deliveryId) => String(hmac(key, `card-code:${deliveryId}`).readUInt32BE(0) % 1_000_000).padStart(6, '0')

/** A fresh 32-byte server key (hex) for a new store. */
export const newServerKey = () => randomBytes(32).toString('hex')
