// @dsh-bridge/server-kit — Node parts for a business system that implements the DSH Business Bridge protocol v1.
export { createBridgeApp, listen } from './app.mjs'
export { registerAliasRoutes, aliasTableFromOpenApi, pickAlias, fillTemplate, camelRows, DEFAULT_PARAM_KINDS } from './alias.mjs'
export {
  HttpError, fail, baseHeaders, sendJson, sendError, readBody, createRouter, compilePath, strictKeys, optString, parseSource, isObject, header, iso,
  MAX_BODY_BYTES, PLATFORM_RE, UUID_RE, DATE_RE, TIME_RE, PROTOCOL_HEADER,
} from './http.mjs'
export { POLICY, gate, createPrincipalResolver, readToolPolicy, userRef } from './gate.mjs'
export {
  sha256, hmac, newToken, sixDigits, safeEqual, hashPassword, verifyPassword, DUMMY_PASSWORD_HASH, linkCodeHash, cardToken, cardReplyCode, newServerKey, TOKEN_PREFIX,
} from './crypto.mjs'
export { loadManifest, etagMatches, notifiableTypes, aiAllowlist, manifestRoles, reportDecl, cronToSlot } from './manifest.mjs'
export { createEventWriter, checkEvent, EventRejected, eventJson } from './events.mjs'
export { localParts, todayIn, addDays, daysBetween, isValidDate } from './time.mjs'
export { startScheduler } from './scheduler.mjs'
export { createMemoryStore } from './store/memory.mjs'
export { createPostgresStore } from './store/postgres.mjs'
export { StoreConflict, STORE_METHODS } from './store/errors.mjs'
export {
  loadPg, databaseName, ensureDatabase, dropDatabase, createPool, withTransaction, migrate, readMigrations, bridgeMigrations, MAINTENANCE_DATABASES,
} from './store/pg.mjs'
export { createMysqlStore } from './store/mysql.mjs'
export {
  loadMysql, mysqlConnectionOptions, createMysqlPool, ensureMysqlDatabase, dropMysqlDatabase, withMysqlTransaction, migrateMysql, splitSqlStatements,
  bridgeMysqlMigrations, MYSQL_SYSTEM_DATABASES,
} from './store/mysqldb.mjs'
export { preferencesOf, DEFAULT_QUIET_HOURS } from './routes/notify.mjs'
export { identityOf, LINK_CODE_TTL_MINUTES, PERSONAL_BOT_PLATFORMS, canonicalPlatform } from './routes/identity.mjs'
export { DELEGATION_TTL_MS, TICKET_TTL_MS, EVENT_DELEGATION_MAX_AGE_HOURS, createEventDelegationRules } from './routes/delegation.mjs'
export { MAX_WRONG_REPLY_CODES } from './routes/approvals.mjs'
export { proposalJson, reportJson } from './routes/misc.mjs'
export { aiProfileEtag, AI_PROFILE_REASON_MAX, AI_PROFILE_VERSIONS_SHOWN } from './routes/ai-profile.mjs'
export { defaultAttachmentRoles } from './routes/assistant-attachments.mjs'
export { checkDocumentReadResult, DOCUMENT_READ_LIMITS, DOCUMENT_READ_ERRORS } from './routes/document-reads.mjs'
export { createConnectorService, registerConnectors, CONNECTOR_WRITE_KIND, CONNECTOR_RUNS_SHOWN } from './routes/connectors.mjs'
