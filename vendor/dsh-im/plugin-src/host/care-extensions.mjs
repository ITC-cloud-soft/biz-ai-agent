// care fork: Host wiring for the additional ctx.dshIm API (AI_PLANE_CONTRACTS §1).
//
// Kept in its own module so the upstream index.mjs only gains a few lines.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { imExtensions } from '../../src/channels/shared/im-extensions.mjs';

export const CARE_EXTENSIONS_VERSION = 1;
export const DEFAULT_DELIVERY_STORE = ['integrations', 'dsh-im', 'care-delivery.json'];

/** 'closed' unless the profile explicitly opts back into upstream's open defaults. */
export function accessDefaultFor(config = {}) {
  const value = config.accessDefault ?? process.env.DSH_IM_ACCESS_DEFAULT;
  return value === 'legacy-open' || value === 'legacy' ? 'legacy' : 'closed';
}

export function deliveryStorePath(config = {}) {
  if (typeof config.deliveryStorePath === 'string' && config.deliveryStorePath) return resolve(config.deliveryStorePath);
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return resolve(dshHome, ...DEFAULT_DELIVERY_STORE);
}

const CHANNEL_ALIASES = Object.freeze({ wecomApp: 'wecom-app' });

/**
 * Build the proactive-delivery draft target a text-only card falls back to.
 * `to.userId` means a private chat; `to.conversationId` the conversation itself.
 */
export function fallbackDraftTarget(channel, to = {}) {
  const user = to.userId;
  const conversation = to.conversationId;
  const either = conversation ?? user;
  switch (CHANNEL_ALIASES[channel] ?? channel) {
    case 'weixin': return { kind: 'user', route: { toUserId: user ?? conversation } };
    case 'feishu': return user && !conversation ? { kind: 'user', route: { openId: user } } : { kind: 'group', route: { chatId: conversation } };
    case 'dingtalk': return user && !conversation ? { kind: 'user', route: { userId: user } } : { kind: 'group', route: { openConversationId: conversation } };
    case 'wecom': return { kind: user && !conversation ? 'user' : 'group', route: { chatId: either } };
    case 'wecom-app': return { kind: 'user', route: { chatId: either } };
    case 'qq': return user && !conversation ? { kind: 'user', route: { userOpenId: user } } : { kind: 'group', route: { groupOpenId: conversation } };
    case 'slack': return conversation ? { kind: 'conversation', route: { channelId: conversation } } : null;
    case 'telegram': return { kind: 'chat', route: { chatId: String(either) } };
    // care fork: a Discord user id is delivered through that user's DM channel (users.createDM).
    case 'discord': return conversation ? { kind: 'channel', route: { channelId: conversation } } : user ? { kind: 'user', route: { userId: user } } : null;
    case 'whatsapp': return { kind: String(either).endsWith('@g.us') ? 'group' : 'user', route: { jid: either } };
    // care fork: macOS Messages sends to the buddy named by the last `;` segment of
    // the chat GUID (MacOSMessagesApi.sendText), so the sender handle (ImSource userId)
    // and its DM GUID (`iMessage;-;<handle>`) reach the same person. A group GUID
    // (`;+;`) cannot be addressed that way.
    case 'imessage': return /;\+;/u.test(String(either)) ? null : { kind: 'user', route: { chatGuid: either } };
    case 'email': return { kind: 'user', route: { address: either } };
    case 'matrix': return user && !conversation ? { kind: 'dm', route: { userId: user } } : { kind: 'room', route: { roomId: conversation } };
    // care fork: LINE ids carry their kind in the first letter (U user / C group / R room).
    case 'line': {
      const id = String(either ?? '');
      return { kind: id.startsWith('C') ? 'group' : id.startsWith('R') ? 'room' : 'user', route: { [id.startsWith('C') ? 'groupId' : id.startsWith('R') ? 'roomId' : 'userId']: id } };
    }
    case 'teams': return conversation ? { kind: 'conversation', route: { conversationId: conversation } } : null;
    default: return null;
  }
}

function isPlainTo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'kind' in value || 'route' in value) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => (key === 'userId' || key === 'conversationId') && typeof value[key] === 'string' && value[key].trim());
}

/**
 * Configure the shared hub for this Host and return the methods appended to
 * the `dshIm` service.
 */
export function installCareExtensions(ctx, config, deliveryService, { extensions = imExtensions, logger = console } = {}) {
  extensions.configure({
    accessDefault: accessDefaultFor(config),
    storePath: deliveryStorePath(config),
    retentionDays: Number(config.deliveryRetentionDays) || undefined,
    logger,
  });
  const emitter = (ctx?.root && typeof ctx.root.emit === 'function') ? ctx.root : ctx;
  if (typeof emitter?.emit === 'function') {
    extensions.setInboundEmitter((event) => emitter.emit('dsh-im/inbound', event));
  }
  const draftFor = async (botId, to) => {
    const bots = await deliveryService.listBots();
    const channel = bots.find((bot) => bot.botId === botId)?.channel;
    if (!channel) throw Object.assign(new Error('Unknown bot'), { code: 'unknown-bot' });
    const draft = fallbackDraftTarget(channel, to);
    if (!draft || Object.values(draft.route).some((value) => typeof value !== 'string' || !value)) {
      throw Object.assign(new Error(`A ${channel} card needs a conversation id`), { code: 'invalid-target' });
    }
    return { channel, draft };
  };
  extensions.setFallbackSender(async (botId, to, text) => {
    const { channel, draft } = await draftFor(botId, to);
    await deliveryService.send(botId, draft, text, { transient: true });
    return { platform: channel, conversationId: Object.values(draft.route)[0] };
  });
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => extensions.reset(), 'dsh-im: care extensions');
  }

  // care fork (shared bots): `applicationId` names the business application a
  // proactive message comes from; the conversation router may prefix it and
  // remember the notification so that a reply returns to that application.
  const routeOutbound = (botId, targetId, text, applicationId) => {
    if (!extensions.hasConversationRouter?.() || typeof text !== 'string') return text;
    const route = targetId && typeof targetId === 'object' ? targetId.route : null;
    const userId = route?.toUserId ?? route?.userId ?? route?.chatId ?? null;
    return extensions.decorateOutbound({
      botId,
      targetId: typeof targetId === 'string' ? targetId : null,
      to: typeof userId === 'string' && userId ? { userId } : null,
      text,
      applicationId: typeof applicationId === 'string' && applicationId ? applicationId : null,
      kind: 'text',
    });
  };
  const send = async (botId, rawTarget, rawText, rawOptions) => {
    // care fork: `{ userId }` / `{ conversationId }` (the sendCard `to` shape) is
    // resolved to the channel's draft target, so a linked user can be reached
    // without a saved delivery target. Strings and `{ kind, route }` are unchanged.
    const targetId = isPlainTo(rawTarget) ? (await draftFor(botId, rawTarget)).draft : rawTarget;
    const { applicationId, ...plainOptions } = rawOptions ?? {};
    const options = rawOptions === undefined ? undefined : plainOptions;
    const text = routeOutbound(botId, targetId, rawText, applicationId);
    if (options?.idempotencyKey === undefined) return deliveryService.send(botId, targetId, text, options);
    const { idempotencyKey, ...rest } = options;
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 400) {
      throw Object.assign(new Error('idempotencyKey must be a non-empty string'), { code: 'bad-request' });
    }
    const { value, deduped } = await extensions.once(
      `send:${botId}:${idempotencyKey.trim()}`,
      () => deliveryService.send(botId, targetId, text, rest),
    );
    return { ...(value ?? { sent: true }), deduped };
  };

  return Object.freeze({
    careExtensionsVersion: CARE_EXTENSIONS_VERSION,
    send,
    sourceForTurn: (sessionId) => extensions.sourceForTurn(sessionId),
    setAccessResolver: (fn) => extensions.setAccessResolver(fn),
    sendCard: (input) => extensions.sendCard(input),
    updateCard: (messageRef, card) => extensions.updateCard(messageRef, card),
    onAction: (prefix, handler) => extensions.onAction(prefix, handler),
    claimReplies: (matcher, handler) => extensions.claimReplies(matcher, handler),
    // care fork: rewrite the agent's final answer of an IM turn before it is sent (e.g. bridge-identity's link guard).
    setAnswerFilter: (filter) => extensions.setAnswerFilter(filter),
    // care fork (shared bots): per-conversation business application, see im-extensions.mjs.
    setConversationRouter: (router) => extensions.setConversationRouter(router),
  });
}

/** Turn boundaries from `session/event`, so a finished turn forgets its source. */
export function trackTurnSources(sessionId, event, extensions = imExtensions) {
  const turn = event?.data?.turn;
  if (event?.type === 'turn/start') extensions.bindTurn(sessionId, turn);
  else if (event?.type === 'turn/end') extensions.endTurn(sessionId, turn);
}
