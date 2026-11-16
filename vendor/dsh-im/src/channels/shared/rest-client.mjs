// care fork: small HTTP helpers shared by the webhook channels (LINE, Teams):
// a JSON request with typed errors, a token-bucket rate limiter, and a retry
// loop that honours Retry-After. Node built-ins (global fetch) only.

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

export function restError(message, { code, status, providerCode, retryAfterMs, body } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status !== undefined) error.status = status;
  if (providerCode) error.providerCode = providerCode;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  if (body !== undefined) error.body = body;
  return error;
}

/** Parse Retry-After (seconds or an HTTP date) into milliseconds. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - now, 120_000));
}

/**
 * One JSON request. Resolves `{ status, body, headers }` for 2xx; throws an
 * Error with `status`, `providerCode`, `retryAfterMs` otherwise. Network
 * failures throw with `code` (`<prefix>-transport-error` / `<prefix>-timeout`).
 */
export async function fetchJson(url, {
  method = 'GET', headers = {}, body, form, signal, timeoutMs = 15_000, fetchImpl = globalThis.fetch, prefix = 'rest',
} = {}) {
  if (typeof fetchImpl !== 'function') throw restError('fetch is unavailable', { code: `${prefix}-transport-error` });
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const requestHeaders = { accept: 'application/json', ...headers };
  let payload;
  if (form) {
    payload = new URLSearchParams(form).toString();
    requestHeaders['content-type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['content-type'] = 'application/json; charset=utf-8';
  }
  let response;
  try {
    response = await fetchImpl(url, { method, headers: requestHeaders, body: payload, signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw restError(`${method} ${new URL(url).host} timed out`, { code: `${prefix}-timeout` });
    throw restError(`${method} ${new URL(url).host} failed: ${error?.message ?? error}`, {
      code: `${prefix}-transport-error`,
      providerCode: error?.cause?.code ?? error?.code,
    });
  }
  const text = await response.text().catch(() => '');
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (response.status >= 200 && response.status < 300) {
    return { status: response.status, body: parsed, headers: response.headers };
  }
  throw restError(`${method} ${new URL(url).pathname} returned HTTP ${response.status}`, {
    code: `${prefix}-${response.status}`,
    status: response.status,
    providerCode: parsed?.error?.code ?? parsed?.error ?? parsed?.message ?? undefined,
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    body: parsed ?? undefined,
  });
}

/** Retry on 429, 5xx and transient network errors (not on 4xx). */
export function isRetryable(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  const status = Number(error.status);
  if (status === 429 || status >= 500) return true;
  if (Number.isFinite(status) && status > 0) return false;
  return /-(transport-error|timeout)$/.test(String(error.code ?? ''))
    || RETRYABLE_NETWORK_CODES.has(error.providerCode);
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  timer.unref?.();
  const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/**
 * Run `operation(attempt)` with exponential back-off. A provider Retry-After
 * wins over the computed delay. The same operation (and so the same
 * idempotency key the caller closed over) is replayed on every attempt.
 */
export async function withRetry(operation, {
  retries = 3, baseDelayMs = 500, maxDelayMs = 15_000, retryable = isRetryable, sleep = defaultSleep, signal, onRetry,
} = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !retryable(error) || signal?.aborted) throw error;
      const computed = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Number.isFinite(error?.retryAfterMs) ? Math.min(maxDelayMs * 4, error.retryAfterMs) : computed;
      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}

/**
 * Token bucket: at most `perSecond` operations per second with `burst`
 * capacity. `take()` resolves when a token is available (FIFO).
 */
export function createRateLimiter({ perSecond = 10, burst, now = () => Date.now(), sleep = defaultSleep } = {}) {
  const rate = Number.isFinite(perSecond) && perSecond > 0 ? perSecond : 10;
  const capacity = Number.isFinite(burst) && burst >= 1 ? burst : Math.max(1, Math.ceil(rate));
  let tokens = capacity;
  let last = now();
  let tail = Promise.resolve();
  const refill = () => {
    const current = now();
    tokens = Math.min(capacity, tokens + ((current - last) / 1000) * rate);
    last = current;
  };
  return {
    take(signal) {
      const turn = tail.then(async () => {
        refill();
        while (tokens < 1) {
          await sleep(Math.ceil(((1 - tokens) / rate) * 1000), signal);
          refill();
        }
        tokens -= 1;
      });
      tail = turn.catch(() => undefined);
      return turn;
    },
    get available() { refill(); return tokens; },
  };
}
