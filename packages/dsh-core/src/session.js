// session.js — 会話（DSH セッション）のキー = (アプリケーション, プラットフォーム, ボット, 会話)。BRIDGE_ARCHITECTURE §15.2。
//
// 同じ職員でもアプリケーションが違えば別の会話・別のメモリ・別の通知文脈になる。キーの各要素は信頼できる値だけから作る
// （applicationId は resolveApplication の結果、platform / botId / conversation は dsh-im の ImSource）。本文は使わない。

const PREFIX = 'bridge:v1'

function enc(value) {
  return encodeURIComponent(String(value ?? ''))
}

/** ImSource から会話のキー（チーム + 会話）。 */
export function conversationKeyOf(source) {
  if (!source || typeof source !== 'object') return ''
  const conversation = source.conversationId ?? source.userId ?? ''
  return source.teamId ? `${source.teamId}/${conversation}` : String(conversation)
}

/**
 * セッションキー。
 * @param {{applicationId: string, platform: string, botId: string, conversationKey?: string, source?: object}} parts
 *   conversationKey が無ければ source から作る。
 */
export function sessionKey({ applicationId, platform, botId, conversationKey, source } = {}) {
  const conversation = conversationKey ?? conversationKeyOf(source)
  const plat = platform ?? source?.platform
  const bot = botId ?? source?.botId
  for (const [name, value] of [['applicationId', applicationId], ['platform', plat], ['botId', bot], ['conversationKey', conversation]]) {
    if (value === undefined || value === null || String(value) === '') throw new TypeError(`sessionKey: ${name} is required`)
  }
  return `${PREFIX}:${enc(applicationId)}:${enc(plat)}:${enc(bot)}:${enc(conversation)}`
}

/** sessionKey の逆。形式が違えば null。 */
export function parseSessionKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`${PREFIX}:`)) return null
  const parts = key.slice(PREFIX.length + 1).split(':')
  if (parts.length !== 4) return null
  try {
    const [applicationId, platform, botId, conversationKey] = parts.map((p) => decodeURIComponent(p))
    return { applicationId, platform, botId, conversationKey }
  } catch {
    return null
  }
}
