// care fork: Bot Connector REST client for Microsoft Teams and the store of
// conversation references (serviceUrl per conversation, personal conversation
// per AAD user) learned from verified inbound activities.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createRateLimiter, fetchJson, withRetry } from '../shared/rest-client.mjs';
import { BotFrameworkTokenProvider } from './teams-auth.mjs';

export const TEAMS_TEXT_LIMIT = 25_000;
const MAX_REFERENCES = 5_000;

// Microsoft guidance: back off and retry on 429, 412, 502, 503 and 504.
const SEND_RETRY_STATUSES = new Set([412, 429, 502, 503, 504]);

function serviceBase(serviceUrl, { allowInsecure = false } = {}) {
  let url;
  try { url = new URL(serviceUrl); } catch { url = null; }
  if (!url || (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:'))) {
    throw Object.assign(new TypeError('Teams serviceUrl must be an https URL'), { code: 'invalid-target' });
  }
  return url.href.replace(/\/+$/, '');
}

export class TeamsConnector {
  #tokens;
  #fetch;
  #limiter;
  #retries;
  #sleep;
  #allowInsecure;
  #logger;

  constructor({
    tokenProvider, appId, appPassword, tenantId, loginBase, fetchImpl = globalThis.fetch,
    ratePerSecond = 7, retries = 3, sleep, allowInsecureServiceUrl = false, logger = console,
  } = {}) {
    this.#tokens = tokenProvider ?? new BotFrameworkTokenProvider({ appId, appPassword, tenantId, fetchImpl, ...(loginBase ? { loginBase } : {}) });
    this.#fetch = fetchImpl;
    this.#limiter = createRateLimiter({ perSecond: ratePerSecond, ...(sleep ? { sleep } : {}) });
    this.#retries = retries;
    this.#sleep = sleep;
    this.#allowInsecure = allowInsecureServiceUrl;
    this.#logger = logger;
  }

  get tokens() { return this.#tokens; }

  async #call(method, serviceUrl, path, body, { signal, idempotent = false } = {}) {
    const url = `${serviceBase(serviceUrl, { allowInsecure: this.#allowInsecure })}${path}`;
    let refreshed = false;
    return withRetry(async () => {
      await this.#limiter.take(signal);
      const token = await this.#tokens.token({ signal });
      try {
        return (await fetchJson(url, {
          method, body, signal, fetchImpl: this.#fetch, prefix: 'teams',
          headers: { authorization: `Bearer ${token}` },
        })).body ?? {};
      } catch (error) {
        if (error?.status === 401 && !refreshed) {
          // Token revoked or rotated: fetch a new one and try once more.
          refreshed = true;
          this.#tokens.invalidate();
          error.retryAfterMs = 0;
          error.retryableAuth = true;
        }
        throw error;
      }
    }, {
      retries: this.#retries,
      signal,
      ...(this.#sleep ? { sleep: this.#sleep } : {}),
      retryable: (error) => error?.retryableAuth === true
        || SEND_RETRY_STATUSES.has(Number(error?.status))
        || (idempotent && (Number(error?.status) >= 500 || /-(transport-error|timeout)$/.test(String(error?.code ?? '')))),
      onRetry: (error, attempt, delay) => this.#logger.warn?.(`[dsh-im:teams] ${method} retry ${attempt + 1} in ${delay}ms (${error?.status ?? error?.code})`),
    });
  }

  sendActivity(serviceUrl, conversationId, activity, { replyToId, signal } = {}) {
    const base = `/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    return this.#call('POST', serviceUrl, replyToId ? `${base}/${encodeURIComponent(replyToId)}` : base, activity, { signal });
  }

  updateActivity(serviceUrl, conversationId, activityId, activity, { signal } = {}) {
    return this.#call('PUT', serviceUrl,
      `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
      { ...activity, id: activityId }, { signal, idempotent: true });
  }

  createConversation(serviceUrl, { botId, memberId, tenantId }, { signal } = {}) {
    return this.#call('POST', serviceUrl, '/v3/conversations', {
      isGroup: false,
      bot: { id: botId },
      members: [{ id: memberId }],
      ...(tenantId ? { tenantId, channelData: { tenant: { id: tenantId } } } : {}),
    }, { signal });
  }
}

/** Validate the App ID / password (and tenant) by acquiring an app token. */
export async function inspectTeamsCredentials({ appId, appPassword, tenantId }, {
  createTokenProvider = (options) => new BotFrameworkTokenProvider(options), signal,
} = {}) {
  await createTokenProvider({ appId, appPassword, tenantId: tenantId || null }).token({ signal });
  return { platformId: appId, name: `Teams Bot ${appId.slice(0, 8)}`, tenantId: tenantId || null };
}

/**
 * Conversation references (no secrets): where to send for a conversation, and
 * which personal conversation belongs to an AAD user.
 */
export class TeamsReferenceStore {
  #path;
  #value = { version: 1, conversations: {}, users: {} };
  #writes = Promise.resolve();

  constructor(path = null) {
    this.#path = path;
  }

  async load() {
    if (!this.#path) return this;
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8'));
      if (value?.version === 1 && value.conversations && value.users) this.#value = value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  conversation(conversationId) {
    return this.#value.conversations[conversationId] ?? null;
  }

  user(aadObjectId) {
    return this.#value.users[aadObjectId] ?? null;
  }

  /** Record what a verified activity tells us. */
  async remember(activity) {
    const conversationId = activity?.conversation?.id;
    const serviceUrl = activity?.serviceUrl;
    if (typeof conversationId !== 'string' || typeof serviceUrl !== 'string') return;
    const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? null;
    const kind = activity.conversation?.conversationType === 'personal' ? 'personal' : (activity.conversation?.conversationType ?? 'group');
    const now = new Date().toISOString();
    const previous = this.#value.conversations[conversationId];
    let changed = previous?.serviceUrl !== serviceUrl || previous?.tenantId !== tenantId;
    this.#value.conversations[conversationId] = { serviceUrl, tenantId, kind, updatedAt: changed ? now : previous.updatedAt };
    const aad = activity.from?.aadObjectId;
    if (kind === 'personal' && typeof aad === 'string' && aad) {
      const user = this.#value.users[aad];
      if (user?.conversationId !== conversationId || user?.serviceUrl !== serviceUrl || user?.userId !== activity.from.id) {
        this.#value.users[aad] = { userId: activity.from.id, conversationId, serviceUrl, tenantId, updatedAt: now };
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }

  async #persist() {
    for (const key of ['conversations', 'users']) {
      const entries = Object.entries(this.#value[key]);
      if (entries.length > MAX_REFERENCES) {
        entries.sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)));
        this.#value[key] = Object.fromEntries(entries.slice(entries.length - MAX_REFERENCES));
      }
    }
    if (!this.#path) return;
    const snapshot = `${JSON.stringify(this.#value, null, 2)}\n`;
    const path = this.#path;
    this.#writes = this.#writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    await this.#writes;
  }
}
