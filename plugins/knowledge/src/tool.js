// The AI employee's knowledge tool: the business system's permission-aware search (GET /bridge/v1/knowledge/search), read-only,
// run as the employee who asked (the bridge-tools delegation gate). The plugin keeps no index and no text: the business system
// decides what this employee may read, every time.
//
// The answer must cite: every result is numbered [n] with its source (a business screen URL exactly as returned); the rendered
// tool output tells the model to cite with [n] and to end with a "Sources:" block (citations.js checks / repairs an answer).
import { createSourceLedger } from './ledger.js'

export const KNOWLEDGE_SEARCH_PATH = '/bridge/v1/knowledge/search'
const MAX_QUESTION = 200
const ARGS = Object.freeze(['question', 'limit'])
const WRITE_HINTS = Object.freeze(['url', 'urls', 'link', 'source', 'sources', 'answer', 'save', 'document', 'documentId', 'role', 'userId', 'asUser'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, max = 2000) => (typeof v === 'string' && v ? v.slice(0, max) : null)

/** One result of the search: the fields an answer may use (n = the citation number). */
export function toKnowledgeResult(r, n) {
  const url = str(r?.source?.url, 500)
  return {
    n,
    id: str(r?.id, 200),
    documentId: str(r?.documentId, 100),
    title: str(r?.title, 120),
    heading: str(r?.heading, 200),
    text: str(r?.text, 1200) ?? '',
    // a source is a screen path or an http(s) URL — anything else is dropped, never shown to the model as a link
    source: { title: str(r?.source?.title, 300) ?? str(r?.title, 120) ?? '', url: url && /^(?:https?:\/\/[^\s/]+)?\/(?!\/)\S*$/.test(url) ? url : null },
  }
}

const text = (lines) => [{ type: 'text', text: lines.filter((line) => typeof line === 'string' && line !== '').join('\n') }]

/** What the model sees: numbered excerpts, each with its source, and the citation rule. */
export function renderKnowledge(r) {
  if (!r?.found) {
    return text([
      'found=false: the documents this employee may read have nothing on this question.',
      'Say so plainly and suggest asking the administrator. Do not answer from general knowledge and do not guess what other documents say.',
    ])
  }
  return text([
    `${r.results.length} excerpt(s) the employee may read. Answer ONLY from them. Cite every statement with its number, e.g. [1].`,
    'End the answer with "Sources:" and one line per cited excerpt: [n] title — url (write the url exactly as below; never build or edit one).',
    ...r.results.map((x) => [
      `## [${x.n}] ${x.source.title}`,
      x.text,
      `url: ${x.source.url ?? 'none'}`,
    ].join('\n')),
  ])
}

/**
 * The tool's spec (pass it to defineTool / return it from a bridge-tools tool module).
 * @param {object} o
 * @param {string} o.name             '<namespace>_knowledge_search'
 * @param {(tool, path, query) => Promise<any>} o.requestJson   the delegated request of the tool runtime (bridge-tools kit)
 * @param {string} [o.path]
 * @param {string} [o.systemName]
 * @param {object} [o.ledger]         createSourceLedger(): the sources per conversation, for a reply guard
 * @param {(exec) => string|null} [o.sessionIdOf]
 */
export function knowledgeToolSpec({ name, requestJson, path = KNOWLEDGE_SEARCH_PATH, systemName = 'the business system', ledger = createSourceLedger(), sessionIdOf = (exec) => exec?.agent?.session?.id ?? exec?.sessionId ?? null }) {
  return {
    name,
    access: 'read',
    description:
      `Read-only: searches the documents of ${systemName} that THIS employee may read (policies, handbooks, procedures) and returns `
      + 'numbered excerpts with their source screens. Call it for questions about company rules and procedures. Answer ONLY from the '
      + 'excerpts, cite each statement with [n], and end with "Sources:" listing [n] title — url exactly as returned. found=false: say the '
      + 'documents have no answer; never answer from general knowledge. The search already applies the employee\'s rights: never ask for '
      + 'or guess documents it did not return. question: a short sentence in the documents\' language. For business data use the business tools.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: `The question as a short sentence (max ${MAX_QUESTION} characters).` },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional: how many excerpts (default 3).' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, found: { type: 'boolean' }, results: { type: 'array' } }, required: ['ok', 'found'] },
      render: (_args, r) => renderKnowledge(r),
    },
    ledger,
    async execute(args = {}, exec) {
      if (!isObj(args)) throw new Error(`${name}: arguments must be an object`)
      const writes = Object.keys(args).filter((k) => WRITE_HINTS.includes(k))
      if (writes.length) throw new Error(`${name}: ${writes.join(', ')} not accepted — read-only; what the employee may read is decided by the business system`)
      const unknown = Object.keys(args).filter((k) => !ARGS.includes(k))
      if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
      if (typeof args.question !== 'string' || !args.question.trim()) throw new Error(`${name}: "question" is required`)
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) throw new Error(`${name}: "limit" must be an integer 1–5`)
      const question = args.question.trim().slice(0, MAX_QUESTION)
      const r = await requestJson(name, path, { q: question, ...(args.limit ? { limit: String(args.limit) } : {}) })
      const results = (Array.isArray(r?.results) ? r.results : []).map((x, i) => toKnowledgeResult(x, i + 1)).filter((x) => x.id)
      const out = { ok: true, found: Boolean(r?.found) && results.length > 0, results }
      ledger?.remember(sessionIdOf(exec), results)
      return out
    },
  }
}
