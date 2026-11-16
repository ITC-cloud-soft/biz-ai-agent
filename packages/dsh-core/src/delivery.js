// IM 送信の失敗の分類（plugin-notify の通知と plugin-approvals のカード更新で共通）と、送信先のプラットフォームの既定の優先順位。
//
// dsh-im はプラットフォームのエラーを delivery-failed などに包む（cause に元のエラー）ので、cause を辿って
// プラットフォームの情報（WeChat の providerCode・診断文の contextToken=yes|no・HTTP status）を読む。
// -> null（不明：従来どおり再試行）| { reason, undeliverable: 'now'|'after-retries'|false, retryLater?, retryAfterMs? }
//   weixin_context_missing: iLink が拒否（ret=-2）し、送信に会話コンテキスト（context_token）が無かった。受信者がボットに
//     メッセージを送るまで何度送っても届かない → 即時 undeliverable
//   weixin_rejected: ret=-2 だがコンテキストはあった（期限切れ・送信枠・内容のどれか。iLink は区別しない）→ 数回だけ再試行
//   invalid_target / target_rejected / unknown_target: 宛先が不正 → 即時 undeliverable
//   bot_offline: ボットが未接続 → 通常の再試行
//   line_quota: LINE の月間の送信上限（HTTP 429 "You have reached your monthly limit."）→ 後で再試行（retryLater）。
//     上限は月が替わるか、プランを上げるまで戻らない。宛先は正しいので undeliverable にはしない
//   line_rate_limited / rate_limited / quota_exceeded: プラットフォームのレート制限・送信上限（HTTP 429 など。Retry-After があれば retryAfterMs）→ 後で再試行

/**
 * 送信先のプラットフォームの既定の優先順位（plugin-notify の通知・plugin-approvals の承認依頼）。dsh-im が対応するプラットフォームすべて（Lark（飛書）を含む）。
 * email は含めない：送信者（From）を検証できない（dsh-im は DKIM / DMARC を確認しない）ので連携も承認もできず、
 * 業務側のメールアドレスを宛先にする仕組みも無い。通知に使う場合だけ platformPriority に明示する。
 */
export const DEFAULT_PLATFORM_PRIORITY = Object.freeze([
  'slack', 'line', 'teams', 'weixin', 'telegram', 'wecom-app', 'wecom', 'dingtalk', 'feishu', 'qq', 'discord', 'matrix', 'whatsapp', 'imessage',
])
/** 通知専用のプラットフォーム（連携・承認・AI 利用は不可）。 */
export const NOTIFY_ONLY_PLATFORMS = Object.freeze(['email'])
/** Bridge v1 の platforms（承認の配信・通知の受信者）の上限。 */
export const MAX_REQUEST_PLATFORMS = 10

const QUOTA_RE = /monthly limit|quota|exceeded the (?:monthly|message) limit/i

function retryAfterMsOf(chain) {
  for (const e of chain) {
    const ms = Number(e?.retryAfterMs)
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms)
    const s = Number(e?.retryAfter ?? e?.body?.retry_after ?? e?.body?.parameters?.retry_after)
    if (Number.isFinite(s) && s > 0) return Math.round(s * 1000)
  }
  return null
}

export function classifyDeliveryError(error, platform = '') {
  const chain = []
  for (let e = error, depth = 0; e && depth < 6; e = e.cause, depth += 1) chain.push(e)
  const codes = chain.map((e) => String(e?.code ?? ''))
  const provider = chain.map((e) => e?.providerCode).find((c) => c !== undefined && c !== null && c !== '')
  const text = chain.map((e) => String(e?.message ?? '')).join(' ')
  const providerCode = provider !== undefined ? String(provider) : (/provider=(-?\d+)/.exec(text)?.[1] ?? null)
  const weixin = platform === 'weixin' || /endpoint=sendmessage/.test(text)
  if (weixin && (providerCode !== null || codes.includes('send-rejected'))) {
    if (/contextToken=no/.test(text)) return { reason: 'weixin_context_missing', undeliverable: 'now' }
    return { reason: providerCode === '-2' || providerCode === null ? 'weixin_rejected' : `weixin_rejected_${providerCode.replace(/[^0-9-]/g, '').slice(0, 8)}`, undeliverable: 'after-retries' }
  }
  if (codes.includes('invalid-target')) return { reason: 'invalid_target', undeliverable: 'now' }
  if (codes.includes('target-rejected')) return { reason: 'target_rejected', undeliverable: 'now' }
  if (codes.includes('unknown-target')) return { reason: 'unknown_target', undeliverable: 'now' }
  if (codes.includes('bot-not-connected')) return { reason: 'bot_offline', undeliverable: false }
  // レート制限・送信上限（宛先は正しい）：後で再試行。上のどれにも当たらなかったものだけ（従来の分類結果は変えない）
  const statuses = chain.map((e) => Number(e?.status ?? e?.httpStatus ?? e?.statusCode)).filter(Number.isFinite)
  const bodyText = chain.map((e) => (typeof e?.body?.message === 'string' ? e.body.message : '')).join(' ')
  const limited = statuses.includes(429) || codes.some((c) => /rate[-_]?limit|quota|too[-_]many/i.test(c)) || /\bHTTP 429\b|status=429\b/.test(text)
  if (limited || QUOTA_RE.test(bodyText)) {
    const line = platform === 'line' || codes.some((c) => c.startsWith('line'))
    const quota = QUOTA_RE.test(`${text} ${bodyText}`)
    const reason = line ? (quota ? 'line_quota' : 'line_rate_limited') : (quota ? 'quota_exceeded' : 'rate_limited')
    const retryAfterMs = retryAfterMsOf(chain)
    return { reason, undeliverable: false, retryLater: true, ...(retryAfterMs ? { retryAfterMs } : {}) }
  }
  return null
}
