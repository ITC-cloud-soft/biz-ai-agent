// MySQL 8 / TiDB store: the Bridge tables of migrations-mysql/*.sql. Same interface and behaviour as the PostgreSQL store
// (errors.mjs STORE_METHODS, test/store-contract.mjs). createMysqlStore({ pool }) — the pool (mysql2/promise) is the business
// system's own, so store.tx(fn) gives fn a transaction in which the business writes its tables (t.db) and its events together.
//
// Dialect notes (see README "MySQL / TiDB"):
//   * no RETURNING: ids are made here (UUIDs) or read from insertId, then the row is read back on the same connection;
//   * "on conflict do nothing" -> the insert's duplicate-key error is caught (a failed statement does not end the transaction);
//     upserts -> INSERT ... ON DUPLICATE KEY UPDATE;
//   * times are written as UTC (UTC_TIMESTAMP(6), Date parameters formatted in UTC) and read as UTC whatever the pool's
//     own `timezone` / `dateStrings`; JSON may come back parsed or as text; booleans come back as 0 / 1;
//   * event ids come from the one-row counter bridge_event_seq, incremented under its row lock inside the writing
//     transaction: ids commit in increasing order (TiDB's AUTO_INCREMENT is not monotonic across TiDB servers), so the
//     cursor of listEvents(after) never skips one. The lock also serialises event inserts, like the advisory lock of the
//     PostgreSQL store.
import { randomUUID } from 'node:crypto'
import { newServerKey } from '../crypto.mjs'
import { StoreConflict, triggerRef } from './errors.mjs'
import { bridgeMysqlMigrations, migrateMysql, withMysqlTransaction } from './mysqldb.mjs'

const NOW = 'utc_timestamp(6)'
const LIVE_CARD = `('issued', 'locked')`

/** A DATETIME read back (a Date, or text 'YYYY-MM-DD HH:MM:SS[.ffffff]' when the pool uses dateStrings) -> Date (UTC). */
const ts = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?$/.test(v)) return new Date(`${v.replace(' ', 'T')}Z`)
  return new Date(v)
}
/** A time parameter -> 'YYYY-MM-DD HH:MM:SS.mmm' in UTC (independent of the pool's `timezone`). */
const dt = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().replace('T', ' ').replace('Z', ''))
/** A JSON column read back: drivers return it parsed, or as text (jsonStrings, some TiDB / proxy combinations). */
const json = (v) => {
  if (typeof v !== 'string') return v ?? null
  try { return JSON.parse(v) } catch { return v }
}
const bool = (v) => Boolean(Number(v ?? 0))
const num = (v) => (v === null || v === undefined ? null : Number(v))
const str = (v) => (v === null || v === undefined ? null : String(v))

const identityRow = (r) => r && ({
  id: r.id, userId: r.user_id, platform: r.platform, teamId: r.team_id, externalId: r.external_id, botId: r.bot_id ?? null,
  method: r.method, verifiedAt: ts(r.verified_at), createdAt: ts(r.created_at), unlinkedAt: ts(r.unlinked_at),
})
const linkCodeRow = (r) => r && ({ id: r.id, userId: r.user_id, codeHash: r.code_hash, createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), usedAt: ts(r.used_at), revokedAt: ts(r.revoked_at) })
const botRow = (r) => r && ({ id: r.id, userId: r.user_id, platform: r.platform, botId: r.bot_id, createdAt: ts(r.created_at), revokedAt: ts(r.revoked_at) })
const ticketRow = (r) => r && ({ id: r.id, tokenHash: r.token_hash, userId: r.user_id, sessionId: r.session_id, createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), revokedAt: ts(r.revoked_at) })
const delegationRow = (r) => r && ({
  id: r.id, tokenHash: r.token_hash, userId: r.user_id, identityId: r.identity_id ?? null, sessionId: r.session_id ?? null, ticketId: r.ticket_id ?? null,
  sourceEventId: num(r.source_event_id), createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), revokedAt: ts(r.revoked_at),
})
const eventRow = (r) => r && ({ id: Number(r.id), type: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, payload: json(r.payload), createdAt: ts(r.created_at) })
const prefsRow = (r) => r && ({ userId: r.user_id, types: json(r.types), quietHours: json(r.quiet_hours), updatedAt: ts(r.updated_at) })
const deliveryRow = (r) => r && ({
  eventId: Number(r.event_id), userId: r.user_id, status: r.status, channel: r.channel, messageRef: r.message_ref, errorCode: r.error_code,
  resolvedAt: ts(r.resolved_at), updatedAt: ts(r.updated_at),
})
const cardRow = (r) => r && ({
  id: r.id, approvalId: r.approval_id, userId: r.user_id, identityId: r.identity_id, tokenHash: r.token_hash, status: r.status,
  wrongAttempts: Number(r.wrong_attempts), messageRef: r.message_ref, sentAt: ts(r.sent_at), expiresAt: ts(r.expires_at), createdAt: ts(r.created_at),
})
const reportRow = (r) => r && ({
  id: r.id, kind: r.kind, date: r.report_date_text ?? r.report_date, slot: r.slot, sections: json(r.sections), attention: Number(r.attention), test: bool(r.test),
  createdBy: r.created_by, generatedAt: ts(r.generated_at),
})
const proposalRow = (r) => r && ({
  id: r.id, kind: r.kind, payload: json(r.payload), status: r.status, confidence: num(r.confidence),
  forUserId: r.for_user_id ?? null, createdVia: r.created_via, createdAt: ts(r.created_at), decidedBy: r.decided_by ?? null, decidedAt: ts(r.decided_at), comment: r.comment ?? null,
})
const attachmentSettingsRow = (r) => r && ({ roles: json(r.roles), types: json(r.types), updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at) })
const aiProfileRow = (r) => r && ({ version: Number(r.version), profile: json(r.profile), updatedBy: r.updated_by ?? null, reason: r.reason ?? null, createdAt: ts(r.created_at) })
const connectorRow = (r) => r && ({
  id: r.id, connector: json(r.definition), hasSecret: Boolean(r.secret_sealed), secretHint: r.secret_sealed ? r.secret_hint : null, updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at),
})
const ruleRow = (r) => r && ({ id: r.id, rule: json(r.definition), updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at) })
const runRow = (r) => r && ({
  id: Number(r.id), ruleId: r.rule_id ?? null, connectorId: r.connector_id, operationId: r.operation_id, triggerKind: r.trigger_kind, triggerRef: r.trigger_ref ?? null,
  actor: r.actor ?? null, status: r.status, code: r.code ?? null, httpStatus: num(r.http_status), durationMs: num(r.duration_ms), proposalId: r.proposal_id ?? null,
  createdAt: ts(r.created_at),
})
const stateRow = (r) => ({
  stopped: bool(r?.stopped), stoppedBy: r?.stopped_by ?? null, stoppedAt: ts(r?.stopped_at), eventCursor: r ? Number(r.event_cursor) : 0, cronMinute: r?.cron_minute ?? null,
})

/** The index named by a duplicate-key error ("Duplicate entry '…' for key 'bridge_x.bridge_x_live'") -> its name; PRIMARY -> <table>_pkey. */
function conflictName(error) {
  const key = /for key '([^']+)'/.exec(error?.message ?? '')?.[1]
  if (!key) return 'unique'
  const parts = key.split('.')
  const name = parts.at(-1)
  return name === 'PRIMARY' && parts.length > 1 ? `${parts[0]}_pkey` : name
}

/** One statement -> its result (rows for a select, the header for a write). Duplicate keys (1062) -> StoreConflict(index name). */
async function run(db, sql, values = []) {
  try {
    const [res] = await db.query({ sql, values, timezone: 'Z' })
    return res
  } catch (error) {
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') throw new StoreConflict(conflictName(error))
    throw error
  }
}
const first = async (db, sql, values, map) => {
  const rows = await run(db, sql, values)
  return rows.length ? map(rows[0]) : null
}
const all = async (db, sql, values, map) => (await run(db, sql, values)).map(map)
const ignoreConflict = async (promise) => {
  try { await promise; return true } catch (error) {
    if (error instanceof StoreConflict) return false
    throw error
  }
}

/**
 * methods(db, pool): db = the pool (outside a transaction: `pool` is that pool, and the few methods that need several
 * statements to be atomic open their own transaction) or the connection of a transaction (`pool` null).
 */
function methods(db, pool) {
  const atomic = (fn) => (pool ? withMysqlTransaction(pool, fn) : fn(db))
  const selectReport = `select *, date_format(report_date, '%Y-%m-%d') as report_date_text from bridge_report`

  return {
    async getServerKey() {
      const read = () => run(db, "select value from bridge_setting where `key` = 'server_key'")
      let rows = await read()
      if (!rows.length) {
        await ignoreConflict(run(db, "insert into bridge_setting (`key`, value) values ('server_key', ?)", [newServerKey()]))
        rows = await read()
      }
      return Buffer.from(rows[0].value, 'hex')
    },

    // ------------------------------------------------------------ throttles / audit
    async countHits(bucket, key, minutes) {
      const rows = await run(db, `select count(*) as n from bridge_throttle_hit where bucket = ? and \`key\` = ? and at > ${NOW} - interval ? minute`, [bucket, String(key), Number(minutes)])
      return Number(rows[0].n)
    },
    async countBucket(bucket, minutes) {
      const rows = await run(db, `select count(*) as n from bridge_throttle_hit where bucket = ? and at > ${NOW} - interval ? minute`, [bucket, Number(minutes)])
      return Number(rows[0].n)
    },
    async addHit(bucket, key) { await run(db, `insert into bridge_throttle_hit (bucket, \`key\`, at) values (?, ?, ${NOW})`, [bucket, String(key)]) },
    async pruneHits(olderThanMinutes = 1440) { await run(db, `delete from bridge_throttle_hit where at < ${NOW} - interval ? minute`, [Number(olderThanMinutes)]) },
    async audit({ actor, action, target = null, detail = {} }) {
      await run(db, `insert into bridge_audit_log (at, actor, action, target, detail) values (${NOW}, ?, ?, ?, ?)`, [String(actor), action, target, JSON.stringify(detail)])
    },
    async listAudit({ action, limit = 1000 } = {}) {
      const rows = await run(db, `select * from bridge_audit_log ${action ? 'where action = ?' : ''} order by id desc limit ?`, action ? [action, Number(limit)] : [Number(limit)])
      return rows.reverse().map((r) => ({ id: Number(r.id), at: ts(r.at), actor: r.actor, action: r.action, target: r.target, detail: json(r.detail) }))
    },

    // ------------------------------------------------------------ identities
    async findActiveIdentity({ platform, teamId = '', externalId }) {
      return first(db, 'select * from bridge_identity where platform = ? and team_id = ? and external_id = ? and unlinked_at is null', [platform, teamId ?? '', externalId], identityRow)
    },
    async getIdentity(id) { return first(db, 'select * from bridge_identity where id = ?', [id], identityRow) },
    async listIdentities(userId, { platforms = null } = {}) {
      if (platforms && !platforms.length) return []
      return all(db, `select * from bridge_identity where user_id = ? and unlinked_at is null ${platforms ? 'and platform in (?)' : ''} order by created_at, id`,
        platforms ? [String(userId), platforms] : [String(userId)], identityRow)
    },
    async listActiveIdentities() { return all(db, 'select * from bridge_identity where unlinked_at is null order by created_at', [], identityRow) },
    async insertIdentity({ userId, platform, teamId = '', externalId, botId = null, method = 'link_code' }) {
      const id = randomUUID()
      await run(db, `insert into bridge_identity (id, user_id, platform, team_id, external_id, bot_id, method, verified_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW})`,
        [id, String(userId), platform, teamId ?? '', externalId, botId, method])
      return first(db, 'select * from bridge_identity where id = ?', [id], identityRow)
    },
    async unlinkIdentity(id) { return (await run(db, `update bridge_identity set unlinked_at = ${NOW} where id = ? and unlinked_at is null`, [id])).affectedRows > 0 },

    // ------------------------------------------------------------ link codes
    async insertLinkCode({ userId, codeHash, expiresAt }) {
      const id = randomUUID()
      await run(db, `insert into bridge_link_code (id, user_id, code_hash, created_at, expires_at) values (?, ?, ?, ${NOW}, ?)`, [id, String(userId), codeHash, dt(expiresAt)])
      return first(db, 'select * from bridge_link_code where id = ?', [id], linkCodeRow)
    },
    async revokeLiveLinkCodes(userId) { await run(db, `update bridge_link_code set revoked_at = ${NOW} where user_id = ? and used_at is null and revoked_at is null`, [String(userId)]) },
    async findLiveLinkCode(codeHash) { return first(db, 'select * from bridge_link_code where code_hash = ? and used_at is null and revoked_at is null for update', [codeHash], linkCodeRow) },
    async markLinkCodeUsed(id) { await run(db, `update bridge_link_code set used_at = ${NOW} where id = ?`, [id]) },
    async revokeLinkCode(id) { await run(db, `update bridge_link_code set revoked_at = ${NOW} where id = ? and revoked_at is null`, [id]) },

    // ------------------------------------------------------------ personal bots
    async getPersonalBot(platform, botId) { return first(db, 'select * from bridge_personal_bot where platform = ? and bot_id = ? for update', [platform, botId], botRow) },
    async insertPersonalBot({ userId, platform, botId }) {
      const id = randomUUID()
      await run(db, `insert into bridge_personal_bot (id, user_id, platform, bot_id, created_at) values (?, ?, ?, ?, ${NOW})`, [id, String(userId), platform, botId])
      return first(db, 'select * from bridge_personal_bot where id = ?', [id], botRow)
    },
    async listPersonalBots(userId) { return all(db, 'select * from bridge_personal_bot where user_id = ? and revoked_at is null order by created_at', [String(userId)], botRow) },
    async revokePersonalBot({ platform, botId, userId }) {
      return (await run(db, `update bridge_personal_bot set revoked_at = ${NOW} where platform = ? and bot_id = ? and user_id = ? and revoked_at is null`, [platform, botId, String(userId)])).affectedRows > 0
    },

    // ------------------------------------------------------------ assistant tickets / delegations
    async insertTicket({ tokenHash, userId, sessionId, expiresAt }) {
      const id = randomUUID()
      await run(db, `insert into bridge_assistant_ticket (id, token_hash, user_id, session_id, created_at, expires_at) values (?, ?, ?, ?, ${NOW}, ?)`,
        [id, tokenHash, String(userId), String(sessionId), dt(expiresAt)])
      return first(db, 'select * from bridge_assistant_ticket where id = ?', [id], ticketRow)
    },
    async findLiveTicket(tokenHash) { return first(db, `select * from bridge_assistant_ticket where token_hash = ? and revoked_at is null and expires_at > ${NOW}`, [tokenHash], ticketRow) },
    async getTicket(id) { return first(db, 'select * from bridge_assistant_ticket where id = ?', [id], ticketRow) },
    async revokeTicketsBySession(sessionId) { await run(db, `update bridge_assistant_ticket set revoked_at = ${NOW} where session_id = ? and revoked_at is null`, [String(sessionId)]) },
    async insertDelegation({ tokenHash, userId, identityId = null, sessionId = null, ticketId = null, sourceEventId = null, expiresAt }) {
      const id = randomUUID()
      await run(db, `insert into bridge_delegation (id, token_hash, user_id, identity_id, session_id, ticket_id, source_event_id, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ${NOW}, ?)`,
        [id, tokenHash, String(userId), identityId, str(sessionId), ticketId, num(sourceEventId), dt(expiresAt)])
      return first(db, 'select * from bridge_delegation where id = ?', [id], delegationRow)
    },
    async findLiveDelegation(tokenHash) { return first(db, `select * from bridge_delegation where token_hash = ? and revoked_at is null and expires_at > ${NOW}`, [tokenHash], delegationRow) },
    async revokeDelegationsByIdentity(identityId) { await run(db, `update bridge_delegation set revoked_at = ${NOW} where identity_id = ? and revoked_at is null`, [identityId]) },
    async revokeDelegationsByUser(userId) { await run(db, `update bridge_delegation set revoked_at = ${NOW} where user_id = ? and revoked_at is null`, [String(userId)]) },

    // ------------------------------------------------------------ events (outbox)
    async insertEvent({ type, aggregateType, aggregateId, payload }) {
      return atomic(async (c) => {
        // the UPDATE takes the counter row's exclusive lock (as SELECT ... FOR UPDATE would) until the transaction ends:
        // event inserts are serialised and their ids commit in increasing order. LAST_INSERT_ID(expr) hands the new value back.
        const res = await run(c, 'update bridge_event_seq set last_id = last_insert_id(last_id + 1) where id = 1')
        if (res.affectedRows !== 1) throw new Error('bridge_event_seq has no row: run store.migrate()')
        let id = Number(res.insertId)
        if (!id) id = Number((await run(c, 'select last_id from bridge_event_seq where id = 1'))[0].last_id)
        await run(c, `insert into bridge_event (id, event_type, aggregate_type, aggregate_id, payload, created_at) values (?, ?, ?, ?, ?, ${NOW})`,
          [id, type, aggregateType, String(aggregateId), JSON.stringify(payload)])
        return id
      })
    },
    async listEvents(after = 0, limit = 100) { return all(db, 'select * from bridge_event where id > ? order by id limit ?', [Number(after), Number(limit)], eventRow) },
    async getEvent(id) { return first(db, 'select * from bridge_event where id = ?', [Number(id)], eventRow) },
    async latestEventId() { return Number((await run(db, 'select coalesce(max(id), 0) as id from bridge_event'))[0].id) },

    // ------------------------------------------------------------ notification preferences / deliveries
    async getPrefs(userId) { return first(db, 'select * from bridge_notification_pref where user_id = ?', [String(userId)], prefsRow) },
    async putPrefs(userId, { types, quietHours }) {
      await run(db, `insert into bridge_notification_pref (user_id, types, quiet_hours, updated_at) values (?, ?, ?, ${NOW})
         on duplicate key update types = values(types), quiet_hours = values(quiet_hours), updated_at = values(updated_at)`,
      [String(userId), JSON.stringify(types), JSON.stringify(quietHours)])
      return first(db, 'select * from bridge_notification_pref where user_id = ?', [String(userId)], prefsRow)
    },
    async getDelivery(eventId, userId) { return first(db, 'select * from bridge_delivery where event_id = ? and user_id = ? for update', [Number(eventId), String(userId)], deliveryRow) },
    async insertDeliveryIfAbsent({ eventId, userId, channel = null }) {
      return ignoreConflict(run(db, `insert into bridge_delivery (event_id, user_id, channel, resolved_at, updated_at) values (?, ?, ?, ${NOW}, ${NOW})`, [Number(eventId), String(userId), channel]))
    },
    async updateDelivery(eventId, userId, { status, messageRef = null, errorCode = null, channel = null }) {
      return (await run(db,
        `update bridge_delivery set status = ?, message_ref = coalesce(?, message_ref), error_code = ?, channel = coalesce(?, channel), updated_at = ${NOW}
         where event_id = ? and user_id = ?`, [status, messageRef, errorCode, channel, Number(eventId), String(userId)],
      )).affectedRows > 0
    },

    // ------------------------------------------------------------ approval card deliveries
    async findLiveApprovalDelivery(approvalId, userId) {
      return first(db, `select * from bridge_approval_delivery where approval_id = ? and user_id = ? and status in ${LIVE_CARD}`, [String(approvalId), String(userId)], cardRow)
    },
    async insertApprovalDelivery({ id, approvalId, userId, identityId, tokenHash, expiresAt }) {
      await run(db, `insert into bridge_approval_delivery (id, approval_id, user_id, identity_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ${NOW})`,
        [id, String(approvalId), String(userId), identityId, tokenHash, dt(expiresAt)])
      return first(db, 'select * from bridge_approval_delivery where id = ?', [id], cardRow)
    },
    async markApprovalDeliverySent(id, approvalId, messageRef) {
      await run(db, `update bridge_approval_delivery set message_ref = ?, sent_at = ${NOW} where id = ? and approval_id = ?`, [messageRef, id, String(approvalId)])
      return first(db, 'select * from bridge_approval_delivery where id = ? and approval_id = ?', [id, String(approvalId)], cardRow)
    },
    async findApprovalDeliveryByToken(approvalId, tokenHash) {
      return first(db, 'select * from bridge_approval_delivery where approval_id = ? and token_hash = ? for update', [String(approvalId), tokenHash], cardRow)
    },
    async latestApprovalDeliveryFor(approvalId, userId) {
      return first(db, 'select * from bridge_approval_delivery where approval_id = ? and user_id = ? order by created_at desc limit 1 for update', [String(approvalId), String(userId)], cardRow)
    },
    async getApprovalDelivery(id) { return first(db, 'select * from bridge_approval_delivery where id = ? for update', [id], cardRow) },
    async listIssuedApprovalDeliveriesOfUser(userId) {
      return all(db, `select * from bridge_approval_delivery where user_id = ? and status = 'issued' order by created_at`, [String(userId)], cardRow)
    },
    async countWrongReplyCode(id, max) {
      // two statements (MySQL applies SET assignments left to right; TiDB may not): count, then lock at the limit
      return atomic(async (c) => {
        const counted = await run(c, `update bridge_approval_delivery set wrong_attempts = wrong_attempts + 1 where id = ? and status = 'issued'`, [id])
        if (!counted.affectedRows) return 'locked'
        await run(c, `update bridge_approval_delivery set status = 'locked' where id = ? and status = 'issued' and wrong_attempts >= ?`, [id, Number(max)])
        return (await run(c, 'select status from bridge_approval_delivery where id = ?', [id]))[0]?.status ?? 'locked'
      })
    },
    async setApprovalDeliveryStatus(id, status) { await run(db, 'update bridge_approval_delivery set status = ? where id = ?', [status, id]) },
    async revokeApprovalDeliveries({ approvalId, exceptId = null }) {
      await run(db, `update bridge_approval_delivery set status = 'revoked' where approval_id = ? and status in ${LIVE_CARD} and (? is null or id <> ?)`, [String(approvalId), exceptId, exceptId])
    },
    async revokeApprovalDeliveriesByIdentity(identityId) {
      await run(db, `update bridge_approval_delivery set status = 'revoked' where identity_id = ? and status in ${LIVE_CARD}`, [identityId])
    },

    // ------------------------------------------------------------ reports
    async insertReport({ kind, date, slot, sections, attention = 0, test = false, createdBy = null }) {
      const id = randomUUID()
      const inserted = await ignoreConflict(run(db,
        `insert into bridge_report (id, kind, report_date, slot, sections, attention, test, created_by, generated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ${NOW})`,
        [id, kind, date, slot, JSON.stringify(sections), attention, test ? 1 : 0, str(createdBy)]))
      return inserted ? first(db, `${selectReport} where id = ?`, [id], reportRow) : null
    },
    async latestReport(kind) { return first(db, `${selectReport} where kind = ? order by generated_at desc limit 1`, [kind], reportRow) },

    // ------------------------------------------------------------ proposals
    async insertProposal({ kind, payload, confidence = null, forUserId = null, createdVia }) {
      const id = randomUUID()
      await run(db, `insert into bridge_proposal (id, kind, payload, confidence, for_user_id, created_via, created_at) values (?, ?, ?, ?, ?, ?, ${NOW})`,
        [id, kind, JSON.stringify(payload), confidence, str(forUserId), createdVia])
      return first(db, 'select * from bridge_proposal where id = ?', [id], proposalRow)
    },
    async listProposals({ forUserId = null, status = null, kind = null, limit = 200 } = {}) {
      const args = []
      const where = []
      if (forUserId !== null) { args.push(String(forUserId)); where.push('for_user_id = ?') }
      if (status) { args.push(status); where.push('status = ?') }
      if (kind) { args.push(kind); where.push('kind = ?') }
      args.push(Number(limit))
      return all(db, `select * from bridge_proposal ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit ?`, args, proposalRow)
    },
    async getProposal(id) { return first(db, 'select * from bridge_proposal where id = ? for update', [id], proposalRow) },
    async decideProposal(id, { status, decidedBy, comment = null }) {
      await run(db, `update bridge_proposal set status = ?, decided_by = ?, decided_at = ${NOW}, comment = ? where id = ?`, [status, String(decidedBy), comment, id])
      return first(db, 'select * from bridge_proposal where id = ?', [id], proposalRow)
    },

    // ------------------------------------------------------------ the AI employee's profile (versions; current = the highest)
    async insertAiProfileVersion({ profile, updatedBy = null, reason = null }) {
      // next version; two concurrent saves collide on the primary key (StoreConflict) and the caller retries
      return atomic(async (c) => {
        const next = Number((await run(c, 'select coalesce(max(version), 0) + 1 as v from bridge_ai_profile_version'))[0].v)
        await run(c, `insert into bridge_ai_profile_version (version, profile, updated_by, reason, created_at) values (?, ?, ?, ?, ${NOW})`,
          [next, JSON.stringify(profile), str(updatedBy), reason])
        return first(c, 'select * from bridge_ai_profile_version where version = ?', [next], aiProfileRow)
      })
    },
    async latestAiProfile() { return first(db, 'select * from bridge_ai_profile_version order by version desc limit 1', [], aiProfileRow) },
    async getAiProfileVersion(version) { return first(db, 'select * from bridge_ai_profile_version where version = ?', [Number(version)], aiProfileRow) },
    async listAiProfileVersions({ limit = 20 } = {}) {
      const rows = await run(db, 'select version, updated_by, reason, created_at from bridge_ai_profile_version order by version desc limit ?', [Number(limit)])
      return rows.map((r) => ({ version: Number(r.version), updatedBy: r.updated_by ?? null, reason: r.reason ?? null, createdAt: ts(r.created_at) }))
    },

    // ------------------------------------------------------------ attachments in the AI assistant panel (one row of settings)
    async getAttachmentSettings() { return first(db, 'select * from bridge_assistant_attachment_settings where id = 1', [], attachmentSettingsRow) },
    async putAttachmentSettings({ roles, types, updatedBy = null }) {
      await run(db, `insert into bridge_assistant_attachment_settings (id, roles, types, updated_by, updated_at) values (1, ?, ?, ?, ${NOW})
        on duplicate key update roles = values(roles), types = values(types), updated_by = values(updated_by), updated_at = values(updated_at)`,
      [JSON.stringify([...roles]), JSON.stringify([...types]), str(updatedBy)])
      return first(db, 'select * from bridge_assistant_attachment_settings where id = 1', [], attachmentSettingsRow)
    },

    // ------------------------------------------------------------ external connectors (definitions, sealed secrets, rules, runs, state)
    async listConnectors() { return all(db, 'select * from bridge_connector order by id', [], connectorRow) },
    async getConnector(id) { return first(db, 'select * from bridge_connector where id = ?', [String(id)], connectorRow) },
    async putConnector({ connector, updatedBy = null }) {
      await run(db, `insert into bridge_connector (id, definition, updated_by, updated_at) values (?, ?, ?, ${NOW})
        on duplicate key update definition = values(definition), updated_by = values(updated_by), updated_at = values(updated_at)`,
      [connector.id, JSON.stringify(connector), str(updatedBy)])
      return first(db, 'select * from bridge_connector where id = ?', [connector.id], connectorRow)
    },
    async deleteConnector(id) { return (await run(db, 'delete from bridge_connector where id = ?', [String(id)])).affectedRows > 0 },
    async getConnectorSecret(id) {
      const r = (await run(db, 'select secret_sealed, secret_hint from bridge_connector where id = ?', [String(id)]))[0]
      return r?.secret_sealed ? { sealed: r.secret_sealed, hint: r.secret_hint } : null
    },
    async setConnectorSecret(id, { sealed = null, hint = null, updatedBy = null } = {}) {
      const res = await run(db, `update bridge_connector set secret_sealed = ?, secret_hint = ?, updated_by = ?, updated_at = ${NOW} where id = ?`,
        [sealed, sealed ? hint : null, str(updatedBy), String(id)])
      return res.affectedRows > 0
    },
    async listConnectorRules() { return all(db, 'select * from bridge_connector_rule order by id', [], ruleRow) },
    async getConnectorRule(id) { return first(db, 'select * from bridge_connector_rule where id = ?', [String(id)], ruleRow) },
    async putConnectorRule({ rule, updatedBy = null }) {
      await run(db, `insert into bridge_connector_rule (id, definition, updated_by, updated_at) values (?, ?, ?, ${NOW})
        on duplicate key update definition = values(definition), updated_by = values(updated_by), updated_at = values(updated_at)`,
      [rule.id, JSON.stringify(rule), str(updatedBy)])
      return first(db, 'select * from bridge_connector_rule where id = ?', [rule.id], ruleRow)
    },
    async deleteConnectorRule(id) { return (await run(db, 'delete from bridge_connector_rule where id = ?', [String(id)])).affectedRows > 0 },
    async insertConnectorRun({ ruleId = null, connectorId, operationId, trigger = { kind: 'manual' }, actor = null, status, code = null, httpStatus = null, durationMs = null, proposalId = null }) {
      const res = await run(db, `insert into bridge_connector_run (rule_id, connector_id, operation_id, trigger_kind, trigger_ref, actor, status, code, http_status, duration_ms, proposal_id, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW})`,
      [ruleId, connectorId, operationId, trigger.kind, triggerRef(trigger), str(actor), status, code, httpStatus, durationMs, proposalId])
      return first(db, 'select * from bridge_connector_run where id = ?', [Number(res.insertId)], runRow)
    },
    async listConnectorRuns({ limit = 50, connectorId = null, ruleId = null } = {}) {
      return all(db, `select * from bridge_connector_run where (? is null or connector_id = ?) and (? is null or rule_id = ?) order by id desc limit ?`,
        [connectorId, connectorId, ruleId, ruleId, Number(limit)], runRow)
    },
    async getConnectorState() { return stateRow((await run(db, 'select * from bridge_connector_state where id = 1'))[0]) },
    async putConnectorState(patch) {
      return atomic(async (c) => {
        const cur = stateRow((await run(c, 'select * from bridge_connector_state where id = 1 for update'))[0])
        const next = { ...cur, ...patch }
        await run(c, `insert into bridge_connector_state (id, stopped, stopped_by, stopped_at, event_cursor, cron_minute) values (1, ?, ?, ?, ?, ?)
          on duplicate key update stopped = values(stopped), stopped_by = values(stopped_by), stopped_at = values(stopped_at),
            event_cursor = values(event_cursor), cron_minute = values(cron_minute)`,
        [next.stopped ? 1 : 0, next.stoppedBy, dt(next.stoppedAt), Number(next.eventCursor), next.cronMinute])
        return stateRow((await run(c, 'select * from bridge_connector_state where id = 1'))[0])
      })
    },

    // ------------------------------------------------------------ "time passes" (tests / conformance fixtures)
    async expireLinkCodes(userId) {
      await run(db, `update bridge_link_code set expires_at = ${NOW} - interval 1 second where user_id = ? and used_at is null and revoked_at is null`, [String(userId)])
    },
    async expireDelegation(tokenHash) { await run(db, `update bridge_delegation set expires_at = ${NOW} - interval 1 second where token_hash = ?`, [tokenHash]) },
  }
}

/**
 * createMysqlStore({ pool }) -> store, on MySQL 8.0.16+ or TiDB (v7+; pessimistic transactions, the TiDB default). `pool` is
 * a mysql2/promise pool (createMysqlPool, or the business system's own; a callback pool is converted with .promise()).
 * Call `await store.migrate()` once at start-up (idempotent, serialised with GET_LOCK).
 */
export function createMysqlStore({ pool }) {
  if (pool && typeof pool.promise === 'function' && typeof pool.getConnection === 'function') pool = pool.promise()
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('createMysqlStore({ pool }): a mysql2/promise pool is required')
  const store = {
    kind: 'mysql',
    pool,
    db: pool,
    inTransaction: false,
    ...methods(pool, pool),
    /** fn(t): t = every store method bound to the transaction's connection, plus t.db (that mysql2 connection). */
    tx: (fn) => withMysqlTransaction(pool, (conn) => fn({ ...methods(conn, null), db: conn, inTransaction: true })),
    migrate: () => migrateMysql(pool, { migrations: bridgeMysqlMigrations(), table: 'bridge_migration' }),
    async close() { await pool.end() },
  }
  return store
}
