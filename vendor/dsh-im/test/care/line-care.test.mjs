// care fork: LINE over a mocked Messaging API — signature check, gate order
// (claimReplies → resolver → agent), postback → onAction, Flex cards,
// reply/push, retry keys and idempotency. No network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMessageRef, lineFlexMessage, linePostbackData, parseLinePostbackData } from '../../src/channels/shared/im-card.mjs';
import { createWebhookHub } from '../../src/channels/shared/webhook-hub.mjs';
import { LineApi, lineRetryKey, signLineBody, verifyLineSignature } from '../../src/channels/line/line-api.mjs';
import { LineRuntime, normalizeLineEvent, stripLineSelfMention } from '../../src/channels/line/line-runtime.mjs';
import { eventually, harnessFixture, policyProvider, quiet, settle, stateFixture, useHub } from './support.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'line-test-access-token-not-real-0000000000';
const BOT_USER = `U${'b'.repeat(32)}`;
const USER = `U${'1'.repeat(32)}`;
const GROUP = `C${'2'.repeat(32)}`;
const BOT_ID = 'line_care';

function fakeApi() {
  const calls = { replies: [], pushes: [], loading: 0 };
  let id = 100;
  const sent = (messages) => ({ sentMessages: messages.map(() => ({ id: String(++id), quoteToken: 'q' })) });
  const api = {
    replyFails: null,
    getBotInfo: async () => ({ userId: BOT_USER, displayName: 'ケアボット', basicId: '@care' }),
    reply: async (request) => {
      calls.replies.push(request);
      if (api.replyFails) throw Object.assign(new Error('reply failed'), { status: api.replyFails });
      return sent(request.messages);
    },
    push: async (request) => { calls.pushes.push(request); return { ...sent(request.messages), retryKey: request.retryKey }; },
    startLoading: async () => { calls.loading += 1; },
  };
  return { api, calls };
}

async function startRuntime(t, { policy = policyProvider(BOT_ID), hub: extensions } = {}) {
  const { api, calls } = fakeApi();
  const { harness, asked } = harnessFixture();
  const { state, seen } = stateFixture();
  const webhooks = createWebhookHub();
  const runtime = new LineRuntime({
    config: { botId: BOT_ID, platformId: BOT_USER, name: 'ケアボット' },
    secrets: { channelSecret: SECRET, channelAccessToken: TOKEN },
    harness, state, accessPolicy: policy, logger: quiet,
    createApi: () => api, webhooks,
    ...(extensions ? { extensions } : {}),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return { runtime, api, calls, asked, seen, webhooks };
}

function webhook(webhooks, events, { secret = SECRET, tamper = false } = {}) {
  const raw = Buffer.from(JSON.stringify({ destination: BOT_USER, events }));
  const signature = signLineBody(secret, raw);
  const body = tamper ? Buffer.from(raw.toString('utf8').replace('"text":"', '"text":"X')) : raw;
  return webhooks.dispatch('line', { rawBody: body, headers: { 'x-line-signature': signature } });
}

function textEvent({ id = 'm1', text = 'こんにちは', source = { type: 'user', userId: USER }, mention, replyToken = 'rt-1' } = {}) {
  return {
    type: 'message', mode: 'active', timestamp: 1_760_000_000_000, webhookEventId: `ev-${id}`,
    deliveryContext: { isRedelivery: false }, replyToken, source,
    message: { type: 'text', id, text, ...(mention ? { mention } : {}) },
  };
}

test('X-Line-Signature: valid, tampered, wrong secret, malformed', () => {
  const raw = Buffer.from('{"events":[]}');
  const signature = signLineBody(SECRET, raw);
  assert.equal(verifyLineSignature(SECRET, raw, signature), true);
  assert.equal(verifyLineSignature(SECRET, Buffer.from('{"events":[ ]}'), signature), false, 'tampered body');
  assert.equal(verifyLineSignature('f'.repeat(32), raw, signature), false, 'other channel secret');
  assert.equal(verifyLineSignature(SECRET, raw, signature.slice(0, -4)), false, 'truncated signature');
  assert.equal(verifyLineSignature(SECRET, raw, undefined), false, 'missing header');
  assert.equal(verifyLineSignature(SECRET, raw, [signature]), true, 'array header form');
});

test('retry keys are deterministic UUIDs per idempotency key', () => {
  const a = lineRetryKey('approval-1');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(lineRetryKey('approval-1'), a);
  assert.notEqual(lineRetryKey('approval-2'), a);
});

test('Flex Message: postback data carries only actionId and value; long values use a card reference', () => {
  const card = {
    title: '請求書の承認', fields: [{ label: '金額', value: '¥12,000' }], body: '8月分',
    actions: [
      { id: 'care:approve', label: '承認', style: 'primary', value: 'ap_1' },
      { id: 'care:reject', label: '却下', style: 'danger', value: 'ap_1' },
    ],
    link: { label: '詳細', url: 'https://care.example.test/approvals/ap_1' }, footer: 'care-ai',
  };
  const message = lineFlexMessage(card);
  assert.equal(message.type, 'flex');
  assert.equal(message.altText, '請求書の承認');
  const buttons = message.contents.footer.contents.filter((item) => item.type === 'button');
  assert.deepEqual(JSON.parse(buttons[0].action.data), { a: 'care:approve', v: 'ap_1' });
  assert.equal(buttons[0].action.type, 'postback');
  assert.equal(buttons[1].color, '#d93025');
  assert.equal(buttons[2].action.type, 'uri');
  assert.deepEqual(parseLinePostbackData(buttons[1].action.data), { actionId: 'care:reject', value: 'ap_1' });
  const long = { id: 'care:x', label: 'X', style: 'default', value: 'v'.repeat(400) };
  assert.throws(() => linePostbackData(long, 0, null), /does not fit/);
  assert.equal(linePostbackData(long, 3, 'abcdefgh'), 'dc:abcdefgh:3');
  assert.deepEqual(parseLinePostbackData('dc:abcdefgh:3'), { cardId: 'abcdefgh', index: 3 });
  assert.equal(parseLinePostbackData('{"x":1}'), null);
});

test('group messages: only addressed (@bot) messages, sender = the LINE userId; mention stripped', () => {
  const plain = normalizeLineEvent(textEvent({ source: { type: 'group', groupId: GROUP, userId: USER } }), BOT_USER);
  assert.equal(plain.kind, 'group');
  assert.equal(plain.addressed, false);
  const text = '@ケアボット 今月の請求は？';
  const mention = { mentionees: [{ index: 0, length: 6, userId: BOT_USER, isSelf: true }] };
  const addressed = normalizeLineEvent(textEvent({ text, mention, source: { type: 'group', groupId: GROUP, userId: USER } }), BOT_USER);
  assert.equal(addressed.addressed, true);
  assert.equal(addressed.senderId, USER);
  assert.equal(addressed.conversationId, GROUP);
  assert.equal(addressed.content, '今月の請求は？');
  assert.equal(stripLineSelfMention(text, mention, BOT_USER), '今月の請求は？');
  assert.equal(normalizeLineEvent(textEvent({ source: { type: 'group', groupId: GROUP } }), BOT_USER), null, 'no userId → dropped');
});

test('webhook: a bad or tampered signature is rejected (401) and never reaches the agent', async (t) => {
  await useHub(t, { accessDefault: 'legacy' });
  const { webhooks, asked } = await startRuntime(t);
  assert.equal((await webhook(webhooks, [textEvent()], { secret: 'f'.repeat(32) })).status, 401);
  assert.equal((await webhook(webhooks, [textEvent()], { tamper: true })).status, 401);
  assert.equal((await webhooks.dispatch('line', { rawBody: Buffer.from('{}'), headers: {} })).status, 401);
  await settle();
  assert.equal(asked.length, 0);
});

test('default-closed: a verified LINE message from an unknown user is ignored', async (t) => {
  await useHub(t, { accessDefault: 'closed' });
  const { webhooks, asked, calls, seen } = await startRuntime(t);
  assert.equal((await webhook(webhooks, [textEvent({ id: 'm2' })])).status, 200);
  await eventually(() => seen.has('m2'));
  assert.equal(asked.length, 0);
  assert.equal(calls.replies.length + calls.pushes.length, 0);
});

test('resolver allow: trusted LINE source, reply via the reply token', async (t) => {
  const { hub, inbound } = await useHub(t);
  const resolved = [];
  hub.setAccessResolver((source) => { resolved.push(source); return 'allow'; });
  const { webhooks, asked, calls } = await startRuntime(t);
  await webhook(webhooks, [textEvent({ id: 'm3', text: '8月の請求状況は？' })]);
  await eventually(() => asked.length === 1 && calls.replies.length === 1);
  const { at, ...source } = asked[0].source;
  assert.deepEqual(source, {
    platform: 'line', botId: BOT_ID, userId: USER, conversationId: USER, conversationKind: 'direct', messageId: 'm3',
  });
  assert.equal(at, new Date(1_760_000_000_000).toISOString());
  assert.equal(resolved.length, 1);
  assert.equal(inbound[0].source.platform, 'line');
  assert.equal(calls.replies[0].replyToken, 'rt-1');
  assert.equal(calls.replies[0].messages[0].text, '了解しました');
  assert.equal(calls.pushes.length, 0);
});

test('gate order: claimReplies wins before the resolver; claimed text never reaches the agent', async (t) => {
  const { hub } = await useHub(t);
  let resolverCalls = 0;
  hub.setAccessResolver(() => { resolverCalls += 1; return 'allow'; });
  const claimed = [];
  hub.claimReplies((text) => /^連携 \d{6}$/.test(text), async ({ text, source, reply }) => {
    claimed.push({ text, source });
    await reply('連携しました');
  });
  const { webhooks, asked, calls } = await startRuntime(t);
  await webhook(webhooks, [textEvent({ id: 'm4', text: '連携 123456' })]);
  await eventually(() => claimed.length === 1 && calls.replies.length === 1);
  await settle();
  assert.equal(resolverCalls, 0);
  assert.equal(asked.length, 0);
  assert.equal(claimed[0].source.userId, USER);
  assert.equal(calls.replies[0].messages[0].text, '連携しました');
});

test('resolver deny with reply; a used reply token falls back to push', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => ({ deny: true, reply: '未連携です' }));
  const { webhooks, asked, calls, api } = await startRuntime(t);
  api.replyFails = 400;
  await webhook(webhooks, [textEvent({ id: 'm5' })]);
  await eventually(() => calls.pushes.length === 1);
  assert.equal(asked.length, 0);
  assert.equal(calls.replies.length, 1, 'reply tried first');
  assert.equal(calls.pushes[0].to, USER);
  assert.equal(calls.pushes[0].messages[0].text, '未連携です');
});

test('redelivered webhook events are processed once', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const { webhooks, asked } = await startRuntime(t);
  const event = textEvent({ id: 'm6' });
  await webhook(webhooks, [event]);
  await webhook(webhooks, [{ ...event, deliveryContext: { isRedelivery: true } }]);
  await eventually(() => asked.length === 1);
  await settle(60);
  assert.equal(asked.length, 1);
});

test('postback → onAction with the trusted source; respond() uses the reply token; no agent turn', async (t) => {
  const { hub } = await useHub(t);
  let resolverCalls = 0;
  hub.setAccessResolver(() => { resolverCalls += 1; return 'allow'; });
  const events = [];
  hub.onAction('care:', async (event) => { events.push(event); await event.respond('承認しました'); });
  const { webhooks, asked, calls } = await startRuntime(t);
  await webhook(webhooks, [{
    type: 'postback', webhookEventId: 'ev-pb1', timestamp: 1_760_000_000_000, replyToken: 'rt-pb',
    source: { type: 'user', userId: USER }, postback: { data: JSON.stringify({ a: 'care:approve', v: 'ap_9' }) },
  }]);
  await eventually(() => events.length === 1 && calls.replies.length === 1);
  assert.equal(events[0].actionId, 'care:approve');
  assert.equal(events[0].value, 'ap_9');
  assert.equal(events[0].source.platform, 'line');
  assert.equal(events[0].source.userId, USER);
  assert.equal(events[0].source.messageId, 'ev-pb1');
  assert.equal(decodeMessageRef(events[0].messageRef).conversationId, USER);
  assert.equal(calls.replies[0].replyToken, 'rt-pb');
  assert.equal(resolverCalls, 0, 'actions bypass the resolver (handlers authorize)');
  assert.equal(asked.length, 0);
});

test('sendCard: Flex push to to.userId with a deterministic retry key; same key delivers once', async (t) => {
  const { hub } = await useHub(t);
  const { calls } = await startRuntime(t);
  const card = { title: '承認依頼', actions: [{ id: 'care:approve', label: '承認', style: 'primary', value: 'ap_1' }] };
  const [first, second] = await Promise.all([
    hub.sendCard({ botId: BOT_ID, to: { userId: USER }, card, idempotencyKey: 'approval:ap_1' }),
    hub.sendCard({ botId: BOT_ID, to: { userId: USER }, card, idempotencyKey: 'approval:ap_1' }),
  ]);
  assert.equal(calls.pushes.length, 1);
  assert.equal(calls.pushes[0].to, USER);
  assert.equal(calls.pushes[0].messages[0].type, 'flex');
  assert.equal(calls.pushes[0].retryKey, lineRetryKey('card:approval:ap_1:0'));
  assert.equal(first.messageRef, second.messageRef);
  assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1);
  const ref = decodeMessageRef(first.messageRef);
  assert.equal(ref.platform, 'line');
  assert.equal(ref.conversationId, USER);
  await hub.updateCard(first.messageRef, { ...card, actions: [] });
  assert.equal(calls.pushes.length, 2, 'LINE cannot edit: the update is pushed as a new message');
});

test('LineApi push: retries 5xx / 429 with the same X-Line-Retry-Key, 409 counts as delivered, honours rate limit', async () => {
  const seen = [];
  const responses = [
    new Response('{"message":"busy"}', { status: 500 }),
    new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '0' } }),
    new Response('{"sentMessages":[{"id":"777"}]}', { status: 200 }),
    new Response('{"message":"The retry key is already accepted","sentMessages":[{"id":"777"}]}', { status: 409 }),
  ];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return responses.shift(); };
  const sleeps = [];
  const api = new LineApi({ channelAccessToken: TOKEN, baseUrl: 'https://line.mock.test', fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, logger: quiet });
  const result = await api.push({ to: USER, messages: [{ type: 'text', text: 'hi' }], retryKey: lineRetryKey('k1') });
  assert.equal(result.sentMessages[0].id, '777');
  assert.equal(seen.length, 3);
  const keys = seen.map((call) => call.init.headers['x-line-retry-key']);
  assert.deepEqual(new Set(keys), new Set([lineRetryKey('k1')]));
  assert.equal(seen[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].url, 'https://line.mock.test/v2/bot/message/push');
  const again = await api.push({ to: USER, messages: [{ type: 'text', text: 'hi' }], retryKey: lineRetryKey('k1') });
  assert.equal(again.duplicate, true);
  assert.ok(sleeps.length >= 2);
});

test('LineApi reply: a 5xx is not retried (the token may have been consumed)', async () => {
  let count = 0;
  const api = new LineApi({
    channelAccessToken: TOKEN, baseUrl: 'https://line.mock.test', logger: quiet, sleep: async () => {},
    fetchImpl: async () => { count += 1; return new Response('{}', { status: 502 }); },
  });
  await assert.rejects(api.reply({ replyToken: 'x', messages: [] }), (error) => error.status === 502);
  assert.equal(count, 1);
});
