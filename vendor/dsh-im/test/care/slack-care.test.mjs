// care fork: Slack over mocked Socket Mode envelopes — trusted sources, default
// deny, resolver, reply claims, Block Kit cards, block_actions and modals.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMessageRef } from '../../src/channels/shared/im-card.mjs';
import { SLACK_APP_MANIFEST_YAML } from '../../src/channels/slack/manifest.mjs';
import { SlackRuntime } from '../../src/channels/slack/slack-runtime.mjs';
import {
  FakeSocket, eventually, harnessFixture, policyProvider, quiet, settle, stateFixture, useHub,
} from './support.mjs';

const BOT_TOKEN = `xoxb-${'0'.repeat(24)}-not-a-real-token`;
const APP_TOKEN = `xapp-${'0'.repeat(24)}-not-a-real-token`;
const BOT_ID = 'slack_care';
const APP_ID = 'A12345678';

function apiFixture() {
  const calls = { posted: [], updated: [], opened: [], views: [], reactions: 0 };
  let ts = 0;
  const api = {
    authTest: async () => ({ team_id: 'T12345678', user_id: 'U12345678' }),
    openConnection: async () => ({ url: 'wss://wss-primary.slack.com/link/?ticket=test' }),
    postMessage: async (request) => {
      calls.posted.push(request);
      ts += 1;
      return { ok: true, channel: request.channelId, ts: `1700000100.00000${ts}` };
    },
    updateMessage: async (request) => { calls.updated.push(request); return { ok: true }; },
    openDirectConversation: async ({ userId }) => { calls.opened.push(userId); return 'D99999999'; },
    openView: async (request) => { calls.views.push(request); return { ok: true }; },
    startStream: async () => { throw new Error('streams disabled in this test'); },
    addReaction: async () => { calls.reactions += 1; },
    removeReaction: async () => {},
  };
  return { api, calls };
}

async function startRuntime(t, { policy = policyProvider(BOT_ID) } = {}) {
  let socket;
  const { api, calls } = apiFixture();
  const { harness, asked } = harnessFixture();
  const { state, seen } = stateFixture();
  const runtime = new SlackRuntime({
    config: { botId: BOT_ID, platformId: 'T12345678:U12345678', name: 'Care' },
    botToken: BOT_TOKEN,
    appToken: APP_TOKEN,
    harness,
    state,
    accessPolicy: policy,
    createApi: () => api,
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.envelope({ type: 'hello', connection_info: { app_id: APP_ID } }));
      return socket;
    },
    logger: quiet,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return { runtime, socket, calls, asked, seen };
}

function dm(socket, { id, user = 'U87654321', text, channel = 'D12345678', ts = '1700000000.000100' }) {
  socket.envelope({
    type: 'events_api',
    envelope_id: `env-${id}`,
    payload: {
      type: 'event_callback',
      api_app_id: APP_ID,
      team_id: 'T12345678',
      event_id: `Ev${id}`,
      event: { type: 'message', channel_type: 'im', channel, user, ts, text },
    },
  });
}

test('Slack manifest enables interactivity over Socket Mode and DM opening', () => {
  assert.match(SLACK_APP_MANIFEST_YAML, /interactivity:\n\s+is_enabled: true/);
  assert.match(SLACK_APP_MANIFEST_YAML, /\n\s+- im:write\n/);
  assert.match(SLACK_APP_MANIFEST_YAML, /socket_mode_enabled: true/);
});

test('default-closed: an open Slack bot ignores everyone when no resolver is set', async (t) => {
  await useHub(t, { accessDefault: 'closed' });
  const { socket, asked, seen, calls } = await startRuntime(t);
  dm(socket, { id: 1, text: 'こんにちは' });
  await eventually(() => seen.has('Ev1'));
  await settle();
  assert.equal(asked.length, 0, 'no agent turn for an unknown sender');
  assert.equal(calls.posted.length, 0, 'no reply to a denied sender');
  assert.deepEqual(socket.sent.find((packet) => packet.envelope_id === 'env-1'), { envelope_id: 'env-1' });
});

test('legacy-open keeps the upstream behavior for the same bot', async (t) => {
  await useHub(t, { accessDefault: 'legacy' });
  const { socket, asked } = await startRuntime(t);
  dm(socket, { id: 2, text: 'hello' });
  await eventually(() => asked.length === 1);
});

test('resolver allow: the turn carries the trusted Slack source and emits dsh-im/inbound', async (t) => {
  const { hub, inbound } = await useHub(t);
  const resolved = [];
  hub.setAccessResolver(async (source) => { resolved.push(source); return 'allow'; });
  const { socket, asked, calls } = await startRuntime(t);
  dm(socket, { id: 3, text: '8月の請求状況は？', ts: '1700000000.000300' });
  await eventually(() => asked.length === 1);
  const expected = {
    platform: 'slack',
    botId: BOT_ID,
    teamId: 'T12345678',
    userId: 'U87654321',
    conversationId: 'D12345678',
    conversationKind: 'direct',
    messageId: '1700000000.000300',
    threadId: undefined,
  };
  const { at, threadId, ...source } = asked[0].source;
  assert.equal(typeof at, 'string');
  assert.equal(threadId, undefined);
  delete expected.threadId;
  assert.deepEqual(source, expected);
  assert.equal(resolved.length, 1);
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].sessionId, 'session-1');
  assert.equal(inbound[0].source, asked[0].source);
  assert.match(inbound[0].text, /8月の請求状況/);
  await eventually(() => calls.posted.some((request) => request.text === '了解しました'));
  // The turn is over: its source is forgotten.
  assert.equal(hub.sourceForTurn('session-1'), null);
});

test('resolver deny with reply: the sender gets the fixed reply and no agent turn', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(async () => ({ deny: true, reply: '先に連携してください。' }));
  const { socket, asked, calls, seen } = await startRuntime(t);
  dm(socket, { id: 4, text: '請求を見せて' });
  await eventually(() => calls.posted.length === 1);
  assert.equal(calls.posted[0].text, '先に連携してください。');
  assert.equal(calls.posted[0].channelId, 'D12345678');
  await eventually(() => seen.has('Ev4'));
  await settle();
  assert.equal(asked.length, 0);
});

test('claimReplies intercepts a reply before the agent, even for an unlinked sender', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(async () => ({ deny: true, reply: '未連携です' }));
  const claimed = [];
  hub.claimReplies((text) => /^(承認|差戻)\s*\d{6}/.test(text), async ({ text, source, reply }) => {
    claimed.push({ text, userId: source.userId, teamId: source.teamId, messageId: source.messageId });
    await reply('承認を受け付けました');
  });
  const { socket, asked, calls } = await startRuntime(t);
  dm(socket, { id: 5, text: '承認 123456', ts: '1700000000.000500' });
  await eventually(() => calls.posted.length === 1);
  assert.deepEqual(claimed, [{ text: '承認 123456', userId: 'U87654321', teamId: 'T12345678', messageId: '1700000000.000500' }]);
  assert.equal(calls.posted[0].text, '承認を受け付けました');
  // A normal message from the same unlinked sender still hits the resolver.
  dm(socket, { id: 6, text: 'ほかの話' });
  await eventually(() => calls.posted.length === 2);
  assert.equal(calls.posted[1].text, '未連携です');
  assert.equal(asked.length, 0, 'claimed and denied messages never reach the agent');
});

test('sendCard posts Block Kit once per idempotency key; updateCard edits it in place', async (t) => {
  const { hub } = await useHub(t);
  const { calls } = await startRuntime(t);
  const card = {
    title: '承認依頼',
    fields: [{ label: '件数', value: '3' }],
    actions: [{ id: 'care_approval:approve', label: '承認', style: 'primary', value: 'tok-9' }],
    textFallback: '「承認 654321」と返信',
  };
  const input = { botId: BOT_ID, to: { userId: 'U87654321' }, card, idempotencyKey: 'approval:9:U87654321' };
  const first = await hub.sendCard(input);
  const second = await hub.sendCard(input);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.messageRef, first.messageRef);
  assert.deepEqual(calls.opened, ['U87654321'], 'a userId target opens the bot DM once');
  assert.equal(calls.posted.length, 1);
  const posted = calls.posted[0];
  assert.equal(posted.channelId, 'D99999999');
  assert.equal(posted.blocks[0].type, 'header');
  assert.ok(posted.blocks.some((block) => block.type === 'actions'
    && block.elements[0].action_id === 'care_approval:approve' && block.elements[0].value === 'tok-9'));
  const ref = decodeMessageRef(first.messageRef);
  assert.deepEqual({ platform: ref.platform, botId: ref.botId, conversationId: ref.conversationId }, {
    platform: 'slack', botId: BOT_ID, conversationId: 'D99999999',
  });
  await hub.updateCard(first.messageRef, { title: '承認済み', footer: '山田さんが承認しました' });
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].ts, ref.messageId);
  assert.equal(calls.updated[0].blocks.some((block) => block.type === 'actions'), false, 'buttons are removed');
});

test('block_actions reach onAction with the trusted source; view_submission returns the reason', async (t) => {
  const { hub } = await useHub(t);
  const events = [];
  hub.onAction('care_approval:', async (event) => {
    const reason = event.actionId.endsWith(':reject')
      ? await event.openReasonDialog({ title: '差戻し理由', label: '理由を入力してください' })
      : null;
    events.push({
      actionId: event.actionId, value: event.value, userId: event.source.userId, teamId: event.source.teamId,
      kind: event.source.conversationKind, messageRef: event.messageRef, reason,
    });
    await event.respond(reason ? `差戻しました: ${reason}` : '承認しました');
  });
  const { socket, calls, asked } = await startRuntime(t);
  const press = (id, actionId, extra = {}) => socket.envelope({
    type: 'interactive',
    envelope_id: `env-${id}`,
    accepts_response_payload: true,
    payload: {
      type: 'block_actions',
      api_app_id: APP_ID,
      trigger_id: `trigger-${id}`,
      team: { id: 'T12345678' },
      user: { id: 'U87654321', team_id: 'T12345678', name: 'yamada' },
      channel: { id: 'D12345678' },
      container: { type: 'message', channel_id: 'D12345678', message_ts: '1700000100.000001' },
      message: { ts: '1700000100.000001' },
      actions: [{ action_id: actionId, block_id: 'b', value: 'tok-9', type: 'button', action_ts: `17000002${id}.0` }],
      ...extra,
    },
  });

  press(1, 'care_approval:approve');
  await eventually(() => events.length === 1);
  assert.deepEqual(socket.sent.find((packet) => packet.envelope_id === 'env-1'), { envelope_id: 'env-1' });
  assert.equal(events[0].actionId, 'care_approval:approve');
  assert.equal(events[0].value, 'tok-9');
  assert.equal(events[0].userId, 'U87654321');
  assert.equal(events[0].teamId, 'T12345678');
  assert.equal(events[0].kind, 'direct');
  assert.equal(decodeMessageRef(events[0].messageRef).messageId, '1700000100.000001');
  await eventually(() => calls.posted.some((request) => request.text === '承認しました'));

  press(2, 'care_approval:reject');
  await eventually(() => calls.views.length === 1);
  const view = calls.views[0];
  assert.equal(view.triggerId, 'trigger-2');
  assert.equal(view.view.type, 'modal');
  assert.equal(view.view.title.text, '差戻し理由');
  const submit = (user) => socket.envelope({
    type: 'interactive',
    envelope_id: `env-view-${user}`,
    payload: {
      type: 'view_submission',
      api_app_id: APP_ID,
      user: { id: user, team_id: 'T12345678' },
      view: {
        id: 'V1',
        callback_id: view.view.callback_id,
        private_metadata: view.view.private_metadata,
        state: { values: { reason: { reason: { type: 'plain_text_input', value: '  根拠資料が不足しています  ' } } } },
      },
    },
  });
  submit('U00000000');
  await settle();
  assert.equal(events.length, 1, 'another user cannot answer someone else\'s dialog');
  submit('U87654321');
  await eventually(() => events.length === 2);
  assert.equal(events[1].reason, '根拠資料が不足しています');
  await eventually(() => calls.posted.some((request) => request.text === '差戻しました: 根拠資料が不足しています'));

  // Presses without a registered handler and foreign apps are ignored.
  press(3, 'other:action');
  press(4, 'care_approval:approve', { api_app_id: 'AOTHERAPP' });
  await settle();
  assert.equal(events.length, 2);
  assert.equal(asked.length, 0, 'button presses never become prompts');
});
