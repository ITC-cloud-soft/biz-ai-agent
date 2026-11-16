// Link code countdown (6 digits, 10 minutes, single use). Pure, no imports.

export const secondsLeft = (expiresAt: number, now: number): number => Math.max(0, Math.floor((expiresAt - now) / 1000))

/** 125 -> { mm: '02', ss: '05' } */
export const mmss = (seconds: number): { mm: string; ss: string } => ({
  mm: String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0'),
  ss: String(Math.max(0, seconds) % 60).padStart(2, '0'),
})

/** The code read digit by digit (screen readers): '123456' -> '1 2 3 4 5 6'. */
export const spokenCode = (code: string): string => code.split('').join(' ')

/** What the page shows: nothing issued, a live code, or an expired one. */
export function linkCodeState(code: { code: string; expiresAt: number } | null, now: number): { kind: 'none' } | { kind: 'live'; code: string; left: number } | { kind: 'expired' } {
  if (!code) return { kind: 'none' }
  const left = secondsLeft(code.expiresAt, now)
  return left > 0 ? { kind: 'live', code: code.code, left } : { kind: 'expired' }
}
