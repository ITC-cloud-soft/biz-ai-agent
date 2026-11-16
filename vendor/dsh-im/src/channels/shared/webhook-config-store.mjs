// care fork: persisted bot list for the webhook channels (LINE, Teams).
// Same document shape and write discipline as the Slack store: no secret is
// ever written here, only the names of the DSH credential entries (`*Ref`).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * @param {object} definition
 * @param {string} definition.channel     'line' | 'teams'
 * @param {Record<string,string>} definition.refs  ref field → credential name prefix,
 *   e.g. { secretRef: 'DSH_LINE_CHANNEL_SECRET_' }
 * @param {string[]} [definition.extra]   additional optional string fields kept in config
 */
export function defineWebhookIdentity({ channel, refs }) {
  const idPattern = new RegExp(`^${channel}_[a-f0-9]{24}$`);
  const refPatterns = Object.fromEntries(Object.entries(refs).map(([field, prefix]) => [
    field, new RegExp(`^${prefix}[A-F0-9]{24}$`),
  ]));
  function derive(platformId) {
    const raw = cleanString(platformId);
    if (!raw) throw new TypeError('platformId is required');
    const digest = createHash('sha256').update(`${channel}:${raw}`).digest('hex').slice(0, 24);
    const suffix = digest.toUpperCase();
    return {
      botId: `${channel}_${digest}`,
      ...Object.fromEntries(Object.entries(refs).map(([field, prefix]) => [field, `${prefix}${suffix}`])),
    };
  }
  return Object.freeze({ channel, idPattern, refPatterns, refFields: Object.keys(refs), derive });
}

export function maskPlatformId(platformId, fallback) {
  const value = cleanString(platformId) ?? '';
  return value ? `${value.slice(0, 6)}••••${value.length > 10 ? value.slice(-2) : ''}` : fallback;
}

export function createWebhookConfigStore(identity, { extra = [] } = {}) {
  const EMPTY = Object.freeze({ version: 1, bots: Object.freeze([]) });
  return class WebhookConfigStore {
    #path;
    #value = EMPTY;
    #writeQueue = Promise.resolve();

    constructor(path) {
      this.#path = path;
    }

    async load() {
      try {
        const normalized = this.#normalizeDocument(JSON.parse(await readFile(this.#path, 'utf8')));
        if (!normalized) throw new Error(`dsh-im ${identity.channel} config contains invalid bot data`);
        this.#value = normalized;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        this.#value = EMPTY;
      }
      return this;
    }

    list() { return structuredClone(this.#value.bots); }

    get(botId) {
      const bot = this.#value.bots.find((candidate) => candidate.botId === botId);
      return bot ? structuredClone(bot) : null;
    }

    getByPlatformId(platformId) {
      const bot = this.#value.bots.find((candidate) => candidate.platformId === platformId);
      return bot ? structuredClone(bot) : null;
    }

    async save(value) {
      const normalized = this.#normalizeBot(value);
      if (!normalized) throw new Error(`Refusing to persist incomplete ${identity.channel} bot data`);
      return this.#mutate((bots) => {
        const collision = bots.find((bot) => bot.botId !== normalized.botId && bot.platformId === normalized.platformId);
        if (collision) throw new Error(`Duplicate ${identity.channel} bot identity`);
        const index = bots.findIndex((bot) => bot.botId === normalized.botId);
        if (index === -1) bots.push(normalized);
        else bots[index] = normalized;
        return structuredClone(normalized);
      });
    }

    async remove(botId) {
      if (!identity.idPattern.test(botId)) throw new TypeError(`Invalid ${identity.channel} bot id`);
      return this.#mutate((bots) => {
        const index = bots.findIndex((bot) => bot.botId === botId);
        if (index === -1) return null;
        return structuredClone(bots.splice(index, 1)[0]);
      });
    }

    async clear() {
      const operation = this.#writeQueue.then(async () => {
        try { await unlink(this.#path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        this.#value = EMPTY;
      });
      this.#writeQueue = operation.then(() => undefined, () => undefined);
      await operation;
    }

    #normalizeBot(value) {
      if (!value || typeof value !== 'object') return null;
      const botId = cleanString(value.botId);
      const platformId = cleanString(value.platformId);
      const name = cleanString(value.name);
      if (!botId || !platformId || !name || !identity.idPattern.test(botId)) return null;
      const derived = identity.derive(platformId);
      if (derived.botId !== botId) return null;
      const bot = { botId, platformId, name };
      for (const field of identity.refFields) {
        const ref = cleanString(value[field]);
        if (!ref || ref !== derived[field] || !identity.refPatterns[field].test(ref)) return null;
        bot[field] = ref;
      }
      for (const field of extra) bot[field] = cleanString(value[field]);
      bot.createdAt = cleanString(value.createdAt) ?? new Date().toISOString();
      bot.connectedAt = cleanString(value.connectedAt);
      return Object.freeze(bot);
    }

    #normalizeDocument(value) {
      if (!value || value.version !== 1 || !Array.isArray(value.bots)) return null;
      const bots = value.bots.map((bot) => this.#normalizeBot(bot));
      if (bots.some((bot) => bot === null)) return null;
      const ids = new Set();
      const platformIds = new Set();
      for (const bot of bots) {
        if (ids.has(bot.botId) || platformIds.has(bot.platformId)) return null;
        ids.add(bot.botId);
        platformIds.add(bot.platformId);
      }
      return Object.freeze({ version: 1, bots: Object.freeze(bots) });
    }

    async #mutate(mutator) {
      let result;
      const operation = this.#writeQueue.then(async () => {
        const bots = [...this.#value.bots];
        result = mutator(bots);
        const document = Object.freeze({ version: 1, bots: Object.freeze(bots) });
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.#path);
        this.#value = document;
      });
      this.#writeQueue = operation.then(() => undefined, () => undefined);
      await operation;
      return result;
    }
  };
}
