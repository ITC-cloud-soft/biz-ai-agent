// <WebKitProvider>: strings (Japanese, with an override map), platform labels, the API clients, the dsh-im runtime, the
// host's feedback hooks (toast / confirm) and, for a host with its own design system, the UI primitives, the layout
// classes and the date format. Every component reads it through useWebKit().
import { createContext, Fragment, useContext, useMemo, type ReactNode } from 'react'
import { createStrings, parseRich, t as translate, type RichToken, type StringKey, type StringOverrides, type Strings } from '../core/strings-core.ts'
import { createMeImClient, type MeImClient } from '../core/me-im-core.ts'
import { createAdminRpc, type AdminRpc } from '../core/rpc-core.ts'
import { platformLabel } from '../core/platforms-core.ts'
import type { ImRuntime } from '../im/runtime.ts'
import { dateTime, DEFAULT_CLASS_NAMES, DEFAULT_UI, type ClassKey, type ClassNames, type WebKitUi } from './ui.tsx'

export interface ConfirmOptions { title: string; description?: string; impact?: [string, string][]; confirmLabel?: string; danger?: boolean }
export type Toast = (kind: 'success' | 'error' | 'info', title: string, detail?: string) => void

export interface WebKitValue {
  strings: Strings
  t: (key: StringKey, vars?: Readonly<Record<string, string | number>>) => string
  /** A rich text: {name} placeholders filled with text or elements, **bold** spans (see parseRich). */
  rt: (key: StringKey, vars?: Readonly<Record<string, ReactNode>>) => ReactNode
  platformLabel: (platform: string) => string
  /** The employee's own connections (Bridge v1 `me` endpoints + the BFF's WeChat endpoints). */
  meIm: MeImClient
  /** The administrator's dsh-im management RPC (through the BFF's DSH gateway). */
  adminRpc: AdminRpc
  /** The dsh-im settings-tab runtime (vendor components); null: IM bot pages and the WeChat QR are not available. */
  runtime: ImRuntime | null
  toast: Toast
  confirm: (o: ConfirmOptions) => Promise<boolean>
  /** Error -> a sentence for people (default: the error's message). */
  errorMessage: (e: unknown) => string
  /** The primitives the components draw with (defaults: ui.tsx). */
  ui: WebKitUi
  /** The class of a layout element (defaults: DEFAULT_CLASS_NAMES). */
  cls: (key: ClassKey) => string
  /** A timestamp for people (default: ja-JP local time, or the dash). */
  formatDateTime: (v: string | null | undefined) => string
}

const defaultConfirm = async (o: ConfirmOptions): Promise<boolean> =>
  typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm([o.title, o.description].filter(Boolean).join('\n\n')) : false
const defaultToast: Toast = (kind, title, detail) => { if (kind === 'error') console.error(title, detail ?? ''); else console.info(title, detail ?? '') }

/** Rich tokens -> React nodes (unknown placeholders stay as text, like t()). */
export function renderRich(tokens: readonly RichToken[], vars: Readonly<Record<string, ReactNode>> = {}): ReactNode {
  return tokens.map((tok, i) => {
    if (tok.kind === 'text') return <Fragment key={i}>{tok.text}</Fragment>
    if (tok.kind === 'var') return <Fragment key={i}>{tok.name in vars ? vars[tok.name] : `{${tok.name}}`}</Fragment>
    return <strong key={i}>{renderRich(tok.children, vars)}</strong>
  })
}

function build(p: WebKitProviderProps): WebKitValue {
  const strings = createStrings(p.strings)
  const ui: WebKitUi = { ...DEFAULT_UI, ...p.ui }
  const classes: Record<string, string> = { ...DEFAULT_CLASS_NAMES, ...p.classNames }
  return {
    strings,
    t: (key, vars) => translate(strings, key, vars),
    rt: (key, vars) => renderRich(parseRich(strings[key]), vars),
    platformLabel: (platform) => platformLabel(platform, p.platformLabels),
    meIm: p.meIm ?? createMeImClient(),
    adminRpc: p.adminRpc ?? createAdminRpc(),
    runtime: p.runtime ?? null,
    toast: p.toast ?? defaultToast,
    confirm: p.confirm ?? defaultConfirm,
    errorMessage: p.errorMessage ?? ((e) => (e instanceof Error ? e.message : String(e))),
    ui,
    cls: (key) => classes[key] ?? '',
    formatDateTime: p.formatDateTime ?? ((v) => dateTime(v, strings['common.dash'])),
  }
}

const WebKitContext = createContext<WebKitValue>(build({}))

export interface WebKitProviderProps {
  strings?: StringOverrides
  platformLabels?: Record<string, string>
  meIm?: MeImClient
  adminRpc?: AdminRpc
  runtime?: ImRuntime | null
  toast?: Toast
  confirm?: (o: ConfirmOptions) => Promise<boolean>
  errorMessage?: (e: unknown) => string
  /** The host's primitives (any subset of WebKitUi). Pass a stable object (module constant or useMemo). */
  ui?: Partial<WebKitUi>
  /** The host's classes for layout elements (any subset of DEFAULT_CLASS_NAMES). Pass a stable object. */
  classNames?: ClassNames
  formatDateTime?: (v: string | null | undefined) => string
  children?: ReactNode
}

export function WebKitProvider(props: WebKitProviderProps) {
  const { strings, platformLabels, meIm, adminRpc, runtime, toast, confirm, errorMessage, ui, classNames, formatDateTime, children } = props
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => build(props), [strings, platformLabels, meIm, adminRpc, runtime, toast, confirm, errorMessage, ui, classNames, formatDateTime])
  return <WebKitContext.Provider value={value}>{children}</WebKitContext.Provider>
}

export const useWebKit = (): WebKitValue => useContext(WebKitContext)
