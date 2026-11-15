// Documents → a semantic knowledge graph (JSON file), with the base model of the settings.
//
//  - input: the chunks of the knowledge index — they have ALREADY passed the personal-data screen
//  - per chunk the model returns { entities: [{ name, type }], relations: [{ from, to, type }] } (JSON); names are screened again
//    (an entity whose name the screen flags is dropped, with its relations)
//  - entities are merged by their normalized name; every entity and relation keeps the chunk IDs it comes from, which is how
//    retrieval applies each asker's rights (kgRank). The file holds names, types and chunk IDs only — never chunk text
//  - cache: the extraction of a chunk is kept by (model, SHA-256 of heading + text); an unchanged chunk is never sent again
import { createHash } from 'node:crypto'
import { KG_VERSION } from '@dsh-bridge/knowledge'
import { normalize } from '@dsh-bridge/help/search'

export const MAX_ENTITIES = 20
export const MAX_RELATIONS = 30
const TYPE_RE = /^[a-z][a-z0-9_]{0,29}$/

export const EXTRACTION_PROMPT = [
  'You extract a knowledge graph from ONE section of a company document.',
  'Return ONLY a JSON object: {"entities":[{"name":"...","type":"..."}],"relations":[{"from":"<entity name>","to":"<entity name>","type":"..."}]}.',
  'Entities: the rules, kinds of leave / requests / items, roles, teams, screens, periods and limits the section talks about — in the',
  'section\'s own language and wording. Types: short lower_snake_case words (rule, role, team, period, limit, document, screen, thing).',
  'Relations: how two of those entities are linked (approves, requires, applies_to, limited_to, part_of, …), lower_snake_case.',
  'Never output names of people, e-mail addresses, phone numbers or other personal data. Never invent anything the section does not say.',
  `At most ${MAX_ENTITIES} entities and ${MAX_RELATIONS} relations.`,
].join('\n')

const hashOf = (c) => createHash('sha256').update(`${c.heading ?? ''}\n${c.text}`).digest('hex')
const cleanName = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 80) : '')
const cleanType = (v) => {
  const t = String(v ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return TYPE_RE.test(t) ? t : 'thing'
}

/** One model answer → { entities, relations } with clean names / types and relations between known entities only. */
export function cleanExtraction(raw) {
  const entities = []
  const seen = new Set()
  for (const e of Array.isArray(raw?.entities) ? raw.entities.slice(0, MAX_ENTITIES) : []) {
    const name = cleanName(e?.name)
    const key = normalize(name)
    if (key.length < 2 || seen.has(key)) continue
    seen.add(key)
    entities.push({ name, type: cleanType(e?.type) })
  }
  const relations = []
  for (const r of Array.isArray(raw?.relations) ? raw.relations.slice(0, MAX_RELATIONS) : []) {
    const from = cleanName(r?.from)
    const to = cleanName(r?.to)
    if (!seen.has(normalize(from)) || !seen.has(normalize(to)) || normalize(from) === normalize(to)) continue
    relations.push({ from, to, type: cleanType(r?.type) })
  }
  return { entities, relations }
}

/**
 * @param {object} index          buildKnowledgeIndex result
 * @param {object} o
 * @param {{ model, json(messages) }} o.chat   createChat(...)
 * @param {(text) => Promise<{kinds}>} [o.screen]   the personal-data screen (bridgePiiScreen): flagged names are dropped
 * @param {object} [o.previous]  the previous graph file (its extraction cache is reused)
 * @returns {Promise<{ kg, stats: { chunks, extracted, cached, failed, dropped } }>}
 */
export async function buildKnowledgeGraph(index, { chat, screen = null, previous = null, now = () => new Date() } = {}) {
  const cache = previous?.model === chat.model && previous?.extractions ? previous.extractions : {}
  const extractions = {}
  const stats = { chunks: index.chunks.length, extracted: 0, cached: 0, failed: 0, dropped: 0 }
  const byKey = new Map()
  const relations = new Map()
  for (const c of index.chunks) {
    const h = hashOf(c)
    let ex = cache[h]
    if (ex) stats.cached += 1
    else {
      try {
        ex = cleanExtraction(await chat.json([
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: `Document: ${c.title}${c.heading ? `\nSection: ${c.heading}` : ''}\n\n${c.text}` },
        ]))
        if (screen) {
          const kept = []
          for (const e of ex.entities) {
            if ((await screen(e.name))?.kinds?.length) stats.dropped += 1
            else kept.push(e)
          }
          const names = new Set(kept.map((e) => normalize(e.name)))
          ex = { entities: kept, relations: ex.relations.filter((r) => names.has(normalize(r.from)) && names.has(normalize(r.to))) }
        }
        stats.extracted += 1
      } catch {
        stats.failed += 1
        continue
      }
    }
    extractions[h] = ex
    for (const e of ex.entities) {
      const key = normalize(e.name)
      const cur = byKey.get(key) ?? { id: `e:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`, name: e.name, type: e.type, chunks: new Set() }
      cur.chunks.add(c.id)
      byKey.set(key, cur)
    }
    for (const r of ex.relations) {
      const from = byKey.get(normalize(r.from))
      const to = byKey.get(normalize(r.to))
      if (!from || !to) continue
      const k = `${from.id}|${r.type}|${to.id}`
      const cur = relations.get(k) ?? { from: from.id, to: to.id, type: r.type, chunks: new Set() }
      cur.chunks.add(c.id)
      relations.set(k, cur)
    }
  }
  const sorted = (set) => [...set].sort()
  const kg = {
    version: KG_VERSION,
    builtAt: now().toISOString(),
    model: chat.model,
    entities: [...byKey.values()].map((e) => ({ ...e, chunks: sorted(e.chunks) })).sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].map((r) => ({ ...r, chunks: sorted(r.chunks) })).sort((a, b) => `${a.from}${a.type}${a.to}`.localeCompare(`${b.from}${b.type}${b.to}`)),
    extractions,
  }
  return { kg, stats }
}
