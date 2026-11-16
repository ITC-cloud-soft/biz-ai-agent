// @dsh-bridge/server-kit/connectors — external connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3): the runner, the
// secret sealing and the rule engine. Storage-free, so a business system with its own tables uses them too (server-kit's own
// routes are routes/connectors.mjs on the kit's store).
export { createConnectorRunner, RUN_CODES } from './runner.mjs'
export { connectorSecretKey, sealSecret, openSecret, secretHint, checkSecret, SECRET_FIELDS, SECRET_MAX } from './secrets.mjs'
export { createRuleEngine, ruleData, minuteKey } from './engine.mjs'
