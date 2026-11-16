// Errors every store implementation raises the same way.

/** A unique invariant was violated (a live link code with the same digits, an account linked twice, ...). */
export class StoreConflict extends Error {
  constructor(constraint) {
    super(`store conflict: ${constraint}`)
    this.name = 'StoreConflict'
    this.code = 'conflict'
    this.constraint = constraint
  }
}

/**
 * The store interface (memory.mjs and postgres.mjs implement it; test/store-contract.mjs runs the same tests on both).
 * Every method is async. `store.tx(fn)` runs fn(t) in one transaction; `t` has every method below plus `t.db`
 * (the pg client of the transaction, or null for the memory store) so the business can write its own tables in the
 * same transaction as its events. Methods marked (locks) take a row lock inside a transaction.
 */
export const STORE_METHODS = Object.freeze([
  'getServerKey',
  'countHits', 'countBucket', 'addHit', 'pruneHits',
  'audit', 'listAudit',
  'findActiveIdentity', 'getIdentity', 'listIdentities', 'listActiveIdentities', 'insertIdentity', 'unlinkIdentity',
  'insertLinkCode', 'revokeLiveLinkCodes', 'findLiveLinkCode' /* locks */, 'markLinkCodeUsed', 'revokeLinkCode',
  'getPersonalBot' /* locks */, 'insertPersonalBot', 'listPersonalBots', 'revokePersonalBot',
  'insertTicket', 'findLiveTicket', 'getTicket', 'revokeTicketsBySession',
  'insertDelegation', 'findLiveDelegation', 'revokeDelegationsByIdentity', 'revokeDelegationsByUser',
  'insertEvent', 'listEvents', 'getEvent', 'latestEventId',
  'getPrefs', 'putPrefs',
  'getDelivery' /* locks */, 'insertDeliveryIfAbsent', 'updateDelivery',
  'findLiveApprovalDelivery', 'insertApprovalDelivery', 'markApprovalDeliverySent', 'findApprovalDeliveryByToken' /* locks */,
  'latestApprovalDeliveryFor' /* locks */, 'getApprovalDelivery' /* locks */, 'listIssuedApprovalDeliveriesOfUser',
  'countWrongReplyCode', 'setApprovalDeliveryStatus', 'revokeApprovalDeliveries', 'revokeApprovalDeliveriesByIdentity',
  'insertReport', 'latestReport',
  'insertProposal', 'listProposals', 'getProposal' /* locks */, 'decideProposal',
  'insertAiProfileVersion', 'latestAiProfile', 'getAiProfileVersion', 'listAiProfileVersions',
  'getAttachmentSettings', 'putAttachmentSettings',
  'listConnectors', 'getConnector', 'putConnector', 'deleteConnector', 'getConnectorSecret', 'setConnectorSecret',
  'listConnectorRules', 'getConnectorRule', 'putConnectorRule', 'deleteConnectorRule', 'insertConnectorRun', 'listConnectorRuns',
  'getConnectorState', 'putConnectorState',
  'expireLinkCodes', 'expireDelegation', // "time passes" (tests / conformance fixtures only)
])

/** The reference of a run's trigger kept in the log: the event id, the cron minute, the proposal id (never any content). */
export const triggerRef = (t) => (t?.eventId ?? t?.minute ?? t?.proposalId ?? null) === null ? null : String(t.eventId ?? t.minute ?? t.proposalId)
