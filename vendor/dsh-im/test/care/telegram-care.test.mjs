// care fork: Telegram over a mocked Bot API long-poll — trusted source
// extraction, default deny, reply claims, inline-keyboard cards and presses.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeMessageRef } from '../../src/channels/shared/im-card.mjs';
import { TelegramRuntime } from '../../src/channels/telegram/telegram-runtime.mjs';
import {
  eventually, harnessFixture, policyProvider, quiet, settle, stateFixture, useHub,
} from './support.mjs';

const BOT_ID = 'telegram_care';
const BOT_USER_ID = 777000;
const USER = 4242;

function apiFixture() {
  const calls = [];
  const queue = [];
  let wake = null;
  let messageId = 900;
  const record = (method) => async (request = {}) => {
    const { signal, ...rest } = request;
    calls.push({ method, ...rest });
    return {};
  };
  const api = {
    getMe: async () => ({ id: BOT_USER_ID, is_bot: true, username: 'care_bot' }),
    getWebhookInfo: async () => ({ url: '' }),
    setMyCommands: record('setMyCommands'),
    deleteMyCommands: record('deleteMyCommands'),
    setChatMenuButton: record('setChatMenuButton'),
    sendChatAction: record('sendChatAction'),
    setMessageReaction: record('setMessageReaction'),
    answerCallbackQuery: record('answerCallbackQuery'),
    editMessageReplyMarkup: record('editMessageReplyMarkup'),
    editMessageText: record('editMessageText'),
    deleteMessage: record('deleteMessage'),
    sendMessage: async ({ signal, ...request }) => {
      messageId += 1;
      calls.push({ method: 'sendMessage', ...request, result: messageId });
      return { message_id: messageId };
    },
    getUpdates: async ({ timeout, signal }) => {
      if (timeout === 0) return [];
      while (queue.length === 0) {
        await new Promise((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', resolve, { once: true });
        });
        if (signal?.aborted) return [];
      }
      return queue.splice(0);
    },
  };
  return {
    api,
    calls,
    push(update) { queue.push(update); wake?.(); },
    sent: () => calls.filter((call) => call.method === 'sendMessage'),
  };
}

async function startRuntime(t, { policy = policyProvider(BOT_ID) } = {}) {
  const fixture = apiFixture();
  const { harness, asked } = harnessFixture();
  const { state, seen } = stateFixture();
  let cursor = 0;
  state.cursor = () => cursor;
  state.setCursor = async (value) => { cursor = value; };
  const runtime = new TelegramRuntime({
    config: { botId: BOT_ID, platformId: String(BOT_USER_ID), username: 'care_bot', thinkingTraces: false },
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456',
    harness,
    state,
    accessPolicy: policy,
    createApi: () => fixture.api,
    createHttpTransport: () => ({ fetchImpl: async () => { throw new Error('no network in tests'); }, FormDataImpl: FormData, destroy: async () => {} }),
    logger: quiet,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return { runtime, asked, seen, ...fixture };
}

let updateId = 1000;
function privateMessage(text, { from = USER, messageId = 55 } = {}) {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      from: { id: from, is_bot: false, first_name: 'Taro' },
      chat: { id: from, type: 'private' },
      text,
    },
  };
}

function press(data, cardMessageId, { from = USER } = {}) {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: from, is_bot: false, first_name: 'Taro' },
      message: { message_id: cardMessageId, chat: { id: from, type: 'private' } },
      data,
    },
  };
}

test('Telegram: default-closed ignores an open bot\'s strangers; resolver allow carries the source', async (t) => {
  const { hub, inbound } = await useHub(t);
  const { push, asked, seen } = await startRuntime(t);
  const first = privateMessage('hello', { messageId: 55 });
  push(first);
  await eventually(() => seen.has(String(first.update_id)));
  await settle();
  assert.equal(asked.length, 0);

  hub.setAccessResolver(async (source) => (source.userId === String(USER) ? 'allow' : 'deny'));
  push(privateMessage('8月の承認待ちは？', { messageId: 56 }));
  await eventually(() => asked.length === 1);
  const { at, ...source } = asked[0].source;
  assert.equal(typeof at, 'string');
  assert.deepEqual(source, {
    platform: 'telegram',
    botId: BOT_ID,
    userId: String(USER),
    conversationId: String(USER),
    conversationKind: 'direct',
    messageId: '56',
  });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].source.messageId, '56');
});

test('Telegram: claimReplies takes a typed decision before the agent', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(async () => 'allow');
  const claimed = [];
  hub.claimReplies((text) => text.startsWith('差戻'), async ({ text, source, reply }) => {
    claimed.push([text, source.userId]);
    await reply('差戻しを受け付けました');
  });
  const { push, asked, sent } = await startRuntime(t);
  push(privateMessage('差戻 123456 根拠不足', { messageId: 57 }));
  await eventually(() => sent().some((call) => call.text === '差戻しを受け付けました'));
  assert.deepEqual(claimed, [['差戻 123456 根拠不足', String(USER)]]);
  await settle();
  assert.equal(asked.length, 0);
});

test('Telegram: sendCard uses an inline keyboard; a press reaches onAction; updateCard edits it', async (t) => {
  const { hub } = await useHub(t);
  const actions = [];
  hub.onAction('care_approval:', async (event) => {
    actions.push({ actionId: event.actionId, value: event.value, userId: event.source.userId, messageRef: event.messageRef });
    await event.respond('承認しました');
  });
  const { push, calls, sent, asked } = await startRuntime(t);
  const card = {
    title: '承認依頼',
    fields: [{ label: '件数', value: '3' }],
    actions: [
      { id: 'care_approval:approve', label: '承認', style: 'primary', value: 'token-approve' },
      { id: 'care_approval:reject', label: '差戻', style: 'danger', value: 'token-reject' },
    ],
    textFallback: '「承認 123456」と返信',
  };
  const result = await hub.sendCard({ botId: BOT_ID, to: { userId: String(USER) }, card, idempotencyKey: 'approval:1:4242' });
  assert.equal((await hub.sendCard({ botId: BOT_ID, to: { userId: String(USER) }, card, idempotencyKey: 'approval:1:4242' })).deduped, true);
  assert.equal(sent().length, 1);
  const message = sent()[0];
  assert.equal(message.chatId, USER);
  assert.doesNotMatch(message.text, /token-/, 'action values stay out of the visible text');
  const keyboard = message.replyMarkup.inline_keyboard[0];
  assert.deepEqual(keyboard.map((button) => button.text), ['承認', '差戻']);
  assert.ok(keyboard.every((button) => /^dc:[A-Za-z0-9_-]+:\d$/.test(button.callback_data)
    && Buffer.byteLength(button.callback_data) <= 64));
  const ref = decodeMessageRef(result.messageRef);
  assert.deepEqual(ref, { platform: 'telegram', botId: BOT_ID, conversationId: String(USER), messageId: String(message.result) });

  push(press(keyboard[1].callback_data, message.result));
  await eventually(() => actions.length === 1);
  assert.deepEqual(actions[0], {
    actionId: 'care_approval:reject', value: 'token-reject', userId: String(USER), messageRef: result.messageRef,
  });
  await eventually(() => calls.some((call) => call.method === 'answerCallbackQuery'));
  await eventually(() => sent().some((call) => call.text === '承認しました'));

  // A forged callback (unknown card id) is refused without reaching a handler.
  push(press('dc:AAAAAAAAAAAA:0', message.result));
  await eventually(() => calls.filter((call) => call.method === 'answerCallbackQuery').length === 2);
  assert.equal(actions.length, 1);

  await hub.updateCard(result.messageRef, { title: '差戻し済み', footer: '理由: 根拠不足' });
  const edit = calls.find((call) => call.method === 'editMessageText');
  assert.equal(edit.messageId, message.result);
  assert.match(edit.text, /差戻し済み/);
  const markup = calls.find((call) => call.method === 'editMessageReplyMarkup');
  assert.deepEqual(markup.replyMarkup, { inline_keyboard: [] }, 'buttons are removed after the decision');
  assert.equal(asked.length, 0, 'presses never become prompts');
});

test('Telegram: replying to a card does not carry the card text into the prompt', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(async () => 'allow');
  const { push, asked, sent } = await startRuntime(t);
  const card = { title: '承認依頼 #A12', fields: [{ label: '返信コード', value: '654321' }] };
  await hub.sendCard({ botId: BOT_ID, to: { userId: String(USER) }, card, idempotencyKey: 'approval:quote' });
  const cardMessage = sent()[0];
  const reply = privateMessage('これは何の件？', { messageId: 60 });
  reply.message.reply_to_message = {
    message_id: cardMessage.result, date: 1_700_000_000,
    from: { id: BOT_USER_ID, is_bot: true, first_name: 'Care' }, chat: { id: USER, type: 'private' },
    text: cardMessage.text,
  };
  push(reply);
  await eventually(() => asked.length === 1);
  const prompt = JSON.stringify(asked[0].prompt);
  assert.match(prompt, /これは何の件/);
  assert.doesNotMatch(prompt, /654321|承認依頼/, 'card content stays out of the agent prompt');

  // A partial quote of the card text is recognised as well.
  const quoted = privateMessage('この件', { messageId: 61 });
  quoted.message.reply_to_message = { message_id: 1, date: 1_700_000_000, from: { id: 1, is_bot: false }, chat: { id: USER, type: 'private' }, text: '返信コード: 654321' };
  push(quoted);
  await eventually(() => asked.length === 2);
  assert.doesNotMatch(JSON.stringify(asked[1].prompt), /654321/);
});
