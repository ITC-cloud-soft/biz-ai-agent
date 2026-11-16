// Screen routes of a business web app: path patterns (':name' = one segment, a trailing '/*' = the path itself or any sub path).
// Pure.

/** A route pattern → RegExp of the path (a trailing slash is fine). */
export function routePattern(route) {
  const src = String(route)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, '[^/?#]+')
  return new RegExp(`^${src}/?$`)
}

/**
 * The route a path falls on (query and fragment ignored), or null. An exact pattern wins over a parameterised one.
 * @param {string} path
 * @param {Array<string | { path: string }>} routes
 */
export function routeOf(path, routes) {
  const p = String(path ?? '').split(/[?#]/)[0]
  const list = (Array.isArray(routes) ? routes : []).map((r) => (typeof r === 'string' ? { path: r } : r)).filter((r) => r && typeof r.path === 'string')
  return list.find((r) => r.path === p) ?? list.find((r) => routePattern(r.path).test(p)) ?? null
}

/** A path a link can open: no ':param' (a detail screen opens from its list = the path without its last ':param'), else null. */
export function listPath(path) {
  const p = String(path ?? '')
  if (!p.includes('/:')) return p || null
  const cut = p.replace(/\/:[A-Za-z][A-Za-z0-9_]*(?:\/.*)?$/, '')
  return cut && !cut.includes('/:') ? cut : null
}
