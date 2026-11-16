// care fork: shared bots (personal WeChat allows one iLink bot per account).
// A conversation router assigns the business application of each inbound
// message; the conversation key, the trusted source, replies and proactive
// notifications follow it. Ordinary bots (WeCom app, Slack, ...) are unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createImHostPlugin } from '../../plugin-src/host/index.mjs';
import { imExtensions, normalizeImSource, scopedConversationKey } from '../../src/channels/shared/im-extensions.mjs';
import { WEIXIN_API_BASE_ENV, normalizeWeixinApiBaseUrl, weixinTestApiBase } from '../../src/channels/weixin/weixin-api.mjs';
import { WeixinHarnessBridge } from '../../src/channels/weixin/weixin-bridge.mjs';
import { WecomAppBridge } from '../../src/channels/wecom-app/wecom-app-bridge.mjs';
import { createWecomAppRuntimeStatus } from '../../src/channels/wecom-app/wecom-app-runtime.mjs';
import { eventually, policyProvider, quiet, scope, settle, stateFixture, useHub } from './support.mjs';

const NAMES = { 'care-billing': 'ケアビリング', 'bridge-demo': '設備点検' };

/** A Harness double with one Session per conversation key (as the real bot-scoped Harness). */
function perKeyHarness() {
  const asked = [];
  const created = [];
  return {
    asked,
    created,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async ({ conversationKey } = {}) => {
        const sessionId = `s:${conversationKey}`;
        created.push({ sessionId, conversationKey });
        return sessionId;
      },
      ask: async (sessionId, prompt) => {
        asked.push({ sessionId, prompt, source: imExtensions.sourceForTurn(sessionId) });
        return `answer to ${typeof prompt === 'string' ? prompt : 'content'}`;
      },
    },
  };
}

function weixinMessage(text, { from = 'wxid_staff', id = 1, quote } = {}) {
  const items = [{ type: 1, text_item: { text } }];
  if (quote) items[0].ref_msg = { message_item: { type: 1, text_item: { text: quote } } };
  return {
    message_id: id, seq: id, message_type: 1, from_user_id: from, to_user_id: 'bot',
    context_token: `ctx-${id}`, item_list: items,
  };
}

function weixinBridge() {
  const sent = [];
  const { harness, asked, created } = perKeyHarness();
  const fixture = stateFixture();
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => { sent.push(request); return { messageId: `out-${sent.length}` }; },
      sendTyping: async () => ({}),
      getConfig: async () => ({}),
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'wxid_staff',
    harness,
    state: fixture.state,
    accessPolicy: policyProvider('wx_shared', { direct: scope('allowlist', []), privileged: ['wxid_staff'] }),
    logger: quiet,
    botId: 'wx_shared',
  });
  return { bridge, sent, asked, created, sessions: fixture.sessions };
}

/** A router like care-identity's: current application per conversation, #<name> claims, 【name】 replies. */
function installRouter(hub, { shared = (source) => source.botId === 'wx_shared' } = {}) {
  const current = new Map();
  const routed = [];
  hub.setConversationRouter({
    route({ source, text, replyTo }) {
      routed.push({ text, replyTo, botId: source.botId });
      if (!shared(source)) return null;
      const quotedApp = Object.entries(NAMES).find(([, name]) => replyTo?.content?.startsWith(`【${name}】`))?.[0];
      if (quotedApp) current.set(source.userId, quotedApp);
      return { applicationId: current.get(source.userId) ?? 'care-billing' };
    },
    decorateReply: (source, text) => (text.startsWith('【') ? text : `【${NAMES[source.applicationId]}】${text}`),
    decorateOutbound: ({ text, applicationId, botId }) => (botId === 'wx_shared' ? `【${NAMES[applicationId ?? 'care-billing']}】${text}` : text),
  });
  hub.claimReplies((text, source) => shared(source) && /^#\S+$/u.test(text), async ({ text, source, reply }) => {
    const id = Object.entries(NAMES).find(([, name]) => `#${name}` === text)?.[0] ?? (text === '#介護' ? 'care-billing' : null);
    if (id) current.set(source.userId, id);
    await reply(id ? `【${NAMES[id]}】に切り替えました` : '【アプリ一覧】ありません');
  });
  hub.setAccessResolver(async () => 'allow');
  return { current, routed };
}

test('normalizeImSource keeps a valid applicationId only; scopedConversationKey suffixes it', () => {
  const base = { platform: 'weixin', botId: 'b', userId: 'u', conversationId: 'u', messageId: 'm' };
  assert.equal(normalizeImSource({ ...base, applicationId: 'bridge-demo' }).applicationId, 'bridge-demo');
  assert.equal(normalizeImSource({ ...base, applicationId: 'Bad App' }).applicationId, undefined);
  assert.equal(normalizeImSource(base).applicationId, undefined);
  assert.equal(scopedConversationKey('p2p:u', { applicationId: 'bridge-demo' }), 'p2p:u:app:bridge-demo');
  assert.equal(scopedConversationKey('p2p:u', {}), 'p2p:u');
  assert.equal(scopedConversationKey('p2p:u', null), 'p2p:u');
  assert.equal(scopedConversationKey('p2p:u', { applicationId: '../x' }), 'p2p:u');
});

test('shared WeChat bot: one Session per application, replies prefixed, source carries applicationId', async (t) => {
  const { hub } = await useHub(t);
  const { routed } = installRouter(hub);
  const { bridge, sent, asked, created } = weixinBridge();

  await bridge.accept(weixinMessage('今日の訪問は？', { id: 1 }));
  await eventually(() => asked.length === 1 && sent.length === 1);
  assert.equal(asked[0].sessionId, 's:p2p:wxid_staff:app:care-billing');
  assert.equal(asked[0].source.applicationId, 'care-billing');
  assert.equal(sent[0].text, '【ケアビリング】answer to 今日の訪問は？');

  // #設備点検 is claimed (never reaches an agent) and answered with the router's wording
  await bridge.accept(weixinMessage('#設備点検', { id: 2 }));
  await eventually(() => sent.length === 2);
  assert.equal(sent[1].text, '【設備点検】に切り替えました');
  assert.equal(asked.length, 1);

  await bridge.accept(weixinMessage('期限切れの点検は？', { id: 3 }));
  await eventually(() => asked.length === 2 && sent.length === 3);
  assert.equal(asked[1].sessionId, 's:p2p:wxid_staff:app:bridge-demo', 'a separate Session');
  assert.equal(asked[1].source.applicationId, 'bridge-demo');
  assert.equal(sent[2].text, '【設備点検】answer to 期限切れの点検は？');
  assert.deepEqual(created.map((c) => c.conversationKey), ['p2p:wxid_staff:app:care-billing', 'p2p:wxid_staff:app:bridge-demo']);

  // A reply quoting a 【ケアビリング】 message is routed back to that application (the router sees the quote).
  await bridge.accept(weixinMessage('この件の詳細は？', { id: 4, quote: '【ケアビリング】answer to 今日の訪問は？' }));
  await eventually(() => asked.length === 3);
  assert.equal(asked[2].sessionId, 's:p2p:wxid_staff:app:care-billing');
  assert.equal(routed.at(-1).replyTo.content, '【ケアビリング】answer to 今日の訪問は？');
  await bridge.waitForIdle?.();
});

test('shared bot: claim and denial replies are decorated; a failing router falls back to the bot default', async (t) => {
  const { hub } = await useHub(t);
  hub.setConversationRouter({
    route: () => ({ applicationId: 'bridge-demo' }),
    decorateReply: (source, text) => `【${NAMES[source.applicationId]}】${text}`,
  });
  const seen = [];
  hub.claimReplies((text) => text.startsWith('連携'), async ({ source, reply }) => {
    seen.push(source.applicationId);
    await reply('連携が完了しました。');
  });
  hub.setAccessResolver(async (source) => { seen.push(`resolver:${source.applicationId}`); return { deny: true, reply: '連携してください' }; });
  const { bridge, sent, asked } = weixinBridge();
  await bridge.accept(weixinMessage('連携 123456', { id: 1 }));
  await bridge.accept(weixinMessage('こんにちは', { id: 2 }));
  await eventually(() => sent.length === 2);
  assert.deepEqual(seen, ['bridge-demo', 'resolver:bridge-demo']);
  assert.deepEqual(sent.map((s) => s.text), ['【設備点検】連携が完了しました。', '【設備点検】連携してください']);
  assert.equal(asked.length, 0);

  hub.reset();
  hub.configure({ accessDefault: 'closed', logger: quiet });
  hub.setConversationRouter(() => { throw new Error('router down'); });
  hub.setAccessResolver(async () => 'allow');
  await bridge.accept(weixinMessage('ふつうの質問', { id: 3 }));
  await eventually(() => asked.length === 1);
  assert.equal(asked[0].sessionId, 's:p2p:wxid_staff', 'no application: the original key');
  assert.equal(asked[0].source.applicationId, undefined);
  await bridge.waitForIdle?.();
});

test('WeCom app (one bot per application): the router answers null, keys and sources stay per bot', async (t) => {
  const { hub } = await useHub(t);
  const { routed } = installRouter(hub);
  const bridges = ['wa_care', 'wa_demo'].map((botId) => {
    const sent = [];
    const { harness, asked } = perKeyHarness();
    const { state } = stateFixture();
    const bridge = new WecomAppBridge({
      api: { sendText: async (request) => { sent.push(request); return { msgid: `out-${sent.length}` }; } },
      harness, state, accessPolicy: policyProvider(botId, { direct: scope('allowlist', []) }), logger: quiet, botId,
      status: createWecomAppRuntimeStatus(),
    });
    return { botId, bridge, sent, asked };
  });
  const message = (text, id) => ({ msgid: id, msgtype: 'text', from: { userid: 'zhangsan' }, text: { content: text }, create_time: 1_700_000_000 });
  await bridges[0].bridge.accept(message('今日の訪問は？', 'c1'));
  await bridges[1].bridge.accept(message('期限切れの点検は？', 'd1'));
  await eventually(() => bridges.every((b) => b.asked.length === 1));
  for (const b of bridges) {
    assert.equal(b.asked[0].source.botId, b.botId);
    assert.equal(b.asked[0].source.applicationId, undefined, 'ordinary bots get no applicationId');
    assert.equal(b.asked[0].sessionId, 's:p2p:zhangsan', 'the unchanged key, inside each bot\'s own state');
    assert.doesNotMatch(String(b.sent[0]?.content ?? ''), /^【/, 'no prefix');
  }
  assert.deepEqual(routed.map((r) => r.botId), ['wa_care', 'wa_demo']);
  // #設備点検 is not a command on an ordinary bot (the claim matcher checks the bot): it reaches the agent
  await bridges[1].bridge.accept(message('#設備点検', 'd2'));
  await eventually(() => bridges[1].asked.length === 2);
  await settle();
});

test('proactive text and card fallbacks to a shared bot are decorated by the router; applicationId is not passed on', async (t) => {
  const { dir } = await useHub(t);
  const sent = [];
  const deliveryService = {
    async send(...args) { sent.push(args); return { sent: true }; },
    async listBots() { return [{ botId: 'wx_shared', channel: 'weixin' }, { botId: 'wa_demo', channel: 'wecom-app' }]; },
    async listTargets() { return { targets: [] }; },
  };
  const provided = [];
  const internals = {
    createDeliveryService: () => deliveryService,
    installUpdateRpc: () => {}, installDeliveryRpc: () => {}, installDeliveryHttp: () => {},
    installSessionSyncCoordinator: () => {},
  };
  for (const name of ['applyFeishu', 'applyWeixin', 'applyDingtalk', 'applyWecom', 'applyWecomApp', 'applyQq', 'applySlack',
    'applyTelegram', 'applyDiscord', 'applyWhatsapp', 'applyIMessage', 'applyEmail', 'applyMatrix', 'applyOffice']) {
    internals[name] = async () => {};
  }
  const effects = [];
  await createImHostPlugin(internals).apply({ effect: (fn) => effects.push(fn), provide: (...a) => provided.push(a), emit: () => {} }, { dshHome: dir });
  const dshIm = provided[0][1];
  assert.equal(typeof dshIm.setConversationRouter, 'function');
  const outbound = [];
  const dispose = dshIm.setConversationRouter({
    route: () => null,
    decorateOutbound: (input) => {
      outbound.push(input);
      return input.botId === 'wx_shared' ? `【${NAMES[input.applicationId ?? 'care-billing']}】${input.text}` : input.text;
    },
  });
  await dshIm.send('wx_shared', 'manager', '点検期限を過ぎた設備があります', { applicationId: 'bridge-demo' });
  assert.deepEqual(sent.at(-1), ['wx_shared', 'manager', '【設備点検】点検期限を過ぎた設備があります', {}]);
  await dshIm.send('wx_shared', { kind: 'user', route: { toUserId: 'wxid_a' } }, '記録が提出されました', { applicationId: 'care-billing', idempotencyKey: 'k1' });
  assert.equal(sent.at(-1)[2], '【ケアビリング】記録が提出されました');
  assert.deepEqual(sent.at(-1)[3], {}, 'neither applicationId nor idempotencyKey reaches the channel');
  assert.deepEqual(outbound[1].to, { userId: 'wxid_a' });
  await dshIm.sendCard({ botId: 'wx_shared', to: { userId: 'wxid_a' }, idempotencyKey: 'notify:9:wxid_a', applicationId: 'bridge-demo',
    card: { title: '点検期限', textFallback: '期限を過ぎた設備が 1 件あります' } });
  assert.match(sent.at(-1)[2], /^【設備点検】/);
  assert.equal(outbound.at(-1).applicationId, 'bridge-demo');
  assert.equal(outbound.at(-1).kind, 'card');
  await dshIm.send('wa_demo', 'u1', 'ふつうのボット');
  assert.equal(sent.at(-1)[2], 'ふつうのボット');
  assert.equal(sent.at(-1)[3], undefined, 'no options stay no options');
  dispose();
  await dshIm.send('wx_shared', 'manager', 'ルーターなし');
  assert.equal(sent.at(-1)[2], 'ルーターなし');
  for (const effect of effects) effect()?.();
});

test('CARE_DSH_IM_WEIXIN_API_BASE: only a loopback origin becomes a trusted iLink base (test override)', () => {
  const warn = [];
  const logger = { warn: (m) => warn.push(m) };
  assert.equal(weixinTestApiBase({}, logger), null);
  assert.equal(weixinTestApiBase({ [WEIXIN_API_BASE_ENV]: 'http://127.0.0.1:19731' }, logger), 'http://127.0.0.1:19731/');
  assert.equal(weixinTestApiBase({ [WEIXIN_API_BASE_ENV]: 'https://ilinkai.example.com' }, logger), null);
  assert.equal(weixinTestApiBase({ [WEIXIN_API_BASE_ENV]: 'http://127.0.0.1.evil.example:80' }, logger), null);
  assert.equal(weixinTestApiBase({ [WEIXIN_API_BASE_ENV]: 'http://user:pw@127.0.0.1:1' }, logger), null);
  assert.ok(warn.some((m) => /ignoring/.test(m)));
  // without the process-wide override a loopback base is still refused
  const saved = process.env[WEIXIN_API_BASE_ENV];
  delete process.env[WEIXIN_API_BASE_ENV];
  try {
    assert.throws(() => normalizeWeixinApiBaseUrl('http://127.0.0.1:19731/'), /不受信任/);
    assert.equal(normalizeWeixinApiBaseUrl('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com/');
  } finally {
    if (saved !== undefined) process.env[WEIXIN_API_BASE_ENV] = saved;
  }
});
