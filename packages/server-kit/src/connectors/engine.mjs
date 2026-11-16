// Rules of external connectors (docs/AI_EMPLOYEE_PROFILE.md §3.2–§3.3): when a business event (or a cron minute) matches a
// rule and its conditions hold, the business system — not the AI — acts: auto = run now (reads, and writes the administrator
// allowed as idempotent with a reason), approval = a request a person of the approvers' role approves first (a proposal of kind
// connector_write + the business's approval card), propose-by-ai = the business starts its own automatic task (playbook) so the
// AI drafts the input and explains, and a person decides.
//
// The engine is storage-free: the business adapts its own store (server-kit's store, or its own tables).
//   const engine = createRuleEngine({ listRules, connectorOf, isStopped, runOperation, requestApproval, proposeByAi, recordRun, notify, timeZone, now })
//   await engine.onEvent(event)       // { id, type, aggregateType, aggregateId, payload, at? }
//   await engine.onMinute(date)       // the cron rules due at that minute (local time of timeZone)
// Every outcome is recorded (recordRun) with ids, the status and the code only — never the input or the response.
import { checkOperationInput, cronMatches, evaluateWhen, renderRuleInput } from '@dsh-bridge/protocol'

function localClock(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`, ym: `${parts.year}-${parts.month}`, time: `${parts.hour}:${parts.minute}`,
  }
}

/** The data a rule's conditions and input templates see: { event, payload, now }. */
export function ruleData({ event = null, date, timeZone = 'UTC' }) {
  const c = localClock(date, timeZone)
  return {
    event: event ? { id: event.id ?? null, type: event.type, aggregateType: event.aggregateType ?? null, aggregateId: event.aggregateId ?? null } : null,
    payload: event?.payload ?? {},
    now: { date: c.date, month: c.ym, time: c.time },
  }
}

/** The local minute key of a date ('YYYY-MM-DDTHH:MM' in timeZone): run the cron rules once per minute. */
export function minuteKey(date, timeZone = 'UTC') {
  const c = localClock(date, timeZone)
  return `${c.date}T${c.time}`
}

/**
 * createRuleEngine(adapter) → { onEvent, onMinute, dispatch }
 *   listRules() → normalised rules (validateRule)                connectorOf(id) → normalised connector | null
 *   isStopped() → boolean (the global stop switch)
 *   runOperation({ connector, operation, input, rule, trigger }) → the runner's result
 *   requestApproval({ connector, operation, input, rule, trigger }) → { proposalId? }       (mode approval; a write or a read)
 *   proposeByAi?({ connector, operation, rule, trigger, inputKeys }) → { started: boolean }   (mode propose-by-ai; absent → approval)
 *   recordRun({ ruleId, connectorId, operationId, trigger, status, code?, httpStatus?, durationMs?, proposalId? })
 *   notify?({ rule, status, level, connectorId, operationId, code? })    (counts / states only; level = info | action)
 */
export function createRuleEngine(adapter) {
  const { listRules, connectorOf, isStopped = async () => false, runOperation, requestApproval, proposeByAi = null, recordRun, notify = null, timeZone = 'UTC', now = () => new Date() } = adapter

  async function finish(rule, base, out) {
    await recordRun({ ...base, ...out })
    const level = out.status === 'succeeded' ? rule.notify.onSuccess : ['failed', 'refused'].includes(out.status) ? rule.notify.onFailure : 'none'
    if (notify && level !== 'none') {
      try { await notify({ rule, status: out.status, level, connectorId: base.connectorId, operationId: base.operationId, code: out.code ?? null }) } catch { /* notification is best effort */ }
    }
    return out
  }

  /** One rule whose trigger fired (conditions already hold or are checked here). */
  async function dispatch(rule, data, trigger) {
    const base = { ruleId: rule.id, connectorId: rule.action.connector, operationId: rule.action.operation, trigger }
    if (!evaluateWhen(rule.when, data)) return null
    if (await isStopped()) return finish(rule, base, { status: 'refused', code: 'stopped' })
    const connector = await connectorOf(rule.action.connector)
    const operation = connector?.operations.find((o) => o.id === rule.action.operation) ?? null
    if (!connector || !operation) return finish(rule, base, { status: 'failed', code: 'operation_not_found' })
    if (!connector.enabled) return finish(rule, base, { status: 'refused', code: 'connector_disabled' })
    const input = renderRuleInput(rule.action.input, data)
    const check = checkOperationInput(operation, input)
    if (!check.ok) return finish(rule, base, { status: 'failed', code: 'invalid_input' })
    const write = operation.effect === 'write'
    let mode = rule.mode
    // re-checked at run time: the operation may have lost its auto permission since the rule was saved
    if (mode === 'auto' && write && !operation.autoRun.allowed) mode = 'approval'
    if (mode === 'propose-by-ai' && proposeByAi) {
      const r = await proposeByAi({ connector, operation, rule, trigger, inputKeys: Object.keys(input) })
      if (r?.started) return finish(rule, base, { status: 'proposed' })
      mode = 'approval'
    } else if (mode === 'propose-by-ai') mode = 'approval'
    if (mode === 'approval') {
      const r = await requestApproval({ connector, operation, input, rule, trigger })
      return finish(rule, base, { status: 'pending_approval', proposalId: r?.proposalId ?? null })
    }
    const r = await runOperation({ connector, operation, input, rule, trigger })
    return finish(rule, base, { status: r.ok ? 'succeeded' : 'failed', code: r.ok ? null : r.code, httpStatus: r.status || null, durationMs: r.durationMs ?? null })
  }

  async function onEvent(event) {
    const rules = (await listRules()).filter((r) => r.enabled && r.trigger.event === event.type)
    const data = ruleData({ event, date: now(), timeZone })
    const out = []
    for (const rule of rules) {
      try { const r = await dispatch(rule, data, { kind: 'event', eventId: event.id ?? null }); if (r) out.push({ ruleId: rule.id, ...r }) } catch (error) {
        out.push({ ruleId: rule.id, status: 'failed', code: 'internal_error' })
        await recordRun({ ruleId: rule.id, connectorId: rule.action.connector, operationId: rule.action.operation, trigger: { kind: 'event', eventId: event.id ?? null }, status: 'failed', code: 'internal_error' }).catch(() => {})
        adapter.log?.(`[connectors] rule ${rule.id}: ${error?.message ?? error}`)
      }
    }
    return out
  }

  async function onMinute(date = now()) {
    const clock = localClock(date, timeZone)
    const rules = (await listRules()).filter((r) => r.enabled && r.trigger.cron && cronMatches(r.trigger.cron, clock))
    const data = ruleData({ date, timeZone })
    const out = []
    for (const rule of rules) {
      try { const r = await dispatch(rule, data, { kind: 'cron', minute: minuteKey(date, timeZone) }); if (r) out.push({ ruleId: rule.id, ...r }) } catch (error) {
        out.push({ ruleId: rule.id, status: 'failed', code: 'internal_error' })
        adapter.log?.(`[connectors] rule ${rule.id}: ${error?.message ?? error}`)
      }
    }
    return out
  }

  return { onEvent, onMinute, dispatch }
}
