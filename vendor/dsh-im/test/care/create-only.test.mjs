// care fork (S1): `createOnly: true` on every bot-creating management RPC. A bind / QR attempt whose bot identity already
// exists changes nothing (no credential write, no config save, no runtime start) and fails with `bot-exists`.
// Without the key the upstream behaviour (re-bind = overwrite) is unchanged. Mocks only: no network, no real accounts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BOT_EXISTS, BOT_EXISTS_MESSAGE, assertCreatable, validCreateOnly } from '../../src/channels/shared/create-only.mjs';
import { diagnosticRpcResult, createConnectionDiagnostics } from '../../src/channels/shared/connection-error.mjs';
import { t as translate } from '../../src/channels/shared/i18n.mjs';
import { TelegramConfigStore } from '../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../src/channels/telegram/telegram-controller.mjs';
import { createTelegramRpcHandler } from '../../plugin-src/host/channels/telegram/rpc.mjs';
import { SlackConfigStore } from '../../src/channels/slack/config-store.mjs';
import { SlackController } from '../../src/channels/slack/slack-controller.mjs';
import { createSlackRpcHandler } from '../../plugin-src/host/channels/slack/rpc.mjs';
import { LineConfigStore } from '../../src/channels/line/config-store.mjs';
import { LineController } from '../../src/channels/line/line-controller.mjs';
import { createLineRpcHandler } from '../../plugin-src/host/channels/line/rpc.mjs';
import { MatrixConfigStore } from '../../src/channels/matrix/matrix-config-store.mjs';
import { MatrixController } from '../../src/channels/matrix/matrix-controller.mjs';
import { createMatrixRpcHandler } from '../../plugin-src/host/channels/matrix/rpc.mjs';
import { WecomAppConfigStore } from '../../src/channels/wecom-app/config-store.mjs';
import { WecomAppController } from '../../src/channels/wecom-app/wecom-app-controller.mjs';
import { createWecomAppRpcHandler } from '../../plugin-src/host/channels/wecom-app/rpc.mjs';
import { WecomController } from '../../src/channels/wecom/wecom-controller.mjs';
import { createWecomRpcHandler } from '../../plugin-src/host/channels/wecom/rpc.mjs';
import { QqController } from '../../src/channels/qq/qq-controller.mjs';
import { createQqRpcHandler } from '../../plugin-src/host/channels/qq/rpc.mjs';
import { DingtalkController } from '../../src/channels/dingtalk/dingtalk-controller.mjs';
import { createDingtalkRpcHandler } from '../../plugin-src/host/channels/dingtalk/rpc.mjs';
import { MultiBotDshFeishuController } from '../../src/channels/feishu/multi-bot-controller.mjs';
import { createFeishuRpcHandler } from '../../plugin-src/host/channels/feishu/rpc.mjs';
import { WeixinController } from '../../src/channels/weixin/weixin-controller.mjs';
import { createWeixinRpcHandler } from '../../plugin-src/host/channels/weixin/rpc.mjs';
import { WhatsappConfigStore } from '../../src/channels/whatsapp/config-store.mjs';
import { WhatsappController } from '../../src/channels/whatsapp/whatsapp-controller.mjs';
import { createWhatsappRpcHandler } from '../../plugin-src/host/channels/whatsapp/rpc.mjs';
import { eventually, quiet } from './support.mjs';

const encodeQr = async () => 'data:image/png;base64,QUJD';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-create-only-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Credentials double: values + every write (set / unset). */
function credentials() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    provider: {
      resolve: async (ref) => (values.has(ref) ? { configured: true, source: 'test', value: values.get(ref) } : undefined),
      set: async (ref, value) => { writes.push(['set', ref]); values.set(ref, value); },
      unset: async (ref) => { writes.push(['unset', ref]); values.delete(ref); },
    },
  };
}

/** Counts runtime creations; the runtime is ready at once. */
function runtimes() {
  const created = [];
  return {
    created,
    createRuntime: async (args = {}) => {
      created.push(args);
      let ready = false;
      return {
        get status() { return { ready, connectionState: ready ? 'connected' : 'idle', harnessReachable: ready, lastCheckedAt: 10 }; },
        async start() { ready = true; },
        async stop() { ready = false; },
      };
    },
  };
}

/** An in-memory config store with the lookups the controllers use; counts saves. */
function memoryStore(lookups = {}) {
  const bots = [];
  const saves = [];
  const store = {
    list: () => structuredClone(bots),
    get: (botId) => structuredClone(bots.find((bot) => bot.botId === botId) ?? null),
    save: async (value) => {
      saves.push(value.botId);
      const index = bots.findIndex((bot) => bot.botId === value.botId);
      if (index === -1) bots.push(structuredClone(value)); else bots[index] = structuredClone(value);
      return structuredClone(value);
    },
    remove: async (botId) => {
      const index = bots.findIndex((bot) => bot.botId === botId);
      return index === -1 ? null : bots.splice(index, 1)[0];
    },
  };
  for (const [name, key] of Object.entries(lookups)) {
    store[name] = (value) => structuredClone(bots.find((bot) => bot[key] === value) ?? null);
  }
  return { bots, saves, store };
}

const botExists = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, BOT_EXISTS);
  assert.equal(result.error.message, translate(BOT_EXISTS_MESSAGE));
};

test('create-only helpers: boolean flag, assertCreatable throws bot-exists only with createOnly=true', () => {
  for (const value of [undefined, true, false]) assert.equal(validCreateOnly(value), true);
  for (const value of ['true', 1, null, {}]) assert.equal(validCreateOnly(value), false);
  assert.doesNotThrow(() => assertCreatable(true, null, undefined));
  assert.doesNotThrow(() => assertCreatable(false, { botId: 'x' }));
  assert.doesNotThrow(() => assertCreatable(undefined, { botId: 'x' }));
  assert.throws(() => assertCreatable(true, null, { botId: 'x' }), (error) => error.code === BOT_EXISTS && error.botId === 'x');
  const result = diagnosticRpcResult(createConnectionDiagnostics({ channel: 'telegram', logger: quiet }),
    Object.assign(new Error('x'), { code: BOT_EXISTS }), { ok: false, error: { code: 'telegram-operation-failed', message: 'x' } });
  botExists(result);
});

test('telegram: createOnly refuses an existing bot and changes nothing; without it a re-bind still overwrites', async (t) => {
  const dir = await tempDir(t);
  const configStore = await new TelegramConfigStore(join(dir, 'config.json')).load();
  const creds = credentials();
  const rt = runtimes();
  const controller = new TelegramController({
    credentials: creds.provider,
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Care Telegram', username: 'care_bot' }),
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  t.after(() => controller.close?.());
  const rpc = createTelegramRpcHandler(controller);
  const TOKEN_A = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const TOKEN_B = '123456789:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  const first = await rpc('bot.bind-credentials', { token: TOKEN_A, createOnly: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const botId = first.value.bots[0].botId;
  const before = { config: configStore.get(botId), writes: creds.writes.length, runtimes: rt.created.length };

  botExists(await rpc('bot.bind-credentials', { token: TOKEN_B, createOnly: true }));
  assert.deepEqual(configStore.get(botId), before.config);
  assert.equal(creds.writes.length, before.writes, 'no credential write');
  assert.equal(rt.created.length, before.runtimes, 'no runtime restart');
  assert.deepEqual([...creds.values.values()], [TOKEN_A]);

  for (const createOnly of ['true', 1, null]) {
    const bad = await rpc('bot.bind-credentials', { token: TOKEN_B, createOnly });
    assert.equal(bad.error.code, 'bad-request');
  }
  // upstream behaviour: no key (or false) = overwrite the same bot
  const overwrite = await rpc('bot.bind-credentials', { token: TOKEN_B });
  assert.equal(overwrite.ok, true);
  assert.equal(overwrite.value.bots.length, 1);
  assert.deepEqual([...creds.values.values()], [TOKEN_B]);
  assert.equal((await rpc('bot.bind-credentials', { token: TOKEN_A, createOnly: false })).ok, true);
  assert.deepEqual([...creds.values.values()], [TOKEN_A]);
});

test('slack: createOnly second bind is bot-exists, tokens and config unchanged', async (t) => {
  const dir = await tempDir(t);
  const configStore = await new SlackConfigStore(join(dir, 'config.json')).load();
  const creds = credentials();
  const rt = runtimes();
  const controller = new SlackController({
    credentials: creds.provider,
    configStore,
    inspectCredentials: async () => ({ platformId: 'T12345678:U12345678', name: 'Care', username: 'care', teamId: 'T12345678', teamName: 'Care Lab' }),
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  t.after(() => controller.close?.());
  const rpc = createSlackRpcHandler(controller);
  const tokens = (n) => ({ botToken: `xoxb-${String(n).repeat(24)}-not-a-real-token`, appToken: `xapp-${String(n).repeat(24)}-not-a-real-token` });
  const first = await rpc('bot.bind-credentials', { ...tokens(1), createOnly: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const botId = first.value.bots[0].botId;
  const config = configStore.get(botId);
  const writes = creds.writes.length;
  botExists(await rpc('bot.bind-credentials', { ...tokens(2), createOnly: true }));
  assert.deepEqual(configStore.get(botId), config);
  assert.equal(creds.writes.length, writes);
  assert.equal(rt.created.length, 1);
  assert.ok([...creds.values.values()].every((value) => value.includes('-1111')));
  assert.equal((await rpc('bot.bind-credentials', { ...tokens(2), createOnly: 'yes' })).error.code, 'bad-request');
  assert.equal((await rpc('bot.bind-credentials', tokens(2))).ok, true, 'without createOnly the bind overwrites');
  assert.ok([...creds.values.values()].every((value) => value.includes('-2222')));
});

test('line (webhook channels): createOnly second bind is bot-exists, nothing changed', async (t) => {
  const dir = await tempDir(t);
  const store = await new LineConfigStore(join(dir, 'config.json')).load();
  const creds = credentials();
  const rt = runtimes();
  const controller = new LineController({
    credentials: creds.provider, configStore: store, logger: quiet,
    inspectCredentials: async () => ({ platformId: `U${'b'.repeat(32)}`, name: 'ケアボット', username: '@care' }),
    createRuntime: rt.createRuntime,
  });
  t.after(() => controller.close());
  const rpc = createLineRpcHandler(controller);
  const SECRET = '0123456789abcdef0123456789abcdef';
  const first = await rpc('bot.bind-credentials', { channelSecret: SECRET, channelAccessToken: 'line-test-access-token-not-real-0000000000', createOnly: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const botId = first.value.bots[0].botId;
  const config = store.get(botId);
  const writes = creds.writes.length;
  botExists(await rpc('bot.bind-credentials', { channelSecret: 'fedcba9876543210fedcba9876543210', channelAccessToken: 'line-test-access-token-not-real-1111111111', createOnly: true }));
  assert.deepEqual(store.get(botId), config);
  assert.equal(creds.writes.length, writes);
  assert.equal(rt.created.length, 1);
  assert.ok([...creds.values.values()].includes(SECRET));
  assert.equal((await rpc('bot.bind-credentials', { channelSecret: SECRET, channelAccessToken: 'line-test-access-token-not-real-0000000000', createOnly: 0 })).error.code, 'bad-request');
});

test('matrix: createOnly second bind is bot-exists (code passed through operationError)', async (t) => {
  const dir = await tempDir(t);
  const configStore = await new MatrixConfigStore(join(dir, 'config.json')).load();
  const creds = credentials();
  const rt = runtimes();
  const controller = new MatrixController({
    credentials: creds.provider,
    configStore,
    inspectCredentials: async () => ({ platformId: 'matrix-platform-1', userId: '@care:matrix.example.org', name: 'Care' }),
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  t.after(() => controller.close?.());
  const rpc = createMatrixRpcHandler(controller);
  const payload = { homeserver: 'https://matrix.example.org', accessToken: 'syt_not_a_real_token_0001' };
  const first = await rpc('bot.bind-credentials', { ...payload, createOnly: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const list = configStore.list();
  const writes = creds.writes.length;
  botExists(await rpc('bot.bind-credentials', { ...payload, accessToken: 'syt_not_a_real_token_0002', createOnly: true }));
  assert.deepEqual(configStore.list(), list);
  assert.equal(creds.writes.length, writes);
  assert.ok([...creds.values.values()].includes('syt_not_a_real_token_0001'));
  assert.equal((await rpc('bot.bind-credentials', { ...payload, createOnly: 'true' })).error.code, 'bad-request');
});

test('wecom-app: bot.bind with createOnly is bot-exists for the same corpId + agentId', async (t) => {
  const dir = await tempDir(t);
  const configStore = await new WecomAppConfigStore(join(dir, 'config.json')).load();
  const creds = credentials();
  const rt = runtimes();
  const controller = new WecomAppController({ credentials: creds.provider, configStore, createRuntime: rt.createRuntime, logger: quiet });
  t.after(() => controller.close?.());
  const rpc = createWecomAppRpcHandler(controller);
  const app = (secret) => ({ corpId: 'ww1234567890abcdef', agentId: '1000002', secret, token: 'callbacktoken', encodingAESKey: 'A'.repeat(43) });
  const first = await rpc('bot.bind', { ...app('s'.repeat(32)), createOnly: true });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const list = configStore.list();
  const writes = creds.writes.length;
  botExists(await rpc('bot.bind', { ...app('t'.repeat(32)), createOnly: true }));
  assert.deepEqual(configStore.list(), list, 'callback secret and config unchanged');
  assert.equal(creds.writes.length, writes);
  assert.equal(rt.created.length, 1);
  assert.equal((await rpc('bot.bind', { ...app('t'.repeat(32)), createOnly: 'x' })).error.code, 'bad-request');
});

test('wecom: bind-credentials and the QR activation both refuse an existing remote bot with createOnly', async (t) => {
  const mem = memoryStore({ getByRemoteBotId: 'remoteBotId' });
  const creds = credentials();
  const rt = runtimes();
  const controller = new WecomController({
    qrAuth: {
      start: async () => ({ scode: 'host-only-code', verificationUrl: 'https://work.weixin.qq.com/ai/qc/auth?ticket=opaque', expiresAt: Date.now() + 10_000, pollIntervalMs: 500 }),
      poll: async () => ({ status: 'success', remoteBotId: 'remote-bot', secret: 'qr-secret' }),
    },
    credentials: creds.provider,
    configStore: mem.store,
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  t.after(() => controller.close?.());
  const rpc = createWecomRpcHandler(controller, { encodeQr });
  assert.equal((await rpc('bot.bind-credentials', { botId: 'remote-bot', secret: 'manual-secret', createOnly: true })).ok, true);
  const saves = mem.saves.length;
  const writes = creds.writes.length;
  botExists(await rpc('bot.bind-credentials', { botId: 'remote-bot', secret: 'other-secret', createOnly: true }));
  const begun = await rpc('provision.begin', { createOnly: true });
  assert.equal(begun.ok, true, JSON.stringify(begun.error));
  const polled = await rpc('provision.poll', { attemptId: begun.value.attemptId });
  assert.equal(polled.ok, true);
  assert.equal(polled.value.status, 'failed');
  assert.equal(polled.value.error.code, BOT_EXISTS);
  assert.equal(polled.value.botId, undefined, 'a refused attempt does not name the existing bot');
  assert.equal(mem.saves.length, saves);
  assert.equal(creds.writes.length, writes);
  assert.deepEqual([...creds.values.values()], ['manual-secret']);
  assert.equal(rt.created.length, 1);
  assert.equal((await rpc('provision.begin', { createOnly: 1 })).error.code, 'bad-request');
});

test('qq: bind-credentials with createOnly refuses an existing AppID', async (t) => {
  const mem = memoryStore({ getByAppId: 'appId' });
  const creds = credentials();
  const rt = runtimes();
  const controller = new QqController({
    qrAuth: { start() { return () => {}; } },
    credentials: creds.provider,
    configStore: mem.store,
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  t.after(() => controller.close?.());
  const rpc = createQqRpcHandler(controller, { encodeQr });
  assert.equal((await rpc('bot.bind-credentials', { appId: '102000001', appSecret: 'secret-one', createOnly: true })).ok, true);
  const saves = mem.saves.length;
  botExists(await rpc('bot.bind-credentials', { appId: '102000001', appSecret: 'secret-two', createOnly: true }));
  assert.equal(mem.saves.length, saves);
  assert.deepEqual([...creds.values.values()], ['secret-one']);
  assert.equal(rt.created.length, 1);
});

test('dingtalk: bind-credentials and the QR activation refuse an existing Client ID with createOnly', async (t) => {
  const mem = memoryStore({ getByClientId: 'clientId' });
  const creds = credentials();
  const rt = runtimes();
  const controller = new DingtalkController({
    deviceAuth: {
      start: async () => ({ deviceCode: 'device-code-private', verificationUrl: 'https://oapi.dingtalk.com/verify?code=public-qr-code', expiresAt: 100_000, pollIntervalMs: 1_000 }),
      poll: async () => ({ status: 'SUCCESS', clientId: 'ding-client', clientSecret: 'qr-secret' }),
    },
    credentials: creds.provider,
    configStore: mem.store,
    createRuntime: async (args) => ({ ...(await rt.createRuntime(args)), pendingSender: () => null }),
    clock: () => 1_000,
    logger: quiet,
  });
  t.after(() => controller.close());
  const rpc = createDingtalkRpcHandler(controller, { encodeQr });
  assert.equal((await rpc('bot.bind-credentials', { clientId: 'ding-client', clientSecret: 'manual-secret', createOnly: true })).ok, true);
  const saves = mem.saves.length;
  botExists(await rpc('bot.bind-credentials', { clientId: 'ding-client', clientSecret: 'other', createOnly: true }));
  const begun = await rpc('provision.begin', { createOnly: true });
  assert.equal(begun.ok, true, JSON.stringify(begun.error));
  const polled = await rpc('provision.poll', { attemptId: begun.value.attemptId });
  assert.equal(polled.value.status, 'failed');
  assert.equal(polled.value.error.code, BOT_EXISTS);
  assert.equal(polled.value.botId, undefined);
  assert.equal(mem.saves.length, saves);
  assert.deepEqual([...creds.values.values()], ['manual-secret']);
  assert.equal(rt.created.length, 1);
});

/** The feishu multi-bot controller with in-memory doubles (same shape as test/channels/feishu/multi-bot-controller.test.mjs). */
function feishuFixture() {
  const bots = [];
  const saves = [];
  const configStore = {
    list: () => structuredClone(bots),
    getBot: (id) => structuredClone(bots.find((bot) => bot.id === id) ?? null),
    saveBot: async (bot) => {
      saves.push(bot.id);
      const index = bots.findIndex((candidate) => candidate.id === bot.id);
      if (index === -1) bots.push(structuredClone(bot)); else bots[index] = structuredClone(bot);
      return structuredClone(bot);
    },
    removeBot: async (id) => { const index = bots.findIndex((bot) => bot.id === id); return index === -1 ? null : bots.splice(index, 1)[0]; },
  };
  const creds = credentials();
  const registrationRuns = [];
  let botSequence = 0;
  let registrationSequence = 0;
  const started = [];
  const controller = new MultiBotDshFeishuController({
    registerApp(options) {
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      registrationRuns.push({ options, resolve });
      return promise;
    },
    verifyApp: async ({ appId }) => ({ name: `bot ${appId}`, openId: `ou_bot_${appId}`, activated: 1 }),
    credentials: creds.provider,
    configStore,
    createRuntime: async ({ botId }) => {
      started.push(botId);
      let ready = false;
      return {
        get status() { return { ready, feishuLongConnectionState: ready ? 'connected' : 'idle', harnessReachable: ready }; },
        async start() { ready = true; },
        async stop() { ready = false; },
      };
    },
    createBotId: () => `bot_generated_${++botSequence}`,
    createRegistrationId: () => `reg_${++registrationSequence}`,
    logger: quiet,
  });
  return { controller, bots, saves, creds, registrationRuns, started };
}

test('feishu: bind-credentials and a create-only QR registration refuse an existing App ID', async (t) => {
  const fx = feishuFixture();
  t.after(() => fx.controller.close());
  const rpc = createFeishuRpcHandler(fx.controller, { encodeQr });
  assert.equal((await rpc('bot.bind-credentials', { appId: 'cli_care', appSecret: 'manual-secret', createOnly: true })).ok, true);
  const saves = fx.saves.length;
  const writes = fx.creds.writes.length;
  botExists(await rpc('bot.bind-credentials', { appId: 'cli_care', appSecret: 'other-secret', createOnly: true }));
  assert.equal((await rpc('bot.bind-credentials', { appId: 'cli_care', appSecret: 'other-secret', createOnly: 'true' })).error.code, 'bad-request');

  const startedReg = fx.controller.startRegistration({ createOnly: true });
  const attemptId = startedReg.registration.attempt;
  await eventually(() => fx.registrationRuns.length > 0);
  const run = fx.registrationRuns.shift();
  assert.equal(run.options.createOnly, true);
  run.options.onQRCodeReady({ url: `https://accounts.feishu.cn/${attemptId}`, expireIn: 60 });
  run.resolve({ client_id: 'cli_care', client_secret: 'qr-secret', user_info: { open_id: 'ou_someone', tenant_brand: 'feishu' } });
  await eventually(() => fx.controller.registrationStatus(attemptId).registration.state === 'error');
  assert.equal(fx.controller.registrationStatus(attemptId).registration.error.code, BOT_EXISTS);
  const polled = await rpc('provision.poll', { attemptId });
  assert.equal(polled.ok, true, JSON.stringify(polled.error));
  assert.equal(polled.value.status, 'failed');
  assert.equal(polled.value.error.code, BOT_EXISTS);
  assert.equal(polled.value.botId, undefined);
  assert.equal(fx.saves.length, saves);
  assert.equal(fx.creds.writes.length, writes);
  assert.deepEqual([...fx.creds.values.values()], ['manual-secret']);
  assert.deepEqual(fx.bots[0].ownerOpenIds, ['*'], 'no owner added to the existing bot');
  assert.deepEqual(fx.started, ['bot_generated_1']);
});

function weixinFixture({ pollLogin }) {
  const mem = memoryStore({ getByAccountId: 'accountId' });
  const creds = credentials();
  const rt = runtimes();
  const controller = new WeixinController({
    api: {
      beginLogin: async () => ({ qrcode: 'qr-secret', qrcodeUrl: 'https://liteapp.weixin.qq.com/q/test' }),
      pollLogin: (...args) => pollLogin(...args),
    },
    credentials: creds.provider,
    configStore: mem.store,
    createRuntime: rt.createRuntime,
    logger: quiet,
  });
  return { controller, mem, creds, rt, rpc: createWeixinRpcHandler(controller, { encodeQr, logger: quiet }) };
}

async function weixinAttempt(rpc, payload) {
  const begun = await rpc('provision.begin', payload);
  assert.equal(begun.ok, true, JSON.stringify(begun.error));
  let polled;
  await eventually(async () => {
    polled = await rpc('provision.poll', { attemptId: begun.value.attemptId });
    return ['connected', 'failed', 'expired', 'cancelled'].includes(polled.value?.status);
  });
  return polled.value;
}

test('weixin: a create-only QR for an already connected account fails with bot-exists, the bot is untouched', async (t) => {
  let token = 'bot-token-one';
  const fx = weixinFixture({ pollLogin: async () => ({ status: 'confirmed', bot_token: token, ilink_bot_id: 'account@im.bot', ilink_user_id: 'owner-user', baseurl: 'https://ilinkai.weixin.qq.com' }) });
  t.after(() => fx.controller.close());
  const first = await weixinAttempt(fx.rpc, { createOnly: true });
  assert.equal(first.status, 'connected');
  assert.match(first.botId, /^wx_[a-f0-9]{24}$/, 'poll carries the botId once connected');
  const saves = fx.mem.saves.length;
  const writes = fx.creds.writes.length;
  token = 'bot-token-two';
  const second = await weixinAttempt(fx.rpc, { locale: 'zh-CN', createOnly: true });
  assert.equal(second.status, 'failed');
  assert.equal(second.error.code, BOT_EXISTS);
  assert.equal(second.botId, undefined);
  assert.equal(fx.mem.saves.length, saves);
  assert.equal(fx.creds.writes.length, writes);
  assert.deepEqual([...fx.creds.values.values()], ['bot-token-one']);
  assert.equal(fx.rt.created.length, 1);
  // upstream: without createOnly the same account is re-activated (overwrite)
  const again = await weixinAttempt(fx.rpc, {});
  assert.equal(again.status, 'connected');
  assert.deepEqual([...fx.creds.values.values()], ['bot-token-two']);
  assert.equal((await fx.rpc('provision.begin', { createOnly: 'true' })).error.code, 'bad-request');
});

test('weixin: binded_redirect never adopts an existing bot under createOnly (upstream still does without it)', async (t) => {
  let mode = 'confirmed';
  const fx = weixinFixture({
    pollLogin: async () => (mode === 'confirmed'
      ? { status: 'confirmed', bot_token: 'org-token', ilink_bot_id: 'org@im.bot', ilink_user_id: 'org-owner', baseurl: 'https://ilinkai.weixin.qq.com' }
      : { status: 'binded_redirect' }),
  });
  t.after(() => fx.controller.close());
  const org = await weixinAttempt(fx.rpc, {});
  assert.equal(org.status, 'connected');
  mode = 'redirect';
  const refused = await weixinAttempt(fx.rpc, { createOnly: true });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error.code, BOT_EXISTS);
  assert.equal(refused.botId, undefined, 'the existing (organisation) bot is not named');
  assert.equal(refused.alreadyConnected, undefined);
  const upstream = await weixinAttempt(fx.rpc, {});
  assert.equal(upstream.status, 'connected');
  assert.equal(upstream.alreadyConnected, true);
  assert.equal(upstream.botId, org.botId);
});

test('whatsapp: a create-only QR for an already linked account fails with bot-exists and drops the new link', async (t) => {
  const dir = await tempDir(t);
  const configStore = await new WhatsappConfigStore(join(dir, 'config.json')).load();
  const deletedAuth = [];
  let created = 0;
  const controller = new WhatsappController({
    configStore,
    authPath: (name) => join(dir, 'auth', name),
    createSession: async (options) => {
      queueMicrotask(() => options.onQr('raw-linked-device-qr'));
      return { ready: Promise.resolve({ accountJid: '16505550123@s.whatsapp.net', name: 'Care WhatsApp' }), close: async () => {} };
    },
    createRuntime: async () => {
      created += 1;
      return { status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 }, start: async () => {}, stop: async () => {} };
    },
    deleteAuth: async (name) => deletedAuth.push(name),
    logger: quiet,
  });
  t.after(() => controller.close());
  const rpc = createWhatsappRpcHandler(controller, { encodeQr });
  const attempt = async (payload) => {
    const begun = await rpc('provision.begin', payload);
    assert.equal(begun.ok, true, JSON.stringify(begun.error));
    let polled;
    await eventually(async () => {
      polled = await rpc('provision.poll', { attemptId: begun.value.attemptId });
      return ['connected', 'failed'].includes(polled.value?.status);
    });
    return { attemptId: begun.value.attemptId, value: polled.value };
  };
  const first = await attempt({ createOnly: true });
  assert.equal(first.value.status, 'connected');
  assert.match(first.value.botId, /^[A-Za-z0-9_-]+$/);
  const config = configStore.get(first.value.botId);
  const second = await attempt({ createOnly: true });
  assert.equal(second.value.status, 'failed');
  assert.equal(second.value.error.code, BOT_EXISTS);
  assert.equal(second.value.botId, undefined);
  assert.deepEqual(configStore.get(first.value.botId), config, 'the existing bot keeps its linked-device session');
  assert.ok(deletedAuth.length >= 1, 'the new link directory is removed');
  assert.ok(!deletedAuth.includes(config.authDirectory));
  assert.equal(created, 1);
  assert.equal((await rpc('provision.begin', { createOnly: 'yes' })).error.code, 'bad-request');
  assert.equal((await rpc('connection.status', { createOnly: true })).error.code, 'bad-request');
});
