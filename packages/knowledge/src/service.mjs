// The knowledge service of a business system: an index and its searcher, for the route (routes.mjs) or the system's own code.
import { createKnowledgeSearcher, searchKnowledge } from './search.mjs'

/**
 * createKnowledgeService(index, { webBase?, synonyms?, minCoverage?, minScore?, perDocument? })
 *   -> { search(question, { asker, limit }), setIndex(index), index() }
 * webBase: the business web's URL ('' → source paths only). setIndex swaps the index after a rebuild (documents changed,
 * visibility changed): searches never see a half-built index.
 */
export function createKnowledgeService(index, { webBase = '', synonyms = [], minCoverage, minScore, perDocument } = {}) {
  let current = index
  let searcher = createKnowledgeSearcher(index, { synonyms })
  return {
    async search(question, { asker, limit } = {}) {
      return searchKnowledge(searcher, question, { asker, limit, webBase, minCoverage, minScore, perDocument })
    },
    setIndex(next) {
      const s = createKnowledgeSearcher(next, { synonyms })
      current = next
      searcher = s
    },
    index: () => current,
  }
}
