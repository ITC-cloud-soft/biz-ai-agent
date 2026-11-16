// Administrators › the AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md): nickname, first person and tone, company
// introduction, personality, background, speaking examples, per-AI-employee overrides (only when `agents` is given; without it one
// nickname for all); the preview of the signature and of
// the system prompt section DSH builds (fixed rules first); the server's check (rule wording / personal data refused) shown per
// field; the versions with 「この版に戻す」. The server (the business system, administrators only) is the source of record:
// `/bridge/v1/admin/ai-profile*` on the same origin, or another path (`endpoint`, e.g. an existing API's /api/ai-profile).
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  AI_PROFILE_LIMITS, AI_PROFILE_TONES, AiProfileError, aiProfileErrorText, cleanProfile, createAiProfileClient, draftFrom, emptyAiProfile, errorsByField,
  localErrors, nicknamePreview, personaPreview, sameProfile, signaturePreview,
  type AiProfile, type AiProfileClient, type AiProfileFieldError, type AiProfileState, type AiProfileVersion,
} from '../core/ai-profile-core.ts'
import type { StringKey } from '../core/strings-core.ts'
import { useWebKit } from './context.tsx'
import { useAsync, type Column } from './ui.tsx'

/** An AI employee the overrides are for: `id` = the DSH preset id (the key of `agents` in the profile), `name` = its label. */
export interface AiProfileAgent { id: string; name: string }

export interface AiProfilePageProps {
  /** The application's display name (the preview: 「— さくら（<appName> AI 秘書）」 and 「<appName>の AI 社員」). */
  appName: string
  /** The administrator's endpoint (default /bridge/v1/admin/ai-profile). Restore: `<endpoint>/versions/<n>/restore`. */
  endpoint?: string
  /** Instead of `endpoint`: a client (tests, a host with its own fetch). */
  client?: AiProfileClient
  /**
   * The AI employees that may get their own nickname / personality / background (none: no override card, one nickname for all;
   * saving then also clears overrides an earlier version had, so nothing invisible changes the AI's name).
   */
  agents?: readonly AiProfileAgent[]
  /** The preview shows the fixed rules too (default true; the section DSH builds always has them). */
  showRules?: boolean
  /** Who changed a version (default: the id as it is; the host may map employee ids to names it may show). */
  formatUser?: (id: string | null) => string
  title?: string
  description?: ReactNode
  /** Extra content above the form (e.g. a link back to the AI settings). */
  links?: ReactNode
}

const fieldOf = (agentId: string, key: 'nickname' | 'personality' | 'background') => `agents.${agentId}.${key}`

export function AiProfilePage({ appName, endpoint, client: given, agents = [], showRules = true, formatUser, title, description, links }: AiProfilePageProps) {
  const { t, toast, confirm, ui, cls, formatDateTime, errorMessage } = useWebKit()
  const uid = useId()
  const client = useMemo(() => given ?? createAiProfileClient(endpoint ? { endpoint } : {}), [given, endpoint])
  const q = useAsync(() => client.get(), [client])
  const [saved, setSaved] = useState<AiProfile>(emptyAiProfile)
  const [draft, setDraft] = useState<AiProfile>(emptyAiProfile)
  const [reason, setReason] = useState('')
  const [serverErrors, setServerErrors] = useState<AiProfileFieldError[]>([])
  const [busy, setBusy] = useState(false)
  const [previewAgent, setPreviewAgent] = useState('')
  useEffect(() => {
    const p = q.data ? draftFrom(q.data.profile) : null
    if (p) { setSaved(p); setDraft(p) }
  }, [q.data])

  const L = AI_PROFILE_LIMITS
  const errText = {
    required: t('aiProfile.err.required'), tooLong: t('aiProfile.err.tooLong'), invalid: t('aiProfile.err.invalid'), unknown: t('aiProfile.err.unknown'),
    ruleOverride: t('aiProfile.err.ruleOverride'), personalData: t('aiProfile.err.personalData'), other: t('aiProfile.err.other'),
  }
  // without override fields on the page, the profile has no overrides (one nickname); an earlier version's overrides go on save
  const editing: AiProfile = agents.length ? draft : { ...draft, agents: {} }
  const local = localErrors(editing)
  const byField = errorsByField([...serverErrors, ...local.filter((e) => !serverErrors.some((s) => s.field === e.field))])
  const errorOf = (field: string): string | null => {
    const list = byField[field]
    return list?.length ? [...new Set(list.map((e) => aiProfileErrorText(e, errText)))].join(' ') : null
  }
  const counter = (v: string, max: number) => t('aiProfile.counter', { n: v.trim().length, max })
  const dirty = !sameProfile(editing, saved)
  const set = (patch: Partial<AiProfile>) => { setDraft((d) => ({ ...d, ...patch })); setServerErrors([]) }
  const setAgent = (id: string, key: 'nickname' | 'personality' | 'background', v: string) => {
    setDraft((d) => ({ ...d, agents: { ...d.agents, [id]: { ...d.agents[id], [key]: v } } }))
    setServerErrors([])
  }

  const reload = q.reload
  const save = async () => {
    if (local.length) return
    setBusy(true)
    try {
      const { version } = await client.save(editing, reason)
      toast('success', t('aiProfile.saved', { version }))
      setReason('')
      setServerErrors([])
      reload()
    } catch (e) {
      if (e instanceof AiProfileError && e.errors.length) {
        setServerErrors(e.errors)
        toast('error', t('aiProfile.invalidTitle'))
      } else toast('error', t('aiProfile.saveFailed'), errorMessage(e))
    } finally { setBusy(false) }
  }
  const restore = async (v: AiProfileVersion) => {
    const ok = await confirm({
      title: t('aiProfile.restoreConfirmTitle', { version: v.version }),
      description: t('aiProfile.restoreConfirmBody', { version: v.version }),
      confirmLabel: t('aiProfile.restoreConfirm'),
    })
    if (!ok) return
    setBusy(true)
    try {
      const { version } = await client.restore(v.version)
      toast('success', t('aiProfile.restored', { version: v.version, newVersion: version }))
      reload()
    } catch (e) {
      toast('error', t('aiProfile.restoreFailed'), e instanceof AiProfileError && e.errors.length ? e.errors.map((x) => aiProfileErrorText(x, errText)).join(' ') : errorMessage(e))
    } finally { setBusy(false) }
  }

  const state: AiProfileState | null = q.data ?? null
  const preview = cleanProfile(editing)
  const agentId = previewAgent || undefined
  const promptText = personaPreview({ profile: preview, agentId, appName, rules: showRules })
  const signature = signaturePreview(appName, nicknamePreview(preview, agentId))
  const versionColumns: Column<AiProfileVersion>[] = [
    { key: 'version', header: t('aiProfile.colVersion'), render: (v) => <>{v.version}{state?.version === v.version ? <> <ui.Pill tone="success" dot={false}>{t('aiProfile.current')}</ui.Pill></> : null}</> },
    { key: 'at', header: t('aiProfile.colUpdatedAt'), render: (v) => formatDateTime(v.updatedAt) },
    { key: 'by', header: t('aiProfile.colUpdatedBy'), render: (v) => (formatUser ? formatUser(v.updatedBy) : v.updatedBy ?? t('common.dash')) },
    { key: 'reason', header: t('aiProfile.colReason'), render: (v) => v.reason ?? t('common.dash') },
    {
      key: 'restore', header: '', align: 'right',
      render: (v) => (state?.version === v.version ? null
        : <ui.Button size="sm" icon="refresh" disabled={busy} onClick={() => { void restore(v) }}>{t('aiProfile.restore')}</ui.Button>),
    },
  ]

  const toneKey = (tone: string) => `aiProfile.tone.${tone}` as StringKey
  return (
    <div className={cls('stack')}>
      <ui.PageHeader title={title ?? t('aiProfile.title')} description={description ?? t('aiProfile.description')} />
      {links}
      <ui.Notice tone="info" icon="shield" title={t('aiProfile.rulesTitle')}>{t('aiProfile.rulesBody')}</ui.Notice>
      {q.loading && !q.data ? <ui.Skeleton rows={6} />
        : q.error ? <ui.ErrorBox title={t('aiProfile.loadFailed')} error={q.error} retryLabel={t('common.retry')} onRetry={q.reload} />
          : !state ? <ui.Preparing title={t('aiProfile.unavailableTitle')}>{t('aiProfile.unavailable')}</ui.Preparing>
            : (
              <>
                <ui.Card title={t('aiProfile.basicTitle')} icon="bot" subtitle={t('aiProfile.basicSubtitle')}>
                  <div className={cls('stack')}>
                    {!state.profile ? <ui.Notice tone="neutral">{t('aiProfile.notSet')}</ui.Notice> : null}
                    <div className={cls('formGrid')}>
                      <ui.TextField id={`${uid}-nickname`} label={t('aiProfile.nickname')} help={t('aiProfile.nicknameHelp')} value={draft.nickname} maxLength={L.nickname + 10}
                        count={counter(draft.nickname, L.nickname)} error={errorOf('nickname')} onChange={(v) => set({ nickname: v })} />
                      <ui.TextField id={`${uid}-first`} label={t('aiProfile.firstPerson')} value={draft.firstPerson} maxLength={L.firstPerson + 10}
                        count={counter(draft.firstPerson, L.firstPerson)} error={errorOf('firstPerson')} onChange={(v) => set({ firstPerson: v })} />
                      <ui.SelectField id={`${uid}-tone`} label={t('aiProfile.tone')} value={draft.tone.preset} error={errorOf('tone.preset')}
                        options={AI_PROFILE_TONES.map((tone) => ({ value: tone, label: t(toneKey(tone)) }))}
                        onChange={(v) => set({ tone: { ...draft.tone, preset: (AI_PROFILE_TONES as readonly string[]).includes(v) ? (v as AiProfile['tone']['preset']) : 'polite' } })} />
                    </div>
                    <ui.TextField id={`${uid}-tone-note`} label={t('aiProfile.toneNote')} value={draft.tone.note} maxLength={L.toneNote + 20}
                      count={counter(draft.tone.note, L.toneNote)} error={errorOf('tone.note')} onChange={(v) => set({ tone: { ...draft.tone, note: v } })} />
                    <ui.TextField id={`${uid}-company`} label={t('aiProfile.company')} help={t('aiProfile.companyHelp')} value={draft.company} multiline rows={6}
                      maxLength={L.company + 100} count={counter(draft.company, L.company)} error={errorOf('company')} onChange={(v) => set({ company: v })} />
                    <ui.TextField id={`${uid}-personality`} label={t('aiProfile.personality')} value={draft.personality} multiline rows={3}
                      maxLength={L.personality + 50} count={counter(draft.personality, L.personality)} error={errorOf('personality')} onChange={(v) => set({ personality: v })} />
                    <ui.TextField id={`${uid}-background`} label={t('aiProfile.background')} value={draft.background} multiline rows={3}
                      maxLength={L.background + 50} count={counter(draft.background, L.background)} error={errorOf('background')} onChange={(v) => set({ background: v })} />
                    <div className={cls('examples')} role="group" aria-label={t('aiProfile.examples')}>
                      <span className={cls('previewLabel')}>{t('aiProfile.examples')}</span>
                      {draft.examples.map((e, i) => (
                        <div key={i} className={cls('exampleRow')}>
                          <ui.TextField id={`${uid}-ex-${i}`} label={t('aiProfile.example', { n: i + 1 })} value={e} maxLength={L.example + 20}
                            count={counter(e, L.example)} error={errorOf(`examples[${i}]`)}
                            onChange={(v) => set({ examples: draft.examples.map((x, j) => (j === i ? v : x)) })} />
                          <ui.Button size="sm" variant="ghost" icon="trash" onClick={() => set({ examples: draft.examples.filter((_, j) => j !== i) })}>{t('aiProfile.exampleRemove')}</ui.Button>
                        </div>
                      ))}
                      {errorOf('examples') ? <span className="dbw-field__error" role="alert">{errorOf('examples')}</span> : null}
                      {draft.examples.length < L.examples
                        ? <div><ui.Button size="sm" onClick={() => set({ examples: [...draft.examples, ''] })}>{t('aiProfile.exampleAdd')}</ui.Button></div> : null}
                    </div>
                  </div>
                </ui.Card>

                {agents.length ? (
                  <ui.Card title={t('aiProfile.agentsTitle')} icon="user" subtitle={t('aiProfile.agentsSubtitle')}>
                    <div className={cls('stack')}>
                      {agents.map((a) => (
                        <div key={a.id} className={cls('agentBlock')} role="group" aria-label={a.name}>
                          <div className={cls('agentTitle')}>{a.name}</div>
                          <ui.TextField id={`${uid}-ag-${a.id}-n`} label={t('aiProfile.agentNickname', { agent: a.name })} value={draft.agents[a.id]?.nickname ?? ''}
                            maxLength={L.nickname + 10} placeholder={draft.nickname} error={errorOf(fieldOf(a.id, 'nickname'))} onChange={(v) => setAgent(a.id, 'nickname', v)} />
                          <ui.TextField id={`${uid}-ag-${a.id}-p`} label={t('aiProfile.agentPersonality', { agent: a.name })} value={draft.agents[a.id]?.personality ?? ''} multiline rows={2}
                            maxLength={L.personality + 50} error={errorOf(fieldOf(a.id, 'personality'))} onChange={(v) => setAgent(a.id, 'personality', v)} />
                          <ui.TextField id={`${uid}-ag-${a.id}-b`} label={t('aiProfile.agentBackground', { agent: a.name })} value={draft.agents[a.id]?.background ?? ''} multiline rows={2}
                            maxLength={L.background + 50} error={errorOf(fieldOf(a.id, 'background'))} onChange={(v) => setAgent(a.id, 'background', v)} />
                        </div>
                      ))}
                    </div>
                  </ui.Card>
                ) : null}

                <ui.Card title={t('aiProfile.previewTitle')} icon="check" subtitle={t('aiProfile.previewSubtitle')}>
                  <div className={cls('preview')}>
                    {agents.length ? (
                      <ui.SelectField id={`${uid}-preview-agent`} label={t('aiProfile.previewAgent')} value={previewAgent}
                        options={[{ value: '', label: t('aiProfile.previewAll') }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={setPreviewAgent} />
                    ) : null}
                    <span className={cls('previewLabel')}>{t('aiProfile.previewSignature')}</span>
                    <pre className={cls('previewText')} aria-label={t('aiProfile.previewSignature')}>{signature}</pre>
                    <span className={cls('previewLabel')}>{t('aiProfile.previewPrompt')}</span>
                    {promptText ? <pre className={cls('previewText')} aria-label={t('aiProfile.previewPrompt')}>{promptText}</pre>
                      : <p className={cls('muted')}>{t('aiProfile.previewEmpty')}</p>}
                  </div>
                </ui.Card>

                {serverErrors.length ? (
                  <ui.Notice tone="danger" title={t('aiProfile.invalidTitle')}>
                    {[...new Set(serverErrors.map((e) => aiProfileErrorText(e, errText)))].join(' ')}
                  </ui.Notice>
                ) : null}
                <div className={cls('saveBar')}>
                  {dirty ? <span className={cls('muted')}>{t('aiProfile.dirty')}</span> : null}
                  <ui.TextField id={`${uid}-reason`} label={t('aiProfile.reason')} value={reason} maxLength={L.reason} onChange={setReason} />
                  <ui.Button variant="primary" icon="save" loading={busy} disabled={busy || !dirty || local.length > 0} onClick={() => { void save() }}>{t('aiProfile.save')}</ui.Button>
                </div>

                <ui.Card title={t('aiProfile.versionsTitle')} icon="refresh" subtitle={t('aiProfile.versionsSubtitle')} flush>
                  <ui.DataTable caption={t('aiProfile.versionsCaption')} columns={versionColumns} rows={state.versions} rowKey={(v) => String(v.version)}
                    empty={<ui.Empty title={t('aiProfile.versionsEmpty')} />} />
                </ui.Card>
              </>
            )}
    </div>
  )
}
