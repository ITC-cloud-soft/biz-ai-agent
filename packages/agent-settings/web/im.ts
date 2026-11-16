// The dsh-im settings components (the framework's vendor/dsh-im/plugin-src/client), run the way the framework's business webs run
// them (@dsh-bridge/web-kit: createImRuntime / channelDefs; care-web's src/im/runtime.ts). '@dsh-im-client' and
// '@dsh-im-ja-dict' are resolved by the build (build.mjs): the framework checkout, and a Japanese language pack when one exists.
import { channelDefs, createImRuntime, DEFAULT_CHANNELS, pickChannels, type ChannelDef, type VendorModules } from '@dsh-bridge/web-kit'
import type { Lang } from './i18n.ts'
import { CHANNEL_LABELS } from './i18n.ts'

const LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  // @ts-ignore vendor JS
  slack: () => import('@dsh-im-client/channels/slack/index.js'),
  // @ts-ignore
  line: () => import('@dsh-im-client/channels/line/index.js'),
  // @ts-ignore
  teams: () => import('@dsh-im-client/channels/teams/index.js'),
  // @ts-ignore
  telegram: () => import('@dsh-im-client/channels/telegram/index.js'),
  // @ts-ignore
  discord: () => import('@dsh-im-client/channels/discord/index.js'),
  // @ts-ignore
  whatsapp: () => import('@dsh-im-client/channels/whatsapp/index.js'),
  // @ts-ignore
  email: () => import('@dsh-im-client/channels/email/index.js'),
  // @ts-ignore
  matrix: () => import('@dsh-im-client/channels/matrix/index.js'),
  // @ts-ignore
  imessage: () => import('@dsh-im-client/channels/imessage/index.js'),
  // @ts-ignore
  dingtalk: () => import('@dsh-im-client/channels/dingtalk/index.js'),
  // @ts-ignore
  feishu: () => import('@dsh-im-client/channels/feishu/index.js'),
  // @ts-ignore
  wecom: () => import('@dsh-im-client/channels/wecom/index.js'),
  // @ts-ignore
  'wecom-app': () => import('@dsh-im-client/channels/wecom-app/index.js'),
  // @ts-ignore
  qq: () => import('@dsh-im-client/channels/qq/index.js'),
}

/** The organisation's IM channels (web-kit DEFAULT_CHANNELS: the 13 SNS an employee can link + e-mail), labelled per language. */
export const channelsFor = (lang: Lang): ChannelDef[] => channelDefs(pickChannels(DEFAULT_CHANNELS, undefined, CHANNEL_LABELS[lang]), LOADERS)

/**
 * The runtime for one page language. dsh-im's own text is Chinese with an English table; Japanese comes from a language pack
 * (dsh-lang-ja) and web-kit's host messages. zh shows the source text, en the English table.
 */
export function runtimeFor(lang: Lang) {
  return createImRuntime({
    loadVendor: async () => {
      const [i18n, meta, styles, ja] = await Promise.all([
        // @ts-ignore
        import('@dsh-im-client/i18n.js'),
        // @ts-ignore
        import('@dsh-im-client/channel-card-meta.js'),
        // @ts-ignore
        import('@dsh-im-client/styles.js'),
        // @ts-ignore
        import('@dsh-im-ja-dict'),
      ])
      const en = (i18n.en ?? {}) as Record<string, string>
      const set = i18n.setImTranslator as (fn: (k: string) => string) => void
      const wrapped = {
        ...i18n,
        setImTranslator: (fn: (k: string) => string) => set(lang === 'ja' ? fn : lang === 'en' ? (k: string) => en[k] ?? k : (k: string) => k),
      }
      return { i18n: wrapped, meta, styles, dict: lang === 'ja' ? (ja.default ?? ja) : {} } as unknown as VendorModules
    },
  })
}
