// IM platform labels and the platforms whose org bot can be linked with a link code (「連携 123456」). Pure, no imports.

export const PLATFORM_LABEL: Readonly<Record<string, string>> = Object.freeze({
  slack: 'Slack', weixin: 'WeChat', wechat: 'WeChat', teams: 'Teams', line: 'LINE', telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp',
  wecom: '企業微信 ボット', 'wecom-app': '企業微信 アプリ', dingtalk: 'DingTalk', feishu: '飛書 / Lark', lark: '飛書 / Lark', qq: 'QQ', matrix: 'Matrix', imessage: 'iMessage',
  email: 'メール', other: 'その他',
})

/**
 * Platforms whose ORGANISATION bot an employee links to with a link code (display order). An employee's own (personal)
 * bots are connected on the SNS link page (PERSONAL_BOT_PLATFORMS). Email is not linkable: the sender cannot be verified.
 */
export const LINK_CODE_PLATFORMS: readonly string[] = Object.freeze([
  'slack', 'line', 'teams', 'telegram', 'wecom-app', 'wecom', 'dingtalk', 'feishu', 'qq', 'discord', 'matrix', 'whatsapp', 'imessage',
])

/**
 * Platforms on which an employee can connect their OWN (personal) bot from the SNS link page (care-ai-native
 * IM_PERSONAL_BOTS §1; 'wechat' = weixin). Not email (notify-only), iMessage (the DSH host's Messages) or office.
 */
export const PERSONAL_BOT_PLATFORMS: readonly string[] = Object.freeze([
  'slack', 'line', 'teams', 'telegram', 'discord', 'weixin', 'wechat', 'whatsapp', 'wecom', 'wecom-app', 'qq', 'dingtalk', 'feishu', 'matrix',
])

/** Notify-only platforms: messages can be sent, but nobody links, asks the AI or approves through them. */
export const NOTIFY_ONLY_PLATFORMS: readonly string[] = Object.freeze(['email'])

export const platformLabel = (platform: string, overrides: Readonly<Record<string, string>> = {}): string =>
  overrides[platform] ?? PLATFORM_LABEL[platform] ?? platform

export const isPersonalBotPlatform = (platform: string): boolean => PERSONAL_BOT_PLATFORMS.includes(platform)

/** 「Slack・LINE・Teams・…」 */
export const linkCodePlatformNames = (platforms: readonly string[] = LINK_CODE_PLATFORMS, overrides: Readonly<Record<string, string>> = {}): string =>
  platforms.map((p) => platformLabel(p, overrides)).join('・')
