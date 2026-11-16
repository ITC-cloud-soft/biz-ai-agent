// help-tool.js and the manifest's help.tool: the manual search tool (generated for a manifest that declares it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HELP_RULES_JA, helpRules, helpToolSpec, manifestTools, renderHelp, toHelpResult } from '../src/index.js'

const RESULT = {
  id: 'manual-a', title: 'ログイン', menu: '画面の「ログイン」', summary: 'ログインします。', steps: ['入れる', '押す'], qa: [{ q: 'できない', a: '管理者へ' }],
  notes: [], app: null, canOpen: true, url: 'https://eq.test/', manualUrl: null, alt: null, unconfirmed: [],
}

test('helpToolSpec: GET with the question; URLs as returned, none for a screen the asker cannot open; write-like arguments refused', async () => {
  const calls = []
  const requestJson = async (tool, path, query) => {
    calls.push({ tool, path, query })
    if (query.q === 'none') return { found: false, results: [] }
    return { found: true, results: [RESULT, { ...RESULT, id: 'manual-b', canOpen: false, url: 'https://eq.test/x', alt: '設備責任者にご依頼ください。' }] }
  }
  const spec = helpToolSpec({ name: 'facility_help_search', requestJson, systemName: '設備点検' })
  assert.equal(spec.access, 'read')
  assert.match(spec.description, /^Read-only: searches the staff manual of 設備点検/)
  const r = await spec.execute({ question: '  ログインできない ', limit: 2 })
  assert.deepEqual(calls.at(-1), { tool: 'facility_help_search', path: '/bridge/v1/help/search', query: { q: 'ログインできない', limit: '2' } })
  assert.deepEqual(r.results.map((x) => [x.id, x.url]), [['manual-a', 'https://eq.test/'], ['manual-b', null]])
  const text = renderHelp(r)[0].text
  assert.match(text, /url: https:\/\/eq\.test\/\n/)
  assert.match(text, /url: none \(canOpen=false\) — 設備責任者にご依頼ください。/)
  assert.deepEqual(await spec.execute({ question: 'none' }), { ok: true, found: false, results: [] })
  assert.match(renderHelp({ found: false, results: [] })[0].text, /found=false/)
  await assert.rejects(spec.execute({}), /"question" is required/)
  await assert.rejects(spec.execute({ question: 'x', url: 'https://evil' }), /url not accepted — read-only/)
  await assert.rejects(spec.execute({ question: 'x', limit: 0 }), /"limit" must be an integer/)
  await assert.rejects(spec.execute({ question: 'x', foo: 1 }), /unknown argument/)
  assert.equal(toHelpResult({ canOpen: false, url: 'https://x' }).url, null)
})

test('manifestTools: the tool named by manifest.help.tool is generated as the manual search', async () => {
  const manifest = {
    help: { tool: 'facility_help_search' },
    tools: [
      { name: 'facility_help_search', description: '使い方', http: 'GET /bridge/v1/help/search', access: 'read', roles: ['admin'], input: { type: 'object', properties: { question: { type: 'string' } } } },
      { name: 'facility_list', description: '一覧', http: 'GET /api/list', access: 'read', roles: ['admin'] },
    ],
  }
  const app = { id: 'eq', name: '設備点検', namespace: 'facility', manifest: () => manifest }
  const calls = []
  const { tools } = manifestTools(app, { requestJson: async (tool, path, query) => { calls.push([tool, path, query]); return { found: true, results: [RESULT] } } })
  const help = tools.find((t) => t.name === 'facility_help_search')
  assert.match(help.description, /searches the staff manual of 設備点検/)
  const r = await help.execute({ question: 'ログイン' })
  assert.equal(r.results[0].url, 'https://eq.test/')
  assert.deepEqual(calls.at(-1), ['facility_help_search', '/bridge/v1/help/search', { q: 'ログイン' }])
  assert.match(help.output.render({}, r)[0].text, /## 1\. ログイン/)
  // the other tool stays a generic one
  assert.match(tools.find((t) => t.name === 'facility_list').description, /generated from the business manifest/)
})

test('helpRules: the persona rules with the tool name', () => {
  assert.match(HELP_RULES_JA, /\{tool\}/)
  const rules = helpRules('facility_help_search')
  assert.ok(!rules.includes('{tool}'))
  assert.match(rules, /必ず facility_help_search を呼び/)
  assert.match(rules, /【ご案内】/)
})
