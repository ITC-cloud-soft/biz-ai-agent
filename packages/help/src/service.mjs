// The help service a business system hands to its API (server-kit `help` option, or its own routes): search and one section for an asker.
import { answerOf, createSearcher, searchManual } from './search.mjs'

/**
 * @param {object} index              buildHelpIndex(...) (usually the committed JSON)
 * @param {object} [opts]
 * @param {string|(() => string)} [opts.webBase]  the business web's URL (a function is read on every call)
 * @param {object} [opts.roleLabels]  role → display name
 * @param {object} [opts.prefer]      role → chapter id prefixes to put first
 * @param {number|object} [opts.demote]
 * @param {string} [opts.manualPage]  default '/help/{chapter}#{id}' (the business web's manual page; '' → no manualUrl)
 * @param {(labels: string[]) => string} [opts.altText]
 * @returns {{ search(question, { role, limit, publicOnly }), section(id, { role }), searcher }}
 */
export function createHelpService(index, { webBase = '', roleLabels = {}, prefer = {}, demote, manualPage, altText, minScore, minCoverage } = {}) {
  const searcher = createSearcher(index)
  const base = () => (typeof webBase === 'function' ? webBase() : webBase) || ''
  const shared = () => ({
    webBase: base(), roleLabels, ...(manualPage !== undefined ? { manualPage } : {}), ...(altText ? { altText } : {}),
  })
  return {
    searcher,
    /** role null = a sender that is not linked (public sections only). */
    search(question, { role = null, limit, publicOnly = false } = {}) {
      return searchManual(searcher, question, {
        role, limit, publicOnly, prefer, ...(demote !== undefined ? { demote } : {}), ...(minScore !== undefined ? { minScore } : {}),
        ...(minCoverage !== undefined ? { minCoverage } : {}), ...shared(),
      })
    },
    /** One section with its full lists; null when unknown or (without a role) not public. */
    section(id, { role = null } = {}) {
      const s = searcher.section(String(id))
      if (!s || (!role && !s.public)) return null
      return { ...answerOf(s, { role, ...shared() }), can: s.can, notes: s.notes, qa: s.qa, related: s.related }
    },
  }
}
