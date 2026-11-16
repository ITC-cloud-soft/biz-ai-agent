// Health, manifest (etag / 304), reports (counts only), proposals (the AI proposes, a person decides) and the PII scan.
import { findPiiInString, PROTOCOL_VERSION } from '@dsh-bridge/protocol'
import { POLICY } from '../gate.mjs'
import { baseHeaders, fail, iso, isObject, strictKeys } from '../http.mjs'
import { etagMatches } from '../manifest.mjs'

export const REPORT_RUNS_PER_RUNNER = 5 // per 10 minutes

export const proposalJson = (p) => ({
  id: p.id,
  kind: p.kind,
  status: p.status,
  payload: p.payload,
  confidence: p.confidence === null || p.confidence === undefined ? null : Number(p.confidence),
  forUserId: p.forUserId ?? null,
  createdAt: iso(p.createdAt),
  decidedAt: iso(p.decidedAt),
})

export const reportJson = (r) => r && ({ id: r.id, date: r.date, slot: r.slot, kind: r.kind, attention: r.attention, generatedAt: iso(r.generatedAt), sections: r.sections })

/** Finding kinds that only say "this is prose" (not personal data by themselves): skipped by POST /pii-scan. */
export const PROSE_KINDS = Object.freeze(['cjk_text', 'free_text'])
const KIND_RE = /^[a-z][a-z0-9_]{0,40}$/

export function registerMisc(router, kit) {
  const { store, config, manifestInfo } = kit

  const health = async () => ({ status: 200, body: { ok: true, protocol: PROTOCOL_VERSION, service: config.service, version: config.version } })
  router.add('GET', '/bridge/v1/health', POLICY.PUBLIC, health)
  if (config.healthAlias !== false) router.add('GET', '/health', POLICY.PUBLIC, health)

  router.add('GET', '/bridge/v1/manifest', POLICY.SERVICE, async ({ req, res }) => {
    if (etagMatches(req.headers['if-none-match'], manifestInfo.etag)) {
      res.writeHead(304, baseHeaders({ etag: manifestInfo.etag }))
      res.end()
      return null
    }
    res.writeHead(200, baseHeaders({ 'content-type': 'application/json; charset=utf-8', etag: manifestInfo.etag, 'content-length': Buffer.byteLength(manifestInfo.json) }))
    res.end(manifestInfo.json)
    return null
  })

  // ---------------------------------------------------------------- reports (counts only)
  if (kit.reports) {
    const { readers, runners } = kit.roles
    router.add('GET', '/bridge/v1/reports/latest', { allow: ['user', 'delegated'], roles: readers }, async ({ principal }) => {
      if (principal.kind === 'user') return { status: 200, body: { ok: true, report: reportJson(await store.latestReport(kit.reports.kind)), source: 'stored' } }
      // a delegation reads a live snapshot scoped to the employee's role
      const role = principal.user.role
      const snap = await kit.reports.compute({ id: principal.user.id, role })
      return {
        status: 200,
        body: {
          ok: true,
          report: { id: null, date: snap.date, slot: 'live', kind: kit.reports.kind, attention: snap.attention, generatedAt: iso(kit.now()), sections: snap.sections },
          source: 'live',
          scope: { role, sections: snap.scope },
        },
      }
    })

    router.add('POST', '/bridge/v1/reports/run', { allow: ['user'], roles: runners }, async ({ principal, body }) => {
      const b = body ?? {}
      strictKeys(b, ['to'])
      const to = b.to ?? 'recipients'
      if (!['recipients', 'me'].includes(to)) fail(400, 'invalid_to')
      if (await store.countHits('report_run', principal.user.id, 10) >= REPORT_RUNS_PER_RUNNER) fail(429, 'too_many_requests')
      await store.addHit('report_run', principal.user.id)
      const report = await kit.reports.generate({ slot: 'test', test: true, createdBy: principal.user.id })
      const audience = to === 'me' ? [principal.user] : await kit.employees.list({ roles: kit.reports.audienceRoles }, kit.ctx(store))
      let linked = 0
      for (const u of audience) if ((await store.listIdentities(String(u.id))).length) linked += 1
      await store.audit({ actor: principal.user.id, action: 'report.run', target: report.id, detail: { to } })
      return { status: 201, body: { ok: true, report: reportJson(report), to, recipients: audience.length, linkedRecipients: linked } }
    })
  }

  // ---------------------------------------------------------------- proposals (the AI proposes, a person decides)
  const kinds = kit.hooks.proposalKinds ?? {}
  router.add('GET', '/bridge/v1/proposals', { allow: ['user', 'delegated'] }, async ({ principal, query }) => {
    const status = query.get('status')
    const kind = query.get('kind')
    if (status !== null && !['pending_review', 'accepted', 'rejected'].includes(status)) fail(400, 'invalid_status')
    if (kind !== null && !Object.hasOwn(kinds, kind)) fail(400, 'invalid_kind')
    const reviewer = principal.kind === 'user' && kit.roles.reviewers.includes(principal.user.role)
    const rows = await store.listProposals({ forUserId: reviewer ? null : principal.user.id, status, kind, limit: 200 }) // others: own proposals only
    return { status: 200, body: { ok: true, proposals: rows.map(proposalJson) } }
  })

  router.add('POST', '/bridge/v1/proposals', { allow: ['service', 'delegated'] }, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['kind', 'payload', 'confidence'])
    if (typeof b.kind !== 'string' || !b.kind) fail(400, 'invalid_kind')
    const kind = Object.hasOwn(kinds, b.kind) ? kinds[b.kind] : null
    if (!kind) fail(400, 'unknown_kind')
    if (!isObject(b.payload)) fail(400, 'invalid_payload')
    if (b.confidence !== undefined && (typeof b.confidence !== 'number' || b.confidence < 0 || b.confidence > 1)) fail(400, 'invalid_confidence')
    // a delegation may propose only what the employee's own role could do
    const delegated = principal.kind === 'delegated'
    if (delegated && !kind.roles.includes(principal.user.role)) fail(403, 'role_not_permitted')
    return store.tx(async (t) => {
      await kind.validate?.(b.payload, kit.ctx(t), principal)
      const p = await t.insertProposal({ kind: b.kind, payload: b.payload, confidence: b.confidence ?? null, forUserId: delegated ? principal.user.id : null, createdVia: delegated ? 'delegation' : 'service' })
      await t.audit({ actor: delegated ? `ai:${principal.user.id}` : 'ai', action: 'proposal.created', target: p.id, detail: { kind: b.kind } })
      return { status: 201, body: { ok: true, proposal: proposalJson(p) } }
    })
  })

  const decide = (verb) => async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, verb === 'reject' ? ['comment'] : [])
    if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 1000)) fail(400, 'invalid_comment')
    if (!/^[0-9a-f-]{36}$/i.test(params.proposalId)) fail(404, 'proposal_not_found')
    return store.tx(async (t) => {
      const p = await t.getProposal(params.proposalId)
      if (!p) fail(404, 'proposal_not_found')
      if (p.status !== 'pending_review') fail(409, `already_${p.status}`)
      if (verb === 'accept') await kinds[p.kind]?.apply?.(p.payload, principal.user, kit.ctx(t), p)
      const updated = await t.decideProposal(p.id, { status: verb === 'accept' ? 'accepted' : 'rejected', decidedBy: principal.user.id, comment: b.comment ?? null })
      await t.audit({ actor: principal.user.id, action: `proposal.${verb}`, target: p.id })
      return { status: 200, body: { ok: true, proposal: proposalJson(updated) } }
    })
  }
  const REVIEWER = { allow: ['user'], roles: kit.roles.reviewers }
  router.add('POST', '/bridge/v1/proposals/:proposalId/accept', REVIEWER, decide('accept'))
  router.add('POST', '/bridge/v1/proposals/:proposalId/reject', REVIEWER, decide('reject'))

  // ---------------------------------------------------------------- optional: does this text contain personal data?
  // The shape check (phone / e-mail / postal code / long numbers ...) skips the "it is prose" kinds: the caller (bridge-memory)
  // sends sentences, and every Japanese or English sentence would otherwise count as personal data. Names need the roster:
  // hooks.piiScan(text, ctx) -> { kinds: string[] } adds the business system's own findings (e.g. a staff or client name).
  // A failing hook answers 503 (the caller then keeps nothing: fail closed).
  router.add('POST', '/bridge/v1/pii-scan', POLICY.SERVICE, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['text'])
    if (typeof b.text !== 'string') fail(400, 'invalid_text')
    if (b.text.length > 20_000) fail(413, 'payload_too_large')
    const kinds = new Set(findPiiInString(b.text, { allow: PROSE_KINDS }).map((f) => f.kind)) // categories only, never the matched text
    if (typeof kit.hooks.piiScan === 'function') {
      let extra
      try { extra = await kit.hooks.piiScan(b.text, kit.ctx()) } catch { fail(503, 'pii_scan_failed') }
      for (const k of Array.isArray(extra?.kinds) ? extra.kinds : []) if (typeof k === 'string' && KIND_RE.test(k)) kinds.add(k)
    }
    const kindsFound = [...kinds]
    return { status: 200, body: { ok: true, containsPersonalData: kindsFound.length > 0, kinds: kindsFound } }
  })
}
