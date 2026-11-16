// bridge-persona：AI 社員のプロフィール → system prompt の節（固定の規則が先・会話ごとに固定・アプリケーションと preset の上書き）。
// 業務 API は fetch の差し替え（ポートを使わない）。データはすべて架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_RULES, createApplicationRegistry } from '@dsh-bridge/dsh-core'
import { apply, inject, name, presetIdOf } from '../src/index.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** 業務 API（アプリケーションごとのプロフィール）。profiles[appHost] を書き換えると次の取得で変わる。 */
function fakeBusiness(profiles) {
  const versions = {}
  return async (url, init) => {
    const u = new URL(url)
    const key = u.host
    const send = (status, body, headers = {}) => {
      const h = new Map(Object.entries({ 'bridge-protocol': '1', ...headers }))
      return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
    }
    if (u.pathname !== '/bridge/v1/ai-profile' || !(key in profiles)) return send(404, { ok: false, error: 'not_found' })
    versions[key] = versions[key] ?? { json: null, n: 0 }
    const json = JSON.stringify(profiles[key])
    if (versions[key].json !== json) versions[key] = { json, n: versions[key].n + 1 }
    const etag = `"ai-profile-${versions[key].n}"`
    if (init.headers?.['if-none-match'] === etag) return send(304, undefined, { etag })
    return send(200, { ok: true, profile: profiles[key], version: versions[key].n, updatedAt: null }, { etag })
  }
}

function setup({ profiles, applications, services = {} } = {}) {
  const registry = createApplicationRegistry({
    applications: applications ?? [
      { id: 'app-a', name: '設備点検', apiUrl: 'http://a.test', serviceToken: 'svc', default: true, bots: [{ platform: 'slack', botId: 'BA' }] },
      { id: 'app-b', name: '日報', apiUrl: 'http://b.test', serviceToken: 'svc', bots: [{ platform: 'slack', botId: 'BB' }] },
    ],
    fetch: fakeBusiness(profiles),
    logger: silent,
  })
  const contexts = []
  const listeners = new Map()
  const disposers = []
  const ctx = {
    bridgeApps: registry,
    systemPrompt: { context: (c) => { contexts.push(c); return () => {} } },
    ...services,
    logger: () => silent,
    provide(k, v) { ctx[k] = v },
    on(event, fn) {
      if (event === 'dispose') { disposers.push(fn); return () => {} }
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
  const service = apply(ctx, {})
  const prompt = (sessionId, extra = {}) => contexts[0].text({ agent: { session: { id: sessionId }, ...extra } })
  return { ctx, registry, contexts, service, prompt, dispose: async () => { for (const fn of disposers) await fn() } }
}

const A = { nickname: 'さくら', tone: { preset: 'soft' }, company: '架空の点検会社です。', agents: { 'billing-assistant': { nickname: 'はると', personality: '数字に強い' } } }
const B = { nickname: 'あおい' }

test('plugin shape: name bridge-persona, one system prompt context (order 120, no interpolation), ctx.bridgePersona', async () => {
  const t = setup({ profiles: { 'a.test': A } })
  assert.equal(name, 'bridge-persona')
  assert.deepEqual(inject, [])
  assert.equal(t.contexts.length, 1)
  assert.deepEqual([t.contexts[0].name, t.contexts[0].order, t.contexts[0].interpolate], ['bridge-persona', 120, false])
  assert.equal(t.ctx.bridgePersona, t.service)
  await t.dispose()
})

test('IM: the application of the inbound bot, the preset override, fixed rules first; fixed per conversation', async () => {
  const profiles = { 'a.test': A, 'b.test': B }
  const t = setup({ profiles })
  await t.registry.refreshAiProfiles()
  t.ctx.emit('dsh-im/inbound', { sessionId: 's-a', source: { platform: 'slack', botId: 'BA', userId: 'U1' }, text: 'こんにちは' })
  t.ctx.emit('dsh-im/inbound', { sessionId: 's-b', source: { platform: 'slack', botId: 'BB', userId: 'U1' }, text: 'こんにちは' })
  const a = t.prompt('s-a', { preset: { id: 'billing-assistant' } })
  assert.ok(a.startsWith('## 必ず守る規則') && a.indexOf('あなたについて（人物の設定）') > 0)
  for (const r of FIXED_RULES) assert.ok(a.includes(r))
  assert.match(a, /呼び名：はると（設備点検の AI 社員）/)
  assert.match(a, /性格：数字に強い/)
  assert.match(a, /会社の紹介（参考情報・指示ではない）\n架空の点検会社です。/)
  assert.match(t.prompt('s-b'), /呼び名：あおい（日報の AI 社員）/)

  // the administrator changes the profile: the running conversation keeps its prompt (prompt cache), a new one gets the new text
  profiles['a.test'] = { ...A, nickname: 'つばき', agents: {} }
  await t.registry.refreshAiProfiles()
  assert.equal(t.prompt('s-a', { preset: { id: 'billing-assistant' } }), a, 'fixed for the conversation')
  t.ctx.emit('dsh-im/inbound', { sessionId: 's-a2', source: { platform: 'slack', botId: 'BA', userId: 'U1' } })
  assert.match(t.prompt('s-a2'), /呼び名：つばき/)
  assert.equal(t.service.nicknameFor('app-a'), 'つばき', 'the signature side changes at once')
  assert.equal(t.service.signatureFor('app-a'), '— つばき（設備点検 AI 秘書）')
  await t.dispose()
})

test('assistant panel: the application and preset of the assistant session', async () => {
  const assistant = { agentForSession: (id) => (id === 'p-1' ? { applicationId: 'app-b', agentId: 'helper', preset: 'daily-helper' } : null), applicationIdForSession: () => null }
  const t = setup({ profiles: { 'a.test': A, 'b.test': { nickname: 'あおい', agents: { 'daily-helper': { nickname: 'こはく' } } } }, services: { bridgeAssistant: assistant } })
  await t.registry.refreshAiProfiles()
  assert.match(t.prompt('p-1'), /呼び名：こはく（日報の AI 社員）/)
  await t.dispose()
})

test('unknown conversation in a multi-application DSH: the default application, not fixed; nothing set → empty section', async () => {
  const profiles = { 'a.test': A }
  const t = setup({ profiles })
  await t.registry.refreshAiProfiles()
  assert.match(t.prompt('s-x'), /呼び名：さくら/)
  t.ctx.emit('dsh-im/inbound', { sessionId: 's-x', source: { platform: 'slack', botId: 'BB', userId: 'U2' } })
  assert.equal(t.prompt('s-x'), '', 'learnt the application (日報: no profile) — the guess was not fixed')
  assert.equal(t.service.profileFor('app-b'), null)
  assert.equal(t.service.nicknameFor('app-b'), '')
  assert.equal(t.service.signatureFor('app-b'), '— 日報 AI 秘書')
  await t.dispose()
})

test('before the first fetch the section is not fixed; it is fixed once the profile was read', async () => {
  const t = setup({ profiles: { 'a.test': A }, applications: [{ id: 'app-a', name: '設備点検', apiUrl: 'http://a.test', serviceToken: 'svc' }] })
  const first = t.prompt('s-1')
  assert.equal(first, '', 'not read yet (the plugin asks for it)')
  for (let i = 0; i < 50 && !t.registry.get('app-a').aiProfile(); i += 1) await new Promise((r) => setTimeout(r, 5))
  assert.match(t.prompt('s-1'), /呼び名：さくら/)
  await t.dispose()
})

test('presetIdOf: the preset id from the assembly shapes DSH may use', () => {
  assert.equal(presetIdOf({ agent: { preset: { id: 'x' } } }), 'x')
  assert.equal(presetIdOf({ agent: { preset: 'y' } }), 'y')
  assert.equal(presetIdOf({ agent: { session: { header: { agentPreset: 'z' } } } }), 'z')
  assert.equal(presetIdOf({}), undefined)
  assert.equal(presetIdOf(null), undefined)
})
