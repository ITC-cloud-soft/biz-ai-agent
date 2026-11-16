// External connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3; optional Bridge v1 capability, createBridgeApp({ connectors })):
//
//   GET    /bridge/v1/connectors/catalog                                   service     the read / write operations the AI may use (etag, 304)
//   POST   /bridge/v1/connectors/{connectorId}/operations/{operationId}/run  delegated   a READ operation as the employee (role ∈ operation.roles)
//   GET    /bridge/v1/admin/connectors                                     admins      connectors (+ hasSecret / secretHint), the state, the limits
//   PUT    /bridge/v1/admin/connectors/{connectorId}                       admins      { connector } → validateConnector (422 invalid_connector)
//   DELETE /bridge/v1/admin/connectors/{connectorId}                       admins      409 connector_in_use while a rule uses it
//   PUT    /bridge/v1/admin/connectors/{connectorId}/secret                admins      { secret } sealed (AES-256-GCM); the answer is the hint only
//   DELETE /bridge/v1/admin/connectors/{connectorId}/secret                admins
//   POST   /bridge/v1/admin/connectors/{connectorId}/test                  admins      { operationId?, input? } a read; status / timing / field names only
//   GET    /bridge/v1/admin/connector-rules                                admins
//   PUT    /bridge/v1/admin/connector-rules/{ruleId}                       admins      { rule } → validateRule (422 invalid_rule)
//   DELETE /bridge/v1/admin/connector-rules/{ruleId}                       admins
//   GET    /bridge/v1/admin/connector-runs                                 admins      ?limit&connectorId&ruleId — ids, status, code, timing
//   PUT    /bridge/v1/admin/connector-settings                             admins      { stopped, reason? } the emergency stop of every connector
//
// Writes never run from the AI: the AI's write tool creates a proposal of kind connector_write (its input sealed), a person of the
// operation's roles (or the rule's approvers) accepts it, then the business system runs it. Rules run in the business system
// (kit.connectors.tick(), a scheduler task): auto / approval / propose-by-ai. Audits and the run log keep ids, status and codes
// only — never the input, the response or a secret.
import { createHash } from 'node:crypto'
import {
  CONNECTOR_ID_RE, CONNECTOR_LIMITS, checkOperationInput, validateConnector, validateRule,
} from '@dsh-bridge/protocol'
import { checkSecret, connectorSecretKey, createConnectorRunner, createRuleEngine, minuteKey, openSecret, secretHint, sealSecret } from '../connectors/index.mjs'
import { POLICY } from '../gate.mjs'
import { baseHeaders, fail, iso, isObject, strictKeys } from '../http.mjs'
import { etagMatches } from '../manifest.mjs'

export const CONNECTOR_WRITE_KIND = 'connector_write'
export const CONNECTOR_RUNS_SHOWN = 200
const RULE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

const connectorJson = (row) => ({ ...row.connector, hasSecret: row.hasSecret, secretHint: row.secretHint, updatedAt: iso(row.updatedAt), updatedBy: row.updatedBy })
const ruleJson = (row) => ({ ...row.rule, updatedAt: iso(row.updatedAt), updatedBy: row.updatedBy })
const runJson = (r) => ({
  id: r.id, ruleId: r.ruleId, connectorId: r.connectorId, operationId: r.operationId, trigger: r.triggerKind, triggerRef: r.triggerRef, actor: r.actor,
  status: r.status, code: r.code, httpStatus: r.httpStatus, durationMs: r.durationMs, proposalId: r.proposalId, at: iso(r.createdAt),
})
const stateJson = (s) => ({ stopped: s.stopped, stoppedBy: s.stoppedBy, stoppedAt: iso(s.stoppedAt) })
const errorsJson = (errors) => errors.map((e) => ({ field: e.field, code: e.code }))

/**
 * createConnectorService(kit, options) → the service behind the routes, the proposal kind and the rule engine (kit.connectors).
 * options: { secretKey (≥ 32 characters, required), allowLocalhost?, fetch?, runner?, onApprovalNeeded?, onProposeByAi?, onRunResult? }
 */
export function createConnectorService(kit, options = {}) {
  const { store } = kit
  const key = connectorSecretKey(options.secretKey)
  const allowLocalhost = options.allowLocalhost === true
  const runner = options.runner ?? createConnectorRunner({ fetch: options.fetch, allowLocalhost })
  const eventNames = () => Object.keys(kit.manifest.events ?? {})

  const connectorOf = async (id, t = store) => (await t.getConnector(id))?.connector ?? null
  const secretOf = async (connector, t = store) => {
    const s = await t.getConnectorSecret(connector.id)
    return s ? openSecret(key, connector.id, s.sealed) : null
  }
  const isStopped = async (t = store) => (await t.getConnectorState()).stopped

  async function runOperation({ connector, operation, input, trigger, actor = null, ruleId = null, t = store }) {
    const r = await runner.run({ connector, operation, input, secret: await secretOf(connector, t) })
    await t.insertConnectorRun({
      ruleId, connectorId: connector.id, operationId: operation.id, trigger, actor, status: r.ok ? 'succeeded' : 'failed', code: r.ok ? null : r.code,
      httpStatus: r.status || null, durationMs: r.durationMs ?? null,
    })
    return r
  }

  /** A connector_write proposal (sealed input) + the business's approval card. */
  async function requestApproval({ connector, operation, input, rule = null, via, forUserId = null, t = store }) {
    const approverRole = rule?.approvers?.role ?? null
    const payload = { connectorId: connector.id, operationId: operation.id, inputSealed: sealSecret(key, `${connector.id}/${operation.id}`, input), inputKeys: Object.keys(input), via, ruleId: rule?.id ?? null, approverRole }
    const proposal = await t.insertProposal({ kind: CONNECTOR_WRITE_KIND, payload, confidence: null, forUserId, createdVia: via === 'ai' ? 'delegation' : 'service' })
    await t.audit({ actor: via === 'rule' ? `rule:${rule.id}` : forUserId ? `ai:${forUserId}` : 'ai', action: 'connector.approval_requested', target: proposal.id, detail: { connectorId: connector.id, operationId: operation.id, ruleId: rule?.id ?? null } })
    if (options.onApprovalNeeded) {
      try { await options.onApprovalNeeded({ proposal: { id: proposal.id, kind: proposal.kind }, connector, operation, rule, approverRole }, kit.ctx(t)) } catch (error) { kit.log(`[connectors] approval card: ${error?.message ?? error}`) }
    }
    return { proposalId: proposal.id }
  }

  const engine = createRuleEngine({
    timeZone: kit.timeZone,
    now: () => kit.now(),
    log: kit.log,
    listRules: async () => (await store.listConnectorRules()).map((r) => r.rule),
    connectorOf: (id) => connectorOf(id),
    isStopped: () => isStopped(),
    runOperation: async ({ connector, operation, input }) => runner.run({ connector, operation, input, secret: await secretOf(connector), checkInput: false }),
    requestApproval: ({ connector, operation, input, rule }) => store.tx((t) => requestApproval({ connector, operation, input, rule, via: 'rule', t })),
    proposeByAi: options.onProposeByAi ? (args) => options.onProposeByAi(args, kit.ctx(store)) : null,
    recordRun: (r) => store.insertConnectorRun({ ...r, actor: `rule:${r.ruleId}` }),
    notify: options.onRunResult ? (r) => options.onRunResult(r, kit.ctx(store)) : null,
  })

  let ticking = false
  /** Rules: new business events since the cursor, then the cron rules of the current minute (once per minute). */
  async function tick() {
    if (ticking) return { events: 0, cron: 0 }
    ticking = true
    let events = 0
    let cron = 0
    try {
      let state = await store.getConnectorState()
      for (;;) {
        const page = await store.listEvents(state.eventCursor, 100)
        if (!page.length) break
        for (const e of page) {
          events += (await engine.onEvent({ id: e.id, type: e.type, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload })).length
          state = await store.putConnectorState({ eventCursor: e.id })
        }
      }
      const minute = minuteKey(kit.now(), kit.timeZone)
      if (state.cronMinute !== minute) {
        await store.putConnectorState({ cronMinute: minute })
        cron = (await engine.onMinute(kit.now())).length
      }
    } finally {
      ticking = false
    }
    return { events, cron }
  }

  /** The AI's catalog: the enabled connectors' operations that have roles (nothing while stopped). */
  async function catalog() {
    if (await isStopped()) return []
    const out = []
    for (const row of await store.listConnectors()) {
      const c = row.connector
      if (!c.enabled) continue
      for (const op of c.operations) {
        if (!op.roles.length) continue
        out.push({ connectorId: c.id, connectorName: c.name, operationId: op.id, name: op.name, description: op.description, effect: op.effect, pii: op.pii, roles: op.roles, input: op.input })
      }
    }
    return out
  }

  /** The built-in proposal kind: the AI proposes a write; the business runs it when a person accepts. */
  const proposalKind = {
    roles: kit.declaredRoles,
    async validate(payload, ctx, principal) {
      strictKeys(payload, ['connectorId', 'operationId', 'input'])
      const connector = await connectorOf(String(payload.connectorId ?? ''), ctx.t)
      const operation = connector?.operations.find((o) => o.id === payload.operationId) ?? null
      if (!operation) fail(404, 'operation_not_found')
      if (operation.effect !== 'write') fail(422, 'invalid_value', undefined, { field: 'operationId' })
      if (principal.kind === 'delegated' && !operation.roles.includes(principal.user.role)) fail(403, 'role_not_permitted')
      if (!connector.enabled || await isStopped(ctx.t)) fail(409, 'connector_stopped')
      const check = checkOperationInput(operation, payload.input ?? {})
      if (!check.ok) fail(400, 'invalid_value', undefined, { field: 'input', errors: errorsJson(check.errors) })
      // the input is sealed in the proposal (it may name a person); the screens see the operation and the input's keys only
      const input = payload.input
      for (const k of Object.keys(payload)) delete payload[k]
      Object.assign(payload, {
        connectorId: connector.id, operationId: operation.id, inputSealed: sealSecret(key, `${connector.id}/${operation.id}`, input), inputKeys: Object.keys(input),
        via: 'ai', ruleId: null, approverRole: null,
      })
    },
    async apply(payload, actor, ctx, proposal) {
      const t = ctx.t
      const connector = await connectorOf(payload.connectorId, t)
      const operation = connector?.operations.find((o) => o.id === payload.operationId) ?? null
      if (!operation) fail(404, 'operation_not_found')
      const deciders = payload.approverRole ? [payload.approverRole] : operation.roles
      if (!deciders.includes(actor.role) && !kit.roles.admins.includes(actor.role)) fail(403, 'role_not_permitted')
      if (proposal.forUserId && String(proposal.forUserId) === String(actor.id) && !kit.roles.admins.includes(actor.role)) fail(403, 'role_not_permitted') // not the requester
      if (!connector.enabled || await isStopped(t)) fail(409, 'connector_stopped')
      const input = openSecret(key, `${connector.id}/${operation.id}`, payload.inputSealed)
      if (!input) fail(409, 'invalid_value', undefined, { field: 'input' })
      const r = await runner.run({ connector, operation, input, secret: await secretOf(connector, t), checkInput: true })
      const run = { ruleId: payload.ruleId ?? null, connectorId: connector.id, operationId: operation.id, trigger: { kind: 'approval', proposalId: proposal.id }, actor: actor.id, status: r.ok ? 'succeeded' : 'failed', code: r.ok ? null : r.code, httpStatus: r.status || null, durationMs: r.durationMs ?? null, proposalId: proposal.id }
      if (!r.ok) {
        // the proposal stays pending (it can be accepted again); the failed attempt is logged outside the transaction
        await store.insertConnectorRun(run).catch(() => {})
        fail(502, 'connector_failed', undefined, { code: r.code, status: r.status || null })
      }
      await t.insertConnectorRun(run)
      await t.audit({ actor: actor.id, action: 'connector.write_executed', target: proposal.id, detail: { connectorId: connector.id, operationId: operation.id, status: r.status } })
    },
  }

  return { key, runner, engine, tick, catalog, connectorOf, secretOf, isStopped, runOperation, requestApproval, proposalKind, eventNames, allowLocalhost }
}

export function registerConnectors(router, kit) {
  const svc = kit.connectors
  // without the capability every route still passes the gate first (401 / 403 as declared) and then answers 404 not_found
  const add = svc ? router.add.bind(router) : (method, path, policy, _handler, opts) => router.add(method, path, policy, () => fail(404, 'not_found'), opts)
  const { store } = kit
  const ADMIN = { allow: ['user'], roles: kit.roles.admins }
  const idOk = (id) => CONNECTOR_ID_RE.test(id)
  const reasonOf = (b) => {
    if (b.reason === undefined || b.reason === null) return null
    if (typeof b.reason !== 'string' || b.reason.length > CONNECTOR_LIMITS.reason) fail(400, 'invalid_value', undefined, { field: 'reason' })
    return b.reason.replace(/\s+/g, ' ').trim() || null
  }
  const connectorsList = async () => (await store.listConnectors()).map((r) => r.connector)

  add('GET', '/bridge/v1/connectors/catalog', POLICY.SERVICE, async ({ req, res }) => {
    const operations = await svc.catalog()
    const json = JSON.stringify(operations)
    const etag = `"connectors-${createHash('sha256').update(json).digest('hex').slice(0, 32)}"`
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, baseHeaders({ etag }))
      res.end()
      return null
    }
    return { status: 200, headers: { etag }, body: { ok: true, operations } }
  })

  add('POST', '/bridge/v1/connectors/:connectorId/operations/:operationId/run', { allow: ['delegated'] }, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['input'])
    if (b.input !== undefined && !isObject(b.input)) fail(400, 'invalid_value', undefined, { field: 'input' })
    if (!idOk(params.connectorId) || !idOk(params.operationId)) fail(404, 'operation_not_found')
    const connector = await svc.connectorOf(params.connectorId)
    const operation = connector?.operations.find((o) => o.id === params.operationId) ?? null
    if (!operation || !operation.roles.length) fail(404, 'operation_not_found')
    if (!operation.roles.includes(principal.user.role)) fail(403, 'role_not_permitted')
    if (operation.effect !== 'read') fail(403, 'write_requires_approval')
    if (!connector.enabled || await svc.isStopped()) fail(409, 'connector_stopped')
    const input = b.input ?? {}
    const check = checkOperationInput(operation, input)
    if (!check.ok) fail(400, 'invalid_value', undefined, { field: 'input', errors: errorsJson(check.errors) })
    const r = await svc.runOperation({ connector, operation, input, trigger: { kind: 'ai' }, actor: principal.user.id })
    await store.audit({ actor: `ai:${principal.user.id}`, action: 'connector.run', target: `${connector.id}/${operation.id}`, detail: { status: r.ok ? 'succeeded' : 'failed', code: r.ok ? null : r.code } })
    if (!r.ok) {
      if (r.code === 'rate_limited') fail(429, 'too_many_requests')
      fail(502, 'connector_failed', undefined, { code: r.code, status: r.status || null })
    }
    return { status: 200, body: { ok: true, connectorId: connector.id, operationId: operation.id, status: r.status, data: r.data } }
  })

  // ---------------------------------------------------------------- administrators
  add('GET', '/bridge/v1/admin/connectors', ADMIN, async () => ({
    status: 200,
    body: {
      ok: true,
      connectors: (await store.listConnectors()).map(connectorJson),
      state: stateJson(await store.getConnectorState()),
      allowLocalhost: svc.allowLocalhost,
      events: svc.eventNames(),
      roles: kit.declaredRoles,
    },
  }))

  add('PUT', '/bridge/v1/admin/connectors/:connectorId', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['connector', 'reason'])
    if (!isObject(b.connector)) fail(400, 'required', undefined, { field: 'connector' })
    const reason = reasonOf(b)
    if (!idOk(params.connectorId)) fail(404, 'connector_not_found')
    const r = validateConnector({ ...b.connector, id: b.connector.id ?? params.connectorId }, { allowLocalhost: svc.allowLocalhost })
    if (!r.ok) fail(422, 'invalid_connector', undefined, { errors: errorsJson(r.errors) })
    if (r.connector.id !== params.connectorId) fail(422, 'invalid_connector', undefined, { errors: [{ field: 'id', code: 'invalid' }] })
    // rules that use a removed operation (or an auto write that lost its permission) must be fixed first
    const rules = (await store.listConnectorRules()).map((x) => x.rule).filter((x) => x.action.connector === r.connector.id)
    const broken = rules.filter((x) => !validateRule(x, { connectors: [r.connector] }).ok).map((x) => x.id)
    if (broken.length) fail(409, 'connector_in_use', undefined, { rules: broken })
    const row = await store.tx(async (t) => {
      const existed = Boolean(await t.getConnector(r.connector.id))
      const saved = await t.putConnector({ connector: r.connector, updatedBy: principal.user.id })
      await t.audit({ actor: principal.user.id, action: existed ? 'connector.updated' : 'connector.created', target: r.connector.id, detail: { enabled: r.connector.enabled, operations: r.connector.operations.length, ...(reason ? { reason } : {}) } })
      return saved
    })
    return { status: 200, body: { ok: true, connector: connectorJson(row) } }
  })

  add('DELETE', '/bridge/v1/admin/connectors/:connectorId', ADMIN, async ({ principal, params }) => {
    if (!idOk(params.connectorId)) fail(404, 'connector_not_found')
    const rules = (await store.listConnectorRules()).filter((x) => x.rule.action.connector === params.connectorId).map((x) => x.id)
    if (rules.length) fail(409, 'connector_in_use', undefined, { rules })
    const removed = await store.tx(async (t) => {
      const ok = await t.deleteConnector(params.connectorId)
      if (ok) await t.audit({ actor: principal.user.id, action: 'connector.deleted', target: params.connectorId })
      return ok
    })
    if (!removed) fail(404, 'connector_not_found')
    return { status: 200, body: { ok: true } }
  })

  add('PUT', '/bridge/v1/admin/connectors/:connectorId/secret', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['secret'])
    if (!idOk(params.connectorId)) fail(404, 'connector_not_found')
    const connector = await svc.connectorOf(params.connectorId)
    if (!connector) fail(404, 'connector_not_found')
    const c = checkSecret(connector.auth.type, b.secret)
    if (!c.ok) fail(422, 'invalid_secret', undefined, { errors: c.errors })
    const hint = secretHint(c.secret)
    await store.tx(async (t) => {
      await t.setConnectorSecret(connector.id, { sealed: sealSecret(svc.key, connector.id, c.secret), hint, updatedBy: principal.user.id })
      await t.audit({ actor: principal.user.id, action: 'connector.secret_updated', target: connector.id })
    })
    svc.runner.reset()
    return { status: 200, body: { ok: true, hasSecret: true, secretHint: hint } }
  })

  add('DELETE', '/bridge/v1/admin/connectors/:connectorId/secret', ADMIN, async ({ principal, params }) => {
    if (!idOk(params.connectorId)) fail(404, 'connector_not_found')
    const ok = await store.tx(async (t) => {
      const done = await t.setConnectorSecret(params.connectorId, { sealed: null, updatedBy: principal.user.id })
      if (done) await t.audit({ actor: principal.user.id, action: 'connector.secret_deleted', target: params.connectorId })
      return done
    })
    if (!ok) fail(404, 'connector_not_found')
    svc.runner.reset()
    return { status: 200, body: { ok: true, hasSecret: false, secretHint: null } }
  })

  add('POST', '/bridge/v1/admin/connectors/:connectorId/test', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['operationId', 'input'])
    if (b.input !== undefined && !isObject(b.input)) fail(400, 'invalid_value', undefined, { field: 'input' })
    if (b.operationId !== undefined && (typeof b.operationId !== 'string' || !idOk(b.operationId))) fail(400, 'invalid_value', undefined, { field: 'operationId' })
    if (!idOk(params.connectorId)) fail(404, 'connector_not_found')
    const connector = await svc.connectorOf(params.connectorId)
    if (!connector) fail(404, 'connector_not_found')
    const r = await svc.runner.test({ connector, operationId: b.operationId ?? null, input: b.input ?? {}, secret: await svc.secretOf(connector) })
    if (r.code === 'operation_not_found') fail(404, 'operation_not_found')
    if (r.code === 'write_not_testable') fail(422, 'invalid_value', undefined, { field: 'operationId' })
    await store.insertConnectorRun({ connectorId: connector.id, operationId: r.operationId, trigger: { kind: 'test' }, actor: principal.user.id, status: r.ok ? 'succeeded' : 'failed', code: r.ok ? null : r.code, httpStatus: r.status || null, durationMs: r.durationMs ?? null })
    return {
      status: 200,
      body: { ok: true, result: { ok: r.ok, code: r.code ?? null, status: r.status || null, durationMs: r.durationMs, operationId: r.operationId, fields: r.fields ?? [], ...(r.errors ? { errors: errorsJson(r.errors) } : {}) } },
    }
  })

  add('GET', '/bridge/v1/admin/connector-rules', ADMIN, async () => ({
    status: 200, body: { ok: true, rules: (await store.listConnectorRules()).map(ruleJson) },
  }))

  add('PUT', '/bridge/v1/admin/connector-rules/:ruleId', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['rule', 'reason'])
    if (!isObject(b.rule)) fail(400, 'required', undefined, { field: 'rule' })
    const reason = reasonOf(b)
    if (!RULE_ID_RE.test(params.ruleId)) fail(404, 'rule_not_found')
    const r = validateRule({ ...b.rule, id: b.rule.id ?? params.ruleId }, { connectors: await connectorsList(), events: svc.eventNames(), roles: kit.declaredRoles })
    if (!r.ok) fail(422, 'invalid_rule', undefined, { errors: errorsJson(r.errors) })
    if (r.rule.id !== params.ruleId) fail(422, 'invalid_rule', undefined, { errors: [{ field: 'id', code: 'invalid' }] })
    const row = await store.tx(async (t) => {
      const existed = Boolean(await t.getConnectorRule(r.rule.id))
      const saved = await t.putConnectorRule({ rule: r.rule, updatedBy: principal.user.id })
      await t.audit({ actor: principal.user.id, action: existed ? 'connector_rule.updated' : 'connector_rule.created', target: r.rule.id, detail: { mode: r.rule.mode, enabled: r.rule.enabled, ...(reason ? { reason } : {}) } })
      return saved
    })
    return { status: 200, body: { ok: true, rule: ruleJson(row) } }
  })

  add('DELETE', '/bridge/v1/admin/connector-rules/:ruleId', ADMIN, async ({ principal, params }) => {
    if (!RULE_ID_RE.test(params.ruleId)) fail(404, 'rule_not_found')
    const ok = await store.tx(async (t) => {
      const done = await t.deleteConnectorRule(params.ruleId)
      if (done) await t.audit({ actor: principal.user.id, action: 'connector_rule.deleted', target: params.ruleId })
      return done
    })
    if (!ok) fail(404, 'rule_not_found')
    return { status: 200, body: { ok: true } }
  })

  add('GET', '/bridge/v1/admin/connector-runs', ADMIN, async ({ query }) => {
    const limitText = query.get('limit')
    const limit = limitText === null ? 50 : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTOR_RUNS_SHOWN) fail(400, 'invalid_value', undefined, { field: 'limit' })
    const connectorId = query.get('connectorId')
    const ruleId = query.get('ruleId')
    if (connectorId !== null && !idOk(connectorId)) fail(400, 'invalid_value', undefined, { field: 'connectorId' })
    if (ruleId !== null && !RULE_ID_RE.test(ruleId)) fail(400, 'invalid_value', undefined, { field: 'ruleId' })
    const runs = await store.listConnectorRuns({ limit, connectorId, ruleId })
    return { status: 200, body: { ok: true, runs: runs.map(runJson) } }
  })

  add('PUT', '/bridge/v1/admin/connector-settings', ADMIN, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['stopped', 'reason'])
    if (typeof b.stopped !== 'boolean') fail(400, 'required', undefined, { field: 'stopped' })
    const reason = reasonOf(b)
    const state = await store.tx(async (t) => {
      const s = await t.putConnectorState(b.stopped ? { stopped: true, stoppedBy: principal.user.id, stoppedAt: kit.now() } : { stopped: false, stoppedBy: null, stoppedAt: null })
      await t.audit({ actor: principal.user.id, action: b.stopped ? 'connectors.stopped' : 'connectors.resumed', target: 'connectors', detail: reason ? { reason } : {} })
      return s
    })
    return { status: 200, body: { ok: true, state: stateJson(state) } }
  })
}

