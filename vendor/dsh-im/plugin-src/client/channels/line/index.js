// care fork: LINE (Messaging API) settings page.
import { LineLogoGlyph } from '../../channel-logos.js';
import { TOKEN_BOT_ENDPOINTS } from '../shared/token-api.js';
import {
  createWebhookChannelApi,
  createWebhookChannelSettings,
  installWebhookChannelStyles,
} from '../shared/webhook-channel.js';

export const LINE_RPC_CHANNEL = '/line';
export const LINE_ENDPOINTS = TOKEN_BOT_ENDPOINTS;
export const LINE_WEBHOOK_PATH = '/dsh-hooks/line';
export const lineClientApi = createWebhookChannelApi('LINE', ' Webhook');
export const LINE_STYLE_ID = 'care-dsh-im-line-settings';

const CSS = String.raw`
.dln-page { --ddt-accent: var(--dsh-im-brand-line, #06c755); --ddt-accent-deep: var(--dsh-im-brand-line-strong, #05a647); --ddt-accent-wash: var(--dsh-im-brand-line-wash, #e8f9ee); }
.dln-avatar { background: var(--dsh-im-logo-line, #fff); border: 1px solid var(--dsh-im-logo-border, #e5e6eb); }
.dln-avatar svg { display: block; }
`;

export function installLineStyles() {
  return installWebhookChannelStyles(LINE_STYLE_ID, CSS);
}

const channel = createWebhookChannelSettings({
  channel: 'LINE',
  endpoints: LINE_ENDPOINTS,
  api: lineClientApi,
  LogoGlyph: LineLogoGlyph,
  installStyles: installLineStyles,
  pageClass: 'dln-page',
  avatarClass: 'dln-avatar',
  connectionLabel: 'Webhook',
  emptyTitle: '接入 LINE 官方账号',
  emptyDescription: '在 LINE Developers 创建 Messaging API 渠道，填写 Channel secret 与 Channel access token，并把 Webhook URL 登记到渠道设置中。',
  platformLabel: 'LINE Developers',
  credentialAriaLabel: '使用 Channel secret 和 Channel access token 接入 LINE',
  credentialOpenLabel: '接入机器人',
  credentialCloseLabel: '收起接入',
  credentialNoun: 'Channel secret 与 Channel access token',
  emptyActionLabel: '开始接入',
  webhookPath: LINE_WEBHOOK_PATH,
  title: '接入 LINE 官方账号',
  guideTitle: '在 LINE Developers 准备 Messaging API 渠道',
  guideText: '在「Basic settings」复制 Channel secret，在「Messaging API」发行长期 Channel access token；把下面的 Webhook URL 填入 Webhook settings，开启「Use webhook」，并关闭自动应答消息。',
  guideUrl: 'https://developers.line.biz/console/',
  guideLinkLabel: '打开 LINE Developers',
  webhookHint: '需要公网 HTTPS。经由业务 Web 网关时，请把此路径加入 DSH_PUBLIC_HOOK_PATHS。',
  fields: [
    { name: 'channelSecret', label: 'Channel secret', placeholder: '32 位十六进制', secret: true },
    { name: 'channelAccessToken', label: 'Channel access token', placeholder: '长期 Channel access token', secret: true },
  ],
});

export const LineSettingsTab = channel.SettingsTab;
export const LineAccountCard = channel.AccountCard;
