// link-guard.js — the links an AI answer may carry (care-ai-native docs/design/SNS_HELP_QA.md §4.3).
//
// The AI copies URLs from tool results into its answer; a copy can be wrong (a character off, another screen, a made-up path).
// Before the answer is sent, every URL in it is checked:
//   - on the business web (same origin and base path as `base`): kept only when its path is one of the business system's screens
//     (`routes`: the manifest's web.routes, ':name' = one segment, a trailing '/*' = any sub path). Query and fragment are kept.
//   - another host: kept only when the host (or a parent domain) is in `allowHosts`.
//   - otherwise the URL is replaced with `replacement` (default 「（リンクを省きました）」).
// No routes (an application that does not declare its screens) → the guard keeps every link (it cannot tell).
// Pure: no I/O.

export const DEFAULT_LINK_REPLACEMENT = '（リンクを省きました）'
// a URL ends at white space, quotes, brackets and Japanese punctuation
const URL_RE = /https?:\/\/[^\s<>"'`「」『』（）()［］[\]{}、。，！？]+/g
const TRAILING = /[.,;:!?)\]}]+$/

/** A route pattern → RegExp of the path (':name' = one segment, '/*' at the end = the path itself or any sub path). */
export function routePattern(route) {
  const src = String(route)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, '[^/]+')
  return new RegExp(`^${src}/?$`)
}

const hostAllowed = (host, allowHosts) => allowHosts.some((h) => host === h || host.endsWith(`.${h}`))

/**
 * @param {object} opts
 * @param {string} opts.base         the business web's URL (origin plus an optional base path)
 * @param {string[]} [opts.routes]   the screens' path patterns (relative to the base path)
 * @param {string[]} [opts.allowHosts] other hosts a link may point to (exact or parent domain)
 * @param {string} [opts.replacement]
 * @returns {(text: string) => { text: string, removed: string[] }}
 */
export function createLinkGuard({ base, routes = [], allowHosts = [], replacement = DEFAULT_LINK_REPLACEMENT } = {}) {
  let baseUrl = null
  try { baseUrl = base ? new URL(String(base)) : null } catch { baseUrl = null }
  const basePath = baseUrl ? baseUrl.pathname.replace(/\/+$/, '') : ''
  const patterns = (Array.isArray(routes) ? routes : []).filter((r) => typeof r === 'string' && r.startsWith('/')).map(routePattern)
  const hosts = (Array.isArray(allowHosts) ? allowHosts : []).map((h) => String(h).toLowerCase().trim()).filter(Boolean)
  const active = Boolean(baseUrl) && patterns.length > 0

  function allowed(raw) {
    let u
    try { u = new URL(raw) } catch { return false }
    if (u.username || u.password) return false
    if (baseUrl && u.origin === baseUrl.origin && (u.pathname === basePath || u.pathname.startsWith(`${basePath}/`) || basePath === '')) {
      const path = u.pathname.slice(basePath.length) || '/'
      return patterns.some((re) => re.test(path))
    }
    return hostAllowed(u.hostname.toLowerCase(), hosts)
  }

  return function guard(text) {
    if (typeof text !== 'string' || !text || !active) return { text, removed: [] }
    const removed = []
    const out = text.replace(URL_RE, (match) => {
      const tail = match.match(TRAILING)?.[0] ?? ''
      const url = tail ? match.slice(0, -tail.length) : match
      if (allowed(url)) return match
      removed.push(url)
      return `${replacement}${tail}`
    })
    return { text: out, removed }
  }
}
