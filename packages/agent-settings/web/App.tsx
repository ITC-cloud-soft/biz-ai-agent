// The settings app: a navigation shell and four pages (overview, models, knowledge, SNS). The SNS page shows the organisation's
// IM bots with web-kit's ImBotsShell (dsh-im's own settings components, the same screen as DSH and the framework's business webs).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  createAdminRpc, createMeImClient, ImBotsShell, LinkCodeBox, probeChannel, SnsLinkPage, useLinkCode, WebKitProvider, type ChannelStatus,
} from '@dsh-bridge/web-kit'
import { SNS_PAGE_STRINGS } from './i18n-sns.ts'
import { Icon } from './icons.tsx'
import { LANGS, translator, WEBKIT_STRINGS, CHANNEL_LABELS, type Key, type Lang } from './i18n.ts'
import { channelsFor, runtimeFor } from './im.ts'

export interface AppConfig {
  lang: Lang
  roles: string[]
  system: { name: string }
  user: { id: string; role: string }
  gateway: { rpcBase: string } | null
  /** 'admin' (default): the settings; 'me': the employee's own SNS link page (/me/sns) */
  mode?: 'admin' | 'me'
  isAdmin?: boolean
  notifyTypes?: { id: string; label: string; help?: string; roles?: string[] }[]
}
type T = ReturnType<typeof translator>
type Page = 'overview' | 'models' | 'knowledge' | 'sns'
const PAGES: { id: Page; icon: string; key: Key }[] = [
  { id: 'overview', icon: 'gauge', key: 'navOverview' }, { id: 'models', icon: 'cpu', key: 'navModels' },
  { id: 'knowledge', icon: 'book', key: 'navKnowledge' }, { id: 'sns', icon: 'chat', key: 'navSns' },
]

/* ---------------------------------------------------------------- data */
class ApiError extends Error { constructor(public code: string, public status: number) { super(code) } }
async function api<R = any>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) throw new ApiError(data?.error ?? `http_${res.status}`, res.status)
  return data as R
}
interface Settings {
  llm: { base: ModelCfg; embedding: ModelCfg & { enabled: boolean; dimensions: number | null } }
  knowledge: { mode: 'bm25f' | 'rag' | 'graph'; vectorStore: 'file' | 'pgvector' }
  sns: { requireApproval: boolean; approverRoles: string[]; reportRoles: string[]; reportOn: { rebuilt: boolean; failures: boolean } }
  keyStorage: boolean
  vectorDb: { available: boolean; source: string | null }
}
interface ModelCfg { kind: 'openai' | 'azure-openai'; baseUrl: string; model: string; apiKeyEnv: string; key: { set: boolean; source: string | null; hint: string | null } }
interface Status { state: string; service?: string; mode?: string; documents?: number; chunks?: number; rejected?: number; failed?: string[]; at?: string; stats?: Record<string, unknown> }
interface Doc { id: string; title: string; roles: string[]; status: string; uploadedAt: string; link: string | null; canDecide: boolean; kinds?: string[] }

/* ---------------------------------------------------------------- small parts */
function Toasts({ items }: { items: { id: number; text: string; tone: 'ok' | 'bad' }[] }) {
  return <div className="as-toasts" aria-live="polite">{items.map((x) => <div key={x.id} className={`as-toast as-toast--${x.tone}`}><Icon name={x.tone === 'ok' ? 'check' : 'alert'} size={16} />{x.text}</div>)}</div>
}
function Section({ icon, title, desc, actions, children, flush }: { icon?: string; title: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; flush?: boolean }) {
  return (
    <section className={`as-card${flush ? ' as-card--flush' : ''}`}>
      <header className="as-card__head">
        {icon ? <span className="as-card__icon"><Icon name={icon} /></span> : null}
        <div className="as-card__titles"><h2>{title}</h2>{desc ? <p>{desc}</p> : null}</div>
        {actions ? <div className="as-card__actions">{actions}</div> : null}
      </header>
      {children !== undefined ? <div className="as-card__body">{children}</div> : null}
    </section>
  )
}
function Btn({ kind = 'secondary', busy, icon, children, ...rest }: { kind?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean; icon?: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`as-btn as-btn--${kind}`} disabled={busy || rest.disabled} {...rest}>{busy ? <span className="as-spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}<span>{children}</span></button>
}
function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`as-pill as-pill--${tone}`}>{children}</span>
}
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="as-field"><span className="as-field__label">{label}</span>{children}{hint ? <span className="as-field__hint">{hint}</span> : null}</label>
}
function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: string; disabled?: boolean }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="as-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} className="as-seg__item" onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  )
}
function RoleChips({ roles, value, onChange, label }: { roles: string[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="as-chips" role="group" aria-label={label}>
      {roles.map((r) => {
        const on = value.includes(r)
        return <button key={r} type="button" className="as-chip" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== r) : [...value, r])}>{on ? <Icon name="check" size={14} /> : null}{r}</button>
      })}
    </div>
  )
}
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="as-toggle">
      <span className="as-toggle__text"><span className="as-toggle__label">{label}</span>{hint ? <span className="as-toggle__hint">{hint}</span> : null}</span>
      <span className="as-switch"><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span className="as-switch__track" /></span>
    </label>
  )
}
/** The running search, in words: lexical → BM25F, hybrid → BM25F + vectors, lexical+graph → BM25F + knowledge graph. */
const serviceLabel = (t: T, service?: string) => (service ? ['BM25F', ...(service.includes('hybrid') ? [t('svcVectors')] : []), ...(service.includes('graph') ? [t('svcGraph')] : [])].join(' + ') : '—')
const fmtTime = (iso: string | undefined, lang: Lang) => (iso ? new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-US' : 'ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

/* ---------------------------------------------------------------- pages */
function Overview({ t, lang, settings, status, docs, sns, baseDocs, myLinks, go }: { t: T; lang: Lang; settings: Settings; status: Status; docs: Doc[]; sns: { connected: number; reachable: boolean } | null; baseDocs: number; myLinks: number; go: (p: Page) => void }) {
  const published = docs.filter((d) => d.status === 'published').length
  const pending = docs.filter((d) => d.status === 'pending').length
  const methodLabel = { bm25f: t('mBm25f'), rag: t('mRag'), graph: t('mGraph') }[settings.knowledge.mode]
  const tiles = [
    { icon: 'search', label: t('ovMethod'), value: methodLabel, sub: settings.knowledge.mode === 'rag' ? (settings.knowledge.vectorStore === 'pgvector' ? t('vstorePg') : t('vstoreFile')) : settings.knowledge.mode === 'graph' ? serviceLabel(t, status.service) : t('mBm25fTag'), page: 'knowledge' as Page },
    { icon: 'file', label: t('ovDocs'), value: String(status.documents ?? 0), sub: t('ovDocsSub', { published, pending }), page: 'knowledge' as Page },
    { icon: 'database', label: t('ovIndex'), value: String(status.chunks ?? 0), sub: t('ovIndexSub', { chunks: status.chunks ?? 0, at: fmtTime(status.at, lang) }), page: 'knowledge' as Page },
    { icon: 'chat', label: t('ovSns'), value: sns?.reachable ? String(sns.connected) : '—', sub: sns?.reachable ? t('ovSnsSub', { connected: sns.connected }) : t('ovSnsNone'), page: 'sns' as Page },
  ]
  const steps: { key: Key; hint: string; done: boolean; optional?: boolean; page: Page }[] = [
    { key: 'stepBase', hint: t('stepBaseHint'), done: Boolean(settings.llm.base.baseUrl && settings.llm.base.model && settings.llm.base.key.set), optional: settings.knowledge.mode !== 'graph', page: 'models' },
    { key: 'stepEmb', hint: t('stepEmbHint'), done: Boolean(settings.llm.embedding.enabled && settings.llm.embedding.key.set), optional: settings.knowledge.mode !== 'rag', page: 'models' },
    { key: 'stepDocs', hint: t('stepDocsHint', { base: baseDocs, uploaded: docs.filter((d) => d.status === 'published').length }), done: (status.documents ?? 0) > 0, page: 'knowledge' },
    { key: 'stepSns', hint: t('stepSnsHint'), done: Boolean(sns?.reachable && sns.connected > 0), page: 'sns' },
    { key: 'stepLink', hint: myLinks > 0 ? t('linkedCount', { count: myLinks }) : t('stepLinkHint'), done: myLinks > 0, optional: true, page: 'sns' },
  ]
  return (
    <>
      <div className="as-tiles">
        {tiles.map((x) => (
          <button key={x.label} type="button" className="as-tile" onClick={() => go(x.page)}>
            <span className="as-tile__icon"><Icon name={x.icon} /></span>
            <span className="as-tile__label">{x.label}</span>
            <span className="as-tile__value">{x.value}</span>
            <span className="as-tile__sub">{x.sub}</span>
          </button>
        ))}
      </div>
      {status.failed?.length ? <div className="as-alert as-alert--warn"><Icon name="alert" /><div><strong>{t('problems')}</strong><div className="as-mono">{status.failed.join(' · ')}</div></div></div> : null}
      <Section icon="check" title={t('ovSteps')} flush>
        <ol className="as-steps">
          {steps.map((s, i) => (
            <li key={s.key} className={`as-step${s.done ? ' as-step--done' : ''}`}>
              <span className="as-step__num">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="as-step__text"><strong>{t(s.key)}</strong><span>{s.hint}</span></span>
              <span className="as-step__state">{s.done ? <Pill tone="ok">{t('done')}</Pill> : s.optional ? <Pill>{t('optional')}</Pill> : <Pill tone="warn">{t('notYet')}</Pill>}</span>
              <Btn kind="ghost" icon="arrow" onClick={() => go(s.page)}>{t('open')}</Btn>
            </li>
          ))}
        </ol>
      </Section>
    </>
  )
}

function ModelCard({ t, which, cfg, keyStorage, onSave, notify }: { t: T; which: 'base' | 'embedding'; cfg: Settings['llm']['embedding'] | ModelCfg; keyStorage: boolean; onSave: (patch: Record<string, unknown>) => Promise<void>; notify: (text: string, tone?: 'ok' | 'bad') => void }) {
  const emb = which === 'embedding'
  const [draft, setDraft] = useState(() => ({ kind: cfg.kind, baseUrl: cfg.baseUrl, model: cfg.model, apiKeyEnv: cfg.apiKeyEnv, apiKey: '', enabled: emb ? (cfg as Settings['llm']['embedding']).enabled : true, dimensions: emb ? (cfg as Settings['llm']['embedding']).dimensions : null, source: cfg.key.source === 'stored' ? 'stored' : 'env' }))
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('')
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))
  const save = async () => {
    setBusy('save')
    try {
      const patch: Record<string, unknown> = { kind: draft.kind, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKeyEnv: draft.source === 'env' ? draft.apiKeyEnv.trim() : '' }
      if (draft.source === 'stored' && draft.apiKey) patch.apiKey = draft.apiKey
      if (emb) { patch.enabled = draft.enabled; patch.dimensions = draft.dimensions }
      await onSave(patch)
      set('apiKey', '')
      notify(t('saved'))
    } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } finally { setBusy('') }
  }
  const runTest = async () => {
    setBusy('test'); setTest(null)
    try {
      const { result } = await api<{ result: { ok: boolean; ms: number; error?: string } }>('POST', '/api/agent/settings/test', { target: which })
      setTest({ ok: result.ok, text: result.ok ? t('testOk', { ms: result.ms }) : t('testNg', { error: result.error ?? '' }) })
    } catch (e) { setTest({ ok: false, text: (e as Error).message }) } finally { setBusy('') }
  }
  const disabled = emb && !draft.enabled
  return (
    <Section icon={emb ? 'vector' : 'sparkle'} title={emb ? t('emb') : t('base')} desc={emb ? t('embDesc') : t('baseDesc')}
      actions={<Pill tone={cfg.key.set ? 'ok' : 'neutral'}><Icon name="key" size={13} />{cfg.key.set ? `${t('keySet')} · ${cfg.key.source === 'env' ? t('keyFromEnv') : t('keyFromStore')}${cfg.key.hint ? ` ${cfg.key.hint}` : ''}` : t('keyUnset')}</Pill>}>
      {emb ? <Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label={t('useEmb')} /> : null}
      <fieldset className="as-fieldset" disabled={disabled}>
        <Field label={t('provider')}><Segmented label={t('provider')} value={draft.kind} onChange={(v) => set('kind', v)} options={[{ value: 'openai', label: t('openai') }, { value: 'azure-openai', label: t('azure') }]} /></Field>
        <div className="as-grid">
          <Field label={t('baseUrl')}><input className="as-input" value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={draft.kind === 'azure-openai' ? 'https://<resource>.openai.azure.com' : 'https://api.example.com/v1'} autoComplete="off" spellCheck={false} /></Field>
          <Field label={draft.kind === 'azure-openai' ? t('modelAzure') : t('model')}><input className="as-input" value={draft.model} onChange={(e) => set('model', e.target.value)} autoComplete="off" spellCheck={false} /></Field>
          {emb ? <Field label={t('dims')}><input className="as-input" type="number" min={1} max={8192} value={draft.dimensions ?? ''} onChange={(e) => set('dimensions', e.target.value ? Number(e.target.value) : null)} /></Field> : null}
        </div>
        <Field label={t('keySource')} hint={keyStorage ? undefined : t('keyNoStorage')}>
          <Segmented label={t('keySource')} value={draft.source as 'env' | 'stored'} onChange={(v) => set('source', v)} options={[{ value: 'env', label: t('keyEnv') }, { value: 'stored', label: t('keyStored'), disabled: !keyStorage }]} />
        </Field>
        {draft.source === 'env'
          ? <input className="as-input as-mono" aria-label={t('keyEnv')} value={draft.apiKeyEnv} onChange={(e) => set('apiKeyEnv', e.target.value.toUpperCase())} placeholder={t('keyEnvPh')} autoComplete="off" spellCheck={false} />
          : <input className="as-input" type="password" aria-label={t('keyStored')} value={draft.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder={t('keyStoredPh')} autoComplete="new-password" />}
      </fieldset>
      <div className="as-actions">
        {test ? <span className={`as-test as-test--${test.ok ? 'ok' : 'bad'}`}><Icon name={test.ok ? 'check' : 'alert'} size={15} />{test.text}</span> : <span />}
        <div className="as-actions__buttons">
          <Btn icon="plug" busy={busy === 'test'} onClick={runTest} disabled={disabled}>{busy === 'test' ? t('testing') : t('test')}</Btn>
          <Btn kind="primary" busy={busy === 'save'} onClick={save}>{busy === 'save' ? t('saving') : t('save')}</Btn>
        </div>
      </div>
    </Section>
  )
}

function Models({ t, settings, saveSettings, notify }: { t: T; settings: Settings; saveSettings: (patch: unknown) => Promise<void>; notify: (text: string, tone?: 'ok' | 'bad') => void }) {
  const [yaml, setYaml] = useState<string | null>(null)
  const showYaml = async () => {
    if (yaml !== null) { setYaml(null); return }
    const res = await fetch('/api/agent/settings/dsh-overlay', { credentials: 'same-origin' })
    setYaml(await res.text())
  }
  return (
    <>
      <ModelCard t={t} which="base" cfg={settings.llm.base} keyStorage={settings.keyStorage} notify={notify} onSave={(p) => saveSettings({ llm: { base: p } })} />
      <ModelCard t={t} which="embedding" cfg={settings.llm.embedding} keyStorage={settings.keyStorage} notify={notify} onSave={(p) => saveSettings({ llm: { embedding: p } })} />
      <Section icon="chat" title={t('dshTitle')} desc={t('dshDesc')} actions={<Btn kind="ghost" onClick={showYaml}>{yaml === null ? t('showYaml') : t('hideYaml')}</Btn>}>
        {yaml !== null ? (
          <div className="as-code">
            <Btn kind="ghost" icon="copy" onClick={() => { void navigator.clipboard?.writeText(yaml); notify(t('copied')) }}>{t('copy')}</Btn>
            <pre>{yaml}</pre>
          </div>
        ) : undefined}
      </Section>
    </>
  )
}

function Knowledge({ t, lang, cfg, settings, status, docs, saveSettings, reload, notify }: {
  t: T; lang: Lang; cfg: AppConfig; settings: Settings; status: Status; docs: Doc[]; saveSettings: (patch: unknown) => Promise<void>; reload: () => Promise<void>; notify: (text: string, tone?: 'ok' | 'bad') => void
}) {
  const [mode, setMode] = useState(settings.knowledge.mode)
  const [store, setStore] = useState(settings.knowledge.vectorStore)
  const [busy, setBusy] = useState<'' | 'apply' | 'rebuild' | 'upload'>('')
  const changed = mode !== settings.knowledge.mode || store !== settings.knowledge.vectorStore
  const methods = [
    { id: 'bm25f' as const, icon: 'search', title: t('mBm25f'), desc: t('mBm25fDesc'), tag: t('mBm25fTag') },
    { id: 'rag' as const, icon: 'vector', title: t('mRag'), desc: t('mRagDesc'), tag: t('mRagTag') },
    { id: 'graph' as const, icon: 'graph', title: t('mGraph'), desc: t('mGraphDesc'), tag: t('mGraphTag') },
  ]
  const apply = async () => {
    setBusy('apply')
    try { await saveSettings({ knowledge: { mode, ...(mode === 'rag' ? { vectorStore: store } : {}) } }); notify(t('saved')) } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } finally { setBusy('') }
  }
  const rebuild = async () => {
    setBusy('rebuild')
    try { await api('POST', '/api/agent/knowledge/rebuild'); await reload(); notify(t('saved')) } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } finally { setBusy('') }
  }
  // upload
  const [title, setTitle] = useState('')
  const [keywords, setKeywords] = useState('')
  const [readers, setReaders] = useState<string[]>(cfg.roles)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const takeFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 200_000) { notify(`${t('failed')}: > 200 KB`, 'bad'); return }
    setText(await f.text()); setFileName(f.name)
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''))
  }
  const upload = async () => {
    setBusy('upload')
    try {
      const { document: d } = await api<{ document: Doc }>('POST', '/api/agent/documents', { title: title.trim(), roles: readers, keywords: keywords.split(/[,，、]/).map((s) => s.trim()).filter(Boolean), text })
      notify(d.status === 'personal_data' ? t('uploadedPersonal', { kinds: (d.kinds ?? []).join(', ') }) : d.status === 'published' ? t('uploadedPublished') : t('uploadedPending'), d.status === 'personal_data' ? 'bad' : 'ok')
      if (d.status !== 'personal_data') { setTitle(''); setKeywords(''); setText(''); setFileName('') }
      await reload()
    } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } finally { setBusy('') }
  }
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload() } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } }
  const statusPill = (d: Doc) => {
    const map: Record<string, ['ok' | 'warn' | 'bad' | 'neutral', Key]> = { pending: ['warn', 'stPending'], published: ['ok', 'stPublished'], rejected: ['bad', 'stRejectedDoc'], personal_data: ['bad', 'stPersonal'], withdrawn: ['neutral', 'stWithdrawn'] }
    const [tone, key] = map[d.status] ?? ['neutral', 'stWithdrawn']
    return <Pill tone={tone}>{t(key)}</Pill>
  }
  return (
    <>
      <Section icon="search" title={t('method')}>
        <div className="as-methods" role="radiogroup" aria-label={t('method')}>
          {methods.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className="as-method" onClick={() => setMode(m.id)}>
              <span className="as-method__top"><span className="as-method__icon"><Icon name={m.icon} /></span><span className="as-method__radio" aria-hidden="true" /></span>
              <span className="as-method__title">{m.title}</span>
              <span className="as-method__desc">{m.desc}</span>
              <span className="as-method__tag">{m.tag}</span>
            </button>
          ))}
        </div>
        {mode === 'rag' ? (
          <div className="as-inline">
            <span className="as-inline__label"><Icon name="database" size={16} />{t('vstore')}</span>
            <Segmented label={t('vstore')} value={store} onChange={setStore} options={[{ value: 'pgvector', label: t('vstorePg'), disabled: !settings.vectorDb.available }, { value: 'file', label: t('vstoreFile') }]} />
            {!settings.vectorDb.available ? <span className="as-muted">{t('vstoreNoDb')}</span> : null}
          </div>
        ) : null}
        {mode !== 'bm25f' ? <div className="as-alert as-alert--info"><Icon name="shield" /><div>{t('sentNote')}</div></div> : null}
        <div className="as-actions">
          <dl className="as-status">
            <div><dt>{t('stService')}</dt><dd>{serviceLabel(t, status.service)}</dd></div>
            <div><dt>{t('stDocs')}</dt><dd>{status.documents ?? 0}</dd></div>
            <div><dt>{t('stChunks')}</dt><dd>{status.chunks ?? 0}</dd></div>
            <div><dt>{t('stRejected')}</dt><dd>{status.rejected ?? 0}</dd></div>
            <div><dt>{t('stAt')}</dt><dd>{fmtTime(status.at, lang)}</dd></div>
            {status.stats ? <div className="as-status__wide"><dt>{t('stStats')}</dt><dd className="as-mono">{Object.entries(status.stats).map(([k, v]) => `${k} ${v}`).join(' · ')}</dd></div> : null}
          </dl>
          <div className="as-actions__buttons">
            <Btn icon="refresh" busy={busy === 'rebuild'} onClick={rebuild}>{busy === 'rebuild' ? t('rebuilding') : t('rebuild')}</Btn>
            <Btn kind="primary" busy={busy === 'apply'} disabled={!changed} onClick={apply}>{t('apply')}</Btn>
          </div>
        </div>
        {status.failed?.length ? <div className="as-alert as-alert--warn"><Icon name="alert" /><div><strong>{t('problems')}</strong><div className="as-mono">{status.failed.join(' · ')}</div></div></div> : null}
      </Section>

      <Section icon="upload" title={t('upload')} desc={t('uploadDesc')}>
        <div className={`as-drop${drag ? ' as-drop--over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void takeFile(e.dataTransfer.files[0]) }}>
          <span className="as-drop__icon"><Icon name={fileName ? 'file' : 'upload'} size={22} /></span>
          {fileName ? <strong>{fileName}</strong> : <span>{t('drop')} {t('or')} <button type="button" className="as-link" onClick={() => fileRef.current?.click()}>{t('choose')}</button></span>}
          <span className="as-muted">.md · .txt · ≤ 200 KB</span>
          <input ref={fileRef} type="file" hidden accept=".md,.txt,text/markdown,text/plain" onChange={(e) => void takeFile(e.target.files?.[0])} />
        </div>
        <div className="as-grid">
          <Field label={t('docTitle')}><input className="as-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label={t('keywords')}><input className="as-input" value={keywords} placeholder={t('keywordsPh')} onChange={(e) => setKeywords(e.target.value)} /></Field>
        </div>
        <Field label={t('readers')}><RoleChips roles={cfg.roles} value={readers} onChange={setReaders} label={t('readers')} /></Field>
        <details className="as-details" open={Boolean(text) && !fileName}>
          <summary>{t('pasteText')}</summary>
          <textarea className="as-input as-textarea as-mono" value={text} onChange={(e) => { setText(e.target.value); setFileName('') }} rows={8} />
        </details>
        <div className="as-actions"><span />
          <Btn kind="primary" icon="upload" busy={busy === 'upload'} disabled={!title.trim() || !text.trim() || !readers.length} onClick={upload}>{busy === 'upload' ? t('uploading') : t('submit')}</Btn>
        </div>
      </Section>

      <Section icon="file" title={t('documents')} flush>
        {docs.length === 0 ? <p className="as-empty">{t('noDocs')}</p> : (
          <div className="as-table-wrap">
            <table className="as-table">
              <thead><tr><th>{t('colTitle')}</th><th>{t('colReaders')}</th><th>{t('colStatus')}</th><th>{t('colAt')}</th><th aria-label="actions" /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td><div className="as-doc">{d.link ? <a href={d.link}>{d.title}</a> : <span>{d.title}</span>}<span className="as-mono as-muted">{d.id}</span></div></td>
                    <td><div className="as-tags">{d.roles.map((r) => <span key={r} className="as-tag">{r}</span>)}</div></td>
                    <td>{statusPill(d)}</td>
                    <td className="as-nowrap">{fmtTime(d.uploadedAt, lang)}</td>
                    <td><div className="as-row-actions">
                      {d.canDecide ? <><Btn kind="primary" onClick={() => act(() => api('POST', `/api/agent/documents/${d.id}/decision`, { action: 'approve' }))}>{t('approve')}</Btn><Btn onClick={() => act(() => api('POST', `/api/agent/documents/${d.id}/decision`, { action: 'reject' }))}>{t('reject')}</Btn></> : null}
                      {d.status === 'published' || d.status === 'pending' ? <Btn kind="danger" onClick={() => { if (window.confirm(t('confirmWithdraw'))) void act(() => api('DELETE', `/api/agent/documents/${d.id}`)) }}>{t('withdraw')}</Btn> : null}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}

function MyLink() {
  const link = useLinkCode()
  return <LinkCodeBox link={link} />
}

function Sns({ t, cfg, lang, dark, settings, saveSettings, notify }: { t: T; cfg: AppConfig; lang: Lang; dark: boolean; settings: Settings; saveSettings: (patch: unknown) => Promise<void>; notify: (text: string, tone?: 'ok' | 'bad') => void }) {
  const channels = useMemo(() => channelsFor(lang), [lang])
  const [selected, setSelected] = useState<string | null>(null)
  const [sns, setSns] = useState(settings.sns)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try { await saveSettings({ sns }); notify(t('saved')) } catch (e) { notify(`${t('failed')}: ${(e as Error).message}`, 'bad') } finally { setBusy(false) }
  }
  return (
    <>
      <Section icon="chat" title={t('bots')} desc={t('botsDesc')}>
        {cfg.gateway ? (
          <div className="as-im">
            <ImBotsShell channels={channels} selected={selected} onSelect={setSelected} dark={dark} header={null} />
          </div>
        ) : <div className="as-alert as-alert--info"><Icon name="plug" /><div><strong>{t('noGateway')}</strong><div>{t('noGatewayBody')}</div></div></div>}
      </Section>
      <Section icon="bell" title={t('approvals')} desc={t('approvalsDesc')}>
        <Toggle checked={sns.requireApproval} onChange={(v) => setSns({ ...sns, requireApproval: v })} label={t('requireApproval')} hint={t('requireApprovalHint')} />
        <div className="as-grid">
          <Field label={t('approverRoles')}><RoleChips roles={cfg.roles} value={sns.approverRoles} onChange={(v) => setSns({ ...sns, approverRoles: v })} label={t('approverRoles')} /></Field>
          <Field label={t('reportRoles')}><RoleChips roles={cfg.roles} value={sns.reportRoles} onChange={(v) => setSns({ ...sns, reportRoles: v })} label={t('reportRoles')} /></Field>
        </div>
        <Field label={t('reportOn')}>
          <div className="as-stack-sm">
            <Toggle checked={sns.reportOn.rebuilt} onChange={(v) => setSns({ ...sns, reportOn: { ...sns.reportOn, rebuilt: v } })} label={t('reportRebuilt')} />
            <Toggle checked={sns.reportOn.failures} onChange={(v) => setSns({ ...sns, reportOn: { ...sns.reportOn, failures: v } })} label={t('reportFailures')} />
          </div>
        </Field>
        <div className="as-actions"><span /><Btn kind="primary" busy={busy} disabled={!sns.approverRoles.length || !sns.reportRoles.length} onClick={save}>{t('save')}</Btn></div>
      </Section>
      <Section icon="link" title={t('myLink')} desc={t('myLinkDesc')} actions={<a className="as-btn as-btn--ghost" href="/me/sns"><Icon name="arrow" size={16} /><span>{t('allLinks')}</span></a>}><MyLink /></Section>
    </>
  )
}

/* ---------------------------------------------------------------- shell */
export function App({ cfg }: { cfg: AppConfig }) {
  const lang = cfg.lang
  const t = useMemo(() => translator(lang), [lang])
  const pageOf = (): Page => { const h = location.hash.slice(1) as Page; return PAGES.some((p) => p.id === h) ? h : 'overview' }
  const [page, setPage] = useState<Page>(pageOf)
  useEffect(() => { const f = () => setPage(pageOf()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }, [])
  const go = (p: Page) => { location.hash = p }
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const f = () => setDark(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  // the theme on <html>: the page background (and dsh-im's parts) follow it, not only the app container
  useEffect(() => {
    const root = document.documentElement
    if (dark) { root.setAttribute('data-dbw-theme', 'dark'); root.setAttribute('data-dsh-im-theme', 'dark') } else { root.removeAttribute('data-dbw-theme'); root.removeAttribute('data-dsh-im-theme') }
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  const [data, setData] = useState<{ settings: Settings; status: Status; docs: Doc[]; myLinks: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const [s, d, me] = await Promise.all([
        api<{ settings: Settings; knowledge: Status }>('GET', '/api/agent/settings'), api<{ documents: Doc[] }>('GET', '/api/agent/documents'),
        api<{ identities?: unknown[] }>('GET', '/bridge/v1/me/identities').catch(() => ({ identities: [] })),
      ])
      setData({ settings: s.settings, status: s.knowledge, docs: d.documents, myLinks: (me.identities ?? []).length }); setError(null)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  const saveSettings = useCallback(async (patch: unknown) => {
    const r = await api<{ settings: Settings; knowledge: Status }>('PUT', '/api/agent/settings', patch)
    setData((d) => (d ? { ...d, settings: r.settings, status: r.knowledge } : d))
  }, [])

  const [toasts, setToasts] = useState<{ id: number; text: string; tone: 'ok' | 'bad' }[]>([])
  const notify = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((x) => [...x, { id, text, tone }])
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 3600)
  }, [])

  // web-kit: the administrator's RPC through the business system's DSH gateway, the employee's own link codes, language
  const adminRpc = useMemo(() => createAdminRpc(cfg.gateway?.rpcBase), [cfg.gateway])
  const meIm = useMemo(() => createMeImClient({ base: '/bridge/v1' }), [])
  const runtime = useMemo(() => runtimeFor(lang), [lang])
  const [sns, setSns] = useState<{ connected: number; reachable: boolean } | null>(null)
  useEffect(() => {
    if (!cfg.gateway) { setSns({ connected: 0, reachable: false }); return }
    let alive = true
    void Promise.all(channelsFor(lang).map((c) => probeChannel(adminRpc, c.rpc))).then((list: ChannelStatus[]) => {
      if (!alive) return
      const ok = list.filter((s): s is Extract<ChannelStatus, { kind: 'ok' }> => s.kind === 'ok')
      setSns({ connected: ok.reduce((a, s) => a + s.connected, 0), reachable: ok.length > 0 })
    })
    return () => { alive = false }
  }, [adminRpc, cfg.gateway, lang])

  const current = PAGES.find((p) => p.id === page)!
  const headers: Record<Page, [Key, Key]> = { overview: ['ovTitle', 'ovDesc'], models: ['mdTitle', 'mdDesc'], knowledge: ['knTitle', 'knDesc'], sns: ['snTitle', 'snDesc'] }
  const setLang = (l: Lang) => { const u = new URL(location.href); u.searchParams.set('lang', l); location.href = u.toString() }

  return (
    <WebKitProvider adminRpc={adminRpc} meIm={meIm} runtime={runtime} strings={{ ...WEBKIT_STRINGS[lang], ...SNS_PAGE_STRINGS[lang] }} platformLabels={CHANNEL_LABELS[lang]}
      toast={(kind, title, detail) => notify(detail ? `${title}: ${detail}` : title, kind === 'error' ? 'bad' : 'ok')} confirm={async (o: { message?: string; title?: string }) => window.confirm(o.message ?? o.title ?? '')}>
      <div className="as-app" data-dbw-theme={dark ? 'dark' : undefined}>
        <aside className="as-side">
          <div className="as-brand">
            <span className="as-brand__mark"><Icon name="sparkle" size={20} /></span>
            <span className="as-brand__text"><strong>{t('appTitle')}</strong><span>{cfg.system.name}</span></span>
          </div>
          <nav className="as-nav" aria-label={t('appSub')}>
            {PAGES.map((p) => (
              <a key={p.id} href={`#${p.id}`} className="as-nav__item" aria-current={page === p.id ? 'page' : undefined}>
                <Icon name={p.icon} /><span>{t(p.key)}</span>
              </a>
            ))}
          </nav>
          <div className="as-side__foot">
            <div className="as-lang" role="group" aria-label="Language"><Icon name="globe" size={16} />
              {LANGS.map((l) => <button key={l.id} type="button" aria-pressed={l.id === lang} onClick={() => setLang(l.id)}>{l.label}</button>)}
            </div>
            <div className="as-user"><span className="as-user__avatar">{cfg.user.role.slice(0, 1).toUpperCase()}</span><span>{cfg.user.role}</span></div>
          </div>
        </aside>
        <main className="as-main">
          <header className="as-page-head">
            <span className="as-page-head__eyebrow">{t('appTitle')} · {t('appSub')}</span>
            <h1>{t(headers[page][0])}</h1>
            <p>{t(headers[page][1])}</p>
          </header>
          {error ? <div className="as-alert as-alert--bad"><Icon name="alert" /><div><strong>{t('failed')}</strong><div className="as-mono">{error}</div></div><Btn onClick={() => void reload()}>{t('retry')}</Btn></div> : null}
          {!data && !error ? <div className="as-loading"><span className="as-spin" />{t('loading')}</div> : null}
          {data ? (
            <div className="as-pages" key={current.id}>
              {page === 'overview' ? <Overview t={t} lang={lang} settings={data.settings} status={data.status} docs={data.docs} sns={sns} baseDocs={Math.max(0, (data.status.documents ?? 0) - data.docs.filter((d) => d.status === 'published').length)} myLinks={data.myLinks} go={go} /> : null}
              {page === 'models' ? <Models t={t} settings={data.settings} saveSettings={saveSettings} notify={notify} /> : null}
              {page === 'knowledge' ? <Knowledge t={t} lang={lang} cfg={cfg} settings={data.settings} status={data.status} docs={data.docs} saveSettings={saveSettings} reload={reload} notify={notify} /> : null}
              {page === 'sns' ? <Sns t={t} cfg={cfg} lang={lang} dark={dark} settings={data.settings} saveSettings={saveSettings} notify={notify} /> : null}
            </div>
          ) : null}
        </main>
        <Toasts items={toasts} />
      </div>
    </WebKitProvider>
  )
}

/* ---------------------------------------------------------------- the employee's own SNS link page (/me/sns) */
export function MeApp({ cfg }: { cfg: AppConfig }) {
  const lang = cfg.lang
  const t = useMemo(() => translator(lang), [lang])
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const f = () => setDark(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  useEffect(() => {
    const root = document.documentElement
    if (dark) { root.setAttribute('data-dbw-theme', 'dark'); root.setAttribute('data-dsh-im-theme', 'dark') } else { root.removeAttribute('data-dbw-theme'); root.removeAttribute('data-dsh-im-theme') }
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: 'ok' | 'bad' }[]>([])
  const notify = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((x) => [...x, { id, text, tone }])
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 3600)
  }, [])
  const meIm = useMemo(() => createMeImClient({ base: '/bridge/v1', weixinBase: null }), [])
  const setLang = (l: Lang) => { const u = new URL(location.href); u.searchParams.set('lang', l); location.href = u.toString() }
  return (
    <WebKitProvider meIm={meIm} strings={{ ...WEBKIT_STRINGS[lang], ...SNS_PAGE_STRINGS[lang] }} platformLabels={CHANNEL_LABELS[lang]}
      toast={(kind, title, detail) => notify(detail ? `${title}: ${detail}` : title, kind === 'error' ? 'bad' : 'ok')} confirm={async (o: { message?: string; title?: string }) => window.confirm(o.message ?? o.title ?? '')}>
      <div className="as-app">
        <aside className="as-side">
          <div className="as-brand">
            <span className="as-brand__mark"><Icon name="sparkle" size={20} /></span>
            <span className="as-brand__text"><strong>{t('appTitle')}</strong><span>{cfg.system.name}</span></span>
          </div>
          <nav className="as-nav" aria-label={t('meTitle')}>
            <a href="/me/sns" className="as-nav__item" aria-current="page"><Icon name="link" /><span>{t('meTitle')}</span></a>
            {cfg.isAdmin ? <a href="/agent-settings" className="as-nav__item"><Icon name="gauge" /><span>{t('appSub')}</span></a> : null}
          </nav>
          <div className="as-side__foot">
            <div className="as-lang" role="group" aria-label="Language"><Icon name="globe" size={16} />
              {LANGS.map((l) => <button key={l.id} type="button" aria-pressed={l.id === lang} onClick={() => setLang(l.id)}>{l.label}</button>)}
            </div>
            {cfg.user ? <div className="as-user"><span className="as-user__avatar">{cfg.user.role.slice(0, 1).toUpperCase()}</span><span>{cfg.user.role}</span></div> : null}
          </div>
        </aside>
        <main className="as-main">
          <header className="as-page-head">
            <span className="as-page-head__eyebrow">{t('appTitle')}</span>
            <h1>{t('meTitle')}</h1>
            <p>{t('meDesc')}</p>
          </header>
          <div className="as-me">
            <SnsLinkPage header={<></>} dark={dark} weixin={false} isAdmin={Boolean(cfg.isAdmin)} notify={{ role: cfg.user?.role, types: cfg.notifyTypes ?? [], labels: Object.fromEntries((cfg.notifyTypes ?? []).map((x) => [x.id, x.label])) }}
              imBotsLink={cfg.isAdmin ? <a href="/agent-settings#sns">{t('imBotsLink')}</a> : undefined} />
          </div>
        </main>
        <Toasts items={toasts} />
      </div>
    </WebKitProvider>
  )
}
