// The knowledge service of a business system: an index and its searcher, for the route (routes.mjs) or the system's own code.
import { candidatesFor, createKnowledgeSearcher, resultsOf } from './search.mjs'
import { DEFAULT_MIN_SIMILARITY, embedChunks, embedQuery } from './hybrid.mjs'
import { checkKnowledgeGraph, kgRank } from './kg.mjs'

export const RERANK_POOL = 20

/**
 * createKnowledgeService(index, { webBase?, synonyms?, fillers?, stopWords?, minCoverage?, minScore?, perDocument?, embedder?, minSimilarity?, rerank?, onError? })
 *   -> { search(question, { asker, limit }), setIndex(index) -> Promise, ready() -> Promise, index(), mode() }
 *
 * webBase: the business web's URL ('' → source paths only).
 * synonyms / fillers / stopWords: the language tuning of the system (see queryTerms); share ONE options object between the app
 *   and evals/run.mjs, so the evals measure what runs.
 * setIndex swaps the index after a rebuild (documents or visibility changed): searches never see a half-built index. With an
 *   embedder the swap happens once the new chunks are embedded (await the promise); without one it is immediate.
 * embedder (optional, see hybrid.mjs): { id, embed(texts) }. No embedder = BM25F only. When embedding fails (the index or a
 *   question), the search falls back to BM25F for it (onError is told; the answer's shape does not change). A new index is
 *   swapped in even then: its visibility is what counts.
 * vectorCache (optional): a Map the vectors are cached in (keyed by embedder id + text): load it from a vector store before and save
 *   it after (await ready()), so unchanged chunks are never embedded again.
 * vectorSearch (optional): async (queryVector, visibleChunks, limit) -> [{ chunkId, sim }] — a vector database does the vector side
 *   (pgvector: @dsh-bridge/agent-settings). It is handed ONLY the asker's visible chunks; whatever it returns is checked again.
 *   Without it the vector side is computed in memory over the same visible chunks.
 * graph (optional): a knowledge graph (kg.mjs: names, types, chunk IDs); its ranking (kgRank, permissions first) is fused with
 *   BM25F (and the vectors) by RRF.
 * rerank (optional): async (question, candidates[{ chunk, score }]) -> candidates in a new order. It sees only the asker's
 *   permitted candidates (at most RERANK_POOL) and may reorder or drop them, never add: anything else it returns is ignored.
 */
export function createKnowledgeService(index, {
  webBase = '', synonyms = [], fillers, stopWords, minCoverage, minScore, perDocument, embedder = null, minSimilarity, rerank = null, onError = null, vectorCache = null, graph = null, vectorSearch = null,
} = {}) {
  const cache = embedder ? (vectorCache ?? new Map()) : null
  const kg = graph ? checkKnowledgeGraph(graph) : null
  const searchOptions = { synonyms, ...(fillers ? { fillers } : {}), ...(stopWords ? { stopWords } : {}) }
  const lexical = (idx) => ({ index: idx, searcher: createKnowledgeSearcher(idx, searchOptions), vectors: null })
  async function prepare(idx) {
    const p = lexical(idx)
    try {
      p.vectors = await embedChunks(idx.chunks, embedder, { cache })
    } catch (error) {
      onError?.(error, { stage: 'embed_index' })
    }
    return p
  }
  let current = lexical(index)
  let pending = embedder ? prepare(index).then((p) => { current = p }) : Promise.resolve()

  async function vectorFor(question) {
    if (!embedder || !current.vectors) return null
    try {
      return { query: await embedQuery(embedder, question), vectors: current.vectors, minSimilarity }
    } catch (error) {
      onError?.(error, { stage: 'embed_query' })
      return null
    }
  }
  /** The vector database's ranking of the asker's visible chunks (permissions first: it never sees another chunk). */
  async function vectorDbList(question, searcher, asker) {
    const visible = searcher.visible(asker)
    if (!visible.length) return []
    try {
      const query = await embedQuery(embedder, question)
      const hits = await vectorSearch(query, visible, 50)
      const byId = new Map(visible.map((c) => [c.id, c]))
      const min = minSimilarity ?? DEFAULT_MIN_SIMILARITY
      return (Array.isArray(hits) ? hits : []).filter((h) => byId.has(h?.chunkId) && Number(h.sim) >= min).map((h) => ({ chunk: byId.get(h.chunkId), sim: Number(h.sim) }))
    } catch (error) {
      onError?.(error, { stage: 'vector_search' })
      return []
    }
  }

  return {
    async search(question, { asker, limit } = {}) {
      await pending
      const { searcher } = current
      const q = String(question ?? '').slice(0, 200)
      const more = kg ? [kgRank(kg, searcher, q, asker)] : []
      const useDb = embedder && current.vectors && typeof vectorSearch === 'function'
      if (useDb) more.unshift(await vectorDbList(q, searcher, asker))
      let list = candidatesFor(searcher, question, { asker, minCoverage, minScore, vector: useDb ? null : await vectorFor(question), more })
      if (typeof rerank === 'function' && list.length > 1) {
        const pool = list.slice(0, RERANK_POOL)
        const allowed = new Map(pool.map((x) => [x.chunk.id, x]))
        try {
          const order = await rerank(String(question ?? ''), pool)
          const seen = new Set()
          list = (Array.isArray(order) ? order : [])
            .map((x) => allowed.get(x?.chunk?.id ?? x?.id ?? x))
            .filter((x) => x && !seen.has(x.chunk.id) && seen.add(x.chunk.id))
        } catch (error) {
          onError?.(error, { stage: 'rerank' }) // keep the fused order
        }
      }
      return resultsOf(list, { limit, webBase, perDocument })
    },
    setIndex(next) {
      if (!embedder) {
        current = lexical(next)
        return Promise.resolve()
      }
      pending = pending.then(() => prepare(next)).then((p) => { current = p })
      return pending
    },
    ready: () => pending,
    index: () => current.index,
    mode: () => [embedder ? 'hybrid' : 'lexical', kg ? 'graph' : null].filter(Boolean).join('+'),
  }
}
