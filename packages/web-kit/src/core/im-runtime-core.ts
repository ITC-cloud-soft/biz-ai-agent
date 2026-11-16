// Pure parts of the dsh-im settings-tab runtime: the translation chain, the host input-validation messages, the channel
// catalog. The DOM / dynamic-import part is src/im/runtime.ts. No imports.

/**
 * Host-side input validation messages of dsh-im (English, not in DSH's Japanese pack):
 * vendor/dsh-im/plugin-src/host/channels/<channel>/rpc.mjs.
 */
export const HOST_MESSAGES_JA: Readonly<Record<string, string>> = Object.freeze({
  'Payload must be an object.': 'リクエストの形式が正しくありません。',
  'bot.bind-credentials requires a Bot Token.': 'Bot Token を入力してください。',
  'bot.bind-credentials requires xoxb Bot Token and xapp App Token.': 'Bot Token（xoxb- で始まる値）と App Token（xapp- で始まる値）の両方を入力してください。',
  'bot.reconnect requires a botId.': '再接続するボットを指定してください。',
  'bot.delete requires a botId and confirm=true.': '削除するボットを指定し、確認してください。',
  'channelSecret must be the 32-character hex Channel secret.': 'チャネルシークレットは、32 桁の 16 進数です。LINE Developers の「Basic settings」からコピーしてください。',
  'channelAccessToken must be a long-lived Channel access token.': 'チャネルアクセストークンは、長期のものを入力してください。LINE Developers の「Messaging API」で発行します。',
  'appId must be the Microsoft App ID (GUID).': 'Microsoft App ID は、GUID（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx の形式）で入力してください。',
  'appPassword must be the client secret (1–1024 characters).': 'クライアントシークレットの値を入力してください（1〜1024 文字）。',
  'tenantId must be a tenant GUID, or empty for a multi-tenant bot.': 'Tenant ID は GUID で入力してください。マルチテナントのボットは空欄にします。',
})

/**
 * The vendor components look their text up by the Chinese source string. Chain: host overrides -> the DSH language pack
 * (e.g. dsh-lang-ja) -> HOST_MESSAGES_JA -> dsh-im's English -> the source text.
 */
export function makeTranslator(dict: Readonly<Record<string, string>> = {}, { en = {}, host = HOST_MESSAGES_JA, overrides = {} }: { en?: Readonly<Record<string, string>>; host?: Readonly<Record<string, string>>; overrides?: Readonly<Record<string, string>> } = {}): (key: string) => string {
  return (key: string) => overrides[key] ?? dict[key] ?? host[key] ?? en[key] ?? key
}

export interface ChannelMeta { id: string; label: string; rpc: string; group: 'main' | 'other'; exportName: string; path: string }

/**
 * The organisation-bot channels of dsh-im (token type) in a Japanese-market order; personal WeChat is NOT here (each
 * employee connects their own on the SNS link page). `path` is relative to vendor/dsh-im/plugin-src/client/.
 */
export const DEFAULT_CHANNELS: readonly ChannelMeta[] = Object.freeze([
  { id: 'slack', label: 'Slack', rpc: '/slack', group: 'main', exportName: 'SlackSettingsTab', path: 'channels/slack/index.js' },
  { id: 'line', label: 'LINE', rpc: '/line', group: 'main', exportName: 'LineSettingsTab', path: 'channels/line/index.js' },
  { id: 'teams', label: 'Microsoft Teams', rpc: '/teams', group: 'main', exportName: 'TeamsSettingsTab', path: 'channels/teams/index.js' },
  { id: 'telegram', label: 'Telegram', rpc: '/telegram', group: 'main', exportName: 'TelegramSettingsTab', path: 'channels/telegram/index.js' },
  { id: 'discord', label: 'Discord', rpc: '/discord', group: 'other', exportName: 'DiscordSettingsTab', path: 'channels/discord/index.js' },
  { id: 'whatsapp', label: 'WhatsApp', rpc: '/whatsapp', group: 'other', exportName: 'WhatsappSettingsTab', path: 'channels/whatsapp/index.js' },
  { id: 'email', label: 'メール', rpc: '/email', group: 'other', exportName: 'EmailSettingsTab', path: 'channels/email/index.js' },
  { id: 'matrix', label: 'Matrix', rpc: '/matrix', group: 'other', exportName: 'MatrixSettingsTab', path: 'channels/matrix/index.js' },
  { id: 'imessage', label: 'iMessage', rpc: '/imessage', group: 'other', exportName: 'IMessageSettingsTab', path: 'channels/imessage/index.js' },
  { id: 'dingtalk', label: 'DingTalk（釘釘）', rpc: '/dingtalk', group: 'other', exportName: 'DingtalkSettingsTab', path: 'channels/dingtalk/index.js' },
  { id: 'feishu', label: 'Lark（飛書 / Feishu）', rpc: '/feishu', group: 'other', exportName: 'FeishuSettingsTab', path: 'channels/feishu/index.js' },
  { id: 'wecom', label: 'WeCom（企業微信）', rpc: '/wecom', group: 'other', exportName: 'WecomSettingsTab', path: 'channels/wecom/index.js' },
  { id: 'wecom-app', label: 'WeCom（企業微信）自社開発アプリ', rpc: '/wecom-app', group: 'other', exportName: 'WecomAppSettingsTab', path: 'channels/wecom-app/index.js' },
  { id: 'qq', label: 'QQ', rpc: '/qq', group: 'other', exportName: 'QqSettingsTab', path: 'channels/qq/index.js' },
] as ChannelMeta[])

/**
 * The channels on which an employee connects their OWN bot (the SNS link page, ImBotsShell mode="personal"; care-ai-native
 * IM_PERSONAL_BOTS §1): the organisation channels without email / iMessage, plus personal WeChat (the fork's
 * WeixinSettingsTab: QR). Same ids / rpc paths as DEFAULT_CHANNELS.
 */
export const PERSONAL_CHANNELS: readonly ChannelMeta[] = Object.freeze([
  ...DEFAULT_CHANNELS.filter((c) => ['slack', 'line', 'teams'].includes(c.id)),
  { id: 'weixin', label: 'WeChat', rpc: '/weixin', group: 'main', exportName: 'WeixinSettingsTab', path: 'channels/weixin/index.js' },
  ...DEFAULT_CHANNELS.filter((c) => ['telegram', 'discord', 'whatsapp', 'wecom', 'wecom-app', 'qq', 'dingtalk', 'feishu', 'matrix'].includes(c.id)),
] as ChannelMeta[])

/**
 * The parts of dsh-im's settings components an employee does not see in personal mode (the fork's
 * BotSettingsContext.hiddenSettings, FORK.md): 「更多设置」 (DSH's advanced dialog: access policy …), working folder, model,
 * agent preset, context enhancement, the WeCom app's proxy / callback base fields (the server fixes them) and its callback secret reset.
 */
export const PERSONAL_HIDDEN_SETTINGS: readonly string[] = Object.freeze(['advanced', 'workspace', 'model', 'agentPreset', 'contextEnhancement', 'appSettings', 'callbackSecretReset'])

/** Channels kept / reordered / relabelled by a host: pick(DEFAULT_CHANNELS, ['slack', 'line'], { line: 'LINE 公式' }). */
export function pickChannels(all: readonly ChannelMeta[], ids?: readonly string[], labels: Readonly<Record<string, string>> = {}): ChannelMeta[] {
  const list = ids ? ids.map((id) => all.find((c) => c.id === id)).filter((c): c is ChannelMeta => Boolean(c)) : [...all]
  return list.map((c) => (labels[c.id] ? { ...c, label: labels[c.id] } : c))
}

export const splitChannelGroups = <T extends { group: 'main' | 'other' }>(list: readonly T[]): { main: T[]; other: T[] } =>
  ({ main: list.filter((c) => c.group === 'main'), other: list.filter((c) => c.group === 'other') })

/** The selected channel: the id from the URL / state when it exists, else the first one. */
export const selectChannel = <T extends { id: string }>(list: readonly T[], id: string | null | undefined): T | undefined => list.find((c) => c.id === id) ?? list[0]
