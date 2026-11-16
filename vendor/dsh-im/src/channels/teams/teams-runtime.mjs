// care fork: Microsoft Teams (Bot Framework) channel.
//
// Inbound: `POST /dsh-hooks/teams` → JWT verification (Bot Framework OpenID
// metadata / JWKS, RS256, iss, aud = App ID, exp, serviceUrl) → activity.
// Text messages go through TextHarnessBridge.accept() (claimReplies → access
// resolver → access policy → agent). Adaptive Card Action.Submit (message
// activity with `value`) and Action.Execute (`invoke` adaptiveCard/action) go
// to ctx.dshIm.onAction() handlers only.
// Outbound: app token (client credentials) → Bot Connector REST.
// ImSource: platform 'teams', userId = AAD object id, teamId = tenant id.

import { atConnectionStage, createConnectionDiagnostics, extractConnectionEvidence } from '../shared/connection-error.mjs';
import { splitMessageText } from '../shared/editable-message-stream.mjs';
import {
  ADAPTIVE_CARD_CONTENT_TYPE, cardPlainText, encodeMessageRef, parseTeamsActionData, teamsAdaptiveCard,
} from '../shared/im-card.mjs';
import { imExtensions, normalizeImSource } from '../shared/im-extensions.mjs';
import { webhookHub as defaultWebhookHub } from '../shared/webhook-hub.mjs';
import { BotFrameworkJwtVerifier, bearerToken, decodeJwt } from './teams-auth.mjs';
import { TEAMS_TEXT_LIMIT, TeamsConnector, TeamsReferenceStore } from './teams-api.mjs';
import { createTeamsBridgeStatus, TeamsHarnessBridge } from './teams-bridge.mjs';

const MAX_REMEMBERED_ACTIVITIES = 2_000;
const INVOKE_OK = Object.freeze({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: '' });

function header(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function decodeEntities(text) {
  return text
    .replaceAll('&nbsp;', ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

export function tenantOf(activity) {
  const value = activity?.channelData?.tenant?.id ?? activity?.conversation?.tenantId;
  return typeof value === 'string' && value ? value : null;
}

function conversationKind(activity) {
  return activity?.conversation?.conversationType === 'personal' || activity?.conversation?.isGroup === false
    ? 'direct' : 'group';
}

/** Strip the bot's own <at>…</at> mention(s) and HTML tags from Teams text. */
export function teamsPlainText(activity) {
  let text = typeof activity?.text === 'string' ? activity.text : '';
  const botId = activity?.recipient?.id;
  for (const entity of Array.isArray(activity?.entities) ? activity.entities : []) {
    if (entity?.type === 'mention' && entity.mentioned?.id === botId && typeof entity.text === 'string') {
      text = text.split(entity.text).join(' ');
    }
  }
  return decodeEntities(text.replace(/<[^>]{0,200}>/gu, ' ')).replace(/\s+/gu, ' ').trim();
}

/**
 * Normalize one Teams `message` activity for TextHarnessBridge. Sender
 * identity follows the existing policy: the AAD object id of the sender, also
 * in group chats and channels; an activity without one is dropped.
 */
export function normalizeTeamsActivity(activity) {
  if (activity?.type !== 'message') return null;
  const senderId = activity.from?.aadObjectId;
  const conversationId = activity.conversation?.id;
  const messageId = activity.id;
  if (typeof senderId !== 'string' || !senderId || typeof conversationId !== 'string' || typeof messageId !== 'string') return null;
  const kind = conversationKind(activity);
  const mentioned = (Array.isArray(activity.entities) ? activity.entities : [])
    .some((entity) => entity?.type === 'mention' && entity.mentioned?.id === activity.recipient?.id);
  const tenantId = tenantOf(activity);
  const target = {
    serviceUrl: activity.serviceUrl,
    conversationId,
    ...(kind === 'group' && activity.conversation?.conversationType === 'channel' ? { replyToId: activity.replyToId ?? messageId } : {}),
  };
  const content = teamsPlainText(activity);
  return {
    messageId,
    senderId,
    senderIsBot: activity.from?.id === activity.recipient?.id,
    kind,
    conversationId,
    content,
    plainText: true,
    images: [],
    files: [],
    addressed: kind === 'direct' || mentioned,
    contextSource: () => ({ chatId: conversationId }),
    imSourceHint: {
      ...(tenantId ? { teamId: tenantId } : {}),
      conversationId,
      messageId,
      ...(typeof activity.from?.name === 'string' ? { userName: activity.from.name } : {}),
      ...(typeof activity.timestamp === 'string' ? { at: activity.timestamp } : {}),
    },
    reactionTarget: null,
    replyTarget: target,
    connectionTestTarget: { serviceUrl: activity.serviceUrl, conversationId },
  };
}

/** Trusted source of a card action (from the verified activity only). */
export function teamsActionSource(activity, botId) {
  const tenantId = tenantOf(activity);
  return normalizeImSource({
    platform: 'teams',
    botId,
    ...(tenantId ? { teamId: tenantId } : {}),
    userId: activity?.from?.aadObjectId,
    userName: activity?.from?.name,
    conversationId: activity?.conversation?.id,
    conversationKind: conversationKind(activity),
    messageId: activity?.id,
    ...(typeof activity?.timestamp === 'string' ? { at: activity.timestamp } : {}),
  });
}

/** `{ actionId, value }` of an Action.Submit / Action.Execute activity, or null. */
export function teamsActionOf(activity) {
  if (activity?.type === 'invoke' && activity.name === 'adaptiveCard/action') {
    const action = activity.value?.action;
    return parseTeamsActionData(action?.data) ?? null;
  }
  if (activity?.type === 'message' && activity.value && typeof activity.value === 'object') {
    return parseTeamsActionData(activity.value);
  }
  return null;
}

export class TeamsBotClient {
  #connector;
  #signal;

  constructor({ connector, signal }) {
    this.#connector = connector;
    this.#signal = signal;
  }

  async sendActivity(target, activity) {
    if (!target?.serviceUrl || !target?.conversationId) {
      throw Object.assign(new TypeError('Teams target needs a serviceUrl and a conversation id'), { code: 'invalid-target' });
    }
    return this.#connector.sendActivity(target.serviceUrl, target.conversationId, activity, {
      ...(target.replyToId ? { replyToId: target.replyToId } : {}),
      signal: this.#signal,
    });
  }

  async sendText(target, text) {
    const providerMessageIds = [];
    for (const chunk of splitMessageText(text, TEAMS_TEXT_LIMIT)) {
      const result = await this.sendActivity(target, { type: 'message', text: chunk, textFormat: 'markdown' });
      if (typeof result?.id === 'string' && result.id) providerMessageIds.push(result.id);
    }
    return { providerMessageIds };
  }

  async sendTyping(target) {
    await this.sendActivity({ ...target, replyToId: undefined }, { type: 'typing' });
  }
}

export function createTeamsRuntimeStatus() {
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
    ...createTeamsBridgeStatus(),
  };
}

export class TeamsRuntime {
  #config;
  #appPassword;
  #harness;
  #state;
  #contextEnhancement;
  #accessPolicy;
  #logger;
  #diagnostics;
  #replyTimeoutMs;
  #createConnector;
  #verifier;
  #references;
  #webhooks;
  #extensions;
  #allowedChannelIds;
  #status = createTeamsRuntimeStatus();
  #connector = null;
  #client = null;
  #bridge = null;
  #abortController = null;
  #disposeWebhook = null;
  #disposeCardDriver = null;
  #handled = new Set();
  #pending = new Set();

  constructor({
    config, secrets, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000,
    createConnector = (options) => new TeamsConnector(options),
    verifier = new BotFrameworkJwtVerifier(),
    references = new TeamsReferenceStore(null),
    webhooks = defaultWebhookHub,
    extensions = imExtensions,
    allowedChannelIds = ['msteams'],
  }) {
    if (!config?.platformId || !secrets?.appPassword || !harness || !state) {
      throw new TypeError('TeamsRuntime requires config, App ID, app password, Harness, and state');
    }
    this.#config = config;
    this.#appPassword = secrets.appPassword;
    this.#harness = harness;
    this.#state = state;
    this.#contextEnhancement = contextEnhancement;
    this.#accessPolicy = accessPolicy;
    this.#logger = logger;
    this.#diagnostics = createConnectionDiagnostics({ channel: 'teams', logger });
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#createConnector = createConnector;
    this.#verifier = verifier;
    this.#references = references;
    this.#webhooks = webhooks;
    this.#extensions = extensions;
    this.#allowedChannelIds = allowedChannelIds;
  }

  get status() {
    return structuredClone(this.#status);
  }

  get appId() {
    return this.#config.platformId;
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
      const connector = this.#createConnector({
        appId: this.#config.platformId,
        appPassword: this.#appPassword,
        tenantId: this.#config.tenantId ?? null,
        logger: this.#logger,
      });
      // Validates the credentials (and the tenant) before the bot reports ready.
      await connector.tokens.token({ signal: controller.signal });
      this.#connector = connector;
      this.#client = new TeamsBotClient({ connector, signal: controller.signal });
      this.#bridge = new TeamsHarnessBridge({
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
      this.#disposeWebhook = this.#webhooks.register('teams', this);
      this.#registerCardDriver(controller.signal);
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
      throw Object.assign(new Error('Teams bot is not connected'), { code: 'test-target-unavailable' });
    }
    return this.#bridge.sendConnectionTest(text);
  }

  /** Proactive delivery target: { kind: 'conversation', route: { conversationId } }. */
  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#bridge) {
      throw Object.assign(new Error('Teams bot is not connected'), { code: 'bot-not-connected' });
    }
    const conversationId = target?.route?.conversationId;
    const reference = typeof conversationId === 'string' ? this.#references.conversation(conversationId) : null;
    if (!reference) {
      throw Object.assign(new TypeError('Unknown Teams conversation (the bot has not received a message there yet)'), { code: 'invalid-target' });
    }
    return this.#bridge.sendProactiveText({ serviceUrl: reference.serviceUrl, conversationId }, text, options);
  }

  /** Webhook receiver: null when the token is not addressed to this App ID. */
  async handleWebhook({ rawBody, headers }) {
    if (!this.#status.ready) return null;
    const token = bearerToken(header(headers, 'authorization'));
    const claims = token ? decodeJwt(token)?.payload : null;
    const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (!audiences.includes(this.#config.platformId)) return null;
    let activity;
    try {
      activity = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      this.#status.webhooksRejected += 1;
      return { status: 400, body: { error: 'bad-request' } };
    }
    try {
      await this.#verifier.verify(token, {
        appId: this.#config.platformId,
        serviceUrl: activity?.serviceUrl,
        channelId: activity?.channelId,
      });
    } catch (error) {
      this.#status.webhooksRejected += 1;
      this.#logger.warn?.(`[dsh-im:teams] rejected an activity: ${error?.code ?? error?.message ?? error}`);
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (!this.#allowedChannelIds.includes(activity?.channelId)) return { status: 200, body: {} };
    if (this.#config.tenantId && tenantOf(activity) !== this.#config.tenantId) {
      this.#status.webhooksRejected += 1;
      return { status: 403, body: { error: 'tenant-not-allowed' } };
    }
    this.#status.lastWebhookAt = Date.now();
    this.#status.lastCheckedAt = Date.now();
    await this.#references.remember(activity).catch((error) => {
      this.#logger.warn?.('[dsh-im:teams] could not store a conversation reference:', error?.message ?? error);
    });
    const task = this.handleActivity(activity).catch((error) => {
      this.#logger.error?.(`[dsh-im:teams] bot ${this.#config.botId} activity handling failed:`, extractConnectionEvidence(error).details);
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    if (activity?.type === 'invoke') return { status: 200, body: INVOKE_OK };
    return { status: 200, body: {} };
  }

  #firstTime(id) {
    if (typeof id !== 'string' || !id) return true;
    if (this.#handled.has(id)) return false;
    this.#handled.add(id);
    if (this.#handled.size > MAX_REMEMBERED_ACTIVITIES) this.#handled.delete(this.#handled.values().next().value);
    return true;
  }

  async handleActivity(activity) {
    if (!this.#bridge || !activity || typeof activity !== 'object') return;
    const action = teamsActionOf(activity);
    if (action) {
      if (!this.#firstTime(`action:${activity.id}`)) return;
      await this.#dispatchAction(activity, action);
      return;
    }
    if (activity.type !== 'message') return;
    const message = normalizeTeamsActivity(activity);
    if (message && message.content) await this.#bridge.accept(message);
  }

  async #dispatchAction(activity, { actionId, value, inputText }) {
    const botId = this.#config.botId;
    const source = teamsActionSource(activity, botId);
    if (!source) return;
    const cardActivityId = activity.replyToId ?? activity.value?.messageId ?? null;
    const target = { serviceUrl: activity.serviceUrl, conversationId: source.conversationId };
    await this.#extensions.dispatchAction({
      actionId,
      value,
      source,
      messageRef: encodeMessageRef({ platform: 'teams', botId, conversationId: source.conversationId, messageId: cardActivityId }),
      respond: (text) => this.#client.sendText(target, text),
      ...(inputText ? { inputText } : {}),
    });
  }

  async #targetFor(to, signal) {
    if (to.conversationId) {
      const reference = this.#references.conversation(to.conversationId);
      if (!reference) throw Object.assign(new Error('Unknown Teams conversation'), { code: 'invalid-target' });
      return { serviceUrl: reference.serviceUrl, conversationId: to.conversationId };
    }
    const user = this.#references.user(to.userId);
    if (!user) {
      throw Object.assign(new Error('This Teams user has not messaged the bot yet'), { code: 'invalid-target' });
    }
    if (user.conversationId) return { serviceUrl: user.serviceUrl, conversationId: user.conversationId };
    const created = await this.#connector.createConversation(user.serviceUrl, {
      botId: `28:${this.#config.platformId}`, memberId: user.userId, tenantId: user.tenantId,
    }, { signal });
    return { serviceUrl: user.serviceUrl, conversationId: created.id };
  }

  #registerCardDriver(signal) {
    this.#disposeCardDriver?.();
    const botId = this.#config.botId;
    const cardActivity = (card) => ({
      type: 'message',
      summary: card.title,
      attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: teamsAdaptiveCard(card) }],
    });
    this.#disposeCardDriver = this.#extensions.registerDriver(botId, {
      platform: 'teams',
      sendCard: async (to, card) => {
        const target = await this.#targetFor(to, signal);
        const result = await this.#connector.sendActivity(target.serviceUrl, target.conversationId, cardActivity(card), { signal });
        if (typeof result?.id !== 'string' || !result.id) {
          throw Object.assign(new Error('Teams did not return an activity id'), { code: 'send-result-unknown' });
        }
        return { messageRef: encodeMessageRef({ platform: 'teams', botId, conversationId: target.conversationId, messageId: result.id }) };
      },
      updateCard: async (ref, card) => {
        const reference = ref.conversationId ? this.#references.conversation(ref.conversationId) : null;
        if (!reference) throw Object.assign(new Error('Unknown Teams conversation'), { code: 'capability-unavailable' });
        if (ref.messageId) {
          await this.#connector.updateActivity(reference.serviceUrl, ref.conversationId, ref.messageId, cardActivity(card), { signal });
        } else {
          await this.#connector.sendActivity(reference.serviceUrl, ref.conversationId, cardActivity(card), { signal });
        }
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
    this.#connector = null;
    await Promise.race([
      Promise.allSettled([...this.#pending, bridge?.waitForIdle() ?? Promise.resolve()]),
      new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref?.(); }),
    ]);
    this.#status.ready = false;
    if (!keepStatus) this.#status.connectionState = 'idle';
    return this.status;
  }

  async idle() {
    await Promise.allSettled([...this.#pending]);
    await this.#bridge?.waitForIdle();
  }
}

export { cardPlainText as teamsCardText };
