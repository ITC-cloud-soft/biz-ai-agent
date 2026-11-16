#!/usr/bin/env node
// A LOCAL FAKE MODEL for trying the settings plugin without any real model or key (development only; never in production).
// OpenAI-compatible: POST /v1/embeddings (hashed character bigrams / words → 64 numbers) and POST /v1/chat/completions (the
// connection test → {"ok":true}; a knowledge-graph extraction → the known terms of the text as entities). It understands nothing:
// it only makes the RAG and knowledge-graph paths (pgvector, the graph JSON, approvals, reports) runnable on one machine.
//   MOCK_MODEL_PORT (19760) · it accepts any API key
import http from 'node:http'
import { termsOf } from '@dsh-bridge/knowledge'

const TERMS = [
  ['annual leave', 'rule'], ['carry-over', 'rule'], ['sick leave', 'rule'], ['manager', 'role'], ['administrator', 'role'], ['approval', 'rule'],
  ['leave request', 'thing'], ['team coverage', 'rule'], ['remote work', 'rule'], ['laptop', 'thing'], ['locker', 'thing'],
  ['有給休暇', 'rule'], ['繰り越し', 'rule'], ['管理職', 'role'], ['慶弔休暇', 'rule'], ['振替休日', 'rule'], ['診断書', 'thing'],
  ['年假', 'rule'], ['病假', 'rule'], ['调休', 'rule'], ['经理', 'role'], ['审批', 'rule'],
]
function embedding(text) {
  const v = new Array(64).fill(0)
  for (const t of termsOf(text)) {
    let h = 2166136261
    for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0
    v[h % 64] += 1
  }
  return v
}
function extraction(text) {
  const lower = text.toLowerCase()
  const entities = TERMS.filter(([n]) => lower.includes(n.toLowerCase())).map(([name, type]) => ({ name, type }))
  const roles = entities.filter((e) => e.type === 'role')
  const rules = entities.filter((e) => e.type !== 'role')
  const relations = roles.flatMap((r) => rules.slice(0, 3).map((x) => ({ from: r.name, to: x.name, type: 'applies' })))
  return { entities, relations }
}
const port = Number(process.env.MOCK_MODEL_PORT || 19760)
http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* empty */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-chat' }, { id: 'mock-embedding' }] }))
    if (req.url.startsWith('/v1/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [String(body.input ?? '')]
      return res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embedding(t) })) }))
    }
    const user = String(body.messages?.at(-1)?.content ?? '')
    const content = /connection test/.test(user) ? { ok: true } : extraction(user)
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }))
  })
}).listen(port, '127.0.0.1', () => console.log(`mock model (fake, development only) on http://127.0.0.1:${port}/v1`))
