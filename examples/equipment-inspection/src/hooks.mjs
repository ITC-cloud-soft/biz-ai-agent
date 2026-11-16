// The hooks of @dsh-bridge/server-kit: the only Bridge code that knows this business.
//   employees        who exists, which role, active or not (the delegation gate and every check use it)
//   recipientsFor    who is notified of an event and with which typed parameters (never names)
//   approvals        what an approval decides, who may decide it and what its IM card shows (IDs, amount, deadline only)
//   proposalKinds    what the AI may propose, for which roles, and what accepting it does
//   reports.compute  counts per section, scoped by role
import { addDays, DATE_RE, fail, strictKeys, todayIn, UUID_RE } from '@dsh-bridge/server-kit'
import { approvalForKit, approverRoles, mayDecide } from './domain.mjs'

const userRow = (r) => r && ({ id: r.id, role: r.role, active: r.active })

/** domainRef.domain is set once the domain exists (the domain needs the kit, the kit needs these hooks). */
export function createHooks({ pool, auth, manifest, domainRef }) {
  const tz = manifest.system.timezone
  const dbOf = (ctx) => ctx?.db ?? pool
  const today = (ctx) => todayIn(tz, ctx?.now ?? new Date())

  const employees = {
    async get(id, ctx) {
      if (!UUID_RE.test(String(id))) return null
      return userRow((await dbOf(ctx).query('select id, role, active from app_user where id = $1', [id])).rows[0])
    },
    async getMany(ids, ctx) {
      const valid = ids.filter((id) => UUID_RE.test(String(id)))
      if (!valid.length) return []
      return (await dbOf(ctx).query('select id, role, active from app_user where id = any($1::uuid[])', [valid])).rows.map(userRow)
    },
    async list({ roles } = {}, ctx) {
      const { rows } = await dbOf(ctx).query(`select id, role, active from app_user where active ${roles ? 'and role = any($1)' : ''} order by created_at`, roles ? [roles] : [])
      return rows.map(userRow)
    },
  }

  /** Who may see one piece of equipment on the web (listEquipment's rule): admin / manager all, an inspector the equipment assigned to them. */
  const mayViewEquipment = (user, equipment) => user.role === 'admin' || user.role === 'manager'
    || (user.role === 'inspector' && Boolean(equipment.assignee_user_id) && equipment.assignee_user_id === user.id)

  /** The business system (never the IM plugin) decides who gets a notification. */
  async function recipientsFor(event, ctx) {
    if (event.type !== 'inspection.overdue') return null
    const c = dbOf(ctx)
    const { equipmentId, dueOn, daysOverdue } = event.payload
    const eq = await c.query(`select id, active, to_char(next_due_on, 'YYYY-MM-DD') as next_due_on, assignee_user_id from equipment where id = $1`, [equipmentId])
    const e = eq.rows[0]
    if (!e || !e.active) return { stale: 'equipment_retired' }
    if (e.next_due_on > dueOn) return { stale: 'inspected' }
    // rule assignee_and_managers: the assigned inspector + every active admin / manager — then the gate, person by person: only
    // someone who may see this equipment on the web gets it (the same rule as listEquipment: an inspector sees their own only)
    const { rows: candidates } = await c.query(`select id, role from app_user where active and (role in ('admin', 'manager') or id = $1) order by created_at`, [e.assignee_user_id])
    const users = candidates.filter((u) => mayViewEquipment(u, e))
    const { rows: counts } = await c.query('select assignee_user_id, count(*)::int as n from equipment where active and next_due_on < $1 group by assignee_user_id', [today(ctx)])
    const total = counts.reduce((s, r) => s + r.n, 0)
    const own = new Map(counts.filter((r) => r.assignee_user_id).map((r) => [r.assignee_user_id, r.n]))
    return {
      users,
      template: manifest.events['inspection.overdue'].notify.template,
      dedupeKey: `inspection.overdue:${equipmentId}:${dueOn}`,
      link: `/equipment/${equipmentId}`,
      // count = the overdue equipment this reader is responsible for (managers: all; an inspector: their own)
      paramsFor: (u) => ({ count: u.role === 'inspector' ? (own.get(u.id) ?? 0) : total, daysOverdue, dueOn }),
    }
  }

  const approvals = {
    async get(id, ctx) {
      if (!UUID_RE.test(String(id))) return null
      const { rows } = await dbOf(ctx).query(`select * from approval where id = $1 ${ctx?.lock ? 'for update' : ''}`, [id])
      return approvalForKit(rows[0] ?? null)
    },
    async approvers(approval, ctx) {
      const { rows } = await dbOf(ctx).query('select id, role from app_user where active and role = any($1) and id <> $2 order by created_at', [approverRoles(approval), approval.requested_by])
      return rows
    },
    /** The IM card: IDs, equipment code, amount and deadline only. No names, no free text from the request. */
    async card(approval, ctx) {
      const { rows } = await dbOf(ctx).query('select r.estimated_cost, e.code from repair_request r join equipment e on e.id = r.equipment_id where r.id = $1', [approval.subject_id])
      const r = rows[0]
      return {
        title: '修理依頼の承認',
        fields: [
          { label: '依頼ID', value: String(approval.subject_id).slice(0, 8) },
          { label: '設備コード', value: r?.code ?? '-' },
          { label: '見積額', value: `${r?.estimated_cost ?? 0}円` },
          { label: '期限', value: new Date(approval.expires_at).toISOString().slice(0, 10) },
        ],
        body: '承認・却下はボタン、または返信コードで行えます。詳しい内容は業務 Web で確認してください。',
      }
    },
    mayDecide: async (approval, user) => mayDecide(approval, user), // the same rule as the web UI
    decide: (approval, decision, ctx) => domainRef.domain.decideApproval(ctx.t, approval, decision),
  }

  const equipmentExists = async (ctx, id) => (await dbOf(ctx).query('select 1 from equipment where id = $1 and active', [id])).rowCount > 0
  const proposalKinds = {
    inspection_reschedule: {
      roles: ['admin', 'manager', 'inspector'],
      async validate(payload, ctx) {
        strictKeys(payload, ['equipmentId', 'dueOn', 'reason'], 'invalid_payload') // reason: optional note for the reviewer (plugin-tools)
        if (payload.reason !== undefined && (typeof payload.reason !== 'string' || payload.reason.length > 200)) fail(400, 'invalid_payload')
        if (typeof payload.equipmentId !== 'string' || !UUID_RE.test(payload.equipmentId)) fail(400, 'invalid_payload')
        const d = today(ctx)
        if (typeof payload.dueOn !== 'string' || !DATE_RE.test(payload.dueOn) || payload.dueOn < d || payload.dueOn > addDays(d, 366)) fail(400, 'invalid_payload')
        if (!(await equipmentExists(ctx, payload.equipmentId))) fail(422, 'equipment_not_found')
      },
      async apply(payload, actor, ctx) {
        await dbOf(ctx).query('update equipment set next_due_on = $2 where id = $1 and active', [payload.equipmentId, payload.dueOn])
      },
    },
    equipment_retire: {
      roles: ['admin', 'manager'],
      async validate(payload, ctx) {
        strictKeys(payload, ['equipmentId'], 'invalid_payload')
        if (typeof payload.equipmentId !== 'string' || !UUID_RE.test(payload.equipmentId)) fail(400, 'invalid_payload')
        if (!(await equipmentExists(ctx, payload.equipmentId))) fail(422, 'equipment_not_found')
      },
      async apply(payload, actor, ctx) {
        await dbOf(ctx).query('update equipment set active = false where id = $1', [payload.equipmentId])
      },
    },
  }

  const reports = { kind: 'daily_inspection', compute: (viewer) => domainRef.domain.computeSections(viewer) }

  // POST /bridge/v1/pii-scan (bridge-memory checks every text before it keeps it): the kit checks the shape (phone, e-mail, ...);
  // the names are only here, in the roster. A display name in the text = 'staff_name' (a real system may also match family names,
  // kana readings, the clients' names ...). The answer carries the category only, never the name.
  const piiScan = async (text, ctx) => {
    const hay = String(text).normalize('NFKC').replace(/\s+/g, '')
    const { rows } = await dbOf(ctx).query('select display_name from app_user')
    for (const { display_name: name } of rows) {
      const full = String(name).normalize('NFKC').replace(/\s+/g, '')
      if (full.length >= 2 && hay.includes(full)) return { kinds: ['staff_name'] }
    }
    return { kinds: [] }
  }

  return { employees, authenticate: auth.authenticate, isSessionLive: auth.isSessionLive, recipientsFor, approvals, proposalKinds, reports, piiScan }
}
