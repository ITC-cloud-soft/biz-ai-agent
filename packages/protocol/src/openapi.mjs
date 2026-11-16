// OpenAPI helpers for the Bridge v1 document: loading, operation table, optional x-alias resolution and a structural lint.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveRef, validateSchema } from './jsonschema.mjs'
import { parseDocument } from './yaml.mjs'

export const DEFAULT_OPENAPI_FILE = fileURLToPath(new URL('../openapi/bridge-v1.yaml', import.meta.url))
export const PROTOCOL_HEADER = 'bridge-protocol'
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

export function loadOpenApi(file = DEFAULT_OPENAPI_FILE) {
  return parseDocument(readFileSync(file, 'utf8'), file)
}

/** Base path of the protocol (servers[0].url), e.g. /bridge/v1. */
export function basePath(doc) {
  return String(doc.servers?.[0]?.url ?? '').replace(/\/+$/, '')
}

/** [{ method: 'GET', path: '/identity', operationId, op }] */
export function listOperations(doc) {
  const out = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) if (item[m]) out.push({ method: m.toUpperCase(), path, operationId: item[m].operationId, op: item[m] })
  }
  return out
}

/** '/me/identities/{identityId}' -> { regex, names } */
export function compileTemplate(template) {
  const names = []
  const source = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => { names.push(n); return '([^/]+)' })
  return { regex: new RegExp(`^${source}$`), names }
}

/** Finds the operation for a request path (with or without the base path). Returns { operation, params } or null. */
export function matchOperation(doc, method, requestPath, ops = listOperations(doc)) {
  const base = basePath(doc)
  const path = requestPath.startsWith(`${base}/`) ? requestPath.slice(base.length) : requestPath
  for (const o of ops) {
    if (o.method !== method.toUpperCase()) continue
    const { regex, names } = compileTemplate(o.path)
    const m = regex.exec(path)
    if (m) return { operation: o, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) }
  }
  return null
}

/** The default extension name of an implementation's alias list (v1 operation -> its own older route). */
export const ALIAS_EXTENSION = 'x-alias'

/**
 * The mapping table v1 -> an implementation's own routes, read from an extension on every operation:
 * [{ method, v1, operationId, aliases: [{ method, path, for?, query?, status, note? }] }].
 * The bundled document carries no aliases; an implementation keeps its own annotated copy (or a JSON table).
 */
export function aliasTable(doc, { extension = ALIAS_EXTENSION } = {}) {
  return listOperations(doc).map((o) => ({ method: o.method, v1: `${basePath(doc)}${o.path}`, operationId: o.operationId, aliases: o.op[extension] ?? [] }))
}

/**
 * The annotated copy of `doc` for an alias table kept as JSON (the shape aliasTable() returns:
 * [{ method, v1, operationId, aliases }]): every row's `aliases` is written to `extension` on its operation, so aliasTable /
 * aliasTableMarkdown / lintOpenApi({ aliasExtension, requireAliases }) / pickAlias work on it. `doc` is not modified.
 * Throws when a row names an operation the document does not have (or names one twice), or its method / v1 path differ
 * from the document: a stale table must not silently map onto the wrong operation. Operations without a row get no extension.
 */
export function applyAliasTable(doc, table, { extension = ALIAS_EXTENSION } = {}) {
  if (!Array.isArray(table)) throw new TypeError('alias table must be an array of { method, v1, operationId, aliases }')
  const copy = structuredClone(doc)
  const byId = new Map(listOperations(copy).map((o) => [o.operationId, o]))
  const seen = new Set()
  for (const [i, row] of table.entries()) {
    const o = byId.get(row?.operationId)
    if (!o) throw new Error(`alias table row ${i}: unknown operationId ${JSON.stringify(row?.operationId)}`)
    if (seen.has(o.operationId)) throw new Error(`alias table row ${i}: duplicate operationId ${o.operationId}`)
    seen.add(o.operationId)
    const v1 = `${basePath(copy)}${o.path}`
    if (row.method !== o.method || row.v1 !== v1) {
      throw new Error(`alias table row ${i} (${o.operationId}): ${row.method} ${row.v1} does not match the document (${o.method} ${v1})`)
    }
    if (!Array.isArray(row.aliases)) throw new Error(`alias table row ${i} (${o.operationId}): aliases must be a list`)
    o.op[extension] = structuredClone(row.aliases)
  }
  return copy
}

/**
 * Picks the alias entry for a principal type ('service' | 'delegated' | 'user' | 'anon').
 * Entries with `for` match only those principals; the first entry without a filter is the default.
 */
export function pickAlias(aliases, principal) {
  return aliases.find((a) => Array.isArray(a.for) && a.for.includes(principal)) ?? aliases.find((a) => !a.for) ?? null
}

/** Fills {name} placeholders. */
export function fillTemplate(template, params) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => encodeURIComponent(params[n] ?? ''))
}

/** Markdown table of the v1 -> implementation mapping (`bridge-validate aliases [file] [--extension x-...] [--label ...]`). */
export function aliasTableMarkdown(doc, { extension = ALIAS_EXTENSION, label = 'implementation' } = {}) {
  const rows = [`| v1 | operation | ${label} | status |`, '|---|---|---|---|']
  for (const r of aliasTable(doc, { extension })) {
    const impl = r.aliases.map((a) => `${a.method} ${a.path}${a.for ? ` (${a.for.join('/')})` : ''}`).join('<br>')
    const status = [...new Set(r.aliases.map((a) => a.status))].join('/')
    rows.push(`| \`${r.method} ${r.v1}\` | ${r.operationId} | ${impl} | ${status} |`)
  }
  return rows.join('\n')
}

/**
 * lintOpenApi(doc) -> { valid, errors, warnings }
 *  - 3.1.x, info, servers, base path /bridge/v1
 *  - every operation: operationId (unique), summary, tags, explicit security, x-invariants, declared path parameters match
 *    the template, a 2xx response; an alias list (options.aliasExtension, default x-alias) is optional unless
 *    options.requireAliases, and when present each entry needs method / path / status and the v1 path parameters
 *  - every response (resolved) carries the bridge-protocol header; every non-2xx response uses the ErrorEnvelope
 *  - every $ref resolves; every security scheme used is declared; ErrorEnvelope codes are documented
 *  - no object key contains a space or comma (a mis-quoted flow mapping)
 */
export function lintOpenApi(doc, { aliasExtension = ALIAS_EXTENSION, requireAliases = false } = {}) {
  const errors = []
  const warnings = []
  const err = (path, message) => errors.push({ path, message })
  const warn = (path, message) => warnings.push({ path, message })

  if (!/^3\.1\.\d+$/.test(String(doc.openapi))) err('/openapi', `must be 3.1.x (got ${doc.openapi})`)
  if (!doc.info?.title || !doc.info?.version) err('/info', 'title and version are required')
  if (doc.info?.['x-bridge-protocol'] !== 1) err('/info/x-bridge-protocol', 'must be 1')
  if (basePath(doc) !== '/bridge/v1') err('/servers/0/url', 'must be /bridge/v1')

  // $ref resolution and odd keys
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}/${i}`)); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (/[\s,]/.test(k)) err(`${path}/${k}`, 'object key contains a space or comma (mis-quoted flow mapping?)')
      if (k === '$ref' && typeof v === 'string') {
        try { resolveRef(doc, v) } catch { err(path, `unresolvable $ref ${v}`) }
      }
      walk(v, `${path}/${k}`)
    }
  }
  walk(doc, '')

  const schemes = new Set(Object.keys(doc.components?.securitySchemes ?? {}))
  const resolve = (node) => (node && node.$ref ? resolveRef(doc, node.$ref) : node)
  const seenIds = new Set()
  const codes = new Set(Object.keys(doc.info?.['x-error-codes'] ?? {}))
  for (const [code, entry] of Object.entries(doc.info?.['x-error-codes'] ?? {})) {
    if (!entry || typeof entry.status !== 'number' || typeof entry.meaning !== 'string') err(`/info/x-error-codes/${code}`, 'needs numeric status and string meaning')
    if (!/^[a-z0-9_]+$/.test(code)) err(`/info/x-error-codes/${code}`, 'code must be lower snake case')
  }
  if (!codes.size) err('/info/x-error-codes', 'error code catalog is missing')

  for (const [name, r] of Object.entries(doc.components?.responses ?? {})) {
    if (!r.headers?.[PROTOCOL_HEADER]) err(`/components/responses/${name}`, `must declare the ${PROTOCOL_HEADER} header`)
    const schemaRef = r.content?.['application/json']?.schema?.$ref
    if (schemaRef !== '#/components/schemas/ErrorEnvelope') err(`/components/responses/${name}`, 'error responses must use ErrorEnvelope')
  }
  const envelope = doc.components?.schemas?.ErrorEnvelope
  if (!envelope || envelope.required?.join() !== 'ok,error') err('/components/schemas/ErrorEnvelope', 'must require ok and error')

  const ops = listOperations(doc)
  if (!ops.length) err('/paths', 'no operations')
  for (const { method, path, op, operationId } of ops) {
    const p = `/paths${path}/${method.toLowerCase()}`
    if (!operationId) err(p, 'operationId is required')
    else if (seenIds.has(operationId)) err(p, `duplicate operationId ${operationId}`)
    seenIds.add(operationId)
    if (!op.summary) err(p, 'summary is required')
    if (!Array.isArray(op.tags) || !op.tags.length) err(p, 'tags are required')
    if (!Array.isArray(op.security)) err(p, 'security must be declared explicitly ([] for none)')
    for (const req of op.security ?? []) for (const s of Object.keys(req)) if (!schemes.has(s)) err(p, `unknown security scheme ${s}`)
    if (!Array.isArray(op['x-invariants'])) err(p, 'x-invariants is required (list the section-3 invariants it enforces, may be empty)')
    const templateParams = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort()
    const declared = (op.parameters ?? []).map(resolve).filter((x) => x.in === 'path').map((x) => x.name).sort()
    if (templateParams.join() !== declared.join()) err(p, `path parameters [${templateParams}] do not match declared [${declared}]`)

    const aliases = op[aliasExtension]
    if (requireAliases && (!Array.isArray(aliases) || !aliases.length)) err(p, `${aliasExtension} is required (use status: missing when the implementation has no equivalent)`)
    if (aliases !== undefined && !Array.isArray(aliases)) err(p, `${aliasExtension} must be a list`)
    for (const [i, a] of (Array.isArray(aliases) ? aliases : []).entries()) {
      const ap = `${p}/${aliasExtension}/${i}`
      if (!METHODS.includes(String(a.method).toLowerCase())) err(ap, 'method is invalid')
      if (typeof a.path !== 'string' || !a.path.startsWith('/')) err(ap, 'path must start with /')
      if (!['exact', 'shape', 'missing'].includes(a.status)) err(ap, 'status must be exact | shape | missing')
      if (a.status !== 'exact' && !a.note) err(ap, 'a note is required unless status is exact')
      if (a.status !== 'missing') {
        const aliasParams = [...String(a.path).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort()
        if (aliasParams.join() !== templateParams.join()) err(ap, `alias parameters [${aliasParams}] must equal the v1 path parameters [${templateParams}]`)
      }
      for (const f of a.for ?? []) if (!['service', 'delegated', 'user', 'anon'].includes(f)) err(ap, `unknown principal ${f}`)
    }

    const statuses = Object.keys(op.responses ?? {})
    if (!statuses.some((s) => /^2\d\d$/.test(s))) err(p, 'needs a 2xx response')
    for (const [status, raw] of Object.entries(op.responses ?? {})) {
      const r = resolve(raw)
      if (!r.headers?.[PROTOCOL_HEADER]) err(`${p}/responses/${status}`, `must declare the ${PROTOCOL_HEADER} header`)
      if (/^[45]\d\d$/.test(status)) {
        const ref = r.content?.['application/json']?.schema?.$ref
        if (ref !== '#/components/schemas/ErrorEnvelope') err(`${p}/responses/${status}`, 'must use ErrorEnvelope')
      } else if (/^2\d\d$/.test(status)) {
        const sch = r.content?.['application/json']?.schema
        if (!sch) warn(`${p}/responses/${status}`, 'no JSON schema')
      }
    }
    const authed = (op.security ?? []).length > 0
    if (authed && !statuses.includes('401') && !statuses.includes('403')) err(p, 'authenticated operations must document 401 or 403')
    const bodyOps = method === 'POST' || method === 'PUT' || method === 'PATCH'
    if (bodyOps && op.requestBody?.required && !statuses.includes('400')) warn(p, 'documents a required body but no 400 response')
  }
  return { valid: errors.length === 0, errors, warnings }
}

/** Validates a JSON body against a component schema (resolved from the document). */
export function validateAgainst(doc, schemaRefOrName, data) {
  const ref = schemaRefOrName.startsWith('#') ? schemaRefOrName : `#/components/schemas/${schemaRefOrName}`
  return validateSchema({ $ref: ref }, data, { root: doc })
}

/** The response schema ref of an operation for a status code (JSON), or null. */
export function responseSchema(doc, operationId, status) {
  const o = listOperations(doc).find((x) => x.operationId === operationId)
  if (!o) return null
  let r = o.op.responses?.[String(status)]
  if (r?.$ref) r = resolveRef(doc, r.$ref)
  return r?.content?.['application/json']?.schema ?? null
}
