// care fork: process-wide extension hub behind the additional ctx.dshIm API.
//
// Channels report what they know (trusted inbound source, button presses,
// connected card drivers); other plugins register policy (access resolver,
// reply claims, action handlers). Everything is optional: with nothing
// registered the bridges take their original code paths, except that the
// production Host switches `accessDefault` to 'closed' (see inbound-access.mjs).
//
// Order for one inbound text message, before it can reach an agent:
//   0. the conversation router, when one is set (shared bots only: which
//      business application this message belongs to -> source.applicationId)
//   1. claimReplies matchers (first match wins; the handler gets the trusted source)
//   2. the access resolver, when one is set ('allow' | 'deny' | { deny, reply })
//   3. the channel's own access policy (command permission, allowlist)
// Messages consumed by 1 or denied by 2 never enter an agent Session.
// After the agent's turn, answer filters (setAnswerFilter) may rewrite its final
// text before the channel sends it (e.g. drop links the business app does not have).
//
// care fork (shared bots, e.g. personal WeChat with one bot per account): a
// router-assigned applicationId scopes the conversation key, so every
// application keeps its own DSH Session (scopedConversationKey).

import { randomBytes } from 'node:crypto';

import { DeliveryIdempotencyStore } from './delivery-idempotency-store.mjs';
import {
  cardFallbackText,
  decodeMessageRef,
  encodeMessageRef,
  normalizeCard,
} from './im-card.mjs';

export const ACCESS_DEFAULTS = Object.freeze(['legacy', 'closed']);
const RESOLVER_TIMEOUT_MS = 10_000;
const MAX_TURN_RECORDS = 2_000;
const DIALOG_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CARD_MESSAGES = 1_000;
const MIN_QUOTE_MATCH = 4;
const ROUTER_TIMEOUT_MS = 5_000;
const APPLICATION_ID_RE = /^[a-z][a-z0-9-]{1,62}$/u;

/**
 * care fork: the conversation key of one business application on a shared bot.
 * Without an applicationId (every ordinary bot) the key is unchanged. The
 * suffix contains ':' so delivery suggestions never parse it as a user id.
 */
export function scopedConversationKey(baseKey, source) {
  const applicationId = source?.applicationId;
  if (typeof baseKey !== 'string' || !baseKey) return baseKey;
  return typeof applicationId === 'string' && APPLICATION_ID_RE.test(applicationId)
    ? `${baseKey}:app:${applicationId}`
    : baseKey;
}

function squash(text) {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function extensionError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function disposable(dispose) {
  let disposed = false;
  const handle = () => {
    if (disposed) return false;
    disposed = true;
    dispose();
    return true;
  };
  handle.dispose = handle;
  if (typeof Symbol.dispose === 'symbol') handle[Symbol.dispose] = handle;
  return handle;
}

function cleanString(value) {
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Copy and freeze one ImSource; returns null when a required field is missing. */
export function normalizeImSource(value) {
  if (!value || typeof value !== 'object') return null;
  const platform = cleanString(value.platform);
  const botId = cleanString(value.botId);
  const userId = cleanString(value.userId);
  const conversationId = cleanString(value.conversationId);
  const messageId = cleanString(value.messageId);
  if (!platform || !botId || !userId || !conversationId || !messageId) return null;
  const at = typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at))
    ? new Date(value.at).toISOString()
    : new Date().toISOString();
  const source = {
    platform,
    botId,
    userId,
    conversationId,
    conversationKind: value.conversationKind === 'group' ? 'group' : 'direct',
    messageId,
    at,
  };
  const teamId = cleanString(value.teamId);
  if (teamId) source.teamId = teamId;
  const userName = cleanString(value.userName);
  if (userName) source.userName = userName.slice(0, 200);
  const threadId = cleanString(value.threadId);
  if (threadId) source.threadId = threadId;
  // care fork: set only by the conversation router of a shared bot.
  const applicationId = cleanString(value.applicationId);
  if (applicationId && APPLICATION_ID_RE.test(applicationId)) source.applicationId = applicationId;
  return Object.freeze(source);
}

function normalizeVerdict(value) {
  if (value === 'allow') return { verdict: 'allow' };
  if (value && typeof value === 'object' && value.deny === true) {
    const reply = typeof value.reply === 'string' && value.reply.trim() ? value.reply.trim().slice(0, 2000) : null;
    return { verdict: 'deny', reply };
  }
  return { verdict: 'deny', reply: null };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(extensionError('resolver-timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function cardId() {
  return randomBytes(9).toString('base64url');
}

function validTo(to) {
  if (!to || typeof to !== 'object' || Array.isArray(to)) return null;
  const userId = cleanString(to.userId);
  const conversationId = cleanString(to.conversationId);
  if (!userId && !conversationId) return null;
  return { ...(userId ? { userId } : {}), ...(conversationId ? { conversationId } : {}) };
}

export function createImExtensions({ logger: initialLogger = console } = {}) {
  let logger = initialLogger;
  let accessDefault = 'legacy';
  let store = new DeliveryIdempotencyStore({ logger });
  let emitInbound = null;
  let fallbackSender = null;
  const resolvers = [];
  const routers = [];
  const claims = [];
  const answerFilters = [];
  const actions = new Map();
  const turns = new Map();
  const drivers = new Map();
  const gateTails = new Map();
  const dialogs = new Map();
  const pendingCards = new Map();
  // Card messages delivered by sendCard/updateCard (7-day store + memory cache),
  // so a reply that quotes a card can be stripped before it reaches a prompt.
  let cardMessages = [];
  const loadCardMessages = (activeStore) => {
    void activeStore.listCards('msg:').then((entries) => {
      if (store !== activeStore) return;
      const known = new Set(cardMessages.map((entry) => entry.key));
      for (const entry of entries) if (!known.has(entry.key)) cardMessages.push(entry);
    }).catch(() => undefined);
  };
  const rememberCardMessage = async ({ platform, botId, conversationId, messageId, text }) => {
    const entry = {
      key: `msg:${platform}:${botId}:${conversationId ?? ''}:${messageId ?? Date.now()}`,
      platform, botId, conversationId: conversationId ?? null, messageId: messageId ?? null, text: squash(text),
    };
    cardMessages = cardMessages.filter((existing) => existing.key !== entry.key);
    cardMessages.push(entry);
    while (cardMessages.length > MAX_CARD_MESSAGES) cardMessages.shift();
    try {
      const { key, ...value } = entry;
      await store.putCard(key, value);
    } catch (error) {
      logger.warn?.('[dsh-im] could not persist a card message record:', error?.message ?? error);
    }
  };
  const rememberRef = async (messageRef, text) => {
    const ref = decodeMessageRef(messageRef);
    if (ref) await rememberCardMessage({ ...ref, text });
  };

  const api = {
    // ── configuration ──────────────────────────────────────────────────────
    configure({ accessDefault: nextDefault, storePath, retentionDays, logger: nextLogger } = {}) {
      if (nextLogger) logger = nextLogger;
      if (nextDefault !== undefined) {
        if (!ACCESS_DEFAULTS.includes(nextDefault)) throw new TypeError(`accessDefault must be one of ${ACCESS_DEFAULTS.join(', ')}`);
        accessDefault = nextDefault;
      }
      if (storePath !== undefined || retentionDays !== undefined) {
        store = new DeliveryIdempotencyStore({ path: storePath ?? store.path, retentionDays, logger });
        cardMessages = [];
        loadCardMessages(store);
      }
    },
    get accessDefault() {
      return accessDefault;
    },
    get store() {
      return store;
    },
    setInboundEmitter(fn) {
      emitInbound = typeof fn === 'function' ? fn : null;
      return disposable(() => { if (emitInbound === fn) emitInbound = null; });
    },
    setFallbackSender(fn) {
      fallbackSender = typeof fn === 'function' ? fn : null;
      return disposable(() => { if (fallbackSender === fn) fallbackSender = null; });
    },
    /** Restore the pristine module state (tests and Host disposal). */
    reset() {
      accessDefault = 'legacy';
      store = new DeliveryIdempotencyStore({ logger });
      emitInbound = null;
      fallbackSender = null;
      resolvers.length = 0;
      routers.length = 0;
      claims.length = 0;
      answerFilters.length = 0;
      actions.clear();
      turns.clear();
      drivers.clear();
      gateTails.clear();
      for (const dialog of dialogs.values()) dialog.finish(null);
      dialogs.clear();
      pendingCards.clear();
      cardMessages = [];
    },

    /**
     * True when a reply reference (replyTo) points at a card this hub sent:
     * same message id in the same conversation, or quoted text taken from a
     * card. Bridges drop such references so card content (reply codes,
     * figures) never enters an agent prompt or transcript.
     */
    isCardReply({ platform, botId, conversationId, replyTo } = {}) {
      if (!replyTo || typeof replyTo !== 'object' || cardMessages.length === 0) return false;
      const messageId = cleanString(replyTo.messageId);
      const quoted = squash(replyTo.content);
      return cardMessages.some((entry) => {
        if (entry.platform !== platform || (botId && entry.botId !== botId)) return false;
        if (messageId && entry.messageId === messageId
          && (!entry.conversationId || !conversationId || entry.conversationId === conversationId)) return true;
        return quoted.length >= MIN_QUOTE_MATCH && entry.text.includes(quoted);
      });
    },

    // ── answer filters (care fork) ─────────────────────────────────────────
    /**
     * filter({ sessionId, source, text }) -> string (or anything else to keep the text). Runs on the
     * agent's final answer of an IM turn before the channel sends it, in registration order. A filter
     * that throws or times out leaves the text as it was (logged).
     */
    setAnswerFilter(filter) {
      if (typeof filter !== 'function') throw new TypeError('answer filter must be a function');
      answerFilters.push(filter);
      return disposable(() => {
        const index = answerFilters.indexOf(filter);
        if (index >= 0) answerFilters.splice(index, 1);
      });
    },
    hasAnswerFilter() {
      return answerFilters.length > 0;
    },
    async filterAnswer({ sessionId = null, source = null, text } = {}) {
      if (typeof text !== 'string' || !text || answerFilters.length === 0) return text;
      let out = text;
      for (const filter of [...answerFilters]) {
        try {
          const next = await withTimeout(Promise.resolve().then(() => filter({ sessionId, source, text: out })), RESOLVER_TIMEOUT_MS);
          if (typeof next === 'string') out = next;
        } catch (error) {
          logger.warn?.('[dsh-im] answer filter failed; the answer is kept:', error?.message ?? error);
        }
      }
      return out;
    },

    // ── 2) access resolver ─────────────────────────────────────────────────
    setAccessResolver(fn) {
      if (typeof fn !== 'function') throw new TypeError('access resolver must be a function');
      const entry = { fn };
      resolvers.push(entry);
      return disposable(() => {
        const index = resolvers.indexOf(entry);
        if (index >= 0) resolvers.splice(index, 1);
      });
    },
    hasAccessResolver() {
      return resolvers.length > 0;
    },
    async resolveAccess(source, { text = '' } = {}) {
      const entry = resolvers.at(-1);
      if (!entry) return { verdict: 'none' };
      try {
        // care fork: the resolver also gets the message text (a fixed answer to a sender that is not linked yet)
        return normalizeVerdict(await withTimeout(Promise.resolve().then(() => entry.fn(source, { text: typeof text === 'string' ? text : '' })), RESOLVER_TIMEOUT_MS));
      } catch (error) {
        logger.warn?.('[dsh-im] access resolver failed; denying the message:', error?.code ?? error?.message ?? error);
        return { verdict: 'deny', reply: null };
      }
    },

    // ── 0) conversation router (shared bots) ──────────────────────────────
    /**
     * router: { route({ source, text, replyTo }) -> { applicationId } | null,
     *           decorateReply?(source, text) -> string,
     *           decorateOutbound?({ botId, to, targetId, text, applicationId }) -> string }
     * (a bare function is the route). The last registered router is used.
     */
    setConversationRouter(router) {
      const entry = typeof router === 'function' ? { route: router } : router;
      if (!entry || typeof entry !== 'object' || typeof entry.route !== 'function') {
        throw new TypeError('conversation router must be a function or { route }');
      }
      routers.push(entry);
      return disposable(() => {
        const index = routers.indexOf(entry);
        if (index >= 0) routers.splice(index, 1);
      });
    },
    hasConversationRouter() {
      return routers.length > 0;
    },
    /** The source with the router's applicationId (unchanged when no router answers). */
    async routeSource(source, { text = '', replyTo = null } = {}) {
      const router = routers.at(-1);
      if (!router || !source) return source;
      try {
        const routed = await withTimeout(Promise.resolve().then(() => router.route({
          source,
          text: typeof text === 'string' ? text : '',
          replyTo: replyTo && typeof replyTo === 'object'
            ? { messageId: cleanString(replyTo.messageId) ?? null, content: typeof replyTo.content === 'string' ? replyTo.content : '' }
            : null,
        })), ROUTER_TIMEOUT_MS);
        const applicationId = cleanString(routed?.applicationId);
        if (!applicationId || !APPLICATION_ID_RE.test(applicationId)) return source;
        return normalizeImSource({ ...source, applicationId }) ?? source;
      } catch (error) {
        logger.warn?.('[dsh-im] conversation router failed; using the bot default:', error?.code ?? error?.message ?? error);
        return source;
      }
    },
    /** Reply text for a routed source (e.g. an application name prefix). */
    decorateReply(source, text) {
      const router = routers.at(-1);
      if (!router || typeof router.decorateReply !== 'function' || typeof text !== 'string' || !source?.applicationId) return text;
      try {
        const decorated = router.decorateReply(source, text);
        return typeof decorated === 'string' && decorated ? decorated : text;
      } catch (error) {
        logger.warn?.('[dsh-im] reply decoration failed:', error?.message ?? error);
        return text;
      }
    },
    /** Proactive text to a bot (notifications): the router may prefix and remember it. */
    decorateOutbound(input = {}) {
      const router = routers.at(-1);
      const text = input.text;
      if (!router || typeof router.decorateOutbound !== 'function' || typeof text !== 'string') return text;
      try {
        const decorated = router.decorateOutbound({ ...input });
        return typeof decorated === 'string' && decorated ? decorated : text;
      } catch (error) {
        logger.warn?.('[dsh-im] outbound decoration failed:', error?.message ?? error);
        return text;
      }
    },

    // ── 5) reply claims ────────────────────────────────────────────────────
    claimReplies(matcher, handler) {
      if (typeof matcher !== 'function' || typeof handler !== 'function') {
        throw new TypeError('claimReplies requires a matcher and a handler');
      }
      const entry = { matcher, handler };
      claims.push(entry);
      return disposable(() => {
        const index = claims.indexOf(entry);
        if (index >= 0) claims.splice(index, 1);
      });
    },

    /** True when inbound messages must pass the asynchronous gate. */
    needsGate() {
      return resolvers.length > 0 || claims.length > 0 || routers.length > 0;
    },

    /**
     * Decide one inbound message, serialized per conversation so a slow
     * resolver cannot reorder a chat. `proceed(decision)` runs inside the
     * serialized section and its (possibly long) result is returned unawaited
     * by the chain.
     * decision: { handled: true, kind: 'claimed'|'denied', source? }
     *         | { handled: false, resolverVerdict?: 'allow', source? }
     * `source` (also the second argument of proceed) carries the router's
     * applicationId on a shared bot.
     */
    gate({ source: rawSource, text = '', plainText = true, reply, serialKey, replyTo = null }, proceed) {
      const source = normalizeImSource(rawSource);
      const key = serialKey ?? (source ? `${source.platform}\u0000${source.botId}\u0000${source.conversationId}` : 'unknown');
      const previous = gateTails.get(key) ?? Promise.resolve();
      let release;
      const turnstile = new Promise((resolve) => { release = resolve; });
      const tail = previous.then(() => turnstile);
      gateTails.set(key, tail);
      void tail.finally(() => { if (gateTails.get(key) === tail) gateTails.delete(key); });
      return previous.then(async () => {
        let decision;
        try {
          decision = source
            ? await api.decide({ source, text, plainText, reply, replyTo })
            : { handled: resolvers.length > 0, kind: 'denied' };
        } catch (error) {
          logger.warn?.('[dsh-im] inbound gate failed; denying the message:', error?.message ?? error);
          decision = { handled: true, kind: 'denied' };
        }
        try {
          return proceed(decision, decision.source ?? source);
        } finally {
          release();
        }
      });
    },

    async decide({ source: rawSource, text, plainText, reply, replyTo = null }) {
      const body = typeof text === 'string' ? text.trim() : '';
      // care fork: the router (shared bots) decides the application first, so
      // claims, the resolver and the agent turn all see the same source.
      const source = await api.routeSource(rawSource, { text: body, replyTo });
      const safeReply = async (message) => {
        if (typeof message !== 'string' || !message.trim() || typeof reply !== 'function') return;
        await reply(api.decorateReply(source, message));
      };
      const decision = await api.decideRouted({ source, body, plainText, safeReply });
      return source === rawSource ? decision : { ...decision, source };
    },

    async decideRouted({ source, body, plainText, safeReply }) {
      if (body && plainText !== false) {
        for (const claim of [...claims]) {
          let matched = false;
          try { matched = claim.matcher(body, source) === true; } catch { matched = false; }
          if (!matched) continue;
          try {
            await claim.handler({ text: body, source, reply: safeReply });
          } catch (error) {
            logger.warn?.('[dsh-im] reply claim handler failed:', error?.message ?? error);
          }
          return { handled: true, kind: 'claimed' };
        }
      }
      const access = await api.resolveAccess(source, { text: body });
      if (access.verdict === 'none') return { handled: false };
      if (access.verdict === 'allow') return { handled: false, resolverVerdict: 'allow' };
      if (access.reply) {
        try { await safeReply(access.reply); } catch (error) {
          logger.warn?.('[dsh-im] could not send the access denial reply:', error?.message ?? error);
        }
      }
      return { handled: true, kind: 'denied' };
    },

    // ── 1) trusted source of the current turn ──────────────────────────────
    recordTurnSource(sessionId, rawSource, text = '') {
      const source = normalizeImSource(rawSource);
      if (typeof sessionId !== 'string' || !sessionId || !source) return null;
      const record = { source, turn: null };
      turns.delete(sessionId);
      turns.set(sessionId, record);
      while (turns.size > MAX_TURN_RECORDS) turns.delete(turns.keys().next().value);
      try {
        emitInbound?.({ sessionId, source, text: typeof text === 'string' ? text : '' });
      } catch (error) {
        logger.warn?.('[dsh-im] dsh-im/inbound listener failed:', error?.message ?? error);
      }
      return record;
    },
    releaseTurnSource(sessionId, record) {
      if (record && turns.get(sessionId) === record) turns.delete(sessionId);
    },
    bindTurn(sessionId, turn) {
      const record = turns.get(sessionId);
      if (record && record.turn === null && Number.isSafeInteger(turn)) record.turn = turn;
    },
    endTurn(sessionId, turn) {
      const record = turns.get(sessionId);
      if (record && record.turn !== null && record.turn === turn) turns.delete(sessionId);
    },
    sourceForTurn(sessionId) {
      if (typeof sessionId !== 'string') return null;
      return turns.get(sessionId)?.source ?? null;
    },

    // ── 4) button actions ──────────────────────────────────────────────────
    onAction(prefix, handler) {
      if (typeof prefix !== 'string' || !prefix || typeof handler !== 'function') {
        throw new TypeError('onAction requires a non-empty prefix and a handler');
      }
      const entry = { handler };
      actions.set(prefix, entry);
      return disposable(() => { if (actions.get(prefix) === entry) actions.delete(prefix); });
    },
    hasActionHandler(actionId) {
      return api.actionHandlerFor(actionId) !== null;
    },
    actionHandlerFor(actionId) {
      if (typeof actionId !== 'string') return null;
      let best = null;
      for (const [prefix, entry] of actions) {
        if (actionId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, entry };
      }
      return best?.entry.handler ?? null;
    },
    /** @returns whether a handler took the press. */
    async dispatchAction({ actionId, value = '', source: rawSource, messageRef = '', respond, openReasonDialog, inputText }) {
      const handler = api.actionHandlerFor(actionId);
      const source = normalizeImSource(rawSource);
      if (!handler || !source) return false;
      const event = {
        actionId,
        value: typeof value === 'string' ? value : String(value ?? ''),
        source,
        messageRef: typeof messageRef === 'string' ? messageRef : '',
        respond: async (text) => {
          if (typeof text === 'string' && text.trim() && typeof respond === 'function') await respond(text.trim());
        },
        ...(typeof openReasonDialog === 'function' ? { openReasonDialog } : {}),
        // care fork: the text typed into the card's input of this button (Teams / Feishu), at most 2000 characters
        ...(typeof inputText === 'string' && inputText.trim() ? { inputText: inputText.trim().slice(0, 2000) } : {}),
      };
      try {
        await handler(event);
      } catch (error) {
        logger.warn?.('[dsh-im] action handler failed:', error?.message ?? error);
      }
      return true;
    },
    async registerCardActions(id, value) {
      await store.putCard(id, value);
    },
    async resolveCardAction(id, index) {
      await pendingCards.get(id)?.catch(() => undefined);
      const card = await store.getCard(id);
      const action = card?.actions?.[index];
      if (!card || !action) return null;
      return {
        botId: card.botId, messageRef: card.messageRef, actionId: action.id, value: action.value,
        // care fork (Feishu): the card callback does not say whether the chat is a DM.
        ...(card.conversationKind === 'direct' || card.conversationKind === 'group' ? { conversationKind: card.conversationKind } : {}),
      };
    },

    // ── reason dialogs (Slack modals) ──────────────────────────────────────
    waitForDialog(key, timeoutMs = DIALOG_TIMEOUT_MS) {
      dialogs.get(key)?.finish(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => entry.finish(null), timeoutMs);
        timer.unref?.();
        const entry = {
          finish(value) {
            clearTimeout(timer);
            if (dialogs.get(key) === entry) dialogs.delete(key);
            resolve(value);
          },
        };
        dialogs.set(key, entry);
      });
    },
    resolveDialog(key, value) {
      const entry = dialogs.get(key);
      if (!entry) return false;
      entry.finish(typeof value === 'string' ? value : null);
      return true;
    },

    // ── 3) cards ───────────────────────────────────────────────────────────
    registerDriver(botId, driver) {
      if (typeof botId !== 'string' || !botId || !driver || typeof driver !== 'object') {
        throw new TypeError('registerDriver requires a bot id and a driver');
      }
      drivers.set(botId, driver);
      return disposable(() => { if (drivers.get(botId) === driver) drivers.delete(botId); });
    },
    driverFor(botId) {
      return drivers.get(botId) ?? null;
    },
    async sendCard(input = {}) {
      const botId = cleanString(input.botId);
      const to = validTo(input.to);
      const key = cleanString(input.idempotencyKey);
      if (!botId || !to || !key) throw extensionError('bad-request', 'sendCard requires botId, to.userId or to.conversationId, and idempotencyKey');
      const card = normalizeCard(input.card);
      const { value, deduped } = await store.once(`card:${key}`, async () => {
        const driver = drivers.get(botId);
        if (typeof driver?.sendCard === 'function') {
          const helpers = {
            // care fork (LINE): provider-level retries reuse a key derived from this.
            idempotencyKey: key,
            newCardId: () => cardId(),
            registerCardActions: async (id, mapping) => api.registerCardActions(id, { botId, ...mapping }),
            trackPendingCard: (id, promise) => {
              pendingCards.set(id, promise);
              void promise.finally(() => { if (pendingCards.get(id) === promise) pendingCards.delete(id); }).catch(() => undefined);
            },
          };
          const sent = await driver.sendCard(to, card, helpers);
          if (typeof sent?.messageRef !== 'string' || !sent.messageRef) throw extensionError('send-result-unknown');
          await rememberRef(sent.messageRef, cardFallbackText(card));
          return { messageRef: sent.messageRef, platform: driver.platform ?? null };
        }
        if (!fallbackSender) throw extensionError('bot-not-connected', 'No connected channel can deliver to this bot');
        // care fork: on a shared bot the router prefixes the application name and
        // remembers the notification (a reply to it returns to that application).
        const text = api.decorateOutbound({
          botId, to, text: cardFallbackText(card), applicationId: cleanString(input.applicationId) ?? null, kind: 'card',
        });
        const sent = await fallbackSender(botId, to, text);
        const messageRef = encodeMessageRef({
          platform: sent?.platform ?? 'unknown',
          botId,
          conversationId: sent?.conversationId ?? to.conversationId ?? to.userId,
          messageId: sent?.messageId ?? null,
          // care fork: remember that this went to a user, so updateCard reaches the same DM.
          toUser: Boolean(to.userId && !to.conversationId),
        });
        await rememberRef(messageRef, text);
        return { messageRef, platform: sent?.platform ?? null };
      });
      return { messageRef: value.messageRef, delivered: true, deduped };
    },
    async updateCard(messageRef, rawCard) {
      const ref = decodeMessageRef(messageRef);
      if (!ref) throw extensionError('bad-request', 'Unknown message reference');
      const card = normalizeCard(rawCard);
      const driver = drivers.get(ref.botId);
      if (typeof driver?.updateCard === 'function' && (!driver.platform || driver.platform === ref.platform)) {
        const updated = await driver.updateCard(ref, card, {
          newCardId: () => cardId(),
          registerCardActions: async (id, mapping) => api.registerCardActions(id, { botId: ref.botId, ...mapping }),
          messageRef,
        });
        // care fork (Feishu): a driver that had to re-send reports the new message id.
        const messageId = cleanString(updated?.messageId);
        await rememberCardMessage({ ...ref, ...(messageId ? { messageId } : {}), text: cardFallbackText(card) });
        return;
      }
      if (!fallbackSender) throw extensionError('bot-not-connected', 'No connected channel can deliver to this bot');
      if (!ref.conversationId) throw extensionError('capability-unavailable', 'This message cannot be updated');
      // Text channels cannot edit: the updated card is sent as a new message.
      const text = cardFallbackText(card);
      const sent = await fallbackSender(ref.botId, ref.toUser ? { userId: ref.conversationId } : { conversationId: ref.conversationId }, text);
      await rememberCardMessage({ ...ref, messageId: sent?.messageId ?? `update-${Date.now()}`, text });
    },

    /** Idempotent wrapper used by ctx.dshIm.send({ idempotencyKey }). */
    once(key, operation) {
      return store.once(key, operation);
    },
  };
  return api;
}

/** The single hub shared by every channel inside one Host bundle. */
export const imExtensions = createImExtensions();
