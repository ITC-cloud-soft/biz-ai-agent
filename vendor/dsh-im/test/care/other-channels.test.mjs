// care fork: the inbound gate on the self-bridged text channels (WeCom app as
// the representative; DingTalk, WeCom AI bot and QQ share the same wiring).
import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomAppBridge } from '../../src/channels/wecom-app/wecom-app-bridge.mjs';
import { createWecomAppRuntimeStatus } from '../../src/channels/wecom-app/wecom-app-runtime.mjs';
import {
  eventually, harnessFixture, policyProvider, quiet, scope, settle, stateFixture, useHub,
} from './support.mjs';

function message(text, { from = 'zhangsan', id = 'm1' } = {}) {
  return { msgid: id, msgtype: 'text', from: { userid: from }, text: { content: text }, create_time: 1_700_000_000 };
}

function bridgeFixture(policy) {
  const sent = [];
  const { harness, asked } = harnessFixture();
  const { state } = stateFixture();
  const bridge = new WecomAppBridge({
    api: { sendText: async (request) => { sent.push(request); return { msgid: `out-${sent.length}` }; } },
    harness, state, accessPolicy: policy, logger: quiet, botId: 'wa_bot', status: createWecomAppRuntimeStatus(),
  });
  return { bridge, sent, asked };
}

test('WeCom app: claims, resolver and trusted source on a self-bridged channel', async (t) => {
  const { hub } = await useHub(t);
  const policy = policyProvider('wa_bot', { direct: scope('allowlist', []) });
  const claimed = [];
  hub.claimReplies((text) => text.startsWith('連携'), async ({ source, reply }) => {
    claimed.push(source.userId);
    await reply('連携しました');
  });
  hub.setAccessResolver(async (source) => (source.userId === 'zhangsan' ? 'allow' : { deny: true, reply: '未連携です' }));
  const { bridge, sent, asked } = bridgeFixture(policy);

  await bridge.accept(message('連携 123456', { from: 'lisi', id: 'm1' }));
  await eventually(() => sent.length === 1);
  assert.deepEqual(claimed, ['lisi']);
  assert.equal(sent[0].content, '連携しました');

  await bridge.accept(message('こんにちは', { from: 'lisi', id: 'm2' }));
  await eventually(() => sent.length === 2);
  assert.equal(sent[1].content, '未連携です');
  assert.equal(asked.length, 0);

  await bridge.accept(message('今日の予定', { from: 'zhangsan', id: 'm3' }));
  await eventually(() => asked.length === 1);
  const { at, ...source } = asked[0].source;
  assert.deepEqual(source, {
    platform: 'wecom-app', botId: 'wa_bot', userId: 'zhangsan', conversationId: 'zhangsan',
    conversationKind: 'direct', messageId: 'm3',
  });
});

test('WeCom app: default-closed without a resolver admits only the allowlist', async (t) => {
  await useHub(t);
  const { bridge, asked } = bridgeFixture(policyProvider('wa_bot', { direct: scope('open', ['granted']) }));
  await bridge.accept(message('hello', { from: 'stranger', id: 'x1' }));
  await settle();
  assert.equal(asked.length, 0);
  await bridge.accept(message('hello', { from: 'granted', id: 'x2' }));
  await eventually(() => asked.length === 1);
});
