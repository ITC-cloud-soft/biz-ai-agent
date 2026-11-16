// care fork: unit tests for the ctx.dshIm extension hub (AI_PLANE_CONTRACTS §1).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeliveryIdempotencyStore } from '../../src/channels/shared/delivery-idempotency-store.mjs';
import {
  decodeMessageRef,
  encodeMessageRef,
  normalizeCard,
  parseCardCallback,
  slackCardBlocks,
  telegramCardMarkup,
} from '../../src/channels/shared/im-card.mjs';
import { createImExtensions, normalizeImSource } from '../../src/channels/shared/im-extensions.mjs';

const quiet = { warn() {}, error() {} };

const SOURCE = Object.freeze({
  platform: 'slack', botId: 'slack_bot', teamId: 'T1', userId: 'U1', conversationId: 'D1',
  conversationKind: 'direct', messageId: '1700000000.000100', at: '2026-10-25T00:00:00.000Z',
});

const CARD = Object.freeze({
  title: '承認依頼 8月請求',
  fields: [{ label: '件数', value: '12' }, { label: '金額', value: '¥123,456' }],
  body: '確認をお願いします。',
  actions: [
    { id: 'care_approval:approve', label: '承認', style: 'primary', value: 'tok-1' },
    { id: 'care_approval:reject', label: '差戻', style: 'danger', value: 'tok-1' },
  ],
  link: { label: '詳細', url: 'https://care.example.test/approvals/1' },
  footer: '期限 10/31',
  textFallback: '「承認 123456」または「差戻 123456 理由」と返信してください。',
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-care-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('ImSource normalization keeps trusted platform fields and rejects incomplete sources', () => {
  const source = normalizeImSource({ ...SOURCE, userName: '  山田  ', extra: 'dropped' });
  assert.deepEqual({ ...source }, { ...SOURCE, userName: '山田' });
  assert.ok(Object.isFrozen(source));
  assert.equal(normalizeImSource({ ...SOURCE, userId: '' }), null);
  assert.equal(normalizeImSource({ ...SOURCE, messageId: undefined }), null);
  assert.equal(normalizeImSource({ ...SOURCE, conversationKind: 'weird' }).conversationKind, 'direct');
});

test('sourceForTurn follows the recorded turn and emits dsh-im/inbound', () => {
  const hub = createImExtensions({ logger: quiet });
  const events = [];
  hub.setInboundEmitter((event) => events.push(event));
  assert.equal(hub.sourceForTurn('s1'), null);
  const record = hub.recordTurnSource('s1', SOURCE, 'こんにちは');
  assert.deepEqual({ ...hub.sourceForTurn('s1') }, SOURCE);
  assert.deepEqual(events, [{ sessionId: 's1', source: hub.sourceForTurn('s1'), text: 'こんにちは' }]);
  // turn/start binds the record; only the matching turn/end clears it.
  hub.bindTurn('s1', 7);
  hub.endTurn('s1', 6);
  assert.ok(hub.sourceForTurn('s1'));
  hub.endTurn('s1', 7);
  assert.equal(hub.sourceForTurn('s1'), null);
  // A stale release does not drop a newer record.
  const newer = hub.recordTurnSource('s1', { ...SOURCE, messageId: 'm2' }, '');
  hub.releaseTurnSource('s1', record);
  assert.equal(hub.sourceForTurn('s1').messageId, 'm2');
  hub.releaseTurnSource('s1', newer);
  assert.equal(hub.sourceForTurn('s1'), null);
});

test('the access resolver decides allow, deny and deny-with-reply; failures deny', async () => {
  const hub = createImExtensions({ logger: quiet });
  assert.deepEqual(await hub.resolveAccess(SOURCE), { verdict: 'none' });
  const seen = [];
  const dispose = hub.setAccessResolver(async (source) => {
    seen.push(source.userId);
    if (source.userId === 'U1') return 'allow';
    if (source.userId === 'U2') return { deny: true, reply: '連携してください' };
    if (source.userId === 'U3') throw new Error('care-api down');
    return 'deny';
  });
  assert.equal(hub.hasAccessResolver(), true);
  assert.deepEqual(await hub.resolveAccess(SOURCE), { verdict: 'allow' });
  assert.deepEqual(await hub.resolveAccess({ ...SOURCE, userId: 'U2' }), { verdict: 'deny', reply: '連携してください' });
  assert.deepEqual(await hub.resolveAccess({ ...SOURCE, userId: 'U3' }), { verdict: 'deny', reply: null });
  assert.deepEqual(await hub.resolveAccess({ ...SOURCE, userId: 'U4' }), { verdict: 'deny', reply: null });
  assert.deepEqual(seen, ['U1', 'U2', 'U3', 'U4']);
  assert.equal(dispose(), true);
  assert.equal(dispose.dispose(), false);
  assert.equal(hub.hasAccessResolver(), false);
});

test('the gate runs claims before the resolver and serializes one conversation', async () => {
  const hub = createImExtensions({ logger: quiet });
  const order = [];
  const replies = [];
  hub.claimReplies((text) => /^連携\s*\d{6}$/.test(text), async ({ text, source, reply }) => {
    order.push(`claim:${text}:${source.userId}`);
    await reply('連携しました');
  });
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  hub.setAccessResolver(async (source) => {
    order.push(`resolve:${source.messageId}`);
    if (source.messageId === 'm1') await slow;
    return source.userId === 'U1' ? 'allow' : { deny: true, reply: '未連携です' };
  });
  const reply = async (text) => { replies.push(text); };
  const decisions = [];
  const run = (messageId, text, userId = 'U1') => hub.gate(
    { source: { ...SOURCE, messageId, userId }, text, reply },
    (decision) => { decisions.push([messageId, decision]); },
  );
  const first = run('m1', 'hello');
  const second = run('m2', '連携 123456', 'U9');
  const third = run('m3', 'other', 'U9');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(decisions, [], 'later messages wait behind the slow first decision');
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(decisions, [
    ['m1', { handled: false, resolverVerdict: 'allow' }],
    ['m2', { handled: true, kind: 'claimed' }],
    ['m3', { handled: true, kind: 'denied' }],
  ]);
  assert.deepEqual(order, ['resolve:m1', 'claim:連携 123456:U9', 'resolve:m3']);
  assert.deepEqual(replies, ['連携しました', '未連携です']);
});

test('cards validate and render as Block Kit, Telegram keyboards and message references', () => {
  const card = normalizeCard(CARD);
  const blocks = slackCardBlocks(card);
  assert.equal(blocks[0].type, 'header');
  assert.equal(blocks[1].fields.length, 2);
  const actions = blocks.find((block) => block.type === 'actions').elements;
  assert.deepEqual(actions.slice(0, 2).map(({ action_id, value, style }) => ({ action_id, value, style })), [
    { action_id: 'care_approval:approve', value: 'tok-1', style: 'primary' },
    { action_id: 'care_approval:reject', value: 'tok-1', style: 'danger' },
  ]);
  assert.equal(actions[2].url, 'https://care.example.test/approvals/1');
  const markup = telegramCardMarkup(card, 'abcdefghijkl');
  assert.deepEqual(markup.inline_keyboard[0].map((button) => button.callback_data), ['dc:abcdefghijkl:0', 'dc:abcdefghijkl:1']);
  assert.ok(markup.inline_keyboard[0].every((button) => Buffer.byteLength(button.callback_data) <= 64));
  assert.deepEqual(parseCardCallback('dc:abcdefghijkl:1'), { cardId: 'abcdefghijkl', index: 1 });
  assert.equal(parseCardCallback('q|nonce|0|1'), null);
  const ref = encodeMessageRef({ platform: 'slack', botId: 'b', conversationId: 'C1', messageId: '1.2' });
  assert.deepEqual(decodeMessageRef(ref), { platform: 'slack', botId: 'b', conversationId: 'C1', messageId: '1.2' });
  assert.equal(decodeMessageRef('nope'), null);
  assert.throws(() => normalizeCard({ title: '' }), /card.title/);
  assert.throws(() => normalizeCard({ ...CARD, actions: [CARD.actions[0], CARD.actions[0]] }), /unique/);
  assert.throws(() => normalizeCard({ ...CARD, link: { label: 'x', url: 'javascript:alert(1)' } }), /http/);
});

test('sendCard is idempotent per key, durable across restarts, and keeps records 7 days', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'care-delivery.json');
  let now = Date.now();
  const hub = createImExtensions({ logger: quiet });
  hub.configure({ storePath: path });
  // Use a store with a controllable clock.
  const sent = [];
  hub.registerDriver('slack_bot', {
    platform: 'slack',
    sendCard: async (to, card) => {
      sent.push([to, card.title]);
      return { messageRef: encodeMessageRef({ platform: 'slack', botId: 'slack_bot', conversationId: 'D1', messageId: `${sent.length}.0` }) };
    },
  });
  const input = { botId: 'slack_bot', to: { userId: 'U1' }, card: CARD, idempotencyKey: 'approval:1:U1' };
  const [a, b] = await Promise.all([hub.sendCard(input), hub.sendCard(input)]);
  assert.equal(sent.length, 1, 'concurrent duplicates share one delivery');
  assert.equal(a.messageRef, b.messageRef);
  assert.deepEqual([a.deduped, b.deduped].sort(), [false, true]);
  assert.equal(a.delivered, true);
  const again = await hub.sendCard(input);
  assert.deepEqual(again, { messageRef: a.messageRef, delivered: true, deduped: true });
  await hub.store.flush();
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.deliveries['card:approval:1:U1'].value.messageRef, a.messageRef);

  // A new process (fresh hub) still deduplicates from disk.
  const restarted = createImExtensions({ logger: quiet });
  restarted.configure({ storePath: path });
  restarted.registerDriver('slack_bot', { platform: 'slack', sendCard: async () => assert.fail('must not resend') });
  assert.equal((await restarted.sendCard(input)).deduped, true);

  // Retention: 7 days kept, then pruned.
  const store = new DeliveryIdempotencyStore({ path, now: () => now, logger: quiet });
  assert.ok(await store.getDelivery('card:approval:1:U1'));
  now += 6 * 24 * 60 * 60 * 1000;
  assert.ok(await new DeliveryIdempotencyStore({ path, now: () => now, logger: quiet }).getDelivery('card:approval:1:U1'));
  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(await new DeliveryIdempotencyStore({ path, now: () => now, logger: quiet }).getDelivery('card:approval:1:U1'), null);
});

test('a failed delivery is not recorded, so the same key can be retried', async () => {
  const hub = createImExtensions({ logger: quiet });
  let attempts = 0;
  hub.registerDriver('b', {
    platform: 'telegram',
    sendCard: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('provider down'), { code: 'delivery-failed' });
      return { messageRef: encodeMessageRef({ platform: 'telegram', botId: 'b', conversationId: '42', messageId: '7' }) };
    },
  });
  const input = { botId: 'b', to: { userId: '42' }, card: CARD, idempotencyKey: 'k' };
  await assert.rejects(hub.sendCard(input), /provider down/);
  assert.equal((await hub.sendCard(input)).deduped, false);
  assert.equal(attempts, 2);
});

test('channels without buttons receive textFallback; updateCard falls back to a new text message', async () => {
  const hub = createImExtensions({ logger: quiet });
  const texts = [];
  hub.setFallbackSender(async (botId, to, text) => {
    texts.push({ botId, to, text });
    return { platform: 'weixin', conversationId: to.userId ?? to.conversationId };
  });
  const result = await hub.sendCard({ botId: 'wx', to: { userId: 'wxid_1' }, card: CARD, idempotencyKey: 'wx-1' });
  assert.match(texts[0].text, /承認依頼 8月請求/);
  assert.match(texts[0].text, /「承認 123456」/);
  assert.doesNotMatch(texts[0].text, /tok-1/, 'action values (tokens) never reach a text channel');
  assert.deepEqual(decodeMessageRef(result.messageRef), { platform: 'weixin', botId: 'wx', conversationId: 'wxid_1', messageId: null, toUser: true });
  await hub.updateCard(result.messageRef, { title: '承認済み', textFallback: '承認されました。' });
  // The update goes to the same user (a user route, not a conversation route).
  assert.deepEqual(texts[1].to, { userId: 'wxid_1' });
  assert.match(texts[1].text, /承認済み/);
  await assert.rejects(hub.sendCard({ botId: 'wx', to: {}, card: CARD, idempotencyKey: 'x' }), { code: 'bad-request' });
});

test('onAction routes by longest prefix and reason dialogs resolve once', async () => {
  const hub = createImExtensions({ logger: quiet });
  const calls = [];
  hub.onAction('care_', async (event) => calls.push(['generic', event.actionId]));
  const dispose = hub.onAction('care_approval:', async (event) => {
    calls.push(['approval', event.actionId, event.value, event.source.userId, event.messageRef]);
    await event.respond('受け付けました');
  });
  const responses = [];
  assert.equal(await hub.dispatchAction({
    actionId: 'care_approval:approve', value: 'tok', source: SOURCE, messageRef: 'ref', respond: async (text) => responses.push(text),
  }), true);
  assert.equal(await hub.dispatchAction({ actionId: 'care_other', source: SOURCE }), true);
  assert.equal(await hub.dispatchAction({ actionId: 'unknown', source: SOURCE }), false);
  dispose();
  assert.equal(await hub.dispatchAction({ actionId: 'care_approval:approve', source: SOURCE }), true);
  assert.deepEqual(calls, [
    ['approval', 'care_approval:approve', 'tok', 'U1', 'ref'],
    ['generic', 'care_other'],
    ['generic', 'care_approval:approve'],
  ]);
  assert.deepEqual(responses, ['受け付けました']);

  const waiting = hub.waitForDialog('nonce-1');
  assert.equal(hub.resolveDialog('nonce-1', '金額の根拠が不足'), true);
  assert.equal(hub.resolveDialog('nonce-1', 'again'), false);
  assert.equal(await waiting, '金額の根拠が不足');
  assert.equal(await hub.waitForDialog('nonce-2', 5), null, 'an unanswered dialog times out as null');
});

test('isCardReply recognises card message ids and quoted card text', async () => {
  const hub = createImExtensions({ logger: quiet });
  hub.setFallbackSender(async () => ({ platform: 'weixin', conversationId: 'wxid_1', messageId: 'p1' }));
  await hub.sendCard({ botId: 'wx', to: { userId: 'wxid_1' }, card: CARD, idempotencyKey: 'q' });
  const base = { platform: 'weixin', botId: 'wx', conversationId: 'wxid_1' };
  assert.equal(hub.isCardReply({ ...base, replyTo: { messageId: 'p1' } }), true);
  assert.equal(hub.isCardReply({ ...base, replyTo: { content: '「承認 123456」または' } }), true);
  assert.equal(hub.isCardReply({ ...base, replyTo: { content: 'まったく別の話' } }), false);
  assert.equal(hub.isCardReply({ ...base, platform: 'slack', replyTo: { messageId: 'p1' } }), false);
  assert.equal(hub.isCardReply({ ...base, replyTo: undefined }), false);
});
