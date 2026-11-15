// bridge-knowledge-guard — the citation guard, as a DSH plugin (cordis): an answer filter of dsh-im (ctx.dshIm.setAnswerFilter).
//
// dsh-im runs every registered answer filter on the agent's final IM answer, in registration order, each on the previous
// filter's output (vendor/dsh-im src/channels/shared/im-extensions.mjs) — so this guard sits NEXT TO bridge-identity's link
// guard, it does not replace it. List it BEFORE bridge-identity in the profile so the link guard sees the final text.
//
//   # cordis.patch.yml
//   - id: bridge-knowledge-guard
//     name: '@dsh-bridge/plugin-knowledge/guard'
//
// What it does: when the knowledge tool returned sources in THIS turn of this conversation (the ledger), the answer must cite
// them (checkCitations); otherwise ensureCitations repairs it (unknown [n] → [?], the "Sources:" block appended). The sources
// are taken out of the ledger, so a later answer that used no knowledge is never touched.
import { makeLogger, onDispose } from '@dsh-bridge/dsh-core'
import { ensureCitations } from './citations.js'
import { ledger as sharedLedger } from './index.js'

export const name = 'bridge-knowledge-guard'
export const inject = ['dshIm']

/** The answer filter: ({ sessionId, text }) -> text. */
export function citationFilter({ ledger = sharedLedger } = {}) {
  return ({ sessionId, text } = {}) => {
    const sources = ledger.recent(sessionId)
    if (!sources.length || typeof text !== 'string') return text
    ledger.forget(sessionId)
    return ensureCitations(text, sources)
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const dshIm = ctx.dshIm
  if (typeof dshIm?.setAnswerFilter !== 'function') {
    logger.warn('bridge-knowledge-guard: ctx.dshIm.setAnswerFilter is missing (an older dsh-im fork); answers are sent without the citation guard')
    return
  }
  const handle = dshIm.setAnswerFilter(citationFilter({ ledger: config.ledger ?? sharedLedger }))
  onDispose(ctx, () => (typeof handle === 'function' ? handle() : handle?.dispose?.()))
  logger.info('bridge-knowledge-guard: citation guard installed')
}
