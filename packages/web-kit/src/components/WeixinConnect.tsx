// Personal WeChat by QR (the employee's own account only), through the BFF's /…/weixin/* endpoints (meIm.beginWeixin …);
// the QR / verification / progress / failure panels are the dsh-im fork's (runtime.loadWeixinUi). Once connected, a link code
// is issued right away and the employee sends 「連携 123456」 to the bot.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Provision } from '../core/me-im-core.ts'
import { imErrorMessage } from '../core/rpc-core.ts'
import type { WeixinUi } from '../im/runtime.ts'
import { useWebKit } from './context.tsx'
import { ImEmbed } from './ImEmbed.tsx'
import { LinkCodeBox, useLinkCommand, type LinkCodeHandle } from './LinkCode.tsx'

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'active'; p: Provision } | { kind: 'connected'; alreadyConnected: boolean } | { kind: 'failed'; message: string } | { kind: 'unavailable' }

function useWeixinUi(): { ui: WeixinUi | null; error: Error | null } {
  const { runtime } = useWebKit()
  const [ui, setUi] = useState<WeixinUi | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let alive = true
    if (!runtime?.loadWeixinUi) { setError(new Error('runtime.loadWeixin not configured')); return undefined }
    runtime.loadWeixinUi().then((u) => { if (alive) setUi(u) }, (e: Error) => { if (alive) setError(e) })
    return () => { alive = false }
  }, [runtime])
  return { ui, error }
}

/** The panels need the ancestors .dim-panel (ImEmbed) and .dxw-page (WeChat colours and spacing). */
const WeixinFrame = ({ children, dark }: { children: ReactNode; dark?: boolean }) => <ImEmbed dark={dark}><div className="dxw-page">{children}</div></ImEmbed>

export function WeixinConnect({ link, onLinked, dark }: { link: LinkCodeHandle; onLinked?: () => void; dark?: boolean }) {
  const { meIm, t, rt, errorMessage, ui: kit, cls } = useWebKit()
  const { ui, error: uiError } = useWeixinUi()
  const command = useLinkCommand(link)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const attempt = useRef<string | null>(null)
  const active = phase.kind === 'active' ? phase.p : null

  useEffect(() => {
    if (!active || !['pending', 'scanned'].includes(active.status)) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active?.attemptId, active?.status])

  const fail = (e: unknown) => setPhase({ kind: 'failed', message: (e as { code?: string })?.code === 'rpc_error' ? imErrorMessage(undefined) : errorMessage(e) })

  const finish = useCallback(async (p: Provision) => {
    attempt.current = null
    setPhase({ kind: 'connected', alreadyConnected: p.alreadyConnected === true })
    await link.issue()
    onLinked?.()
  }, [link, onLinked])

  // poll while the QR is shown / scanned / connecting
  useEffect(() => {
    if (!ui || !active || !['pending', 'scanned', 'connecting'].includes(active.status)) return undefined
    let alive = true
    const id = active.attemptId
    const timer = setTimeout(async () => {
      try {
        const next = ui.normalizeProvisioning(await meIm.pollWeixin(id))
        if (!alive || attempt.current !== id) return
        if (next.status === 'connected') { await finish(next); return }
        setPhase({ kind: 'active', p: { ...next, qrCodeDataUrl: next.qrCodeDataUrl ?? active.qrCodeDataUrl, verificationUrl: next.verificationUrl ?? active.verificationUrl } })
      } catch (e) { if (alive) fail(e) }
    }, active.pollIntervalMs)
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui, active?.attemptId, active?.status, active?.expiresAt, active?.pollIntervalMs])

  // leaving the page closes an unscanned QR
  useEffect(() => () => { const id = attempt.current; if (id) void meIm.cancelWeixin(id).catch(() => undefined) }, [meIm])

  const start = async () => {
    if (!ui) return
    setBusy(true)
    setPhase({ kind: 'starting' })
    try {
      const r = await meIm.beginWeixin()
      if (r.unavailable) { setPhase({ kind: 'unavailable' }); return }
      const p = ui.normalizeProvisioning(r.data)
      attempt.current = p.attemptId
      setNow(Date.now())
      if (p.status === 'connected') { await finish(p); return }
      setPhase({ kind: 'active', p })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const cancel = async () => {
    const id = attempt.current
    attempt.current = null
    setBusy(true)
    try { if (id) await meIm.cancelWeixin(id) } catch { /* expired: just close */ } finally { setBusy(false); setPhase({ kind: 'idle' }) }
  }
  const submitCode = async (code: string) => {
    if (!ui || !active) return
    setBusy(true)
    try {
      const next = ui.normalizeProvisioning(await meIm.verifyWeixin(active.attemptId, code.trim()))
      if (next.status === 'connected') { await finish(next); return }
      setPhase({ kind: 'active', p: { ...active, ...next, qrCodeDataUrl: next.qrCodeDataUrl ?? active.qrCodeDataUrl } })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  if (phase.kind === 'unavailable') return <kit.Preparing title={t('weixin.unavailableTitle')}>{t('weixin.unavailableBody')}</kit.Preparing>

  if (phase.kind === 'connected') {
    return (
      <div className={cls('stack')}>
        <kit.Notice tone="success" icon="check" title={phase.alreadyConnected ? t('weixin.alreadyConnected') : t('weixin.connected')}>{t('weixin.connectedBody')}</kit.Notice>
        <LinkCodeBox link={link} />
        <ol className={cls('weixinSteps')}>
          <li>{t('weixin.step1')}</li>
          <li>{rt('weixin.step2', { command })}</li>
          <li>{t('weixin.step3')}</li>
        </ol>
        <div><kit.Button variant="ghost" size="sm" onClick={() => { link.clear(); setPhase({ kind: 'idle' }) }}>{t('common.close')}</kit.Button></div>
      </div>
    )
  }

  if (phase.kind === 'starting') return ui ? <WeixinFrame dark={dark}><ui.ProgressPanel scanned={false} /></WeixinFrame> : <kit.Skeleton rows={3} />

  if (active && ui) {
    const needsCode = active.status === 'needs_verification' || (active.verificationRequired && active.status !== 'connecting')
    const timedOut = ['pending', 'scanned'].includes(active.status) && active.expiresAt <= now && !needsCode
    return (
      <WeixinFrame dark={dark}>
        {['failed', 'cancelled', 'expired'].includes(active.status) ? (
          <ui.ProvisionError provision={active} busy={busy} onRetry={start} onClose={() => { attempt.current = null; setPhase({ kind: 'idle' }) }} />
        ) : needsCode ? (
          <ui.VerificationPanel provision={active} busy={busy} onSubmit={submitCode} onCancel={cancel} />
        ) : active.status === 'connecting' ? (
          <ui.ProgressPanel scanned busy={busy} onCancel={cancel} />
        ) : (
          <ui.QrPanel provision={timedOut ? { ...active, status: 'expired' } : active} now={now} busy={busy} onRefresh={start} onCancel={cancel} />
        )}
      </WeixinFrame>
    )
  }

  return (
    <div className={cls('stack')}>
      {phase.kind === 'failed' ? <kit.Notice tone="danger" title={t('weixin.failedTitle')}>{phase.message}</kit.Notice> : null}
      {uiError ? <kit.Notice tone="danger" title={t('weixin.loadFailed')}>{uiError.message}</kit.Notice> : null}
      <p className={cls('intro')}>{t('weixin.intro')}</p>
      <div><kit.Button variant="primary" icon="qr" loading={!ui && !uiError} disabled={!ui} onClick={start}>{phase.kind === 'failed' ? t('weixin.retry') : t('weixin.connect')}</kit.Button></div>
    </div>
  )
}
