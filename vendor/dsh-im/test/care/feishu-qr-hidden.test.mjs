// care fork (FORK.md「QR の作成を隠す」): a host that passes hiddenSettings ['feishuQr'] gets no QR flow on the Feishu / Lark
// page: no scan button, no 补全权限 (callback repair QR) on the bot cards, no QR left in the Host shown, and the manual form
// (App ID / App Secret) opens by itself while there is no bot, set to Lark. Without the setting the page is unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer from 'react-test-renderer';

import { BotSettingsContext } from '../../plugin-src/client/bot-settings-context.js';
import { BotCard, FeishuSettingsTab } from '../../plugin-src/client/channels/feishu/index.js';
import { FEISHU_ENDPOINTS } from '../../plugin-src/client/channels/feishu/api.js';

const { act, create } = TestRenderer;
const noop = () => {};
const flushTasks = () => new Promise((resolve) => setImmediate(resolve));
const withHidden = (element, hiddenSettings) => React.createElement(
  BotSettingsContext.Provider,
  { value: hiddenSettings ? { openBotSettings: noop, hiddenSettings } : { openBotSettings: noop } },
  element,
);

const connection = {
  botId: 'bot_lark',
  state: 'connected',
  connected: true,
  bot: { name: 'AI 介護アシスタント', appIdMasked: 'cli_aa6c••••9e26', domain: 'lark' },
  health: { summary: 'ok', lastCheckedAt: '2026-11-01T10:15:55.000Z' },
};

function fakeWindow(t) {
  const previous = globalThis.window;
  let nextTimer = 0;
  globalThis.window = {
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    setTimeout() { return ++nextTimer; },
    clearTimeout() {},
    requestAnimationFrame(callback) { queueMicrotask(callback); return ++nextTimer; },
    cancelAnimationFrame() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test('feishuQr: the bot card leaves out the 补全权限 QR button; reconnect and remove stay', () => {
  const card = React.createElement(BotCard, {
    connection, onReconnect: noop, onRequestRemove: noop, onConfirmRemove: noop, onCancelRemove: noop,
  });
  const full = renderToStaticMarkup(withHidden(card));
  assert.match(full, /class="bxf-repairAction"/);
  const hidden = renderToStaticMarkup(withHidden(card, ['feishuQr']));
  assert.doesNotMatch(hidden, /bxf-repairAction|补全权限/);
  assert.match(hidden, /检查连接/);
  assert.equal((hidden.match(/dim-cardAction(?: |")/g) ?? []).length, 2);
});

test('feishuQr: the heading has no scan button, only the manual one', () => {
  const tab = React.createElement(FeishuSettingsTab, { rpcCall: async () => ({ ok: true, value: {} }) });
  assert.match(renderToStaticMarkup(withHidden(tab)), /aria-label="扫码接入飞书机器人"/);
  const hidden = renderToStaticMarkup(withHidden(tab, ['feishuQr']));
  assert.doesNotMatch(hidden, /扫码接入/);
  assert.match(hidden, /aria-label="使用 App ID 和 App Secret 绑定飞书机器人"/);
});

test('feishuQr: with no bot the manual form opens by itself, set to Lark; a QR left in the Host is not shown', async (t) => {
  fakeWindow(t);
  const rpcCall = async (endpoint) => {
    if (endpoint === FEISHU_ENDPOINTS.status) {
      return {
        ok: true,
        value: {
          schemaVersion: 2,
          revision: 1,
          state: 'provisioning',
          bots: [],
          provisioning: {
            attemptId: 'reg_left_over',
            operation: 'provision',
            expiresAt: Date.now() + 600_000,
            pollIntervalMs: 1800,
            verificationUrl: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH',
            qrCodeDataUrl: 'data:image/png;base64,QUJD',
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  let renderer;
  await act(async () => {
    renderer = create(withHidden(React.createElement(FeishuSettingsTab, { rpcCall }), ['feishuQr']));
    await flushTasks();
  });
  const platform = renderer.root.findByProps({ 'aria-label': '应用平台' });
  assert.equal(platform.props.value, 'lark');
  assert.equal(renderer.root.findAll((node) => node.type === 'img' && /二维码/.test(node.props.alt ?? '')).length, 0);
  const manual = renderer.root.findByProps({ 'aria-label': '使用 App ID 和 App Secret 绑定飞书机器人' });
  assert.notEqual(manual.props.disabled, true);
  await act(async () => renderer.unmount());
});

test('without feishuQr the empty page still offers the QR and the platform starts at Feishu', async (t) => {
  fakeWindow(t);
  const rpcCall = async (endpoint) => {
    if (endpoint === FEISHU_ENDPOINTS.status) return { ok: true, value: { schemaVersion: 2, revision: 1, state: 'idle', bots: [] } };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  let renderer;
  await act(async () => {
    renderer = create(withHidden(React.createElement(FeishuSettingsTab, { rpcCall })));
    await flushTasks();
  });
  assert.equal(renderer.root.findAllByProps({ 'aria-label': '应用平台' }).length, 0);
  assert.ok(renderer.root.findAllByType('h3').some((node) => node.children.join('') === '扫码，创建第一个飞书入口'));
  assert.ok(renderer.root.findAllByProps({ 'aria-label': '扫码接入飞书机器人' }).length > 0);
  await act(async () => renderer.unmount());
});
