// E: invariant 4 for events: ordered cursor, declared types, whitelisted payload keys, no personal data.
import assert from 'node:assert/strict'
import { validateEventPage } from '../../src/events.mjs'
import { scanJson } from '../../src/pii.mjs'

export function register(s) {
  s.check('E1', 'GET /events: envelope, strictly increasing ids, nextAfter = last id, repeatable reads, bounded paging, input validation', async (c) => {
    const start = Math.max(0, (await c.latestEventCursor()) - 300)
    const r = await c.api.get(c.v1('/events'), c.as.service(), { after: start, limit: 500 })
    c.ok(r, 200)
    c.shape('listEvents', 200, r)
    const v = validateEventPage(r.body, { after: start })
    assert.ok(v.valid, JSON.stringify(v.errors.slice(0, 5)))
    assert.ok(r.body.events.length >= 1, 'the suite itself produced events (links, unlinks, approvals)')
    // repeatable
    const again = await c.api.get(c.v1('/events'), c.as.service(), { after: start, limit: 500 })
    assert.deepEqual(again.body.events, r.body.events)
    // paging with a small limit continues exactly where it stopped
    const p1 = await c.api.get(c.v1('/events'), c.as.service(), { after: start, limit: 2 })
    assert.ok(p1.body.events.length <= 2)
    if (r.body.events.length > 2) {
      const p2 = await c.api.get(c.v1('/events'), c.as.service(), { after: p1.body.nextAfter, limit: 2 })
      assert.equal(p2.body.events[0].id, r.body.events[2].id)
    }
    // beyond the end: empty page, the cursor does not move
    const far = r.body.nextAfter + 1_000_000
    const empty = await c.api.get(c.v1('/events'), c.as.service(), { after: far })
    c.ok(empty, 200)
    assert.deepEqual([empty.body.events, empty.body.nextAfter], [[], far])
    c.err(await c.api.get(c.v1('/events'), c.as.service(), { after: -1 }), 400, null, 'negative cursor')
    c.err(await c.api.get(c.v1('/events'), c.as.service(), { limit: 0 }), 400, null, 'limit 0')
    c.err(await c.api.get(c.v1('/events'), c.as.service(), { limit: 501 }), 400, null, 'limit above the maximum')
    c.err(await c.api.get(c.v1('/events'), c.as.service(), { after: 'abc' }), 400, null, 'non numeric cursor')
  })

  s.check('E2', 'every event is declared in the manifest, carries only its whitelisted payload keys and no personal data', async (c) => {
    if (c.fx.hooks.produceEvents) await c.fx.hooks.produceEvents()
    const probes = await c.fx.probes()
    const start = Math.max(0, (await c.latestEventCursor()) - 450)
    const r = await c.api.get(c.v1('/events'), c.as.service(), { after: start, limit: 500 })
    c.ok(r, 200)
    const v = validateEventPage(r.body, { after: start, manifest: c.manifest(), probes })
    assert.ok(v.valid, `events violate the manifest whitelist / PII rules:\n  ${v.errors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n  ')}`)
    const types = new Set(r.body.events.map((e) => e.type))
    assert.ok(types.size >= 2, `expected at least two event types in the window, saw ${[...types]}`)
    // aggregate ids are identifiers, never names
    for (const e of r.body.events) assert.deepEqual(scanJson(e.aggregateId, { probes }), [], `aggregateId of event ${e.id}`)
  }, { requires: ['manifest'] })

  s.check('E3', 'the system refuses to write an event with a non-whitelisted payload key or an undeclared type', async (c) => {
    const first = Object.keys(c.manifest().events)[0]
    const control = await c.fx.hooks.tryEmitEvent({ type: first, payload: {} })
    assert.equal(control.accepted, true, `positive control: an empty payload of ${first} must be accepted (${control.reason ?? ''})`)
    const badKey = await c.fx.hooks.tryEmitEvent({ type: Object.keys(c.manifest().events)[0], payload: { residentName: 'Taro Yamada' } })
    assert.equal(badKey.accepted, false, 'a payload with a name must be refused')
    const badType = await c.fx.hooks.tryEmitEvent({ type: 'made_up.event_type', payload: {} })
    assert.equal(badType.accepted, false, 'an undeclared event type must be refused')
  }, { requires: ['hook:tryEmitEvent', 'manifest'] })

  s.check('E4', 'the payload whitelist is PER EVENT TYPE: a key that is declared for another type but not for this one is refused too', async (c) => {
    const events = c.manifest().events
    let pick = null
    for (const [typeA, a] of Object.entries(events)) {
      for (const [typeB, b] of Object.entries(events)) {
        const stray = b.payload.find((k) => !a.payload.includes(k))
        if (typeA !== typeB && stray && !pick) pick = { type: typeA, key: stray, from: typeB }
      }
    }
    assert.ok(pick, 'the manifest has no two event types with different payload keys')
    const r = await c.fx.hooks.tryEmitEvent({ type: pick.type, payload: { [pick.key]: 1 } })
    assert.equal(r.accepted, false, `${pick.type} must refuse the key "${pick.key}" (declared only for ${pick.from})`)
  }, { requires: ['hook:tryEmitEvent', 'manifest'] })
}
