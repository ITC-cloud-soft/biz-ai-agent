// Knowledge-graph retrieval: an entity counts only through the chunks the asker may read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnowledgeIndex, checkKnowledgeGraph, createKnowledgeSearcher, createKnowledgeService, kgRank, parseKnowledgeMarkdown } from '../src/index.mjs'

const ROLES = ['admin', 'manager', 'staff']
const MD = `---
id: travel-policy
title: Travel policy
link: /handbook/travel-policy
roles: [admin, manager, staff]
---
Rules for business trips (fictional).

## Booking {#booking}
Book trains and hotels through the travel desk at least 3 days ahead.

## Expense limits {#limits roles=admin,manager}
Hotel up to 15000 yen per night. The finance team checks every claim.
`
// what an extraction model could have found (names, types, chunk ids only)
const KG = {
  version: 1,
  entities: [
    { id: 'e1', name: 'travel desk', type: 'team', chunks: ['travel-policy:1:0'] },
    { id: 'e2', name: 'hotel', type: 'thing', chunks: ['travel-policy:1:0', 'travel-policy:2:0'] },
    { id: 'e3', name: 'finance team', type: 'team', chunks: ['travel-policy:2:0'] },
    { id: 'e4', name: '経理', type: 'team', chunks: ['travel-policy:2:0'] },
  ],
  relations: [{ from: 'e3', to: 'e2', type: 'checks', chunks: ['travel-policy:2:0'] }],
}
const staff = { id: 's1', role: 'staff' }
const manager = { id: 'm1', role: 'manager' }

test('kgRank: a named entity ranks its readable chunks; hidden chunks give no score and no neighbor', async () => {
  const s = createKnowledgeSearcher(await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES }))
  assert.deepEqual(kgRank(KG, s, 'who checks claims, the finance team?', manager).map((x) => x.chunk.id), ['travel-policy:2:0'])
  assert.deepEqual(kgRank(KG, s, 'who checks claims, the finance team?', staff), [], 'e3 lives only in a hidden chunk')
  assert.deepEqual(kgRank(KG, s, '経理に聞けますか', staff), [])
  assert.deepEqual(kgRank(KG, s, 'hotel booking', staff).map((x) => x.chunk.id), ['travel-policy:1:0'], 'only the readable chunk of "hotel"')
  assert.deepEqual(kgRank(KG, s, 'anything', null), [])
  assert.throws(() => checkKnowledgeGraph({ version: 1, entities: [], relations: [{ from: 'x', to: 'y', type: 't', chunks: [] }] }), /bad relation/)
})

test('service with a graph: fused with BM25F; staff answers equal those without the hidden section', async () => {
  const full = createKnowledgeService(await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES }), { graph: KG })
  const cut = createKnowledgeService(await buildKnowledgeIndex([parseKnowledgeMarkdown(MD.replace(/## Expense limits[\s\S]*$/, '## Expense limits {#limits roles=admin,manager}\n'))], { roles: ROLES }), { graph: KG })
  assert.equal(full.mode(), 'lexical+graph')
  for (const q of ['finance team', 'hotel', 'travel desk', '経理', 'who checks hotel claims']) {
    assert.deepEqual(await full.search(q, { asker: staff, limit: 5 }), await cut.search(q, { asker: staff, limit: 5 }), q)
  }
  const m = await full.search('finance team', { asker: manager })
  assert.equal(m.results[0].id, 'travel-policy:2:0', 'the graph finds what BM25F alone also may — and for the manager only')
})
