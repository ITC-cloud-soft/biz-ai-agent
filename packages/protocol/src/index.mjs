// @dsh-bridge/protocol: Bridge protocol v1 (OpenAPI, manifest / event schemas), validators and helpers.
export { parseYaml, parseDocument, YamlError } from './yaml.mjs'
export { validateSchema, formatErrors, resolveRef } from './jsonschema.mjs'
export {
  validateManifest, INTERNAL_EVENTS, loadManifestSchema, loadEventEnvelopeSchema, loadManifestFile, eventPayloadKeys,
} from './manifest.mjs'
export { validateEvent, validateEventPage, checkPayloadWhitelist } from './events.mjs'
export { checkNotificationParams, checkNotificationLink } from './notify.mjs'
export { findPiiInString, isPiiLikeKey, probeHits, scanJson } from './pii.mjs'
export {
  AI_PROFILE_TONES, AI_PROFILE_TONE_LABEL, AI_PROFILE_LIMITS, RULE_OVERRIDE_PATTERNS, normalizeAiProfile, validateAiProfile, aiProfileFor,
} from './ai-profile.mjs'
export {
  CONNECTOR_KINDS, CONNECTOR_AUTH_TYPES, CONNECTOR_PII, CONNECTOR_PII_HIGH, OPERATION_EFFECTS, OPERATION_METHODS, RULE_MODES, CONDITION_OPS, RULE_NOTIFY,
  INPUT_TYPES, RUN_STATUSES, CONNECTOR_LIMITS, CONNECTOR_ID_RE, RULE_DATA_ROOTS, connectorHostOf, validateOperation, validateConnector, validateRule, parseCron,
  cronMatches, valueAt, evaluateWhen, renderRuleInput, checkOperationInput, buildOperationRequest, pickResponseFields, connectorToolName,
} from './connectors.mjs'
export {
  DEFAULT_OPENAPI_FILE, PROTOCOL_HEADER, loadOpenApi, basePath, listOperations, compileTemplate, matchOperation, aliasTable, applyAliasTable, ALIAS_EXTENSION, pickAlias,
  fillTemplate, aliasTableMarkdown, lintOpenApi, validateAgainst, responseSchema,
} from './openapi.mjs'

export const PROTOCOL_VERSION = 1
