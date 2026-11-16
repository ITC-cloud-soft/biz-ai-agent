// In-process scheduler of a running system: the manifest's daily report slots plus periodic business tasks (an overdue
// scan, pruning throttles). Idempotent by construction: scheduled reports are unique per (kind, date, slot), so several
// instances may run it at once.
import { cronToSlot } from './manifest.mjs'
import { localParts } from './time.mjs'

/**
 * startScheduler({ kit, tasks: [{ name, everyMinutes, run() }], everyMs = 60_000, log }) -> stop()
 * A report slot ("08:30") is generated on the first tick at or after it each day (missed slots are caught up once).
 */
export function startScheduler({ kit, tasks = [], everyMs = 60_000, log = () => {}, pruneThrottles = true }) {
  const slots = kit.reports ? kit.reports.cron.map(cronToSlot) : []
  const all = [...tasks, ...(pruneThrottles ? [{ name: 'prune-throttles', everyMinutes: 60, run: () => kit.store.pruneHits(24 * 60) }] : [])]
  let ticks = 0
  const tick = async () => {
    const minute = Math.round((ticks * everyMs) / 60_000)
    for (const task of all) {
      if (minute % Math.max(1, task.everyMinutes ?? 1) !== 0) continue
      try { await task.run() } catch (error) { log(`[scheduler] ${task.name}: ${error.message}`) }
    }
    if (slots.length) {
      try {
        const { time } = localParts(kit.now(), kit.timeZone)
        for (const slot of slots) {
          if (time < slot) continue
          const report = await kit.reports.generate({ slot })
          if (report) log(`[scheduler] report ${report.kind} ${report.date} ${report.slot} stored`)
        }
      } catch (error) { log(`[scheduler] report: ${error.message}`) }
    }
    ticks += 1
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  const first = tick()
  const stop = () => clearInterval(timer)
  stop.firstTick = first
  return stop
}
