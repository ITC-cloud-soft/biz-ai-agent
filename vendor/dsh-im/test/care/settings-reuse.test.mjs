// care fork: what care-web relies on when it reuses the settings components
// (WS-Q): WeChat provisioning panels as named exports, --dsh-im-* color tokens whose
// defaults keep DSH's own colors, and validation reasons on rejected management RPCs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProgressPanel,
  ProvisionError,
  QrPanel,
  VerificationPanel,
  WeixinSettingsTab,
} from '../../plugin-src/client/channels/weixin/index.js';
import { normalizeConnectionError } from '../../plugin-src/client/connection-error.js';
import { normalizeConnectionError as normalizeWeixinError } from '../../plugin-src/client/channels/weixin/api.js';
import { en, ru, localizeText, setImTranslator } from '../../plugin-src/client/i18n.js';
import { createSlackRpcHandler } from '../../plugin-src/host/channels/slack/rpc.mjs';
import { createTokenBotRpcHandler } from '../../plugin-src/host/channels/shared/rpc.mjs';
import { createTeamsRpcHandler } from '../../plugin-src/host/channels/teams/rpc.mjs';
import { createLineRpcHandler } from '../../plugin-src/host/channels/line/rpc.mjs';
import { createMatrixRpcHandler } from '../../plugin-src/host/channels/matrix/rpc.mjs';
import {
  VALIDATION_MESSAGES,
  VALIDATION_REASONS,
  validationMessage,
} from '../../src/channels/shared/validation-reason.mjs';

const CLIENT_ROOT = fileURLToPath(new URL('../../plugin-src/client/', import.meta.url));
const JA_URL = new URL('../../../../plugins/dsh-lang-ja/locales/ja/dsh-im.json', import.meta.url);

const PROVISION = Object.freeze({
  attemptId: 'attempt_1',
  status: 'pending',
  expiresAt: 1_000_000 + 120_000,
  pollIntervalMs: 1_000,
  verificationRequired: false,
  qrCodeDataUrl: 'data:image/png;base64,AAAA',
  verificationUrl: 'https://liteapp.weixin.qq.com/q/abc',
});

const noop = () => {};

function controller() {
  return {
    status: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    bindCredentials: async () => ({ bots: [], totals: { configured: 0, connected: 0 } }),
    reconnectBot: async () => ({ bots: [] }),
    deleteBot: async () => ({ bots: [] }),
  };
}

test('WeChat provisioning panels are named exports that render on their own', () => {
  for (const component of [QrPanel, VerificationPanel, ProgressPanel, ProvisionError]) {
    assert.equal(typeof component, 'function');
  }
  const qr = renderToStaticMarkup(React.createElement(QrPanel, {
    provision: PROVISION, now: 1_000_000, busy: false, onRefresh: noop, onCancel: noop,
  }));
  assert.match(qr, /src="data:image\/png;base64,AAAA"/);
  assert.match(qr, /2:00/);
  assert.match(qr, /href="https:\/\/liteapp\.weixin\.qq\.com\/q\/abc"/);
  const expired = renderToStaticMarkup(React.createElement(QrPanel, {
    provision: PROVISION, now: PROVISION.expiresAt + 1, busy: false, onRefresh: noop, onCancel: noop,
  }));
  assert.match(expired, /dxw-expired/);

  const verify = renderToStaticMarkup(React.createElement(VerificationPanel, {
    provision: { ...PROVISION, status: 'needs_verification' }, busy: false, onSubmit: noop, onCancel: noop,
  }));
  assert.match(verify, /autoComplete="one-time-code"|autocomplete="one-time-code"/);

  const progress = renderToStaticMarkup(React.createElement(ProgressPanel, { scanned: true, busy: false }));
  assert.match(progress, /aria-busy="true"/);
  assert.doesNotMatch(progress, /<button/, 'no cancel button without onCancel');
  assert.match(renderToStaticMarkup(React.createElement(ProgressPanel, { onCancel: noop })), /<button/);

  const failed = renderToStaticMarkup(React.createElement(ProvisionError, {
    provision: { ...PROVISION, status: 'failed', error: { code: 'X', message: '微信绑定没有完成' } },
    busy: false, onRetry: noop, onClose: noop,
  }));
  assert.match(failed, /role="alert"/);
  // The settings tab itself is unchanged and still exported.
  assert.equal(typeof WeixinSettingsTab, 'function');
});

async function clientStyleSources(directory = CLIENT_ROOT) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await clientStyleSources(path));
    else if (entry.name === 'styles.js' || /channels[\\/](line|teams)[\\/]index\.js$/.test(path)) {
      found.push([path.slice(CLIENT_ROOT.length), await readFile(path, 'utf8')]);
    }
  }
  return found;
}

test('accent colors are --dsh-im-* tokens whose fallback is the original color', async () => {
  const raw = [];
  for (const [path, source] of await clientStyleSources()) {
    for (const match of source.matchAll(/#(?:1677ff|0958d9|0f5fce|4d93f8)\b/giu)) {
      const before = source.slice(Math.max(0, match.index - 80), match.index);
      if (!/var\(--[\w-]+,\s*$/u.test(before) && !/\[data-dsh-im-theme="dark"\][^}]*$/u.test(source.slice(0, match.index))) {
        raw.push(`${path}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(raw, []);
  const styles = await readFile(join(CLIENT_ROOT, 'styles.js'), 'utf8');
  assert.match(styles, /background: var\(--dsh-im-accent, #1677ff\)/);
  assert.match(styles, /var\(--dsh-im-accent-strong, #0958d9\)/);
});

test('every channel page takes its accent from --dsh-im-brand-<channel>, with a dark override hook', async () => {
  const sources = Object.fromEntries(await clientStyleSources());
  const expected = {
    slack: '#4a154b', telegram: '#229ed9', discord: '#5865f2', whatsapp: '#25d366', line: '#06c755',
    teams: '#5b5fc7', matrix: '#1a8f6f', email: '#2f6fd0', imessage: '#32a852', qq: '#1677ff',
    wecom: '#3370ff', 'wecom-app': '#07c160', dingtalk: '#1677ff', weixin: '#07c160',
  };
  const all = Object.values(sources).join('\n');
  for (const [channel, color] of Object.entries(expected)) {
    assert.ok(all.includes(`var(--dsh-im-brand-${channel}, ${color})`), `${channel} brand token`);
    assert.ok(all.includes(`var(--dsh-im-brand-${channel}-strong, `), `${channel} strong token`);
  }
  const dark = /\[data-dsh-im-theme="dark"\] \{([^}]*)\}/u.exec(sources['styles.js'])?.[1] ?? '';
  assert.match(dark, /--dsh-im-brand-slack: #b746b9;/);
  assert.match(dark, /--dsh-im-brand-slack-wash: color-mix\(/);
  assert.match(dark, /--dsh-im-accent-strong: /);
});

test('rejected payloads keep bad-request and carry a reason and field', async () => {
  const slack = createSlackRpcHandler(controller());
  let result = await slack('bot.bind-credentials', { botToken: 'xoxb-1234567890abcdefgh', appToken: 'nope' });
  assert.deepEqual(result.error, {
    code: 'bad-request', reason: 'invalid-app-token', field: 'appToken', message: VALIDATION_MESSAGES['invalid-app-token'],
  });
  result = await slack('bot.bind-credentials', { botToken: 'bad', appToken: 'xapp-1234567890abcdefgh' });
  assert.equal(result.error.reason, 'invalid-bot-token');
  assert.equal(result.error.field, 'botToken');
  result = await slack('bot.bind-credentials', { botToken: '', appToken: 'xapp-1234567890abcdefgh' });
  assert.equal(result.error.reason, 'missing-field');
  result = await slack('bot.bind-credentials', { botToken: 'xoxb-1234567890abcdefgh', appToken: 'xapp-1234567890abcdefgh', extra: 1 });
  assert.equal(result.error.reason, 'invalid-payload');
  result = await slack('bot.delete', { botId: 'slack_1234567890abcdef12345678' });
  assert.equal(result.error.reason, 'confirmation-required');
  result = await slack('bot.delete', { botId: 'nope', confirm: true });
  assert.equal(result.error.reason, 'invalid-bot-id');
  result = await slack('bot.workspace.set', { botId: 'slack_1234567890abcdef12345678', workspace: 'relative' });
  assert.equal(result.error.code, 'bad-request');
  assert.equal(result.error.reason, 'invalid-setting');
  assert.equal(result.error.message, '请输入工作区绝对路径。');
  result = await slack('no.such.endpoint', {});
  assert.equal(result.error.reason, 'invalid-payload');

  const telegram = createTokenBotRpcHandler(controller(), { channel: 'Telegram' });
  result = await telegram('bot.bind-credentials', { token: 'short' });
  assert.equal(result.error.reason, 'invalid-bot-token');
  assert.equal(result.error.field, 'token');
  result = await telegram('bot.bind-credentials', {});
  assert.equal(result.error.reason, 'missing-field');

  const teams = createTeamsRpcHandler(controller());
  result = await teams('bot.bind-credentials', { appId: 'not-a-guid', appPassword: 'pw' });
  assert.deepEqual([result.error.reason, result.error.field], ['invalid-credential', 'appId']);
  result = await teams('bot.bind-credentials', { appId: '00000000-0000-0000-0000-000000000000', appPassword: 'pw', tenantId: 'contoso' });
  assert.deepEqual([result.error.reason, result.error.field], ['invalid-credential', 'tenantId']);
  result = await teams('bot.bind-credentials', { appId: '00000000-0000-0000-0000-000000000000', appPassword: '' });
  assert.deepEqual([result.error.reason, result.error.field], ['missing-field', 'appPassword']);

  const line = createLineRpcHandler(controller());
  result = await line('bot.bind-credentials', { channelSecret: 'xyz', channelAccessToken: 'a'.repeat(40) });
  assert.deepEqual([result.error.reason, result.error.field], ['invalid-credential', 'channelSecret']);

  const matrix = createMatrixRpcHandler(controller());
  result = await matrix('bot.bind-credentials', { homeserver: 'https://matrix.example.org' });
  assert.deepEqual([result.error.reason, result.error.field], ['missing-field', 'userId']);
});

test('the client maps a reason to its dictionary sentence, in every language', async () => {
  for (const normalize of [normalizeConnectionError, normalizeWeixinError]) {
    const error = normalize({ code: 'bad-request', reason: 'invalid-app-token', field: 'appToken', message: 'bot.bind-credentials requires …' });
    assert.equal(error.code, 'bad-request');
    assert.equal(error.reason, 'invalid-app-token');
    assert.equal(error.field, 'appToken');
    assert.equal(error.message, validationMessage('invalid-app-token'));
    // Without a known reason nothing changes.
    assert.equal(normalize({ code: 'bad-request', message: 'x' }).reason, undefined);
    assert.equal(normalize({ code: 'bad-request', reason: 'invalid-setting', message: '请选择有效模型。' }).message, '请选择有效模型。');
  }
  // The Japanese pack lives beside the fork in care-ai-native; outside it only en/ru are checked.
  const ja = existsSync(JA_URL) ? JSON.parse(await readFile(JA_URL, 'utf8')) : null;
  for (const reason of VALIDATION_REASONS) {
    const key = validationMessage(reason);
    if (key === null) continue;
    assert.equal(typeof en[key], 'string', `en: ${key}`);
    assert.equal(typeof ru[key], 'string', `ru: ${key}`);
    if (ja) assert.equal(typeof ja[key], 'string', `ja: ${key}`);
  }
  if (!ja) return;
  setImTranslator((key) => ja[key] ?? en[key] ?? key);
  try {
    assert.equal(localizeText(validationMessage('missing-field')), '必須項目をすべて入力してください。');
  } finally {
    setImTranslator(null);
  }
});
