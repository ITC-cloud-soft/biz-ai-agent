// The employee's own notification preferences (types the server notifies + quiet hours). Own only: the server enforces it
// with the employee's session (a userId in the body is refused).
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  DEFAULT_QUIET_HOURS, groupNotifyTypes, normPrefs, putBody, quietInvalid, samePrefs, serverTypeIds, visibleTypes, wants,
  type NotifyGroupDef, type NotifyPrefs, type NotifyTypeDef, type QuietHours,
} from '../core/notify-core.ts'
import { useWebKit } from './context.tsx'
import { useAsync } from './ui.tsx'

export interface NotifyPrefsCardProps {
  /** The employee's role (rows whose def lists roles are filtered by it). */
  role?: string
  /** The host's descriptions of the types (label / help / roles / group). Types the server lists but the host does not describe show `labels[id]` or the id. */
  types?: readonly NotifyTypeDef[]
  groups?: readonly NotifyGroupDef[]
  /** The group of a type without one (default ''; give one of `groups` to show those types under its heading). */
  groupFallback?: string
  /** Fallback labels, e.g. from the manifest events (events.<type>.label). */
  labels?: Readonly<Record<string, string>>
  defaultOff?: readonly string[]
  /** Quiet-hour keys the server accepts (server-kit: enabled / start / end). */
  quietKeys?: readonly string[]
  /** Quiet hours when the server sends none (default 22:00–07:00, off); extra keys = the host's quiet-hour flags (normPrefs). */
  defaultQuiet?: QuietHours
  /** Where "start = end" is reported: in the hint next to the times (default) or at the end-time field (TimeField `error`). */
  invalidAt?: 'hint' | 'field'
  /** false: the employee has no linked IM yet (a warning, saving still works). */
  hasIdentity?: boolean
  title?: ReactNode
  /** Extra rows under the quiet hours (host-specific flags of quietHours); `types` = the rows shown. */
  extraQuietRows?: (draft: NotifyPrefs, set: (patch: Partial<NotifyPrefs['quietHours']>) => void, ctx: { types: NotifyTypeDef[] }) => ReactNode
}

export function NotifyPrefsCard({
  role, types: defs = [], groups = [], groupFallback = '', labels = {}, defaultOff = [], quietKeys, defaultQuiet = DEFAULT_QUIET_HOURS, invalidAt = 'hint',
  hasIdentity = true, title, extraQuietRows,
}: NotifyPrefsCardProps) {
  const { meIm, toast, t, errorMessage, ui, cls } = useWebKit()
  const uid = useId()
  const q = useAsync(() => meIm.getNotifyPreferences(), [meIm])
  // before the first answer: the host's defaults (so the first paint already shows the default quiet hours)
  const [draft, setDraft] = useState<NotifyPrefs>(() => ({ types: {}, quietHours: { ...defaultQuiet } }))
  const [saved, setSaved] = useState<NotifyPrefs>(() => ({ types: {}, quietHours: { ...defaultQuiet } }))
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (q.data?.data) { const p = normPrefs(q.data.data, { defaultQuiet }); setDraft(p); setSaved(p) } }, [q.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const types = visibleTypes(defs, { serverIds: q.data?.data ? serverTypeIds(q.data.data) : null, role, labels })
  const dirty = !samePrefs(draft, saved)
  const invalid = quietInvalid(draft)
  const setType = (id: string, im: boolean) => setDraft((d) => ({ ...d, types: { ...d.types, [id]: { im } } }))
  const setQuiet = (patch: Partial<NotifyPrefs['quietHours']>) => setDraft((d) => ({ ...d, quietHours: { ...d.quietHours, ...patch } }))

  const save = async () => {
    if (invalid) return
    setBusy(true)
    try {
      const next = normPrefs(await meIm.putNotifyPreferences(putBody(draft, types, { defaultOff, quietKeys })), { defaultQuiet })
      setDraft(next); setSaved(next)
      toast('success', t('notify.saved'))
    } catch (e) { toast('error', t('notify.saveFailed'), errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <ui.Card title={title ?? t('notify.title')} icon="bell" subtitle={t('notify.subtitle')}
      actions={<ui.Button variant="primary" size="sm" icon="save" loading={busy} disabled={!dirty || busy || invalid || !q.data?.data} onClick={save}>{t('notify.save')}</ui.Button>}>
      {q.loading && !q.data ? <ui.Skeleton rows={4} />
        : q.error ? <ui.ErrorBox title={t('notify.loadFailed')} error={q.error} retryLabel={t('common.retry')} onRetry={q.reload} />
          : q.data?.unavailable ? <ui.Preparing title={t('notify.unavailableTitle')}>{t('notify.unavailable')}</ui.Preparing>
            : (
              <div className={cls('stack')}>
                {!hasIdentity ? <ui.Notice tone="warning" title={t('notify.noIdentityTitle')}>{t('notify.noIdentityBody')}</ui.Notice> : null}
                {types.length === 0 ? <ui.Notice tone="neutral">{t('notify.none')}</ui.Notice> : groupNotifyTypes(types, groups, groupFallback).map((g) => (
                  <div key={g.group || '_'} role="group" aria-label={t('notify.groupLabel', { group: g.label || (title ? String(title) : '') })}>
                    {g.label ? <div className={cls('notifyGroup')}>{g.label}</div> : null}
                    {g.types.map((type) => (
                      <div key={type.id} className={cls('prefRow')}>
                        <div>
                          <label htmlFor={`${uid}-${type.id}`} className={cls('prefLabel')}>{type.label}</label>
                          {type.help ? <div className={cls('prefHelp')} id={`${uid}-${type.id}-h`}>{type.help}</div> : null}
                        </div>
                        <ui.Switch id={`${uid}-${type.id}`} checked={wants(draft, type.id, defaultOff)} onChange={(v) => setType(type.id, v)} label={t('notify.switchLabel', { label: type.label })} describedBy={type.help ? `${uid}-${type.id}-h` : undefined} />
                      </div>
                    ))}
                  </div>
                ))}

                <section aria-label={t('notify.quietSection')} className={cls('quiet')}>
                  <div className={cls('quietHead')}>
                    <div>
                      <span className={cls('quietTitle')}><ui.Icon name="moon" />{t('notify.quietTitle')}</span>
                      <div className={cls('prefHelp')}>{t('notify.quietHelp')}</div>
                    </div>
                    <ui.Switch checked={draft.quietHours.enabled} onChange={(v) => setQuiet({ enabled: v })} label={t('notify.quietToggle')} />
                  </div>
                  {draft.quietHours.enabled ? (
                    <div className={cls('quietTimes')}>
                      <ui.TimeField label={t('notify.quietStart')} value={draft.quietHours.start} onChange={(v) => setQuiet({ start: v })} />
                      <ui.TimeField label={t('notify.quietEnd')} value={draft.quietHours.end} invalid={invalid} error={invalidAt === 'field' && invalid ? t('notify.quietInvalid') : null} onChange={(v) => setQuiet({ end: v })} />
                      <span className={cls('quietHint')}>{invalid && invalidAt === 'hint' ? t('notify.quietInvalid') : t('notify.quietOvernight')}</span>
                    </div>
                  ) : null}
                  {extraQuietRows?.(draft, setQuiet, { types })}
                </section>
                <p className={cls('privacy')}>{t('notify.privacy')}</p>
              </div>
            )}
    </ui.Card>
  )
}
