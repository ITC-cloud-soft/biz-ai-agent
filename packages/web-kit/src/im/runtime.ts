// The runtime the dsh-im settings components (vendor/dsh-im/plugin-src/client) need inside a business web app:
//  1. styles: the components append <style> elements to <head>; a BFF CSP of style-src 'self' refuses them, so they are
//     moved to constructable stylesheets (document.adoptedStyleSheets, not subject to the inline-style restriction);
//  2. translation: the components look their text up by the Chinese source string; the host gives a language pack;
//  3. instead of DSH's ctx (locale / slots / connection), an RPC client and the translator are enough.
// The vendor modules are loaded by the HOST (its bundler knows the paths): createImRuntime({ loadVendor, loadWeixin }).
import type { ComponentType, Context } from 'react'
import { makeTranslator } from '../core/im-runtime-core.ts'
import type { ChannelMeta } from '../core/im-runtime-core.ts'
import type { Provision } from '../core/me-im-core.ts'
import type { RpcResult } from '../core/rpc-core.ts'

export type RpcCall = (endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<RpcResult>
export interface SettingsTabProps { rpcCall: RpcCall }
export interface BotSettingsRequest { channel?: string; botId?: string; botName?: string; connected?: boolean }
/** hiddenSettings: parts the fork's components leave out (FORK.md 「本人モード」; PERSONAL_HIDDEN_SETTINGS). */
export interface BotSettingsApi { openBotSettings?: (request: BotSettingsRequest) => void; hiddenSettings?: readonly string[] }

/* ---------------------------------------------------------------- 1. styles */
const adopted = new Map<string, CSSStyleSheet>()
let captureInstalled = false

function adopt(style: HTMLStyleElement): void {
  const key = style.dataset.pluginCss || style.dataset.plugin || String(style.textContent?.length ?? 0)
  if (adopted.has(key)) return
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(style.textContent ?? '')
  adopted.set(key, sheet)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}

/** Moves the components' <style data-plugin-css|data-plugin> appended to <head> into adoptedStyleSheets (once). */
export function installStyleCapture(): void {
  if (captureInstalled || typeof document === 'undefined') return
  captureInstalled = true
  if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) return // older browsers: as before
  const head = document.head
  const original = head.appendChild.bind(head)
  head.appendChild = (<T extends Node>(node: T): T => {
    if (node instanceof HTMLStyleElement && (node.dataset.pluginCss || node.dataset.plugin)) { adopt(node); return node }
    return original(node)
  }) as typeof head.appendChild
}

/* ---------------------------------------------------------------- 2. vendor + translation */
/** What the host loads from vendor/dsh-im/plugin-src/client (+ a language pack such as dsh-lang-ja's dsh-im.json). */
export interface VendorModules {
  i18n: { setImTranslator: (fn: (key: string) => string) => void; en?: Record<string, string> }
  meta: { BotSettingsContext: Context<BotSettingsApi> }
  styles?: { installImStyles?: () => void }
  dict?: Record<string, string> | { default: Record<string, string> }
}
export interface Vendor { BotSettingsContext: Context<BotSettingsApi> }

/** The personal WeChat QR panels exported by the dsh-im fork (channels/weixin/index.js, api.js, styles.js). */
export interface WeixinModules {
  panels: Pick<WeixinUi, 'QrPanel' | 'VerificationPanel' | 'ProgressPanel' | 'ProvisionError'>
  api: { normalizeProvisioning: (raw: unknown) => Provision }
  styles?: { installWeixinStyles?: () => void }
}
export interface WeixinUi {
  QrPanel: ComponentType<{ provision: Provision; now: number; busy: boolean; onRefresh: () => void; onCancel: () => void }>
  VerificationPanel: ComponentType<{ provision: Provision; busy: boolean; onSubmit: (code: string) => void; onCancel: () => void }>
  ProgressPanel: ComponentType<{ scanned?: boolean; busy?: boolean; onCancel?: () => void }>
  ProvisionError: ComponentType<{ provision: Provision; busy: boolean; onRetry: () => void; onClose: () => void }>
  /** The BFF answer -> the shape the panels take (QR only as data:image, fallback links only weixin.qq.com / wechat.com https). Throws on a bad shape. */
  normalizeProvisioning: (raw: unknown) => Provision
}

export interface ImRuntime {
  /** Style capture + translator, once; resolves to the vendor's contexts. */
  ensure(): Promise<Vendor>
  /** The WeChat QR panels (null when the host gave no loadWeixin). */
  loadWeixinUi: (() => Promise<WeixinUi>) | null
}

export interface ImRuntimeOptions {
  loadVendor: () => Promise<VendorModules>
  loadWeixin?: () => Promise<WeixinModules>
  /** Extra translations (source string -> text), checked before the language pack. */
  translations?: Record<string, string>
  captureStyles?: boolean
}

export function createImRuntime({ loadVendor, loadWeixin, translations = {}, captureStyles = true }: ImRuntimeOptions): ImRuntime {
  let vendor: Promise<Vendor> | null = null
  let weixin: Promise<WeixinUi> | null = null
  const ensure = (): Promise<Vendor> => {
    if (!vendor) {
      if (captureStyles) installStyleCapture()
      vendor = loadVendor().then((m) => {
        m.styles?.installImStyles?.()
        const raw = m.dict ?? {}
        const dict = ('default' in raw && typeof raw.default === 'object' ? raw.default : raw) as Record<string, string>
        m.i18n.setImTranslator(makeTranslator(dict, { en: m.i18n.en ?? {}, overrides: translations }))
        return { BotSettingsContext: m.meta.BotSettingsContext }
      })
      vendor.catch(() => { vendor = null })
    }
    return vendor
  }
  const loadWeixinUi = loadWeixin ? (): Promise<WeixinUi> => {
    if (!weixin) {
      weixin = ensure().then(loadWeixin).then((m) => {
        m.styles?.installWeixinStyles?.()
        return { ...m.panels, normalizeProvisioning: m.api.normalizeProvisioning }
      })
      weixin.catch(() => { weixin = null })
    }
    return weixin
  } : null
  return { ensure, loadWeixinUi }
}

/* ---------------------------------------------------------------- 3. channels */
export interface ChannelDef extends ChannelMeta {
  /** Loads the channel's SettingsTab only when it is shown. */
  load: () => Promise<ComponentType<SettingsTabProps>>
}

/**
 * Channel catalog + the host's loaders: channelDefs(DEFAULT_CHANNELS, { slack: () => import('<vendor>/client/channels/slack/index.js'), ... }).
 * A channel without a loader is left out.
 */
export function channelDefs(meta: readonly ChannelMeta[], loaders: Readonly<Record<string, () => Promise<Record<string, unknown>>>>): ChannelDef[] {
  return meta.filter((c) => loaders[c.id]).map((c) => ({
    ...c,
    load: () => loaders[c.id]().then((m) => {
      const tab = m[c.exportName]
      if (typeof tab !== 'function' && (typeof tab !== 'object' || tab === null)) throw new Error(`${c.path} does not export ${c.exportName}`)
      return tab as ComponentType<SettingsTabProps>
    }),
  }))
}
