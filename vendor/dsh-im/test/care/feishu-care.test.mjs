// care fork: Feishu / Lark in the care integration, like every other platform:
// inbound gate (router → claims → resolver → channel policy → agent), link codes
// claimed in DMs only, the ImSource shape and the turn source, resolver verdicts
// replacing the default-closed owner/allowlist rule, native interactive cards
// whose buttons reach onAction, proactive send to an open_id with idempotency
// per bot, and several Feishu / Lark apps on one DSH kept apart. Every Feishu
// endpoint is a mock; nothing touches the network.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { fallbackDraftTarget, installCareExtensions } from '../../plugin-src/host/care-extensions.mjs';
import { normalizeDeliveryTarget } from '../../plugin-src/host/delivery-adapter.mjs';
import { FeishuHarnessBridge } from '../../src/channels/feishu/bridge.mjs';
import { FEISHU_CARE_INPUT_NAME, feishuCareCard } from '../../src/channels/feishu/feishu-cards.mjs';
import { FeishuRuntime } from '../../src/channels/feishu/feishu-runtime.mjs';
import { decodeMessageRef } from '../../src/channels/shared/im-card.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../src/channels/shared/inbound-access.mjs';
import { imExtensions } from '../../src/channels/shared/im-extensions.mjs';
import {
  eventually, policyProvider, quiet, scope, settle, stateFixture, useHub,
} from './support.mjs';

const LINK_CODE = /^連携\s*\d{6}$/u;
const TENANT = 'tenant_care_1';
const APPROVAL_CARD = {
  title: '承認依頼',
  fields: [{ label: '申請', value: '休暇 10/30' }],
  body: '山田さんの休暇申請です。',
  actions: [
    { id: 'care.approve', label: '承認', style: 'primary', value: 'req-7' },
    { id: 'care.reject', label: '却下', style: 'danger', value: 'req-7' },
  ],
  link: { label: '詳細', url: 'https://care.example/requests/7' },
  textFallback: '承認は「承認 123456」と返信してください',
};

/** A Feishu OpenAPI client double that records every call. */
function feishuClient(calls = []) {
  let sequence = 0;
  const record = (method) => async (request) => {
    sequence += 1;
    calls.push({ method, request });
    if (method === 'patch' && calls.failPatch) return { code: 230031, msg: 'message too old' };
    if (method === 'create' && calls.failForm && String(request?.data?.content ?? '').includes('"tag":"form"')) return { code: 230099, msg: 'parse json err' };
    const receiveType = request?.params?.receive_id_type;
    const chatId = receiveType === 'chat_id' ? request.data.receive_id : `oc_dm_${request?.data?.receive_id ?? 'x'}`;
    return { code: 0, data: { message_id: `om_out_${sequence}`, chat_id: chatId } };
  };
  return {
    calls,
    im: {
      v1: {
        message: {
          create: record('create'), reply: record('reply'), patch: record('patch'), update: record('update'),
          delete: record('delete'),
        },
        messageReaction: { create: async () => ({ code: 0, data: { reaction_id: 'r1' } }), delete: async () => ({ code: 0 }) },
      },
    },
  };
}

function textsOf(calls) {
  return calls.filter((call) => call.request?.data?.msg_type === 'text').map((call) => JSON.parse(call.request.data.content).text);
}

/** One im.message.receive_v1 event as the SDK hands it over (v2 header flattened). */
function messageEvent(text, { id, from = 'ou_staff', chat = 'oc_dm_staff', group = false, mention = false } = {}) {
  return {
    event_id: `ev_${id}`,
    tenant_key: TENANT,
    app_id: 'cli_care',
    sender: { sender_type: 'user', sender_id: { open_id: from, user_id: `u_${from}`, union_id: `on_${from}` }, tenant_key: TENANT },
    message: {
      message_id: id,
      chat_id: group ? 'oc_group_1' : chat,
      chat_type: group ? 'group' : 'p2p',
      message_type: 'text',
      create_time: '1798000000000',
      content: JSON.stringify({ text: mention ? `@_user_1 ${text}` : text }),
      ...(mention ? { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'care' }] } : {}),
    },
  };
}

function orderedHarness(log) {
  const asked = [];
  return {
    asked,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (sessionId, prompt) => {
        log.push('agent');
        asked.push({ sessionId, prompt, source: imExtensions.sourceForTurn(sessionId) });
        return '了解しました';
      },
    },
  };
}

function bridgeFixture(log, { botId = 'feishu_care', policy } = {}) {
  const { harness, asked } = orderedHarness(log);
  const { state } = stateFixture();
  const client = feishuClient();
  const bridge = new FeishuHarnessBridge({
    client,
    channel: {},
    harness,
    state,
    status: {},
    botId,
    appId: 'cli_care',
    botOpenId: 'ou_bot',
    logger: quiet,
    accessPolicy: policy ?? policyProvider(botId, { direct: scope('allowlist', []), group: scope('allowlist', []), privileged: ['ou_owner'] }),
  });
  return { bridge, client, asked };
}

test('Feishu: router → claims → resolver → agent, link code in DMs only, ImSource shape and turn source', async (t) => {
  const { hub, inbound } = await useHub(t);
  const log = [];
  const claimed = [];
  const resolved = [];
  hub.setConversationRouter({ route: ({ source }) => { log.push('router'); assert.ok(source.userId); return null; } });
  hub.claimReplies((text, source) => {
    log.push('claim');
    return source.conversationKind === 'direct' && LINK_CODE.test(text);
  }, async ({ source, reply }) => {
    claimed.push(source);
    await reply('連携しました');
  });
  hub.setAccessResolver(async (source) => {
    log.push('resolver');
    resolved.push(source);
    return source.userId === 'ou_staff' ? 'allow' : { deny: true, reply: '未連携です' };
  });
  const { bridge, client, asked } = bridgeFixture(log);

  // 1) An unlinked user's link code in a DM is claimed: no resolver, no agent.
  await bridge.accept(messageEvent('連携 123456', { id: 'om_1', from: 'ou_new', chat: 'oc_dm_new' }));
  await eventually(() => claimed.length === 1);
  assert.deepEqual(log, ['router', 'claim']);
  assert.equal(claimed[0].userId, 'ou_new');
  assert.equal(claimed[0].conversationKind, 'direct');
  await eventually(() => textsOf(client.calls).includes('連携しました'));
  // The reply answers the claimed message itself.
  assert.equal(client.calls.find((call) => call.method === 'reply').request.path.message_id, 'om_1');

  // 2) The same code in a group (mentioning the bot) is not a link request: the resolver denies it.
  log.length = 0;
  await bridge.accept(messageEvent('連携 654321', { id: 'om_2', from: 'ou_new', group: true, mention: true }));
  await eventually(() => resolved.length === 1);
  await settle();
  assert.deepEqual(log, ['router', 'claim', 'resolver']);
  assert.equal(claimed.length, 1);
  assert.equal(resolved[0].conversationKind, 'group');
  assert.equal(resolved[0].conversationId, 'oc_group_1');
  assert.ok(textsOf(client.calls).includes('未連携です'));
  assert.equal(asked.length, 0);

  // 3) A linked user (not on any allowlist, not the owner) reaches the agent with the turn source.
  log.length = 0;
  await bridge.accept(messageEvent('今日の予定は？', { id: 'om_3' }));
  await eventually(() => asked.length === 1);
  assert.deepEqual(log, ['router', 'claim', 'resolver', 'agent']);
  assert.equal(asked[0].prompt.includes('今日の予定は？') || JSON.stringify(asked[0].prompt).includes('今日の予定は？'), true);
  assert.deepEqual(asked[0].source, {
    platform: 'feishu',
    botId: 'feishu_care',
    teamId: TENANT,
    userId: 'ou_staff',
    conversationId: 'oc_dm_staff',
    conversationKind: 'direct',
    messageId: 'om_3',
    at: new Date(1798000000000).toISOString(),
  });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].source.userId, 'ou_staff');
  assert.equal(inbound[0].text, '今日の予定は？');
  await bridge.waitForIdle();
  // The turn source is released when the ask completes.
  assert.equal(hub.sourceForTurn('session-1'), null);
});

test('Feishu: the gate serializes one conversation even with a slow resolver', async (t) => {
  const { hub } = await useHub(t);
  const log = [];
  let first = true;
  hub.setAccessResolver(async () => {
    if (first) {
      first = false;
      await settle(60);
    }
    return 'allow';
  });
  const { bridge, asked } = bridgeFixture(log);
  void bridge.accept(messageEvent('一通目', { id: 'om_a' }));
  void bridge.accept(messageEvent('二通目', { id: 'om_b' }));
  await eventually(() => asked.length === 2);
  assert.deepEqual(asked.map((entry) => entry.source.messageId), ['om_a', 'om_b']);
  await bridge.waitForIdle();
});

test('Feishu: resolver verdicts replace the default-closed owner/allowlist rule', async (t) => {
  const { hub } = await useHub(t);
  const log = [];
  // No resolver: default-closed admits only the owner (privileged) — not ou_staff.
  const { bridge, client, asked } = bridgeFixture(log);
  await bridge.accept(messageEvent('こんにちは', { id: 'om_c1' }));
  await settle();
  assert.equal(asked.length, 0);
  await bridge.accept(messageEvent('こんにちは', { id: 'om_c2', from: 'ou_owner', chat: 'oc_dm_owner' }));
  await eventually(() => asked.length === 1);
  assert.equal(asked[0].source.userId, 'ou_owner');

  // With a resolver, 'allow' admits a user outside the allowlist ...
  const verdicts = new Map([['ou_staff', 'allow'], ['ou_gone', { deny: true, reply: '利用できません' }]]);
  const dispose = hub.setAccessResolver((source) => verdicts.get(source.userId) ?? 'deny');
  await bridge.accept(messageEvent('予定を教えて', { id: 'om_c3' }));
  await eventually(() => asked.length === 2);
  assert.equal(asked[1].source.userId, 'ou_staff');
  // ... but command permission still follows the channel policy.
  await bridge.accept(messageEvent('/status', { id: 'om_c4' }));
  await eventually(() => textsOf(client.calls).includes(COMMAND_PERMISSION_DENIED_MESSAGE));
  assert.equal(asked.length, 2);
  // A deny (with reply) blocks even a sender the policy would admit ... and replies.
  await bridge.accept(messageEvent('こんにちは', { id: 'om_c5', from: 'ou_gone', chat: 'oc_dm_gone' }));
  await eventually(() => textsOf(client.calls).includes('利用できません'));
  // A plain deny also blocks the owner: the resolver decides membership.
  await bridge.accept(messageEvent('こんにちは', { id: 'om_c6', from: 'ou_owner', chat: 'oc_dm_owner' }));
  await settle();
  assert.equal(asked.length, 2);
  dispose();
  await bridge.waitForIdle();
});

test('Feishu: a reply quoting a care card does not bring the card into the prompt', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const log = [];
  const { bridge, client, asked } = bridgeFixture(log);
  const helpers = { newCardId: () => 'cardQuote01', registerCardActions: async () => undefined };
  const { messageRef } = await bridge.sendCareCard({ userId: 'ou_staff' }, { title: '通知', fields: [], actions: [] }, helpers, { botId: 'feishu_care' });
  const ref = decodeMessageRef(messageRef);
  // Feishu returns the quoted message's content when the bridge loads a reply reference.
  client.im.v1.message.get = async ({ path }) => ({ code: 0, data: { items: [{
    message_id: path.message_id, chat_id: ref.conversationId, msg_type: 'text',
    body: { content: JSON.stringify({ text: `引用本文 ${path.message_id}` }) },
  }] } });
  // The hub remembers card messages it sent through a driver.
  hub.registerDriver('feishu_care', { platform: 'feishu', sendCard: async () => ({ messageRef }) });
  await hub.sendCard({ botId: 'feishu_care', to: { userId: 'ou_staff' }, card: { title: '通知' }, idempotencyKey: 'quote-1' });
  const reply = (id, parent) => {
    const event = messageEvent('これは何？', { id, chat: ref.conversationId });
    event.message.parent_id = parent;
    event.message.root_id = parent;
    return event;
  };
  // Control: a reply to an ordinary message keeps its quote.
  await bridge.accept(reply('om_q0', 'om_plain'));
  await eventually(() => asked.length === 1);
  assert.equal(JSON.stringify(asked[0].prompt).includes('引用本文 om_plain'), true);
  await bridge.accept(reply('om_q1', ref.messageId));
  await eventually(() => asked.length === 2);
  assert.equal(JSON.stringify(asked[1].prompt).includes('引用本文'), false);
  assert.equal(JSON.stringify(asked[1].prompt).includes('これは何？'), true);
  await bridge.waitForIdle();
});

// ── native interactive cards through the runtime ─────────────────────────────

function fakeLark() {
  const clients = [];
  const runtimes = [];
  class Client {
    constructor(options) {
      this.options = options;
      Object.assign(this, feishuClient());
      clients.push(this);
    }
  }
  class EventDispatcher {
    register(handlers) { this.handlers = handlers; return this; }
  }
  class WSClient {
    constructor(options) { this.options = options; this.state = 'idle'; runtimes.push(this); }
    async start({ eventDispatcher } = {}) {
      this.dispatcher = eventDispatcher;
      this.state = 'connected';
      queueMicrotask(() => this.options.onReady());
    }
    getConnectionStatus() { return { state: this.state }; }
    close() { this.state = 'closed'; }
  }
  return {
    clients,
    sockets: runtimes,
    lark: {
      Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
      LoggerLevel: { info: 'info' },
      Client,
      EventDispatcher,
      WSClient,
      defaultHttpInstance: null,
    },
  };
}

async function startRuntime(fake, { botId, domain = 'feishu', appId = `cli_${botId}` }) {
  const runtime = new FeishuRuntime({
    lark: fake.lark,
    botId,
    appId,
    appSecret: 'test-secret',
    domain,
    botOpenId: `ou_bot_${botId}`,
    ownerOpenIds: ['ou_owner'],
    harness: { ensureRunning: async () => true },
    state: { hasSeen: () => false, markSeen: async () => undefined, sessionFor: () => null },
    accessPolicy: policyProvider(botId, { direct: scope('allowlist', []), group: scope('allowlist', []) }),
    slashCommands: false,
    logger: quiet,
  });
  await runtime.start();
  const index = fake.sockets.length - 1;
  return { runtime, client: fake.clients[index], socket: fake.sockets[index] };
}

function cardPress(value, { operator = 'ou_staff', messageId, chatId, eventId = 'ev_press_1' } = {}) {
  return {
    schema: '2.0',
    event_id: eventId,
    tenant_key: TENANT,
    app_id: 'cli_care',
    operator: { open_id: operator, user_id: `u_${operator}`, tenant_key: TENANT },
    action: { tag: 'button', value },
    context: { open_message_id: messageId, open_chat_id: chatId },
  };
}

function careButtons(content) {
  const card = JSON.parse(content);
  const buttons = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.tag === 'button') buttons.push(value);
    Object.values(value).forEach(visit);
  };
  visit(card.body.elements);
  return { card, buttons };
}

test('Feishu card driver: interactive card, button → onAction (no resolver, no agent), updateCard patches', async (t) => {
  const { hub } = await useHub(t);
  const fake = fakeLark();
  const { runtime, client, socket } = await startRuntime(fake, { botId: 'feishu_care' });
  t.after(() => runtime.stop());
  assert.equal(typeof hub.driverFor('feishu_care')?.sendCard, 'function');
  let resolverCalls = 0;
  hub.setAccessResolver(() => { resolverCalls += 1; return 'deny'; });
  const presses = [];
  hub.onAction('care.', async (event) => {
    presses.push(event);
    await event.respond('承認しました');
  });

  const sent = await hub.sendCard({ botId: 'feishu_care', to: { userId: 'ou_staff' }, card: APPROVAL_CARD, idempotencyKey: 'approval:7' });
  assert.equal(sent.deduped, false);
  const create = client.calls.find((call) => call.method === 'create');
  assert.deepEqual(create.request.params, { receive_id_type: 'open_id' });
  assert.equal(create.request.data.receive_id, 'ou_staff');
  assert.equal(create.request.data.msg_type, 'interactive');
  const { card, buttons } = careButtons(create.request.data.content);
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.title.content, '承認依頼');
  assert.deepEqual(buttons.map((button) => [button.text.content, button.type]), [['承認', 'primary'], ['却下', 'danger'], ['詳細', 'default']]);
  assert.deepEqual(buttons[2].behaviors, [{ type: 'open_url', default_url: 'https://care.example/requests/7' }]);
  const callback = buttons[0].behaviors[0];
  assert.equal(callback.type, 'callback');
  assert.match(callback.value.dshim, /^dc:[A-Za-z0-9_-]+:0$/u);
  // Only the stored card reference travels; the reply code stays as plain text.
  assert.equal(create.request.data.content.includes('req-7'), false);
  assert.ok(create.request.data.content.includes('承認 123456'));
  const ref = decodeMessageRef(sent.messageRef);
  assert.deepEqual({ platform: ref.platform, botId: ref.botId, messageId: ref.messageId }, { platform: 'feishu', botId: 'feishu_care', messageId: 'om_out_1' });

  // Idempotent: the same key does not send again.
  const again = await hub.sendCard({ botId: 'feishu_care', to: { userId: 'ou_staff' }, card: APPROVAL_CARD, idempotencyKey: 'approval:7' });
  assert.deepEqual(again, { messageRef: sent.messageRef, delivered: true, deduped: true });
  assert.equal(client.calls.filter((call) => call.method === 'create').length, 1);

  // A press over the long connection reaches onAction with the action id / value and trusted source.
  socket.dispatcher.handlers['card.action.trigger'](cardPress(callback.value, { messageId: ref.messageId, chatId: ref.conversationId }));
  await eventually(() => presses.length === 1);
  assert.equal(resolverCalls, 0);
  assert.equal(presses[0].actionId, 'care.approve');
  assert.equal(presses[0].value, 'req-7');
  assert.equal(presses[0].messageRef, sent.messageRef);
  const { at, ...source } = presses[0].source;
  assert.deepEqual(source, {
    platform: 'feishu', botId: 'feishu_care', teamId: TENANT, userId: 'ou_staff',
    conversationId: ref.conversationId, conversationKind: 'direct', messageId: 'ev_press_1',
  });
  await eventually(() => client.calls.some((call) => call.method === 'reply' && JSON.parse(call.request.data.content).text === '承認しました'));
  // A redelivered press (same event id) is handled once.
  socket.dispatcher.handlers['card.action.trigger'](cardPress(callback.value, { messageId: ref.messageId, chatId: ref.conversationId }));
  await settle();
  assert.equal(presses.length, 1);
  // A forged reference that the card record does not know is ignored.
  socket.dispatcher.handlers['card.action.trigger'](cardPress({ dshim: 'dc:unknownCard1:0' }, { eventId: 'ev_forged', messageId: 'om_x', chatId: 'oc_x' }));
  await settle();
  assert.equal(presses.length, 1);

  // updateCard patches the same message; the new buttons map to the new actions.
  await hub.updateCard(sent.messageRef, { title: '承認済み', fields: [{ label: '申請', value: '休暇 10/30' }], actions: [{ id: 'care.undo', label: '取り消す', value: 'req-7' }] });
  const patch = client.calls.find((call) => call.method === 'patch');
  assert.equal(patch.request.path.message_id, ref.messageId);
  const patched = careButtons(patch.request.data.content);
  assert.equal(patched.card.header.title.content, '承認済み');
  socket.dispatcher.handlers['card.action.trigger'](cardPress(patched.buttons[0].behaviors[0].value, { eventId: 'ev_press_2', messageId: ref.messageId, chatId: ref.conversationId }));
  await eventually(() => presses.length === 2);
  assert.equal(presses[1].actionId, 'care.undo');
  assert.equal(presses[1].source.conversationKind, 'direct');

  // When Feishu refuses the patch, the updated card is sent as a new message to the same chat.
  client.calls.failPatch = true;
  const creates = client.calls.filter((call) => call.method === 'create').length;
  await hub.updateCard(sent.messageRef, { title: '最終版' });
  const resent = client.calls.filter((call) => call.method === 'create');
  assert.equal(resent.length, creates + 1);
  assert.deepEqual(resent.at(-1).request.params, { receive_id_type: 'chat_id' });
  assert.equal(resent.at(-1).request.data.receive_id, ref.conversationId);
  assert.equal(resent.at(-1).request.data.msg_type, 'interactive');

  // Stopping the runtime unregisters the driver (cards then use the text fallback).
  await runtime.stop();
  assert.equal(hub.driverFor('feishu_care'), null);
});

test('Feishu / Lark: two apps on one DSH keep separate drivers, clients and card records', async (t) => {
  const { hub } = await useHub(t);
  const fake = fakeLark();
  const a = await startRuntime(fake, { botId: 'feishu_a' });
  const b = await startRuntime(fake, { botId: 'lark_b', domain: 'lark' });
  t.after(async () => { await a.runtime.stop(); await b.runtime.stop(); });
  assert.equal(a.client.options.domain, 'feishu-domain');
  assert.equal(b.client.options.domain, 'lark-domain');
  const presses = [];
  hub.onAction('care.', (event) => { presses.push(event); });
  const sentA = await hub.sendCard({ botId: 'feishu_a', to: { userId: 'ou_same' }, card: APPROVAL_CARD, idempotencyKey: 'k:a' });
  const sentB = await hub.sendCard({ botId: 'lark_b', to: { conversationId: 'oc_group_lark' }, card: APPROVAL_CARD, idempotencyKey: 'k:b' });
  assert.equal(a.client.calls.filter((call) => call.method === 'create').length, 1);
  assert.equal(b.client.calls.filter((call) => call.method === 'create').length, 1);
  assert.deepEqual(b.client.calls[0].request.params, { receive_id_type: 'chat_id' });
  assert.equal(decodeMessageRef(sentA.messageRef).botId, 'feishu_a');
  assert.equal(decodeMessageRef(sentB.messageRef).botId, 'lark_b');
  const valueA = careButtons(a.client.calls[0].request.data.content).buttons[0].behaviors[0].value;
  const valueB = careButtons(b.client.calls[0].request.data.content).buttons[1].behaviors[0].value;
  // A press of app A's card arriving on app B's connection is ignored.
  b.socket.dispatcher.handlers['card.action.trigger'](cardPress(valueA, { eventId: 'ev_cross', messageId: 'om_x', chatId: 'oc_x' }));
  await settle();
  assert.equal(presses.length, 0);
  b.socket.dispatcher.handlers['card.action.trigger'](cardPress(valueB, { eventId: 'ev_b', messageId: decodeMessageRef(sentB.messageRef).messageId, chatId: 'oc_group_lark' }));
  await eventually(() => presses.length === 1);
  assert.equal(presses[0].actionId, 'care.reject');
  assert.equal(presses[0].source.botId, 'lark_b');
  assert.equal(presses[0].source.platform, 'feishu');
  // A card sent to a conversation (not a user) is reported as a group press.
  assert.equal(presses[0].source.conversationKind, 'group');
  // Proactive text through each runtime uses its own client and the open_id route.
  await a.runtime.sendProactiveText({ kind: 'user', route: { openId: 'ou_same' } }, '通知です');
  const proactive = a.client.calls.at(-1);
  assert.deepEqual(proactive.request.params, { receive_id_type: 'open_id' });
  assert.equal(proactive.request.data.receive_id, 'ou_same');
  assert.equal(b.client.calls.some((call) => call.request?.data?.receive_id === 'ou_same'), false);
});

test('Feishu: send({ userId }) maps to the open_id route, idempotent per bot; sendCard falls back to text', async (t) => {
  const { dir } = await useHub(t);
  const sent = [];
  const deliveryService = {
    async send(...args) { sent.push(args); return { sent: true }; },
    async listBots() { return [{ botId: 'feishu_a', channel: 'feishu' }, { botId: 'lark_b', channel: 'feishu' }]; },
  };
  const dshIm = installCareExtensions({}, { deliveryStorePath: join(dir, 'care-delivery.json') }, deliveryService, { logger: quiet });
  const draft = { kind: 'user', route: { openId: 'ou_staff' } };
  assert.deepEqual(fallbackDraftTarget('feishu', { userId: 'ou_staff' }), draft);
  assert.deepEqual(fallbackDraftTarget('feishu', { conversationId: 'oc_dm_staff' }), { kind: 'group', route: { chatId: 'oc_dm_staff' } });
  assert.deepEqual(normalizeDeliveryTarget('feishu', { targetId: 'draft', ...draft }), { targetId: 'draft', ...draft });

  assert.deepEqual(await dshIm.send('feishu_a', { userId: 'ou_staff' }, '本日の訪問予定です', { idempotencyKey: 'notify:1' }), { sent: true, deduped: false });
  assert.deepEqual(sent, [['feishu_a', draft, '本日の訪問予定です', {}]]);
  assert.deepEqual(await dshIm.send('feishu_a', { userId: 'ou_staff' }, '本日の訪問予定です', { idempotencyKey: 'notify:1' }), { sent: true, deduped: true });
  assert.equal(sent.length, 1);
  // The same key on another app is a different notification.
  assert.deepEqual(await dshIm.send('lark_b', { userId: 'ou_staff' }, '本日の訪問予定です', { idempotencyKey: 'notify:1' }), { sent: true, deduped: false });
  assert.equal(sent.length, 2);

  // No connected driver: the card goes out as text with the reply code, to the user.
  sent.length = 0;
  const card = await dshIm.sendCard({ botId: 'feishu_a', to: { userId: 'ou_staff' }, card: APPROVAL_CARD, idempotencyKey: 'card:1' });
  assert.deepEqual(sent[0].slice(0, 2), ['feishu_a', draft]);
  assert.match(sent[0][2], /「承認 123456」/);
  assert.deepEqual(sent[0][3], { transient: true });
  assert.equal(decodeMessageRef(card.messageRef).toUser, true);
  sent.length = 0;
  await dshIm.updateCard(card.messageRef, { title: '承認済み' });
  assert.deepEqual(sent[0].slice(0, 2), ['feishu_a', draft]);
});

test('B-028: a button with an input is a form (input + submit); the typed text reaches onAction as inputText', async (t) => {
  const { hub } = await useHub(t);
  const fake = fakeLark();
  const { runtime, client, socket } = await startRuntime(fake, { botId: 'feishu_care' });
  t.after(() => runtime.stop());
  const presses = [];
  hub.onAction('care.', async (event) => { presses.push(event); });
  const card = {
    title: '承認依頼',
    actions: [
      { id: 'care.approve', label: '承認', style: 'primary', value: 'req-9' },
      { id: 'care.reject', label: '差戻', style: 'danger', value: 'req-9', input: { label: '差戻しの理由', placeholder: '例：金額を確認してください' } },
    ],
  };
  await hub.sendCard({ botId: 'feishu_care', to: { userId: 'ou_staff' }, card, idempotencyKey: 'approval:9' });
  const create = client.calls.find((call) => call.method === 'create');
  const parsed = JSON.parse(create.request.data.content);
  const form = parsed.body.elements.find((element) => element.tag === 'form');
  assert.ok(form, 'the reject button and its input are in a form');
  const [input, submit] = form.elements;
  assert.equal(input.tag, 'input');
  assert.equal(input.name, FEISHU_CARE_INPUT_NAME);
  assert.equal(input.label.content, '差戻しの理由');
  assert.equal(input.placeholder.content, '例：金額を確認してください');
  assert.equal(submit.tag, 'button');
  assert.equal(submit.form_action_type, 'submit');
  assert.match(submit.behaviors[0].value.dshim, /^dc:[A-Za-z0-9_-]+:1$/u);
  const press = cardPress(submit.behaviors[0].value, { messageId: 'om_out_1', chatId: 'oc_dm_ou_staff' });
  press.action.form_value = { [FEISHU_CARE_INPUT_NAME]: ' 金額を確認してください ' };
  socket.dispatcher.handlers['card.action.trigger'](press);
  await eventually(() => presses.length === 1);
  assert.equal(presses[0].actionId, 'care.reject');
  assert.equal(presses[0].inputText, '金額を確認してください');

  // When Feishu refuses the form, the card still goes out (without the input).
  client.calls.failForm = true;
  await hub.sendCard({ botId: 'feishu_care', to: { userId: 'ou_staff' }, card, idempotencyKey: 'approval:10' });
  const creates = client.calls.filter((call) => call.method === 'create');
  assert.equal(creates.length, 3);
  assert.equal(creates.at(-1).request.data.content.includes('"tag":"form"'), false);
  assert.equal(careButtons(creates.at(-1).request.data.content).buttons.length, 2);
});

test('Feishu card renderer: plain text only, ≤ 10 buttons, reply code kept', () => {
  const content = feishuCareCard({
    title: '*見出し*', fields: [{ label: '[x](https://evil.example)', value: '<at id=all></at>' }], actions: [], textFallback: '「承認 1」',
  }, 'cardRender1');
  const card = JSON.parse(content);
  const texts = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.tag === 'lark_md' || value.tag === 'markdown') assert.fail('care cards never use lark_md');
    if (value.tag === 'plain_text') texts.push(value.content);
    Object.values(value).forEach(visit);
  };
  visit(card);
  assert.ok(texts.includes('[x](https://evil.example): <at id=all></at>'));
  assert.ok(texts.includes('「承認 1」'));
  assert.deepEqual(card.config, { update_multi: true });
});
