// Manifest validation: JSON Schema (schema/manifest.schema.json) + cross-reference and safety checks.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateSchema } from './jsonschema.mjs'
import { isPiiLikeKey } from './pii.mjs'
import { parseDocument } from './yaml.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

let manifestSchema = null
let eventSchema = null
export function loadManifestSchema() {
  manifestSchema ??= JSON.parse(readFileSync(here('../schema/manifest.schema.json'), 'utf8'))
  return manifestSchema
}
export function loadEventEnvelopeSchema() {
  eventSchema ??= JSON.parse(readFileSync(here('../schema/event-envelope.schema.json'), 'utf8'))
  return eventSchema
}

/** Reads a manifest file (YAML subset or JSON). */
export function loadManifestFile(file) {
  return parseDocument(readFileSync(file, 'utf8'), file)
}

/**
 * validateManifest(manifest) -> { valid, errors, warnings }
 * errors / warnings: [{ path, message, code }]. `valid` is true when there are no errors.
 * Checks beyond the schema:
 *  - roles / events / tools / templates / playbooks / audience rules that are referenced must exist
 *  - tool names are unique; propose tools are POST; a tool's roles may not exceed what the role's delegation ceiling allows
 *  - payload keys never look like personal data (an `...Id` key is fine)
 *  - a notified event needs an audience; an event may not be both internal and notified / playbook-driven
 *  - audience.include names declared audience rules; audience.fallback (hand-over when nobody is left) names known roles and
 *    templates the event's notify may pick (warning), and only makes sense on a notified event (warning)
 *  - a deprecated event (no longer emitted) has no audience / notify / playbook, and no playbook triggers on it
 *  - playbooks with approval: none may not use propose tools unless the audience can review (warning)
 *  - cron triggers are 5-field; scheduled reports reference known sections of their role map
 *  - the internal events (INTERNAL_EVENTS: approval.requested / approval.decided / sns_identity.unlinked) are declared with
 *    their fixed payload keys and owner (warning: without them unlinking and approvals fail at run time)
 */
export const INTERNAL_EVENTS = Object.freeze({
  'approval.requested': Object.freeze({
    payload: ['approvalId', 'subjectType', 'subjectId', 'requiredRole', 'expiresAt'], internal: 'approvals_im',
    why: 'the business emits it when it creates an approval (approval cards, conformance A1-A4)',
  }),
  'approval.decided': Object.freeze({
    payload: ['approvalId', 'subjectType', 'subjectId', 'decision', 'status', 'channel', 'decidedByUserId'], internal: 'approvals_im',
    why: 'the business emits it when an approval is decided on the web or in IM',
  }),
  'sns_identity.unlinked': Object.freeze({
    payload: ['identityId', 'userId', 'platform'], internal: 'identity',
    why: 'server-kit emits it when an employee unlinks an IM account (DELETE /me/identities/{id} would fail, conformance L9 / E2)',
  }),
})

export function validateManifest(manifest) {
  const errors = []
  const warnings = []
  const err = (path, message, code) => errors.push({ path, message, code })
  const warn = (path, message, code) => warnings.push({ path, message, code })

  const schemaResult = validateSchema(loadManifestSchema(), manifest)
  for (const e of schemaResult.errors) err(e.path || '/', e.message, `schema.${e.keyword}`)
  if (!manifest || typeof manifest !== 'object' || schemaResult.errors.some((e) => e.keyword === 'type' && e.path === '')) {
    return { valid: false, errors, warnings }
  }

  const roles = manifest.roles && typeof manifest.roles === 'object' ? manifest.roles : {}
  const roleIds = new Set(Object.keys(roles))
  const entities = manifest.entities && typeof manifest.entities === 'object' ? manifest.entities : {}
  const events = manifest.events && typeof manifest.events === 'object' ? manifest.events : {}
  const templates = manifest.templates && typeof manifest.templates === 'object' ? manifest.templates : {}
  const playbooks = manifest.playbooks && typeof manifest.playbooks === 'object' ? manifest.playbooks : {}
  const rules = manifest.audienceRules && typeof manifest.audienceRules === 'object' ? manifest.audienceRules : null
  const tools = Array.isArray(manifest.tools) ? manifest.tools : []
  const toolNames = new Set()

  const checkRoles = (path, list) => {
    for (const r of Array.isArray(list) ? list : []) if (!roleIds.has(r)) err(path, `unknown role "${r}"`, 'ref.role')
  }
  const checkRule = (path, rule) => {
    if (rules && !(rule in rules)) err(path, `audience rule "${rule}" is not declared in audienceRules`, 'ref.audience_rule')
    else if (!rules) warn(path, `audience rule "${rule}" is not documented (no audienceRules section)`, 'ref.audience_rule_undeclared')
  }
  // notified: the templates the event's notify may pick (events only, null when not notified); a hand-over template must be one of them
  const checkAudience = (path, audience, { notified } = {}) => {
    if (!audience || typeof audience !== 'object') return
    checkRoles(`${path}/roles`, audience.roles)
    if (audience.rule !== undefined) checkRule(`${path}/rule`, audience.rule)
    for (const r of Array.isArray(audience.include) ? audience.include : []) checkRule(`${path}/include`, r)
    if (audience.fallback && typeof audience.fallback === 'object') {
      checkRoles(`${path}/fallback/roles`, audience.fallback.roles)
      for (const t of Array.isArray(audience.fallback.templates) ? audience.fallback.templates : []) {
        if (!(t in templates)) err(`${path}/fallback/templates`, `template "${t}" is not declared in templates`, 'ref.template')
        else if (notified && !notified.includes(t)) warn(`${path}/fallback/templates`, `template "${t}" is not one the event's notify may pick (template / variants)`, 'audience.fallback_template')
      }
      if (notified === null) warn(`${path}/fallback`, 'a hand-over (fallback) only applies to a notified event', 'audience.fallback_unused')
    }
  }

  for (const [id, rule] of Object.entries(rules ?? {})) checkRoles(`/audienceRules/${id}/roles`, rule?.roles)

  for (const [type, ev] of Object.entries(events)) {
    const p = `/events/${type}`
    if (!ev || typeof ev !== 'object') continue
    if (ev.aggregate !== undefined && !(ev.aggregate in entities)) err(`${p}/aggregate`, `unknown entity "${ev.aggregate}"`, 'ref.entity')
    for (const key of Array.isArray(ev.payload) ? ev.payload : []) {
      if (isPiiLikeKey(key)) err(`${p}/payload`, `payload key "${key}" looks like personal data or free text; events carry IDs, dates, counts and status values only`, 'pii.payload_key')
    }
    checkAudience(`${p}/audience`, ev.audience, { notified: ev.notify ? [ev.notify.template, ...(ev.notify.variants ?? [])] : null })
    if (ev.notify) {
      if (!ev.audience) err(`${p}/audience`, 'an event with notify needs an audience', 'notify.audience_required')
      for (const t of [ev.notify.template, ...(ev.notify.variants ?? [])]) {
        if (!(t in templates)) err(`${p}/notify`, `template "${t}" is not declared in templates`, 'ref.template')
      }
    }
    if (ev.playbook !== undefined) {
      if (!(ev.playbook in playbooks)) err(`${p}/playbook`, `unknown playbook "${ev.playbook}"`, 'ref.playbook')
      else if (!(playbooks[ev.playbook]?.trigger?.events ?? []).includes(type)) {
        warn(`${p}/playbook`, `playbook "${ev.playbook}" does not list ${type} in its trigger`, 'ref.playbook_trigger')
      }
      if (!ev.audience) err(`${p}/audience`, 'an event with a playbook needs an audience', 'playbook.audience_required')
    }
    if (ev.internal && (ev.notify || ev.playbook)) err(p, 'an internal event cannot also be notified or handled by a playbook', 'event.internal_conflict')
    if (ev.deprecated && (ev.audience || ev.notify || ev.playbook)) {
      err(p, 'a deprecated event cannot have an audience, be notified or be handled by a playbook', 'event.deprecated_conflict')
    }
  }

  tools.forEach((tool, i) => {
    const p = `/tools/${i}`
    if (!tool || typeof tool !== 'object') return
    if (toolNames.has(tool.name)) err(`${p}/name`, `duplicate tool name "${tool.name}"`, 'tool.duplicate')
    toolNames.add(tool.name)
    checkRoles(`${p}/roles`, tool.roles)
    if (tool.access === 'read' && typeof tool.http === 'string' && !tool.http.startsWith('GET ') && !tool.open) {
      warn(`${p}/http`, 'a read tool should call a GET endpoint', 'tool.read_not_get')
    }
    // delegation ceiling: a role whose delegation is none / read cannot be listed on a propose tool
    for (const r of Array.isArray(tool.roles) ? tool.roles : []) {
      const ceiling = roles[r]?.delegation ?? 'propose'
      if (tool.access === 'propose' && ceiling !== 'propose') err(`${p}/roles`, `role "${r}" has delegation "${ceiling}" and cannot use the propose tool`, 'tool.role_ceiling')
      if (tool.access === 'read' && ceiling === 'none' && !tool.open) err(`${p}/roles`, `role "${r}" has delegation "none" and cannot use a tool`, 'tool.role_ceiling')
    }
    if (tool.input?.$ref !== undefined) {
      const m = /^#\/schemas\/([A-Za-z0-9_]+)$/.exec(tool.input.$ref)
      if (!m || !manifest.schemas || !(m[1] in manifest.schemas)) err(`${p}/input`, `unresolvable input $ref ${tool.input.$ref}`, 'ref.schema')
    }
  })

  // the manual search tool (help.tool) is a declared read tool on a GET path without parameters
  if (manifest.help && typeof manifest.help === 'object') {
    const t = tools.find((x) => x.name === manifest.help.tool)
    if (!t) err('/help/tool', `unknown tool "${manifest.help.tool}"`, 'ref.tool')
    else if (t.access !== 'read' || !/^GET \/[^{}\s]*$/.test(String(t.http ?? ''))) err('/help/tool', 'the help tool must be a read tool on a GET path without parameters', 'help.tool')
  }

  for (const [id, tpl] of Object.entries(templates)) {
    for (const key of Object.keys(tpl?.params ?? {})) {
      if (isPiiLikeKey(key)) err(`/templates/${id}/params/${key}`, 'template parameter name looks like personal data or free text', 'pii.template_param')
    }
  }

  for (const [id, pb] of Object.entries(playbooks)) {
    const p = `/playbooks/${id}`
    if (!pb || typeof pb !== 'object') continue
    for (const t of Array.isArray(pb.tools) ? pb.tools : []) if (!toolNames.has(t)) err(`${p}/tools`, `unknown tool "${t}"`, 'ref.tool')
    for (const e of pb.trigger?.events ?? []) {
      if (!(e in events)) err(`${p}/trigger/events`, `unknown event "${e}"`, 'ref.event')
      else if (events[e]?.deprecated) err(`${p}/trigger/events`, `event "${e}" is deprecated (no longer emitted)`, 'ref.event_deprecated')
    }
    checkAudience(`${p}/audience`, pb.audience)
    const uses = (Array.isArray(pb.tools) ? pb.tools : []).map((t) => tools.find((x) => x.name === t)).filter(Boolean)
    for (const tool of uses) {
      // the playbook runs with the audience's delegation: every audience role must be allowed to use each tool
      const audienceRoles = pb.audience?.roles ?? (pb.audience?.rule && rules?.[pb.audience.rule]?.roles) ?? []
      for (const r of audienceRoles) {
        if (!tool.roles.includes(r)) warn(`${p}/tools`, `audience role "${r}" may not use tool "${tool.name}" (it would be refused at run time)`, 'playbook.role_tool')
      }
    }
    if (pb.approval === 'none' && uses.some((t) => t.access === 'propose') && pb.delivery === 'always') {
      warn(`${p}/approval`, 'a playbook that proposes with delivery "always" and no approval can message people for every run', 'playbook.noisy')
    }
    // a per-person delegation (<class>=each) is issued for the person of the triggering event: it needs an event trigger
    if (typeof pb.delegation === 'string' && pb.delegation.endsWith('=each') && !Array.isArray(pb.trigger?.events)) {
      warn(`${p}/delegation`, 'a per-person delegation (<class>=each) needs an event trigger (the delegation is issued for the person of the triggering event)', 'playbook.delegation_each_trigger')
    }
    if (pb.trigger?.condition) {
      const [report] = String(pb.trigger.condition.metric).split('.')
      if (!manifest.reports || !(report in manifest.reports)) err(`${p}/trigger/condition/metric`, `metric refers to unknown report "${report}"`, 'ref.report')
    }
  }

  // The events the kit and the internal plugins write in a fixed shape (server-kit emits sns_identity.unlinked; the business
  // emits the approval events in the transaction that creates / decides an approval): missing or reshaped, unlinking and
  // approvals fail at run time (500) although the manifest is otherwise valid.
  for (const [type, expected] of Object.entries(INTERNAL_EVENTS)) {
    const ev = events[type]
    const p = `/events/${type}`
    if (!ev) { warn(p, `declare ${type} (payload [${expected.payload.join(', ')}], internal: ${expected.internal}): ${expected.why}`, 'event.internal_missing'); continue }
    const keys = Array.isArray(ev.payload) ? ev.payload : []
    const missing = expected.payload.filter((k) => !keys.includes(k))
    if (missing.length) warn(`${p}/payload`, `${type} must carry [${expected.payload.join(', ')}] (missing ${missing.join(', ')})`, 'event.internal_payload')
    if (ev.internal && ev.internal !== expected.internal) warn(`${p}/internal`, `${type} is handled by the internal plugin "${expected.internal}"`, 'event.internal_owner')
  }

  for (const [id, rep] of Object.entries(manifest.reports ?? {})) {
    const p = `/reports/${id}`
    checkAudience(`${p}/audience`, rep?.audience)
    if (rep?.template !== undefined && !(rep.template in templates)) err(`${p}/template`, `template "${rep.template}" is not declared`, 'ref.template')
    if (rep?.event !== undefined && !(rep.event in events)) err(`${p}/event`, `event "${rep.event}" is not declared`, 'ref.event')
    if (rep?.playbook !== undefined && !(rep.playbook in playbooks)) err(`${p}/playbook`, `playbook "${rep.playbook}" is not declared`, 'ref.playbook')
    for (const [r, secs] of Object.entries(rep?.sectionsByRole ?? {})) {
      if (!roleIds.has(r)) err(`${p}/sectionsByRole/${r}`, `unknown role "${r}"`, 'ref.role')
      for (const s of secs) if (!(rep.sections ?? []).includes(s)) err(`${p}/sectionsByRole/${r}`, `section "${s}" is not in the report sections`, 'ref.section')
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Convenience lookups used by the conformance suite. */
export function eventPayloadKeys(manifest, type) {
  const ev = manifest?.events?.[type]
  return ev ? [...ev.payload] : null
}
