// The business itself (備品・設備点検): equipment, inspections, the overdue scan, repair requests with one approval, and
// the counts of the daily report. Every state change that DSH should hear about writes its event in the SAME transaction
// (kit.tx + kit.emitEvent: the transactional outbox of @dsh-bridge/server-kit).
import { addDays, daysBetween, fail, isValidDate, strictKeys, todayIn, UUID_RE } from '@dsh-bridge/server-kit'

export const REPORT_KIND = 'daily_inspection'
export const APPROVAL_TTL_DAYS = 7

export const equipmentJson = (r, today) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  location: r.location,
  category: r.category,
  intervalDays: r.interval_days,
  nextDueOn: r.next_due_on,
  assigneeUserId: r.assignee_user_id,
  active: r.active,
  overdue: Boolean(r.active && r.next_due_on < today),
})

export const approvalJson = (a) => ({
  id: a.id,
  subjectType: a.subject_type,
  subjectId: a.subject_id,
  requiredRole: a.required_role,
  status: a.status,
  expiresAt: new Date(a.expires_at).toISOString(),
  decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null,
  decidedBy: a.decided_by ?? null,
  channel: a.decision_channel ?? null,
})

/** The approval as the kit sees it (hooks.approvals.get). */
export const approvalForKit = (a) => a && ({
  ...a, id: a.id, status: a.status, expiresAt: new Date(a.expires_at), requestedBy: a.requested_by, subjectType: a.subject_type, subjectId: a.subject_id,
})

/** Approvers of an approval: the required role or admin, active, never the requester (segregation of duties). */
export const approverRoles = (approval) => [...new Set([approval.required_role, 'admin'])]
export const mayDecide = (approval, user) => Boolean(user && user.active !== false && approverRoles(approval).includes(user.role) && String(user.id) !== String(approval.requested_by))

export function createDomain({ pool, kit }) {
  const tz = kit.timeZone
  const today = () => todayIn(tz, kit.now())
  const audit = (t, entry) => t.audit(entry)

  async function createEquipment(actor, body) {
    strictKeys(body, ['code', 'name', 'location', 'category', 'intervalDays', 'nextDueOn', 'assigneeUserId'])
    const { code, name, location = '', category = 'general', intervalDays, nextDueOn, assigneeUserId = null } = body
    if (typeof code !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(code)) fail(400, 'invalid_code')
    if (typeof name !== 'string' || !name.trim() || name.length > 80) fail(400, 'invalid_name')
    if (typeof location !== 'string' || location.length > 80) fail(400, 'invalid_location')
    if (typeof category !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(category)) fail(400, 'invalid_category')
    if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650) fail(400, 'invalid_interval_days')
    if (!isValidDate(nextDueOn)) fail(400, 'invalid_next_due_on')
    if (assigneeUserId !== null && (typeof assigneeUserId !== 'string' || !UUID_RE.test(assigneeUserId))) fail(400, 'invalid_assignee')
    return kit.tx(async (t) => {
      const c = t.db
      if (assigneeUserId && !(await c.query('select 1 from app_user where id = $1 and active', [assigneeUserId])).rowCount) fail(422, 'assignee_not_found')
      if ((await c.query('select 1 from equipment where code = $1', [code])).rowCount) fail(409, 'equipment_code_taken')
      const { rows } = await c.query(
        `insert into equipment (code, name, location, category, interval_days, next_due_on, assignee_user_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning *, to_char(next_due_on, 'YYYY-MM-DD') as next_due_on`,
        [code, name.trim(), location, category, intervalDays, nextDueOn, assigneeUserId],
      )
      await audit(t, { actor: actor.id, action: 'equipment.create', target: rows[0].id })
      return equipmentJson(rows[0], today())
    })
  }

  const EQ_COLUMNS = `id, code, name, location, category, interval_days, to_char(next_due_on, 'YYYY-MM-DD') as next_due_on, assignee_user_id, active`

  /** viewer = { id, role }: an inspector sees only the equipment assigned to them (role scope "assigned"). */
  async function listEquipment(viewer, { status = 'active', overdueOnly = false } = {}) {
    if (!['active', 'retired', 'all'].includes(status)) fail(400, 'invalid_status')
    const d = today()
    const where = []
    const args = []
    if (status === 'active') where.push('active')
    if (status === 'retired') where.push('not active')
    if (overdueOnly) { args.push(d); where.push(`active and next_due_on < $${args.length}`) }
    if (viewer.role === 'inspector') { args.push(viewer.id); where.push(`assignee_user_id = $${args.length}`) }
    const { rows } = await pool.query(`select ${EQ_COLUMNS} from equipment ${where.length ? `where ${where.join(' and ')}` : ''} order by code limit 500`, args)
    return rows.map((r) => equipmentJson(r, d))
  }

  async function listOverdue() {
    const d = today()
    const { rows } = await pool.query(
      `select id, code, to_char(next_due_on, 'YYYY-MM-DD') as due_on, assignee_user_id, ($1::date - next_due_on) as days from equipment
       where active and next_due_on < $1 order by next_due_on, code limit 500`, [d],
    )
    return { today: d, items: rows.map((r) => ({ equipmentId: r.id, code: r.code, dueOn: r.due_on, daysOverdue: r.days, assigneeUserId: r.assignee_user_id })) }
  }

  async function recordInspection(actor, body) {
    strictKeys(body, ['equipmentId', 'result', 'note', 'inspectedOn'])
    const d = today()
    const { equipmentId, result, note = '', inspectedOn = d } = body
    if (typeof equipmentId !== 'string' || !UUID_RE.test(equipmentId)) fail(400, 'invalid_equipment_id')
    if (!['ok', 'ng'].includes(result)) fail(400, 'invalid_result')
    if (typeof note !== 'string' || note.length > 500) fail(400, 'invalid_note')
    if (!isValidDate(inspectedOn) || inspectedOn > d) fail(400, 'invalid_inspected_on')
    return kit.tx(async (t) => {
      const c = t.db
      const eq = await c.query(`select ${EQ_COLUMNS} from equipment where id = $1 and active for update`, [equipmentId])
      if (!eq.rowCount) fail(404, 'equipment_not_found')
      const e = eq.rows[0]
      if (actor.role === 'inspector' && e.assignee_user_id && e.assignee_user_id !== actor.id) fail(403, 'role_not_permitted')
      const { rows } = await c.query(
        'insert into inspection (equipment_id, inspector_user_id, inspected_on, result, note) values ($1, $2, $3, $4, $5) returning id',
        [equipmentId, actor.id, inspectedOn, result, note],
      )
      const next = addDays(inspectedOn, e.interval_days)
      await c.query('update equipment set next_due_on = greatest(next_due_on, $2::date) where id = $1', [equipmentId, next])
      await kit.emitEvent(t, {
        type: 'inspection.completed', aggregateType: 'inspection', aggregateId: rows[0].id,
        payload: { inspectionId: rows[0].id, equipmentId, result, inspectedOn, inspectorUserId: actor.id },
      })
      return { id: rows[0].id, equipmentId, result, inspectedOn, nextDueOn: next > e.next_due_on ? next : e.next_due_on }
    })
  }

  async function createRepairRequest(actor, body) {
    strictKeys(body, ['equipmentId', 'estimatedCost', 'detail'])
    const { equipmentId, estimatedCost, detail = '' } = body
    if (typeof equipmentId !== 'string' || !UUID_RE.test(equipmentId)) fail(400, 'invalid_equipment_id')
    if (!Number.isInteger(estimatedCost) || estimatedCost < 0 || estimatedCost > 100_000_000) fail(400, 'invalid_estimated_cost')
    if (typeof detail !== 'string' || detail.length > 500) fail(400, 'invalid_detail')
    return kit.tx(async (t) => {
      const c = t.db
      if (!(await c.query('select 1 from equipment where id = $1 and active', [equipmentId])).rowCount) fail(404, 'equipment_not_found')
      const rr = await c.query('insert into repair_request (equipment_id, requested_by, estimated_cost, detail) values ($1, $2, $3, $4) returning id', [equipmentId, actor.id, estimatedCost, detail])
      const { rows } = await c.query(
        `insert into approval (subject_type, subject_id, required_role, requested_by, expires_at)
         values ('repair_request', $1, 'manager', $2, now() + make_interval(days => $3)) returning *`,
        [rr.rows[0].id, actor.id, APPROVAL_TTL_DAYS],
      )
      const a = rows[0]
      await kit.emitEvent(t, {
        type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id,
        payload: { approvalId: a.id, subjectType: a.subject_type, subjectId: a.subject_id, requiredRole: a.required_role, expiresAt: new Date(a.expires_at).toISOString() },
      })
      return { repairRequest: { id: rr.rows[0].id, equipmentId, estimatedCost, status: 'pending' }, approval: approvalJson(a) }
    })
  }

  /**
   * Records a person's decision (web UI or IM card) inside the caller's transaction; `approval` is locked FOR UPDATE.
   * The subject changes state, every live IM card of the approval is revoked, approval.decided is emitted.
   */
  async function decideApproval(t, approval, { action, actor, channel, comment = null, deliveryId = null }) {
    const c = t.db
    const status = action === 'approve' ? 'approved' : 'rejected'
    if (approval.subject_type === 'repair_request') await c.query('update repair_request set status = $2 where id = $1', [approval.subject_id, status])
    const { rows } = await c.query(
      'update approval set status = $2, decided_by = $3, decided_at = now(), decision_channel = $4, comment = $5 where id = $1 returning *',
      [approval.id, status, actor.id, channel, comment],
    )
    await t.revokeApprovalDeliveries({ approvalId: approval.id, exceptId: deliveryId })
    await kit.emitEvent(t, {
      type: 'approval.decided', aggregateType: 'approval', aggregateId: approval.id,
      payload: { approvalId: approval.id, subjectType: approval.subject_type, subjectId: approval.subject_id, decision: action, status, channel, decidedByUserId: actor.id },
    })
    await audit(t, { actor: actor.id, action: `approval.${status}`, target: approval.id, detail: { channel } })
    return approvalJson(rows[0])
  }

  async function lockApproval(c, id) {
    if (!UUID_RE.test(String(id))) return null
    return (await c.query('select * from approval where id = $1 for update', [id])).rows[0] ?? null
  }

  /** Web decision (logged-in approver): the same rule as the IM card. */
  async function decideOnWeb(actor, approvalId, body) {
    strictKeys(body, ['action', 'comment'])
    if (!['approve', 'reject'].includes(body?.action)) fail(400, 'invalid_action')
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 1000)) fail(400, 'invalid_comment')
    if (body.action === 'reject' && !body.comment?.trim()) fail(400, 'comment_required')
    return kit.tx(async (t) => {
      const a = await lockApproval(t.db, approvalId)
      if (!a) fail(404, 'approval_not_found')
      if (a.status !== 'pending') fail(409, `already_${a.status}`)
      if (new Date(a.expires_at) <= kit.now()) fail(410, 'expired')
      if (!mayDecide(a, actor)) fail(403, 'role_not_permitted')
      return decideApproval(t, a, { action: body.action, actor, channel: 'web', comment: body.comment ?? null })
    })
  }

  async function listPendingApprovals() {
    const { rows } = await pool.query(`select * from approval where status = 'pending' and expires_at > now() order by created_at limit 200`)
    return rows.map(approvalJson)
  }

  /** Emits inspection.overdue once per (equipment, due date) whose due date has passed. Idempotent across instances. */
  async function scanOverdue() {
    const d = today()
    const { rows } = await pool.query(
      `select e.id, to_char(e.next_due_on, 'YYYY-MM-DD') as due_on, e.assignee_user_id from equipment e
       where e.active and e.next_due_on < $1
         and not exists (select 1 from overdue_notice n where n.equipment_id = e.id and n.due_on = e.next_due_on)
       order by e.next_due_on limit 500`, [d],
    )
    const created = []
    for (const e of rows) {
      await kit.tx(async (t) => {
        const ins = await t.db.query('insert into overdue_notice (equipment_id, due_on) values ($1, $2) on conflict do nothing returning equipment_id', [e.id, e.due_on])
        if (!ins.rowCount) return
        const eventId = await kit.emitEvent(t, {
          type: 'inspection.overdue', aggregateType: 'equipment', aggregateId: e.id,
          payload: { equipmentId: e.id, dueOn: e.due_on, daysOverdue: daysBetween(e.due_on, d), assigneeUserId: e.assignee_user_id ?? undefined },
        })
        await t.db.query('update overdue_notice set event_id = $3 where equipment_id = $1 and due_on = $2', [e.id, e.due_on, eventId])
        created.push({ eventId, equipmentId: e.id })
      })
    }
    return created
  }

  /** hooks.reports.compute: counts only (never names); an inspector sees their own equipment / own inspections. */
  async function computeSections(viewer) {
    const d = today()
    const own = viewer?.role === 'inspector'
    const scope = viewer.sections
    const out = {}
    if (scope.includes('equipment')) {
      const { rows } = await pool.query('select count(*)::int as total, count(*) filter (where active)::int as active, count(*) filter (where not active)::int as retired from equipment')
      out.equipment = rows[0]
    }
    if (scope.includes('overdue')) {
      const { rows } = await pool.query(
        `select count(*)::int as count, coalesce(max($1::date - next_due_on), 0)::int as "maxDaysOverdue" from equipment
         where active and next_due_on < $1 ${own ? 'and assignee_user_id = $2' : ''}`, own ? [d, viewer.id] : [d],
      )
      out.overdue = rows[0]
    }
    if (scope.includes('inspections')) {
      const { rows } = await pool.query(
        `select count(*) filter (where inspected_on = $1)::int as today,
                count(*) filter (where inspected_on > $1::date - 7)::int as "last7Days",
                count(*) filter (where result = 'ng' and inspected_on > $1::date - 7)::int as "ng7Days"
         from inspection ${own ? 'where inspector_user_id = $2' : ''}`, own ? [d, viewer.id] : [d],
      )
      out.inspections = rows[0]
    }
    if (scope.includes('repairs')) {
      const { rows } = await pool.query(
        `select count(*) filter (where status = 'pending')::int as pending,
                count(*) filter (where status = 'approved' and created_at > now() - interval '30 days')::int as "approved30Days"
         from repair_request`,
      )
      out.repairs = rows[0]
    }
    return { date: d, sections: out, attention: (out.overdue?.count ?? 0) + (out.repairs?.pending ?? 0) }
  }

  return {
    today, createEquipment, listEquipment, listOverdue, recordInspection, createRepairRequest, decideApproval, decideOnWeb, lockApproval,
    listPendingApprovals, scanOverdue, computeSections,
  }
}
