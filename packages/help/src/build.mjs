// The help index: the manual's sections with the roles that may open their screens, plus the synonyms. Pure, deterministic
// (no dates: CI compares the committed index with a fresh build).
import { routeOf } from './routes.mjs'

export const INDEX_VERSION = 1

const matcher = (patterns) => {
  const list = (Array.isArray(patterns) ? patterns : []).map(String)
  return (id) => list.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p))
}

/**
 * @param {object} o
 * @param {Array} o.chapters        parseManual(...)
 * @param {Array<{path: string, roles: string[], caps?: string[]}>} o.routes  the business web's screens and who may open them
 *                                  (from the app's own route table: the business system knows its guards)
 * @param {string[]} o.roles        every role (the order of `roles` in the index)
 * @param {string[]} [o.appRoles]   roles of the mobile-app sections (sections with 「アプリの画面」, or in `appChapters`); default every role
 * @param {string[]} [o.appChapters] chapter id prefixes of the mobile app (e.g. ['06-']): all their sections are app sections
 * @param {string[]} [o.publicSections]  ids (a trailing * = prefix) answered to senders that are not linked yet
 * @param {string[][]} [o.synonyms] parseSynonyms(...)
 * @returns {{ version, chapters: {chapter, title}[], synonyms, sections }}
 */
export function buildHelpIndex({ chapters, routes, roles, appRoles = roles, appChapters = [], publicSections = [], synonyms = [] }) {
  const isPublic = matcher(publicSections)
  const sections = []
  for (const ch of chapters) {
    for (const s of ch.sections) {
      const hits = s.paths.map((p) => routeOf(p, routes)).filter(Boolean)
      const app = Boolean(s.app) || appChapters.some((p) => ch.chapter.startsWith(p))
      const allowed = app ? appRoles : hits.length ? hits.flatMap((r) => r.roles ?? []) : roles
      const caps = [...new Set(hits.flatMap((r) => r.caps ?? []))]
      const { roleText: _text, ...rest } = s
      sections.push({ ...rest, ...(caps.length || hits.some((r) => r.caps) ? { caps } : {}), roles: roles.filter((r) => allowed.includes(r)), public: isPublic(s.id) })
    }
  }
  return { version: INDEX_VERSION, chapters: chapters.map((c) => ({ chapter: c.chapter, title: c.title })), synonyms, sections }
}

/** One section a line (readable diffs), the rest compact. */
export const serializeIndex = (index) => [
  `{"version":${JSON.stringify(index.version)},"chapters":${JSON.stringify(index.chapters)},"synonyms":${JSON.stringify(index.synonyms)},"sections":[`,
  index.sections.map((s) => JSON.stringify(s)).join(',\n'),
  ']}',
  '',
].join('\n')

export const DEFAULT_WEB_BLOCK_HEADER = '# The screens an AI answer may link (bridge-identity link guard). Generated from the app\'s route table: do not edit by hand.\n'

/**
 * A YAML manifest's text with its top-level `web:` block set to the routes: an existing `web:` block (anywhere, with or without the
 * header comment) is replaced in place; without one, the block is inserted before `roles:`. Other keys under `web:` are not kept
 * (the manifest's `web` has only `routes`).
 */
export function setManifestWebRoutes(text, routes, { header = DEFAULT_WEB_BLOCK_HEADER } = {}) {
  const block = `${header}web:\n  routes:\n${routes.map((r) => `    - '${r}'`).join('\n')}\n\n`
  // an existing top-level `web:` block (generated or written by hand, wherever it is) is replaced in place — never a second `web:`
  const web = /^web:[ \t]*(#.*)?$/m.exec(text)
  if (web) {
    let start = web.index
    if (text.slice(0, start).endsWith(header)) start -= header.length
    const lines = text.slice(web.index).split('\n')
    let n = 1
    while (n < lines.length && (lines[n] === '' || /^[ \t]/.test(lines[n]))) n += 1 // the block: indented (or blank) lines
    const rest = lines.slice(n).join('\n')
    return text.slice(0, start) + block + rest
  }
  const at = text.indexOf('\nroles:\n')
  if (at < 0) throw new Error('manifest: no roles: block')
  return text.slice(0, at + 1) + block + text.slice(at + 1)
}
