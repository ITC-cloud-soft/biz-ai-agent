// Who may read a chunk. Pure.
//
//   visibility = { roles: [role, ...], users: [employeeId, ...] }   (at least one entry; never "everyone" by default)
//   canSee(visibility, asker) = asker.role ∈ roles  OR  asker.id ∈ users
//
// A document declares its visibility; a section may only NARROW it (its roles ⊆ the document's roles, its users ⊆ the
// document's users). A chunk is never more visible than its document. Unknown roles are a build error (fail closed: a typo
// is reported, not silently turned into "nobody" or "everybody").

export class KnowledgeBuildError extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'KnowledgeBuildError'
    this.details = details
  }
}

const uniq = (list) => [...new Set(list)]
const strings = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean)

/**
 * The visibility of a document, checked against the manifest's roles.
 * @param {object} raw          { roles?, users? }
 * @param {object} o
 * @param {string[]} o.declaredRoles   the manifest's roles
 * @param {string} o.where             for the error message
 */
export function documentVisibility(raw, { declaredRoles, where }) {
  const roles = uniq(strings(raw?.roles))
  const users = uniq(strings(raw?.users))
  const unknown = roles.filter((r) => !declaredRoles.includes(r))
  if (unknown.length) throw new KnowledgeBuildError(`${where}: unknown role(s) ${unknown.join(', ')} (the manifest declares ${declaredRoles.join(', ')})`)
  if (!roles.length && !users.length) {
    throw new KnowledgeBuildError(`${where}: no visibility — give roles and / or users (a document is never visible to everyone by default)`)
  }
  return Object.freeze({ roles: Object.freeze(roles), users: Object.freeze(users) })
}

/**
 * The visibility of a section: the document's, or narrower when the section names roles / users (each a subset of the
 * document's; naming one replaces both grants with the section's).
 */
export function sectionVisibility(doc, raw, { where }) {
  const hasRoles = raw && raw.roles !== undefined
  const hasUsers = raw && raw.users !== undefined
  if (!hasRoles && !hasUsers) return doc
  const roles = uniq(strings(raw.roles))
  const users = uniq(strings(raw.users))
  const wider = [...roles.filter((r) => !doc.roles.includes(r)), ...users.filter((u) => !doc.users.includes(u))]
  if (wider.length) throw new KnowledgeBuildError(`${where}: a section can only narrow its document's visibility (${wider.join(', ')} cannot read the document)`)
  if (!roles.length && !users.length) throw new KnowledgeBuildError(`${where}: empty section visibility`)
  return Object.freeze({ roles: Object.freeze(roles), users: Object.freeze(users) })
}

/** Can this asker ({ id, role }) read a chunk of this visibility. No asker = nothing. */
export function canSee(visibility, asker) {
  if (!asker || !visibility) return false
  const role = typeof asker.role === 'string' && asker.role ? asker.role : null
  const id = asker.id === undefined || asker.id === null ? null : String(asker.id)
  return Boolean((role && visibility.roles.includes(role)) || (id && visibility.users.includes(id)))
}
