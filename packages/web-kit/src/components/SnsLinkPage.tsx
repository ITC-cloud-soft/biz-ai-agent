// Settings › SNS linking (every employee): only the employee's OWN IM connections. Other people's links and bots are never
// shown and cannot be made or removed here, administrators included (the server enforces it; this page never names anyone).
//   ① my own bots (ImBotsShell mode="personal" with personalChannels: every channel of the host's personal RPC; legacy
//      hosts without it: personal WeChat by QR, needs runtime.loadWeixin and meIm.weixinEnabled)
//   ② the organisation's bots by link code
//   ③ my links (list / unlink; unlinking a link made through my personal bot also deletes that bot — the server decides)
//   ④ notification preferences (NotifyPrefsCard)
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { addedIdentities, type Identity } from '../core/me-im-core.ts'
import { LINK_CODE_PLATFORMS } from '../core/platforms-core.ts'
import { createPersonalRpc, type AdminRpc } from '../core/rpc-core.ts'
import type { ChannelDef } from '../im/runtime.ts'
import { useWebKit } from './context.tsx'
import { ImBotsShell } from './ImBotsShell.tsx'
import { LinkCodeBox, useLinkCode, useLinkCommand } from './LinkCode.tsx'
import { NotifyPrefsCard, type NotifyPrefsCardProps } from './NotifyPrefsCard.tsx'
import { WeixinConnect } from './WeixinConnect.tsx'
import { useAsync, type Column } from './ui.tsx'

export interface SnsLinkPageProps {
  /** The signed-in employee is an administrator: show where the org bots are set up. */
  isAdmin?: boolean
  /** A link to the IM bot connection page for administrators (the {link} of 'sns.adminHint'). */
  imBotsLink?: ReactNode
  /** Platforms whose org bot is linked by code (display order). */
  linkCodePlatforms?: readonly string[]
  /** ① as the employee's own bots on these channels (PERSONAL_CHANNELS + the host's loaders). Needs the runtime. */
  personalChannels?: readonly ChannelDef[]
  /** The employee's RPC for ① (default createPersonalRpc(): the BFF's /api/me/im/rpc). */
  personalRpc?: AdminRpc
  /** Show the legacy ① (personal WeChat QR) when personalChannels is not given. Default: when the runtime and the client support it. */
  weixin?: boolean
  /** Props of the notification card; false hides it. */
  notify?: Omit<NotifyPrefsCardProps, 'hasIdentity'> | false
  /** Poll for a new link while a code is shown (ms, default 4000). */
  watchMs?: number
  dark?: boolean
  header?: ReactNode
  /** Vendor parts hidden in ① (ImBotsShell hiddenSettings, e.g. 'feishuQr'). */
  hiddenSettings?: readonly string[]
}

const canonical = (p: string) => (p === 'wechat' ? 'weixin' : p)

export function SnsLinkPage({
  isAdmin = false, imBotsLink, linkCodePlatforms = LINK_CODE_PLATFORMS, personalChannels, personalRpc, weixin, notify = {}, watchMs = 4000, dark, header, hiddenSettings,
}: SnsLinkPageProps) {
  const { meIm, runtime, toast, confirm, t, rt, platformLabel, errorMessage, ui, cls, formatDateTime } = useWebKit()
  const mine = useAsync(() => meIm.listMyIdentities(), [meIm])
  const myBots = useAsync(() => (meIm.listMyPersonalBots ? meIm.listMyPersonalBots() : Promise.resolve({ unavailable: true, data: null })), [meIm])
  const orgLink = useLinkCode()
  const wxLink = useLinkCode()
  const botLink = useLinkCode()
  const orgCommand = useLinkCommand(orgLink)
  const botCommand = useLinkCommand(botLink)
  const [createdOn, setCreatedOn] = useState<string | null>(null)
  const items: Identity[] = mine.data?.data ?? []
  const personal = Boolean(personalChannels?.length && runtime)
  const showWeixin = !personal && (weixin ?? Boolean(runtime?.loadWeixinUi && meIm.weixinEnabled))
  const rpc = useMemo(() => personalRpc ?? createPersonalRpc(), [personalRpc])

  // while a code is shown, watch for the new link and say when it arrived
  const known = useRef<Set<string>>(new Set())
  useEffect(() => { if (mine.data?.data) known.current = new Set(mine.data.data.map((i) => i.id)) }, [mine.data])
  const watching = orgLink.live || wxLink.live || botLink.live
  useEffect(() => {
    if (!watching || !watchMs) return undefined
    const timer = setInterval(async () => {
      const r = await meIm.listMyIdentities().catch(() => null)
      const added = addedIdentities(known.current, r?.data ?? [])
      if (added.length) {
        toast('success', t('sns.linkedToast', { platform: platformLabel(added[0].platform) }))
        orgLink.clear(); wxLink.clear(); botLink.clear(); setCreatedOn(null)
        mine.reload()
      }
    }, watchMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, watchMs])

  // a new personal bot: issue a link code right away (not needed when the same account is linked already)
  const onBotCreated = ({ channel }: { channel: string }) => {
    setCreatedOn(channel)
    myBots.reload()
    void botLink.issue()
  }

  const isMyBot = (i: Identity) => Boolean(i.botId && (myBots.data?.data ?? []).some((b) => b.botId === i.botId && canonical(b.platform) === canonical(i.platform)))
  const remove = async (i: Identity) => {
    const ok = await confirm({
      title: t('sns.unlinkConfirmTitle'), danger: true, confirmLabel: t('sns.unlinkConfirm'),
      description: isMyBot(i) ? t('sns.unlinkConfirmPersonal') : t('sns.unlinkConfirmOrg'),
      impact: [[t('sns.colPlatform'), platformLabel(i.platform)], [t('sns.colUser'), i.externalId], ...(i.teamId ? [[t('sns.colWorkspace'), i.teamId] as [string, string]] : [])],
    })
    if (!ok) return
    try { await meIm.removeMyIdentity(i); toast('success', t('sns.unlinked')); mine.reload(); myBots.reload() } catch (e) { toast('error', t('sns.unlinkFailed'), errorMessage(e)) }
  }

  const dash = t('common.dash')
  const cols: Column<Identity>[] = [
    { key: 'p', header: t('sns.colPlatform'), render: (i) => <ui.Pill tone="info" dot={false}>{platformLabel(i.platform)}</ui.Pill> },
    { key: 't', header: t('sns.colWorkspace'), render: (i) => i.teamId ?? <span className={cls('muted')}>{dash}</span> },
    { key: 'e', header: t('sns.colUser'), render: (i) => <code>{i.externalId}</code> },
    { key: 'b', header: t('sns.colBot'), render: (i) => (i.botId ? <code>{i.botId}</code> : <span className={cls('muted')}>{dash}</span>) },
    { key: 'v', header: t('sns.colLinkedAt'), render: (i) => formatDateTime(i.verifiedAt ?? i.createdAt) },
    { key: 'x', header: '', align: 'right', render: (i) => <ui.Button size="sm" variant="danger" icon="trash" onClick={() => remove(i)}>{t('sns.unlink')}</ui.Button> },
  ]

  return (
    <div className={cls('stack')}>
      {header ?? <ui.PageHeader title={t('sns.title')} description={t('sns.description')} />}
      <ui.Notice tone="info" icon="shield" title={t('sns.ownOnlyTitle')}>{t('sns.ownOnlyBody')}</ui.Notice>

      {personal && personalChannels ? (
        <ui.Card title={t('sns.botsTitle')} icon="bot" subtitle={t('sns.botsSubtitle')}>
          <div className={cls('stack')}>
            {createdOn ? (
              <div className={cls('stack')}>
                <ui.Notice tone="success" icon="check" title={t('sns.botCreatedTitle', { platform: platformLabel(createdOn) })}>{t('sns.botCreatedBody')}</ui.Notice>
                <LinkCodeBox link={botLink} />
                <ol className={cls('weixinSteps')}>
                  <li>{t('sns.botStep1')}</li>
                  <li>{rt('sns.botStep2', { command: botCommand })}</li>
                  <li>{t('sns.botStep3')}</li>
                </ol>
                <div><ui.Button variant="ghost" size="sm" onClick={() => { botLink.clear(); setCreatedOn(null) }}>{t('common.close')}</ui.Button></div>
              </div>
            ) : null}
            <ImBotsShell channels={personalChannels} mode="personal" rpc={rpc} header={null} dark={dark} onBotCreated={onBotCreated} hiddenSettings={hiddenSettings} />
          </div>
        </ui.Card>
      ) : null}

      {showWeixin ? (
        <ui.Card title={t('sns.weixinTitle')} icon="weixin" subtitle={t('sns.weixinSubtitle')}>
          <WeixinConnect link={wxLink} onLinked={() => mine.reload()} dark={dark} />
        </ui.Card>
      ) : null}

      <ui.Card title={t('sns.orgTitle')} icon="org" subtitle={t('sns.orgSubtitle')}>
        <div className={cls('stack')}>
          <LinkCodeBox link={orgLink} />
          <ol className={cls('steps')}>
            <li>{t('sns.step1')}</li>
            <li>{rt('sns.step2', { platforms: linkCodePlatforms.map(platformLabel).join('・'), command: orgCommand })}</li>
            <li>{t('sns.step3')}</li>
          </ol>
          <ui.Notice tone="neutral" icon="user">{rt('sns.codeNotice', { admin: isAdmin ? rt('sns.adminHint', { link: imBotsLink }) : '' })}</ui.Notice>
          <ui.Notice tone="neutral" icon="mail">{t('sns.emailNotLinkable')}</ui.Notice>
        </div>
      </ui.Card>

      <ui.Card title={t('sns.mineTitle')} icon="link" subtitle={t('sns.mineSubtitle')} flush>
        {mine.error ? <ui.ErrorBox title={t('sns.loadFailed')} error={mine.error} retryLabel={t('common.retry')} onRetry={mine.reload} /> : (
          <ui.DataTable caption={t('sns.mineCaption')} columns={cols} rows={items} rowKey={(i) => i.id} loading={mine.loading}
            empty={<ui.Empty icon="link" title={t('sns.empty')} description={mine.data?.unavailable ? t('sns.emptyUnavailable') : t('sns.emptyHint')} />} />
        )}
      </ui.Card>

      {notify === false ? null : <NotifyPrefsCard {...notify} hasIdentity={items.length > 0} />}
    </div>
  )
}
