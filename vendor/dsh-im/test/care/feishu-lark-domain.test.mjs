// care fork (FORK.md「Lark で QR 作成」): `provision.begin` takes `domain: 'lark'` and the QR registration then starts on
// accounts.larksuite.com. A Feishu QR scanned in the Lark app creates the app but cannot return its credentials.
// Mocks only: no network, no real accounts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MultiBotDshFeishuController } from '../../src/channels/feishu/multi-bot-controller.mjs';
import { createFeishuRpcHandler } from '../../plugin-src/host/channels/feishu/rpc.mjs';
import { eventually, quiet } from './support.mjs';

const encodeQr = async () => 'data:image/png;base64,QUJD';

function fixture() {
  const bots = [];
  const configStore = {
    list: () => structuredClone(bots),
    getBot: (id) => structuredClone(bots.find((bot) => bot.id === id) ?? null),
    saveBot: async (bot) => {
      const index = bots.findIndex((candidate) => candidate.id === bot.id);
      if (index === -1) bots.push(structuredClone(bot)); else bots[index] = structuredClone(bot);
      return structuredClone(bot);
    },
    removeBot: async (id) => { const index = bots.findIndex((bot) => bot.id === id); return index === -1 ? null : bots.splice(index, 1)[0]; },
  };
  const values = new Map();
  const verified = [];
  const runs = [];
  let botSequence = 0;
  let registrationSequence = 0;
  const controller = new MultiBotDshFeishuController({
    registerApp(options) {
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      runs.push({ options, resolve });
      return promise;
    },
    verifyApp: async ({ appId, domain }) => {
      verified.push(domain);
      return { name: `bot ${appId}`, openId: `ou_bot_${appId}`, activated: 1 };
    },
    credentials: {
      resolve: async (ref) => (values.has(ref) ? { configured: true, source: 'test', value: values.get(ref) } : undefined),
      set: async (ref, value) => { values.set(ref, value); },
      unset: async (ref) => { values.delete(ref); },
    },
    configStore,
    createRuntime: async () => {
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
  return { controller, bots, runs, verified };
}

async function begin(fx, rpc, payload, qrHost) {
  const pending = rpc('provision.begin', payload);
  await eventually(() => fx.runs.length > 0);
  const run = fx.runs.shift();
  run.options.onQRCodeReady({ url: `https://${qrHost}/page/launcher?user_code=ABC`, expireIn: 600 });
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return { run, value: result.value };
}

test('lark: provision.begin with domain lark starts the registration on accounts.larksuite.com', async (t) => {
  const fx = fixture();
  t.after(() => fx.controller.close());
  const rpc = createFeishuRpcHandler(fx.controller, { encodeQr });

  const { run } = await begin(fx, rpc, { locale: 'zh-CN', domain: 'lark', createOnly: true }, 'accounts.larksuite.com');
  assert.equal(run.options.domain, 'accounts.larksuite.com');
  assert.equal(run.options.createOnly, true);
});

test('lark: without a domain (or with feishu) the SDK default host is kept', async (t) => {
  const fx = fixture();
  t.after(() => fx.controller.close());
  const rpc = createFeishuRpcHandler(fx.controller, { encodeQr });

  const first = await begin(fx, rpc, { locale: 'zh-CN' }, 'accounts.feishu.cn');
  assert.equal(Object.hasOwn(first.run.options, 'domain'), false);
  const second = await begin(fx, rpc, { locale: 'zh-CN', domain: 'feishu', replaceAttemptId: first.value.attemptId }, 'accounts.feishu.cn');
  assert.equal(Object.hasOwn(second.run.options, 'domain'), false);
});

test('lark: an unknown domain is a bad request and starts nothing', async (t) => {
  const fx = fixture();
  t.after(() => fx.controller.close());
  const rpc = createFeishuRpcHandler(fx.controller, { encodeQr });

  const result = await rpc('provision.begin', { locale: 'zh-CN', domain: 'larksuite.com' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bad-request');
  assert.equal(fx.runs.length, 0);
});

test('lark: credentials without tenant_brand from a Lark registration are saved as a Lark bot', async (t) => {
  const fx = fixture();
  t.after(() => fx.controller.close());

  const started = fx.controller.startRegistration({ createOnly: true, domain: 'lark' });
  const attemptId = started.registration.attempt;
  await eventually(() => fx.runs.length > 0);
  const run = fx.runs.shift();
  run.options.onQRCodeReady({ url: 'https://accounts.larksuite.com/page/launcher?user_code=ABC', expireIn: 600 });
  run.resolve({ client_id: 'cli_lark', client_secret: 'lark-secret', user_info: { open_id: 'ou_owner' } });
  await eventually(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  assert.deepEqual(fx.verified, ['lark']);
  assert.equal(fx.bots[0].domain, 'lark');
});

test('lark: a Feishu registration still follows tenant_brand', async (t) => {
  const fx = fixture();
  t.after(() => fx.controller.close());

  const started = fx.controller.startRegistration({ createOnly: true });
  const attemptId = started.registration.attempt;
  await eventually(() => fx.runs.length > 0);
  const run = fx.runs.shift();
  run.options.onQRCodeReady({ url: 'https://accounts.feishu.cn/page/launcher?user_code=ABC', expireIn: 600 });
  run.resolve({ client_id: 'cli_switched', client_secret: 'secret', user_info: { open_id: 'ou_owner', tenant_brand: 'lark' } });
  await eventually(() => fx.controller.registrationStatus(attemptId).registration.state === 'succeeded');
  assert.equal(fx.bots[0].domain, 'lark');
});
