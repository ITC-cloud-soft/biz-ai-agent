// care fork: Microsoft Teams over a mocked Bot Framework — JWT (RS256, iss,
// aud, exp, serviceUrl, tampering), app token, gate order, Action.Submit /
// Action.Execute → onAction, Adaptive Cards and activity update. No network.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { TEAMS_INPUT_ID, decodeMessageRef, normalizeCard, parseTeamsActionData, teamsAdaptiveCard } from '../../src/channels/shared/im-card.mjs';
import { createWebhookHub } from '../../src/channels/shared/webhook-hub.mjs';
import {
  BOT_FRAMEWORK_ISSUER, BotFrameworkJwtVerifier, BotFrameworkTokenProvider,
} from '../../src/channels/teams/teams-auth.mjs';
import { TeamsConnector, TeamsReferenceStore } from '../../src/channels/teams/teams-api.mjs';
import { TeamsRuntime, normalizeTeamsActivity, teamsPlainText } from '../../src/channels/teams/teams-runtime.mjs';
import { eventually, harnessFixture, policyProvider, quiet, settle, stateFixture, useHub } from './support.mjs';

const APP_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_APP = '99999999-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AAD = 'cccccccc-0000-0000-0000-000000000001';
const SERVICE_URL = 'https://smba.trafficmanager.mock.test/apac/';
const BOT_ID = 'teams_care';
const METADATA = 'https://login.botframework.mock.test/v1/.well-known/openidconfiguration';
const JWKS = 'https://login.botframework.mock.test/v1/.well-known/keys';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: rogueKeyPublic, privateKey: roguePrivate } = generateKeyPairSync('rsa', { modulusLength: 2048 });
void rogueKeyPublic;
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', endorsements: ['msteams'] };

function sign(payload, { key = privateKey, kid = 'key-1', alg = 'RS256' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(key).toString('base64url')}`;
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: now + 600, nbf: now - 10, serviceurl: SERVICE_URL, ...overrides };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined });
    const handler = routes(String(url), init);
    const [status, body] = handler ?? [404, { error: 'not found' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const openIdRoutes = (url) => {
  if (url === METADATA) return [200, { issuer: BOT_FRAMEWORK_ISSUER, jwks_uri: JWKS, id_token_signing_alg_values_supported: ['RS256'] }];
  if (url === JWKS) return [200, { keys: [JWK] }];
  return null;
};

function verifier() {
  return new BotFrameworkJwtVerifier({ metadataUrl: METADATA, fetchImpl: mockFetch(openIdRoutes).fetchImpl });
}

test('JWT: a valid Bot Framework token passes (RS256, iss, aud, exp, serviceUrl)', async () => {
  const verified = await verifier().verify(sign(claims()), { appId: APP_ID, serviceUrl: SERVICE_URL.replace(/\/$/, ''), channelId: 'msteams' });
  assert.equal(verified.aud, APP_ID);
});

test('JWT: tampered, re-signed, expired, wrong iss/aud/serviceUrl/alg/kid/endorsement are rejected', async () => {
  const v = verifier();
  const expected = { appId: APP_ID, serviceUrl: SERVICE_URL, channelId: 'msteams' };
  const good = sign(claims());
  const [header, , signature] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(claims({ aud: APP_ID, serviceurl: 'https://evil.example/' }))).toString('base64url');
  const cases = [
    [`${header}.${forgedPayload}.${signature}`, { ...expected, serviceUrl: 'https://evil.example/' }, 'jwt-signature'],
    [sign(claims(), { key: roguePrivate }), expected, 'jwt-signature'],
    [sign(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })), expected, 'jwt-expired'],
    [sign(claims({ iss: 'https://sts.windows.net/x/' })), expected, 'jwt-issuer'],
    [sign(claims({ aud: OTHER_APP })), expected, 'jwt-audience'],
    [sign(claims()), { ...expected, serviceUrl: 'https://other.mock.test/' }, 'jwt-service-url'],
    [sign(claims(), { alg: 'HS256' }), expected, 'jwt-alg'],
    [sign(claims(), { kid: 'unknown' }), expected, 'jwt-unknown-key'],
    [sign(claims()), { ...expected, channelId: 'webchat' }, 'jwt-endorsement'],
    ['not-a-jwt', expected, 'jwt-malformed'],
  ];
  for (const [token, options, code] of cases) {
    await assert.rejects(v.verify(token, options), (error) => error.code === code, code);
  }
});

test('app token: client credentials against the tenant (single) or botframework.com (multi), cached', async () => {
  const { fetchImpl, calls } = mockFetch((url) => (url.includes('/oauth2/v2.0/token') ? [200, { access_token: 'app-token-1', expires_in: 3600 }] : null));
  const single = new BotFrameworkTokenProvider({ appId: APP_ID, appPassword: 'pw', tenantId: TENANT, loginBase: 'https://login.mock.test', fetchImpl });
  assert.equal(await single.token(), 'app-token-1');
  assert.equal(await single.token(), 'app-token-1');
  assert.equal(calls.length, 1, 'cached');
  assert.equal(calls[0].url, `https://login.mock.test/${TENANT}/oauth2/v2.0/token`);
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), APP_ID);
  assert.equal(form.get('scope'), 'https://api.botframework.com/.default');
  const multi = new BotFrameworkTokenProvider({ appId: APP_ID, appPassword: 'pw', loginBase: 'https://login.mock.test', fetchImpl });
  await multi.token();
  assert.equal(calls[1].url, 'https://login.mock.test/botframework.com/oauth2/v2.0/token');
  const rejected = new BotFrameworkTokenProvider({
    appId: APP_ID, appPassword: 'bad', loginBase: 'https://login.mock.test',
    fetchImpl: mockFetch(() => [401, { error: 'invalid_client' }]).fetchImpl,
  });
  await assert.rejects(rejected.token(), (error) => error.code === 'teams-invalid-credentials');
});

test('Adaptive Card: Action.Execute (verb = action id) with an Action.Submit fallback; data = { actionId, value }', () => {
  const card = teamsAdaptiveCard({
    title: '請求書の承認', fields: [{ label: '金額', value: '¥12,000' }], body: '8月分', footer: 'care-ai',
    actions: [
      { id: 'care:approve', label: '承認', style: 'primary', value: 'ap_1' },
      { id: 'care:reject', label: '却下', style: 'danger', value: 'ap_1' },
    ],
    link: { label: '詳細', url: 'https://care.example.test/a' },
  });
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, '1.4');
  assert.deepEqual(card.body[1], { type: 'FactSet', facts: [{ title: '金額', value: '¥12,000' }] });
  const [approve, reject, link] = card.actions;
  assert.equal(approve.type, 'Action.Execute');
  assert.equal(approve.verb, 'care:approve');
  assert.equal(approve.style, 'positive');
  assert.equal(approve.fallback.type, 'Action.Submit');
  assert.deepEqual(parseTeamsActionData(approve.data), { actionId: 'care:approve', value: 'ap_1' });
  assert.equal(reject.style, 'destructive');
  assert.equal(link.type, 'Action.OpenUrl');
});

test('B-028: a button with an input opens an Input.Text under the card; its text comes back as inputText', () => {
  const card = teamsAdaptiveCard(normalizeCard({
    title: '請求書の承認',
    actions: [
      { id: 'care:approve', label: '承認', style: 'primary', value: 'ap_1' },
      { id: 'care:reject', label: '差戻', style: 'danger', value: 'ap_1', input: { label: '差戻しの理由', placeholder: '例：金額を確認してください' } },
    ],
  }));
  const [approve, reject] = card.actions;
  assert.equal(approve.type, 'Action.Execute');
  assert.equal(reject.type, 'Action.ShowCard');
  assert.equal(reject.title, '差戻');
  const [input] = reject.card.body;
  assert.deepEqual(
    { type: input.type, id: input.id, label: input.label, placeholder: input.placeholder, isMultiline: input.isMultiline },
    { type: 'Input.Text', id: TEAMS_INPUT_ID, label: '差戻しの理由', placeholder: '例：金額を確認してください', isMultiline: true },
  );
  const [submit] = reject.card.actions;
  assert.equal(submit.type, 'Action.Execute');
  assert.equal(submit.title, '差戻する');
  assert.equal(submit.verb, 'care:reject');
  // Teams merges the input value into the submitted data
  assert.deepEqual(parseTeamsActionData({ ...submit.data, [TEAMS_INPUT_ID]: ' 金額違い ' }), { actionId: 'care:reject', value: 'ap_1', inputText: '金額違い' });
  assert.deepEqual(parseTeamsActionData({ ...submit.data, [TEAMS_INPUT_ID]: '' }), { actionId: 'care:reject', value: 'ap_1' });
  assert.throws(() => normalizeCard({ title: 't', actions: [{ id: 'a', label: 'b', value: 'v', input: 'x' }] }), /input must be an object/);
});

function activity(overrides = {}) {
  return {
    type: 'message', id: 'act-1', timestamp: '2026-10-25T01:02:03.000Z', channelId: 'msteams', serviceUrl: SERVICE_URL,
    from: { id: '29:user-teams-id', aadObjectId: AAD, name: '佐藤 花子' },
    recipient: { id: `28:${APP_ID}`, name: 'ケアボット' },
    conversation: { id: 'a:personal-1', conversationType: 'personal', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: 'こんにちは',
    ...overrides,
  };
}

async function startRuntime(t, { tenantId = null } = {}) {
  const { harness, asked } = harnessFixture();
  const { state, seen } = stateFixture();
  const webhooks = createWebhookHub();
  const connectorFetch = mockFetch((url, init) => {
    if (init.method === 'PUT') return [200, { id: url.split('/').pop() }];
    if (url.includes('/v3/conversations/')) return [201, { id: `sent-${Math.random().toString(36).slice(2, 8)}` }];
    return null;
  });
  const tokenProvider = { token: async () => 'app-token', invalidate() {} };
  const runtime = new TeamsRuntime({
    config: { botId: BOT_ID, platformId: APP_ID, name: 'ケアボット', tenantId },
    secrets: { appPassword: 'pw' },
    harness, state, accessPolicy: policyProvider(BOT_ID), logger: quiet,
    webhooks,
    verifier: verifier(),
    references: new TeamsReferenceStore(null),
    createConnector: () => new TeamsConnector({ tokenProvider, fetchImpl: connectorFetch.fetchImpl, logger: quiet, sleep: async () => {} }),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const post = (body, { token = sign(claims()) } = {}) => webhooks.dispatch('teams', {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { authorization: `Bearer ${token}` },
  });
  return { runtime, asked, seen, post, sent: connectorFetch.calls };
}

test('Teams text: mention stripped; group messages need an @mention; sender = AAD object id, teamId = tenant', () => {
  const group = activity({
    conversation: { id: '19:chat@thread.v2', conversationType: 'groupChat', tenantId: TENANT },
    text: '<at>ケアボット</at> 今月の請求は？',
    entities: [{ type: 'mention', text: '<at>ケアボット</at>', mentioned: { id: `28:${APP_ID}` } }],
  });
  assert.equal(teamsPlainText(group), '今月の請求は？');
  const message = normalizeTeamsActivity(group);
  assert.equal(message.kind, 'group');
  assert.equal(message.addressed, true);
  assert.equal(message.senderId, AAD);
  assert.equal(message.imSourceHint.teamId, TENANT);
  assert.equal(normalizeTeamsActivity({ ...group, entities: [] }).addressed, false);
  assert.equal(normalizeTeamsActivity({ ...group, from: { id: '29:x' } }), null, 'no aadObjectId → dropped');
});

test('webhook: missing, tampered or foreign tokens never reach the agent', async (t) => {
  await useHub(t, { accessDefault: 'legacy' });
  const { post, asked } = await startRuntime(t);
  const good = sign(claims());
  const [h, , s] = good.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify(claims({ exp: claims().exp + 99999 }))).toString('base64url')}.${s}`;
  assert.equal((await post(activity({ id: 'x1' }), { token: tampered })).status, 401);
  assert.equal((await post(activity({ id: 'x2' }), { token: sign(claims({ aud: OTHER_APP })) })).status, 401, 'other bot → nobody claims it');
  assert.equal((await post(activity({ id: 'x3', serviceUrl: 'https://evil.example/' }))).status, 401, 'serviceUrl must match the token');
  assert.equal((await post(activity({ id: 'x4' }), { token: 'garbage' })).status, 401);
  await settle();
  assert.equal(asked.length, 0);
});

test('resolver allow: trusted Teams source; the reply goes to the connector with the app token', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const { post, asked, sent } = await startRuntime(t);
  assert.equal((await post(activity({ id: 'act-10', text: '8月の請求状況は？' }))).status, 200);
  await eventually(() => asked.length === 1 && sent.some((call) => call.body?.text === '了解しました'));
  const { at, ...source } = asked[0].source;
  assert.deepEqual(source, {
    platform: 'teams', botId: BOT_ID, teamId: TENANT, userId: AAD, userName: '佐藤 花子',
    conversationId: 'a:personal-1', conversationKind: 'direct', messageId: 'act-10',
  });
  assert.equal(at, '2026-10-25T01:02:03.000Z');
  const reply = sent.find((call) => call.body?.text === '了解しました');
  assert.equal(reply.url, `${SERVICE_URL.replace(/\/$/, '')}/v3/conversations/a%3Apersonal-1/activities`);
  assert.equal(reply.init.headers.authorization, 'Bearer app-token');
});

test('gate order: claimReplies before the resolver; a resolver deny stops the agent', async (t) => {
  const { hub } = await useHub(t);
  const resolved = [];
  hub.setAccessResolver((source) => { resolved.push(source.messageId); return 'deny'; });
  const claimed = [];
  hub.claimReplies((text) => text.startsWith('連携 '), async ({ source }) => { claimed.push(source); });
  const { post, asked } = await startRuntime(t);
  await post(activity({ id: 'act-20', text: '連携 123456' }));
  await eventually(() => claimed.length === 1);
  await post(activity({ id: 'act-21', text: 'こんにちは' }));
  await eventually(() => resolved.length === 1);
  await settle(50);
  assert.deepEqual(resolved, ['act-21'], 'the claimed message never reached the resolver');
  assert.equal(asked.length, 0);
  assert.equal(claimed[0].userId, AAD);
});

test('default-closed: without a resolver nobody reaches the agent', async (t) => {
  await useHub(t, { accessDefault: 'closed' });
  const { post, asked, seen } = await startRuntime(t);
  await post(activity({ id: 'act-22' }));
  await eventually(() => seen.has('act-22'));
  await settle();
  assert.equal(asked.length, 0);
});

test('Action.Submit and Action.Execute → onAction (no agent turn); invoke gets an invokeResponse body', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const events = [];
  hub.onAction('care:', async (event) => { events.push(event); await event.respond('承認しました'); });
  const { post, asked, sent } = await startRuntime(t);
  const data = { dshImAction: { actionId: 'care:approve', value: 'ap_1' } };
  const submit = await post(activity({ id: 'act-30', text: undefined, value: data, replyToId: 'card-activity-1' }));
  assert.equal(submit.status, 200);
  const execute = await post(activity({
    id: 'act-31', type: 'invoke', name: 'adaptiveCard/action', text: undefined, replyToId: 'card-activity-1',
    value: { action: { type: 'Action.Execute', verb: 'care:reject', data: { dshImAction: { actionId: 'care:reject', value: 'ap_1' } } } },
  }));
  assert.equal(execute.status, 200);
  assert.deepEqual(execute.body, { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: '' });
  await eventually(() => events.length === 2);
  assert.deepEqual(events.map((event) => event.actionId).sort(), ['care:approve', 'care:reject']);
  assert.equal(events[0].source.platform, 'teams');
  assert.equal(events[0].source.userId, AAD);
  assert.equal(decodeMessageRef(events[0].messageRef).messageId, 'card-activity-1');
  await eventually(() => sent.filter((call) => call.body?.text === '承認しました').length === 2);
  assert.equal(asked.length, 0);
});

test('sendCard to an AAD user (after they messaged the bot) and updateCard via activity update; idempotent', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const { post, sent, asked } = await startRuntime(t);
  await post(activity({ id: 'act-40' }));
  await eventually(() => asked.length === 1);
  const card = { title: '承認依頼', actions: [{ id: 'care:approve', label: '承認', style: 'primary', value: 'ap_1' }] };
  const first = await hub.sendCard({ botId: BOT_ID, to: { userId: AAD }, card, idempotencyKey: 'approval:ap_1' });
  const again = await hub.sendCard({ botId: BOT_ID, to: { userId: AAD }, card, idempotencyKey: 'approval:ap_1' });
  assert.equal(again.deduped, true);
  assert.equal(again.messageRef, first.messageRef);
  const cards = sent.filter((call) => call.body?.attachments);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const ref = decodeMessageRef(first.messageRef);
  assert.equal(ref.platform, 'teams');
  assert.equal(ref.conversationId, 'a:personal-1');
  await hub.updateCard(first.messageRef, { title: '承認済み', actions: [] });
  const put = sent.find((call) => call.init.method === 'PUT');
  assert.ok(put.url.endsWith(`/activities/${encodeURIComponent(ref.messageId)}`));
  assert.equal(put.body.attachments[0].content.actions, undefined);
  await assert.rejects(hub.sendCard({ botId: BOT_ID, to: { userId: 'unknown-aad' }, card, idempotencyKey: 'k2' }), (error) => error.code === 'invalid-target');
});

test('single-tenant bot rejects activities from another tenant', async (t) => {
  const { hub } = await useHub(t);
  hub.setAccessResolver(() => 'allow');
  const { post, asked } = await startRuntime(t, { tenantId: TENANT });
  const foreign = activity({ id: 'act-50', channelData: { tenant: { id: 'ffffffff-0000-0000-0000-000000000000' } }, conversation: { id: 'a:p', conversationType: 'personal' } });
  assert.equal((await post(foreign)).status, 403);
  await settle();
  assert.equal(asked.length, 0);
});

test('connector retries 429 and refreshes the app token once on 401', async () => {
  let n = 0;
  const statuses = [401, 429, 201];
  const fetchImpl = async () => { const status = statuses[n++]; return new Response(JSON.stringify({ id: 'ok' }), { status }); };
  let invalidated = 0;
  const connector = new TeamsConnector({
    tokenProvider: { token: async () => `t${invalidated}`, invalidate() { invalidated += 1; } },
    fetchImpl, sleep: async () => {}, logger: quiet,
  });
  const result = await connector.sendActivity(SERVICE_URL, 'a:1', { type: 'message', text: 'x' });
  assert.equal(result.id, 'ok');
  assert.equal(n, 3);
  assert.equal(invalidated, 1);
  await assert.rejects(connector.sendActivity('http://insecure.example/', 'a:1', {}), (error) => error.code === 'invalid-target');
});
