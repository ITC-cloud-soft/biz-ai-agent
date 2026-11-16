// care fork: Microsoft Teams (Bot Framework) settings page.
import { TeamsLogoGlyph } from '../../channel-logos.js';
import { TOKEN_BOT_ENDPOINTS } from '../shared/token-api.js';
import {
  createWebhookChannelApi,
  createWebhookChannelSettings,
  installWebhookChannelStyles,
} from '../shared/webhook-channel.js';

export const TEAMS_RPC_CHANNEL = '/teams';
export const TEAMS_ENDPOINTS = TOKEN_BOT_ENDPOINTS;
export const TEAMS_WEBHOOK_PATH = '/dsh-hooks/teams';
export const teamsClientApi = createWebhookChannelApi('Teams', ' Webhook');
export const TEAMS_STYLE_ID = 'care-dsh-im-teams-settings';

const CSS = String.raw`
.dtm-page { --ddt-accent: var(--dsh-im-brand-teams, #5b5fc7); --ddt-accent-deep: var(--dsh-im-brand-teams-strong, #4f52b2); --ddt-accent-wash: var(--dsh-im-brand-teams-wash, #eef0fb); }
.dtm-avatar { background: var(--dsh-im-logo-teams, #fff); border: 1px solid var(--dsh-im-logo-border, #e5e6eb); }
.dtm-avatar svg { display: block; }
`;

export function installTeamsStyles() {
  return installWebhookChannelStyles(TEAMS_STYLE_ID, CSS);
}

const channel = createWebhookChannelSettings({
  channel: 'Teams',
  endpoints: TEAMS_ENDPOINTS,
  api: teamsClientApi,
  LogoGlyph: TeamsLogoGlyph,
  installStyles: installTeamsStyles,
  pageClass: 'dtm-page',
  avatarClass: 'dtm-avatar',
  connectionLabel: 'Webhook',
  emptyTitle: '接入 Microsoft Teams 机器人',
  emptyDescription: '在 Azure Bot（Bot Framework）注册机器人，填写 Microsoft App ID 与客户端密码，并把 Messaging endpoint 设为下面的 Webhook URL。',
  platformLabel: 'Azure Bot',
  credentialAriaLabel: '使用 App ID 和密码接入 Teams 机器人',
  credentialOpenLabel: '接入机器人',
  credentialCloseLabel: '收起接入',
  credentialNoun: 'App ID 与客户端密码',
  emptyActionLabel: '开始接入',
  webhookPath: TEAMS_WEBHOOK_PATH,
  title: '接入 Microsoft Teams 机器人',
  guideTitle: '在 Azure Bot 准备机器人',
  guideText: '创建 Azure Bot 资源并启用 Microsoft Teams 渠道；在「Configuration」把 Messaging endpoint 设为下面的 Webhook URL，复制 Microsoft App ID，并在 Entra ID 应用注册中创建客户端密码。单租户机器人请同时填写 Tenant ID。',
  guideUrl: 'https://portal.azure.com/#create/Microsoft.AzureBot',
  guideLinkLabel: '打开 Azure Bot 创建页',
  webhookHint: '需要公网 HTTPS。经由业务 Web 网关时，请把此路径加入 DSH_PUBLIC_HOOK_PATHS。',
  fields: [
    { name: 'appId', label: 'Microsoft App ID', placeholder: '00000000-0000-0000-0000-000000000000' },
    { name: 'appPassword', label: '客户端密码', placeholder: 'Client secret 的值', secret: true },
    { name: 'tenantId', label: 'Tenant ID（单租户时填写）', placeholder: '多租户机器人请留空', optional: true, hint: '留空 = 多租户（botframework.com）' },
  ],
});

export const TeamsSettingsTab = channel.SettingsTab;
export const TeamsAccountCard = channel.AccountCard;
