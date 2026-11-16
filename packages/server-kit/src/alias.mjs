// Serving /bridge/v1 on top of an EXISTING API (generalized from care-api src/routes/bridge.mjs of care-ai-native).
//
// A system that already has routes for the Bridge operations under other paths (/api/ai/identity, /api/sns-identities, ...)
// does not rewrite them: each v1 operation becomes an ALIAS of the existing route — same handler, same policy (re-checked
// for the principal), same body; `shape` aliases get a thin response adapter so the body has the v1 shape.
//
//   registerAliasRoutes(router, { table, from: legacyRouter, adapters })
//   table: [{ operationId, method, path: '/identity', aliases: [{ method, path: '/api/ai/identity', for?, query?, status }] }]
//          (aliasTableFromOpenApi(doc, { key }) reads it from an OpenAPI extension, default x-alias; rows of the
//           @dsh-bridge/protocol aliasTable form { method, v1: '/bridge/v1/identity', operationId, aliases } are accepted too,
//           e.g. examples/care-billing/manifest/care-api-v1-aliases.json)
import { gate } from './gate.mjs'
import { compilePath, HttpError } from './http.mjs'

/** Path parameter kinds tried when locating an existing route (a UUID, then a number). */
export const DEFAULT_PARAM_KINDS = Object.freeze([
  { sample: '00000000-0000-4000-8000-000000000000', pattern: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
  { sample: '1', pattern: '[0-9]{1,16}' },
])

/** The alias table from an OpenAPI document: every operation's `key` extension (default x-alias, as @dsh-bridge/protocol). */
export function aliasTableFromOpenApi(doc, { key = 'x-alias' } = {}) {
  const out = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[m]) out.push({ operationId: item[m].operationId, method: m.toUpperCase(), path, aliases: item[m][key] ?? [] })
    }
  }
  return out
}

/** The alias for a principal kind ('service' | 'delegated' | 'user' | 'anon'): an entry whose `for` lists it, else the default. */
export function pickAlias(aliases, kind) {
  return aliases.find((a) => Array.isArray(a.for) && a.for.includes(kind)) ?? aliases.find((a) => !a.for) ?? null
}

/** Fills {name} placeholders. */
export const fillTemplate = (template, params) => template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, n) => encodeURIComponent(params[n] ?? ''))

const toColon = (template) => template.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')

function unionPolicy(policies) {
  if (policies.every((p) => p.public)) return { public: true, aliased: true }
  const allow = [...new Set(policies.flatMap((p) => (p.public ? ['user', 'service', 'delegated'] : p.allow ?? [])))]
  return { allow, aliased: true } // the exact rule of the alias picked for the principal is re-checked in the handler
}

/**
 * registerAliasRoutes(router, { table, from = router, base = '/bridge/v1', adapters = {}, skip = [], paramKinds, log })
 * -> { served: [operationId], skipped: [{ operationId, reason }] }
 */
export function registerAliasRoutes(router, { table, from = router, base = '/bridge/v1', adapters = {}, skip = [], paramKinds = DEFAULT_PARAM_KINDS, log = () => {} }) {
  const served = []
  const skipped = []
  const findRoute = (alias) => {
    for (const kind of paramKinds) {
      const probe = alias.path.replace(/\{[A-Za-z0-9_]+\}/g, kind.sample)
      const found = from.routes.find((r) => r.method === alias.method && r.regex.test(probe))
      if (found) return { route: found, pattern: kind.pattern }
    }
    return null
  }

  for (const row of table) {
    const rowV1 = String(row.v1 ?? '')
    const op = { ...row, path: row.path ?? (rowV1.startsWith(`${base}/`) ? rowV1.slice(base.length) : rowV1) }
    if (skip.includes(op.operationId)) continue
    const aliases = (op.aliases ?? []).filter((a) => a.status !== 'missing')
    if (!aliases.length) { skipped.push({ operationId: op.operationId, reason: 'no alias' }); continue }
    const targets = aliases.map((alias) => ({ alias, ...findRoute(alias) }))
    const lost = targets.find((t) => !t.route)
    if (lost) {
      skipped.push({ operationId: op.operationId, reason: `alias ${lost.alias.method} ${lost.alias.path} is not a route` })
      log(`[server-kit] bridge v1 ${op.method} ${op.path}: alias ${lost.alias.method} ${lost.alias.path} is not a route`)
      continue
    }
    const names = [...op.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1])
    const v1 = `${base}${toColon(op.path)}`
    const patterns = Object.fromEntries(names.map((n) => [n, targets[0].pattern]))
    const { regex: v1Regex } = compilePath(v1, patterns)
    const adapter = adapters[op.operationId] ?? null

    router.add(op.method, v1, unionPolicy(targets.map((t) => t.route.policy)), async (args) => {
      const { principal, req, query, kit } = args
      const alias = pickAlias(aliases, principal.kind) ?? aliases[0]
      const target = targets.find((t) => t.alias === alias)
      // the exact rule of the existing route, for this principal (before any lookup)
      if (!target.route.policy.public) gate(principal, target.route.policy, req, { bffSecret: kit?.config?.bffSecret })
      const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '')
      const m = v1Regex.exec(pathname)
      if (!m) throw new HttpError(404, 'not_found')
      const v1Params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
      const legacyPath = fillTemplate(alias.path, v1Params)
      const lm = target.route.regex.exec(legacyPath)
      if (!lm) throw new HttpError(404, 'not_found')
      const params = Object.fromEntries(target.route.names.map((n, i) => [n, decodeURIComponent(lm[i + 1])]))
      const legacyQuery = new URLSearchParams(query)
      for (const [k, val] of Object.entries(alias.query ?? {})) if (!legacyQuery.has(k)) legacyQuery.set(k, String(val))
      const search = legacyQuery.toString()
      // handlers that read req.url themselves see the existing path
      const legacyReq = Object.create(req, { url: { value: `${legacyPath}${search ? `?${search}` : ''}`, writable: true, enumerable: true, configurable: true } })
      const result = await target.route.handler({ ...args, params, query: legacyQuery, req: legacyReq })
      if (!result || !adapter) return result
      return { ...result, body: adapter(result.body) }
    }, { patterns })
    served.push(op.operationId)
  }
  return { served, skipped }
}

/** Response adapter helper: snake_case keys of each row of `body[listKey]` -> camelCase (a `shape` alias). */
export function camelRows(listKey) {
  const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
  const camelRow = (row) => (row && typeof row === 'object' ? Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v])) : row)
  return (body) => (Array.isArray(body?.[listKey]) ? { ...body, [listKey]: body[listKey].map(camelRow) } : body)
}
