// The Bridge v1 conformance suite. Entry: runSuite(target) inside a node:test file (see http.test.mjs).
//
// A check is  s.check(id, title, async (c) => { ... }, { requires: [...] })  where `c` is the context from lib/context.mjs.
//   requires: names resolved against the target: 'manifest', 'hook:<name>', 'capability:<name>', 'fixture:<name>'.
//   A missing requirement SKIPS the check (and the summary lists it): a system that does not provide the hook is not
//   proven for that behaviour. Known gaps (target.knownGaps[id]) are strict expected failures.
import { after, before, describe, test } from 'node:test'
import { buildContext } from './lib/context.mjs'
import * as protocol from './checks/protocol.mjs'
import * as linking from './checks/linking.mjs'
import * as bots from './checks/personal-bots.mjs'
import * as delegation from './checks/delegation.mjs'
import * as assistant from './checks/assistant.mjs'
import * as approvals from './checks/approvals.mjs'
import * as notifications from './checks/notifications.mjs'
import * as events from './checks/events.mjs'
import * as manifest from './checks/manifest.mjs'
import * as reports from './checks/reports.mjs'
import * as proposals from './checks/proposals.mjs'
import * as tally from './checks/zz-tally.mjs'

// order matters: later groups read the events earlier groups produced
export const GROUPS = [protocol, linking, bots, delegation, assistant, proposals, approvals, notifications, reports, events, manifest, tally]

function missingRequirement(target, requires = []) {
  for (const r of requires) {
    const [kind, name] = r.includes(':') ? r.split(':') : [r, '']
    if (kind === 'manifest' && !target.manifest) return 'a manifest (GET /manifest, or BRIDGE_MANIFEST_FILE)'
    if (kind === 'hook' && !target.fx?.hooks?.[name]) return `the fixture hook "${name}"`
    if (kind === 'capability' && target.fx?.capabilities?.[name] === false) return `capability "${name}" (declared off by the fixtures)`
    if (kind === 'fixture' && !target.fx?.[name]) return `the fixture "${name}"`
  }
  return null
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 220)

export function collectChecks() {
  const checks = []
  const s = { check: (id, title, fn, opts = {}) => checks.push({ id, title, fn, opts }) }
  for (const g of GROUPS) g.register(s)
  const ids = new Set()
  for (const c of checks) {
    if (ids.has(c.id)) throw new Error(`duplicate check id ${c.id}`)
    ids.add(c.id)
  }
  return checks
}

/**
 * Runs one check against a started target (programmatic runner, used by node:test below and by the mutation tests).
 * -> { state: 'pass' | 'fail' | 'skip' | 'gap', note, error? }
 */
export async function executeCheck(target, check, ctx) {
  const missing = missingRequirement(target, check.opts.requires)
  if (missing) return { state: 'skip', note: `requires ${missing}` }
  const gap = target.knownGaps[check.id]
  let failure = null
  try { await check.fn(ctx) } catch (e) { failure = e }
  if (gap) {
    if (!failure) return { state: 'fail', note: `${check.id} is declared a known gap ("${gap}") but it passed: remove it from knownGaps`, error: new Error('known gap passed') }
    return { state: 'gap', note: `${gap} [${firstLine(failure)}]` }
  }
  return failure ? { state: 'fail', note: firstLine(failure), error: failure } : { state: 'pass', note: '' }
}

export function runSuite(target) {
  const checks = collectChecks()
  let ctx = null
  describe(`bridge v1 conformance: ${target.name}`, () => {
    before(async () => {
      await target.start()
      ctx = buildContext(target)
    })
    after(async () => {
      const lines = [`bridge v1 conformance summary for ${target.name}: ${target.results.filter((r) => r.state === 'pass').length} passed, `
        + `${target.results.filter((r) => r.state === 'gap').length} known gaps, ${target.results.filter((r) => r.state === 'skip').length} skipped`]
      for (const r of target.results.filter((x) => x.state === 'gap')) lines.push(`  GAP  ${r.id}: ${r.note}`)
      for (const r of target.results.filter((x) => x.state === 'skip')) lines.push(`  SKIP ${r.id}: ${r.note}`)
      console.log(lines.join('\n'))
      await target.stop()
    })

    for (const check of checks) {
      test(`${check.id} ${check.title}`, async (t) => {
        const r = await executeCheck(target, check, ctx)
        target.results.push({ id: check.id, state: r.state, note: r.note })
        if (r.state === 'skip') t.skip(r.note)
        else if (r.state === 'gap') t.todo(`known gap: ${target.knownGaps[check.id]}`)
        else if (r.state === 'fail') throw r.error
      })
    }
  })
}
