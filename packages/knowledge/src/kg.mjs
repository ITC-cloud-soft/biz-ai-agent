// Retrieval over a semantic knowledge graph (entities and relations extracted from the chunks; @dsh-bridge/agent-settings builds
// it). The graph JSON holds names, types and chunk IDs only — never chunk text.
//
//   kg = { version: 1, entities: [{ id, name, type, chunks: [chunkId] }], relations: [{ from, to, type, chunks: [chunkId] }] }
//
// PERMISSIONS FIRST: an entity counts only through the chunks the asker may read, a relation only when one of ITS chunks is
// readable and both of its ends are usable. Hidden chunks therefore add nothing (no score, no neighbor, no side channel).
// Ranking: an entity named in the question gives 1 to each readable chunk that mentions it, a neighbor (one hop over a usable
// relation) 0.5, the relation's own chunks 0.75. Chunks below 1 are dropped (at least one direct mention).
import { normalize } from '@dsh-bridge/help/search'
import { wordTerms } from './search.mjs'

export const KG_VERSION = 1
const MIN_SCORE = 1

/** Does the question name this entity? (normalized substring for 2+ characters; for Latin names every word must occur) */
function named(qNorm, qWords, name) {
  const n = normalize(name)
  if (n.length < 2) return false
  if (/^[a-z0-9]+$/.test(n)) {
    const words = wordTerms(name)
    return words.length > 0 && words.every((w) => qWords.has(w))
  }
  return qNorm.includes(n)
}

/** [{ chunk, score }] best first, for one asker. `searcher` = createKnowledgeSearcher(index) (visible(asker), chunk(id)). */
export function kgRank(kg, searcher, question, asker) {
  if (!kg || !Array.isArray(kg.entities)) return []
  const visible = new Set(searcher.visible(asker).map((c) => c.id))
  if (!visible.size) return []
  const readable = (ids) => (Array.isArray(ids) ? ids.filter((id) => visible.has(id)) : [])
  const entities = new Map()
  for (const e of kg.entities) {
    const chunks = readable(e.chunks)
    if (chunks.length) entities.set(e.id, { ...e, chunks })
  }
  const relations = (kg.relations ?? [])
    .map((r) => ({ ...r, chunks: readable(r.chunks) }))
    .filter((r) => r.chunks.length && entities.has(r.from) && entities.has(r.to))
  const qNorm = normalize(question)
  const qWords = new Set(wordTerms(question))
  const matched = [...entities.values()].filter((e) => named(qNorm, qWords, e.name))
  if (!matched.length) return []
  const score = new Map()
  const add = (ids, w) => { for (const id of ids) score.set(id, (score.get(id) ?? 0) + w) }
  const hit = new Set(matched.map((e) => e.id))
  for (const e of matched) add(e.chunks, 1)
  for (const r of relations) {
    if (!hit.has(r.from) && !hit.has(r.to)) continue
    add(r.chunks, 0.75)
    const other = hit.has(r.from) ? r.to : r.from
    if (!hit.has(other)) add(entities.get(other).chunks, 0.5)
  }
  return [...score]
    .filter(([, s]) => s >= MIN_SCORE)
    .map(([id, s]) => ({ chunk: searcher.chunk(id), score: s }))
    .filter((x) => x.chunk)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
}

/** A graph's shape check (a file from disk or another build): throws on anything that is not names, types and chunk IDs. */
export function checkKnowledgeGraph(kg) {
  if (!kg || kg.version !== KG_VERSION || !Array.isArray(kg.entities) || !Array.isArray(kg.relations)) throw new Error('knowledge graph: bad file (version / entities / relations)')
  const ids = new Set()
  for (const e of kg.entities) {
    if (typeof e?.id !== 'string' || typeof e.name !== 'string' || typeof e.type !== 'string' || !Array.isArray(e.chunks)) throw new Error('knowledge graph: bad entity')
    ids.add(e.id)
  }
  for (const r of kg.relations) {
    if (!ids.has(r?.from) || !ids.has(r?.to) || typeof r.type !== 'string' || !Array.isArray(r.chunks)) throw new Error('knowledge graph: bad relation')
  }
  return kg
}
