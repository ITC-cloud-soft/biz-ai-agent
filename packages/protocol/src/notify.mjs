// IM notification checks (invariant 4): template parameters are typed numbers / times; links carry no personal data.
import { findPiiInString, isPiiLikeKey, probeHits } from './pii.mjs'

const TYPE_CHECKS = {
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  flag: (v) => v === 0 || v === 1,
  time: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  monthday: (v) => typeof v === 'string' && /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/.test(v),
  month: (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  datetime: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v),
}
const SAFE_STRING = /^[0-9A-Za-z:./+_-]{1,64}$/

/**
 * checkNotificationParams(template, params, { manifest, probes }) -> { ok, problems: [{ param?, code, message }] }
 * With a manifest the template must be declared and every parameter must be declared with a matching type
 * (required ones present). Without one, values must be numbers / booleans or short [0-9A-Za-z:./+_-] strings.
 * Always: no value looks like personal data (pii.mjs) and no probe string (a seeded person's name) appears.
 */
export function checkNotificationParams(template, params, { manifest = null, probes = [] } = {}) {
  const problems = []
  const bad = (code, message, param) => problems.push({ code, message, ...(param ? { param } : {}) })
  if (typeof template !== 'string' || !template) bad('template', 'template must be a non-empty string')
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    bad('params', 'params must be an object')
    return { ok: false, problems }
  }
  const declared = manifest?.templates?.[template]?.params ?? null
  if (manifest?.templates && !declared) bad('undeclared_template', `template "${template}" is not declared in the manifest`)
  for (const [k, v] of Object.entries(params)) {
    if (isPiiLikeKey(k)) bad('pii_like_key', `parameter name "${k}" looks like personal data or free text`, k)
    if (typeof v === 'string') {
      for (const f of findPiiInString(v)) bad(`pii_value.${f.kind}`, `parameter "${k}" looks like personal data (${f.kind})`, k)
      if (probeHits(v, probes)) bad('probe', `parameter "${k}" contains a known personal string`, k)
    } else if (typeof v !== 'number' && typeof v !== 'boolean') bad('param_type', `parameter "${k}" must be a number, boolean or short string`, k)
    if (declared) {
      const spec = declared[k]
      if (!spec) bad('undeclared_param', `parameter "${k}" is not declared for template "${template}"`, k)
      else if (!TYPE_CHECKS[spec.type]?.(v)) bad('param_type', `parameter "${k}" must be of type ${spec.type}`, k)
    } else if (typeof v === 'string' && !SAFE_STRING.test(v)) bad('param_charset', `parameter "${k}" has characters outside [0-9A-Za-z:./+_-]`, k)
  }
  if (declared) {
    for (const [k, spec] of Object.entries(declared)) if (!spec.optional && !(k in params)) bad('missing_param', `required parameter "${k}" is missing`, k)
  }
  return { ok: problems.length === 0, problems }
}

/** Links point to the business web: relative path or http(s) URL, no credentials, no personal data in the query. */
export function checkNotificationLink(link, { probes = [] } = {}) {
  const problems = []
  if (link === undefined || link === null || link === '') return { ok: true, problems }
  if (typeof link !== 'string' || link.length > 500) return { ok: false, problems: [{ code: 'link', message: 'link must be a string of at most 500 characters' }] }
  let url
  try { url = new URL(link, 'https://business.invalid') } catch { return { ok: false, problems: [{ code: 'link', message: 'link is not a URL' }] } }
  if (!/^https?:$/.test(url.protocol)) problems.push({ code: 'link_scheme', message: 'link must be http(s) or a relative path' })
  if (url.username || url.password) problems.push({ code: 'link_credentials', message: 'link must not contain credentials' })
  const text = decodeURIComponent(`${url.pathname}${url.search}`)
  for (const f of findPiiInString(text, { allow: ['long_digit_run'] })) problems.push({ code: `link_pii.${f.kind}`, message: `link looks to contain personal data (${f.kind})` })
  if (probeHits(text, probes)) problems.push({ code: 'link_probe', message: 'link contains a known personal string' })
  return { ok: problems.length === 0, problems }
}
