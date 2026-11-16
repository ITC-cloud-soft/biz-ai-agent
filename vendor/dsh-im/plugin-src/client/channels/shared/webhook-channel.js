// care fork: settings UI for the webhook channels (LINE, Teams). Reuses the
// token-channel page (bot list, workspace/model/preset/context editors, access
// settings, remove/reconnect) with a multi-field credential panel and the
// public webhook URL to register on the platform.

import * as React from 'react';

import { ConnectionError } from '../../connection-error.js';
import { h } from '../../i18n.js';
import { createTokenChannelApi } from './token-api.js';
import { createTokenChannelSettings } from './token-channel.js';

/** The URL the platform must call: this page's origin + the DSH webhook path. */
export function webhookUrl(path, location = globalThis.location) {
  const origin = typeof location?.origin === 'string' && /^https?:\/\//.test(location.origin) ? location.origin : '';
  return `${origin}${path}`;
}

export function createWebhookChannelApi(channel, connectionSummary) {
  return createTokenChannelApi(channel, connectionSummary, {
    normalizeBotExtension: (value) => ({
      webhookPath: typeof value.webhookPath === 'string' ? value.webhookPath : null,
      lastWebhookAt: typeof value.health?.lastWebhookAt === 'number' ? value.health.lastWebhookAt : null,
      tenantMode: value.bot?.tenantMode === 'single' ? 'single' : value.bot?.tenantMode === 'multi' ? 'multi' : null,
    }),
  });
}

function CopyButton({ value, disabled }) {
  const [copied, setCopied] = React.useState(false);
  return h('button', {
    type: 'button',
    className: 'ddt-button',
    disabled,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      } catch {
        setCopied(false);
      }
    },
  }, copied ? '已复制' : '复制');
}

export function WebhookUrlBox({ path, hint }) {
  const url = webhookUrl(path);
  return h('div', { className: 'dwh-webhook' },
    h('div', { className: 'dwh-webhookCopy' },
      h('strong', null, 'Webhook URL'),
      h('code', { className: 'dwh-webhookUrl' }, url),
      hint ? h('p', null, hint) : null),
    h(CopyButton, { value: url }));
}

/**
 * @param {object} definition
 * @param {string} definition.channel      'LINE' | 'Teams'
 * @param {string} definition.webhookPath
 * @param {Array<{ name, label, placeholder?, secret?, optional?, hint? }>} definition.fields
 * @param {string} definition.title
 * @param {string} definition.guideTitle
 * @param {string} definition.guideText
 * @param {string} [definition.guideUrl]
 * @param {string} [definition.guideLinkLabel]
 * @param {string} definition.webhookHint
 */
export function createWebhookCredentialPanel(definition) {
  const { fields } = definition;
  return function WebhookCredentialPanel({ busy, error, onSubmit, onCancel }) {
    const [values, setValues] = React.useState(() => Object.fromEntries(fields.map((field) => [field.name, ''])));
    const headingId = React.useId();
    const missing = fields.some((field) => !field.optional && !values[field.name].trim());
    const submit = (event) => {
      event.preventDefault();
      if (missing || busy) return;
      const payload = {};
      for (const field of fields) {
        const value = values[field.name].trim();
        if (value || !field.optional) payload[field.name] = value;
      }
      void onSubmit?.(payload);
    };
    return h('section', { className: 'ddt-card dim-surfaceCard dim-credentialPanel dwh-setup', 'aria-labelledby': headingId },
      h('h3', { id: headingId, className: 'dim-credentialTitle' }, definition.title),
      h('div', { className: 'dwh-guide' },
        h('div', { className: 'dwh-guideCopy' },
          h('strong', null, definition.guideTitle),
          h('p', null, definition.guideText)),
        definition.guideUrl ? h('div', { className: 'dwh-guideActions' },
          h('a', { className: 'ddt-button', href: definition.guideUrl, target: '_blank', rel: 'noreferrer' }, definition.guideLinkLabel)) : null),
      h(WebhookUrlBox, { path: definition.webhookPath, hint: definition.webhookHint }),
      h('form', { className: 'dim-credentialForm dim-credentialFormSingle', onSubmit: submit },
        h('div', { className: 'dwh-fields' },
          fields.map((field) => h('label', { key: field.name, className: 'dim-credentialField' },
            h('span', null, field.label),
            h('input', {
              type: field.secret ? 'password' : 'text',
              value: values[field.name],
              onChange: (event) => setValues((current) => ({ ...current, [field.name]: event.target.value })),
              placeholder: field.placeholder ?? '',
              maxLength: 4096,
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
              autoComplete: field.secret ? 'new-password' : 'off',
              disabled: busy,
              required: !field.optional,
            }),
            field.hint ? h('small', { className: 'dwh-fieldHint' }, field.hint) : null))),
        error ? h(ConnectionError, { error }) : null,
        h('div', { className: 'ddt-actions dim-viewActions dim-credentialActions' },
          h('button', { type: 'submit', className: 'ddt-button', 'data-kind': 'primary', disabled: busy || missing },
            busy ? '正在验证并连接…' : '验证并连接'),
          h('button', { type: 'button', className: 'ddt-button', onClick: onCancel, disabled: busy }, '取消'))));
  };
}

/** Shows the webhook URL on each connected bot card. */
export function createWebhookAccountSettings(definition) {
  return function WebhookAccountSettings({ account }) {
    return h('div', { className: 'dwh-account' },
      h(WebhookUrlBox, { path: account.webhookPath ?? definition.webhookPath, hint: definition.webhookHint }),
      account.tenantMode ? h('p', { className: 'dwh-fieldHint' },
        account.tenantMode === 'single' ? '单租户（仅限已配置的 Tenant ID）' : '多租户') : null);
  };
}

export function createWebhookChannelSettings(definition) {
  return createTokenChannelSettings({
    ...definition,
    CredentialPanel: createWebhookCredentialPanel(definition),
    credentialPayload: (values) => values,
    AccountSettings: createWebhookAccountSettings(definition),
  });
}

export const WEBHOOK_CHANNEL_STYLE_ID = 'care-dsh-im-webhook-channels';

const CSS = String.raw`
.dwh-setup { display: grid; gap: 16px; }
.dwh-guide { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 18px; padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: 11px; background: color-mix(in srgb, var(--ddt-accent, #06c755) 5%, var(--dsw-alias-bg-layer-1, #fff)); }
.dwh-guideCopy strong { display: block; margin-bottom: 5px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; }
.dwh-guideCopy p { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 1.6; }
.dwh-guideActions .ddt-button { white-space: nowrap; }
.dwh-webhook { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px dashed var(--dsw-alias-border-l2, #dfe1e5); border-radius: 10px; }
.dwh-webhookCopy { min-width: 0; display: grid; gap: 4px; }
.dwh-webhookCopy strong { font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.dwh-webhookCopy p { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); line-height: 1.55; }
.dwh-webhookUrl { overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary, #1f2329); }
.dwh-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dwh-fieldHint { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; font-weight: 400; line-height: 1.5; }
.dwh-account { display: grid; gap: 6px; margin: 4px 0 8px; }
@container (max-width: 680px) {
  .dwh-guide { grid-template-columns: minmax(0, 1fr); }
  .dwh-fields { grid-template-columns: minmax(0, 1fr); }
}
`;

export function installWebhookChannelStyles(extraId, extraCss) {
  if (typeof document === 'undefined') return () => {};
  const disposers = [];
  for (const [id, css] of [[WEBHOOK_CHANNEL_STYLE_ID, CSS], [extraId, extraCss]]) {
    if (!id || document.querySelector(`style[data-plugin-css="${id}"]`)) continue;
    const style = document.createElement('style');
    style.dataset.plugin = '@care/dsh-im';
    style.dataset.pluginCss = id;
    style.textContent = css;
    document.head.appendChild(style);
    disposers.push(() => style.remove());
  }
  return () => { for (const dispose of disposers) dispose(); };
}
