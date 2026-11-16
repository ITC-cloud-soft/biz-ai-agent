// @dsh-bridge/agent-settings without a server: keys, settings validation, the model clients, the graph build, the stores, the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildKnowledgeIndex, parseKnowledgeMarkdown } from '@dsh-bridge/knowledge'
import {
  applySettingsPatch, buildKnowledgeGraph, cleanExtraction, createChat, createDocumentStore, createFileVectorStore, defaultSettings, dshOverlay,
  endpointOf, keyStatus, masterKeyFrom, publicSettings, resolveKey, seal, testConnection, unseal,
} from '../src/index.mjs'
import { CSP, asset, pickLang, settingsShell } from '../src/screen.mjs'

const ROLES = ['admin', 'manager', 'staff']
const MASTER = 'ab'.repeat(32)

test('keys: sealed with the master key, resolved env-first, never shown', () => {
  const mk = masterKeyFrom({ AGENT_SETTINGS_KEY: MASTER })
  assert.equal(masterKeyFrom({}), null)
  assert.throws(() => masterKeyFrom({ AGENT_SETTINGS_KEY: 'short' }), /32 bytes/)
  const sealed = seal(mk, 'sk-test-0000-abcd')
  assert.ok(!sealed.includes('sk-test'))
  assert.equal(unseal(mk, sealed), 'sk-test-0000-abcd')
  assert.equal(resolveKey({ apiKeyEnv: 'MY_KEY', apiKey: sealed }, { env: { MY_KEY: 'from-env' }, masterKey: mk }), 'from-env')
  assert.equal(resolveKey({ apiKeyEnv: 'MY_KEY', apiKey: sealed }, { env: {}, masterKey: mk }), 'sk-test-0000-abcd')
  assert.deepEqual(keyStatus({ apiKey: sealed }, { env: {}, masterKey: mk }), { set: true, source: 'stored', hint: '…abcd' })
  assert.deepEqual(keyStatus({ apiKeyEnv: 'MY_KEY' }, { env: { MY_KEY: 'x' } }), { set: true, source: 'env', hint: null })
})

test('settings: strict patch; a key needs the master key; the public view has no key', () => {
  const s0 = defaultSettings()
  assert.equal(s0.knowledge.mode, 'bm25f')
  assert.throws(() => applySettingsPatch(s0, { llm: { base: { colour: 'red' } } }, { roles: ROLES }), /unknown key/)
  assert.throws(() => applySettingsPatch(s0, { llm: { base: { baseUrl: 'file:///etc' } } }, { roles: ROLES }), (e) => e.code === 'invalid_url')
  assert.throws(() => applySettingsPatch(s0, { llm: { base: { baseUrl: 'https://u:p@x.example' } } }, { roles: ROLES }), (e) => e.code === 'invalid_url')
  assert.throws(() => applySettingsPatch(s0, { llm: { base: { apiKeyEnv: 'lower-case' } } }, { roles: ROLES }), (e) => e.code === 'invalid_env_name')
  assert.throws(() => applySettingsPatch(s0, { llm: { base: { apiKey: 'k-123' } } }, { roles: ROLES }), (e) => e.code === 'key_storage_disabled')
  assert.throws(() => applySettingsPatch(s0, { knowledge: { mode: 'rag' } }, { roles: ROLES }), (e) => e.code === 'embedding_required')
  assert.throws(() => applySettingsPatch(s0, { sns: { approverRoles: ['boss'] } }, { roles: ROLES }), (e) => e.code === 'invalid_roles')
  const mk = masterKeyFrom({ AGENT_SETTINGS_KEY: MASTER })
  const s1 = applySettingsPatch(s0, { llm: { base: { baseUrl: 'https://llm.example/v1/', model: 'test-model', apiKey: 'sk-test-9999' }, embedding: { enabled: true, model: 'emb' } }, knowledge: { mode: 'rag' } }, { roles: ROLES, masterKey: mk })
  assert.equal(s1.llm.base.baseUrl, 'https://llm.example/v1')
  const pub = publicSettings(s1, { env: {}, masterKey: mk })
  assert.ok(!JSON.stringify(pub).includes('sk-test') && !('apiKey' in pub.llm.base))
  assert.deepEqual(pub.llm.base.key, { set: true, source: 'stored', hint: '…9999' })
  assert.equal(applySettingsPatch(s1, { llm: { base: { apiKey: '' } } }, { roles: ROLES, masterKey: mk }).llm.base.apiKey, null, 'cleared')
})

test('model clients: endpoints, JSON answers, connection test codes without bodies; the DSH overlay names the variable only', async () => {
  assert.equal(endpointOf({ kind: 'openai', baseUrl: 'https://x/v1', model: 'm' }, 'embeddings'), 'https://x/v1/embeddings')
  assert.match(endpointOf({ kind: 'azure-openai', baseUrl: 'https://r.openai.azure.com', model: 'dep' }, 'chat/completions'), /^https:\/\/r\.openai\.azure\.com\/openai\/deployments\/dep\/chat\/completions\?api-version=/)
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    if (url.includes('bad')) return new Response('echo of the secret input', { status: 401 })
    return Response.json({ choices: [{ message: { content: '```json\n{"ok": true}\n```' } }] })
  }
  const chat = createChat({ kind: 'openai', baseUrl: 'https://x/v1', model: 'm' }, 'key-1', { fetch })
  assert.deepEqual(await chat.json([{ role: 'user', content: 'hi' }]), { ok: true })
  assert.equal(seen[0].headers.authorization, 'Bearer key-1')
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' })
  assert.deepEqual((await testConnection('base', { kind: 'openai', baseUrl: 'https://bad/v1', model: 'm' }, 'k', { fetch })).error, 'http_401')
  assert.equal((await testConnection('base', { kind: 'openai', baseUrl: '', model: '' }, 'k', { fetch })).error, 'not_configured')
  assert.equal((await testConnection('base', { kind: 'openai', baseUrl: 'https://x/v1', model: 'm' }, null, { fetch })).error, 'no_key')
  const y = dshOverlay({ kind: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'ACME_LLM_KEY', apiKey: 'v1:sealed' })
  assert.match(y, /apiKeyEnv: ACME_LLM_KEY/)
  assert.doesNotMatch(y, /sealed/)
})

const MD = `---
id: travel-policy
title: Travel policy
link: /handbook/travel-policy
roles: [admin, manager, staff]
---
## Booking {#booking}
Book trains through the travel desk.

## Limits {#limits roles=admin,manager}
The finance team checks hotel claims.
`

test('graph build: names / types / chunk IDs only, flagged names dropped, unchanged chunks cached', async () => {
  const index = await buildKnowledgeIndex([parseKnowledgeMarkdown(MD)], { roles: ROLES })
  let calls = 0
  const chat = {
    model: 'fake',
    async json(messages) {
      calls += 1
      const text = messages[1].content
      if (/finance team/.test(text)) return { entities: [{ name: 'Finance team', type: 'Team' }, { name: 'hotel claim', type: 'thing' }, { name: 'Taro Example', type: 'person' }], relations: [{ from: 'Finance team', to: 'hotel claim', type: 'checks' }, { from: 'Taro Example', to: 'hotel claim', type: 'files' }] }
      return { entities: [{ name: 'travel desk', type: 'team' }, { name: 'x', type: '??' }], relations: [{ from: 'travel desk', to: 'nobody', type: 'r' }] }
    },
  }
  const screen = async (t) => ({ kinds: /Taro/.test(t) ? ['staff_name'] : [] })
  const { kg, stats } = await buildKnowledgeGraph(index, { chat, screen })
  const byName = (list) => [...list].sort((a, b) => a[0].localeCompare(b[0]))
  assert.deepEqual(byName(kg.entities.map((e) => [e.name, e.type, e.chunks])), byName([
    ['travel desk', 'team', ['travel-policy:0:0']], ['Finance team', 'team', ['travel-policy:1:0']], ['hotel claim', 'thing', ['travel-policy:1:0']],
  ]))
  assert.ok(!kg.entities.some((e) => /Taro/.test(e.name)), 'the flagged name is gone, and its relation')
  assert.deepEqual(kg.relations.map((r) => r.type), ['checks'])
  assert.ok(!JSON.stringify(kg).includes('Book trains'), 'no chunk text in the file')
  assert.equal(stats.dropped, 1)
  const before = calls
  const again = await buildKnowledgeGraph(index, { chat, screen, previous: kg })
  assert.equal(calls, before, 'nothing sent again for unchanged chunks')
  assert.equal(again.stats.cached, index.chunks.length)
  assert.deepEqual(cleanExtraction({ entities: [{ name: 'A' }, { name: 'ab', type: 'Big Type!' }] }).entities, [{ name: 'ab', type: 'big_type' }])
})

test('stores: the file vector store keeps hashes, not text; documents get ids and statuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-'))
  try {
    const vs = createFileVectorStore(join(dir, 'vectors.json'))
    const cache = vs.cache()
    cache.set('emb:1\u0000secret text', Float32Array.from([0.5, 0.25]))
    assert.equal(vs.save(cache, ['emb:1\u0000secret text']), 1)
    assert.ok(!readFileSync(join(dir, 'vectors.json'), 'utf8').includes('secret text'))
    const again = createFileVectorStore(join(dir, 'vectors.json')).cache()
    assert.deepEqual(Array.from(again.get('emb:1\u0000secret text')), [0.5, 0.25])
    const docs = createDocumentStore(join(dir, 'documents'))
    assert.equal(docs.newId('Remote Work Rules'), 'remote-work-rules')
    assert.match(docs.newId('在宅勤務の規程'), /^doc-[0-9a-f]{6}$/)
    docs.save({ id: 'remote-work-rules', title: 'Remote', roles: ['staff'], status: 'pending', uploadedAt: '2026-11-15T00:00:00Z' }, 'text')
    assert.equal(docs.text('remote-work-rules'), 'text')
    assert.match(docs.newId('Remote Work Rules'), /^remote-work-rules-[0-9a-f]{6}$/)
    docs.dropText('remote-work-rules')
    assert.equal(docs.text('remote-work-rules'), null)
    assert.equal(docs.get('../etc'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('screen: the app shell — language, config as JSON that cannot close its script, assets from dist only', () => {
  assert.equal(pickLang(null, 'zh-CN,zh;q=0.9'), 'zh')
  assert.equal(pickLang('en', 'ja'), 'en')
  assert.equal(pickLang(null, 'fr'), 'ja')
  const html = settingsShell({ lang: 'zh', roles: ['admin', '</script><script>alert(1)</script>'], system: { name: 'Leave Requests' }, user: { id: 'u1', role: 'admin' }, gateway: { rpcBase: '/dsh/api/dsh-im' } })
  assert.match(html, /<html lang="zh-CN">[\s\S]*<title>AI 代理设置<\/title>/)
  assert.ok(!html.includes('</script><script>alert(1)'), 'the config JSON is escaped')
  const cfg = JSON.parse(/<script type="application\/json" id="agent-settings-config">([^<]*)<\/script>/.exec(html)[1])
  assert.deepEqual([cfg.lang, cfg.gateway, cfg.user], ['zh', { rpcBase: '/dsh/api/dsh-im' }, { id: 'u1', role: 'admin' }])
  assert.doesNotMatch(html, /src="http|href="http/, 'no external resource')
  assert.match(CSP, /script-src 'self';/)
  assert.ok(asset('app.js')?.body.length > 1000, 'built app (npm run build)')
  assert.equal(asset('../src/index.mjs'), null)
  assert.equal(asset('chunks/../../package.json'), null)
  assert.equal(asset('nothing.js'), null)
})
