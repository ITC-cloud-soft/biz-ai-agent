// CI checks that keep the manual in step with the screens (a change of a screen that leaves the manual behind fails the build).
// Every function returns a list of problems (strings, empty = fine). Pure.
import { isChapterFile } from './manual.mjs'
import { routeOf } from './routes.mjs'

const allSections = (chapters) => chapters.flatMap((c) => c.sections)

/** Anchors are unique. */
export function checkAnchors(chapters) {
  const seen = new Map()
  const out = []
  for (const s of allSections(chapters)) {
    if (seen.has(s.id)) out.push(`duplicate anchor ${s.id} (${seen.get(s.id)} and ${s.chapter})`)
    else seen.set(s.id, s.chapter)
  }
  return out
}

/** Every path a section names (its screen and related screens) is a route. isRoute(path) may accept more (another app's routes). */
export function checkSectionPaths(chapters, routes, { isRoute = (p) => Boolean(routeOf(p, routes)) } = {}) {
  const out = []
  for (const s of allSections(chapters)) for (const p of [...s.paths, ...s.screens]) if (!isRoute(p)) out.push(`${s.id}: ${p} is not a route`)
  return out
}

/** Every route and every menu item is covered by a section, unless excluded (an exclusion must still be a route). */
export function checkCoverage(chapters, routes, { exclusions = [], menuPaths = [] } = {}) {
  const covered = new Set()
  for (const s of allSections(chapters)) for (const p of [...s.paths, ...s.screens]) { const r = routeOf(p, routes); if (r) covered.add(r.path) }
  const out = []
  for (const r of routes) if (!covered.has(r.path) && !exclusions.includes(r.path)) out.push(`route ${r.path} has no section (add one, or the path with a reason to the exclusions)`)
  for (const p of exclusions) if (!routes.some((r) => r.path === p)) out.push(`exclusion ${p} is no route any more`)
  for (const p of menuPaths) {
    const r = routeOf(p, routes)
    if (!r || !covered.has(r.path)) out.push(`menu item ${p} has no section`)
  }
  return out
}

/**
 * The 「使える役割」 text names every role the section's screen admits. labels: role → the word to look for.
 * Sections whose text says everyone (`everyoneRe`), without a path, or with an unguarded screen (`roles` = every role and `open`) are skipped;
 * skip(section, role) excuses a role (e.g. one screen described per role in two chapters).
 */
export function checkRoleText(chapters, routes, { labels, everyoneRe = /すべて|every|all roles/i, skip = () => false } = {}) {
  const out = []
  for (const s of allSections(chapters)) {
    if (!s.roleText || everyoneRe.test(s.roleText) || !s.paths.length) continue
    const r = routeOf(s.paths[0], routes)
    if (!r || r.open) continue
    for (const role of r.roles ?? []) {
      if (skip(s, role)) continue
      const word = labels[role]
      if (word && !s.roleText.includes(word)) out.push(`${s.id} (${r.path}): 「使える役割」 does not name ${word}: ${s.roleText}`)
    }
  }
  return out
}

/** The section's 「メニュー」 names the menu label of its screen. menu: Map path → label. */
export function checkMenuLabels(chapters, menu, { skip = () => false } = {}) {
  const out = []
  for (const s of allSections(chapters)) {
    if (!s.menu || s.menu.startsWith('—') || !s.paths.length || skip(s)) continue
    const label = menu.get(s.paths[0])
    if (label && !s.menu.includes(label.replace(/（.*$/, ''))) out.push(`${s.id}: メニュー 「${s.menu}」 does not name 「${label}」`)
  }
  return out
}

/** Links between chapters (`NN-x.md#anchor`, `#anchor`) resolve. files: { fileName: text }. Links to other documents (../) are not checked. */
export function checkLinks(files, chapters) {
  const where = new Map(allSections(chapters).map((s) => [s.id, `${s.chapter}.md`]))
  const names = Object.keys(files).map((f) => f.replace(/^.*[\\/]/, '')).filter(isChapterFile)
  const out = []
  for (const [path, text] of Object.entries(files)) {
    const f = path.replace(/^.*[\\/]/, '')
    if (!isChapterFile(f)) continue
    for (const m of String(text).matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1]
      if (/^https?:/.test(link) || link.startsWith('../')) continue
      const [file, anchor] = link.split('#')
      if (file && !file.endsWith('.md')) continue
      if (file && !names.includes(file)) { out.push(`${f}: link to a missing chapter ${link}`); continue }
      if (anchor && where.get(anchor) !== (file || f)) out.push(`${f}: unresolved anchor ${link}`)
    }
  }
  return out
}

/** Links the system itself sends (notices, manifest entity links) open real screens. {from (label), path} with {id}/${…} as a value. */
export function checkLinksAreRoutes(links, isRoute) {
  const sample = '00000000-0000-4000-8000-000000000000'
  return links
    .map(({ from, path }) => ({ from, path, probe: String(path).replace(/\$\{[^}]+\}/g, sample).replace(/\{[A-Za-z]+\}/g, sample) }))
    .filter(({ probe }) => !isRoute(probe))
    .map(({ from, path }) => `${from}: link ${path} is not a route`)
}
