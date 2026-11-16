// care fork: Host side of the webhook channels — `/dsh-hooks/*` routes,
// `/line` and `/teams` management RPC (validation, no secrets in responses,
// webhookPath), credential storage and delivery routes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createWebhookHub } from '../../src/channels/shared/webhook-hub.mjs';
import { LineConfigStore } from '../../src/channels/line/config-store.mjs';
import { LineController } from '../../src/channels/line/line-controller.mjs';
import { TeamsConfigStore } from '../../src/channels/teams/config-store.mjs';
import { TeamsController } from '../../src/channels/teams/teams-controller.mjs';
import { createLineRpcHandler } from '../../plugin-src/host/channels/line/rpc.mjs';
import { createTeamsRpcHandler } from '../../plugin-src/host/channels/teams/rpc.mjs';
import { createWebhookHttpHandler, installWebhookHttp } from '../../plugin-src/host/webhook-http.mjs';
import { normalizeDeliveryTarget } from '../../plugin-src/host/delivery-adapter.mjs';
import { deliverySuggestionFromConversationKey, privateDeliverySuggestionFromConversationKey } from '../../plugin-src/host/delivery-suggestions.mjs';
import { fallbackDraftTarget } from '../../plugin-src/host/care-extensions.mjs';
import { quiet } from './support.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'line-test-access-token-not-real-0000000000';
const BOT_USER = `U${'b'.repeat(32)}`;
const APP_ID = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function request(method, body = '', headers = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function response() {
  const result = { status: null, headers: null, body: '' };
  return {
    result,
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(text) { result.body = text; this.writableEnded = true; },
  };
}

function credentialsFixture() {
  const values = new Map();
  return {
    values,
    credentials: {
      resolve: async (ref) => (values.has(ref) ? { value: values.get(ref) } : null),
      set: async (ref, value) => { values.set(ref, value); },
      unset: async (ref) => { values.delete(ref); },
    },
  };
}

function runtimeDouble() {
  const status = { ready: false, connectionState: 'idle', harnessReachable: false };
  return {
    get status() { return { ...status }; },
    async start() { Object.assign(status, { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: Date.now() }); },
    async stop() { status.ready = false; },
  };
}

async function tempStore(t, Store) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-webhook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { store: await new Store(join(dir, 'config.json')).load(), path: join(dir, 'config.json') };
}

test('webhook routes: POST only, raw body handed to the hub, 413 over 1 MiB', async () => {
  const hub = createWebhookHub();
  const seen = [];
  hub.register('line', { handleWebhook: async ({ rawBody, headers }) => { seen.push({ raw: rawBody.toString(), sig: headers['x-line-signature'] }); return { status: 200, body: {} }; } });
  const handler = createWebhookHttpHandler('line', { hub, logger: quiet });
  const get = response();
  await handler(request('GET'), get);
  assert.equal(get.result.status, 405);
  assert.equal(get.result.headers.allow, 'POST');
  const ok = response();
  await handler(request('POST', '{"events":[]}', { 'x-line-signature': 'sig' }), ok);
  assert.equal(ok.result.status, 200);
  assert.deepEqual(seen, [{ raw: '{"events":[]}', sig: 'sig' }]);
  const big = response();
  await handler(request('POST', 'x', { 'content-length': String(2 * 1024 * 1024) }), big);
  assert.equal(big.result.status, 413);
  const teams = response();
  await createWebhookHttpHandler('teams', { hub, logger: quiet })(request('POST', '{}'), teams);
  assert.equal(teams.result.status, 401, 'no receiver claims an unsigned request');
});

test('installWebhookHttp registers exactly /dsh-hooks/line and /dsh-hooks/teams on the DSH webServer', () => {
  const routes = [];
  installWebhookHttp({ webServer: { register: (route) => { routes.push(route); return () => {}; } }, effect: (fn) => fn() });
  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [['exact', '/dsh-hooks/line'], ['exact', '/dsh-hooks/teams']]);
});

test('/line RPC: validates bind payloads, stores secrets only in credentials, never returns them', async (t) => {
  const { store, path } = await tempStore(t, LineConfigStore);
  const { credentials, values } = credentialsFixture();
  const inspected = [];
  const controller = new LineController({
    credentials, configStore: store, logger: quiet,
    inspectCredentials: async (input) => { inspected.push(input); return { platformId: BOT_USER, name: 'ケアボット', username: '@care' }; },
    createRuntime: async () => runtimeDouble(),
  });
  t.after(() => controller.close());
  const rpc = createLineRpcHandler(controller);
  for (const payload of [
    { channelSecret: 'short', channelAccessToken: TOKEN },
    { channelSecret: SECRET, channelAccessToken: 'x' },
    { channelSecret: SECRET, channelAccessToken: TOKEN, extra: 1 },
    { token: TOKEN },
  ]) {
    const result = await rpc('bot.bind-credentials', payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'bad-request');
  }
  const bound = await rpc('bot.bind-credentials', { channelSecret: SECRET, channelAccessToken: TOKEN });
  assert.equal(bound.ok, true, JSON.stringify(bound.error));
  const text = JSON.stringify(bound.value);
  assert.doesNotMatch(text, new RegExp(`${SECRET}|${TOKEN}|secretRef|tokenRef|platformId|${BOT_USER}`));
  assert.equal(bound.value.webhookPath, '/dsh-hooks/line');
  assert.equal(bound.value.bots[0].webhookPath, '/dsh-hooks/line');
  assert.equal(bound.value.bots[0].connected, true);
  assert.equal(bound.value.bots[0].bot.username, 'care');
  assert.match(bound.value.bots[0].botId, /^line_[a-f0-9]{24}$/);
  assert.deepEqual([...values.values()].sort(), [SECRET, TOKEN].sort());
  const saved = await readFile(path, 'utf8');
  assert.doesNotMatch(saved, new RegExp(`${SECRET}|${TOKEN}`));
  assert.equal(inspected[0].channelAccessToken, TOKEN);
  const status = await rpc('connection.status', {});
  assert.equal(status.value.totals.configured, 1);
  const removed = await rpc('bot.delete', { botId: bound.value.bots[0].botId, confirm: true });
  assert.equal(removed.ok, true);
  assert.equal(values.size, 0);
});

test('/line RPC maps LINE failures to stable error codes', async (t) => {
  const { store } = await tempStore(t, LineConfigStore);
  const { credentials } = credentialsFixture();
  const controller = new LineController({
    credentials, configStore: store, logger: quiet,
    inspectCredentials: async () => { throw Object.assign(new Error('401'), { code: 'line-401', status: 401 }); },
    createRuntime: async () => runtimeDouble(),
  });
  const result = await createLineRpcHandler(controller)('bot.bind-credentials', { channelSecret: SECRET, channelAccessToken: TOKEN });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-token');
});

test('/teams RPC: App ID + password (+ optional tenant); tenant mode is reported, the password is not', async (t) => {
  const { store } = await tempStore(t, TeamsConfigStore);
  const { credentials, values } = credentialsFixture();
  const controller = new TeamsController({
    credentials, configStore: store, logger: quiet,
    inspectCredentials: async ({ appId, tenantId }) => ({ platformId: appId, name: 'Teams Bot', tenantId: tenantId ?? null }),
    createRuntime: async () => runtimeDouble(),
  });
  t.after(() => controller.close());
  const rpc = createTeamsRpcHandler(controller);
  assert.equal((await rpc('bot.bind-credentials', { appId: 'not-a-guid', appPassword: 'pw' })).error.code, 'bad-request');
  assert.equal((await rpc('bot.bind-credentials', { appId: APP_ID, appPassword: 'pw', tenantId: 'contoso' })).error.code, 'bad-request');
  assert.equal((await rpc('bot.bind-credentials', { appId: APP_ID, appPassword: '' })).error.code, 'bad-request');
  const bound = await rpc('bot.bind-credentials', { appId: APP_ID, appPassword: 'super-secret-pw', tenantId: TENANT });
  assert.equal(bound.ok, true, JSON.stringify(bound.error));
  assert.doesNotMatch(JSON.stringify(bound.value), /super-secret-pw|passwordRef/);
  const bot = bound.value.bots[0];
  assert.equal(bot.webhookPath, '/dsh-hooks/teams');
  assert.equal(bot.bot.appId, APP_ID);
  assert.equal(bot.bot.tenantMode, 'single');
  assert.equal(bot.bot.tenantId, TENANT);
  assert.deepEqual([...values.values()], ['super-secret-pw']);
  const failing = new TeamsController({
    credentials, configStore: store, logger: quiet,
    inspectCredentials: async () => { throw Object.assign(new Error('no'), { code: 'teams-invalid-credentials' }); },
    createRuntime: async () => runtimeDouble(),
  });
  assert.equal((await createTeamsRpcHandler(failing)('bot.bind-credentials', { appId: APP_ID, appPassword: 'pw' })).error.code, 'invalid-credentials');
});

test('delivery routes and conversation keys for LINE and Teams', () => {
  const user = `U${'1'.repeat(32)}`;
  const group = `C${'2'.repeat(32)}`;
  const room = `R${'3'.repeat(32)}`;
  assert.deepEqual(normalizeDeliveryTarget('line', { targetId: 't1', kind: 'user', route: { userId: user } }).route, { userId: user });
  assert.deepEqual(normalizeDeliveryTarget('line', { targetId: 't2', kind: 'group', route: { groupId: group } }).route, { groupId: group });
  assert.throws(() => normalizeDeliveryTarget('line', { targetId: 't3', kind: 'user', route: { userId: group } }), /LINE user id/);
  assert.deepEqual(normalizeDeliveryTarget('teams', { targetId: 't4', kind: 'conversation', route: { conversationId: '19:abc@thread.v2' } }).route, { conversationId: '19:abc@thread.v2' });
  assert.deepEqual(deliverySuggestionFromConversationKey('line', `direct:${user}`), { kind: 'user', route: { userId: user } });
  assert.deepEqual(deliverySuggestionFromConversationKey('line', `group:${room}`), { kind: 'room', route: { roomId: room } });
  assert.deepEqual(privateDeliverySuggestionFromConversationKey('teams', 'direct:a:1xyz'), { kind: 'conversation', route: { conversationId: 'a:1xyz' } });
  assert.equal(privateDeliverySuggestionFromConversationKey('teams', 'group:19:abc@thread.v2'), null);
  assert.deepEqual(fallbackDraftTarget('line', { conversationId: group }), { kind: 'group', route: { groupId: group } });
  assert.deepEqual(fallbackDraftTarget('teams', { conversationId: 'a:1' }), { kind: 'conversation', route: { conversationId: 'a:1' } });
});
