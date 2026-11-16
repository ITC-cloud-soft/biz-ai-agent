// care fork (S1): a host's personal mode hides parts of the bot cards (BotSettingsContext.hiddenSettings). DSH's own settings
// page passes no hiddenSettings, so everything renders as before.
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BotSettingsButton, BotSettingsContext } from '../../plugin-src/client/channel-card-meta.js';
import { BotSettingsContext as SharedContext, hideable, useSettingHidden } from '../../plugin-src/client/bot-settings-context.js';
import { TelegramAccountCard } from '../../plugin-src/client/channels/telegram/index.js';
import { AccountCard as WecomAppAccountCard } from '../../plugin-src/client/channels/wecom-app/index.js';

const noop = () => {};
const account = Object.freeze({
  botId: 'telegram_0123456789abcdef01234567',
  connected: true,
  state: 'connected',
  workspace: '/srv/dsh/workspace/bot',
  model: null,
  agentPreset: '',
  busyMessageMode: 'queue',
  contextEnhancement: undefined,
  thinkingTraces: true,
  thinkingNumbering: true,
  thinkingIntervalSeconds: 10,
  sendLimitPerMinute: 20,
  bot: { name: 'My bot', username: 'my_bot', idMasked: '12••••89' },
  health: { summary: 'ok', lastCheckedAt: 1_700_000_000_000 },
  lastMessageError: null,
  error: null,
});
const HIDDEN = ['advanced', 'workspace', 'model', 'agentPreset', 'contextEnhancement', 'appSettings', 'callbackSecretReset'];

function render(element, hiddenSettings) {
  const value = hiddenSettings ? { openBotSettings: noop, hiddenSettings } : { openBotSettings: noop };
  return renderToStaticMarkup(React.createElement(BotSettingsContext.Provider, { value }, element));
}

test('one context object: channel-card-meta re-exports the shared BotSettingsContext', () => {
  assert.equal(BotSettingsContext, SharedContext);
});

test('token channel card: personal mode leaves out 更多设置, working folder, model, preset and context enhancement', () => {
  const card = React.createElement(TelegramAccountCard, { account, busy: null, onReconnect: noop, onRequestRemove: noop, rpcCall: async () => ({ ok: true, value: {} }), reload: noop });
  const full = render(card);
  for (const cls of ['dim-botSettingsButton', 'dim-workspace', 'dim-preset', 'dim-contextEntry']) assert.ok(full.includes(cls), `DSH page renders ${cls}`);
  assert.ok(full.includes('/srv/dsh/workspace/bot'));
  const personal = render(card, HIDDEN);
  for (const cls of ['dim-botSettingsButton', 'dim-workspace', 'dim-preset', 'dim-contextEntry', 'dim-model']) assert.ok(!personal.includes(cls), `personal mode hides ${cls}`);
  assert.ok(!personal.includes('/srv/dsh/workspace/bot'));
  // what the employee keeps: the card, the alias, reconnect / remove
  assert.ok(personal.includes('My bot'));
  assert.ok(personal.includes('dim-cardAction'));
  // only the named parts disappear
  const onlyWorkspace = render(card, ['workspace']);
  assert.ok(!onlyWorkspace.includes('dim-workspace'));
  assert.ok(onlyWorkspace.includes('dim-botSettingsButton') && onlyWorkspace.includes('dim-preset'));
});

test('WeCom app card: personal mode leaves out the proxy / callback base editor and the callback secret reset; the callback URL stays', () => {
  const bot = {
    ...account, botId: 'wecom_app_x',
    bot: {
      ...account.bot, corpIdMasked: 'ww••••ef', agentId: '1000002', apiBaseUrl: 'http://proxy.internal', callbackBaseUrl: 'https://care.example.test',
      streamEnabled: true, callbackUrl: 'https://care.example.test/wecom-app-callback/wecom_app_x/secret',
    },
  };
  const props = { account: bot, busy: null, feedback: null, onReconnect: noop, onRequestRemove: noop, onConfirmRemove: noop, onCancelRemove: noop, onSettingsSave: noop, onSecretReset: noop };
  const full = render(React.createElement(WecomAppAccountCard, props));
  assert.ok(full.includes('http://proxy.internal'), 'DSH page shows the proxy field');
  assert.ok(full.includes('>重置密钥<'));
  const personal = render(React.createElement(WecomAppAccountCard, props), HIDDEN);
  assert.ok(!personal.includes('http://proxy.internal'));
  assert.ok(!personal.includes('>重置密钥<'));
  assert.ok(personal.includes('/wecom-app-callback/wecom_app_x/secret'), 'the employee pastes their own callback URL');
});

test('BotSettingsButton / hideable / useSettingHidden', () => {
  const button = React.createElement(BotSettingsButton, { channel: 'telegram', botId: 'b', botName: 'n', connected: true });
  assert.match(render(button), /更多设置/);
  assert.equal(render(button, ['advanced']), '');
  const Part = hideable('x', () => React.createElement('i', null, 'part'));
  assert.equal(render(React.createElement(Part)), '<i>part</i>');
  assert.equal(render(React.createElement(Part), ['x']), '');
  assert.match(Part.displayName, /^Hideable\(/);
  function Probe() { return React.createElement('b', null, String(useSettingHidden('y'))); }
  assert.equal(render(React.createElement(Probe), ['y']), '<b>true</b>');
  assert.equal(render(React.createElement(Probe)), '<b>false</b>');
});
