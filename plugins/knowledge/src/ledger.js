// The sources the knowledge tool returned per conversation, for a short while (a reply guard checks the answer against them).
// Only numbers, titles and screen URLs — never the text of a chunk, never a question. In memory; nothing is persisted.

export const LEDGER_TTL_MS = 10 * 60_000
export const LEDGER_MAX_SESSIONS = 500

export function createSourceLedger({ ttlMs = LEDGER_TTL_MS, max = LEDGER_MAX_SESSIONS, now = () => Date.now() } = {}) {
  const map = new Map() // sessionId -> { at, sources }
  return {
    remember(sessionId, sources) {
      if (!sessionId) return
      map.delete(sessionId)
      map.set(sessionId, { at: now(), sources: sources.map((s) => ({ n: s.n, source: { title: s.source.title, url: s.source.url } })) })
      while (map.size > max) map.delete(map.keys().next().value)
    },
    recent(sessionId) {
      const e = sessionId ? map.get(sessionId) : null
      if (!e) return []
      if (now() - e.at > ttlMs) { map.delete(sessionId); return [] }
      return e.sources
    },
    forget: (sessionId) => map.delete(sessionId),
    size: () => map.size,
  }
}
