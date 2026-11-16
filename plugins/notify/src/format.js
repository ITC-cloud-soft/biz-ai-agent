// format.js — 通知文の材料の整形（数値・日付・時刻だけを通す）。templates.js と、アプリケーションの文面モジュールが使う。

const SAFE_TEXT = /^[0-9T:./Z+-]{1,40}$/

/** 数値か時刻・日付形式の文字列だけを通す。それ以外は undefined。 */
export function safe(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && SAFE_TEXT.test(value)) return value
  return undefined
}

export const plural = (n) => (Number.isInteger(n) && n > 0 ? n : 1)

/** 'MM/DD' だけ（それ以外は undefined）。 */
export const mmdd = (value) => (typeof value === 'string' && /^(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])$/.test(value) ? value : undefined)
/** 'HH:MM' だけ（それ以外は undefined）。 */
export const hhmm = (value) => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined)
/** 'YYYY-MM' → 'YYYY年M月'（それ以外は undefined）。 */
export function yearMonth(value) {
  const m = typeof value === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value) : null
  return m ? `${m[1]}年${Number(m[2])}月` : undefined
}
/** 日付があれば「MM/DD の」。 */
export const on = (value) => (mmdd(value) ? `${mmdd(value)} の` : '')
/** 0 以上の整数（それ以外は undefined）。 */
export const int = (value) => (Number.isInteger(value) && value >= 0 && value < 1e9 ? value : undefined)
/** 'MM/DD HH:MM'（どちらか欠けたら出せる分だけ。どちらも無ければ undefined）。 */
export function dateTime(params) {
  const parts = [mmdd(params?.date), hhmm(params?.time)].filter(Boolean)
  return parts.length ? parts.join(' ') : undefined
}
