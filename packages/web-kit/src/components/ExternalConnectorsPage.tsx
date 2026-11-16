// Administrators › external connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3): the emergency stop, the connectors (own /
// third-party APIs: the allowed hosts, the auth, the operations with their roles and response fields), the secret (sent once, shown as
// the hint only), the connection test, the rules (event / cron → auto / approval / propose-by-ai) and the run log (ids, status, timing).
// The business system is the source of record and runs every call: `/bridge/v1/admin/*` on the same origin, or another `base`
// (e.g. an existing API's /api/admin), or a `client`.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  BILLING_SOFTWARE_TEMPLATE, CONNECTOR_AUTH_TYPES, ConnectorsError, RULE_MODES, SECRET_FIELDS, createConnectorsClient, emptyConnector, emptyRule, hostOf,
  isConnectorsUnavailable, parseJsonField, triggerText,
  type Connector, type ConnectorAdmin, type ConnectorAuthType, type ConnectorFieldError, type ConnectorList, type ConnectorRule, type ConnectorRun,
  type ConnectorTemplate, type ConnectorsClient, type RuleMode,
} from '../core/external-connectors-core.ts'
import type { StringKey } from '../core/strings-core.ts'
import { useWebKit } from './context.tsx'
import { useAsync, type Column } from './ui.tsx'

export interface ExternalConnectorsPageProps {
  /** The administrator's API base (default /bridge/v1/admin). */
  base?: string
  client?: ConnectorsClient
  /** Starting points for 「ひな形から追加」 (default: the billing software read example). */
  templates?: readonly ConnectorTemplate[]
  /** Labels of the business roles (approvers, the operations' roles). */
  roleLabels?: Readonly<Record<string, string>>
  /** Who did it (default: the id as it is). */
  formatUser?: (id: string | null) => string
  title?: string
  description?: ReactNode
  links?: ReactNode
}

interface ConnectorDraft { connector: Connector; operationsText: string; allowedHostsText: string; isNew: boolean }
interface RuleDraft { rule: ConnectorRule; whenText: string; inputText: string; isNew: boolean; triggerKind: 'event' | 'cron' }

const json = (v: unknown) => JSON.stringify(v, null, 2)

export function ExternalConnectorsPage({ base, client: given, templates = [BILLING_SOFTWARE_TEMPLATE], roleLabels = {}, formatUser, title, description, links }: ExternalConnectorsPageProps) {
  const { t, toast, confirm, ui, cls, formatDateTime, errorMessage } = useWebKit()
  const uid = useId()
  const client = useMemo(() => given ?? createConnectorsClient(base ? { base } : {}), [given, base])
  const q = useAsync(async () => {
    try {
      const [list, rules, runs] = await Promise.all([client.list(), client.rules(), client.runs({ limit: 50 })])
      return { list, rules, runs }
    } catch (e) {
      if (isConnectorsUnavailable(e)) return null
      throw e
    }
  }, [client])
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<ConnectorFieldError[]>([])
  const [cDraft, setCDraft] = useState<ConnectorDraft | null>(null)
  const [rDraft, setRDraft] = useState<RuleDraft | null>(null)
  const [secretFor, setSecretFor] = useState<ConnectorAdmin | null>(null)
  const [secret, setSecret] = useState<Record<string, string>>({})
  const [testFor, setTestFor] = useState<ConnectorAdmin | null>(null)
  const [testOp, setTestOp] = useState('')
  const [testInput, setTestInput] = useState('{}')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [stopReason, setStopReason] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => { setErrors([]) }, [cDraft?.isNew, rDraft?.isNew])

  const user = (id: string | null) => (formatUser ? formatUser(id) : id ?? t('common.dash'))
  const role = (r: string) => roleLabels[r] ?? r
  const errText = (e: ConnectorFieldError) => {
    const key = `conn.err.${e.code}` as StringKey
    const text = t(key)
    return `${e.field || '—'}: ${text === key ? e.code : text}`
  }
  const fail = (e: unknown, fallback: StringKey) => {
    if (e instanceof ConnectorsError && e.errors.length) { setErrors(e.errors); toast('error', t('conn.invalidTitle')); return }
    if (e instanceof ConnectorsError && e.code === 'connector_in_use') {
      toast('error', t('conn.saveFailed'), t('conn.err.connector_in_use', { rules: Array.isArray(e.details.rules) ? (e.details.rules as string[]).join(', ') : '' }))
      return
    }
    toast('error', t(fallback), errorMessage(e))
  }
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } finally { setBusy(false) } }

  const data = q.data
  const list: ConnectorList | null = data?.list ?? null

  // ------------------------------------------------------------------ the emergency stop
  const toggleStop = (stopped: boolean) => run(async () => {
    try { await client.setStopped(stopped, stopReason || undefined); setStopReason(''); toast('success', t('conn.stopSaved')); q.reload() } catch (e) { fail(e, 'conn.saveFailed') }
  })

  // ------------------------------------------------------------------ connectors
  const editConnector = (c: Connector, isNew: boolean) => {
    setRDraft(null)
    setCDraft({ connector: structuredClone(c), operationsText: json(c.operations), allowedHostsText: (c.allowedHosts ?? []).join(', '), isNew })
  }
  const setC = (patch: Partial<Connector>) => setCDraft((d) => (d ? { ...d, connector: { ...d.connector, ...patch } } : d))
  const setAuth = (type: ConnectorAuthType) => setC({ auth: type === 'api_key' ? { type, headerName: 'x-api-key' } : { type } })
  const saveConnector = () => run(async () => {
    if (!cDraft) return
    const ops = parseJsonField<Connector['operations']>(cDraft.operationsText)
    if (!ops.ok || !Array.isArray(ops.value)) { setErrors([{ field: 'operations', code: 'invalid' }]); toast('error', t('conn.invalidJson')); return }
    const allowedHosts = cDraft.allowedHostsText.split(',').map((x) => x.trim()).filter(Boolean)
    try {
      await client.save({ ...cDraft.connector, operations: ops.value, allowedHosts }, reason || undefined)
      toast('success', t('conn.saved')); setCDraft(null); setErrors([]); setReason(''); q.reload()
    } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const deleteConnector = (c: ConnectorAdmin) => run(async () => {
    const ok = await confirm({ title: t('conn.deleteConfirmTitle', { name: c.name }), description: t('conn.deleteConfirmBody'), confirmLabel: t('conn.delete') })
    if (!ok) return
    try { await client.remove(c.id); toast('success', t('conn.deleted')); q.reload() } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const toggleConnector = (c: ConnectorAdmin) => run(async () => {
    try { await client.save({ ...c, enabled: !c.enabled }); q.reload() } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const saveSecret = () => run(async () => {
    if (!secretFor) return
    try {
      const r = await client.setSecret(secretFor.id, secret)
      toast('success', t('conn.secretSaved', { hint: r.secretHint ?? '' })); setSecret({}); setSecretFor(null); setErrors([]); q.reload()
    } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const clearSecret = () => run(async () => {
    if (!secretFor) return
    try { await client.clearSecret(secretFor.id); setSecretFor(null); q.reload() } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const runTest = () => run(async () => {
    if (!testFor) return
    const input = parseJsonField<Record<string, unknown>>(testInput)
    if (!input.ok) { toast('error', t('conn.invalidJson')); return }
    try {
      const r = await client.test(testFor.id, { ...(testOp ? { operationId: testOp } : {}), input: input.value })
      setTestResult({ ok: r.ok, text: r.ok ? t('conn.testOk', { status: r.status ?? '-', ms: r.durationMs, fields: r.fields.join(', ') || t('common.dash') }) : t('conn.testFailed', { code: r.code ?? '-', status: r.status ?? '-' }) })
      q.reload()
    } catch (e) { fail(e, 'conn.saveFailed') }
  })

  // ------------------------------------------------------------------ rules
  const editRule = (r: ConnectorRule, isNew: boolean) => {
    setCDraft(null)
    setRDraft({ rule: structuredClone(r), whenText: r.when ? json(r.when) : '', inputText: json(r.action.input ?? {}), isNew, triggerKind: r.trigger.cron ? 'cron' : 'event' })
  }
  const setR = (patch: Partial<ConnectorRule>) => setRDraft((d) => (d ? { ...d, rule: { ...d.rule, ...patch } } : d))
  const saveRule = () => run(async () => {
    if (!rDraft) return
    const when = rDraft.whenText.trim() ? parseJsonField<ConnectorRule['when']>(rDraft.whenText) : { ok: true as const, value: null }
    const input = parseJsonField<ConnectorRule['action']['input']>(rDraft.inputText || '{}')
    if (!when.ok || !input.ok) { toast('error', t('conn.invalidJson')); return }
    const trigger = rDraft.triggerKind === 'cron' ? { cron: rDraft.rule.trigger.cron ?? '' } : { event: rDraft.rule.trigger.event ?? '' }
    try {
      await client.saveRule({ ...rDraft.rule, trigger, when: when.value, action: { ...rDraft.rule.action, input: input.value } }, reason || undefined)
      toast('success', t('conn.ruleSaved')); setRDraft(null); setErrors([]); setReason(''); q.reload()
    } catch (e) { fail(e, 'conn.saveFailed') }
  })
  const deleteRule = (r: ConnectorRule) => run(async () => {
    try { await client.removeRule(r.id); toast('success', t('conn.ruleDeleted')); q.reload() } catch (e) { fail(e, 'conn.saveFailed') }
  })

  const connectorColumns: Column<ConnectorAdmin>[] = [
    { key: 'name', header: t('conn.colName'), render: (c) => <>{c.name}<div className={cls('muted')}>{t(`conn.kind.${c.kind}` as StringKey)}</div></> },
    { key: 'host', header: t('conn.colHost'), render: (c) => hostOf(c.baseUrl) || t('common.dash') },
    { key: 'ops', header: t('conn.colOps'), render: (c) => c.operations.map((o) => `${o.name}（${o.effect}）`).join('、') || t('common.dash') },
    { key: 'secret', header: t('conn.colSecret'), render: (c) => (c.auth.type === 'none' ? t('common.dash') : c.hasSecret ? t('conn.secretSet', { hint: c.secretHint ?? '' }) : t('conn.secretUnset')) },
    { key: 'state', header: t('conn.colState'), render: (c) => <ui.Pill tone={c.enabled ? 'success' : 'warning'}>{t(c.enabled ? 'conn.enabled' : 'conn.disabled')}</ui.Pill> },
    {
      key: 'actions', header: '', align: 'right',
      render: (c) => (
        <span className={cls('actions')}>
          <ui.Button size="sm" disabled={busy} onClick={() => editConnector(c, false)}>{t('conn.edit')}</ui.Button>
          {c.auth.type !== 'none' ? <ui.Button size="sm" disabled={busy} onClick={() => { setSecretFor(c); setSecret({}); setErrors([]) }}>{t('conn.secretTitle')}</ui.Button> : null}
          <ui.Button size="sm" disabled={busy} onClick={() => { setTestFor(c); setTestOp(c.operations.find((o) => o.effect === 'read')?.id ?? ''); setTestInput('{}'); setTestResult(null) }}>{t('conn.test')}</ui.Button>
          <ui.Button size="sm" disabled={busy} onClick={() => { void toggleConnector(c) }}>{t(c.enabled ? 'conn.disabled' : 'conn.enabled')}</ui.Button>
          <ui.Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => { void deleteConnector(c) }}>{t('conn.delete')}</ui.Button>
        </span>
      ),
    },
  ]
  const ruleColumns: Column<ConnectorRule>[] = [
    { key: 'name', header: t('conn.colName'), render: (r) => <>{r.name}{r.enabled ? null : <> <ui.Pill tone="warning">{t('conn.disabled')}</ui.Pill></>}</> },
    { key: 'trigger', header: t('conn.colTrigger'), render: (r) => triggerText(r) },
    { key: 'action', header: t('conn.colAction'), render: (r) => `${r.action.connector} / ${r.action.operation}` },
    { key: 'mode', header: t('conn.colMode'), render: (r) => `${t(`conn.mode.${r.mode}` as StringKey)}${r.approvers ? `（${role(r.approvers.role)}）` : ''}` },
    {
      key: 'actions', header: '', align: 'right',
      render: (r) => (
        <span className={cls('actions')}>
          <ui.Button size="sm" disabled={busy} onClick={() => editRule(r, false)}>{t('conn.edit')}</ui.Button>
          <ui.Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => { void deleteRule(r) }}>{t('conn.delete')}</ui.Button>
        </span>
      ),
    },
  ]
  const runColumns: Column<ConnectorRun>[] = [
    { key: 'at', header: t('conn.colAt'), render: (r) => formatDateTime(r.at) },
    { key: 'what', header: t('conn.colAction'), render: (r) => `${r.connectorId} / ${r.operationId}${r.ruleId ? `（${r.ruleId}）` : ''}` },
    { key: 'trigger', header: t('conn.colRunTrigger'), render: (r) => `${r.trigger}${r.actor ? ` · ${user(r.actor)}` : ''}` },
    { key: 'status', header: t('conn.colStatus'), render: (r) => <ui.Pill tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' || r.status === 'refused' ? 'danger' : 'info'}>{t(`conn.status.${r.status}` as StringKey)}</ui.Pill> },
    { key: 'code', header: t('conn.colCode'), render: (r) => [r.code, r.httpStatus ? `HTTP ${r.httpStatus}` : null].filter(Boolean).join(' · ') || t('common.dash') },
    { key: 'ms', header: t('conn.colDuration'), align: 'right', render: (r) => (r.durationMs === null ? t('common.dash') : `${r.durationMs} ms`) },
  ]

  const operationsOf = (connectorId: string) => list?.connectors.find((c) => c.id === connectorId)?.operations ?? []
  const errorBox = errors.length ? <ui.Notice tone="danger" title={t('conn.invalidTitle')}>{errors.map(errText).join(' / ')}</ui.Notice> : null

  return (
    <div className={cls('stack')}>
      <ui.PageHeader title={title ?? t('conn.title')} description={description ?? t('conn.description')} />
      {links}
      <ui.Notice tone="info" icon="shield" title={t('conn.rulesNoticeTitle')}>{t('conn.rulesNotice')}</ui.Notice>
      {q.loading && !data ? <ui.Skeleton rows={6} />
        : q.error ? <ui.ErrorBox title={t('conn.loadFailed')} error={q.error} retryLabel={t('common.retry')} onRetry={q.reload} />
          : !data || !list ? <ui.Preparing title={t('conn.unavailableTitle')}>{t('conn.unavailable')}</ui.Preparing>
            : (
              <>
                <ui.Card title={t('conn.stopTitle')} icon="shield" subtitle={t('conn.stopSubtitle')}>
                  <div className={cls('stack')}>
                    <ui.Switch id={`${uid}-stop`} checked={list.state.stopped} disabled={busy} label={t('conn.stopSwitch')} onChange={(v) => { void toggleStop(v) }} />
                    <span className={cls('muted')}>{list.state.stopped ? t('conn.stopped', { at: formatDateTime(list.state.stoppedAt), by: user(list.state.stoppedBy) }) : t('conn.running')}</span>
                    <ui.TextField id={`${uid}-stop-reason`} label={t('conn.stopReason')} value={stopReason} maxLength={200} onChange={setStopReason} />
                  </div>
                </ui.Card>

                <ui.Card title={t('conn.connectorsTitle')} icon="link" subtitle={t('conn.connectorsSubtitle')} flush
                  actions={(
                    <span className={cls('actions')}>
                      <ui.Button size="sm" variant="primary" disabled={busy} onClick={() => editConnector(emptyConnector(), true)}>{t('conn.add')}</ui.Button>
                      {templates.map((tpl) => <ui.Button key={tpl.id} size="sm" disabled={busy} onClick={() => editConnector(tpl.connector, true)}>{t('conn.addFromTemplate', { label: tpl.label })}</ui.Button>)}
                    </span>
                  )}>
                  <ui.DataTable caption={t('conn.connectorsTitle')} columns={connectorColumns} rows={list.connectors} rowKey={(c) => c.id} empty={<ui.Empty title={t('conn.empty')} />} />
                </ui.Card>

                {cDraft ? (
                  <ui.Card title={t('conn.formTitle')} icon="link">
                    <div className={cls('stack')}>
                      {errorBox}
                      <div className={cls('formGrid')}>
                        <ui.TextField id={`${uid}-c-id`} label={t('conn.id')} value={cDraft.connector.id} maxLength={40} disabled={!cDraft.isNew} onChange={(v) => setC({ id: v.trim() })} />
                        <ui.TextField id={`${uid}-c-name`} label={t('conn.name')} value={cDraft.connector.name} maxLength={60} onChange={(v) => setC({ name: v })} />
                        <ui.SelectField id={`${uid}-c-kind`} label={t('conn.kind')} value={cDraft.connector.kind}
                          options={[{ value: 'own', label: t('conn.kind.own') }, { value: 'third_party', label: t('conn.kind.third_party') }]} onChange={(v) => setC({ kind: v === 'own' ? 'own' : 'third_party' })} />
                      </div>
                      <ui.TextField id={`${uid}-c-desc`} label={t('conn.descriptionField')} value={cDraft.connector.description} maxLength={300} onChange={(v) => setC({ description: v })} />
                      <ui.TextField id={`${uid}-c-url`} label={t('conn.baseUrl')} value={cDraft.connector.baseUrl} maxLength={300} onChange={(v) => setC({ baseUrl: v.trim() })} />
                      <ui.TextField id={`${uid}-c-hosts`} label={t('conn.allowedHosts')} value={cDraft.allowedHostsText} maxLength={600} onChange={(v) => setCDraft((d) => (d ? { ...d, allowedHostsText: v } : d))} />
                      <div className={cls('formGrid')}>
                        <ui.SelectField id={`${uid}-c-auth`} label={t('conn.authType')} value={cDraft.connector.auth.type}
                          options={CONNECTOR_AUTH_TYPES.map((a) => ({ value: a, label: t(`conn.auth.${a}` as StringKey) }))} onChange={(v) => setAuth(v as ConnectorAuthType)} />
                        {cDraft.connector.auth.type === 'api_key' ? <ui.TextField id={`${uid}-c-header`} label={t('conn.headerName')} value={cDraft.connector.auth.headerName ?? ''} maxLength={60} onChange={(v) => setC({ auth: { ...cDraft.connector.auth, headerName: v.trim() } })} /> : null}
                        {cDraft.connector.auth.type === 'basic' ? <ui.TextField id={`${uid}-c-user`} label={t('conn.username')} value={cDraft.connector.auth.username ?? ''} maxLength={120} onChange={(v) => setC({ auth: { ...cDraft.connector.auth, username: v } })} /> : null}
                        {cDraft.connector.auth.type === 'oauth2_client' ? (
                          <>
                            <ui.TextField id={`${uid}-c-token`} label={t('conn.tokenUrl')} value={cDraft.connector.auth.tokenUrl ?? ''} maxLength={300} onChange={(v) => setC({ auth: { ...cDraft.connector.auth, tokenUrl: v.trim() } })} />
                            <ui.TextField id={`${uid}-c-client`} label={t('conn.clientId')} value={cDraft.connector.auth.clientId ?? ''} maxLength={200} onChange={(v) => setC({ auth: { ...cDraft.connector.auth, clientId: v.trim() } })} />
                          </>
                        ) : null}
                        <ui.TextField id={`${uid}-c-timeout`} label={t('conn.timeoutMs')} value={String(cDraft.connector.timeoutMs)} maxLength={5} onChange={(v) => setC({ timeoutMs: Number(v) || 0 })} />
                        <ui.TextField id={`${uid}-c-rate`} label={t('conn.ratePerMinute')} value={String(cDraft.connector.ratePerMinute)} maxLength={3} onChange={(v) => setC({ ratePerMinute: Number(v) || 0 })} />
                      </div>
                      <ui.Switch id={`${uid}-c-enabled`} checked={cDraft.connector.enabled} label={t('conn.enabledSwitch')} onChange={(v) => setC({ enabled: v })} />
                      <ui.TextField id={`${uid}-c-ops`} label={t('conn.operations')} help={t('conn.operationsHelp')} value={cDraft.operationsText} multiline rows={14} onChange={(v) => setCDraft((d) => (d ? { ...d, operationsText: v } : d))} />
                      <div className={cls('saveBar')}>
                        <ui.TextField id={`${uid}-c-reason`} label={t('conn.reason')} value={reason} maxLength={200} onChange={setReason} />
                        <ui.Button onClick={() => { setCDraft(null); setErrors([]) }}>{t('common.cancel')}</ui.Button>
                        <ui.Button variant="primary" icon="save" loading={busy} disabled={busy} onClick={() => { void saveConnector() }}>{t('conn.save')}</ui.Button>
                      </div>
                    </div>
                  </ui.Card>
                ) : null}

                {secretFor ? (
                  <ui.Card title={`${t('conn.secretTitle')}：${secretFor.name}`} icon="shield" subtitle={t('conn.secretHelp')}>
                    <div className={cls('stack')}>
                      {errorBox}
                      {SECRET_FIELDS[secretFor.auth.type].length ? SECRET_FIELDS[secretFor.auth.type].map((f) => (
                        <label key={f} className="dbw-field dbw-field--block">
                          <span className="dbw-field__label">{t(`conn.secret.${f}` as StringKey)}</span>
                          <input type="password" autoComplete="new-password" value={secret[f] ?? ''} maxLength={4096} onChange={(e) => setSecret((s) => ({ ...s, [f]: e.target.value }))} />
                        </label>
                      )) : <p className={cls('muted')}>{t('conn.secretNotNeeded')}</p>}
                      <div className={cls('saveBar')}>
                        <ui.Button onClick={() => { setSecretFor(null); setSecret({}) }}>{t('common.cancel')}</ui.Button>
                        {secretFor.hasSecret ? <ui.Button variant="ghost" icon="trash" disabled={busy} onClick={() => { void clearSecret() }}>{t('conn.secretClear')}</ui.Button> : null}
                        <ui.Button variant="primary" icon="save" loading={busy} disabled={busy || !SECRET_FIELDS[secretFor.auth.type].every((f) => (secret[f] ?? '').trim())} onClick={() => { void saveSecret() }}>{t('conn.secretSave')}</ui.Button>
                      </div>
                    </div>
                  </ui.Card>
                ) : null}

                {testFor ? (
                  <ui.Card title={`${t('conn.testTitle')}：${testFor.name}`} icon="check">
                    <div className={cls('stack')}>
                      <ui.SelectField id={`${uid}-t-op`} label={t('conn.testOperation')} value={testOp}
                        options={testFor.operations.filter((o) => o.effect === 'read').map((o) => ({ value: o.id, label: o.name }))} onChange={setTestOp} />
                      <ui.TextField id={`${uid}-t-input`} label={t('conn.testInput')} value={testInput} multiline rows={3} onChange={setTestInput} />
                      {testResult ? <ui.Notice tone={testResult.ok ? 'success' : 'warning'}>{testResult.text}</ui.Notice> : null}
                      <div className={cls('saveBar')}>
                        <ui.Button onClick={() => setTestFor(null)}>{t('common.close')}</ui.Button>
                        <ui.Button variant="primary" loading={busy} disabled={busy || !testOp} onClick={() => { void runTest() }}>{t('conn.testRun')}</ui.Button>
                      </div>
                    </div>
                  </ui.Card>
                ) : null}

                <ui.Card title={t('conn.rulesTitle')} icon="bell" subtitle={t('conn.rulesSubtitle')} flush
                  actions={<ui.Button size="sm" variant="primary" disabled={busy || !list.connectors.length} onClick={() => editRule({ ...emptyRule(), action: { connector: list.connectors[0]?.id ?? '', operation: list.connectors[0]?.operations[0]?.id ?? '', input: {} } }, true)}>{t('conn.ruleAdd')}</ui.Button>}>
                  <ui.DataTable caption={t('conn.rulesTitle')} columns={ruleColumns} rows={data.rules} rowKey={(r) => r.id} empty={<ui.Empty title={t('conn.ruleEmpty')} />} />
                </ui.Card>

                {rDraft ? (
                  <ui.Card title={t('conn.ruleFormTitle')} icon="bell">
                    <div className={cls('stack')}>
                      {errorBox}
                      <div className={cls('formGrid')}>
                        <ui.TextField id={`${uid}-r-id`} label={t('conn.ruleId')} value={rDraft.rule.id} maxLength={64} disabled={!rDraft.isNew} onChange={(v) => setR({ id: v.trim() })} />
                        <ui.TextField id={`${uid}-r-name`} label={t('conn.ruleName')} value={rDraft.rule.name} maxLength={60} onChange={(v) => setR({ name: v })} />
                        <ui.SelectField id={`${uid}-r-tk`} label={t('conn.ruleTrigger')} value={rDraft.triggerKind}
                          options={[{ value: 'event', label: t('conn.ruleTrigger.event') }, { value: 'cron', label: t('conn.ruleTrigger.cron') }]}
                          onChange={(v) => setRDraft((d) => (d ? { ...d, triggerKind: v === 'cron' ? 'cron' : 'event' } : d))} />
                        {rDraft.triggerKind === 'event'
                          ? <ui.SelectField id={`${uid}-r-event`} label={t('conn.ruleEvent')} value={rDraft.rule.trigger.event ?? ''}
                            options={[{ value: '', label: t('common.dash') }, ...list.events.map((e) => ({ value: e, label: e }))]} onChange={(v) => setR({ trigger: { event: v } })} />
                          : <ui.TextField id={`${uid}-r-cron`} label={t('conn.ruleCron')} value={rDraft.rule.trigger.cron ?? ''} maxLength={60} placeholder="0 9 * * 1-5" onChange={(v) => setR({ trigger: { cron: v } })} />}
                        <ui.SelectField id={`${uid}-r-conn`} label={t('conn.ruleConnector')} value={rDraft.rule.action.connector}
                          options={list.connectors.map((c) => ({ value: c.id, label: c.name }))}
                          onChange={(v) => setR({ action: { connector: v, operation: operationsOf(v)[0]?.id ?? '', input: rDraft.rule.action.input } })} />
                        <ui.SelectField id={`${uid}-r-op`} label={t('conn.ruleOperation')} value={rDraft.rule.action.operation}
                          options={operationsOf(rDraft.rule.action.connector).map((o) => ({ value: o.id, label: `${o.name}（${o.effect}）` }))}
                          onChange={(v) => setR({ action: { ...rDraft.rule.action, operation: v } })} />
                        <ui.SelectField id={`${uid}-r-mode`} label={t('conn.ruleMode')} value={rDraft.rule.mode}
                          options={RULE_MODES.map((m) => ({ value: m, label: t(`conn.mode.${m}` as StringKey) }))} onChange={(v) => setR({ mode: v as RuleMode })} />
                        <ui.SelectField id={`${uid}-r-appr`} label={t('conn.ruleApprovers')} value={rDraft.rule.approvers?.role ?? ''}
                          options={[{ value: '', label: t('common.dash') }, ...list.roles.map((r) => ({ value: r, label: role(r) }))]} onChange={(v) => setR({ approvers: v ? { role: v } : null })} />
                      </div>
                      <ui.TextField id={`${uid}-r-when`} label={t('conn.ruleWhen')} help={t('conn.ruleWhenHelp')} value={rDraft.whenText} multiline rows={4} onChange={(v) => setRDraft((d) => (d ? { ...d, whenText: v } : d))} />
                      <ui.TextField id={`${uid}-r-input`} label={t('conn.ruleInput')} help={t('conn.ruleInputHelp')} value={rDraft.inputText} multiline rows={4} onChange={(v) => setRDraft((d) => (d ? { ...d, inputText: v } : d))} />
                      <label className={cls('checkItem')}>
                        <input type="checkbox" checked={rDraft.rule.allowPii} onChange={(e) => setR({ allowPii: e.target.checked })} /> {t('conn.ruleAllowPii')}
                      </label>
                      <ui.Switch id={`${uid}-r-enabled`} checked={rDraft.rule.enabled} label={t('conn.ruleEnabled')} onChange={(v) => setR({ enabled: v })} />
                      <div className={cls('saveBar')}>
                        <ui.TextField id={`${uid}-r-reason`} label={t('conn.reason')} value={reason} maxLength={200} onChange={setReason} />
                        <ui.Button onClick={() => { setRDraft(null); setErrors([]) }}>{t('common.cancel')}</ui.Button>
                        <ui.Button variant="primary" icon="save" loading={busy} disabled={busy} onClick={() => { void saveRule() }}>{t('conn.save')}</ui.Button>
                      </div>
                    </div>
                  </ui.Card>
                ) : null}

                <ui.Card title={t('conn.runsTitle')} icon="refresh" subtitle={t('conn.runsSubtitle')} flush>
                  <ui.DataTable caption={t('conn.runsTitle')} columns={runColumns} rows={data.runs} rowKey={(r) => String(r.id)} empty={<ui.Empty title={t('conn.runsEmpty')} />} />
                </ui.Card>
              </>
            )}
    </div>
  )
}
