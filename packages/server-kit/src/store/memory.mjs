// In-memory store (tests, prototypes). Same interface and invariants as the PostgreSQL store (see errors.mjs STORE_METHODS).
// Transactions are serialised (a mutex) and roll back by restoring a snapshot of the state when fn throws.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { newServerKey } from '../crypto.mjs'
import { StoreConflict, triggerRef } from './errors.mjs'

const clone = (v) => structuredClone(v)
const LIVE_CARD = ['issued', 'locked']
const DEFAULT_CONNECTOR_STATE = Object.freeze({ stopped: false, stoppedBy: null, stoppedAt: null, eventCursor: 0, cronMinute: null })
const connectorOut = (c) => ({
  id: c.id, connector: clone(c.connector), hasSecret: Boolean(c.sealed), secretHint: c.sealed ? c.hint : null, updatedBy: c.updatedBy ?? null, updatedAt: c.updatedAt ? new Date(c.updatedAt) : null,
})

/** createMemoryStore({ now?: () => Date, serverKey?: hex }) */
export function createMemoryStore({ now = () => new Date(), serverKey = newServerKey() } = {}) {
  let state = {
    hits: [], audit: [], identities: [], linkCodes: [], personalBots: [], tickets: [], delegations: [],
    events: [], eventSeq: 0, prefs: {}, deliveries: [], approvalDeliveries: [], reports: [], proposals: [], aiProfiles: [], attachmentSettings: null,
    connectors: [], connectorRules: [], connectorRuns: [], connectorRunSeq: 0, connectorState: null,
  }
  const t0 = () => now().getTime()
  const at = () => new Date(t0())
  const live = (row) => !row.revokedAt && new Date(row.expiresAt).getTime() > t0()
  const out = (row) => (row ? clone(row) : null)

  const core = {
    async getServerKey() { return Buffer.from(serverKey, 'hex') },

    // ------------------------------------------------------------ throttles / audit
    async countHits(bucket, key, minutes) {
      const since = t0() - minutes * 60_000
      return state.hits.filter((h) => h.bucket === bucket && h.key === key && h.at > since).length
    },
    async countBucket(bucket, minutes) {
      const since = t0() - minutes * 60_000
      return state.hits.filter((h) => h.bucket === bucket && h.at > since).length
    },
    async addHit(bucket, key) { state.hits.push({ bucket, key: String(key), at: t0() }) },
    async pruneHits(olderThanMinutes = 1440) { state.hits = state.hits.filter((h) => h.at >= t0() - olderThanMinutes * 60_000) },
    async audit({ actor, action, target = null, detail = {} }) {
      state.audit.push({ id: state.audit.length + 1, at: at(), actor: String(actor), action, target, detail: clone(detail) })
    },
    async listAudit({ action, limit = 1000 } = {}) {
      return clone(state.audit.filter((a) => !action || a.action === action).slice(-limit))
    },

    // ------------------------------------------------------------ identities
    async findActiveIdentity({ platform, teamId = '', externalId }) {
      return out(state.identities.find((i) => !i.unlinkedAt && i.platform === platform && i.teamId === (teamId ?? '') && i.externalId === externalId))
    },
    async getIdentity(id) { return out(state.identities.find((i) => i.id === id)) },
    async listIdentities(userId, { platforms = null } = {}) {
      return clone(state.identities.filter((i) => !i.unlinkedAt && i.userId === String(userId) && (!platforms || platforms.includes(i.platform))))
    },
    async listActiveIdentities() { return clone(state.identities.filter((i) => !i.unlinkedAt)) },
    async insertIdentity({ userId, platform, teamId = '', externalId, botId = null, method = 'link_code' }) {
      if (state.identities.some((i) => !i.unlinkedAt && i.platform === platform && i.teamId === (teamId ?? '') && i.externalId === externalId)) throw new StoreConflict('bridge_identity_active')
      const row = { id: randomUUID(), userId: String(userId), platform, teamId: teamId ?? '', externalId, botId, method, verifiedAt: at(), createdAt: at(), unlinkedAt: null }
      state.identities.push(row)
      return out(row)
    },
    async unlinkIdentity(id) {
      const row = state.identities.find((i) => i.id === id && !i.unlinkedAt)
      if (row) row.unlinkedAt = at()
      return Boolean(row)
    },

    // ------------------------------------------------------------ link codes
    async insertLinkCode({ userId, codeHash, expiresAt }) {
      if (state.linkCodes.some((l) => l.codeHash === codeHash && !l.usedAt && !l.revokedAt)) throw new StoreConflict('bridge_link_code_live')
      const row = { id: randomUUID(), userId: String(userId), codeHash, createdAt: at(), expiresAt: new Date(expiresAt), usedAt: null, revokedAt: null }
      state.linkCodes.push(row)
      return out(row)
    },
    async revokeLiveLinkCodes(userId) {
      for (const l of state.linkCodes) if (l.userId === String(userId) && !l.usedAt && !l.revokedAt) l.revokedAt = at()
    },
    async findLiveLinkCode(codeHash) { return out(state.linkCodes.find((l) => l.codeHash === codeHash && !l.usedAt && !l.revokedAt)) },
    async markLinkCodeUsed(id) { const l = state.linkCodes.find((x) => x.id === id); if (l) l.usedAt = at() },
    async revokeLinkCode(id) { const l = state.linkCodes.find((x) => x.id === id); if (l && !l.revokedAt) l.revokedAt = at() },

    // ------------------------------------------------------------ personal bots
    async getPersonalBot(platform, botId) { return out(state.personalBots.find((b) => b.platform === platform && b.botId === botId)) },
    async insertPersonalBot({ userId, platform, botId }) {
      if (state.personalBots.some((b) => b.platform === platform && b.botId === botId)) throw new StoreConflict('bridge_personal_bot_unique')
      const row = { id: randomUUID(), userId: String(userId), platform, botId, createdAt: at(), revokedAt: null }
      state.personalBots.push(row)
      return out(row)
    },
    async listPersonalBots(userId) { return clone(state.personalBots.filter((b) => b.userId === String(userId) && !b.revokedAt)) },
    async revokePersonalBot({ platform, botId, userId }) {
      const b = state.personalBots.find((x) => x.platform === platform && x.botId === botId && x.userId === String(userId) && !x.revokedAt)
      if (b) b.revokedAt = at()
      return Boolean(b)
    },

    // ------------------------------------------------------------ assistant tickets / delegations
    async insertTicket({ tokenHash, userId, sessionId, expiresAt }) {
      const row = { id: randomUUID(), tokenHash, userId: String(userId), sessionId: String(sessionId), createdAt: at(), expiresAt: new Date(expiresAt), revokedAt: null }
      state.tickets.push(row)
      return out(row)
    },
    async findLiveTicket(tokenHash) { return out(state.tickets.find((x) => x.tokenHash === tokenHash && live(x))) },
    async getTicket(id) { return out(state.tickets.find((x) => x.id === id)) },
    async revokeTicketsBySession(sessionId) { for (const x of state.tickets) if (x.sessionId === String(sessionId) && !x.revokedAt) x.revokedAt = at() },
    async insertDelegation({ tokenHash, userId, identityId = null, sessionId = null, ticketId = null, sourceEventId = null, expiresAt }) {
      const row = {
        id: randomUUID(), tokenHash, userId: String(userId), identityId, sessionId: sessionId === null ? null : String(sessionId), ticketId,
        sourceEventId: sourceEventId === null ? null : Number(sourceEventId), createdAt: at(), expiresAt: new Date(expiresAt), revokedAt: null,
      }
      state.delegations.push(row)
      return out(row)
    },
    async findLiveDelegation(tokenHash) { return out(state.delegations.find((x) => x.tokenHash === tokenHash && live(x))) },
    async revokeDelegationsByIdentity(identityId) { for (const x of state.delegations) if (x.identityId === identityId && !x.revokedAt) x.revokedAt = at() },
    async revokeDelegationsByUser(userId) { for (const x of state.delegations) if (x.userId === String(userId) && !x.revokedAt) x.revokedAt = at() },

    // ------------------------------------------------------------ events (outbox)
    async insertEvent({ type, aggregateType, aggregateId, payload }) {
      state.eventSeq += 1
      state.events.push({ id: state.eventSeq, type, aggregateType, aggregateId: String(aggregateId), payload: clone(payload), createdAt: at() })
      return state.eventSeq
    },
    async listEvents(after = 0, limit = 100) { return clone(state.events.filter((e) => e.id > after).slice(0, limit)) },
    async getEvent(id) { return out(state.events.find((e) => e.id === Number(id))) },
    async latestEventId() { return state.events.at(-1)?.id ?? 0 },

    // ------------------------------------------------------------ notification preferences / deliveries
    async getPrefs(userId) { return out(state.prefs[String(userId)] ?? null) },
    async putPrefs(userId, { types, quietHours }) {
      state.prefs[String(userId)] = { userId: String(userId), types: clone(types), quietHours: clone(quietHours), updatedAt: at() }
      return out(state.prefs[String(userId)])
    },
    async getDelivery(eventId, userId) { return out(state.deliveries.find((d) => d.eventId === Number(eventId) && d.userId === String(userId))) },
    async insertDeliveryIfAbsent({ eventId, userId, channel = null }) {
      if (state.deliveries.some((d) => d.eventId === Number(eventId) && d.userId === String(userId))) return false
      state.deliveries.push({ eventId: Number(eventId), userId: String(userId), status: 'pending', channel, messageRef: null, errorCode: null, resolvedAt: at(), updatedAt: at() })
      return true
    },
    async updateDelivery(eventId, userId, { status, messageRef = null, errorCode = null, channel = null }) {
      const d = state.deliveries.find((x) => x.eventId === Number(eventId) && x.userId === String(userId))
      if (!d) return false
      Object.assign(d, { status, messageRef: messageRef ?? d.messageRef, errorCode, channel: channel ?? d.channel, updatedAt: at() })
      return true
    },

    // ------------------------------------------------------------ approval card deliveries
    async findLiveApprovalDelivery(approvalId, userId) {
      return out(state.approvalDeliveries.find((d) => d.approvalId === String(approvalId) && d.userId === String(userId) && LIVE_CARD.includes(d.status)))
    },
    async insertApprovalDelivery({ id, approvalId, userId, identityId, tokenHash, expiresAt }) {
      if (state.approvalDeliveries.some((d) => d.approvalId === String(approvalId) && d.userId === String(userId) && LIVE_CARD.includes(d.status))) throw new StoreConflict('bridge_approval_delivery_live')
      if (state.approvalDeliveries.some((d) => d.tokenHash === tokenHash)) throw new StoreConflict('bridge_approval_delivery_token')
      const row = { id, approvalId: String(approvalId), userId: String(userId), identityId, tokenHash, status: 'issued', wrongAttempts: 0, messageRef: null, sentAt: null, expiresAt: new Date(expiresAt), createdAt: at() }
      state.approvalDeliveries.push(row)
      return out(row)
    },
    async markApprovalDeliverySent(id, approvalId, messageRef) {
      const d = state.approvalDeliveries.find((x) => x.id === id && x.approvalId === String(approvalId))
      if (!d) return null
      Object.assign(d, { messageRef, sentAt: at() })
      return out(d)
    },
    async findApprovalDeliveryByToken(approvalId, tokenHash) { return out(state.approvalDeliveries.find((d) => d.approvalId === String(approvalId) && d.tokenHash === tokenHash)) },
    async latestApprovalDeliveryFor(approvalId, userId) {
      return out(state.approvalDeliveries.filter((d) => d.approvalId === String(approvalId) && d.userId === String(userId)).at(-1))
    },
    async getApprovalDelivery(id) { return out(state.approvalDeliveries.find((d) => d.id === id)) },
    async listIssuedApprovalDeliveriesOfUser(userId) { return clone(state.approvalDeliveries.filter((d) => d.userId === String(userId) && d.status === 'issued')) },
    async countWrongReplyCode(id, max) {
      const d = state.approvalDeliveries.find((x) => x.id === id && x.status === 'issued')
      if (!d) return 'locked'
      d.wrongAttempts += 1
      if (d.wrongAttempts >= max) d.status = 'locked'
      return d.status
    },
    async setApprovalDeliveryStatus(id, status) { const d = state.approvalDeliveries.find((x) => x.id === id); if (d) d.status = status },
    async revokeApprovalDeliveries({ approvalId, exceptId = null }) {
      for (const d of state.approvalDeliveries) if (d.approvalId === String(approvalId) && LIVE_CARD.includes(d.status) && d.id !== exceptId) d.status = 'revoked'
    },
    async revokeApprovalDeliveriesByIdentity(identityId) {
      for (const d of state.approvalDeliveries) if (d.identityId === identityId && LIVE_CARD.includes(d.status)) d.status = 'revoked'
    },

    // ------------------------------------------------------------ reports
    async insertReport({ kind, date, slot, sections, attention = 0, test = false, createdBy = null }) {
      if (!test && state.reports.some((r) => !r.test && r.kind === kind && r.date === date && r.slot === slot)) return null
      const row = { id: randomUUID(), kind, date, slot, sections: clone(sections), attention, test, createdBy, generatedAt: at() }
      state.reports.push(row)
      return out(row)
    },
    async latestReport(kind) { return out(state.reports.filter((r) => r.kind === kind).at(-1)) },

    // ------------------------------------------------------------ proposals
    async insertProposal({ kind, payload, confidence = null, forUserId = null, createdVia }) {
      const row = { id: randomUUID(), kind, payload: clone(payload), status: 'pending_review', confidence, forUserId: forUserId === null ? null : String(forUserId), createdVia, createdAt: at(), decidedBy: null, decidedAt: null, comment: null }
      state.proposals.push(row)
      return out(row)
    },
    async listProposals({ forUserId = null, status = null, kind = null, limit = 200 } = {}) {
      return clone(state.proposals
        .filter((p) => (forUserId === null || p.forUserId === String(forUserId)) && (!status || p.status === status) && (!kind || p.kind === kind))
        .slice().reverse().slice(0, limit))
    },
    async getProposal(id) { return out(state.proposals.find((p) => p.id === id)) },
    async decideProposal(id, { status, decidedBy, comment = null }) {
      const p = state.proposals.find((x) => x.id === id)
      if (!p) return null
      Object.assign(p, { status, decidedBy: String(decidedBy), decidedAt: at(), comment })
      return out(p)
    },

    // ------------------------------------------------------------ the AI employee's profile (versions; current = the highest)
    async insertAiProfileVersion({ profile, updatedBy = null, reason = null }) {
      const version = (state.aiProfiles.at(-1)?.version ?? 0) + 1
      const row = { version, profile: clone(profile), updatedBy: updatedBy === null ? null : String(updatedBy), reason, createdAt: at() }
      state.aiProfiles.push(row)
      return out(row)
    },
    async latestAiProfile() { return out(state.aiProfiles.at(-1)) },
    async getAiProfileVersion(version) { return out(state.aiProfiles.find((p) => p.version === Number(version))) },
    async listAiProfileVersions({ limit = 20 } = {}) {
      return state.aiProfiles.slice().reverse().slice(0, limit).map(({ version, updatedBy, reason, createdAt }) => ({ version, updatedBy, reason, createdAt: new Date(createdAt) }))
    },

    // ------------------------------------------------------------ attachments in the AI assistant panel (one row of settings)
    async getAttachmentSettings() { return out(state.attachmentSettings) },
    async putAttachmentSettings({ roles, types, updatedBy = null }) {
      state.attachmentSettings = { roles: [...roles], types: [...types], updatedBy: updatedBy === null ? null : String(updatedBy), updatedAt: at() }
      return out(state.attachmentSettings)
    },

    // ------------------------------------------------------------ external connectors (definitions, sealed secrets, rules, runs, state)
    async listConnectors() { return state.connectors.slice().sort((a, b) => a.id.localeCompare(b.id)).map(connectorOut) },
    async getConnector(id) { const c = state.connectors.find((x) => x.id === String(id)); return c ? connectorOut(c) : null },
    async putConnector({ connector, updatedBy = null }) {
      let c = state.connectors.find((x) => x.id === connector.id)
      if (!c) { c = { id: connector.id, sealed: null, hint: null }; state.connectors.push(c) }
      Object.assign(c, { connector: clone(connector), updatedBy: updatedBy === null ? null : String(updatedBy), updatedAt: at() })
      return connectorOut(c)
    },
    async deleteConnector(id) {
      const n = state.connectors.length
      state.connectors = state.connectors.filter((x) => x.id !== String(id))
      return state.connectors.length < n
    },
    async getConnectorSecret(id) {
      const c = state.connectors.find((x) => x.id === String(id))
      return c?.sealed ? { sealed: c.sealed, hint: c.hint } : null
    },
    async setConnectorSecret(id, { sealed = null, hint = null, updatedBy = null } = {}) {
      const c = state.connectors.find((x) => x.id === String(id))
      if (!c) return false
      Object.assign(c, { sealed, hint: sealed ? hint : null, updatedBy: updatedBy === null ? null : String(updatedBy), updatedAt: at() })
      return true
    },
    async listConnectorRules() { return state.connectorRules.slice().sort((a, b) => a.id.localeCompare(b.id)).map(clone) },
    async getConnectorRule(id) { return out(state.connectorRules.find((x) => x.id === String(id))) },
    async putConnectorRule({ rule, updatedBy = null }) {
      const row = { id: rule.id, rule: clone(rule), updatedBy: updatedBy === null ? null : String(updatedBy), updatedAt: at() }
      state.connectorRules = [...state.connectorRules.filter((x) => x.id !== rule.id), row]
      return out(row)
    },
    async deleteConnectorRule(id) {
      const n = state.connectorRules.length
      state.connectorRules = state.connectorRules.filter((x) => x.id !== String(id))
      return state.connectorRules.length < n
    },
    async insertConnectorRun({ ruleId = null, connectorId, operationId, trigger = { kind: 'manual' }, actor = null, status, code = null, httpStatus = null, durationMs = null, proposalId = null }) {
      state.connectorRunSeq += 1
      const row = {
        id: state.connectorRunSeq, ruleId, connectorId, operationId, triggerKind: trigger.kind, triggerRef: triggerRef(trigger), actor: actor === null ? null : String(actor),
        status, code, httpStatus, durationMs, proposalId, createdAt: at(),
      }
      state.connectorRuns.push(row)
      return out(row)
    },
    async listConnectorRuns({ limit = 50, connectorId = null, ruleId = null } = {}) {
      return state.connectorRuns.filter((r) => (!connectorId || r.connectorId === connectorId) && (!ruleId || r.ruleId === ruleId)).slice(-limit).reverse().map(clone)
    },
    async getConnectorState() { return { ...DEFAULT_CONNECTOR_STATE, ...(state.connectorState ? clone(state.connectorState) : {}) } },
    async putConnectorState(patch) {
      state.connectorState = { ...DEFAULT_CONNECTOR_STATE, ...(state.connectorState ?? {}), ...clone(patch) }
      return clone(state.connectorState)
    },

    // ------------------------------------------------------------ "time passes" (tests / conformance fixtures)
    async expireLinkCodes(userId) {
      for (const l of state.linkCodes) if (l.userId === String(userId) && !l.usedAt && !l.revokedAt) l.expiresAt = new Date(t0() - 1000)
    },
    async expireDelegation(tokenHash) { for (const d of state.delegations) if (d.tokenHash === tokenHash) d.expiresAt = new Date(t0() - 1000) },
  }

  // transactions: serialised; a failure restores the snapshot taken at the start. Calls made inside a transaction's async
  // context (t.x or store.x) run directly; calls from elsewhere wait for the running transaction (no lost updates on rollback).
  const als = new AsyncLocalStorage()
  let chain = Promise.resolve()
  const enqueue = (run) => {
    const result = chain.then(run, run)
    chain = result.then(() => {}, () => {})
    return result
  }
  function tx(fn) {
    if (als.getStore()) return fn({ ...core, db: null, inTransaction: true }) // nested: part of the outer transaction
    return enqueue(() => als.run(true, async () => {
      const snapshot = clone(state)
      try {
        return await fn({ ...core, db: null, inTransaction: true })
      } catch (error) {
        state = snapshot
        throw error
      }
    }))
  }

  // outside a transaction every call is its own unit
  const store = { kind: 'memory', tx, async close() {}, inTransaction: false }
  for (const [name, fn] of Object.entries(core)) {
    store[name] = (...args) => (als.getStore() ? fn(...args) : enqueue(() => fn(...args)))
  }
  store.db = null
  return store
}
