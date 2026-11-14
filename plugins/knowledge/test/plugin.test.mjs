// bridge-knowledge without a business system: the tool spec, the result shape, the ledger, the module entry point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@dsh-bridge/dsh-core'
import knowledgeTools, { createKnowledgeTools, createSourceLedger, knowledgeToolName, knowledgeToolSpec, renderKnowledge, sourcesBlock, toKnowledgeResult } from '../src/index.js'

const ANSWER = {
  ok: true, query: 'q', found: true,
  results: [
    { id: 'doc:1:0', documentId: 'doc', title: 'Doc', heading: 'A', text: 'Rule A.', source: { title: 'Doc › A', url: '/handbook/doc#a' }, score: 3 },
    { id: 'doc:2:0', documentId: 'doc', title: 'Doc', heading: 'B', text: 'Rule B.', source: { title: 'Doc › B', url: 'javascript:alert(1)' }, score: 2 },
  ],
}

test('the spec: GET with q / limit; numbered results; a source that is not a screen path or http(s) URL is dropped', async () => {
  const calls = []
  const spec = knowledgeToolSpec({ name: 'lr_knowledge_search', requestJson: async (...a) => { calls.push(a); return ANSWER }, systemName: 'LR' })
  assert.equal(spec.access, 'read')
  assert.match(spec.description, /^Read-only: searches the documents of LR that THIS employee may read/)
  const r = await spec.execute({ question: '  carry over  ', limit: 2 }, { sessionId: 's1' })
  assert.deepEqual(calls[0], ['lr_knowledge_search', '/bridge/v1/knowledge/search', { q: 'carry over', limit: '2' }])
  assert.deepEqual(r.results.map((x) => [x.n, x.source.url]), [[1, '/handbook/doc#a'], [2, null]])
  assert.deepEqual(spec.ledger.recent('s1').map((s) => s.n), [1, 2])
  assert.equal(toKnowledgeResult({ id: 'x', source: { url: 'https://lr.example/handbook/x' } }, 1).source.url, 'https://lr.example/handbook/x')
  assert.equal(toKnowledgeResult({ id: 'x', source: { url: '//evil.example/x' } }, 1).source.url, null, 'protocol-relative = another host')
  assert.match(renderKnowledge(r)[0].text, /url: none/)
  assert.equal(sourcesBlock(r.results.slice(0, 1)), 'Sources:\n[1] Doc › A — /handbook/doc#a')
})

test('the ledger: sources only, per conversation, forgotten after the TTL; bounded', () => {
  let t = 0
  const ledger = createSourceLedger({ ttlMs: 1000, max: 2, now: () => t })
  ledger.remember('a', [{ n: 1, text: 'secret text', source: { title: 'T', url: '/x' } }])
  assert.deepEqual(ledger.recent('a'), [{ n: 1, source: { title: 'T', url: '/x' } }])
  t = 1001
  assert.deepEqual(ledger.recent('a'), [])
  ledger.remember('b', []); ledger.remember('c', []); ledger.remember('d', [])
  assert.equal(ledger.size(), 2)
  ledger.remember(null, [])
  assert.equal(ledger.size(), 2)
})

test('the tool module: <namespace>_knowledge_search with the kit of bridge-tools; no namespace = an error', async () => {
  const kit = { namespace: 'leave', application: () => ({ name: 'Leave Requests' }), requestJson: async () => ({ found: false, results: [] }), defineTool }
  const [tool] = knowledgeTools(kit)
  assert.equal(tool.name, knowledgeToolName('leave'))
  assert.equal(tool.access, 'read')
  assert.match(tool.description, /of Leave Requests that THIS employee/)
  assert.deepEqual(await tool.execute({ question: 'x' }, {}), { ok: true, found: false, results: [] })
  assert.throws(() => createKnowledgeTools({ ...kit, namespace: null }), /no namespace/)
  assert.equal(createKnowledgeTools({ ...kit, namespace: null }, { toolName: 'other_knowledge_search' })[0].name, 'other_knowledge_search')
})
