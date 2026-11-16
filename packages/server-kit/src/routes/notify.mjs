// Events (cursor), deterministic IM notifications (recipients resolved by the business — hooks.recipientsFor — with typed
// params, never names) and the employee's own notification preferences.
import { eventJson } from '../events.mjs'
import { POLICY } from '../gate.mjs'
import { fail, iso, isObject, PLATFORM_RE, strictKeys, TIME_RE } from '../http.mjs'
import { notifiableTypes } from '../manifest.mjs'

export const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, start: '22:00', end: '07:00' })
const TERMINAL = ['sent', 'skipped']

/** The employee's preferences with the manifest defaults filled in (notify.default 'on' | 'off'). */
export async function preferencesOf(kit, userId, t = kit.store) {
  const notifiable = notifiableTypes(kit.manifest)
  const saved = await t.getPrefs(userId)
  const types = {}
  for (const type of notifiable) {
    const def = (kit.manifest.events[type].notify.default ?? 'on') === 'on'
    types[type] = { im: typeof saved?.types?.[type]?.im === 'boolean' ? saved.types[type].im : def }
  }
  return { types, quietHours: { ...DEFAULT_QUIET_HOURS, ...(kit.config.defaultQuietHours ?? {}), ...(saved?.quietHours ?? {}) }, ...(saved ? { updatedAt: iso(saved.updatedAt) } : {}) }
}

const wireIdentity = (i) => ({ platform: i.platform, ...(i.teamId ? { teamId: i.teamId } : {}), externalId: i.externalId, ...(i.botId ? { botId: i.botId } : {}) })

export function registerNotify(router, kit) {
  const { store, manifest } = kit
  const notifiable = notifiableTypes(manifest)
  const tz = manifest.system?.timezone ?? 'UTC'

  // ---------------------------------------------------------------- events
  router.add('GET', '/bridge/v1/events', POLICY.SERVICE, async ({ query }) => {
    const rawAfter = query.get('after') ?? '0'
    const rawLimit = query.get('limit') ?? '100'
    if (!/^\d{1,15}$/.test(rawAfter)) fail(400, 'invalid_after')
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500) fail(400, 'invalid_limit')
    const after = Number(rawAfter)
    const events = (await store.listEvents(after, Number(rawLimit))).map(eventJson)
    if (events.length) await store.audit({ actor: 'ai', action: 'events.read', detail: { after, count: events.length } })
    return { status: 200, body: { ok: true, events, nextAfter: events.length ? events[events.length - 1].id : after } }
  })

  // ---------------------------------------------------------------- notifications
  router.add('GET', '/bridge/v1/notifications/for-event/:eventId', POLICY.SERVICE, async ({ params, query }) => {
    if (!/^\d{1,15}$/.test(params.eventId) || Number(params.eventId) < 1) fail(400, 'invalid_event_id')
    const raw = query.get('platforms')
    let platforms = null
    if (raw !== null) {
      platforms = raw.split(',').map((s) => s.trim())
      if (!platforms.length || platforms.length > 10 || platforms.some((p) => !PLATFORM_RE.test(p))) fail(400, 'invalid_platforms')
    }
    const eventId = Number(params.eventId)
    return store.tx(async (t) => {
      const stored = await t.getEvent(eventId)
      if (!stored) fail(404, 'event_not_found')
      const event = eventJson(stored)
      const base = { ok: true, eventId, type: event.type }
      const decl = manifest.events?.[event.type]
      if (!decl?.notify || decl.internal || !kit.hooks.recipientsFor) return { status: 200, body: { ...base, supported: false, recipients: [] } }
      const plan = await kit.hooks.recipientsFor(event, kit.ctx(t))
      if (!plan) return { status: 200, body: { ...base, supported: false, recipients: [] } }
      if (plan.stale) return { status: 200, body: { ...base, supported: true, stale: plan.stale, recipients: [] } }

      const recipients = []
      let alreadyNotified = 0
      const seen = new Set()
      for (const u of plan.users ?? []) {
        const userId = String(u.id)
        if (seen.has(userId)) continue
        seen.add(userId)
        const prefs = await preferencesOf(kit, userId, t)
        if (!prefs.types[event.type]?.im) continue // the employee's own preference, read at resolution time
        const done = await t.getDelivery(eventId, userId)
        if (TERMINAL.includes(done?.status)) { alreadyNotified += 1; continue }
        const ids = await t.listIdentities(userId, { platforms })
        if (!ids.length) continue
        const identity = platforms ? platforms.map((p) => ids.find((r) => r.platform === p)).find(Boolean) : ids[0]
        await t.insertDeliveryIfAbsent({ eventId, userId, channel: identity.platform })
        recipients.push({
          userId,
          identity: wireIdentity(identity),
          template: plan.template ?? decl.notify.template,
          params: plan.paramsFor ? await plan.paramsFor(u) : (plan.params ?? {}),
          link: plan.link ?? null,
          quietHours: prefs.quietHours.enabled && decl.notify.quiet !== 'exempt' ? { start: prefs.quietHours.start, end: prefs.quietHours.end, timeZone: tz } : null,
        })
      }
      await t.audit({ actor: 'ai', action: 'notifications.resolved', target: String(eventId), detail: { recipients: recipients.length } })
      return { status: 200, body: { ...base, dedupeKey: plan.dedupeKey ?? `${event.type}:${event.aggregateId}:${event.id}`, supported: true, alreadyNotified, recipients } }
    })
  })

  router.add('POST', '/bridge/v1/notifications/deliveries', POLICY.SERVICE, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['userId', 'eventIds', 'status', 'messageRef', 'errorCode', 'channel'])
    if (typeof b.userId !== 'string' || !b.userId || b.userId.length > 128) fail(400, 'invalid_user_id')
    if (!Array.isArray(b.eventIds) || !b.eventIds.length || b.eventIds.length > 500 || b.eventIds.some((x) => !Number.isSafeInteger(x) || x < 1)) fail(400, 'invalid_event_ids')
    if (!['sent', 'failed', 'skipped', 'undeliverable'].includes(b.status)) fail(400, 'invalid_status')
    if (b.messageRef !== undefined && (typeof b.messageRef !== 'string' || b.messageRef.length > 300)) fail(400, 'invalid_message_ref')
    if (b.errorCode !== undefined && (typeof b.errorCode !== 'string' || !/^[A-Za-z0-9_.:-]{1,60}$/.test(b.errorCode))) fail(400, 'invalid_error_code')
    if (b.channel !== undefined && (typeof b.channel !== 'string' || !PLATFORM_RE.test(b.channel))) fail(400, 'invalid_channel')
    const result = { updated: 0, unchanged: 0, unknown: [] }
    await store.tx(async (t) => {
      for (const id of [...new Set(b.eventIds)]) {
        // only rows created by a resolution can be reported; sent / skipped are terminal (never downgraded)
        const row = await t.getDelivery(id, b.userId)
        if (!row) { result.unknown.push(id); continue }
        if (TERMINAL.includes(row.status)) { result.unchanged += 1; continue }
        await t.updateDelivery(id, b.userId, { status: b.status, messageRef: b.messageRef ?? null, errorCode: b.errorCode ?? null, channel: b.channel ?? null })
        result.updated += 1
      }
    })
    return { status: 200, body: { ok: true, ...result } }
  })

  // ---------------------------------------------------------------- me: my notification preferences
  router.add('GET', '/bridge/v1/me/notification-preferences', POLICY.USER, async ({ principal }) => {
    return { status: 200, body: { ok: true, preferences: await preferencesOf(kit, principal.user.id), types: notifiable } }
  })

  router.add('PUT', '/bridge/v1/me/notification-preferences', POLICY.USER, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['types', 'quietHours']) // a userId in the body is refused: preferences are always the caller's own
    if (!Object.keys(b).length) fail(400, 'invalid_input')
    const me = principal.user.id
    const current = await preferencesOf(kit, me)
    const types = Object.fromEntries(Object.entries(current.types).map(([k, v]) => [k, { im: v.im }]))
    if (b.types !== undefined) {
      if (!isObject(b.types)) fail(400, 'invalid_types')
      for (const [type, value] of Object.entries(b.types)) {
        if (!notifiable.includes(type)) fail(400, 'invalid_types')
        if (!isObject(value) || Object.keys(value).some((k) => k !== 'im') || typeof value.im !== 'boolean') fail(400, 'invalid_types')
        types[type] = { im: value.im }
      }
    }
    const quiet = { ...current.quietHours }
    if (b.quietHours !== undefined) {
      if (!isObject(b.quietHours) || Object.keys(b.quietHours).some((k) => !['enabled', 'start', 'end'].includes(k))) fail(400, 'invalid_quiet_hours')
      const { enabled, start, end } = b.quietHours
      if (enabled !== undefined && typeof enabled !== 'boolean') fail(400, 'invalid_quiet_hours')
      if (start !== undefined && (typeof start !== 'string' || !TIME_RE.test(start))) fail(400, 'invalid_quiet_hours')
      if (end !== undefined && (typeof end !== 'string' || !TIME_RE.test(end))) fail(400, 'invalid_quiet_hours')
      Object.assign(quiet, Object.fromEntries(Object.entries({ enabled, start, end }).filter(([, v]) => v !== undefined)))
    }
    await store.putPrefs(me, { types, quietHours: quiet })
    return { status: 200, body: { ok: true, preferences: await preferencesOf(kit, me) } }
  })
}
