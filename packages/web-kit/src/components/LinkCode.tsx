// Link code (6 digits, 10 minutes, single use): issue + countdown. The code proves who the employee is; it is theirs only.
import { useEffect, useState } from 'react'
import { linkCodeState, mmss, spokenCode } from '../core/link-code-core.ts'
import type { LinkCode } from '../core/me-im-core.ts'
import { useWebKit } from './context.tsx'

export function useLinkCode() {
  const { meIm, toast, t, errorMessage } = useWebKit()
  const [code, setCode] = useState<LinkCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!code) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  const issue = async (): Promise<boolean> => {
    setBusy(true)
    try { setCode(await meIm.issueLinkCode()); setNow(Date.now()); return true } catch (e) {
      toast('error', t('link.issueFailed'), errorMessage(e))
      return false
    } finally { setBusy(false) }
  }
  const state = linkCodeState(code, now)
  return {
    code, busy, issue, state,
    left: state.kind === 'live' ? state.left : 0,
    expired: state.kind === 'expired',
    live: state.kind === 'live',
    clear: () => setCode(null),
  }
}

export type LinkCodeHandle = ReturnType<typeof useLinkCode>

/** 「連携 123456」 with the live code, or the placeholder. */
export function useLinkCommand(link: LinkCodeHandle): string {
  const { t } = useWebKit()
  return t('link.command', { code: link.live && link.code ? link.code.code : t('link.placeholder') })
}

export function LinkCodeBox({ link }: { link: LinkCodeHandle }) {
  const { t, ui, cls } = useWebKit()
  if (!link.live || !link.code) {
    return (
      <div className={cls('linkRow')}>
        <ui.Button variant="primary" icon={link.expired ? 'refresh' : 'link'} loading={link.busy} onClick={() => void link.issue()}>{link.expired ? t('link.reissue') : t('link.issue')}</ui.Button>
        {link.expired ? <ui.Notice tone="warning">{t('link.expired')}</ui.Notice> : <span className={cls('muted')}>{t('link.validity')}</span>}
      </div>
    )
  }
  const { mm, ss } = mmss(link.left)
  return (
    <div className={cls('codeBox')} role="status" aria-live="polite">
      <div>
        <div className={cls('codeLabel')}>{t('link.yourCode')}</div>
        <div className={cls('codeValue')} aria-label={t('link.spoken', { code: spokenCode(link.code.code) })}>{link.code.code}</div>
      </div>
      <div className={cls('codeTimer')}><ui.Icon name="hourglass" />{t('link.left', { mm, ss })}</div>
    </div>
  )
}
