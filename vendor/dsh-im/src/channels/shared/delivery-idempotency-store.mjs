// care fork: durable idempotency records for proactive deliveries and cards.
//
// One small JSON document under $DSH_HOME keeps, per idempotency key, the
// message reference a successful delivery produced, plus the button mapping of
// cards whose platform cannot carry the action value itself (Telegram limits
// callback_data to 64 bytes). Records are kept for at least `retentionDays`
// (7 by default) and pruned on load and on every write.
//
// Only successful deliveries are recorded. Concurrent calls with the same key
// inside this process share the in-flight attempt, so a retry storm cannot
// double-send; a crash between the provider accepting a message and the record
// being written can still repeat that single message once.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 512;

function emptyDocument() {
  return { version: 1, deliveries: {}, cards: {} };
}

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

export class DeliveryIdempotencyStore {
  #path;
  #retentionMs;
  #now;
  #logger;
  #document = emptyDocument();
  #loaded = null;
  #writeTail = Promise.resolve();
  #inflight = new Map();

  constructor({ path = null, retentionDays = DEFAULT_RETENTION_DAYS, now = () => Date.now(), logger = console } = {}) {
    this.#path = typeof path === 'string' && path ? path : null;
    const days = Number.isFinite(retentionDays) && retentionDays >= DEFAULT_RETENTION_DAYS
      ? retentionDays : DEFAULT_RETENTION_DAYS;
    this.#retentionMs = days * DAY_MS;
    this.#now = now;
    this.#logger = logger;
  }

  get path() {
    return this.#path;
  }

  async load() {
    this.#loaded ??= (async () => {
      if (!this.#path) return;
      try {
        const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.#document = {
            version: 1,
            deliveries: parsed.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {},
            cards: parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {},
          };
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.#logger.warn?.('[dsh-im] idempotency store unreadable; starting empty:', error?.message ?? error);
        }
      }
      this.#prune();
    })();
    return this.#loaded;
  }

  #prune() {
    const cutoff = this.#now() - this.#retentionMs;
    for (const section of ['deliveries', 'cards']) {
      for (const [key, entry] of Object.entries(this.#document[section])) {
        if (!entry || typeof entry.at !== 'number' || entry.at < cutoff) delete this.#document[section][key];
      }
    }
  }

  async #persist() {
    this.#prune();
    if (!this.#path) return;
    const snapshot = JSON.stringify(this.#document);
    const path = this.#path;
    this.#writeTail = this.#writeTail.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, path);
    });
    return this.#writeTail;
  }

  async getDelivery(key) {
    await this.load();
    if (!validKey(key)) return null;
    const entry = this.#document.deliveries[key];
    if (!entry || entry.at < this.#now() - this.#retentionMs) return null;
    return structuredClone(entry);
  }

  async putDelivery(key, value) {
    await this.load();
    if (!validKey(key)) throw new TypeError('idempotency key must be 1 to 512 characters');
    this.#document.deliveries[key] = { ...structuredClone(value), at: this.#now() };
    await this.#persist();
  }

  /**
   * Run `operation` at most once per key inside the retention window.
   * @returns {{ value: any, deduped: boolean }}
   */
  async once(key, operation) {
    if (!validKey(key)) throw new TypeError('idempotency key must be 1 to 512 characters');
    const existing = await this.getDelivery(key);
    if (existing) return { value: existing.value, deduped: true };
    const running = this.#inflight.get(key);
    if (running) {
      const value = await running;
      return { value, deduped: true };
    }
    const attempt = (async () => {
      const value = await operation();
      await this.putDelivery(key, { value });
      return value;
    })();
    this.#inflight.set(key, attempt);
    try {
      return { value: await attempt, deduped: false };
    } finally {
      if (this.#inflight.get(key) === attempt) this.#inflight.delete(key);
    }
  }

  async getCard(cardId) {
    await this.load();
    if (!validKey(cardId)) return null;
    const entry = this.#document.cards[cardId];
    return entry ? structuredClone(entry) : null;
  }

  async putCard(cardId, value) {
    await this.load();
    if (!validKey(cardId)) throw new TypeError('card id is invalid');
    this.#document.cards[cardId] = { ...structuredClone(value), at: this.#now() };
    await this.#persist();
  }

  async listCards(prefix = '') {
    await this.load();
    return Object.entries(this.#document.cards)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, ...structuredClone(value) }));
  }

  async flush() {
    await this.#writeTail.catch(() => undefined);
  }
}
