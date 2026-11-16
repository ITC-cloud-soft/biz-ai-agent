// care fork: proactive delivery to a linked user's userId on every non-Feishu
// platform — ctx.dshIm.send(botId, { userId }, text, { idempotencyKey }) and
// sendCard's text fallback map to the channel's delivery route; Discord opens
// the DM channel, iMessage addresses the handle, WeCom AI bot cards are native
// template cards whose buttons reach onAction. All endpoints are mocks.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';

import { fallbackDraftTarget, installCareExtensions } from '../../plugin-src/host/care-extensions.mjs';
import { normalizeDeliveryTarget } from '../../plugin-src/host/delivery-adapter.mjs';
import { DiscordApi } from '../../src/channels/discord/discord-api.mjs';
import { DiscordRuntime } from '../../src/channels/discord/discord-runtime.mjs';
import { MacOSMessagesApi } from '../../src/channels/imessage/imessage-api.mjs';
import { IMessageRuntime } from '../../src/channels/imessage/runtime.mjs';
import { decodeMessageRef } from '../../src/channels/shared/im-card.mjs';
import { WecomRuntime } from '../../src/channels/wecom/wecom-runtime.mjs';
import {
  eventually, FakeSocket, harnessFixture, policyProvider, quiet, scope, stateFixture, useHub,
} from './support.mjs';

const REPLY_CARD = { title: '承認依頼', fields: [{ label: '申請', value: '休暇' }], textFallback: '承認は「承認 123456」、却下は「却下 123456」と返信してください' };

const USERS = [
  { channel: 'wecom', botId: 'wecom_bot', userId: 'zhangsan', draft: { kind: 'user', route: { chatId: 'zhangsan' } } },
  { channel: 'dingtalk', botId: 'ding_bot', userId: 'staff-1', draft: { kind: 'user', route: { userId: 'staff-1' } } },
  { channel: 'qq', botId: 'qq_bot', userId: 'user-openid-1', draft: { kind: 'user', route: { userOpenId: 'user-openid-1' } } },
  { channel: 'whatsapp', botId: 'wa_bot', userId: '819011112222@s.whatsapp.net', draft: { kind: 'user', route: { jid: '819011112222@s.whatsapp.net' } } },
  { channel: 'matrix', botId: 'mx_bot', userId: '@staff:care.example', draft: { kind: 'dm', route: { userId: '@staff:care.example' } } },
  { channel: 'discord', botId: 'discord_a', userId: '222222222222222222', draft: { kind: 'user', route: { userId: '222222222222222222' } } },
  { channel: 'discord', botId: 'discord_b', userId: '222222222222222222', draft: { kind: 'user', route: { userId: '222222222222222222' } } },
  { channel: 'imessage', botId: 'imessage_bot', userId: '+819012345678', draft: { kind: 'user', route: { chatGuid: '+819012345678' } } },
];

async function hostFixture(t) {
  const { dir } = await useHub(t);
  const sent = [];
  const deliveryService = {
    async send(...args) { sent.push(args); return { sent: true }; },
    async listBots() { return USERS.map(({ botId, channel }) => ({ botId, channel })); },
  };
  const dshIm = installCareExtensions({}, { deliveryStorePath: join(dir, 'care-delivery.json') }, deliveryService, { logger: quiet });
  return { dshIm, sent };
}

test('send({ userId }) with an idempotencyKey reaches each platform\'s user route once, per bot', async (t) => {
  const { dshIm, sent } = await hostFixture(t);
  for (const user of USERS) {
    sent.length = 0;
    const first = await dshIm.send(user.botId, { userId: user.userId }, '本日の訪問予定です', { idempotencyKey: 'notify:42:staff' });
    assert.deepEqual(first, { sent: true, deduped: false }, user.botId);
    assert.deepEqual(sent, [[user.botId, user.draft, '本日の訪問予定です', {}]], user.botId);
    // The runtime receives this draft: the delivery adapter accepts it as a target.
    assert.deepEqual(normalizeDeliveryTarget(user.channel, { targetId: 'draft', ...user.draft }), { targetId: 'draft', ...user.draft });
    const again = await dshIm.send(user.botId, { userId: user.userId }, '本日の訪問予定です', { idempotencyKey: 'notify:42:staff' });
    assert.deepEqual(again, { sent: true, deduped: true });
    assert.equal(sent.length, 1, `${user.botId}: the second send is deduplicated`);
  }
  // Strings and { kind, route } targets keep the upstream behaviour.
  sent.length = 0;
  await dshIm.send('ding_bot', 'saved-target', 'hello');
  assert.deepEqual(sent, [['ding_bot', 'saved-target', 'hello', undefined]]);
});

test('sendCard without a native driver sends the text fallback with the reply code to the user route', async (t) => {
  const { dshIm, sent } = await hostFixture(t);
  for (const user of USERS) {
    sent.length = 0;
    const result = await dshIm.sendCard({ botId: user.botId, to: { userId: user.userId }, card: REPLY_CARD, idempotencyKey: `approval:7:${user.botId}` });
    assert.equal(result.deduped, false);
    assert.equal(sent.length, 1, user.botId);
    assert.deepEqual(sent[0].slice(0, 2), [user.botId, user.draft]);
    assert.match(sent[0][2], /承認依頼/);
    assert.match(sent[0][2], /「承認 123456」/);
    assert.deepEqual(sent[0][3], { transient: true });
    const ref = decodeMessageRef(result.messageRef);
    assert.equal(ref.toUser, true);
    // updateCard on a text channel sends a new message to the same user.
    sent.length = 0;
    await dshIm.updateCard(result.messageRef, { title: '承認済み', body: '承認しました' });
    assert.deepEqual(sent[0].slice(0, 2), [user.botId, user.draft], `${user.botId}: update reaches the same DM`);
  }
});

test('fallback targets: Discord users, iMessage handles and refused iMessage group GUIDs', () => {
  assert.deepEqual(fallbackDraftTarget('discord', { userId: '222222222222222222' }), { kind: 'user', route: { userId: '222222222222222222' } });
  assert.deepEqual(fallbackDraftTarget('discord', { conversationId: '333333333333333333' }), { kind: 'channel', route: { channelId: '333333333333333333' } });
  assert.deepEqual(fallbackDraftTarget('imessage', { conversationId: 'any;-;+819012345678' }), { kind: 'user', route: { chatGuid: 'any;-;+819012345678' } });
  assert.equal(fallbackDraftTarget('imessage', { conversationId: 'iMessage;+;chat123456789' }), null);
  assert.throws(() => normalizeDeliveryTarget('discord', { targetId: 't', kind: 'user', route: { userId: 'not-a-snowflake' } }), /Discord user id/);
});

const DISCORD_TOKEN = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;

test('Discord API opens the DM channel with users/@me/channels', async () => {
  const requests = [];
  const api = new DiscordApi({
    token: DISCORD_TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: '777777777777777777', type: 1 }), { status: 200 });
    },
  });
  assert.deepEqual(await api.createDirectMessageChannel({ userId: '222222222222222222' }), { id: '777777777777777777', type: 1 });
  assert.deepEqual(requests, [{ url: 'https://discord.com/api/v10/users/@me/channels', method: 'POST', body: { recipient_id: '222222222222222222' } }]);
  assert.throws(() => api.createDirectMessageChannel({ userId: 'nope' }), /Invalid Discord user id/);
});

test('Discord runtime delivers kind user through the cached DM channel', async (t) => {
  const BOT = '111111111111111111';
  const calls = [];
  let socket;
  const { state } = stateFixture();
  const runtime = new DiscordRuntime({
    config: { botId: 'discord_a', platformId: BOT, name: 'Care Discord' },
    token: DISCORD_TOKEN,
    harness: harnessFixture().harness,
    state,
    logger: quiet,
    createApi: () => ({
      getCurrentUser: async () => ({ id: BOT, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      createDirectMessageChannel: async ({ userId }) => { calls.push(['dm', userId]); return { id: '777777777777777777', type: 1 }; },
      createMessage: async ({ channelId, content }) => { calls.push(['message', channelId, content]); return { id: `9${calls.length}`.padEnd(18, '0') }; },
    }),
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => {
        socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) });
        setTimeout(() => socket.emit('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1' } }) }), 1);
      });
      return socket;
    },
    random: () => 0.5,
    connectTimeoutMs: 2_000,
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await runtime.sendProactiveText({ kind: 'user', route: { userId: '222222222222222222' } }, '本日の訪問予定です');
  await runtime.sendProactiveText({ kind: 'user', route: { userId: '222222222222222222' } }, '承認依頼があります');
  assert.deepEqual(calls, [
    ['dm', '222222222222222222'],
    ['message', '777777777777777777', '本日の訪問予定です'],
    ['message', '777777777777777777', '承認依頼があります'],
  ]);
  // Channel targets are unchanged.
  await runtime.sendProactiveText({ kind: 'channel', route: { channelId: '333333333333333333' } }, 'channel');
  assert.deepEqual(calls.at(-1), ['message', '333333333333333333', 'channel']);
  await assert.rejects(runtime.sendProactiveText({ kind: 'user', route: {} }, 'x'), { code: 'invalid-target' });
});

test('iMessage: a proactive send to the user handle addresses that buddy', async (t) => {
  const sent = [];
  const runtime = new IMessageRuntime({
    config: { botId: 'imessage_bot', platformId: 'macos-messages' },
    token: 'local',
    harness: harnessFixture().harness,
    state: { cursor: () => 0, setCursor: async () => {}, hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
    logger: quiet,
    pollIntervalMs: 60_000,
    createApi: () => ({
      getPermissions: async () => ({ database: 'granted', automation: 'granted' }),
      listMessages: async () => [],
      sendText: async (request) => { sent.push(request); return { sent: true }; },
    }),
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const draft = fallbackDraftTarget('imessage', { userId: '+819012345678' });
  assert.deepEqual(await runtime.sendProactiveText(draft, '本日の訪問予定です'), { sent: true });
  assert.equal(sent[0].chatGuid, '+819012345678');

  // macOS Messages resolves the buddy from the last `;` segment of the chat GUID,
  // so the bare handle and the DM GUID address the same person.
  const scripts = [];
  const api = new MacOSMessagesApi({ execFileImpl: async () => ({ stdout: '' }), osascriptImpl: async (script) => { scripts.push(script); } });
  await api.sendText({ chatGuid: '+819012345678', text: 'hello' });
  await api.sendText({ chatGuid: 'any;-;+819012345678', text: 'hello' });
  for (const script of scripts) assert.match(script, /buddy "\+819012345678"/);
});

function wecomClient() {
  const sent = [];
  const client = new EventEmitter();
  Object.assign(client, {
    connect: () => queueMicrotask(() => client.emit('authenticated')),
    disconnect() {},
    replyStream: async (_frame, _id, content) => sent.push({ type: 'stream', content }),
    replyStreamNonBlocking: async (_frame, _id, content) => sent.push({ type: 'stream', content }),
    replyTemplateCard: async (_frame, card) => sent.push({ type: 'reply-card', card }),
    updateTemplateCard: async (_frame, card) => sent.push({ type: 'update', card }),
    sendMessage: async (chatId, body) => {
      sent.push({ type: body.msgtype, chatId, card: body.template_card, content: body.markdown?.content });
      return { body: { msgid: `wecom-out-${sent.length}` } };
    },
  });
  return { client, sent };
}

test('WeCom AI bot: sendCard is a native template card and a button press reaches onAction only', async (t) => {
  const { hub } = await useHub(t);
  const { client, sent } = wecomClient();
  const { harness, asked } = harnessFixture();
  const { state } = stateFixture();
  const resolverCalls = [];
  hub.setAccessResolver(async (source) => { resolverCalls.push(source); return 'allow'; });
  const runtime = new WecomRuntime({
    config: { botId: 'wecom_bot', remoteBotId: 'aib-remote' }, secret: 'host-secret', harness, state, logger: quiet,
    accessPolicy: policyProvider('wecom_bot', { direct: scope('allowlist', []) }),
    createClient: () => client,
  });
  t.after(() => runtime.stop());
  await runtime.start();

  const card = {
    ...REPLY_CARD,
    actions: [
      { id: 'care.approve', label: '承認', style: 'primary', value: 'req-7' },
      { id: 'care.reject', label: '却下', style: 'danger', value: 'req-7' },
    ],
  };
  const result = await hub.sendCard({ botId: 'wecom_bot', to: { userId: 'zhangsan' }, card, idempotencyKey: 'approval:7:zhangsan' });
  assert.equal(result.deduped, false);
  assert.equal(sent.length, 1);
  const template = sent[0].card;
  assert.equal(sent[0].type, 'template_card');
  assert.equal(sent[0].chatId, 'zhangsan');
  assert.equal(template.card_type, 'button_interaction');
  assert.match(template.task_id, /^dshim_[A-Za-z0-9_-]+$/);
  assert.equal(template.main_title.title, '承認依頼');
  assert.match(template.sub_title_text, /申請: 休暇/);
  assert.match(template.sub_title_text, /「承認 123456」/, 'the reply code stays as the text path');
  assert.deepEqual(template.button_list.map(({ text, key, style }) => [text, key, style]), [['承認', '0', 1], ['却下', '1', 2]]);
  assert.equal(decodeMessageRef(result.messageRef).platform, 'wecom');
  assert.deepEqual(await hub.sendCard({ botId: 'wecom_bot', to: { userId: 'zhangsan' }, card, idempotencyKey: 'approval:7:zhangsan' }),
    { ...result, deduped: true });
  assert.equal(sent.length, 1);

  const actions = [];
  hub.onAction('care.', async (event) => {
    actions.push(event);
    await event.respond('却下しました');
  });
  client.emit('event.template_card_event', {
    headers: { req_id: 'req-event-1' },
    body: {
      msgid: 'event-1', chattype: 'single', from: { userid: 'zhangsan' }, msgtype: 'event',
      event: { eventtype: 'template_card_event', template_card_event: { card_type: 'button_interaction', task_id: template.task_id, event_key: '1' } },
    },
  });
  await eventually(() => actions.length === 1);
  assert.equal(actions[0].actionId, 'care.reject');
  assert.equal(actions[0].value, 'req-7');
  assert.equal(actions[0].messageRef, result.messageRef);
  const { at, messageId, ...source } = actions[0].source;
  assert.deepEqual(source, { platform: 'wecom', botId: 'wecom_bot', userId: 'zhangsan', conversationId: 'zhangsan', conversationKind: 'direct' });
  assert.equal(messageId, 'event-1');
  await eventually(() => sent.some((entry) => entry.content === '却下しました'));
  assert.equal(resolverCalls.length, 0, 'button presses do not pass the resolver');
  assert.equal(asked.length, 0, 'button presses never reach the agent');

  // A card without buttons (a notification) is sent as markdown text.
  const notice = await hub.sendCard({ botId: 'wecom_bot', to: { userId: 'zhangsan' }, card: { title: 'お知らせ', textFallback: '返信は「確認 1」' }, idempotencyKey: 'notify:1:zhangsan' });
  assert.match(sent.at(-1).content, /お知らせ[\s\S]*「確認 1」/);
  assert.equal(sent.at(-1).type, 'markdown');
  assert.equal(decodeMessageRef(notice.messageRef).toUser, true);

  // Stopping the runtime removes its driver: cards fall back to proactive text.
  await runtime.stop();
  assert.equal(hub.driverFor('wecom_bot'), null);
});
