// care fork: LINE Messaging API client (reply / push / bot info / loading
// animation) and webhook signature verification. Node built-ins only.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { createRateLimiter, fetchJson, isRetryable, withRetry } from '../shared/rest-client.mjs';

export const LINE_API_BASE = 'https://api.line.me';
export const LINE_TEXT_LIMIT = 5000;
export const LINE_MESSAGES_PER_REQUEST = 5;

/**
 * Verify `X-Line-Signature`: base64(HMAC-SHA256(channelSecret, raw body)),
 * compared in constant time. The raw request bytes must be used, not a
 * re-serialized JSON value.
 */
export function verifyLineSignature(channelSecret, rawBody, signature) {
  if (typeof channelSecret !== 'string' || !channelSecret) return false;
  const header = Array.isArray(signature) ? signature[0] : signature;
  if (typeof header !== 'string' || !header || header.length > 128) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expected = createHmac('sha256', channelSecret).update(body).digest();
  let provided;
  try {
    provided = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) {
    // Keep the comparison cost independent of where the mismatch is.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/** Sign a body the way LINE does (tests and local tools). */
export function signLineBody(channelSecret, rawBody) {
  return createHmac('sha256', channelSecret).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')).digest('base64');
}

/** A deterministic UUID (X-Line-Retry-Key) for one idempotency key. */
export function lineRetryKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) return randomUUID();
  const hex = createHash('sha256').update(`dsh-im:line:${idempotencyKey}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function lineError(error) {
  if (error?.status === 401) error.code = 'line-401';
  else if (error?.status === 403) error.code = 'line-403';
  return error;
}

export class LineApi {
  #token;
  #base;
  #fetch;
  #limiter;
  #retries;
  #sleep;
  #logger;

  constructor({
    channelAccessToken, baseUrl = LINE_API_BASE, fetchImpl = globalThis.fetch,
    ratePerSecond = 30, retries = 3, sleep, logger = console,
  } = {}) {
    if (typeof channelAccessToken !== 'string' || !channelAccessToken) throw new TypeError('LINE channel access token is required');
    this.#token = channelAccessToken;
    this.#base = String(baseUrl).replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#limiter = createRateLimiter({ perSecond: ratePerSecond, ...(sleep ? { sleep } : {}) });
    this.#retries = retries;
    this.#sleep = sleep;
    this.#logger = logger;
  }

  async #call(method, path, { body, headers = {}, signal, retryable = isRetryable } = {}) {
    return withRetry(async () => {
      await this.#limiter.take(signal);
      try {
        return await fetchJson(`${this.#base}${path}`, {
          method, body, signal, fetchImpl: this.#fetch, prefix: 'line',
          headers: { authorization: `Bearer ${this.#token}`, ...headers },
        });
      } catch (error) {
        throw lineError(error);
      }
    }, {
      retries: this.#retries, retryable, signal, ...(this.#sleep ? { sleep: this.#sleep } : {}),
      onRetry: (error, attempt, delay) => this.#logger.warn?.(`[dsh-im:line] ${method} ${path} retry ${attempt + 1} in ${delay}ms (${error?.status ?? error?.code})`),
    });
  }

  async getBotInfo({ signal } = {}) {
    return (await this.#call('GET', '/v2/bot/info', { signal })).body;
  }

  /**
   * Reply with a one-shot reply token. Only a rate-limit rejection is retried:
   * a 5xx may have been delivered, and the token cannot be reused anyway.
   */
  async reply({ replyToken, messages, signal }) {
    const result = await this.#call('POST', '/v2/bot/message/reply', {
      body: { replyToken, messages },
      signal,
      retryable: (error) => Number(error?.status) === 429,
    });
    return result.body ?? {};
  }

  /**
   * Push messages. Every attempt carries the same `X-Line-Retry-Key`, so a
   * retry after an ambiguous failure is delivered at most once; LINE answers a
   * repeated key with 409, which counts as delivered.
   */
  async push({ to, messages, retryKey = randomUUID(), signal }) {
    try {
      const result = await this.#call('POST', '/v2/bot/message/push', {
        body: { to, messages },
        headers: { 'x-line-retry-key': retryKey },
        signal,
      });
      return { ...(result.body ?? {}), retryKey };
    } catch (error) {
      if (Number(error?.status) === 409) return { ...(error.body ?? {}), retryKey, duplicate: true };
      throw error;
    }
  }

  async startLoading({ chatId, loadingSeconds = 20, signal }) {
    await this.#call('POST', '/v2/bot/chat/loading/start', {
      body: { chatId, loadingSeconds },
      signal,
      retryable: () => false,
    });
  }
}

/** Validate the access token and read the bot identity. */
export async function inspectLineCredentials({ channelAccessToken }, { createApi = (options) => new LineApi(options), signal } = {}) {
  const api = createApi({ channelAccessToken, retries: 1 });
  const info = await api.getBotInfo({ signal });
  const userId = typeof info?.userId === 'string' ? info.userId : '';
  if (!/^U[0-9a-f]{32}$/i.test(userId)) throw Object.assign(new Error('LINE returned an invalid bot identity'), { code: 'line-invalid-identity' });
  return {
    platformId: userId,
    name: typeof info.displayName === 'string' && info.displayName.trim() ? info.displayName.trim() : 'LINE Bot',
    username: typeof info.basicId === 'string' ? info.basicId : null,
  };
}
