// bridge-knowledge end to end on expense-claims: the plugin's tool, wrapped the way bridge-tools wraps a tool module
// (@dsh-bridge/dsh-core's defineTool + guardTool + createToolRequester + createBusinessApi), calls the running system with
// the asking employee's delegation. The gate here hands out the delegation of the employee named by the test conversation —
// in DSH, bridge-tools' createDelegationGate finds it from the IM sender or the web assistant.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBusinessApi, createToolRequester, defineTool, guardTool } from '@dsh-bridge/dsh-core'
import knowledgeTools, { checkCitations, createSourceLedger, createKnowledgeTools, ensureCitations, knowledgeRules } from '@dsh-bridge/plugin-knowledge'
import { canSee } from '@dsh-bridge/knowledge'
import { SERVICE, manifestWithKnowledgeRoles, startWithPeople } from './helpers.mjs'

const APP_ID = 'expense-claims'
let env
const tokens = new Map() // conversation id -> delegation token of its employee

function toolFor(e, { ledger } = {}) {
  const application = {
    id: APP_ID, name: 'Expense Claims', namespace: 'expense', paths: {},
    api: createBusinessApi({ applicationId: APP_ID, label: 'expense-claims API', baseUrl: () => e.srv.base, serviceToken: () => SERVICE }),
  }
  const requester = createToolRequester({ application: () => application })
  const kit = { applicationId: APP_ID, application: () => application, namespace: 'expense', requestJson: requester.requestJson, defineTool }
  const [tool] = ledger ? createKnowledgeTools(kit, { sources: ledger }) : knowledgeTools(kit)
  const gate = {
    async authorize(_name, exec) {
      const token = tokens.get(exec.sessionId)
      if (!token) throw new Error(`${tool.name}: not allowed — no linked employee`)
      return { mode: 'delegated', delegationToken: token, applicationId: APP_ID, cacheKey: exec.sessionId }
    },
    forget() {},
  }
  return guardTool(gate, tool, { write: false })
}

async function conversationOf(e, person, id) {
  const headers = await e.delegated(person)
  tokens.set(id, headers['x-delegation-token'])
  return { sessionId: id }
}

before(async () => { env = await startWithPeople() })
after(() => env?.srv.stop())

test('the tool runs as the asking employee: a manager gets the approval limits with their source, an administrator the audit, staff neither', async () => {
  const ledger = createSourceLedger()
  const tool = toolFor(env, { ledger })
  assert.equal(tool.name, 'expense_knowledge_search')
  const index = env.srv.app.knowledge.index()
  const byId = new Map(index.chunks.map((c) => [c.id, c]))

  const m = await tool.execute({ question: 'Up to what amount can I approve a claim as a manager?' }, await conversationOf(env, env.people.manager, 'c-manager'))
  assert.equal(m.found, true)
  assert.equal(m.results[0].id, 'expense-policy:8:0')
  assert.deepEqual(m.results[0].source, { title: 'Expense policy › Approval limits for managers', url: '/handbook/expense-policy#approval-limits' })
  assert.deepEqual(m.results.map((x) => x.n), m.results.map((_, i) => i + 1))
  assert.deepEqual(ledger.recent('c-manager').map((s) => s.source.url), m.results.map((x) => x.source.url), 'the ledger keeps sources only')
  assert.ok(!('text' in ledger.recent('c-manager')[0]))

  const ja = await tool.execute({ question: '毎月の監査では何件抽出しますか' }, await conversationOf(env, env.people.admin, 'c-admin'))
  assert.equal(ja.results[0].source.url, '/handbook/kansa-tejun#sample')

  for (const person of [env.people.staff1, env.people.staff3]) {
    const exec = await conversationOf(env, person, `c-${person.id}`)
    for (const question of ['Up to what amount can a manager approve a claim?', 'split claims', 'monthly audit sample', '上長の承認上限', '監査記録の保存期間', 'how to check a claim before approving']) {
      const r = await tool.execute({ question, limit: 5 }, exec)
      for (const x of r.results) assert.ok(canSee(byId.get(x.id).visibility, { id: person.id, role: 'staff' }), `staff got ${x.id}`)
    }
  }
})

test('the rendered output makes the model cite, and found=false tells it not to guess', async () => {
  const tool = toolFor(env)
  const exec = await conversationOf(env, env.people.staff1, 'c-render')
  const r = await tool.execute({ question: 'I lost my receipt. What can I do?' }, exec)
  const text = tool.output.render({}, r)[0].text
  assert.match(text, /Answer ONLY from them\. Cite every statement with its number/)
  assert.match(text, /## \[1\] Expense policy › Receipts\n/)
  assert.match(text, /url: \/handbook\/expense-policy#receipts/)
  const none = await tool.execute({ question: 'monthly audit sample retention' }, exec)
  assert.deepEqual(none, { ok: true, found: false, results: [] })
  assert.match(tool.output.render({}, none)[0].text, /found=false: the documents this employee may read have nothing.*\nSay so plainly/)
  assert.doesNotMatch(tool.output.render({}, none)[0].text, /hidden|restricted|permission/i, 'no hint that something exists')
})

test('citations: an answer must cite [n] with the source URL as returned; ensureCitations repairs one that does not', async () => {
  const tool = toolFor(env)
  const r = await tool.execute({ question: 'I lost my receipt. What can I do?' }, await conversationOf(env, env.people.staff2, 'c-cite'))
  const good = `A lost-receipt statement replaces a receipt for up to 3,000 yen [1].\n\nSources:\n[1] ${r.results[0].source.title} — ${r.results[0].source.url}`
  assert.deepEqual(checkCitations(good, r.results), { ok: true, cited: [1], unknown: [], missingUrls: [], reason: null })
  assert.equal(checkCitations('Up to 3,000 yen.', r.results).reason, 'no_citation')
  assert.equal(checkCitations('Up to 3,000 yen [7].', r.results).reason, 'unknown_citation')
  assert.equal(checkCitations('Up to 3,000 yen [1].', r.results).reason, 'source_url_missing')
  const fixed = ensureCitations('Up to 3,000 yen [1][7].', r.results)
  assert.match(fixed, /\[1\]\[\?\]\.\n\nSources:\n\[1\] Expense policy › Receipts — \/handbook\/expense-policy#receipts$/)
  assert.equal(checkCitations(fixed, r.results).ok, true, 'the repaired answer passes ([7] became [?], the source is listed)')
  assert.equal(ensureCitations(good, r.results), good)
  assert.match(knowledgeRules('expense_knowledge_search'), /Always call expense_knowledge_search and answer ONLY/)
})

test('the tool refuses arguments that try to choose whose rights or which document', async () => {
  const tool = toolFor(env)
  const exec = await conversationOf(env, env.people.staff1, 'c-args')
  await assert.rejects(tool.execute({ question: 'x', role: 'admin' }, exec), /role not accepted — read-only/)
  await assert.rejects(tool.execute({ question: 'x', documentId: 'audit-procedure' }, exec), /documentId not accepted/)
  await assert.rejects(tool.execute({ question: 'x', url: 'https://evil.example' }, exec), /url not accepted/)
  await assert.rejects(tool.execute({}, exec), /"question" is required/)
  await assert.rejects(tool.execute({ question: 'x', limit: 9 }, exec), /"limit" must be an integer 1–5/)
  await assert.rejects(tool.execute({ question: 'x' }, { sessionId: 'not-linked' }), /not allowed — no linked employee/)
})

test('delegation × role: with the knowledge tool for managers only, a staff member\'s AI is refused by the business system', async () => {
  const e = await startWithPeople({ manifest: manifestWithKnowledgeRoles(['admin', 'manager']) })
  try {
    const tool = toolFor(e)
    await assert.rejects(tool.execute({ question: 'lost receipt' }, await conversationOf(e, e.people.staff1, 'c-staff-denied')), (err) => err.status === 403 && /delegation_not_permitted/.test(err.message))
    const ok = await tool.execute({ question: 'lost receipt' }, await conversationOf(e, e.people.manager, 'c-manager-ok'))
    assert.equal(ok.found, true)
  } finally {
    await e.srv.stop()
  }
})
