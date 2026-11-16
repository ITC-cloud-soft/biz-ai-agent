// Settings › IM bot connection, with dsh-im's own settings tabs. A shell: the host gives the channels (catalog + loaders),
// where the selection lives (props or internal state) and the links to its own pages. Two modes:
//  - 'admin' (default): the organisation's bots (Slack app, LINE official account, Teams bot, ...) through the administrator's
//    RPC (adminRpc). The employees' personal bots are left out (excludeBotIds: the host's list of them).
//  - 'personal': the employee's OWN bots on the SNS link page, through the employee's RPC (rpc = createPersonalRpc(): the
//    host's BFF lets through only their bots and a per-channel allowlist). The vendor components do not render 「更多设置」,
//    working folder, model, preset, context enhancement (PERSONAL_HIDDEN_SETTINGS); a channel whose public hook is not set up
//    shows 「準備中（管理者に依頼）」. The server enforces all of it; the hiding is for clarity only.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createdBotId, excludingBots, imErrorMessage, infraFailure, probeChannel, statusPill, type AdminRpc, type ChannelStatus } from '../core/rpc-core.ts'
import { PERSONAL_HIDDEN_SETTINGS, selectChannel, splitChannelGroups } from '../core/im-runtime-core.ts'
import type { BotSettingsRequest, ChannelDef } from '../im/runtime.ts'
import { useWebKit } from './context.tsx'
import { ChannelPanel } from './ImEmbed.tsx'

export interface ImBotsShellProps {
  channels: readonly ChannelDef[]
  /** Controlled selection (e.g. from ?channel= in the URL); omit to keep it inside. */
  selected?: string | null
  onSelect?: (id: string) => void
  /** Re-probe interval of connection.status (ms, default 20000; 0 = no polling). */
  refreshMs?: number
  dark?: boolean
  onOpenAdvanced?: (request: BotSettingsRequest) => void
  /** Cross links above the list (the host's SNS link page / DSH settings), e.g. <a href="/settings/sns">…</a>. */
  links?: ReactNode
  /** The page header; null = none (e.g. inside a card), undefined = the default header. */
  header?: ReactNode
  /** Shown under the error when a channel's settings screen fails (default: the 「詳細設定（DSH）から」 notice). */
  advancedFallback?: ReactNode
  /** 'admin' (default) or 'personal' (the employee's own bots; see the file comment). */
  mode?: 'admin' | 'personal'
  /** The RPC client (default: the provider's adminRpc). Personal mode: the employee's RPC (createPersonalRpc). */
  rpc?: AdminRpc
  /** Bots never shown (admin mode: the employees' personal bots, e.g. from the host's GET /api/im-bots/personal). */
  excludeBotIds?: readonly string[] | null
  /** A personal create succeeded (the BFF's personalBotCreated): e.g. show a link code. */
  onBotCreated?: (event: { channel: string; botId: string }) => void
  /** Vendor parts hidden in both modes (the fork's hiddenSettings, e.g. 'feishuQr'); personal mode adds PERSONAL_HIDDEN_SETTINGS. */
  hiddenSettings?: readonly string[]
}

function StatusPill({ st }: { st?: ChannelStatus }) {
  const { rt, ui } = useWebKit()
  const p = statusPill(st)
  // rich: the counts are their own text nodes (as a host's JSX `{connected}/{configured} 接続中` would render them)
  return <ui.Pill tone={p.tone} dot={p.dot}>{rt(p.key, p.vars)}</ui.Pill>
}

/** The vendor parts to leave out: the host's list, plus PERSONAL_HIDDEN_SETTINGS in personal mode. */
const hiddenFor = (personal: boolean, extra?: readonly string[]): readonly string[] | undefined => {
  const all = [...(personal ? PERSONAL_HIDDEN_SETTINGS : []), ...(extra ?? [])]
  return all.length ? [...new Set(all)] : undefined
}

/** In personal mode, 「管理者のみ」 (403) reads 「自分のボットだけ」. */
const personalMessage = (st: ChannelStatus): ChannelStatus =>
  (st.kind === 'error' && st.code === 'forbidden' ? { ...st, message: imErrorMessage('personal-forbidden') } : st)

export function ImBotsShell({
  channels, selected, onSelect, refreshMs = 20000, dark, onOpenAdvanced, links, header, advancedFallback, mode = 'admin', rpc, excludeBotIds, onBotCreated, hiddenSettings,
}: ImBotsShellProps) {
  const { adminRpc, t, ui, cls } = useWebKit()
  const personal = mode === 'personal'
  const [own, setOwn] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ChannelStatus> | null>(null)
  const [tick, setTick] = useState(0)

  // the excluded bots are read on every call (the list may arrive after the first probe)
  const excludeKey = (excludeBotIds ?? []).join('\u0001')
  const excluded = useMemo<ReadonlySet<string>>(() => new Set(excludeBotIds ?? []), [excludeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const exclude = useRef(excluded)
  exclude.current = excluded
  const created = useRef(onBotCreated)
  created.current = onBotCreated
  const base = rpc ?? adminRpc
  const client = useMemo<AdminRpc>(() => {
    if (!personal) return excludingBots(base, () => exclude.current)
    return async (channel, method, payload, signal) => {
      const result = await base(channel, method, payload, signal)
      const botId = createdBotId(result)
      if (botId) { created.current?.({ channel: channel.replace(/^\//, ''), botId }); setTick((n) => n + 1) }
      return result
    }
  }, [base, personal])

  useEffect(() => {
    let alive = true
    Promise.all(channels.map(async (c) => [c.id, await probeChannel(client, c.rpc)] as const))
      .then((entries) => { if (alive) setStatuses(Object.fromEntries(entries.map(([id, st]) => [id, personal ? personalMessage(st) : st]))) })
    return () => { alive = false }
  }, [channels, client, tick, excludeKey, personal])
  useEffect(() => {
    if (!refreshMs) return undefined
    const timer = setInterval(() => setTick((n) => n + 1), refreshMs)
    return () => clearInterval(timer)
  }, [refreshMs])

  const current = selectChannel(channels, selected !== undefined ? selected : own)
  const select = useCallback((id: string) => { if (onSelect) onSelect(id); else setOwn(id) }, [onSelect])
  const infra = infraFailure(statuses)
  const { main, other } = splitChannelGroups(channels)
  const row = (c: ChannelDef) => (
    <button key={c.id} type="button" className={cls('channelRow')} aria-current={c.id === current?.id} onClick={() => select(c.id)}>
      <span>{c.label}</span>
      <StatusPill st={statuses?.[c.id]} />
    </button>
  )
  const pending = Boolean(current && statuses?.[current.id]?.kind === 'pending')
  const head = header !== undefined ? header : <ui.PageHeader title={t('imBots.title')} description={t('imBots.description')} />

  return (
    <div className={cls('stack')}>
      {head}
      {links ? <div className={cls('crossLinks')}>{links}</div> : null}
      {infra ? (
        <ui.Card><ui.ErrorBox title={infra.code === 'gateway-not-configured' ? t('imBots.infraNotConfigured') : t('imBots.infraUnreachable')} error={infra.message} retryLabel={t('common.retry')} onRetry={() => setTick((n) => n + 1)} /></ui.Card>
      ) : (
        <div className={cls('imLayout')}>
          <ui.Card flush>
            <div className={cls('channelList')} role="group" aria-label={t('imBots.channels')}>
              <div className={cls('channelGroup')}>{t('imBots.groupMain')}</div>
              {!statuses ? <div className={cls('channelLoading')}><ui.Skeleton rows={4} /></div> : main.map(row)}
              {other.length ? (
                <details className={cls('more')} open={other.some((c) => c.id === current?.id)}>
                  <summary>{t('imBots.groupOther', { count: other.length })}</summary>
                  {other.map(row)}
                </details>
              ) : null}
            </div>
          </ui.Card>
          <div className={cls('imPanel')}>
            <div className={cls('stack')}>
              {current && pending ? (
                <ui.Notice tone="info" title={t(personal ? 'imBots.personalPendingTitle' : 'imBots.pendingTitle', { label: current.label })}>{t(personal ? 'imBots.personalPendingBody' : 'imBots.pendingBody')}</ui.Notice>
              ) : current ? (
                <>
                  <ChannelPanel channel={current} dark={dark} onOpenAdvanced={personal ? undefined : onOpenAdvanced}
                    advancedFallback={personal ? (advancedFallback ?? false) : advancedFallback}
                    rpc={client} hidden={hiddenFor(personal, hiddenSettings)} />
                  {personal
                    ? <ui.Notice tone="info" icon="shield" title={t('imBots.personalAccessTitle')}>{t('imBots.personalAccessBody')}</ui.Notice>
                    : <ui.Notice tone="info" icon="shield" title={t('imBots.accessTitle')}>{t('imBots.accessBody')}</ui.Notice>}
                </>
              ) : null}
              {personal ? null : <ui.Notice tone="neutral" icon="bot" title={t('imBots.personalTitle')}>{t('imBots.personalBody')}</ui.Notice>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
