// Administrators › which roles may attach files in the AI assistant panel, and which types (docs/ASSISTANT_ATTACHMENTS.md §3.1).
// The server (the business system, administrators only) is the source of record: GET / PUT /bridge/v1/admin/assistant/attachment-settings
// on the same origin, another path (`endpoint`, e.g. an existing API's /api/admin/assistant/attachment-settings) or a `client`.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ATTACHMENT_TYPE_IDS, AttachmentSettingsError, createAttachmentSettingsClient, formatBytes, sameAdminSettings,
  type AttachmentAdminSettings, type AttachmentLimits, type AttachmentSettingsClient, type AttachmentType,
} from '../core/assistant-attachments-core.ts'
import type { StringKey } from '../core/strings-core.ts'
import { useWebKit } from './context.tsx'
import { useAsync } from './ui.tsx'

/** A role the administrator can allow: `id` = the business role name, `label` = what the screen shows. */
export interface AttachmentRoleOption { id: string; label: string; help?: string }

export interface AttachmentSettingsCardProps {
  /** The roles that can be checked (in this order). Roles the server returns that are not listed are kept as they are. */
  roles: readonly AttachmentRoleOption[]
  /** The types that can be checked (default all seven; the server may accept fewer). */
  types?: readonly AttachmentType[]
  endpoint?: string
  client?: AttachmentSettingsClient
  title?: ReactNode
  subtitle?: ReactNode
  /** Called after a successful save. */
  onSaved?: (settings: AttachmentAdminSettings) => void
}

const TYPE_KEYS: Record<AttachmentType, StringKey> = {
  image: 'attach.typeImage', pdf: 'attach.typePdf', docx: 'attach.typeDocx', xlsx: 'attach.typeXlsx', csv: 'attach.typeCsv', markdown: 'attach.typeMarkdown', text: 'attach.typeText',
}

export function AttachmentSettingsCard({ roles, types = ATTACHMENT_TYPE_IDS, endpoint, client: given, title, subtitle, onSaved }: AttachmentSettingsCardProps) {
  const { t, toast, ui, cls, errorMessage } = useWebKit()
  const client = useMemo(() => given ?? createAttachmentSettingsClient(endpoint ? { endpoint } : {}), [given, endpoint])
  const q = useAsync(async () => {
    try { return await client.get() } catch (e) {
      if (e instanceof AttachmentSettingsError && (e.status === 404 || e.status === 501)) return null
      throw e
    }
  }, [client])
  const empty: AttachmentAdminSettings = { roles: [], types: [] }
  const [saved, setSaved] = useState<AttachmentAdminSettings>(empty)
  const [draft, setDraft] = useState<AttachmentAdminSettings>(empty)
  const [limits, setLimits] = useState<AttachmentLimits | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data) {
      const s = { roles: q.data.roles, types: q.data.types }
      setSaved(s); setDraft(s); setLimits(q.data.limits ?? null)
    }
  }, [q.data])

  const toggle = <K extends 'roles' | 'types'>(key: K, id: AttachmentAdminSettings[K][number], on: boolean) =>
    setDraft((d) => ({ ...d, [key]: on ? [...new Set([...(d[key] as string[]), id])] : (d[key] as string[]).filter((x) => x !== id) }))
  const dirty = !sameAdminSettings(draft, saved)

  const save = async () => {
    setBusy(true)
    try {
      const next = await client.save(draft)
      const s = { roles: next.roles, types: next.types }
      setSaved(s); setDraft(s); setLimits(next.limits ?? limits)
      toast('success', t('attachSettings.saved'))
      onSaved?.(s)
    } catch (e) { toast('error', t('attachSettings.saveFailed'), errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <ui.Card title={title ?? t('attachSettings.title')} icon="paperclip" subtitle={subtitle ?? t('attachSettings.subtitle')}
      actions={<ui.Button variant="primary" size="sm" icon="save" loading={busy} disabled={!dirty || busy || !q.data} onClick={save}>{t('attachSettings.save')}</ui.Button>}>
      {q.loading && !q.data ? <ui.Skeleton rows={4} />
        : q.error ? <ui.ErrorBox title={t('attachSettings.loadFailed')} error={q.error} retryLabel={t('common.retry')} onRetry={q.reload} />
          : !q.data ? <ui.Preparing title={t('attachSettings.unavailableTitle')}>{t('attachSettings.unavailable')}</ui.Preparing>
            : (
              <div className={cls('stack')}>
                <fieldset className={cls('checkGrid')}>
                  <legend className={cls('prefLabel')}>{t('attachSettings.roles')}</legend>
                  {roles.map((r) => (
                    <label key={r.id} className={cls('checkItem')}>
                      <input type="checkbox" checked={draft.roles.includes(r.id)} disabled={busy} onChange={(e) => toggle('roles', r.id, e.currentTarget.checked)} />
                      <span>{r.label}{r.help ? <span className={cls('prefHelp')}> {r.help}</span> : null}</span>
                    </label>
                  ))}
                </fieldset>
                {!draft.roles.length ? <ui.Notice tone="warning">{t('attachSettings.noRoles')}</ui.Notice> : null}
                <fieldset className={cls('checkGrid')}>
                  <legend className={cls('prefLabel')}>{t('attachSettings.types')}</legend>
                  {types.map((x) => (
                    <label key={x} className={cls('checkItem')}>
                      <input type="checkbox" checked={draft.types.includes(x)} disabled={busy} onChange={(e) => toggle('types', x, e.currentTarget.checked)} />
                      <span>{t(TYPE_KEYS[x])}</span>
                    </label>
                  ))}
                </fieldset>
                {!draft.types.length ? <ui.Notice tone="warning">{t('attachSettings.noTypes')}</ui.Notice> : null}
                {limits ? <p className={cls('prefHelp')}>{t('attachSettings.limits', { maxFiles: limits.maxFiles, maxFile: formatBytes(limits.maxFileBytes), maxTotal: formatBytes(limits.maxTotalBytes) })}</p> : null}
                <p className={cls('privacy')}>{t('attachSettings.privacy')}</p>
              </div>
            )}
    </ui.Card>
  )
}
