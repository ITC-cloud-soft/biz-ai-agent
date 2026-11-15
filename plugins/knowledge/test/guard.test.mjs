// The citation guard as a dsh-im answer filter: chained with other filters (dsh-im runs them in registration order), it repairs
// an answer of a turn that used the knowledge tool, and leaves every other answer alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSourceLedger } from '../src/ledger.js'
import { apply, citationFilter, name } from '../src/guard.js'

/** The chain semantics of dsh-im's im-extensions (setAnswerFilter / filterAnswer), reduced to what the guard relies on. */
function fakeDshIm() {
  const filters = []
  return {
    setAnswerFilter(f) { filters.push(f); return { dispose: () => filters.splice(filters.indexOf(f), 1) } },
    async filterAnswer({ sessionId, text }) {
      let out = text
      for (const f of [...filters]) { const next = await f({ sessionId, text: out }); if (typeof next === 'string') out = next }
      return out
    },
    count: () => filters.length,
  }
}

const SOURCES = [{ n: 1, source: { title: 'Leave policy › Carry-over', url: '/handbook/leave-policy#carry-over' } }]

test('chained after another filter; repairs the turn that used knowledge, then forgets it', async () => {
  const ledger = createSourceLedger()
  const dshIm = fakeDshIm()
  dshIm.setAnswerFilter(({ text }) => text.replace('https://evil.example', '(link removed)')) // a link guard stand-in
  const disposers = []
  apply({ dshIm, logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }), on: (ev, fn) => ev === 'dispose' && disposers.push(fn) }, { ledger })
  assert.equal(name, 'bridge-knowledge-guard')
  assert.equal(dshIm.count(), 2, 'added next to the other filter')

  ledger.remember('s-1', SOURCES)
  const fixed = await dshIm.filterAnswer({ sessionId: 's-1', text: 'Up to 5 days carry over. See https://evil.example' })
  assert.equal(fixed, 'Up to 5 days carry over. See (link removed)\n\nSources:\n[1] Leave policy › Carry-over — /handbook/leave-policy#carry-over')
  assert.equal(await dshIm.filterAnswer({ sessionId: 's-1', text: 'Hello!' }), 'Hello!', 'the next answer used no knowledge')
  ledger.remember('s-2', SOURCES)
  const good = 'Up to 5 days carry over [1].\n\nSources:\n[1] Leave policy › Carry-over — /handbook/leave-policy#carry-over'
  assert.equal(await dshIm.filterAnswer({ sessionId: 's-2', text: good }), good, 'a cited answer is unchanged')
  assert.equal(await dshIm.filterAnswer({ sessionId: 's-3', text: 'no tool here' }), 'no tool here')
  for (const d of disposers) d()
  assert.equal(dshIm.count(), 1, 'dispose removes only the guard')
})

test('no setAnswerFilter (an older dsh-im): a warning, nothing installed', () => {
  const warned = []
  apply({ dshIm: {}, logger: () => ({ info() {}, warn: (m) => warned.push(m), debug() {}, error() {} }) })
  assert.match(warned[0], /setAnswerFilter is missing/)
  assert.equal(citationFilter({ ledger: createSourceLedger() })({ sessionId: 'x', text: 't' }), 't')
})
