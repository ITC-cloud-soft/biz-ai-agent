// screen.js — 記憶に入れてよい文か（保存の前・会話の振り返りに残す前）。
//
// 1. 手元の検査（dsh-core の screenOutboundText の網：敬称つきの人名・電話・メール・郵便番号・健康情報の語・〔設定で〕金額）と
//    長い番号（10 桁以上：被保険者番号・口座番号など）。
// 2. 業務システムの検査（Bridge v1 の任意の機能 POST /bridge/v1/pii-scan、レジストリの paths.piiScan）。
//    その業務システムの名簿（利用者・支払者の氏名など）で見るので、手元の網より確か。
// どちらかが当たれば保存しない（部分的な伏せ字はしない）。業務システムの検査に届かないときも保存しない（fail closed）。
// paths.piiScan の無いアプリケーションは手元の検査だけ（README に明記）。返すのは種類（kinds）だけで、当たった文字列は返さない。
import { HEALTH_WORDS, appPath, screenOutboundText } from '@dsh-bridge/dsh-core'

const REASON_KIND = { person_name: 'person_name', contact: 'contact', health: 'health', amount: 'amount' }
const LONG_NUMBER_RE = /(?<![\d-])\d{10,}(?![\d-])/u

/**
 * 手元の検査。
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.health]   健康情報の語を見る（既定 true）
 * @param {boolean} [opts.amounts]  金額を見る（既定 false。組織の手順に「1 万円以上は…」と書けるように）
 * @returns {string[]} kinds（person_name | contact | health | amount | long_number）
 */
export function localKinds(text, { health = true, amounts = false, healthWords = HEALTH_WORDS } = {}) {
  const s = String(text ?? '')
  if (!s.trim()) return []
  const { reasons } = screenOutboundText(s, {
    allowedUrlPrefixes: ['http://', 'https://'],
    maxChars: Number.MAX_SAFE_INTEGER,
    maxLines: Number.MAX_SAFE_INTEGER,
    healthWords: health ? healthWords : [],
  })
  const kinds = new Set()
  for (const r of reasons) {
    const kind = REASON_KIND[r]
    if (!kind) continue
    if (kind === 'amount' && !amounts) continue
    kinds.add(kind)
  }
  if (LONG_NUMBER_RE.test(s.normalize('NFKC'))) kinds.add('long_number')
  return [...kinds]
}

export class ScreenUnavailableError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'ScreenUnavailableError'
    this.status = status ?? null
  }
}

/**
 * 手元の検査 ＋ 業務システムの検査。
 * @returns {Promise<{ ok: boolean, kinds: string[], checked: 'local' | 'business' }>}
 * @throws ScreenUnavailableError  業務システムの検査に届かない（呼び出し側は保存しない）
 */
export async function screenText(text, { app, local = {} } = {}) {
  const kinds = new Set(localKinds(text, local))
  const hasScan = Boolean(app?.paths?.piiScan)
  if (hasScan) {
    let res
    try {
      res = await app.api.post(appPath(app, 'piiScan'), { text: String(text) })
    } catch (error) {
      const status = error?.status || null
      if (status === 413) throw new ScreenUnavailableError('text is too long for the personal-data check (max 20,000 characters)', { status })
      throw new ScreenUnavailableError(`personal-data check is unavailable (${error?.code || error?.name || 'error'})`, { status })
    }
    const found = Array.isArray(res?.kinds) ? res.kinds.map(String) : []
    for (const k of found) kinds.add(k)
    if (res?.containsPersonalData && found.length === 0) kinds.add('personal_data')
  }
  return { ok: kinds.size === 0, kinds: [...kinds], checked: hasScan ? 'business' : 'local' }
}
