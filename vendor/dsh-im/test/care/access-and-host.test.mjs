// care fork: default-closed access, resolver semantics, Weixin claims,
// dsh-proactive forwarding and the provided ctx.dshIm surface.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createImHostPlugin } from '../../plugin-src/host/index.mjs';
import { accessDefaultFor, fallbackDraftTarget } from '../../plugin-src/host/care-extensions.mjs';
import { installSessionSyncCoordinator } from '../../plugin-src/host/session-sync-coordinator.mjs';
import { evaluateInboundAccess } from '../../src/channels/shared/inbound-access.mjs';
import { imExtensions } from '../../src/channels/shared/im-extensions.mjs';
import { WeixinHarnessBridge } from '../../src/channels/weixin/weixin-bridge.mjs';
import {
  eventually, harnessFixture, policyProvider, quiet, scope, settle, stateFixture, useHub,
} from './support.mjs';

const decide = (policy, senderId, extra = {}) => evaluateInboundAccess(policy, {
  conversationType: 'direct', senderIds: [senderId], text: 'hello', ...extra,
});

test('default-closed denies open scopes except the owner and explicit allowlist entries', async (t) => {
  await useHub(t, { accessDefault: 'closed' });
  const open = policyProvider('b', { privileged: ['owner'] });
  assert.deepEqual(decide(open, 'stranger'), { allowed: false, reason: 'sender-not-allowed' });
  assert.equal(decide(open, 'owner').allowed, true);
  // An explicit allowlist entry is an owner grant and keeps working.
  const listed = policyProvider('b', { direct: scope('open', ['granted']) });
  assert.equal(decide(listed, 'granted').allowed, true);
  assert.equal(decide(listed, 'stranger').allowed, false);
  // Allowlist scopes behave as before.
  const allowlist = policyProvider('b', { direct: scope('allowlist', ['member']) });
  assert.equal(decide(allowlist, 'member').allowed, true);
  // Damaged settings still fail closed.
  assert.equal(decide({ getSettings: () => null }, 'x').allowed, false);
  // Fixtures without a provider keep their compatibility path.
  assert.equal(decide(undefined, 'x').allowed, true);
});

test('legacy mode keeps upstream open defaults', async (t) => {
  await useHub(t, { accessDefault: 'legacy' });
  assert.equal(decide(policyProvider('b'), 'stranger').allowed, true);
});

test('a resolver allow replaces membership while commands keep the policy permission', async (t) => {
  await useHub(t, { accessDefault: 'closed' });
  const allowlist = policyProvider('b', { direct: scope('allowlist', []) });
  assert.deepEqual(decide(allowlist, 'staff', { resolverVerdict: 'allow' }), { allowed: true, reason: 'resolver-allowed' });
  assert.deepEqual(decide(allowlist, 'staff', { resolverVerdict: 'allow', text: '/model' }), {
    allowed: false, reason: 'command-not-allowed',
  });
  const open = policyProvider('b');
  assert.equal(decide(open, 'staff', { resolverVerdict: 'allow', text: '/clear' }).allowed, true);
});

test('Host access default is closed unless the profile opts into legacy-open', () => {
  assert.equal(accessDefaultFor({}), 'closed');
  assert.equal(accessDefaultFor({ accessDefault: 'legacy-open' }), 'legacy');
  assert.equal(accessDefaultFor({ accessDefault: 'anything' }), 'closed');
});

test('fallback draft targets map userId / conversationId per channel', () => {
  assert.deepEqual(fallbackDraftTarget('weixin', { userId: 'wxid_a' }), { kind: 'user', route: { toUserId: 'wxid_a' } });
  assert.deepEqual(fallbackDraftTarget('feishu', { conversationId: 'oc_1' }), { kind: 'group', route: { chatId: 'oc_1' } });
  assert.deepEqual(fallbackDraftTarget('dingtalk', { userId: 'staff1' }), { kind: 'user', route: { userId: 'staff1' } });
  assert.deepEqual(fallbackDraftTarget('wecomApp', { userId: 'u' }), { kind: 'user', route: { chatId: 'u' } });
  assert.equal(fallbackDraftTarget('slack', { userId: 'U1' }), null, 'Slack DMs need the connected card driver');
});

function weixinMessage(text, { from = 'wxid_staff', id = 1 } = {}) {
  return {
    message_id: id, seq: id, message_type: 1, from_user_id: from, to_user_id: 'bot',
    context_token: `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }],
  };
}

function weixinBridge(policy) {
  const sent = [];
  const { harness, asked } = harnessFixture();
  const { state } = stateFixture();
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => { sent.push(request); return { messageId: `out-${sent.length}` }; },
      sendTyping: async () => ({}),
      getConfig: async () => ({}),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'wxid_owner',
    harness,
    state,
    accessPolicy: policy,
    logger: quiet,
    botId: 'wx_bot',
  });
  return { bridge, sent, asked };
}

test('Weixin: claimReplies intercepts text replies and the resolver gates the rest', async (t) => {
  const { hub } = await useHub(t);
  const claims = [];
  hub.claimReplies((text) => /^承認\s*\d{6}$/.test(text), async ({ text, source, reply }) => {
    claims.push({ text, source: { ...source } });
    await reply('承認を受け付けました');
  });
  hub.setAccessResolver(async (source) => (source.userId === 'wxid_staff' ? 'allow' : { deny: true, reply: '未連携です' }));
  const { bridge, sent, asked } = weixinBridge(policyProvider('wx_bot', { direct: scope('allowlist', []), privileged: ['wxid_owner'] }));

  await bridge.accept(weixinMessage('承認 123456', { id: 11 }));
  await eventually(() => sent.length === 1);
  assert.equal(claims.length, 1);
  assert.deepEqual({ ...claims[0].source, at: undefined }, {
    platform: 'weixin', botId: 'wx_bot', userId: 'wxid_staff', conversationId: 'wxid_staff',
    conversationKind: 'direct', messageId: claims[0].source.messageId, at: undefined,
  });
  assert.ok(claims[0].source.messageId);
  assert.equal(asked.length, 0);

  await bridge.accept(weixinMessage('ほかの人', { from: 'wxid_other', id: 12 }));
  await eventually(() => sent.length === 2);
  assert.equal(asked.length, 0);

  // A linked staff member is allowed by the resolver although the allowlist is empty.
  await bridge.accept(weixinMessage('今日の予定', { id: 13 }));
  await eventually(() => asked.length === 1);
  assert.equal(asked[0].source.platform, 'weixin');
  assert.equal(asked[0].source.userId, 'wxid_staff');
  await bridge.waitForIdle?.();
});

function syncHarness(forwardPluginSources) {
  let listener;
  const ctx = { on: (name, fn) => { if (name === 'session/event') listener = fn; return () => {}; } };
  const delivered = [];
  const deliveryService = {
    listSessionSyncTargets: async () => [{ channel: 'slack', botId: 'b1', targetId: 't1' }],
    sendSessionSyncText: async (botId, targetId, sessionId, text) => { delivered.push({ botId, targetId, sessionId, text }); },
  };
  const turns = [];
  const coordinator = installSessionSyncCoordinator(ctx, deliveryService, {
    logger: quiet, inputScope: {}, forwardPluginSources, onTurnEvent: (sessionId, event) => turns.push([sessionId, event.type]),
  });
  const session = { id: 's-proactive' };
  const run = async () => {
    listener(session, { type: 'turn/start', data: { turn: 1 } });
    listener(session, {
      type: 'user/message', surfaceOp: 'append',
      data: { source: { kind: 'plugin:dsh-proactive', form: 'notice', summary: 'wake' }, content: [{ type: 'text', text: '[framing]' }] },
    });
    listener(session, {
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '本日の承認待ちは 2 件です。' }] } },
    });
    listener(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
    await coordinator.whenIdle();
  };
  return { run, delivered, turns };
}

test('dsh-proactive wakes are mirrored to IM only when configured, without echoing the framing', async () => {
  const off = syncHarness([]);
  await off.run();
  assert.deepEqual(off.delivered, [], 'upstream default: plugin wakes stay in the Session');

  const on = syncHarness(['dsh-proactive']);
  await on.run();
  assert.equal(on.delivered.length, 1);
  assert.equal(on.delivered[0].sessionId, 's-proactive');
  assert.match(on.delivered[0].text, /本日の承認待ちは 2 件です。/);
  assert.doesNotMatch(on.delivered[0].text, /framing/);
  assert.deepEqual(on.turns, [['s-proactive', 'turn/start'], ['s-proactive', 'turn/end']]);
});

test('the Host provides the care API, idempotent send and the dsh-im/inbound event', async (t) => {
  const { dir } = await useHub(t);
  const sent = [];
  const deliveryService = {
    async send(...args) { sent.push(args); return { sent: true }; },
    async listBots() { return [{ botId: 'wx_bot', channel: 'weixin' }]; },
    async listTargets() { return { targets: [] }; },
  };
  const provided = [];
  const emitted = [];
  const effects = [];
  const channelApply = async () => {};
  const internals = {
    createDeliveryService: () => deliveryService,
    installUpdateRpc: () => {}, installDeliveryRpc: () => {}, installDeliveryHttp: () => {},
    installSessionSyncCoordinator: () => {},
  };
  for (const name of ['applyFeishu', 'applyWeixin', 'applyDingtalk', 'applyWecom', 'applyWecomApp', 'applyQq', 'applySlack',
    'applyTelegram', 'applyDiscord', 'applyWhatsapp', 'applyIMessage', 'applyEmail', 'applyMatrix', 'applyOffice']) {
    internals[name] = channelApply;
  }
  const ctx = {
    effect: (fn) => effects.push(fn),
    provide: (...args) => provided.push(args),
    emit: (...args) => emitted.push(args),
  };
  await createImHostPlugin(internals).apply(ctx, { dshHome: dir });
  const dshIm = provided[0][1];
  for (const method of ['sourceForTurn', 'setAccessResolver', 'sendCard', 'updateCard', 'onAction', 'claimReplies', 'send', 'consumeInbound']) {
    assert.equal(typeof dshIm[method], 'function', method);
  }
  assert.equal(dshIm.careExtensionsVersion, 1);
  assert.equal(imExtensions.accessDefault, 'closed');

  // send(): unchanged without a key; at most once with a key.
  assert.deepEqual(await dshIm.send('wx_bot', 'target', 'hello'), { sent: true });
  assert.deepEqual(sent.at(-1), ['wx_bot', 'target', 'hello', undefined]);
  assert.deepEqual(await dshIm.send('wx_bot', 'target', 'reminder', { idempotencyKey: 'daily:2026-10-25', format: 'plain' }), { sent: true, deduped: false });
  assert.deepEqual(await dshIm.send('wx_bot', 'target', 'reminder', { idempotencyKey: 'daily:2026-10-25' }), { sent: true, deduped: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], ['wx_bot', 'target', 'reminder', { format: 'plain' }]);
  const stored = JSON.parse(await readFile(join(dir, 'integrations', 'dsh-im', 'care-delivery.json'), 'utf8'));
  assert.ok(stored.deliveries['send:wx_bot:daily:2026-10-25']);

  // Weixin (no card driver connected) receives textFallback through proactive delivery.
  const card = await dshIm.sendCard({ botId: 'wx_bot', to: { userId: 'wxid_staff' }, idempotencyKey: 'approval:2:wxid_staff',
    card: { title: '承認依頼', textFallback: '「承認 111111」と返信してください' } });
  assert.equal(card.deduped, false);
  assert.deepEqual(sent.at(-1).slice(0, 2), ['wx_bot', { kind: 'user', route: { toUserId: 'wxid_staff' } }]);
  assert.match(sent.at(-1)[2], /「承認 111111」/);

  // dsh-im/inbound is a Host event.
  imExtensions.recordTurnSource('sess', {
    platform: 'weixin', botId: 'wx_bot', userId: 'wxid_staff', conversationId: 'wxid_staff', messageId: 'm1',
  }, 'こんにちは');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'dsh-im/inbound');
  assert.equal(emitted[0][1].sessionId, 'sess');
  assert.equal(dshIm.sourceForTurn('sess').userId, 'wxid_staff');

  // Disposal returns the hub to its pristine state.
  for (const effect of effects) effect()?.();
  assert.equal(imExtensions.accessDefault, 'legacy');
  await settle(1);
});
