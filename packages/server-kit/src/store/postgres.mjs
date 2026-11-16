// PostgreSQL store: the Bridge tables of migrations/*.sql. Same interface as the memory store (errors.mjs).
// createPostgresStore({ pool }) — the pool is the business system's own, so store.tx(fn) gives fn a transaction in which
// the business writes its tables (t.db) and its events (outbox) together.
import { newServerKey } from '../crypto.mjs'
import { StoreConflict, triggerRef } from './errors.mjs'
import { bridgeMigrations, migrate, withTransaction } from './pg.mjs'

const EVENT_LOCK_KEY = 1972_0001 // serialises event inserts: ids commit in increasing order, a cursor never skips one
const LIVE_CARD = `('issued', 'locked')`

const ts = (v) => (v === null || v === undefined ? null : new Date(v))
const identityRow = (r) => r && ({
  id: r.id, userId: r.user_id, platform: r.platform, teamId: r.team_id, externalId: r.external_id, botId: r.bot_id ?? null,
  method: r.method, verifiedAt: ts(r.verified_at), createdAt: ts(r.created_at), unlinkedAt: ts(r.unlinked_at),
})
const linkCodeRow = (r) => r && ({ id: r.id, userId: r.user_id, codeHash: r.code_hash, createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), usedAt: ts(r.used_at), revokedAt: ts(r.revoked_at) })
const botRow = (r) => r && ({ id: r.id, userId: r.user_id, platform: r.platform, botId: r.bot_id, createdAt: ts(r.created_at), revokedAt: ts(r.revoked_at) })
const ticketRow = (r) => r && ({ id: r.id, tokenHash: r.token_hash, userId: r.user_id, sessionId: r.session_id, createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), revokedAt: ts(r.revoked_at) })
const delegationRow = (r) => r && ({
  id: r.id, tokenHash: r.token_hash, userId: r.user_id, identityId: r.identity_id ?? null, sessionId: r.session_id ?? null, ticketId: r.ticket_id ?? null,
  sourceEventId: r.source_event_id === null || r.source_event_id === undefined ? null : Number(r.source_event_id), createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), revokedAt: ts(r.revoked_at),
})
const eventRow = (r) => r && ({ id: Number(r.id), type: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, payload: r.payload, createdAt: ts(r.created_at) })
const deliveryRow = (r) => r && ({
  eventId: Number(r.event_id), userId: r.user_id, status: r.status, channel: r.channel, messageRef: r.message_ref, errorCode: r.error_code,
  resolvedAt: ts(r.resolved_at), updatedAt: ts(r.updated_at),
})
const cardRow = (r) => r && ({
  id: r.id, approvalId: r.approval_id, userId: r.user_id, identityId: r.identity_id, tokenHash: r.token_hash, status: r.status,
  wrongAttempts: r.wrong_attempts, messageRef: r.message_ref, sentAt: ts(r.sent_at), expiresAt: ts(r.expires_at), createdAt: ts(r.created_at),
})
const reportRow = (r) => r && ({
  id: r.id, kind: r.kind, date: r.report_date_text ?? r.report_date, slot: r.slot, sections: r.sections, attention: r.attention, test: r.test,
  createdBy: r.created_by, generatedAt: ts(r.generated_at),
})
const proposalRow = (r) => r && ({
  id: r.id, kind: r.kind, payload: r.payload, status: r.status, confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
  forUserId: r.for_user_id ?? null, createdVia: r.created_via, createdAt: ts(r.created_at), decidedBy: r.decided_by ?? null, decidedAt: ts(r.decided_at), comment: r.comment ?? null,
})
const attachmentSettingsRow = (r) => r && ({ roles: r.roles, types: r.types, updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at) })
const aiProfileRow = (r) => r && ({ version: Number(r.version), profile: r.profile, updatedBy: r.updated_by ?? null, reason: r.reason ?? null, createdAt: ts(r.created_at) })
const connectorRow = (r) => r && ({
  id: r.id, connector: r.definition, hasSecret: Boolean(r.secret_sealed), secretHint: r.secret_sealed ? r.secret_hint : null, updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at),
})
const ruleRow = (r) => r && ({ id: r.id, rule: r.definition, updatedBy: r.updated_by ?? null, updatedAt: ts(r.updated_at) })
const runRow = (r) => r && ({
  id: Number(r.id), ruleId: r.rule_id ?? null, connectorId: r.connector_id, operationId: r.operation_id, triggerKind: r.trigger_kind, triggerRef: r.trigger_ref ?? null,
  actor: r.actor ?? null, status: r.status, code: r.code ?? null, httpStatus: r.http_status ?? null, durationMs: r.duration_ms ?? null, proposalId: r.proposal_id ?? null,
  createdAt: ts(r.created_at),
})
const stateRow = (r) => ({
  stopped: Boolean(r?.stopped), stoppedBy: r?.stopped_by ?? null, stoppedAt: ts(r?.stopped_at), eventCursor: r ? Number(r.event_cursor) : 0, cronMinute: r?.cron_minute ?? null,
})
const first = (res, map) => (res.rows.length ? map(res.rows[0]) : null)

/** Maps unique violations (23505) to StoreConflict(constraint). */
async function q(db, sql, args) {
  try { return await db.query(sql, args) } catch (error) {
    if (error?.code === '23505') throw new StoreConflict(error.constraint ?? 'unique')
    throw error
  }
}

function methods(db) {
  return {
    async getServerKey() {
      await db.query(`insert into bridge_setting (key, value) values ('server_key', $1) on conflict (key) do nothing`, [newServerKey()])
      const { rows } = await db.query(`select value from bridge_setting where key = 'server_key'`)
      return Buffer.from(rows[0].value, 'hex')
    },

    // ------------------------------------------------------------ throttles / audit
    async countHits(bucket, key, minutes) {
      const { rows } = await db.query('select count(*)::int as n from bridge_throttle_hit where bucket = $1 and key = $2 and at > now() - make_interval(mins => $3)', [bucket, String(key), minutes])
      return rows[0].n
    },
    async countBucket(bucket, minutes) {
      const { rows } = await db.query('select count(*)::int as n from bridge_throttle_hit where bucket = $1 and at > now() - make_interval(mins => $2)', [bucket, minutes])
      return rows[0].n
    },
    async addHit(bucket, key) { await db.query('insert into bridge_throttle_hit (bucket, key) values ($1, $2)', [bucket, String(key)]) },
    async pruneHits(olderThanMinutes = 1440) { await db.query('delete from bridge_throttle_hit where at < now() - make_interval(mins => $1)', [olderThanMinutes]) },
    async audit({ actor, action, target = null, detail = {} }) {
      await db.query('insert into bridge_audit_log (actor, action, target, detail) values ($1, $2, $3, $4)', [String(actor), action, target, JSON.stringify(detail)])
    },
    async listAudit({ action, limit = 1000 } = {}) {
      const { rows } = await db.query(`select * from bridge_audit_log ${action ? 'where action = $2' : ''} order by id desc limit $1`, action ? [limit, action] : [limit])
      return rows.reverse().map((r) => ({ id: Number(r.id), at: ts(r.at), actor: r.actor, action: r.action, target: r.target, detail: r.detail }))
    },

    // ------------------------------------------------------------ identities
    async findActiveIdentity({ platform, teamId = '', externalId }) {
      return first(await db.query('select * from bridge_identity where platform = $1 and team_id = $2 and external_id = $3 and unlinked_at is null', [platform, teamId ?? '', externalId]), identityRow)
    },
    async getIdentity(id) { return first(await db.query('select * from bridge_identity where id = $1', [id]), identityRow) },
    async listIdentities(userId, { platforms = null } = {}) {
      const { rows } = await db.query(
        `select * from bridge_identity where user_id = $1 and unlinked_at is null ${platforms ? 'and platform = any($2)' : ''} order by created_at, id`,
        platforms ? [String(userId), platforms] : [String(userId)],
      )
      return rows.map(identityRow)
    },
    async listActiveIdentities() { return (await db.query('select * from bridge_identity where unlinked_at is null order by created_at')).rows.map(identityRow) },
    async insertIdentity({ userId, platform, teamId = '', externalId, botId = null, method = 'link_code' }) {
      return first(await q(db, 'insert into bridge_identity (user_id, platform, team_id, external_id, bot_id, method) values ($1, $2, $3, $4, $5, $6) returning *',
        [String(userId), platform, teamId ?? '', externalId, botId, method]), identityRow)
    },
    async unlinkIdentity(id) { return (await db.query('update bridge_identity set unlinked_at = now() where id = $1 and unlinked_at is null', [id])).rowCount > 0 },

    // ------------------------------------------------------------ link codes
    async insertLinkCode({ userId, codeHash, expiresAt }) {
      return first(await q(db, 'insert into bridge_link_code (user_id, code_hash, expires_at) values ($1, $2, $3) returning *', [String(userId), codeHash, new Date(expiresAt)]), linkCodeRow)
    },
    async revokeLiveLinkCodes(userId) { await db.query('update bridge_link_code set revoked_at = now() where user_id = $1 and used_at is null and revoked_at is null', [String(userId)]) },
    async findLiveLinkCode(codeHash) { return first(await db.query('select * from bridge_link_code where code_hash = $1 and used_at is null and revoked_at is null for update', [codeHash]), linkCodeRow) },
    async markLinkCodeUsed(id) { await db.query('update bridge_link_code set used_at = now() where id = $1', [id]) },
    async revokeLinkCode(id) { await db.query('update bridge_link_code set revoked_at = now() where id = $1 and revoked_at is null', [id]) },

    // ------------------------------------------------------------ personal bots
    async getPersonalBot(platform, botId) { return first(await db.query('select * from bridge_personal_bot where platform = $1 and bot_id = $2 for update', [platform, botId]), botRow) },
    async insertPersonalBot({ userId, platform, botId }) {
      return first(await q(db, 'insert into bridge_personal_bot (user_id, platform, bot_id) values ($1, $2, $3) returning *', [String(userId), platform, botId]), botRow)
    },
    async listPersonalBots(userId) { return (await db.query('select * from bridge_personal_bot where user_id = $1 and revoked_at is null order by created_at', [String(userId)])).rows.map(botRow) },
    async revokePersonalBot({ platform, botId, userId }) {
      return (await db.query('update bridge_personal_bot set revoked_at = now() where platform = $1 and bot_id = $2 and user_id = $3 and revoked_at is null', [platform, botId, String(userId)])).rowCount > 0
    },

    // ------------------------------------------------------------ assistant tickets / delegations
    async insertTicket({ tokenHash, userId, sessionId, expiresAt }) {
      return first(await q(db, 'insert into bridge_assistant_ticket (token_hash, user_id, session_id, expires_at) values ($1, $2, $3, $4) returning *', [tokenHash, String(userId), String(sessionId), new Date(expiresAt)]), ticketRow)
    },
    async findLiveTicket(tokenHash) { return first(await db.query('select * from bridge_assistant_ticket where token_hash = $1 and revoked_at is null and expires_at > now()', [tokenHash]), ticketRow) },
    async getTicket(id) { return first(await db.query('select * from bridge_assistant_ticket where id = $1', [id]), ticketRow) },
    async revokeTicketsBySession(sessionId) { await db.query('update bridge_assistant_ticket set revoked_at = now() where session_id = $1 and revoked_at is null', [String(sessionId)]) },
    async insertDelegation({ tokenHash, userId, identityId = null, sessionId = null, ticketId = null, sourceEventId = null, expiresAt }) {
      return first(await q(db,
        'insert into bridge_delegation (token_hash, user_id, identity_id, session_id, ticket_id, source_event_id, expires_at) values ($1, $2, $3, $4, $5, $6, $7) returning *',
        [tokenHash, String(userId), identityId, sessionId === null ? null : String(sessionId), ticketId, sourceEventId, new Date(expiresAt)]), delegationRow)
    },
    async findLiveDelegation(tokenHash) { return first(await db.query('select * from bridge_delegation where token_hash = $1 and revoked_at is null and expires_at > now()', [tokenHash]), delegationRow) },
    async revokeDelegationsByIdentity(identityId) { await db.query('update bridge_delegation set revoked_at = now() where identity_id = $1 and revoked_at is null', [identityId]) },
    async revokeDelegationsByUser(userId) { await db.query('update bridge_delegation set revoked_at = now() where user_id = $1 and revoked_at is null', [String(userId)]) },

    // ------------------------------------------------------------ events (outbox)
    async insertEvent({ type, aggregateType, aggregateId, payload }) {
      await db.query('select pg_advisory_xact_lock($1)', [EVENT_LOCK_KEY])
      const { rows } = await db.query('insert into bridge_event (event_type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4) returning id', [type, aggregateType, String(aggregateId), JSON.stringify(payload)])
      return Number(rows[0].id)
    },
    async listEvents(after = 0, limit = 100) { return (await db.query('select * from bridge_event where id > $1 order by id limit $2', [after, limit])).rows.map(eventRow) },
    async getEvent(id) { return first(await db.query('select * from bridge_event where id = $1', [id]), eventRow) },
    async latestEventId() { return Number((await db.query('select coalesce(max(id), 0) as id from bridge_event')).rows[0].id) },

    // ------------------------------------------------------------ notification preferences / deliveries
    async getPrefs(userId) {
      return first(await db.query('select * from bridge_notification_pref where user_id = $1', [String(userId)]), (r) => ({ userId: r.user_id, types: r.types, quietHours: r.quiet_hours, updatedAt: ts(r.updated_at) }))
    },
    async putPrefs(userId, { types, quietHours }) {
      const { rows } = await db.query(
        `insert into bridge_notification_pref (user_id, types, quiet_hours, updated_at) values ($1, $2, $3, now())
         on conflict (user_id) do update set types = excluded.types, quiet_hours = excluded.quiet_hours, updated_at = now() returning *`,
        [String(userId), JSON.stringify(types), JSON.stringify(quietHours)],
      )
      return { userId: rows[0].user_id, types: rows[0].types, quietHours: rows[0].quiet_hours, updatedAt: ts(rows[0].updated_at) }
    },
    async getDelivery(eventId, userId) { return first(await db.query('select * from bridge_delivery where event_id = $1 and user_id = $2 for update', [eventId, String(userId)]), deliveryRow) },
    async insertDeliveryIfAbsent({ eventId, userId, channel = null }) {
      return (await db.query('insert into bridge_delivery (event_id, user_id, channel) values ($1, $2, $3) on conflict do nothing', [eventId, String(userId), channel])).rowCount > 0
    },
    async updateDelivery(eventId, userId, { status, messageRef = null, errorCode = null, channel = null }) {
      return (await db.query(
        `update bridge_delivery set status = $3, message_ref = coalesce($4, message_ref), error_code = $5, channel = coalesce($6, channel), updated_at = now()
         where event_id = $1 and user_id = $2`, [eventId, String(userId), status, messageRef, errorCode, channel],
      )).rowCount > 0
    },

    // ------------------------------------------------------------ approval card deliveries
    async findLiveApprovalDelivery(approvalId, userId) {
      return first(await db.query(`select * from bridge_approval_delivery where approval_id = $1 and user_id = $2 and status in ${LIVE_CARD}`, [String(approvalId), String(userId)]), cardRow)
    },
    async insertApprovalDelivery({ id, approvalId, userId, identityId, tokenHash, expiresAt }) {
      return first(await q(db,
        'insert into bridge_approval_delivery (id, approval_id, user_id, identity_id, token_hash, expires_at) values ($1, $2, $3, $4, $5, $6) returning *',
        [id, String(approvalId), String(userId), identityId, tokenHash, new Date(expiresAt)]), cardRow)
    },
    async markApprovalDeliverySent(id, approvalId, messageRef) {
      return first(await db.query('update bridge_approval_delivery set message_ref = $3, sent_at = now() where id = $1 and approval_id = $2 returning *', [id, String(approvalId), messageRef]), cardRow)
    },
    async findApprovalDeliveryByToken(approvalId, tokenHash) {
      return first(await db.query('select * from bridge_approval_delivery where approval_id = $1 and token_hash = $2 for update', [String(approvalId), tokenHash]), cardRow)
    },
    async latestApprovalDeliveryFor(approvalId, userId) {
      return first(await db.query('select * from bridge_approval_delivery where approval_id = $1 and user_id = $2 order by created_at desc limit 1 for update', [String(approvalId), String(userId)]), cardRow)
    },
    async getApprovalDelivery(id) { return first(await db.query('select * from bridge_approval_delivery where id = $1 for update', [id]), cardRow) },
    async listIssuedApprovalDeliveriesOfUser(userId) {
      return (await db.query(`select * from bridge_approval_delivery where user_id = $1 and status = 'issued' order by created_at`, [String(userId)])).rows.map(cardRow)
    },
    async countWrongReplyCode(id, max) {
      const { rows } = await db.query(
        `update bridge_approval_delivery set wrong_attempts = wrong_attempts + 1,
           status = case when wrong_attempts + 1 >= $2 then 'locked' else status end
         where id = $1 and status = 'issued' returning status`, [id, max],
      )
      return rows[0]?.status ?? 'locked'
    },
    async setApprovalDeliveryStatus(id, status) { await db.query('update bridge_approval_delivery set status = $2 where id = $1', [id, status]) },
    async revokeApprovalDeliveries({ approvalId, exceptId = null }) {
      await db.query(`update bridge_approval_delivery set status = 'revoked' where approval_id = $1 and status in ${LIVE_CARD} and ($2::uuid is null or id <> $2)`, [String(approvalId), exceptId])
    },
    async revokeApprovalDeliveriesByIdentity(identityId) {
      await db.query(`update bridge_approval_delivery set status = 'revoked' where identity_id = $1 and status in ${LIVE_CARD}`, [identityId])
    },

    // ------------------------------------------------------------ reports
    async insertReport({ kind, date, slot, sections, attention = 0, test = false, createdBy = null }) {
      const { rows } = await db.query(
        `insert into bridge_report (kind, report_date, slot, sections, attention, test, created_by) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict do nothing returning *, to_char(report_date, 'YYYY-MM-DD') as report_date_text`,
        [kind, date, slot, JSON.stringify(sections), attention, test, createdBy === null ? null : String(createdBy)],
      )
      return rows.length ? reportRow(rows[0]) : null
    },
    async latestReport(kind) {
      return first(await db.query(`select *, to_char(report_date, 'YYYY-MM-DD') as report_date_text from bridge_report where kind = $1 order by generated_at desc limit 1`, [kind]), reportRow)
    },

    // ------------------------------------------------------------ proposals
    async insertProposal({ kind, payload, confidence = null, forUserId = null, createdVia }) {
      return first(await db.query('insert into bridge_proposal (kind, payload, confidence, for_user_id, created_via) values ($1, $2, $3, $4, $5) returning *',
        [kind, JSON.stringify(payload), confidence, forUserId === null ? null : String(forUserId), createdVia]), proposalRow)
    },
    async listProposals({ forUserId = null, status = null, kind = null, limit = 200 } = {}) {
      const args = []
      const where = []
      if (forUserId !== null) { args.push(String(forUserId)); where.push(`for_user_id = $${args.length}`) }
      if (status) { args.push(status); where.push(`status = $${args.length}`) }
      if (kind) { args.push(kind); where.push(`kind = $${args.length}`) }
      args.push(limit)
      const { rows } = await db.query(`select * from bridge_proposal ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit $${args.length}`, args)
      return rows.map(proposalRow)
    },
    async getProposal(id) { return first(await db.query('select * from bridge_proposal where id = $1 for update', [id]), proposalRow) },
    async decideProposal(id, { status, decidedBy, comment = null }) {
      return first(await db.query('update bridge_proposal set status = $2, decided_by = $3, decided_at = now(), comment = $4 where id = $1 returning *', [id, status, String(decidedBy), comment]), proposalRow)
    },

    // ------------------------------------------------------------ the AI employee's profile (versions; current = the highest)
    async insertAiProfileVersion({ profile, updatedBy = null, reason = null }) {
      // next version in one statement; two concurrent saves collide on the primary key (StoreConflict) and the caller retries
      return first(await q(db, `insert into bridge_ai_profile_version (version, profile, updated_by, reason)
        select coalesce(max(version), 0) + 1, $1, $2, $3 from bridge_ai_profile_version returning *`,
      [JSON.stringify(profile), updatedBy === null ? null : String(updatedBy), reason]), aiProfileRow)
    },
    async latestAiProfile() { return first(await db.query('select * from bridge_ai_profile_version order by version desc limit 1'), aiProfileRow) },
    async getAiProfileVersion(version) { return first(await db.query('select * from bridge_ai_profile_version where version = $1', [Number(version)]), aiProfileRow) },
    async listAiProfileVersions({ limit = 20 } = {}) {
      const { rows } = await db.query('select version, updated_by, reason, created_at from bridge_ai_profile_version order by version desc limit $1', [limit])
      return rows.map((r) => ({ version: Number(r.version), updatedBy: r.updated_by ?? null, reason: r.reason ?? null, createdAt: ts(r.created_at) }))
    },

    // ------------------------------------------------------------ attachments in the AI assistant panel (one row of settings)
    async getAttachmentSettings() { return first(await db.query('select * from bridge_assistant_attachment_settings where id = 1'), attachmentSettingsRow) },
    async putAttachmentSettings({ roles, types, updatedBy = null }) {
      return first(await db.query(`insert into bridge_assistant_attachment_settings (id, roles, types, updated_by, updated_at) values (1, $1, $2, $3, now())
        on conflict (id) do update set roles = excluded.roles, types = excluded.types, updated_by = excluded.updated_by, updated_at = now() returning *`,
      [JSON.stringify([...roles]), JSON.stringify([...types]), updatedBy === null ? null : String(updatedBy)]), attachmentSettingsRow)
    },

    // ------------------------------------------------------------ external connectors (definitions, sealed secrets, rules, runs, state)
    async listConnectors() { return (await db.query('select * from bridge_connector order by id')).rows.map(connectorRow) },
    async getConnector(id) { return first(await db.query('select * from bridge_connector where id = $1', [String(id)]), connectorRow) },
    async putConnector({ connector, updatedBy = null }) {
      return first(await db.query(`insert into bridge_connector (id, definition, updated_by, updated_at) values ($1, $2, $3, now())
        on conflict (id) do update set definition = excluded.definition, updated_by = excluded.updated_by, updated_at = now() returning *`,
      [connector.id, JSON.stringify(connector), updatedBy === null ? null : String(updatedBy)]), connectorRow)
    },
    async deleteConnector(id) { return (await db.query('delete from bridge_connector where id = $1', [String(id)])).rowCount > 0 },
    async getConnectorSecret(id) {
      const r = first(await db.query('select secret_sealed, secret_hint from bridge_connector where id = $1', [String(id)]), (x) => x)
      return r?.secret_sealed ? { sealed: r.secret_sealed, hint: r.secret_hint } : null
    },
    async setConnectorSecret(id, { sealed = null, hint = null, updatedBy = null } = {}) {
      const res = await db.query('update bridge_connector set secret_sealed = $2, secret_hint = $3, updated_by = $4, updated_at = now() where id = $1',
        [String(id), sealed, sealed ? hint : null, updatedBy === null ? null : String(updatedBy)])
      return res.rowCount > 0
    },
    async listConnectorRules() { return (await db.query('select * from bridge_connector_rule order by id')).rows.map(ruleRow) },
    async getConnectorRule(id) { return first(await db.query('select * from bridge_connector_rule where id = $1', [String(id)]), ruleRow) },
    async putConnectorRule({ rule, updatedBy = null }) {
      return first(await db.query(`insert into bridge_connector_rule (id, definition, updated_by, updated_at) values ($1, $2, $3, now())
        on conflict (id) do update set definition = excluded.definition, updated_by = excluded.updated_by, updated_at = now() returning *`,
      [rule.id, JSON.stringify(rule), updatedBy === null ? null : String(updatedBy)]), ruleRow)
    },
    async deleteConnectorRule(id) { return (await db.query('delete from bridge_connector_rule where id = $1', [String(id)])).rowCount > 0 },
    async insertConnectorRun({ ruleId = null, connectorId, operationId, trigger = { kind: 'manual' }, actor = null, status, code = null, httpStatus = null, durationMs = null, proposalId = null }) {
      return first(await db.query(`insert into bridge_connector_run (rule_id, connector_id, operation_id, trigger_kind, trigger_ref, actor, status, code, http_status, duration_ms, proposal_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [ruleId, connectorId, operationId, trigger.kind, triggerRef(trigger), actor === null ? null : String(actor), status, code, httpStatus, durationMs, proposalId]), runRow)
    },
    async listConnectorRuns({ limit = 50, connectorId = null, ruleId = null } = {}) {
      const { rows } = await db.query(`select * from bridge_connector_run where ($1::text is null or connector_id = $1) and ($2::text is null or rule_id = $2)
        order by id desc limit $3`, [connectorId, ruleId, limit])
      return rows.map(runRow)
    },
    async getConnectorState() { return stateRow((await db.query('select * from bridge_connector_state where id = 1')).rows[0]) },
    async putConnectorState(patch) {
      const cur = stateRow((await db.query('select * from bridge_connector_state where id = 1 for update')).rows[0])
      const next = { ...cur, ...patch }
      const { rows } = await db.query(`insert into bridge_connector_state (id, stopped, stopped_by, stopped_at, event_cursor, cron_minute) values (1, $1, $2, $3, $4, $5)
        on conflict (id) do update set stopped = excluded.stopped, stopped_by = excluded.stopped_by, stopped_at = excluded.stopped_at,
          event_cursor = excluded.event_cursor, cron_minute = excluded.cron_minute returning *`,
      [next.stopped, next.stoppedBy, next.stoppedAt, next.eventCursor, next.cronMinute])
      return stateRow(rows[0])
    },

    // ------------------------------------------------------------ "time passes" (tests / conformance fixtures)
    async expireLinkCodes(userId) {
      await db.query(`update bridge_link_code set expires_at = now() - interval '1 second' where user_id = $1 and used_at is null and revoked_at is null`, [String(userId)])
    },
    async expireDelegation(tokenHash) { await db.query(`update bridge_delegation set expires_at = now() - interval '1 second' where token_hash = $1`, [tokenHash]) },
  }
}

/**
 * createPostgresStore({ pool }) -> store. Call `await store.migrate()` once at start-up (idempotent, advisory-locked).
 * UUID ids need PostgreSQL 13+ (gen_random_uuid).
 */
export function createPostgresStore({ pool }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('createPostgresStore({ pool }): a pg.Pool is required')
  const store = {
    kind: 'postgres',
    pool,
    db: pool,
    inTransaction: false,
    ...methods(pool),
    /** fn(t): t = every store method bound to the transaction's client, plus t.db (that client). */
    tx: (fn) => withTransaction(pool, (client) => fn({ ...methods(client), db: client, inTransaction: true })),
    migrate: () => migrate(pool, { migrations: bridgeMigrations(), table: 'bridge_migration' }),
    async close() { await pool.end() },
  }
  return store
}
