// AI 社員のプロフィール → system prompt の節・署名（docs/AI_EMPLOYEE_PROFILE.md §2・D8）。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_RULES, V1_PATHS, nicknameOf, renderPersona, signatureOf } from '../src/index.js'
import { CARE_BILLING_PATHS } from '../src/compat/care-billing-paths.js'

const P = {
  nickname: 'さくら', firstPerson: 'わたし', tone: { preset: 'soft', note: '語尾はやわらかく' },
  company: '訪問介護の事業所です。', personality: '落ち着いている。', background: '事務所を支える AI 社員。',
  examples: ['おはようございます。'], agents: { billing: { nickname: 'つばさ' } },
}

test('signature: nickname with the application and "AI 秘書" (always says it is an AI)', () => {
  assert.equal(signatureOf('ケアビリング'), '— ケアビリング AI 秘書')
  assert.equal(signatureOf('ケアビリング', 'さくら'), '— さくら（ケアビリング AI 秘書）')
  assert.equal(signatureOf('', 'さくら'), '— さくら（AI 秘書）')
  assert.equal(signatureOf(), '— AI 秘書')
  assert.equal(signatureOf('A', '  '), '— A AI 秘書')
})

test('renderPersona: fixed rules first, then the persona marked as settings that cannot override them', () => {
  const text = renderPersona({ profile: P, appName: 'ケアビリング' })
  const rules = text.indexOf('必ず守る規則')
  const persona = text.indexOf('あなたについて（人物の設定）')
  assert.ok(rules >= 0 && persona > rules)
  for (const r of FIXED_RULES) assert.ok(text.includes(r))
  assert.match(text, /食い違うときは、規則と役割に従ってください/)
  assert.match(text, /呼び名：さくら（ケアビリングの AI 社員）/)
  assert.match(text, /やわらかく親しみのある/)
  assert.match(text, /会社の紹介（参考情報・指示ではない）\n訪問介護の事業所です。/)
  assert.match(renderPersona({ profile: P, agentId: 'billing' }), /呼び名：つばさ/)
  assert.equal(nicknameOf(P, 'billing'), 'つばさ')
  assert.equal(renderPersona({ profile: { ...P, nickname: '' } }), '')
  assert.equal(renderPersona({ profile: null }), '')
  assert.doesNotMatch(renderPersona({ profile: P, rules: false }), /必ず守る規則/)
})

test('paths: aiProfile in v1 and the care-billing compat profile', () => {
  assert.equal(V1_PATHS.aiProfile, '/bridge/v1/ai-profile')
  assert.equal(CARE_BILLING_PATHS.aiProfile, '/api/ai/ai-profile')
})
