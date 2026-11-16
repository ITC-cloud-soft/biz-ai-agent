// Masking: what may reach a log line (RSI_SELF_IMPROVING_SYSTEM.md §5.1, care-ai-native docs/design/LOGGING_MONITORING_RSI.md §5).
// Two layers: (1) keys that name personal or secret data are replaced whatever their value; (2) values shaped like
// personal or secret data (e-mail, phone, long digit runs, bearer tokens, JWTs, ?token=) are replaced whatever their key.
// Names cannot be recognised by shape: callers must pass IDs and counts, never free text (rule 1 of the design).
// Changing these lists is change class A2 (a human decides; an agent may only propose).

export const MASK = '[masked]'
export const MASK_RULES_VERSION = 1

/** Keys (lower-cased, '-' → '_') whose values are never logged. A key matches if it equals or ends with `_<one of these>`. */
export const SENSITIVE_KEYS = Object.freeze([
  'name', 'display_name', 'full_name', 'first_name', 'last_name', 'kana', 'name_kana', 'furigana',
  'address', 'addr', 'postal_code', 'zip', 'phone', 'tel', 'mobile', 'fax', 'email', 'mail',
  'birthday', 'birth_date', 'dob', 'gender',
  'body', 'note', 'notes', 'text', 'content', 'memo', 'comment', 'message_text', 'description', 'reason_text', 'summary',
  'password', 'passwd', 'pass', 'secret', 'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey',
  'authorization', 'cookie', 'set_cookie', 'session', 'otp', 'code_verifier', 'private_key',
  'account_number', 'account_no', 'bank_account', 'card_number', 'iban',
  'insured_number', 'insurer_number', 'my_number', 'mynumber', 'individual_number',
])

const KEY_SET = new Set(SENSITIVE_KEYS)
/** Keys that look sensitive by suffix but are identifiers, codes or counters. */
const SAFE_KEYS = new Set(['event', 'kind', 'level', 'route', 'method', 'status', 'code', 'error_code', 'reason', 'role', 'channel', 'service'])

export function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/-/g, '_')
  if (SAFE_KEYS.has(k) || k.endsWith('_id') || k.endsWith('_count') || k.endsWith('_ms') || k.endsWith('_bytes') || k.endsWith('_length')) return false
  if (KEY_SET.has(k)) return true
  for (const s of KEY_SET) if (k.endsWith(`_${s}`)) return true
  return false
}

// value shapes (the most specific first)
const PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [masked]'],
  [/([?&](?:token|code|key|secret|password|sig|signature)=)[^&#\s]+/gi, '$1[masked]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![\w-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\w-])/g, '[phone]'],
  [/(?<![\w-])\+\d[\d -]{8,}\d(?![\w-])/g, '[phone]'],
  [/(?<![\w-])\d{7,}(?![\w-])/g, '[digits]'],
]

/** Mask one string value. Returns { value, masked }. Long strings are cut at `max` characters. */
export function maskString(input, { max = 200 } = {}) {
  let value = String(input)
  const before = value
  for (const [re, rep] of PATTERNS) value = value.replace(re, rep)
  const masked = value !== before
  if (value.length > max) value = `${value.slice(0, max)}…`
  return { value, masked }
}

/**
 * Mask a free-form message (an Error message, a legacy console line): value shapes as above, and anything quoted
 * ("…", '…', 「…」, and PostgreSQL's `Key (col)=(value)`) is dropped, because databases quote the offending value.
 */
export function maskMessage(input, { max = 300 } = {}) {
  let s = String(input ?? '')
  const before = s
  s = s.replace(/\)=\([^)]*\)/g, ')=(…)')
    .replace(/"[^"\n]{1,200}"/g, '"…"')
    .replace(/(^|[\s(:=,])'[^'\n]{1,200}'/g, '$1\'…\'')
    .replace(/「[^」\n]{1,200}」/g, '「…」')
  const r = maskString(s, { max })
  return { value: r.value, masked: r.masked || s !== before }
}

/**
 * Mask an attrs object for a log line. Allowed: strings (masked, cut), finite numbers, booleans, null, dates, arrays
 * (≤ 20 items) and plain objects (≤ 3 levels, ≤ 40 keys). Anything else (functions, Buffers, Errors, class instances)
 * becomes its type name. Returns { value, masked }.
 */
export function maskAttrs(attrs, { depth = 3 } = {}) {
  let masked = false
  const walk = (v, d, key) => {
    if (key !== undefined && isSensitiveKey(key) && v !== null && v !== undefined && v !== '') { masked = true; return MASK }
    if (v === null || v === undefined) return null
    if (typeof v === 'string') { const r = maskString(v); if (r.masked) masked = true; return r.value }
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
    if (typeof v === 'boolean') return v
    if (typeof v === 'bigint') return String(v)
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
    if (d <= 0) return '[depth]'
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, d - 1))
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return `[${v.constructor?.name ?? 'object'}]`
      const out = {}
      for (const k of Object.keys(v).slice(0, 40)) out[k] = walk(v[k], d - 1, k)
      return out
    }
    return `[${typeof v}]`
  }
  const value = attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? walk(attrs, depth) : {}
  return { value, masked }
}

/** A path with its values removed (UUIDs → :id, numbers → :n, long or odd segments → :x), for when no route template is known. */
export function maskPath(pathname) {
  return String(pathname || '/').split('/').map((seg) => {
    if (!seg) return seg
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id'
    if (/^\d+$/.test(seg)) return ':n'
    if (seg.length > 24 || /[^A-Za-z0-9._-]/.test(seg)) return ':x'
    return seg
  }).join('/')
}
