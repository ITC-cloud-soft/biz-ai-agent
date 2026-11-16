// quiet-hours.js — おやすみ時間（通知を控える時間帯。本人設定。業務システムが受信者ごとに {start, end, timeZone} または null を返す）。

const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/
const DAY = 1440

function minutesOf(text) {
  const m = HHMM.exec(String(text ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** timeZone での壁時計（時・分・秒）。 */
function wallClock(nowMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]))
  return { h: Number(parts.hour) % 24, m: Number(parts.minute), s: Number(parts.second) }
}

/**
 * おやすみ時間の中なら、その終わり（epoch ms）を返す。外なら null。
 * 時間帯は [start, end)。start > end は日をまたぐ（例 20:00–08:00）。
 */
export function quietUntil(nowMs, quiet) {
  if (!quiet) return null
  const start = minutesOf(quiet.start)
  const end = minutesOf(quiet.end)
  if (start === null || end === null || start === end) return null
  let clock
  try {
    clock = wallClock(nowMs, quiet.timeZone || 'Asia/Tokyo')
  } catch {
    clock = wallClock(nowMs, 'Asia/Tokyo')
  }
  const cur = clock.h * 60 + clock.m
  const inside = start < end ? cur >= start && cur < end : cur >= start || cur < end
  if (!inside) return null
  const delta = (end - cur + DAY) % DAY
  return nowMs - (nowMs % 1000) - clock.s * 1000 + delta * 60_000
}
