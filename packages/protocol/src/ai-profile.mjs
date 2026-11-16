// AI 社員のプロフィール（docs/AI_EMPLOYEE_PROFILE.md §2）：形・上限・保存前の検査。業務システム（server-kit・自前の実装）と DSH が同じものを使う。
//
// プロフィールは「人物の設定」の文章だけ。権限・ツール・安全の規則は変えられない：規則を外させる言い回しは保存を拒む（D4）。
// 会社の紹介などに個人情報（連絡先・番号）があれば拒む（findPiiInString の網。日本語の文そのものは許す）。検査は種類だけを返し、当たった文字列は返さない。
import { findPiiInString } from './pii.mjs'

export const AI_PROFILE_TONES = Object.freeze(['polite', 'soft', 'concise'])
export const AI_PROFILE_TONE_LABEL = Object.freeze({ polite: '丁寧（です・ます）', soft: 'やわらかめ（です・ます）', concise: '簡潔（です・ます、短く）' })
export const AI_PROFILE_LIMITS = Object.freeze({
  nickname: 20, firstPerson: 10, toneNote: 100, company: 2000, personality: 300, background: 500, example: 100, examples: 3, agents: 20, agentId: 64,
})
const AGENT_KEYS = Object.freeze(['nickname', 'personality', 'background'])
const TOP_KEYS = Object.freeze(['nickname', 'firstPerson', 'tone', 'company', 'personality', 'background', 'examples', 'agents'])

/**
 * 規則を外させる言い回し（D4：保存を拒む）。プロフィールは人物の設定で、規則・権限は変えられない。語の一覧は完全ではない
 * （そもそも system prompt では固定の規則が先に来て、「食い違うときは規則に従う」と明記する。これは保存の時点の網）。
 */
export const RULE_OVERRIDE_PATTERNS = Object.freeze([
  /(規則|ルール|制約|指示|方針|ガイドライン|安全)(を|は)?(無視|守らな|破|解除|外|忘れ)/u,
  /(承認|確認|許可)(なし|無し|不要|を省|を飛ば|をとらず|を取らず)/u,
  /(確定|承認|削除|送金|支払|発行)(して(よい|いい|かまわない|構わない)|できる|する権限)/u,
  /(管理者|システム|開発者|root|admin)(として|の権限|権限で)(振る舞|動|答|実行)/iu,
  /(人間|人)(だと|であると|として)(名乗|振る舞|言)/u,
  /(AI|ボット)\s*(であること|だということ|ということ)を(隠|言わな|伏せ)/iu,
  /ignore (all |any |the )?(previous |above )?(rules|instructions)/iu,
  /(system prompt|システムプロンプト)/iu,
])

const str = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\r\n?/g, '\n').trim() : v)

/**
 * 形を整える（空白・改行・全角英数を正規化、未設定の項目は既定値）。形が違えば { ok: false, errors } のときに分かるよう、そのまま残す。
 * @returns {object} 正規化したプロフィール
 */
export function normalizeAiProfile(input = {}) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const tone = p.tone && typeof p.tone === 'object' && !Array.isArray(p.tone) ? p.tone : {}
  const out = {
    nickname: str(p.nickname ?? ''),
    firstPerson: str(p.firstPerson ?? '') || 'わたし',
    tone: { preset: tone.preset ?? 'polite', note: str(tone.note ?? '') },
    company: str(p.company ?? ''),
    personality: str(p.personality ?? ''),
    background: str(p.background ?? ''),
    examples: Array.isArray(p.examples) ? p.examples.map(str).filter((e) => e !== '') : p.examples ?? [],
    agents: {},
  }
  if (p.agents && typeof p.agents === 'object' && !Array.isArray(p.agents)) {
    for (const [id, a] of Object.entries(p.agents)) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) { out.agents[id] = a; continue }
      const o = {}
      for (const k of AGENT_KEYS) if (a[k] !== undefined && str(a[k]) !== '') o[k] = str(a[k])
      for (const k of Object.keys(a)) if (!AGENT_KEYS.includes(k)) o[k] = a[k]
      out.agents[id] = o
    }
  } else if (p.agents !== undefined) out.agents = p.agents
  for (const k of Object.keys(p)) if (!TOP_KEYS.includes(k)) out[k] = p[k]
  return out
}

/**
 * 保存前の検査。errors: [{ field, code }]。code：
 *   required | too_long | invalid | unknown_field | rule_override（規則を外させる言い回し）| personal_data（連絡先・番号など）
 * @returns {{ ok: boolean, profile: object, errors: Array<{field: string, code: string, kinds?: string[]}> }}
 */
export function validateAiProfile(input) {
  const profile = normalizeAiProfile(input)
  const errors = []
  const L = AI_PROFILE_LIMITS
  const text = (field, value, max, { required = false } = {}) => {
    if (typeof value !== 'string') { errors.push({ field, code: 'invalid' }); return }
    if (required && !value) { errors.push({ field, code: 'required' }); return }
    if (value.length > max) errors.push({ field, code: 'too_long' })
    if (!value) return
    if (RULE_OVERRIDE_PATTERNS.some((re) => re.test(value))) errors.push({ field, code: 'rule_override' })
    const kinds = [...new Set(findPiiInString(value, { allow: ['cjk_text', 'free_text'] }).map((f) => f.kind))]
    if (kinds.length) errors.push({ field, code: 'personal_data', kinds })
  }
  for (const k of Object.keys(profile)) if (!TOP_KEYS.includes(k)) errors.push({ field: k, code: 'unknown_field' })
  text('nickname', profile.nickname, L.nickname, { required: true })
  if (typeof profile.nickname === 'string' && /[\n<>{}`]/.test(profile.nickname)) errors.push({ field: 'nickname', code: 'invalid' })
  text('firstPerson', profile.firstPerson, L.firstPerson)
  if (!AI_PROFILE_TONES.includes(profile.tone.preset)) errors.push({ field: 'tone.preset', code: 'invalid' })
  text('tone.note', profile.tone.note, L.toneNote)
  text('company', profile.company, L.company)
  text('personality', profile.personality, L.personality)
  text('background', profile.background, L.background)
  if (!Array.isArray(profile.examples)) errors.push({ field: 'examples', code: 'invalid' })
  else {
    if (profile.examples.length > L.examples) errors.push({ field: 'examples', code: 'too_long' })
    profile.examples.forEach((e, i) => text(`examples[${i}]`, e, L.example))
  }
  if (!profile.agents || typeof profile.agents !== 'object' || Array.isArray(profile.agents)) errors.push({ field: 'agents', code: 'invalid' })
  else {
    const ids = Object.keys(profile.agents)
    if (ids.length > L.agents) errors.push({ field: 'agents', code: 'too_long' })
    for (const id of ids) {
      const a = profile.agents[id]
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id.length > L.agentId) { errors.push({ field: `agents.${id}`, code: 'invalid' }); continue }
      if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push({ field: `agents.${id}`, code: 'invalid' }); continue }
      for (const k of Object.keys(a)) if (!AGENT_KEYS.includes(k)) errors.push({ field: `agents.${id}.${k}`, code: 'unknown_field' })
      if (a.nickname !== undefined) text(`agents.${id}.nickname`, a.nickname, L.nickname)
      if (a.personality !== undefined) text(`agents.${id}.personality`, a.personality, L.personality)
      if (a.background !== undefined) text(`agents.${id}.background`, a.background, L.background)
    }
  }
  return { ok: errors.length === 0, profile, errors }
}

/** その AI 社員（DSH の preset の id）に効くプロフィール（agents の上書きを重ねる）。profile が無ければ null。 */
export function aiProfileFor(profile, agentId) {
  if (!profile || typeof profile !== 'object') return null
  const over = agentId && profile.agents && typeof profile.agents === 'object' ? profile.agents[agentId] : null
  if (!over) return profile
  return { ...profile, ...Object.fromEntries(AGENT_KEYS.filter((k) => over[k]).map((k) => [k, over[k]])) }
}
