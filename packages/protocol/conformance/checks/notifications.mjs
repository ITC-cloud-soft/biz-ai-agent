// N: deterministic IM notifications (invariants 1, 4, 5): the business system resolves the recipients,
// text parameters are numbers / times only, links carry no personal data, preferences are the employee's own.
import assert from 'node:assert/strict'
import { checkNotificationLink, checkNotificationParams } from '../../src/notify.mjs'

const REQ = { requires: ['hook:emitNotifiableEvent'] }

export function register(s) {
  /** A linked employee that the next notifiable event is for, plus the event. */
  async function setup(c, role = 'manager') {
    const employee = await c.fx.newEmployee(role)
    const { source } = await c.linkEmployee(employee)
    const event = await c.fx.hooks.emitNotifiableEvent({ employee, platform: c.fx.platform })
    return { employee, source, event }
  }
  const resolve = (c, eventId, platforms = c.fx.platform) => c.api.get(c.v1(`/notifications/for-event/${eventId}`), c.as.service(), { platforms })

  s.check('N1', 'recipients are resolved by the business system; params are typed numbers / times, links carry no personal data', async (c) => {
    const { employee, source, event } = await setup(c)
    const r = await resolve(c, event.eventId)
    c.ok(r, 200, 'resolve')
    c.shape('resolveNotificationRecipients', 200, r)
    assert.equal(r.body.supported, true)
    assert.equal(r.body.eventId, event.eventId)
    const mine = r.body.recipients.find((x) => x.userId === employee.id)
    assert.ok(mine, 'the employee the event is for is a recipient')
    assert.equal(mine.identity.platform, c.fx.platform)
    assert.equal(mine.identity.externalId, source.userId)
    const probes = await c.fx.probes()
    for (const rec of r.body.recipients) {
      assert.equal(rec.identity.platform, c.fx.platform, 'only the requested platform is used')
      const p = checkNotificationParams(rec.template, rec.params, { manifest: c.manifest(), probes })
      assert.ok(p.ok, `IM params for ${rec.template}: ${JSON.stringify(p.problems)}`)
      const l = checkNotificationLink(rec.link, { probes })
      assert.ok(l.ok, `IM link: ${JSON.stringify(l.problems)}`)
    }
    // the event's declared notify template (or one of its variants) is what was chosen
    const decl = c.manifest()?.events?.[event.type]?.notify
    if (decl) assert.ok([decl.template, ...(decl.variants ?? [])].includes(mine.template), `template ${mine.template} is not declared for ${event.type}`)
    c.err(await resolve(c, 999999999999), 404, ['event_not_found'], 'unknown event')
    c.err(await c.api.get(c.v1(`/notifications/for-event/${event.eventId}`), c.as.service(), { platforms: 'bad platform!' }), 400, null, 'malformed platforms')
    c.err(await c.api.get(c.v1(`/notifications/for-event/${event.eventId}`), c.as.user(employee), { platforms: c.fx.platform }), 403, null, 'an employee asking who gets notified')
    c.err(await c.api.get(c.v1(`/notifications/for-event/${event.eventId}`), c.as.anon(), { platforms: c.fx.platform }), 401, null, 'anonymous')
  }, REQ)

  s.check('N2', 'delivery results: sent is terminal and deduplicates the next resolution; other employees\' rows are unknown', async (c) => {
    const { employee, event } = await setup(c)
    const first = await resolve(c, event.eventId)
    assert.ok(first.body.recipients.some((x) => x.userId === employee.id))
    const send = (status, extra = {}) => c.api.post(c.v1('/notifications/deliveries'), c.as.service(), { userId: employee.id, eventIds: [event.eventId], status, channel: c.fx.platform, ...extra })
    const sent = await send('sent', { messageRef: 'conformance-ref' })
    c.ok(sent, 200, 'report sent')
    c.shape('recordNotificationDelivery', 200, sent)
    assert.equal(sent.body.updated, 1)
    const downgrade = await send('failed', { errorCode: 'late_failure' })
    c.ok(downgrade, 200)
    assert.equal(downgrade.body.updated, 0, 'sent is terminal: a later failure never downgrades it')
    const again = await resolve(c, event.eventId)
    assert.ok(!again.body.recipients.some((x) => x.userId === employee.id), 'an employee already notified of this event is left out')
    assert.ok((again.body.alreadyNotified ?? 0) >= 1)
    const other = await c.api.post(c.v1('/notifications/deliveries'), c.as.service(), { userId: c.fx.employees.admin.id, eventIds: [event.eventId], status: 'sent' })
    c.ok(other, 200)
    assert.deepEqual([other.body.updated, other.body.unknown], [0, [event.eventId]], 'a report for a pair that was never resolved is "unknown"')
    c.err(await send('delivered-ish'), 400, null, 'unknown status')
    c.err(await c.api.post(c.v1('/notifications/deliveries'), c.as.service(), { userId: employee.id, eventIds: [], status: 'sent' }), 400, null, 'empty eventIds')
    c.err(await c.api.post(c.v1('/notifications/deliveries'), c.as.user(employee), { userId: employee.id, eventIds: [event.eventId], status: 'sent' }), 403, null, 'an employee reporting deliveries')
  }, REQ)

  s.check('N3', 'preferences are the employee\'s own and are honoured at resolution time; a userId in the body is refused', async (c) => {
    const { employee, event } = await setup(c)
    const other = await c.fx.newEmployee('staff')
    const prefs = await c.api.get(c.v1('/me/notification-preferences'), c.as.user(employee))
    c.ok(prefs, 200)
    c.shape('getMyNotificationPreferences', 200, prefs)
    assert.ok(prefs.body.types.includes(event.type), `${event.type} is a notifiable type`)
    const before = prefs.body.preferences.types[event.type].im
    const put = (emp, body) => c.api.put(c.v1('/me/notification-preferences'), c.as.user(emp), body)
    c.err(await put(employee, { types: { [event.type]: { im: false } }, userId: other.id }), 400, null, 'a userId in the body')
    c.err(await put(employee, { types: { 'no.such_type': { im: false } } }), 400, null, 'unknown type')
    const otherBefore = (await c.api.get(c.v1('/me/notification-preferences'), c.as.user(other))).body.preferences.types[event.type].im
    const off = await put(employee, { types: { [event.type]: { im: false } } })
    c.ok(off, 200, 'opt out')
    c.shape('updateMyNotificationPreferences', 200, off)
    const otherAfter = (await c.api.get(c.v1('/me/notification-preferences'), c.as.user(other))).body.preferences.types[event.type].im
    assert.equal(otherAfter, otherBefore, "another employee's preference is untouched")
    const resolved = await resolve(c, event.eventId)
    assert.ok(!resolved.body.recipients.some((x) => x.userId === employee.id), 'an employee who opted out is not a recipient')
    const on = await put(employee, { types: { [event.type]: { im: before } } })
    c.ok(on, 200, 'restore')
    if (before) {
      const back = await resolve(c, event.eventId)
      assert.ok(back.body.recipients.some((x) => x.userId === employee.id), 'the preference is read at resolution time')
    }
    c.err(await c.api.get(c.v1('/me/notification-preferences'), c.as.service()), 403, null, 'service principal')
    const d = await c.linkedDelegation('staff')
    c.err(await put({ headers: c.as.delegated(d.token) }, { types: {} }), 403, ['delegation_not_permitted'], 'delegation token')
    c.err(await c.api.get(c.v1('/me/notification-preferences'), c.as.anon()), 401, null, 'anonymous')
  }, REQ)
}
