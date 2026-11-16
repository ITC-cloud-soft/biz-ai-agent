// care fork: machine-readable reasons for management RPC input-validation failures.
//
// A rejected payload keeps `code: 'bad-request'` (callers and upstream tests rely on
// it) and adds `reason` (one of VALIDATION_REASONS) plus `field` when one input is to
// blame. `message` is the Chinese source sentence for the reason, which the client
// dictionaries (en / ru, and ja via @care/dsh-lang-ja) translate; a client may also
// map `reason` itself (validationMessage). See CARE_FORK.md「入力検証エラー」.

export const VALIDATION_MESSAGES = Object.freeze({
  'invalid-payload': '请求内容无效，请刷新页面后重试。',
  'missing-field': '请填写所有必填项。',
  'invalid-bot-token': 'Bot Token 格式不正确，请检查后重新填写。',
  'invalid-app-token': 'App Token 格式不正确（应以 xapp- 开头），请检查后重新填写。',
  'invalid-credential': '凭据格式不正确，请检查填写的内容。',
  'invalid-bot-id': '机器人 ID 无效，请刷新页面后重试。',
  'confirmation-required': '请先确认再执行此操作。',
  'invalid-attempt': '接入流程已失效，请重新开始。',
  'invalid-verification-code': '请输入 4 到 8 位数字配对码。',
});

/** `invalid-setting` carries the host's own (already translatable) Chinese message. */
export const VALIDATION_REASONS = Object.freeze([...Object.keys(VALIDATION_MESSAGES), 'invalid-setting']);

const HAN = /\p{Script=Han}/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function blank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * The Chinese source sentence for a reason, or null when the reason has none of its
 * own (`invalid-setting`, unknown values).
 */
export function validationMessage(reason) {
  return typeof reason === 'string' && Object.hasOwn(VALIDATION_MESSAGES, reason)
    ? VALIDATION_MESSAGES[reason]
    : null;
}

/**
 * Check credential fields in order: unknown keys first, then each field missing
 * (`missing-field`) or malformed (`reason`, default `invalid-credential`).
 *
 * @param payload - the RPC payload.
 * @param fields - `[{ name, valid(value) → boolean, reason?, optional? }]`.
 * @param extraKeys - keys accepted without a check of their own.
 * @returns `{ reason, field? }` or null.
 */
export function credentialFailure(payload, fields, extraKeys = []) {
  if (!isRecord(payload)) return { reason: 'invalid-payload' };
  const allowed = new Set([...fields.map((entry) => entry.name), ...extraKeys]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) return { reason: 'invalid-payload' };
  for (const { name, valid, reason = 'invalid-credential', optional = false } of fields) {
    const value = payload[name];
    if (blank(value)) {
      if (optional) continue;
      return { reason: 'missing-field', field: name };
    }
    if (!valid(value)) return { reason, field: name };
  }
  return null;
}

function derivedFailure(message, { endpoint, payload, credentials } = {}) {
  if (typeof endpoint === 'string' && /(?:^|\.)bind(?:-credentials)?$/u.test(endpoint) && credentials) {
    const found = typeof credentials === 'function' ? credentials(payload) : credentialFailure(payload, credentials);
    if (found) return found;
  }
  if (typeof message === 'string' && HAN.test(message)) return { reason: 'invalid-setting', message };
  const text = typeof message === 'string' ? message : '';
  const record = isRecord(payload);
  const validRef = (value) => typeof value === 'string' && ID.test(value);
  const onlyKeys = (allowed) => record && Object.keys(payload).every((key) => allowed.includes(key));
  // The channel's own validator already rejected the payload; what is left to find
  // out is which part. A botId that passes the generic shape can still miss the
  // channel's own pattern (`slack_<hex>` …), so it is the last suspect.
  if (record && endpoint === 'provision.verify') {
    if (!validRef(payload.attemptId)) return { reason: 'invalid-attempt', field: 'attemptId' };
    return { reason: 'invalid-verification-code', field: 'verifyCode' };
  }
  // Also reached without a payload: "The provisioning attempt no longer exists."
  if (/attemptId|provisioning attempt/iu.test(text)) return { reason: 'invalid-attempt', field: 'attemptId' };
  if (!record) return { reason: 'invalid-payload' };
  if (endpoint === 'bot.delete') {
    if (!onlyKeys(['botId', 'confirm'])) return { reason: 'invalid-payload' };
    if (payload.confirm !== true && validRef(payload.botId)) return { reason: 'confirmation-required', field: 'confirm' };
    return { reason: 'invalid-bot-id', field: 'botId' };
  }
  if (endpoint === 'bot.reconnect') {
    if (!onlyKeys(['botId', 'sendTest'])) return { reason: 'invalid-payload' };
    if (payload.sendTest !== undefined && typeof payload.sendTest !== 'boolean') return { reason: 'invalid-payload' };
    return { reason: 'invalid-bot-id', field: 'botId' };
  }
  if (/\bbotId\b/u.test(text) && !validRef(payload.botId)) return { reason: 'invalid-bot-id', field: 'botId' };
  return { reason: 'invalid-payload' };
}

/**
 * The `error` object of a rejected payload.
 *
 * @param failure - what the channel's validator returned: a legacy message string, or
 *   `{ reason, field?, message? }`.
 * @param context - `{ endpoint, payload, credentials }`; `credentials` (a field list for
 *   credentialFailure, or a function returning `{ reason, field }`) refines failures of
 *   the bind endpoint.
 * @param extra - further error properties (e.g. `details`).
 */
export function validationError(failure, context = {}, extra = {}) {
  const found = isRecord(failure) && typeof failure.reason === 'string'
    ? failure
    : derivedFailure(failure, context);
  const reason = VALIDATION_REASONS.includes(found.reason) ? found.reason : 'invalid-payload';
  const message = validationMessage(reason)
    ?? (typeof found.message === 'string' && found.message ? found.message
      : typeof failure === 'string' && failure ? failure : VALIDATION_MESSAGES['invalid-payload']);
  return {
    code: 'bad-request',
    reason,
    ...(typeof found.field === 'string' ? { field: found.field } : {}),
    message,
    ...extra,
  };
}

/** `{ ok: false, error }` for a rejected payload (see validationError). */
export function validationRejected(failure, context, extra) {
  return { ok: false, error: validationError(failure, context, extra) };
}
