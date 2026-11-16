// Calendar helpers in the system time zone (manifest system.timezone). Dates are 'YYYY-MM-DD' strings (no time zone shifts).

/** Local date / time in a time zone: { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
export function localParts(now = new Date(), timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

export const todayIn = (timeZone, now = new Date()) => localParts(now, timeZone).date

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** A real calendar date in 'YYYY-MM-DD' form (2026-02-30 is not). */
export const isValidDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
