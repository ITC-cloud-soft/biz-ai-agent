// Wires a Bridge v1 server: manifest, store, principals / gate, the v1 routes and the business system's hooks.
//
//   const bridge = await createBridgeApp({ manifest: { file }, store, serviceToken, bffSecret, hooks, ... })
//   http.createServer(bridge.handler)            // node:http
//   app.use(bridge.middleware)                   // express / connect: unmatched paths go to next()
//   bridge.router.add('GET', '/api/x', policy, handler)   // the business's own routes behind the same gate
import { createServer } from 'node:http'
import { createEventWriter } from './events.mjs'
import { createPrincipalResolver, gate, readToolPolicy } from './gate.mjs'
import { createRouter, HttpError, readBody, sendError, sendJson } from './http.mjs'
import { aiAllowlist, loadManifest, manifestRoles, reportDecl } from './manifest.mjs'
import { todayIn } from './time.mjs'
import { registerAiProfile } from './routes/ai-profile.mjs'
import { registerAssistantAttachments } from './routes/assistant-attachments.mjs'
import { CONNECTOR_WRITE_KIND, createConnectorService, registerConnectors } from './routes/connectors.mjs'
import { registerApprovals } from './routes/approvals.mjs'
import { createEventDelegationRules, registerDelegation } from './routes/delegation.mjs'
import { identityOf, PERSONAL_BOT_PLATFORMS, registerIdentity } from './routes/identity.mjs'
import { registerMisc } from './routes/misc.mjs'
import { registerHelp } from './routes/help.mjs'
import { registerDocumentReads } from './routes/document-reads.mjs'
import { registerNotify } from './routes/notify.mjs'

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

function requireHook(cond, message) {
  if (!cond) throw new TypeError(`createBridgeApp: ${message}`)
}

/**
 * createBridgeApp(options) -> Promise<{ handler, middleware, router, kit }>
 *
 * options
 *   manifest            { file } | { manifest } | the result of loadManifest()
 *   store               createMemoryStore() | createPostgresStore({ pool }) (migrated)
 *   serviceToken        the DSH x-service-token (required)
 *   bffSecret           the business web BFF's x-bff-secret ('' disables BFF-only operations: 503)
 *   orgId, service, version          identity / health fields
 *   personalBotPlatforms             channels with personal bots (default PERSONAL_BOT_PLATFORMS: every dsh-im channel
 *                                    whose bots can be per employee — not email, not iMessage). Narrow it to opt out
 *   linkGlobalMaxFailures            global wrong-link-code budget per 10 minutes (default 1000)
 *   roles               { reportReaders, reportRunners, proposalReviewers, admins } (defaults: report audience / 'admin' / report readers /
 *                       'admin'; admins edit the AI employee's profile)
 *   aiProfile           false: no AI employee's profile routes (/bridge/v1/ai-profile, /bridge/v1/admin/ai-profile*: 404). Default on
 *   attachments         files attached in the AI assistant panel (routes/assistant-attachments.mjs, docs/ASSISTANT_ATTACHMENTS.md):
 *                       false = no routes (404). Default on: { defaultRoles?, limits?, pdfText?, ocr? } (defaultRoles: who may attach
 *                       before an administrator saves settings, default DEFAULT_ATTACHMENT_ROLES within the manifest roles;
 *                       limits: lower the hard ones; pdfText: the PDF reader, default pdf.js when pdfjs-dist is installed;
 *                       ocr: scanned PDF pages — a local OCR engine (bytes, { mediaType, page }) -> text, or false = off; default: page images for the model)
 *   connectors          external connectors of the AI employee (routes/connectors.mjs, docs/AI_EMPLOYEE_PROFILE.md §3). Absent / false = the
 *                       routes pass the gate, then 404. { secretKey (≥ 32 characters: seals the API keys), allowLocalhost? (http to localhost: development),
 *                       fetch?, onApprovalNeeded?({ proposal, connector, operation, rule, approverRole }, ctx) (deliver the approval card),
 *                       onProposeByAi?({ connector, operation, rule, trigger, inputKeys }, ctx) -> { started } (mode propose-by-ai: start
 *                       the business's automatic task), onRunResult?({ rule, status, level, connectorId, operationId, code }, ctx) }.
 *                       Adds the proposal kind connector_write and kit.connectors (tick(): the rules; a scheduler task)
 *   hooks               what the business implements (README "Hooks"):
 *     employees: { get(id, ctx), list({ roles }, ctx), getMany?(ids, ctx) }     (required)
 *     authenticate(req) -> { user: { id, role }, sessionId } | null              (required for /me/* routes)
 *     isSessionLive(sessionId, ctx) -> boolean
 *     recipientsFor(event, ctx) -> null | { stale } | { users, template?, paramsFor(user), link, dedupeKey }
 *     approvals: { get, approvers, card, mayDecide, decide, state? }
 *     proposalKinds: { [kind]: { roles, validate(payload, ctx, principal), apply(payload, actor, ctx, proposal) } }
 *     reports: { kind?, compute(viewer, ctx) -> { sections, attention, date? } }
 *     documentReads?: { claim({ limit }, ctx) -> { reads }, answer(readId, { pages } | { error }, ctx) }   scanned documents read by the
 *                         AI model (routes/document-reads.mjs, docs/DOCUMENT_READS.md). Absent = 404 after the service-only gate
 *     piiScan?(text, ctx) -> { kinds: string[] }   POST /pii-scan: the business system's own check (staff / client names in the
 *                         roster ...), added to the shape check (which skips plain prose). Throwing = 503 (callers keep nothing)
 *     eventDelegations: { [eventType]: { eligible(event, user, ctx) -> boolean, personOf?(event), maxAgeHours? } }
 *                         per-event delegations (POST /delegations { event }; routes/delegation.mjs). Absent = 400 for { event }
 *   help                optional: how-to questions answered from the business system's manual (routes/help.mjs):
 *                       { search(question, { role, limit, publicOnly }), section(id, { role }), onQuestion?(entry, ctx) }
 *                       — usually @dsh-bridge/help createHelpService(index, { webBase, roleLabels }) plus a log hook
 *   now                 () => Date (tests)
 *   log                 (line) => void — unexpected errors
 */
export async function createBridgeApp(options) {
  const {
    store, serviceToken, bffSecret = '', hooks = {}, now = () => new Date(), log = () => {}, help = null,
    orgId = 'default', service = 'bridge', version = '0.0.0', personalBotPlatforms = [...PERSONAL_BOT_PLATFORMS], linkGlobalMaxFailures = 1000,
  } = options
  requireHook(store && typeof store.tx === 'function', 'a store is required (createMemoryStore / createPostgresStore)')
  requireHook(serviceToken, 'serviceToken is required')
  requireHook(typeof hooks.employees?.get === 'function', 'hooks.employees.get(id, ctx) is required')
  requireHook(typeof hooks.employees?.list === 'function', 'hooks.employees.list({ roles }, ctx) is required')
  if (hooks.approvals) for (const m of ['get', 'approvers', 'card', 'mayDecide', 'decide']) requireHook(typeof hooks.approvals[m] === 'function', `hooks.approvals.${m} is required`)
  for (const [k, v] of Object.entries(hooks.proposalKinds ?? {})) requireHook(Array.isArray(v?.roles), `hooks.proposalKinds.${k}.roles is required`)
  for (const [k, v] of Object.entries(hooks.eventDelegations ?? {})) {
    requireHook(typeof v?.eligible === 'function', `hooks.eventDelegations.${k}.eligible(event, user, ctx) is required (the person's own condition)`)
    requireHook(v.personOf === undefined || typeof v.personOf === 'function', `hooks.eventDelegations.${k}.personOf must be a function`)
  }

  const manifestInfo = options.manifest?.etag && options.manifest?.json ? options.manifest : loadManifest(options.manifest ?? {})
  const { manifest } = manifestInfo
  for (const k of Object.keys(hooks.eventDelegations ?? {})) requireHook(manifest.events?.[k], `hooks.eventDelegations.${k}: the manifest declares no event ${k}`)
  const serverKey = await store.getServerKey()
  const emitEvent = createEventWriter(manifest)
  const allowlist = aiAllowlist(manifest)
  const timeZone = manifest.system?.timezone ?? 'UTC'
  const declaredRoles = manifestRoles(manifest)
  const report = hooks.reports ? reportDecl(manifest, hooks.reports.kind) : null
  requireHook(!hooks.reports || report, 'hooks.reports is set but the manifest declares no report')
  const adminRole = declaredRoles.includes('admin') ? 'admin' : declaredRoles[0]
  const readers = options.roles?.reportReaders ?? report?.audience?.roles ?? [adminRole]
  const roles = {
    readers,
    runners: options.roles?.reportRunners ?? [adminRole],
    reviewers: options.roles?.proposalReviewers ?? readers,
    admins: options.roles?.admins ?? [adminRole],
  }

  const config = { serviceToken, bffSecret, orgId, service, version, personalBotPlatforms, linkGlobalMaxFailures, timeZone, ...(options.config ?? {}) }
  const ctx = (t = store, extra = {}) => ({ db: t.db ?? null, t, emitEvent: (event) => emitEvent(t, event), now: now(), ...extra })
  const employees = {
    get: hooks.employees.get,
    list: hooks.employees.list,
    getMany: hooks.employees.getMany ?? (async (ids, c) => (await Promise.all(ids.map((id) => hooks.employees.get(id, c)))).filter(Boolean)),
  }
  const eventDelegations = createEventDelegationRules(hooks.eventDelegations, { employees, now, ctx })
  const { resolvePrincipal, findDelegation } = createPrincipalResolver({
    store, serviceToken, employees, authenticate: hooks.authenticate, isSessionLive: hooks.isSessionLive,
    // a per-event delegation holds only while its event and the person's own conditions still hold (checked on every use)
    eventDelegationHolds: async (eventId, user, t) => {
      const out = await eventDelegations.check(await t.getEvent(eventId), t)
      return Boolean(out.user && out.user.id === String(user.id))
    },
  })

  const connectorOptions = options.connectors && typeof options.connectors === 'object' ? options.connectors : null
  if (connectorOptions) requireHook(!hooks.proposalKinds?.[CONNECTOR_WRITE_KIND], `hooks.proposalKinds.${CONNECTOR_WRITE_KIND} is built in (connectors)`)
  const kitHooks = connectorOptions ? { ...hooks, proposalKinds: { ...(hooks.proposalKinds ?? {}) } } : hooks

  const kit = {
    store, manifest, manifestInfo, config, hooks: kitHooks, employees, emitEvent, serverKey, now, ctx, roles, allowlist, timeZone,
    resolvePrincipal, findDelegation, eventDelegations, help, log, declaredRoles,
    /** Map id -> employee for many ids (one hook call). */
    async employeesById(ids, c = ctx()) {
      const list = ids.length ? await employees.getMany(ids, c) : []
      return new Map(list.map((u) => [String(u.id), u]))
    },
    /** Policy of a business read endpoint the AI may call iff the manifest lists it as a read tool for the role. */
    readToolPolicy: (endpoint, routeRoles) => readToolPolicy(allowlist, endpoint, routeRoles),
    identityOf: (source) => identityOf(kit, { teamId: '', botId: null, ...source }),
    /** Runs fn(t) in one store transaction (business tables via t.db, events via kit.emitEvent(t, ...)). */
    tx: (fn) => store.tx(fn),
    today: () => todayIn(timeZone, now()),
    reports: report ? {
      kind: report.kind,
      sections: report.sections ?? [],
      sectionsByRole: report.sectionsByRole ?? {},
      audienceRoles: report.audience?.roles ?? readers,
      cron: report.cron ?? [],
      /** Counts for a viewer ({ id, role }; no role = everything). -> { date, sections, attention, scope } */
      async compute(viewer = {}, c = ctx()) {
        const scope = viewer.role ? (report.sectionsByRole?.[viewer.role] ?? report.sections ?? []) : (report.sections ?? [])
        const out = await hooks.reports.compute({ ...viewer, sections: scope }, c)
        const sections = Object.fromEntries(Object.entries(out.sections ?? {}).filter(([k]) => scope.includes(k)))
        return { date: out.date ?? todayIn(timeZone, now()), sections, attention: out.attention ?? 0, scope }
      },
      /** Stores a report (scheduled slot: unique per date / slot; test runs always stored). -> row | null */
      async generate({ slot, test = false, createdBy = null } = {}) {
        const snap = await kit.reports.compute({})
        return store.insertReport({ kind: report.kind, date: snap.date, slot, sections: snap.sections, attention: snap.attention, test, createdBy })
      },
      latest: () => store.latestReport(report.kind),
    } : null,
  }

  if (connectorOptions) {
    kit.connectors = createConnectorService(kit, connectorOptions)
    kitHooks.proposalKinds[CONNECTOR_WRITE_KIND] = kit.connectors.proposalKind
    // the rules react to events written from now on (never to the history before the capability was turned on)
    const st = await store.getConnectorState()
    if (st.eventCursor === 0 && st.cronMinute === null) await store.putConnectorState({ eventCursor: await store.latestEventId() })
  }

  const router = createRouter()
  registerMisc(router, kit)
  registerHelp(router, kit)
  registerDocumentReads(router, kit)
  registerIdentity(router, kit)
  registerDelegation(router, kit)
  registerNotify(router, kit)
  registerApprovals(router, kit)
  if (options.aiProfile !== false) registerAiProfile(router, kit)
  if (options.attachments !== false) registerAssistantAttachments(router, kit, options.attachments ?? {})
  registerConnectors(router, kit) // without kit.connectors: 404 after the gate

  async function dispatch(req, res, next) {
    let principal = { kind: 'anon' }
    try {
      const url = new URL(req.url, 'http://localhost')
      const found = router.match(req.method, url.pathname)
      if (!found) {
        if (next) return next()
        throw new HttpError(404, 'not_found')
      }
      if (found.error) throw found.error
      const { route, params } = found
      if (!route.policy.public) {
        principal = await resolvePrincipal(req)
        gate(principal, route.policy, req, { bffSecret: config.bffSecret })
      }
      const body = BODY_METHODS.includes(req.method) ? await readBody(req, route.maxBodyBytes ? { maxBytes: route.maxBodyBytes } : {}) : null
      const out = await route.handler({ req, res, params, query: url.searchParams, body, principal, kit })
      if (out) sendJson(res, out.status ?? 200, out.body, out.headers)
    } catch (error) {
      if (!(error instanceof HttpError)) log(`[server-kit] ${req.method} ${req.url?.split('?')[0]} failed: ${error?.stack ?? error}`)
      if (error instanceof HttpError && error.code === 'bff_only') {
        // a browser (or anything without the BFF secret) tried a BFF-only operation: audited
        await store.audit({ actor: principal.user?.id ?? 'anon', action: 'bff_only.refused', target: req.url?.split('?')[0] }).catch(() => {})
      }
      if (!res.headersSent) sendError(res, error)
      else res.destroy()
    }
    return undefined
  }

  return {
    kit,
    router,
    store,
    /** node:http request listener (404 for unknown paths). */
    handler: (req, res) => { dispatch(req, res, null) },
    /** express / connect middleware: unknown paths go to next(). */
    middleware: (req, res, next) => { dispatch(req, res, next) },
  }
}

/** Starts a node:http server for a handler. -> { base, server, stop() } */
export async function listen(handler, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(handler)
  server.keepAliveTimeout = 5_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {
    base: `http://${host}:${server.address().port}`,
    server,
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() }),
  }
}
