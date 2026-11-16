// care fork (S1): "create only" binds. A personal-bot page must never take over an existing bot by binding the same
// platform credentials again (bot ids are derived from the platform identity). With `createOnly: true` a bind / QR
// activation whose bot identity already exists changes nothing and fails with code `bot-exists`.
import { t } from './i18n.mjs';

export const BOT_EXISTS = 'bot-exists';
export const BOT_EXISTS_MESSAGE = '该账号已接入为机器人，未作任何更改。';

/** `createOnly` is optional; when present it must be a boolean. */
export function validCreateOnly(value) {
  return value === undefined || typeof value === 'boolean';
}

export function botExistsError(botId) {
  const error = new Error(t(BOT_EXISTS_MESSAGE));
  error.code = BOT_EXISTS;
  if (botId) error.botId = botId;
  return error;
}

/** Throws bot-exists when createOnly is true and any of the lookups found an existing bot. */
export function assertCreatable(createOnly, ...existing) {
  if (createOnly !== true) return;
  const found = existing.find(Boolean);
  if (found) throw botExistsError(typeof found === 'object' ? found.botId : undefined);
}

export function isBotExists(error) {
  return error?.code === BOT_EXISTS;
}

/** The public RPC error for a bot-exists failure (no details: nothing went wrong on the platform side). */
export function botExistsPublicError() {
  return { code: BOT_EXISTS, message: t(BOT_EXISTS_MESSAGE), details: {} };
}

export function botExistsResult() {
  return { ok: false, error: botExistsPublicError() };
}
