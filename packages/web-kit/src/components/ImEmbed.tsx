// The area where dsh-im's settings components (vendor) render: runtime (styles + translator), the 「詳細設定」 link of the
// cards, the parts to hide (personal mode), an error boundary. ChannelPanel = one channel's SettingsTab wired to an RPC
// client (the administrator's by default; the employee's own in personal mode).
import { Component, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import type { BotSettingsRequest, ChannelDef, SettingsTabProps, Vendor } from '../im/runtime.ts'
import { useWebKit } from './context.tsx'
import type { WebKitUi } from './ui.tsx'
import type { AdminRpc } from '../core/rpc-core.ts'

export interface ImEmbedProps {
  children?: ReactNode
  /** Dark theme hook of the fork (data-dsh-im-theme="dark" on an ancestor). */
  dark?: boolean
  /** The cards' 「更多设置」 (workspace, model, presets): usually the DSH settings screen. */
  onOpenAdvanced?: (request: BotSettingsRequest) => void
  /** Parts of the vendor components not to render (the fork's BotSettingsContext.hiddenSettings; PERSONAL_HIDDEN_SETTINGS). */
  hidden?: readonly string[]
}

/** Vendor components need the ancestors .dim-page / .dim-panel (the classes DSH's own settings page puts around them). */
export function ImEmbed({ children, dark, onOpenAdvanced, hidden }: ImEmbedProps) {
  const { runtime, t, ui, cls } = useWebKit()
  const [vendor, setVendor] = useState<Vendor | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let alive = true
    if (!runtime) { setError(new Error('runtime not configured (WebKitProvider runtime)')); return undefined }
    runtime.ensure().then((v) => { if (alive) setVendor(v) }, (e: Error) => { if (alive) setError(e) })
    return () => { alive = false }
  }, [runtime])
  const hiddenKey = hidden?.join('') ?? ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => ({ openBotSettings: (r: BotSettingsRequest) => onOpenAdvanced?.(r), ...(hidden?.length ? { hiddenSettings: [...hidden] } : {}) }), [onOpenAdvanced, hiddenKey])
  if (error) return <ui.ErrorBox title={t('im.loadFailed')} error={error} retryLabel={t('common.retry')} onRetry={() => location.reload()} />
  if (!vendor) return <ui.Skeleton rows={6} />
  return (
    <div data-dsh-im-theme={dark ? 'dark' : undefined}>
      <div className={`${cls('imEmbed')} dim-page`}><div className="dim-panel"><vendor.BotSettingsContext.Provider value={api}>{children}</vendor.BotSettingsContext.Provider></div></div>
    </div>
  )
}

class PanelBoundary extends Component<{ children: ReactNode; channel: string; title: string; retry: string; fallback?: ReactNode; ui: WebKitUi; stack: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidUpdate(prev: { channel: string }) { if (prev.channel !== this.props.channel && this.state.error) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    const { ErrorBox } = this.props.ui
    return (
      <div className={this.props.stack}>
        <ErrorBox title={this.props.title} error={this.state.error} retryLabel={this.props.retry} onRetry={() => this.setState({ error: null })} />
        {this.props.fallback}
      </div>
    )
  }
}

/** One channel's settings screen (dsh-im SettingsTab); rpcCall goes to `rpc` (default: the administrator's RPC client). */
export function ChannelPanel({ channel, dark, onOpenAdvanced, advancedFallback, rpc, hidden }: {
  channel: ChannelDef; dark?: boolean; onOpenAdvanced?: ImEmbedProps['onOpenAdvanced']; advancedFallback?: ReactNode; rpc?: AdminRpc; hidden?: readonly string[]
}) {
  const { adminRpc: kitRpc, t, ui, cls } = useWebKit()
  const adminRpc = rpc ?? kitRpc
  const [Tab, setTab] = useState<ComponentType<SettingsTabProps> | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  useEffect(() => {
    let alive = true
    setTab(null); setLoadError(null)
    channel.load().then((c) => { if (alive) setTab(() => c) }, (e: Error) => { if (alive) setLoadError(e) })
    return () => { alive = false }
  }, [channel])
  const rpcCall = useCallback((endpoint: string, payload?: unknown, signal?: AbortSignal) => adminRpc(channel.rpc, endpoint, payload, signal), [adminRpc, channel.rpc])
  if (loadError) return <ui.ErrorBox title={t('im.tabLoadFailed')} error={loadError} retryLabel={t('common.retry')} onRetry={() => location.reload()} />
  const fallback = advancedFallback ?? <ui.Notice tone="info" title={t('im.advancedFallbackTitle')}>{t('im.advancedFallbackBody')}</ui.Notice>
  return (
    <PanelBoundary channel={channel.id} title={t('im.panelFailed')} retry={t('common.retry')} fallback={fallback} ui={ui} stack={cls('stack')}>
      <ImEmbed dark={dark} onOpenAdvanced={onOpenAdvanced} hidden={hidden}>{Tab ? <Tab key={channel.id} rpcCall={rpcCall} /> : <ui.Skeleton rows={6} />}</ImEmbed>
    </PanelBoundary>
  )
}
