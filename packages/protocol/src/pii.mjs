// "Looks like personal information" heuristics used by the validators and the conformance suite.
// They are a defence in depth for events and IM notification parameters (invariant 4), NOT a PII scanner:
// the primary protection is that events / templates only ever carry IDs, dates, counts and status values.
// Findings never echo the matched text (they are logged in CI output).

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const ISO_RE = /\b\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\b/g

const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['phone', /(?:\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})|(?<!\d)0\d{1,4}[-(（]\d{1,4}[-)）]\d{3,4}(?!\d)|(?<!\d)0[5789]0\d{8}(?!\d)|(?<!\d)\+?\d{1,3}[-.\s]\(?\d{2,4}\)?[-.\s]\d{3,4}[-.\s]\d{3,4}(?!\d)/],
  ['postal_code', /(?:〒|郵便番号)\s?:?\s?\d{3}-?\d{4}/],
  ['id_number', /(?:被保険者番号|保険者番号|保険証|マイナンバー|個人番号|口座番号|口座)\D{0,10}\d{4,12}/],
  ['long_digit_run', /(?<!\d)\d{10,}(?!\d)/],
  ['spaced_digit_run', /(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)/],
  ['cjk_text', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['free_text', /[A-Za-z]{2,}\s+[A-Za-z]{2,}/],
]

/** Words of a camelCase / snake_case key. */
const words = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().split(' ').filter(Boolean)

// payload key vocabulary that signals personal data / free text (an `...Id` key is an identifier and is fine)
const PII_KEY_WORDS = new Set(['name', 'kana', 'email', 'mail', 'phone', 'tel', 'address', 'birth', 'birthday', 'memo', 'comment', 'body', 'text',
  'note', 'diagnosis', 'vital', 'vitals', 'password', 'secret', 'token', 'reason', 'content', 'freetext', 'description', 'title'])

/** True when an event payload / template param NAME suggests personal data or free text. */
export function isPiiLikeKey(key) {
  const w = words(key)
  if (!w.length) return false
  const last = w[w.length - 1]
  if (last === 'id' || last === 'ids') return false
  return w.some((x) => PII_KEY_WORDS.has(x))
}

const normalize = (s) => String(s).normalize('NFKC')

/**
 * Findings for one string: [{ kind, length }]. UUIDs and ISO dates / timestamps are ignored.
 * `allow` lists finding kinds to skip (e.g. ['cjk_text'] for a system whose enum values are Japanese).
 */
export function findPiiInString(value, { allow = [] } = {}) {
  if (typeof value !== 'string' || value === '') return []
  const text = normalize(value).replace(UUID_RE, ' ').replace(ISO_RE, ' ')
  const out = []
  for (const [kind, re] of PATTERNS) {
    if (allow.includes(kind)) continue
    if (re.test(text)) out.push({ kind, length: value.length })
  }
  return out
}

/** Exact probe strings (names of seeded test persons, ...) found in a string: returns the number of hits. */
export function probeHits(value, probes = []) {
  if (!probes.length || typeof value !== 'string') return 0
  const hay = normalize(value).replace(/\s+/g, '').toLowerCase()
  let n = 0
  for (const p of probes) {
    const needle = normalize(p).replace(/\s+/g, '').toLowerCase()
    if (needle.length >= 2 && hay.includes(needle)) n += 1
  }
  return n
}

/**
 * Walks any JSON value and returns findings with their path:
 * [{ path, kind }] where kind is a heuristic name, 'probe' or 'pii_like_key'.
 */
export function scanJson(value, { probes = [], allow = [], checkKeys = false, path = '' } = {}) {
  const out = []
  const walk = (v, p) => {
    if (typeof v === 'string') {
      for (const f of findPiiInString(v, { allow })) out.push({ path: p || '/', kind: f.kind })
      if (probeHits(v, probes)) out.push({ path: p || '/', kind: 'probe' })
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}/${i}`))
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (checkKeys && isPiiLikeKey(k)) out.push({ path: `${p}/${k}`, kind: 'pii_like_key' })
        if (probes.length && probeHits(k, probes)) out.push({ path: `${p}/${k}`, kind: 'probe' })
        walk(x, `${p}/${k}`)
      }
    }
  }
  walk(value, path)
  return out
}
