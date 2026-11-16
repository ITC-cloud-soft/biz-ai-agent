// A small JSON Schema validator (zero dependencies) covering the draft 2020-12 subset the Bridge schemas use:
//   $ref (local "#/..." pointers, $defs / definitions), type, enum, const, properties, patternProperties,
//   additionalProperties, required, minProperties, maxProperties, propertyNames, dependentRequired, items,
//   prefixItems, minItems, maxItems, uniqueItems, contains, minLength, maxLength, pattern, format (date, date-time,
//   hhmm, cron5, identifier), minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
//   allOf, anyOf, oneOf, not, if / then / else.
// Annotations (title, description, examples, default, $comment, $schema, $id, x-*) are ignored.
// Keywords that need annotation tracking (unevaluated*, $dynamicRef, $anchor) are rejected loudly instead of ignored.

const UNSUPPORTED = ['unevaluatedProperties', 'unevaluatedItems', '$dynamicRef', '$dynamicAnchor', '$anchor', 'contentSchema', 'dependentSchemas']

const FORMATS = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  hhmm: (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s),
  // 5-field cron (minute hour day-of-month month day-of-week); steps / ranges / lists, no names
  cron5: (s) => /^\S+( \S+){4}$/.test(s) && s.split(' ').every((f) => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(f)),
  identifier: (s) => /^[a-z][a-z0-9_]*$/.test(s),
}

const regexCache = new Map()
const regex = (p) => {
  let r = regexCache.get(p)
  if (!r) { r = new RegExp(p, 'u'); regexCache.set(p, r) }
  return r
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t || (t === 'object' && typeOf(v) === 'object'))

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
}

const pointer = (path) => (path.length ? `/${path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '')

export function resolveRef(root, ref) {
  if (!ref.startsWith('#')) throw new Error(`only local $ref values are supported: ${ref}`)
  let node = root
  const parts = ref.slice(1).split('/').filter((x, i) => i > 0 || x !== '')
  for (const raw of parts) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object' || !(key in node)) throw new Error(`unresolvable $ref: ${ref}`)
    node = node[key]
  }
  return node
}

/**
 * Validates `data` against `schema`.
 * @returns {{ valid: boolean, errors: Array<{ path: string, keyword: string, message: string }> }}
 */
export function validateSchema(schema, data, { root = schema, maxErrors = 200 } = {}) {
  const errors = []

  // check(schema, value, path, sink) returns true when valid; failures go to `sink` (an array of errors)
  function check(sch, value, path, sink) {
    if (sch === true || sch === undefined) return true
    if (sch === false) { sink.push({ path: pointer(path), keyword: 'false', message: 'is not allowed' }); return false }
    if (sch === null || typeof sch !== 'object') throw new Error(`invalid schema at ${pointer(path) || '/'}`)
    for (const k of UNSUPPORTED) if (k in sch) throw new Error(`unsupported JSON Schema keyword: ${k}`)
    const before = sink.length
    const fail = (keyword, message, p = path) => { sink.push({ path: pointer(p), keyword, message }) }

    if (sch.$ref !== undefined) {
      const target = resolveRef(root, sch.$ref)
      check(target, value, path, sink)
    }
    if (sch.type !== undefined) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type]
      if (!types.some((t) => isType(value, t))) {
        fail('type', `must be ${types.join(' or ')} (got ${typeOf(value)})`)
        return false // the remaining keywords are meaningless for the wrong type
      }
    }
    if (sch.enum !== undefined && !sch.enum.some((e) => deepEqual(e, value))) fail('enum', `must be one of: ${sch.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    if (sch.const !== undefined && !deepEqual(sch.const, value)) fail('const', `must be ${JSON.stringify(sch.const)}`)

    if (typeof value === 'string') {
      const len = [...value].length
      if (sch.minLength !== undefined && len < sch.minLength) fail('minLength', `must be at least ${sch.minLength} characters`)
      if (sch.maxLength !== undefined && len > sch.maxLength) fail('maxLength', `must be at most ${sch.maxLength} characters`)
      if (sch.pattern !== undefined && !regex(sch.pattern).test(value)) fail('pattern', `must match ${sch.pattern}`)
      if (sch.format !== undefined && FORMATS[sch.format] && !FORMATS[sch.format](value)) fail('format', `must be a valid ${sch.format}`)
    }
    if (typeof value === 'number') {
      if (sch.minimum !== undefined && value < sch.minimum) fail('minimum', `must be >= ${sch.minimum}`)
      if (sch.maximum !== undefined && value > sch.maximum) fail('maximum', `must be <= ${sch.maximum}`)
      if (sch.exclusiveMinimum !== undefined && value <= sch.exclusiveMinimum) fail('exclusiveMinimum', `must be > ${sch.exclusiveMinimum}`)
      if (sch.exclusiveMaximum !== undefined && value >= sch.exclusiveMaximum) fail('exclusiveMaximum', `must be < ${sch.exclusiveMaximum}`)
      if (sch.multipleOf !== undefined && Math.abs(value / sch.multipleOf - Math.round(value / sch.multipleOf)) > 1e-9) fail('multipleOf', `must be a multiple of ${sch.multipleOf}`)
    }
    if (Array.isArray(value)) {
      if (sch.minItems !== undefined && value.length < sch.minItems) fail('minItems', `must have at least ${sch.minItems} items`)
      if (sch.maxItems !== undefined && value.length > sch.maxItems) fail('maxItems', `must have at most ${sch.maxItems} items`)
      if (sch.uniqueItems) {
        for (let i = 0; i < value.length; i += 1) {
          const dup = value.findIndex((x, j) => j < i && deepEqual(x, value[i]))
          if (dup >= 0) { fail('uniqueItems', `items ${dup} and ${i} are duplicates`, [...path, i]); break }
        }
      }
      let start = 0
      if (Array.isArray(sch.prefixItems)) {
        sch.prefixItems.forEach((s, i) => { if (i < value.length) check(s, value[i], [...path, i], sink) })
        start = sch.prefixItems.length
      }
      if (sch.items !== undefined) for (let i = start; i < value.length; i += 1) check(sch.items, value[i], [...path, i], sink)
      if (sch.contains !== undefined && !value.some((x) => check(sch.contains, x, path, []))) fail('contains', 'must contain at least one matching item')
    }
    if (typeOf(value) === 'object') {
      const keys = Object.keys(value)
      if (sch.minProperties !== undefined && keys.length < sch.minProperties) fail('minProperties', `must have at least ${sch.minProperties} properties`)
      if (sch.maxProperties !== undefined && keys.length > sch.maxProperties) fail('maxProperties', `must have at most ${sch.maxProperties} properties`)
      for (const r of sch.required ?? []) if (!(r in value)) fail('required', `is missing required property "${r}"`)
      if (sch.dependentRequired) {
        for (const [k, deps] of Object.entries(sch.dependentRequired)) {
          if (k in value) for (const d of deps) if (!(d in value)) fail('dependentRequired', `"${k}" requires "${d}"`)
        }
      }
      if (sch.propertyNames !== undefined) {
        for (const k of keys) {
          const sub = []
          if (!check(sch.propertyNames, k, path, sub)) fail('propertyNames', `property name "${k}" is invalid: ${sub.map((e) => e.message).join('; ')}`, [...path, k])
        }
      }
      const patterns = sch.patternProperties ? Object.entries(sch.patternProperties) : []
      for (const k of keys) {
        let matched = false
        if (sch.properties && Object.prototype.hasOwnProperty.call(sch.properties, k)) { matched = true; check(sch.properties[k], value[k], [...path, k], sink) }
        for (const [p, s] of patterns) if (regex(p).test(k)) { matched = true; check(s, value[k], [...path, k], sink) }
        if (!matched && sch.additionalProperties !== undefined) {
          if (sch.additionalProperties === false) fail('additionalProperties', `has unknown property "${k}"`, [...path, k])
          else check(sch.additionalProperties, value[k], [...path, k], sink)
        }
      }
    }

    if (sch.allOf) for (const s of sch.allOf) check(s, value, path, sink)
    if (sch.anyOf) {
      const subs = sch.anyOf.map((s) => { const e = []; return { ok: check(s, value, path, e), e } })
      if (!subs.some((x) => x.ok)) {
        const best = subs.reduce((a, b) => (b.e.length < a.e.length ? b : a))
        fail('anyOf', `must match at least one alternative (closest: ${best.e.map((e) => `${e.path || '/'} ${e.message}`).join('; ')})`)
      }
    }
    if (sch.oneOf) {
      const subs = sch.oneOf.map((s) => { const e = []; return { ok: check(s, value, path, e), e } })
      const okCount = subs.filter((x) => x.ok).length
      if (okCount === 0) {
        const best = subs.reduce((a, b) => (b.e.length < a.e.length ? b : a))
        fail('oneOf', `must match exactly one alternative (closest: ${best.e.map((e) => `${e.path || '/'} ${e.message}`).join('; ')})`)
      } else if (okCount > 1) fail('oneOf', `matches ${okCount} alternatives, expected exactly one`)
    }
    if (sch.not !== undefined && check(sch.not, value, path, [])) fail('not', 'must not match the forbidden schema')
    if (sch.if !== undefined) {
      if (check(sch.if, value, path, [])) { if (sch.then !== undefined) check(sch.then, value, path, sink) } else if (sch.else !== undefined) check(sch.else, value, path, sink)
    }
    return sink.length === before
  }

  const sink = []
  check(schema, data, [], sink)
  for (const e of sink.slice(0, maxErrors)) errors.push(e)
  return { valid: errors.length === 0, errors }
}

/** Formats validation errors as "path: message" lines. */
export const formatErrors = (errors) => errors.map((e) => `${e.path || '/'}: ${e.message}`)
