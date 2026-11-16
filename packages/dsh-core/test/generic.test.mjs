// The core without any compatibility profile: no business-system names, environment variables or routes are built in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_APPLICATION_ID, DEFAULT_DENY_HINTS, V1_PATHS, applyCompat, createApplicationRegistry, createBusinessApi, fallbackRegistry,
  pathProfile, registerPathProfile, signatureOf, frameMessage, frameAiText, noticeCard, intentOfHead, normalizeIntent,
  INTENTS, INTENT_LABELS, APPROVAL_LABEL, CONSULT_LABEL, SECRETARY_LABEL_RE,
} from '../src/index.js'
import * as core from '../src/index.js'
import { startFakeApi } from './helpers.mjs'

test('the main entry exports no care-specific names (they live in compat/care-billing-paths)', () => {
  for (const name of ['legacyRegistry', 'LEGACY_PATHS', 'createCareApi', 'CareApiError']) assert.equal(name in core, false, name)
  assert.equal(DEFAULT_APPLICATION_ID, 'default')
  assert.equal(/care|ケア|SNS連携/.test(JSON.stringify(DEFAULT_DENY_HINTS)), false)
})

test('a business API client has no built-in URL, token or environment fallback', async () => {
  const prev = { url: process.env.CARE_API_URL, token: process.env.CARE_SERVICE_TOKEN }
  process.env.CARE_API_URL = 'http://127.0.0.1:9'
  process.env.CARE_SERVICE_TOKEN = 'must-not-leak'
  try {
    const api = createBusinessApi({})
    assert.equal(api.baseUrl(), '')
    assert.equal(api.hasServiceToken(), false)
    await assert.rejects(api.get('/x'), (e) => e.code === 'api_url_missing' && /business API/.test(e.message))
  } finally {
    for (const [k, v] of [['CARE_API_URL', prev.url], ['CARE_SERVICE_TOKEN', prev.token]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

test('paths: v1 by default; an unknown path profile is a start-up error; registered profiles and objects work', () => {
  const reg = createApplicationRegistry({ applications: [{ id: 'example-app', apiUrl: 'http://x.invalid' }] })
  assert.deepEqual(reg.get('example-app').paths, V1_PATHS)
  assert.throws(() => createApplicationRegistry({ applications: [{ id: 'a-app', paths: 'nope-profile' }] }), /unknown path profile "nope-profile"/)
  registerPathProfile('generic-test-legacy', { ...V1_PATHS, identity: '/old/identity' })
  assert.equal(pathProfile('generic-test-legacy').identity, '/old/identity')
  const custom = createApplicationRegistry({
    applications: [
      { id: 'a-app', paths: 'generic-test-legacy' },
      { id: 'b-app', paths: { base: 'generic-test-legacy', link: '/old/link' }, bots: [{ platform: 'slack', botId: 'S' }] },
      { id: 'c-app', paths: { events: '/custom/events' }, bots: [{ platform: 'slack', botId: 'S3' }] },
    ],
  })
  assert.equal(custom.get('a-app').paths.identity, '/old/identity')
  assert.deepEqual([custom.get('b-app').paths.identity, custom.get('b-app').paths.link], ['/old/identity', '/old/link'])
  assert.deepEqual([custom.get('c-app').paths.events, custom.get('c-app').paths.identity], ['/custom/events', V1_PATHS.identity])
})

test('fallbackRegistry: plugin config first, then the named environment variables, then defaultBaseUrl', async () => {
  const api = await startFakeApi(() => ({ body: { ok: true } }))
  process.env.GENERIC_TEST_API_URL = ''
  process.env.GENERIC_TEST_TOKEN = 'tok-env'
  try {
    let configured = ''
    const reg = fallbackRegistry({
      id: 'example-app', name: '日報', apiUrl: () => configured,
      envFallback: { apiUrl: 'GENERIC_TEST_API_URL', serviceToken: 'GENERIC_TEST_TOKEN' }, defaultBaseUrl: api.url,
    })
    const app = reg.default()
    assert.deepEqual([app.id, app.name, app.namespace, app.label, app.catchAll], ['example-app', '日報', 'example_app', 'example-app API', true])
    assert.equal(app.apiUrl(), api.url)
    process.env.GENERIC_TEST_API_URL = 'http://env.invalid:1/'
    assert.equal(app.apiUrl(), 'http://env.invalid:1')
    configured = api.url
    await app.api.get('/ping')
    assert.equal(api.calls[0].headers['x-service-token'], 'tok-env')
    assert.deepEqual(app.paths, V1_PATHS)
    const bare = fallbackRegistry().default()
    assert.deepEqual([bare.id, bare.apiUrl(), bare.hasServiceToken()], ['default', '', false])
  } finally {
    delete process.env.GENERIC_TEST_API_URL
    delete process.env.GENERIC_TEST_TOKEN
    await api.close()
  }
})

test('secretary signature: — <アプリ名> AI 秘書, or — AI 秘書 without a name', () => {
  assert.equal(signatureOf('設備点検'), '— 設備点検 AI 秘書')
  assert.equal(signatureOf(), '— AI 秘書')
  assert.equal(signatureOf('  '), '— AI 秘書')
  assert.equal(frameMessage({ intent: 'info', title: 'x', lead: 'y', now: Date.parse('2026-10-27T01:00:00Z') }).signature, '— AI 秘書')
})

test('secretary intents: approval 【承認のお願い】 and consult 【ご相談】 frame like action (▶ お願いしたいこと), and map back from the head', () => {
  assert.deepEqual([...INTENTS], ['info', 'action', 'urgent', 'approval', 'consult'])
  assert.equal(INTENT_LABELS.approval, APPROVAL_LABEL)
  assert.equal(INTENT_LABELS.consult, CONSULT_LABEL)
  assert.equal(CONSULT_LABEL, '【ご相談】')
  const now = Date.parse('2026-10-27T01:00:00Z') // 10:00 JST
  const approval = frameMessage({ intent: 'approval', title: '記録の承認', lead: '承認を待っている記録が 1 件あります。', ask: '業務 Web で判断してください。', due: '本日中', now })
  assert.equal(approval.label, '【承認のお願い】')
  assert.equal(approval.body, ['【承認のお願い】記録の承認', 'お疲れさまです。承認を待っている記録が 1 件あります。', '▶ お願いしたいこと（本日中）：業務 Web で判断してください。', '— AI 秘書'].join('\n'))
  const consult = frameMessage({ intent: 'consult', title: '期限を過ぎた対応', lead: '期限を過ぎた対応が 2 件あります。', ask: '担当と相談してください。', now })
  assert.equal(consult.title, '【ご相談】期限を過ぎた対応')
  assert.equal(consult.intent, 'consult')
  assert.ok(consult.text.includes('▶ お願いしたいこと：担当と相談してください。'))
  assert.equal(noticeCard(consult).link, undefined)
  assert.equal(noticeCard({ ...consult, url: 'https://x.example.jp/' }).link.label, '業務 Web を開いて対応')
  assert.equal(normalizeIntent('consult'), 'consult')
  assert.equal(normalizeIntent('nope'), 'info')
  // the labels are secretary labels (no 【アプリ名】 confusion) and map back to their intents
  for (const label of ['【ご報告】', '【対応のお願い】', '【至急】', '【承認のお願い】', '【ご相談】', '【定時のご報告】']) assert.ok(SECRETARY_LABEL_RE.test(`${label}x`), label)
  assert.equal(SECRETARY_LABEL_RE.test('【設備点検】x'), false)
  assert.deepEqual(['【承認のお願い】a', '【ご相談】b', '【至急】c', '【対応のお願い】d', '【ご報告】e', '【定時のご報告】f', 'g'].map(intentOfHead),
    ['approval', 'consult', 'urgent', 'action', 'info', 'info', 'info'])
  const ai = frameAiText('【ご相談】期限を過ぎた対応\n2 件が片付いていません。', { now })
  assert.equal(ai.intent, 'consult')
  assert.equal(ai.title, '【ご相談】期限を過ぎた対応')
  assert.equal(frameAiText('【承認のお願い】給与\nx', { now }).intent, 'approval')
})

test('bridge-apps compat: unknown profiles are refused; care-billing-paths adds the legacy paths and service names', () => {
  assert.deepEqual(applyCompat({}), { identity: ['bridgeIdentity'], assistant: ['bridgeAssistant'] })
  assert.throws(() => applyCompat({ compat: ['nope'] }), /unknown compat profile "nope"/)
  assert.deepEqual(applyCompat({ compat: ['care-billing-paths'] }), { identity: ['bridgeIdentity', 'careIdentity'], assistant: ['bridgeAssistant', 'careAssistant'] })
  assert.equal(pathProfile('legacy').identity, '/api/ai/identity')
  applyCompat({ pathProfiles: { 'generic-test-profile': { identity: '/p/identity' } } })
  assert.equal(pathProfile('generic-test-profile').identity, '/p/identity')
})
