// システムの使い方（care-ai-native docs/design/SNS_HELP_QA.md §4.3・D1）：
//  - リンクの検査：AI の答えの業務 Web の URL は manifest の web.routes の画面だけ、ほかのホストは linkGuard.allowHosts だけ（dsh-im の setAnswerFilter）
//  - 未連携の発信者の質問（1:1）：paths.publicHelp があれば AI を使わずに公開の節で答え、連携の案内を添える。無い・見つからない・上限は従来の案内
// 業務システムは偽物（node:http）。manifest は framework/examples/care-billing の本物（web.routes を持つ）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createApplicationRegistry, registryService } from '@dsh-bridge/dsh-core'
import { apply } from '../src/index.js'
import { makeCtx, makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const WEB = 'https://care.example.test'
const MANIFEST_FILE = fileURLToPath(new URL('../../../examples/care-billing/manifest/care-billing.manifest.yaml', import.meta.url))
const PATHS = { identity: '/bridge/v1/identity', link: '/bridge/v1/identities/link', publicHelp: '/api/ai/help/public' }
const LOGIN = {
  id: 'manual-admin-login', title: 'ログイン', summary: '業務 Web にログインします。', steps: ['メールアドレスとパスワードを入れる', '「ログイン」を押す'],
  url: `${WEB}/login`, manualUrl: `${WEB}/help/05-admin#manual-admin-login`,
}

async function setup({ config = {}, paths = PATHS, linked = new Set(['U-linked']) } = {}) {
  const api = await startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { ok: false } }
    if (req.path === '/bridge/v1/identity') {
      return linked.has(req.query.userId) ? { body: { ok: true, linked: true, orgId: 't', user: { id: 'e1', role: 'staff' } } } : { body: { ok: true, linked: false, orgId: 't' } }
    }
    if (req.path === '/api/ai/help/public') {
      return /ログイン/.test(req.query.q) ? { body: { ok: true, found: true, results: [LOGIN] } } : { body: { ok: true, found: false, results: [] } }
    }
    return { status: 404, body: { ok: false } }
  })
  const registry = createApplicationRegistry({
    applications: [{ id: 'care-billing', name: 'ケアビリング', default: true, apiUrl: api.url, serviceToken: 'svc', paths, manifestFile: MANIFEST_FILE }],
  })
  await registry.get('care-billing').ensureManifest()
  const im = mockDshIm()
  const warnings = []
  const logger = () => ({ debug() {}, info() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) })
  const ctx = makeCtx({ dshIm: im.dshIm, bridgeApps: registryService(registry) }, { logger })
  apply(ctx, { guideIntervalSeconds: 600, unlinkedReply: '連携の案内です。', linkGuard: { webUrl: WEB, allowHosts: ['mhlw.go.jp'] }, ...config })
  return { api, im, ctx, warnings, close: async () => { await ctx.dispose(); await api.close() } }
}

test('link guard: an AI answer keeps the business web screens (manifest web.routes) and allowed hosts only', async () => {
  const s = await setup()
  try {
    assert.equal(typeof s.im.state.answerFilter, 'function')
    const source = makeSource({ userId: 'U-linked' })
    const text = [
      '【ご案内】モニタリング',
      `こちらから開けます：${WEB}/cm/monitoring`,
      `くわしい手順：${WEB}/help/03-care-manager#manual-cm-monitoring`,
      `詳細：${WEB}/cm/monitoring/123e4567-e89b-42d3-a456-426614174000`,
      `誤り：${WEB}/cm/monitorings`,
      '厚労省：https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/hukushi_kaigo/',
      '外部：https://evil.example/phish',
    ].join('\n')
    const out = await s.im.state.answerFilter({ sessionId: 's1', source, text })
    assert.match(out, /こちらから開けます：https:\/\/care\.example\.test\/cm\/monitoring\n/)
    assert.match(out, /help\/03-care-manager#manual-cm-monitoring/)
    assert.match(out, /cm\/monitoring\/123e4567/)
    assert.match(out, /誤り：（リンクを省きました）/)
    assert.match(out, /www\.mhlw\.go\.jp/)
    assert.match(out, /外部：（リンクを省きました）/)
    // a non-string answer passes through
    assert.equal(await s.im.state.answerFilter({ source, text: undefined }), undefined)
  } finally {
    await s.close()
  }
  // no webUrl, or turned off: nothing is changed
  for (const linkGuard of [{}, { webUrl: WEB, enabled: false }]) {
    const t = await setup({ config: { linkGuard } })
    try {
      const text = 'https://evil.example/x'
      assert.equal(await t.im.state.answerFilter({ source: makeSource({ userId: 'U-linked' }), text }), text)
      await t.im.state.answerFilter({ source: makeSource({ userId: 'U-linked' }), text })
      // no URL for an application that has routes: one warning (fail open is said out loud); turned off: none
      assert.equal(t.warnings.filter((w) => w.includes('link guard is off')).length, linkGuard.enabled === false ? 0 : 1)
    } finally {
      await t.close()
    }
  }
})

test('unlinked sender: a question is answered from the public sections (no AI) with the link guide; otherwise the guide as before', async () => {
  const s = await setup()
  try {
    const source = makeSource({ userId: 'U-new' })
    const r = await s.im.state.resolver(source, { text: 'ログインできません' })
    assert.equal(r.deny, true)
    const lines = r.reply.split('\n')
    assert.equal(lines[0], '【ご案内】ログイン')
    assert.match(lines[1], /^(おはようございます。|お疲れさまです。|夜分に失礼します。)業務 Web にログインします。$/)
    assert.ok(lines.includes('1. メールアドレスとパスワードを入れる'))
    assert.ok(lines.includes(`こちらから開けます：${WEB}/login`))
    assert.ok(lines.includes(`くわしい手順：${WEB}/help/05-admin#manual-admin-login`))
    assert.ok(lines.includes('連携の案内です。'))
    assert.equal(lines.at(-1), '— ケアビリング AI 秘書')
    const call = s.api.callsTo('/api/ai/help/public').at(-1)
    assert.deepEqual(call.query, { q: 'ログインできません', limit: '1' })
    // the answer counts as the guide: the next message without an answer is silent (guideIntervalSeconds)
    assert.equal(await s.im.state.resolver(source, { text: '天気は？' }), 'deny')
    // a new sender with a question the manual cannot answer gets the guide
    assert.deepEqual(await s.im.state.resolver(makeSource({ userId: 'U-other' }), { text: '天気は？' }), { deny: true, reply: '連携の案内です。' })
    // a link code is never sent to the help search
    const before = s.api.callsTo('/api/ai/help/public').length
    await s.im.state.resolver(makeSource({ userId: 'U-code' }), { text: '連携 123456' })
    assert.equal(s.api.callsTo('/api/ai/help/public').length, before)
    // a linked sender is allowed (no help search)
    assert.equal(await s.im.state.resolver(makeSource({ userId: 'U-linked' }), { text: 'ログイン' }), 'allow')
    assert.equal(s.api.callsTo('/api/ai/help/public').length, before)
  } finally {
    await s.close()
  }
})

test('unlinked sender: no publicHelp path, publicHelp off, or over the limit → the guide only', async () => {
  const noPath = await setup({ paths: { identity: PATHS.identity, link: PATHS.link } })
  try {
    assert.deepEqual(await noPath.im.state.resolver(makeSource({ userId: 'U-a' }), { text: 'ログイン' }), { deny: true, reply: '連携の案内です。' })
    assert.equal(noPath.api.callsTo('/api/ai/help/public').length, 0)
  } finally {
    await noPath.close()
  }
  const off = await setup({ config: { publicHelp: { enabled: false } } })
  try {
    assert.deepEqual(await off.im.state.resolver(makeSource({ userId: 'U-b' }), { text: 'ログイン' }), { deny: true, reply: '連携の案内です。' })
  } finally {
    await off.close()
  }
  const limited = await setup({ config: { publicHelp: { perWindow: 1 }, guideIntervalSeconds: 0 } })
  try {
    const src = makeSource({ userId: 'U-c' })
    assert.match((await limited.im.state.resolver(src, { text: 'ログイン' })).reply, /^【ご案内】/)
    assert.deepEqual(await limited.im.state.resolver(src, { text: 'ログイン' }), { deny: true, reply: '連携の案内です。' })
  } finally {
    await limited.close()
  }
})
