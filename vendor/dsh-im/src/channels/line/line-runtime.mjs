// care fork: LINE Messaging API channel.
//
// Inbound: `POST /dsh-hooks/line` (webhook hub) → X-Line-Signature check with
// this bot's channel secret → events. Text messages are normalized and go
// through TextHarnessBridge.accept() (claimReplies → access resolver → channel
// access policy → agent). Postbacks from card buttons go straight to
// ctx.dshIm.onAction() handlers and never reach an agent Session.
// Outbound: reply token while it is fresh and unused, push otherwise.
// Cards: Flex Message bubbles whose buttons are postback actions.

import { atConnectionStage, createConnectionDiagnostics, extractConnectionEvidence } from '../shared/connection-error.mjs';
import { splitMessageText } from '../shared/editable-message-stream.mjs';
import { encodeMessageRef, lineFlexMessage, linePostbackData, parseLinePostbackData } from '../shared/im-card.mjs';
import { imExtensions, normalizeImSource } from '../shared/im-extensions.mjs';
import { webhookHub as defaultWebhookHub } from '../shared/webhook-hub.mjs';
import {
  LINE_MESSAGES_PER_REQUEST, LINE_TEXT_LIMIT, LineApi, lineRetryKey, verifyLineSignature,
} from './line-api.mjs';
import { createLineBridgeStatus, LineHarnessBridge } from './line-bridge.mjs';

// LINE documents roughly one minute of validity; leave a margin.
const REPLY_TOKEN_TTL_MS = 50_000;
const MAX_REMEMBERED_EVENTS = 2_000;

function header(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function conversationOf(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'user' && source.userId) return { kind: 'direct', id: String(source.userId) };
  if (source.type === 'group' && source.groupId) return { kind: 'group', id: String(source.groupId) };
  if (source.type === 'room' && source.roomId) return { kind: 'group', id: String(source.roomId) };
  return null;
}

/** Remove the bot's own @mention (by the indices LINE reports) from the text. */
export function stripLineSelfMention(text, mention, botUserId) {
  if (typeof text !== 'string') return '';
  const mentionees = Array.isArray(mention?.mentionees) ? mention.mentionees : [];
  const own = mentionees
    .filter((entry) => entry?.isSelf === true || (botUserId && entry?.userId === botUserId))
    .filter((entry) => Number.isSafeInteger(entry.index) && Number.isSafeInteger(entry.length))
    .sort((a, b) => b.index - a.index);
  let output = text;
  for (const entry of own) output = output.slice(0, entry.index) + output.slice(entry.index + entry.length);
  return output.replace(/\s+/gu, ' ').trim();
}

/**
 * Normalize one LINE `message` event (text only) for TextHarnessBridge.
 * Sender identity follows the existing policy: the platform userId of the
 * sender, also in groups; a group event without a userId is dropped.
 */
export function normalizeLineEvent(event, botUserId) {
  if (event?.type !== 'message' || event.message?.type !== 'text' || event.mode === 'standby') return null;
  const conversation = conversationOf(event.source);
  const senderId = typeof event.source?.userId === 'string' ? event.source.userId : '';
  const messageId = typeof event.message.id === 'string' ? event.message.id : String(event.message.id ?? '');
  if (!conversation || !senderId || !messageId) return null;
  const direct = conversation.kind === 'direct';
  const mentioned = Array.isArray(event.message.mention?.mentionees)
    && event.message.mention.mentionees.some((entry) => entry?.isSelf === true || (botUserId && entry?.userId === botUserId));
  const target = { kind: conversation.kind, to: conversation.id };
  return {
    messageId,
    senderId,
    senderIsBot: senderId === botUserId,
    kind: conversation.kind,
    conversationId: conversation.id,
    content: direct ? String(event.message.text ?? '').trim() : stripLineSelfMention(event.message.text, event.message.mention, botUserId),
    plainText: true,
    images: [],
    files: [],
    addressed: direct || mentioned,
    contextSource: () => ({ chatId: conversation.id }),
    imSourceHint: {
      conversationId: conversation.id,
      messageId,
      ...(Number.isFinite(event.timestamp) ? { at: new Date(event.timestamp).toISOString() } : {}),
    },
    reactionTarget: null,
    replyTarget: {
      ...target,
      ...(typeof event.replyToken === 'string' && event.replyToken ? { replyToken: event.replyToken, receivedAt: Date.now() } : {}),
    },
    connectionTestTarget: target,
  };
}

/** Trusted source of a postback event (fields from the signed webhook only). */
export function linePostbackSource(event, botId) {
  const conversation = conversationOf(event?.source);
  if (!conversation) return null;
  return normalizeImSource({
    platform: 'line',
    botId,
    userId: event.source.userId,
    conversationId: conversation.id,
    conversationKind: conversation.kind,
    messageId: event.webhookEventId,
    ...(Number.isFinite(event.timestamp) ? { at: new Date(event.timestamp).toISOString() } : {}),
  });
}

export class LineBotClient {
  #api;
  #signal;
  #logger;
  #usedReplyTokens = new Map();

  constructor({ api, signal, logger = console }) {
    this.#api = api;
    this.#signal = signal;
    this.#logger = logger;
  }

  /** Claim a reply token once; later callers (or stale tokens) get null. */
  #claimReplyToken(target) {
    const token = target?.replyToken;
    if (typeof token !== 'string' || !token) return null;
    if (!Number.isFinite(target.receivedAt) || Date.now() - target.receivedAt > REPLY_TOKEN_TTL_MS) return null;
    if (this.#usedReplyTokens.has(token)) return null;
    this.#usedReplyTokens.set(token, Date.now());
    if (this.#usedReplyTokens.size > MAX_REMEMBERED_EVENTS) {
      this.#usedReplyTokens.delete(this.#usedReplyTokens.keys().next().value);
    }
    return token;
  }

  /**
   * Send messages: the first batch (≤ 5) by reply token when one is available,
   * everything else by push. A rejected reply (expired token, rate limit)
   * falls back to push with an idempotent retry key.
   */
  async sendMessages(target, messages, { idempotencyKey } = {}) {
    const to = typeof target?.to === 'string' ? target.to : '';
    if (!to) throw Object.assign(new TypeError('LINE target needs a user, group or room id'), { code: 'invalid-target' });
    const providerMessageIds = [];
    const batches = [];
    for (let index = 0; index < messages.length; index += LINE_MESSAGES_PER_REQUEST) {
      batches.push(messages.slice(index, index + LINE_MESSAGES_PER_REQUEST));
    }
    const collect = (result) => {
      for (const sent of Array.isArray(result?.sentMessages) ? result.sentMessages : []) {
        if (sent?.id) providerMessageIds.push(String(sent.id));
      }
    };
    for (const [index, batch] of batches.entries()) {
      const replyToken = index === 0 ? this.#claimReplyToken(target) : null;
      if (replyToken) {
        try {
          collect(await this.#api.reply({ replyToken, messages: batch, signal: this.#signal }));
          continue;
        } catch (error) {
          const status = Number(error?.status);
          if (!(status === 400 || status === 429)) throw error;
          this.#logger.warn?.(`[dsh-im:line] reply token rejected (HTTP ${status}); using push`);
        }
      }
      const retryKey = idempotencyKey ? lineRetryKey(`${idempotencyKey}:${index}`) : undefined;
      collect(await this.#api.push({ to, messages: batch, ...(retryKey ? { retryKey } : {}), signal: this.#signal }));
    }
    return { providerMessageIds };
  }

  async sendText(target, text, options = {}) {
    const chunks = splitMessageText(text, LINE_TEXT_LIMIT);
    if (chunks.length === 0) return { providerMessageIds: [] };
    return this.sendMessages(target, chunks.map((chunk) => ({ type: 'text', text: chunk })), options);
  }

  async sendTyping(target) {
    // The loading animation exists for one-to-one chats only.
    if (target?.kind !== 'direct' || !target.to) return;
    await this.#api.startLoading({ chatId: target.to, loadingSeconds: 20, signal: this.#signal });
  }
}

export function createLineRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    connectionState: 'idle',
    harnessReachable: false,
    lastCheckedAt: null,
    lastConnectedAt: null,
    lastWebhookAt: null,
    webhooksRejected: 0,
    lastError: null,
    ...createLineBridgeStatus(),
  };
}

export class LineRuntime {
  #config;
  #channelSecret;
  #channelAccessToken;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #createApi;
  #webhooks;
  #extensions;
  #status = createLineRuntimeStatus();
  #api = null;
  #bridge = null;
  #client = null;
  #abortController = null;
  #disposeWebhook = null;
  #disposeCardDriver = null;
  #handledEvents = new Set();
  #pending = new Set();

  constructor({
    config, secrets, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000, createApi = (options) => new LineApi(options),
    webhooks = defaultWebhookHub, extensions = imExtensions,
  }) {
    if (!config || !secrets?.channelSecret || !secrets?.channelAccessToken || !harness || !state) {
      throw new TypeError('LineRuntime requires config, channel secret, access token, Harness, and state');
    }
    this.#config = config;
    this.#channelSecret = secrets.channelSecret;
    this.#channelAccessToken = secrets.channelAccessToken;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger;
    this.#diagnostics = createConnectionDiagnostics({ channel: 'line', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#createApi = createApi;
    this.#webhooks = webhooks;
    this.#extensions = extensions;
  }

  get status() {
    return structuredClone(this.#status);
  }

  async start() {
    await this.stop();
    this.#status.startedAt = new Date().toISOString();
    this.#status.connectionState = 'connecting';
    this.#status.error = null;
    this.#status.lastError = null;
    this.#diagnostics.clear();
    try {
      await atConnectionStage('harness.check', () => this.#harness.ensureRunning());
      this.#status.harnessReachable = true;
      const controller = new AbortController();
      this.#abortController = controller;
      const api = this.#createApi({ channelAccessToken: this.#channelAccessToken, logger: this.#logger });
      this.#api = api;
      const info = await api.getBotInfo({ signal: controller.signal });
      if (info?.userId !== this.#config.platformId) {
        throw Object.assign(new Error('LINE access token identity does not match the saved bot'), { code: 'line-identity-mismatch' });
      }
      this.#client = new LineBotClient({ api, signal: controller.signal, logger: this.#logger });
      this.#bridge = new LineHarnessBridge({
        bot: this.#client,
        harness: this.#harness,
        state: this.#state,
        contextEnhancement: this.#contextEnhancement,
        accessPolicy: this.#accessPolicy,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        signal: controller.signal,
        botId: this.#config.botId,
        extensions: this.#extensions,
      });
      this.#disposeWebhook = this.#webhooks.register('line', this);
      this.#registerCardDriver(api, controller.signal);
      const now = Date.now();
      this.#status.ready = true;
      this.#status.connectionState = 'connected';
      this.#status.lastCheckedAt = now;
      this.#status.lastConnectedAt = now;
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.connectionState = 'failed';
      this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;
      await this.stop({ keepStatus: true });
      throw error;
    }
  }

  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#bridge) {
      throw Object.assign(new Error('LINE bot is not connected'), { code: 'test-target-unavailable' });
    }
    return this.#bridge.sendConnectionTest(text);
  }

  /** Proactive delivery target: { kind: 'user'|'group'|'room', route: { userId|groupId|roomId } }. */
  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#bridge) {
      throw Object.assign(new Error('LINE bot is not connected'), { code: 'bot-not-connected' });
    }
    const to = target?.route?.userId ?? target?.route?.groupId ?? target?.route?.roomId;
    if (typeof to !== 'string' || !to.trim()) {
      throw Object.assign(new TypeError('Invalid LINE proactive delivery target'), { code: 'invalid-target' });
    }
    return this.#bridge.sendProactiveText({ kind: target.kind === 'user' ? 'direct' : 'group', to: to.trim() }, text, options);
  }

  /** Webhook receiver: null when the signature is not this bot's. */
  async handleWebhook({ rawBody, headers }) {
    if (!this.#status.ready) return null;
    if (!verifyLineSignature(this.#channelSecret, rawBody, header(headers, 'x-line-signature'))) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      this.#status.webhooksRejected += 1;
      return { status: 400, body: { error: 'bad-request' } };
    }
    this.#status.lastWebhookAt = Date.now();
    this.#status.lastCheckedAt = Date.now();
    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const event of events) {
      const task = this.handleEvent(event).catch((error) => {
        this.#logger.error?.(`[dsh-im:line] bot ${this.#config.botId} event handling failed:`, extractConnectionEvidence(error).details);
      });
      this.#pending.add(task);
      void task.finally(() => this.#pending.delete(task));
    }
    // LINE expects a fast 200; events are processed asynchronously.
    return { status: 200, body: {} };
  }

  #firstTime(eventId) {
    if (typeof eventId !== 'string' || !eventId) return true;
    if (this.#handledEvents.has(eventId)) return false;
    this.#handledEvents.add(eventId);
    if (this.#handledEvents.size > MAX_REMEMBERED_EVENTS) this.#handledEvents.delete(this.#handledEvents.values().next().value);
    return true;
  }

  async handleEvent(event) {
    if (!event || typeof event !== 'object' || !this.#bridge) return;
    if (!this.#firstTime(event.webhookEventId)) return;
    if (event.type === 'message') {
      const message = normalizeLineEvent(event, this.#config.platformId);
      if (message) await this.#bridge.accept(message);
      return;
    }
    if (event.type === 'postback') await this.#handlePostback(event);
  }

  async #handlePostback(event) {
    const parsed = parseLinePostbackData(event.postback?.data);
    if (!parsed) return;
    const botId = this.#config.botId;
    const source = linePostbackSource(event, botId);
    if (!source) return;
    let actionId = parsed.actionId;
    let value = parsed.value;
    let messageRef = encodeMessageRef({ platform: 'line', botId, conversationId: source.conversationId, messageId: null });
    if (parsed.cardId) {
      const resolved = await this.#extensions.resolveCardAction(parsed.cardId, parsed.index).catch(() => null);
      if (!resolved || resolved.botId !== botId) return;
      ({ actionId, value } = resolved);
      messageRef = resolved.messageRef ?? messageRef;
    }
    const replyTarget = {
      kind: source.conversationKind,
      to: source.conversationId,
      ...(typeof event.replyToken === 'string' && event.replyToken ? { replyToken: event.replyToken, receivedAt: Date.now() } : {}),
    };
    await this.#extensions.dispatchAction({
      actionId,
      value,
      source,
      messageRef,
      respond: (text) => this.#client.sendText(replyTarget, text),
    });
  }

  #registerCardDriver(api, signal) {
    this.#disposeCardDriver?.();
    const botId = this.#config.botId;
    const client = this.#client;
    const actionMapping = (card) => card.actions.map(({ id, value }) => ({ id, value }));
    const needsStoredActions = (card) => card.actions.some((action, index) => {
      try { linePostbackData(action, index, null); return false; } catch { return true; }
    });
    this.#disposeCardDriver = this.#extensions.registerDriver(botId, {
      platform: 'line',
      sendCard: async (to, card, helpers) => {
        const conversationId = to.conversationId ?? to.userId;
        const cardId = needsStoredActions(card) ? helpers.newCardId() : null;
        const sending = client.sendMessages(
          { kind: to.conversationId ? 'group' : 'direct', to: conversationId },
          [lineFlexMessage(card, { cardId })],
          helpers.idempotencyKey ? { idempotencyKey: `card:${helpers.idempotencyKey}` } : {},
        ).then(async (sent) => {
          const messageRef = encodeMessageRef({
            platform: 'line', botId, conversationId, messageId: sent.providerMessageIds[0] ?? null,
          });
          if (cardId) await helpers.registerCardActions(cardId, { messageRef, actions: actionMapping(card) });
          return messageRef;
        });
        if (cardId) helpers.trackPendingCard(cardId, sending);
        return { messageRef: await sending };
      },
      // LINE messages cannot be edited: the updated card is pushed as a new message.
      updateCard: async (ref, card, helpers) => {
        if (!ref.conversationId) throw Object.assign(new Error('This LINE message cannot be updated'), { code: 'capability-unavailable' });
        const cardId = needsStoredActions(card) ? helpers.newCardId() : null;
        if (cardId) await helpers.registerCardActions(cardId, { messageRef: helpers.messageRef, actions: actionMapping(card) });
        await api.push({ to: ref.conversationId, messages: [lineFlexMessage(card, { cardId })], signal });
      },
    });
  }

  async stop({ keepStatus = false } = {}) {
    this.#disposeCardDriver?.();
    this.#disposeCardDriver = null;
    this.#disposeWebhook?.();
    this.#disposeWebhook = null;
    this.#abortController?.abort();
    this.#abortController = null;
    const bridge = this.#bridge;
    this.#bridge = null;
    this.#client = null;
    this.#api = null;
    await Promise.race([
      Promise.allSettled([...this.#pending, bridge?.waitForIdle() ?? Promise.resolve()]),
      new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref?.(); }),
    ]);
    this.#status.ready = false;
    if (!keepStatus) this.#status.connectionState = 'idle';
    return this.status;
  }

  /** Wait for in-flight webhook events (tests). */
  async idle() {
    await Promise.allSettled([...this.#pending]);
    await this.#bridge?.waitForIdle();
  }
}
