// agents.list の displayName：AI 社員の呼び名（業務システムのプロフィール、preset ごとの上書き）があればそれ、無ければ従来の name。
// agentForSession：アシスタントの会話の AI 社員（bridge-persona 用）。業務 API は fetch の差し替え（ポートを使わない）。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationRegistry } from '@dsh-bridge/dsh-core'
import { createAssistantService } from '../src/service.js'
import { mockHarness } from './helpers.mjs'

const TICKET = `tkt_${'d'.repeat(43)}`
const silent = { warn() {}, info() {}, debug() {} }

function fetchFor(profile) {
  return async (url) => {
    const path = new URL(url).pathname
    const send = (status, body) => ({ status, ok: status < 300, headers: { get: (k) => (k === 'bridge-protocol' ? '1' : null) }, text: async () => JSON.stringify(body) })
    if (path === '/bridge/v1/assistant/delegations') return send(201, { token: 'dlg-1', user: { id: 'u-0001', role: 'staff' }, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    if (path === '/bridge/v1/ai-profile') return profile ? send(200, { ok: true, profile, version: 1, updatedAt: null }) : send(404, { ok: false, error: 'not_found' })
    return send(404, { ok: false, error: 'not_found' })
  }
}

async function setup(profile) {
  const registry = createApplicationRegistry({
    logger: silent,
    fetch: fetchFor(profile),
    applications: [{ id: 'equipment-inspection', name: '設備点検', default: true, apiUrl: 'http://eq.test', serviceToken: 'svc' }],
  })
  await registry.refreshAiProfiles()
  const harness = mockHarness()
  const service = createAssistantService({
    registry,
    harness,
    logger: silent,
    agents: () => [
      { id: 'assistant', preset: 'business-assistant', name: 'AI アシスタント' },
      { id: 'billing', preset: 'billing-assistant', name: '請求アシスタント' },
    ],
  })
  return { service, harness }
}

test('agents.list: displayName = the nickname (per preset override) or the name; no preset ids leave', async () => {
  const { service } = await setup({ nickname: 'さくら', agents: { 'billing-assistant': { nickname: 'はると' } } })
  const r = await service.handleRpc('agents.list', { ticket: TICKET })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.agents.map((a) => [a.id, a.name, a.displayName]), [['assistant', 'AI アシスタント', 'さくら'], ['billing', '請求アシスタント', 'はると']])
  assert.equal(JSON.stringify(r.value).includes('preset'), false)

  const none = await setup(null)
  const r2 = await none.service.handleRpc('agents.list', { ticket: TICKET })
  assert.deepEqual(r2.value.agents.map((a) => a.displayName), ['AI アシスタント', '請求アシスタント'], 'without a profile: the name')
})

test('agentForSession: the AI employee of an assistant session (null for others)', async () => {
  const { service, harness } = await setup({ nickname: 'さくら' })
  assert.equal((await service.handleRpc('message.send', { ticket: TICKET, agent: 'billing', text: '今日の件数は？' })).ok, true)
  const [{ sessionId, agentPreset }] = harness.state.created
  assert.equal(agentPreset, 'billing-assistant')
  assert.deepEqual(service.agentForSession(sessionId), { applicationId: 'equipment-inspection', agentId: 'billing', preset: 'billing-assistant' })
  assert.equal(service.agentForSession('nope'), null)
})
