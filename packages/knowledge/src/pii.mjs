// The personal-data screen of the index: the SAME check as server-kit's POST /bridge/v1/pii-scan (the one bridge-memory calls).
//
//   bridgePiiScreen({ hooks, ctx? }) -> async (text) => { kinds }
//
//  - @dsh-bridge/protocol's shape check (e-mail, phone, postal code, long digit runs, …) with the "this is prose" kinds skipped
//    (cjk_text / free_text: every document sentence would count otherwise)
//  - plus hooks.piiScan(text, ctx) — the business system's own check (names in its roster, client names, …)
//  - a failing hook THROWS: the build fails, nothing is indexed (fail closed, like the route's 503)
// Pass it as buildKnowledgeIndex's `screen`. The build's local shape check (localKinds) still runs as well.
import { findPiiInString } from '@dsh-bridge/protocol'

/** The finding kinds POST /bridge/v1/pii-scan skips (they only say "this is prose"). */
export const PROSE_KINDS = Object.freeze(['cjk_text', 'free_text'])
const KIND_RE = /^[a-z][a-z0-9_]{0,40}$/

export function bridgePiiScreen({ hooks = null, ctx = null } = {}) {
  return async function screen(text) {
    const kinds = new Set(findPiiInString(String(text ?? ''), { allow: PROSE_KINDS }).map((f) => f.kind))
    if (typeof hooks?.piiScan === 'function') {
      let extra
      try {
        extra = await hooks.piiScan(String(text ?? ''), typeof ctx === 'function' ? ctx() : ctx)
      } catch (error) {
        throw new Error(`knowledge: the personal-data check (hooks.piiScan) failed — nothing is indexed (${error?.message ?? error})`)
      }
      for (const k of Array.isArray(extra?.kinds) ? extra.kinds : []) if (typeof k === 'string' && KIND_RE.test(k)) kinds.add(k)
    }
    return { kinds: [...kinds] }
  }
}
