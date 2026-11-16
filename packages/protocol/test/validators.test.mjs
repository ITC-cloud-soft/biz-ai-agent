import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERNAL_EVENTS, checkNotificationLink, checkNotificationParams, checkPayloadWhitelist, findPiiInString, isPiiLikeKey, loadManifestFile, validateEvent,
  validateEventPage, validateManifest,
} from '../src/index.mjs'

const MANIFESTS = fileURLToPath(new URL('../manifests/', import.meta.url))
const MANIFEST = join(MANIFESTS, 'example.manifest.yaml')
const example = () => loadManifestFile(MANIFEST)
// the first user's manifest lives in examples/care-billing (validated here too when the examples are present)
const CARE_MANIFEST = fileURLToPath(new URL('../../../examples/care-billing/manifest/care-billing.manifest.yaml', import.meta.url))
const clone = (x) => JSON.parse(JSON.stringify(x))
const codes = (r) => r.errors.map((e) => e.code)

/** A minimal valid manifest to mutate. */
const base = () => ({
  bridge: 1,
  system: { id: 'demo', name: 'Demo', locale: 'en-US', timezone: 'UTC' },
  roles: { admin: { label: 'Admin' }, staff: { label: 'Staff', delegation: 'read' } },
  entities: { order: { label: 'Order', pii: 'none' } },
  events: {
    'order.placed': { payload: ['orderId', 'count'], severity: 'info', aggregate: 'order', audience: { roles: ['admin'] }, notify: { template: 'order.placed' } },
    ...Object.fromEntries(Object.entries(INTERNAL_EVENTS).map(([type, e]) => [type, { payload: [...e.payload], severity: 'info', internal: e.internal }])),
  },
  templates: { 'order.placed': { params: { count: { type: 'integer' }, time: { type: 'time' } } } },
  tools: [{ name: 'list_orders', http: 'GET /orders', access: 'read', roles: ['admin', 'staff'] }],
})

describe('validateManifest', () => {
  test('a minimal manifest is valid; every bundled manifest is valid with no warnings', () => {
    assert.deepEqual(validateManifest(base()).errors, [])
    const files = readdirSync(MANIFESTS).filter((f) => /\.(ya?ml|json)$/.test(f)).map((f) => join(MANIFESTS, f))
    assert.ok(files.length >= 2)
    for (const file of files) {
      const r = validateManifest(loadManifestFile(file))
      assert.deepEqual(r.errors, [], file)
      assert.deepEqual(r.warnings, [], file)
    }
  })

  test('the care-billing manifest (examples/care-billing) is valid with no warnings', { skip: existsSync(CARE_MANIFEST) ? false : 'examples/care-billing is not present' }, () => {
    const r = validateManifest(loadManifestFile(CARE_MANIFEST))
    assert.deepEqual(r.errors, [])
    assert.deepEqual(r.warnings, [])
  })

  test('schema errors: protocol version, ids, unknown keys, missing parts', () => {
    const m = base()
    m.bridge = 2
    m.system.id = 'Bad Id'
    m.surprise = true
    delete m.roles.admin.label
    assert.deepEqual(codes(validateManifest(m)).sort(), ['schema.additionalProperties', 'schema.const', 'schema.pattern', 'schema.required'])
  })

  test('cross references: unknown role / entity / template / playbook / tool / event', () => {
    const m = base()
    m.tools[0].roles = ['admin', 'ghost']
    m.events['order.placed'].aggregate = 'nothing'
    m.events['order.placed'].notify.template = 'missing.template'
    m.events['order.placed'].playbook = 'nope'
    m.playbooks = { p: { agent: 'a', trigger: { events: ['not.declared'] }, instructions: 'x'.repeat(30), tools: ['no_tool'], audience: { roles: ['admin'] }, delivery: 'always', approval: 'none' } }
    const c = codes(validateManifest(m))
    for (const code of ['ref.role', 'ref.entity', 'ref.template', 'ref.playbook', 'ref.tool', 'ref.event']) assert.ok(c.includes(code), `${code} in ${c}`)
  })

  test('personal data guards: payload keys and template parameter names that look like names / free text', () => {
    const m = base()
    m.events['order.placed'].payload.push('residentName', 'comment')
    m.templates['order.placed'].params.patientName = { type: 'integer' }
    const c = codes(validateManifest(m))
    assert.equal(c.filter((x) => x === 'pii.payload_key').length, 2)
    assert.ok(c.includes('pii.template_param'))
    // an ...Id key is an identifier and fine
    const ok = base()
    ok.events['order.placed'].payload.push('commentId', 'residentId')
    assert.deepEqual(validateManifest(ok).errors, [])
  })

  test('tools: duplicate names, propose must POST, delegation ceiling', () => {
    const m = base()
    m.tools.push({ name: 'list_orders', http: 'GET /x', access: 'read', roles: ['admin'] })
    m.tools.push({ name: 'propose_order', http: 'GET /y', access: 'propose', roles: ['admin'] })
    m.tools.push({ name: 'propose_other', http: 'POST /z', access: 'propose', roles: ['admin', 'staff'] })
    const c = codes(validateManifest(m))
    assert.ok(c.includes('tool.duplicate'))
    assert.ok(c.includes('schema.pattern'), 'a propose tool must POST')
    assert.ok(c.includes('tool.role_ceiling'), 'staff has delegation read and cannot use a propose tool')
  })

  test('events: notify needs an audience; an internal event cannot be notified', () => {
    const m = base()
    delete m.events['order.placed'].audience
    assert.ok(codes(validateManifest(m)).includes('notify.audience_required'))
    const n = base()
    n.events['order.placed'].internal = 'identity'
    assert.ok(codes(validateManifest(n)).includes('event.internal_conflict'))
  })

  test('events: a deprecated event has no audience / notify / playbook and no playbook triggers on it', () => {
    const m = base()
    m.events['order.placed'].deprecated = true
    assert.ok(codes(validateManifest(m)).includes('event.deprecated_conflict'))
    const n = base()
    n.events['order.placed'] = { payload: n.events['order.placed'].payload, severity: 'info', deprecated: true }
    assert.ok(!codes(validateManifest(n)).includes('event.deprecated_conflict'))
    n.playbooks = { p: { agent: 'a-b', trigger: { events: ['order.placed'] }, instructions: 'x'.repeat(30), tools: ['list_orders'], audience: { roles: ['admin'] }, delivery: 'always', approval: 'none' } }
    assert.ok(codes(validateManifest(n)).includes('ref.event_deprecated'))
  })

  test('playbooks: trigger shape, cron format, audience roles vs tool roles (warning)', () => {
    const m = base()
    m.playbooks = {
      p: { agent: 'a-b', trigger: { cron: '30 8 * * *' }, instructions: 'x'.repeat(30), tools: ['list_orders'], audience: { roles: ['admin'] }, delivery: 'always', approval: 'none' },
    }
    assert.deepEqual(validateManifest(m).errors, [])
    m.playbooks.p.trigger = { cron: 'every day' }
    assert.ok(codes(validateManifest(m)).includes('schema.format'))
    m.playbooks.p.trigger = { cron: '30 8 * * *', events: ['order.placed'] }
    assert.ok(codes(validateManifest(m)).includes('schema.maxProperties'))
    const w = base()
    w.tools[0].roles = ['admin']
    w.playbooks = { p: { agent: 'a', trigger: { events: ['order.placed'] }, instructions: 'x'.repeat(30), tools: ['list_orders'], audience: { roles: ['admin', 'staff'] }, delivery: 'only_if_actionable', approval: 'none' } }
    const r = validateManifest(w)
    assert.deepEqual(r.errors, [])
    assert.ok(r.warnings.some((x) => x.code === 'playbook.role_tool'))
  })

  test('audience: optional include (declared rules) and fallback (hand-over roles / templates of the event)', () => {
    const m = base()
    m.audienceRules = { reviewers: { description: 'Reviewers.', roles: ['staff'] }, owner: { description: 'The owner of the order.', includes: ['owner'] } }
    m.templates['order.placed.fallback'] = { params: { count: { type: 'integer' } } }
    m.events['order.placed'].audience = { rule: 'reviewers', include: ['owner'], fallback: { roles: ['admin'], templates: ['order.placed.fallback'] } }
    m.events['order.placed'].notify.variants = ['order.placed.fallback']
    const ok = validateManifest(m)
    assert.deepEqual([ok.errors, ok.warnings], [[], []])
    const bad = clone(m)
    bad.events['order.placed'].audience = { rule: 'reviewers', include: ['nobody'], fallback: { roles: ['ghost'], templates: ['missing.template'] } }
    const c = codes(validateManifest(bad))
    assert.deepEqual(c.sort(), ['ref.audience_rule', 'ref.role', 'ref.template'])
    // a template the event cannot pick, and a hand-over on an event that is not notified: warnings
    const w = clone(m)
    delete w.events['order.placed'].notify.variants
    assert.ok(validateManifest(w).warnings.some((x) => x.code === 'audience.fallback_template'))
    const quiet = clone(m)
    delete quiet.events['order.placed'].notify
    assert.ok(validateManifest(quiet).warnings.some((x) => x.code === 'audience.fallback_unused'))
    // fallback needs roles; no other keys
    const shape = clone(m)
    shape.events['order.placed'].audience.fallback = { templates: ['order.placed.fallback'], extra: 1 }
    assert.deepEqual(codes(validateManifest(shape)).sort(), ['schema.additionalProperties', 'schema.required'])
  })

  test('playbooks: optional delegation class (<class> or <class>=each); a per-person delegation needs an event trigger (warning)', () => {
    const m = base()
    m.playbooks = { p: { agent: 'a-b', trigger: { events: ['order.placed'] }, instructions: 'x'.repeat(30), tools: ['list_orders'], audience: { roles: ['admin'] }, delivery: 'only_if_actionable', approval: 'none', delegation: 'sales=each' } }
    const ok = validateManifest(m)
    assert.deepEqual([ok.errors, ok.warnings], [[], []])
    m.playbooks.p.delegation = 'sales'
    assert.deepEqual(validateManifest(m).errors, [])
    for (const bad of ['Sales', 'sales=all', 'each=each=each', '=each', '']) {
      m.playbooks.p.delegation = bad
      assert.ok(codes(validateManifest(m)).includes('schema.pattern'), bad)
    }
    m.playbooks.p = { ...m.playbooks.p, delegation: 'sales=each', trigger: { cron: '0 7 20 * *' } }
    const w = validateManifest(m)
    assert.deepEqual(w.errors, [])
    assert.ok(w.warnings.some((x) => x.code === 'playbook.delegation_each_trigger'))
  })

  test('reports: sectionsByRole must be a subset of sections; unknown template / event / playbook', () => {
    const m = base()
    m.reports = { daily: { cron: ['30 8 * * *'], audience: { roles: ['admin'] }, sections: ['a', 'b'], sectionsByRole: { staff: ['c'] }, template: 'nope', event: 'no.event' } }
    const c = codes(validateManifest(m))
    assert.ok(c.includes('ref.section') && c.includes('ref.template') && c.includes('ref.event'))
  })
})

describe('events', () => {
  const m = example()
  const ev = (over = {}) => ({ id: 5, type: 'report.submitted', aggregateType: 'report', aggregateId: '3f2c1a60-0000-4000-8000-000000000001', payload: { reportId: 'r', authorUserId: 'u', version: 2 }, at: '2026-10-26T08:30:00.000Z', ...over })

  test('validateEvent: envelope shape', () => {
    assert.ok(validateEvent(ev()).valid)
    assert.ok(!validateEvent(ev({ id: 0 })).valid)
    assert.ok(!validateEvent(ev({ type: 'NoDots' })).valid)
    assert.ok(!validateEvent(ev({ at: 'yesterday' })).valid)
    assert.ok(!validateEvent({ ...ev(), extra: 1 }).valid)
    assert.ok(!validateEvent(ev({ payload: { nested: { a: { b: 1 } } } })).valid, 'only flat objects of scalars are allowed in a payload')
  })

  test('checkPayloadWhitelist: unknown keys, PII-like keys and values, probes', () => {
    assert.ok(checkPayloadWhitelist('report.submitted', { reportId: 'r', version: 2 }, m).ok)
    const unknown = checkPayloadWhitelist('report.submitted', { reportId: 'r', total: 5 }, m)
    assert.deepEqual(unknown.unknownKeys, ['total'])
    assert.equal(unknown.ok, false)
    const named = checkPayloadWhitelist('report.submitted', { residentName: 'x' }, ['residentName'])
    assert.deepEqual(named.piiLikeKeys, ['residentName'])
    assert.equal(checkPayloadWhitelist('report.submitted', { reportId: 'taro@example.com' }, m).ok, false)
    assert.equal(checkPayloadWhitelist('report.submitted', { reportId: '山田 太郎' }, m).ok, false)
    assert.equal(checkPayloadWhitelist('report.submitted', { reportId: 'Taro Yamada' }, m).ok, false)
    assert.equal(checkPayloadWhitelist('report.submitted', { reportId: 'abc' }, m, { probes: ['ABC'] }).ok, false, 'probe strings are matched case-insensitively')
    assert.equal(checkPayloadWhitelist('made.up', {}, m).undeclaredType, true)
    // IDs, ISO dates, UUIDs and counts are fine
    assert.ok(checkPayloadWhitelist('approval.requested', { approvalId: '3f2c1a60-0000-4000-8000-000000123456', periodStart: '2026-08-01', expiresAt: '2026-10-26T08:30:00.000Z', amount: 41000 }, m).ok)
  })

  test('validateEvent with a manifest: undeclared type, unknown key', () => {
    assert.ok(validateEvent(ev(), { manifest: m }).valid)
    assert.deepEqual(validateEvent(ev({ type: 'made.up' }), { manifest: m }).errors.map((e) => e.code), ['manifest.undeclared_type'])
    assert.ok(validateEvent(ev({ payload: { reportId: 'r', total: 1 } }), { manifest: m }).errors.some((e) => e.code === 'payload.unknown_key'))
  })

  test('validateEventPage: ordering, cursor rule', () => {
    const page = { ok: true, events: [ev({ id: 6 }), ev({ id: 7 })], nextAfter: 7 }
    assert.ok(validateEventPage(page, { after: 5 }).valid)
    assert.ok(!validateEventPage({ ...page, nextAfter: 6 }, { after: 5 }).valid)
    assert.ok(!validateEventPage({ ...page, events: [ev({ id: 7 }), ev({ id: 6 })] }, { after: 5 }).valid)
    assert.ok(!validateEventPage(page, { after: 6 }).valid, 'ids must be greater than the request cursor')
    assert.ok(validateEventPage({ ok: true, events: [], nextAfter: 9 }, { after: 9 }).valid)
    assert.ok(!validateEventPage({ ok: true, events: [], nextAfter: 3 }, { after: 9 }).valid)
  })
})

describe('notification parameters and links', () => {
  const m = example()
  test('typed against the manifest template', () => {
    assert.ok(checkNotificationParams('report.submitted', { count: 1, pendingCount: 3, submittedAt: '2026-10-26T08:30:00.000Z', time: '08:30' }, { manifest: m }).ok)
    const bad = checkNotificationParams('report.submitted', { count: 'one', pendingCount: 3, time: '8:30', extra: 1 }, { manifest: m })
    assert.deepEqual([...new Set(bad.problems.map((p) => p.code))].sort(), ['missing_param', 'param_type', 'undeclared_param'])
    assert.equal(checkNotificationParams('nope', {}, { manifest: m }).problems[0].code, 'undeclared_template')
  })
  test('without a manifest: numbers and short safe strings only; no personal data, no probes', () => {
    assert.ok(checkNotificationParams('t', { count: 2, time: '08:30', date: '10/26' }).ok)
    assert.equal(checkNotificationParams('t', { who: '山田 太郎' }).ok, false)
    assert.equal(checkNotificationParams('t', { name: 'x' }).problems[0].code, 'pii_like_key')
    assert.equal(checkNotificationParams('t', { ref: 'hanako' }, { probes: ['Hanako'] }).ok, false)
    assert.equal(checkNotificationParams('t', { contact: '090-1234-5678' }).ok, false)
    assert.equal(checkNotificationParams('t', { obj: { a: 1 } }).ok, false)
  })
  test('links: relative or http(s), no credentials, no personal data', () => {
    assert.ok(checkNotificationLink('/reports?status=submitted').ok)
    assert.ok(checkNotificationLink('https://biz.example.com/reports/3f2c1a60-0000-4000-8000-000000000001').ok)
    assert.ok(checkNotificationLink(undefined).ok)
    assert.equal(checkNotificationLink('javascript:alert(1)').ok, false)
    assert.equal(checkNotificationLink('https://user:pw@biz.example.com/x').ok, false)
    assert.equal(checkNotificationLink('/reports?q=taro@example.com').ok, false)
    assert.equal(checkNotificationLink('/reports?q=Hanako', { probes: ['hanako'] }).ok, false)
  })
})

describe('pii heuristics', () => {
  test('patterns', () => {
    const kinds = (s) => findPiiInString(s).map((f) => f.kind)
    assert.ok(kinds('09012345678').includes('phone'))
    assert.ok(kinds('03-1234-5678').includes('phone'))
    assert.ok(kinds('mail me at a.b@example.co.jp').includes('email'))
    assert.ok(kinds('〒123-4567').includes('postal_code'))
    assert.ok(kinds('被保険者番号 1234567890').includes('id_number'))
    assert.deepEqual(kinds('2026-10-26T08:30:00.000Z'), [])
    assert.deepEqual(kinds('3f2c1a60-0000-4000-8000-000000123456'), [])
    assert.deepEqual(kinds('report.submitted'), [])
    assert.deepEqual(kinds('08:30'), [])
  })
  test('key vocabulary', () => {
    for (const k of ['name', 'residentName', 'comment', 'freeText', 'email', 'phone_number', 'memo']) assert.ok(isPiiLikeKey(k), k)
    for (const k of ['recordId', 'commentId', 'staffUserId', 'count', 'plannedStart', 'documentType', 'summary', 'channel']) assert.ok(!isPiiLikeKey(k), k)
  })
})
