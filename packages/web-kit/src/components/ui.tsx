// Minimal unbranded building blocks (class names dbw-*, colours from CSS variables in styles.css). A host can restyle
// everything through the variables or its own CSS; no icon library, no router.
// A host with its own design system replaces the primitives (<WebKitProvider ui={{ Card: MyCard, … }}>) and the class
// names of the layout elements (<WebKitProvider classNames={{ steps: 'my-steps' }}>): the components render only
// through `ui.*` and `cls(key)`, so the host's pages keep their own look. Icons are semantic names (IconName) that the
// host's primitives map to its icon set; the defaults draw no icons.
import { useEffect, useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react'

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

/**
 * Semantic icon names the components ask for (the default primitives ignore them): shield (own-only notices), weixin
 * (personal WeChat card), org (org bot card), link (my links / issue a code), user (code notice), mail (email notice),
 * bell (notification card), save, qr (connect WeChat), check (connected), refresh (re-issue), hourglass (code timer),
 * moon (quiet hours), trash (unlink), bot (personal-bot notice, the AI employee's profile; refresh: its versions, check: its preview),
 * paperclip (attach files), close (remove an attached file), file (an attached document; save: the attachment settings).
 */
export type IconName = 'shield' | 'weixin' | 'org' | 'link' | 'user' | 'mail' | 'bell' | 'save' | 'qr' | 'check' | 'refresh' | 'hourglass' | 'moon' | 'trash' | 'bot' | 'paperclip' | 'close' | 'file'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface CardProps { title?: ReactNode; subtitle?: ReactNode; icon?: IconName; actions?: ReactNode; children?: ReactNode; flush?: boolean }
export function Card({ title, subtitle, actions, children, flush }: CardProps) {
  return (
    <section className={cx('dbw-card', flush && 'dbw-card--flush')}>
      {title || actions ? (
        <header className="dbw-card__head">
          <div>
            {title ? <h2 className="dbw-card__title">{title}</h2> : null}
            {subtitle ? <p className="dbw-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="dbw-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="dbw-card__body">{children}</div>
    </section>
  )
}

export interface NoticeProps { tone?: Tone; title?: string; icon?: IconName; children?: ReactNode }
export function Notice({ tone = 'neutral', title, children }: NoticeProps) {
  return (
    <div className={cx('dbw-notice', `dbw-tone--${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <strong className="dbw-notice__title">{title}</strong> : null}
      {children ? <div className="dbw-notice__body">{children}</div> : null}
    </div>
  )
}

/** `dot: false`: a label rather than a status (for a host whose pills carry a status dot). */
export interface PillProps { tone?: Tone; dot?: boolean; children?: ReactNode }
export function Pill({ tone = 'neutral', children }: PillProps) {
  return <span className={cx('dbw-pill', `dbw-tone--${tone}`)}>{children}</span>
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean; icon?: IconName }
export function Button({ variant = 'secondary', size = 'md', loading, children, className, disabled, icon, ...rest }: ButtonProps) {
  void icon
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx('dbw-button', `dbw-button--${variant}`, size === 'sm' && 'dbw-button--sm', className)}>
      {children}
    </button>
  )
}

export interface SwitchProps { id?: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; describedBy?: string }
export function Switch({ id, checked, onChange, label, disabled, describedBy }: SwitchProps) {
  return (
    <span className="dbw-switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span className="dbw-switch__track" aria-hidden="true" />
    </span>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="dbw-skeleton" aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="dbw-skeleton__row" />)}</div>
}

export interface ErrorBoxProps { title: string; error?: unknown; onRetry?: () => void; retryLabel: string }
export function ErrorBox({ title, error, onRetry, retryLabel }: ErrorBoxProps) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  return (
    <Notice tone="danger" title={title}>
      {message ? <p className="dbw-muted">{message}</p> : null}
      {onRetry ? <Button size="sm" onClick={onRetry}>{retryLabel}</Button> : null}
    </Notice>
  )
}

export interface Column<T> { key: string; header: ReactNode; render: (row: T) => ReactNode; align?: 'left' | 'right' }
export interface DataTableProps<T> { caption: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; empty?: ReactNode; loading?: boolean }
/** `loading` while there are no rows yet: a skeleton (a reload keeps the rows on screen). */
export function DataTable<T>({ caption, columns, rows, rowKey, empty, loading }: DataTableProps<T>) {
  if (loading && !rows.length) return <Skeleton rows={3} />
  if (!rows.length) return <div className="dbw-empty">{empty}</div>
  return (
    <table className="dbw-table">
      <caption className="dbw-visually-hidden">{caption}</caption>
      <thead><tr>{columns.map((c) => <th key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.header}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.render(r)}</td>)}</tr>)}</tbody>
    </table>
  )
}

/** The empty state of a list (DataTable's `empty`). */
export interface EmptyProps { icon?: IconName; title: string; description?: ReactNode }
export function Empty({ title, description }: EmptyProps) {
  return <><strong>{title}</strong><div className="dbw-muted">{description}</div></>
}

/** A feature the server does not offer yet (404 / 405 / 501 / 503). */
export interface PreparingProps { title: string; children?: ReactNode }
export function Preparing({ title, children }: PreparingProps) {
  return <Notice tone="info" title={title}>{children}</Notice>
}

export interface PageHeaderProps { title: string; description?: ReactNode }
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="dbw-page-header">
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  )
}

/** A time input (HH:MM). `error`: the message, when the card shows input errors at the field (NotifyPrefsCard invalidAt="field"). */
export interface TimeFieldProps { label: string; value: string; onChange: (v: string) => void; invalid?: boolean; error?: string | null }
export function TimeField({ label, value, onChange, invalid }: TimeFieldProps) {
  return <label className="dbw-field">{label}<input type="time" value={value} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} /></label>
}

/**
 * A text input or textarea with its label (AiProfilePage). `error`: the message under the field; `count`: the counter text
 * ('12/20'); `help`: a hint under the label.
 */
export interface TextFieldProps {
  id?: string; label: string; value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number; maxLength?: number
  placeholder?: string; help?: string; error?: string | null; count?: string; disabled?: boolean
}
export function TextField({ id, label, value, onChange, multiline, rows = 3, maxLength, placeholder, help, error, count, disabled }: TextFieldProps) {
  const common = { id, value, placeholder, disabled, maxLength, 'aria-invalid': error ? true : undefined, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }
  return (
    <label className="dbw-field dbw-field--block">
      <span className="dbw-field__label">{label}{count ? <span className="dbw-field__count">{count}</span> : null}</span>
      {help ? <span className="dbw-field__help">{help}</span> : null}
      {multiline ? <textarea rows={rows} {...common} /> : <input type="text" {...common} />}
      {error ? <span className="dbw-field__error" role="alert">{error}</span> : null}
    </label>
  )
}

/** A select with its label (AiProfilePage: the tone, the agent of the preview). */
export interface SelectFieldProps { id?: string; label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; label: string }[]; error?: string | null; disabled?: boolean }
export function SelectField({ id, label, value, onChange, options, error, disabled }: SelectFieldProps) {
  return (
    <label className="dbw-field dbw-field--block">
      <span className="dbw-field__label">{label}</span>
      <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error ? <span className="dbw-field__error" role="alert">{error}</span> : null}
    </label>
  )
}

/** An icon inside text (code timer, quiet-hours title). The default draws none. */
export function Icon({ name }: { name: IconName }): ReactNode {
  void name
  return null
}

/** The replaceable primitives (WebKitProvider `ui`: any subset; the others stay the defaults). */
export interface WebKitUi {
  Card: ComponentType<CardProps>
  Notice: ComponentType<NoticeProps>
  Pill: ComponentType<PillProps>
  Button: ComponentType<ButtonProps>
  Switch: ComponentType<SwitchProps>
  Skeleton: ComponentType<{ rows?: number }>
  ErrorBox: ComponentType<ErrorBoxProps>
  DataTable: <T>(props: DataTableProps<T>) => ReactNode
  Empty: ComponentType<EmptyProps>
  Preparing: ComponentType<PreparingProps>
  PageHeader: ComponentType<PageHeaderProps>
  TimeField: ComponentType<TimeFieldProps>
  TextField: ComponentType<TextFieldProps>
  SelectField: ComponentType<SelectFieldProps>
  Icon: (props: { name: IconName }) => ReactNode
}

export const DEFAULT_UI: Readonly<WebKitUi> = Object.freeze({ Card, Notice, Pill, Button, Switch, Skeleton, ErrorBox, DataTable, Empty, Preparing, PageHeader, TimeField, TextField, SelectField, Icon })

/**
 * The classes of the layout elements (WebKitProvider `classNames` replaces any of them; a value may hold several classes).
 * By component: pages (stack, muted), LinkCodeBox (linkRow, codeBox, codeLabel, codeValue, codeTimer), SnsLinkPage
 * (steps), WeixinConnect (weixinSteps, intro), NotifyPrefsCard (notifyGroup, prefRow, prefLabel, prefHelp, quiet,
 * quietHead, quietTitle, quietTimes, quietHint, privacy), ImBotsShell (crossLinks, imLayout, channelList, channelGroup,
 * channelRow, channelLoading, more, imPanel), ImEmbed (imEmbed: the element im-theme.css styles), AiProfilePage (formGrid, examples,
 * exampleRow, agentBlock, agentTitle, preview, previewLabel, previewText, saveBar), AssistantMarkdown (md, mdTable, mdCode),
 * AssistantAttachmentPicker (attach, attachDragging, attachBar, attachList, attachChip, attachThumb, attachKind, attachName, attachSize,
 * attachRemove, attachNote, attachErrors), AttachmentSettingsCard (checkGrid, checkItem).
 */
export const DEFAULT_CLASS_NAMES = Object.freeze({
  stack: 'dbw-stack',
  muted: 'dbw-muted',
  linkRow: 'dbw-row',
  codeBox: 'dbw-code-box',
  codeLabel: 'dbw-code-box__label',
  codeValue: 'dbw-code-box__value',
  codeTimer: 'dbw-code-box__timer',
  steps: 'dbw-steps',
  weixinSteps: 'dbw-steps',
  intro: 'dbw-muted',
  notifyGroup: 'dbw-group-label',
  prefRow: 'dbw-pref-row',
  prefLabel: 'dbw-pref-row__label',
  prefHelp: 'dbw-pref-row__help',
  quiet: 'dbw-quiet',
  quietHead: 'dbw-pref-row',
  quietTitle: 'dbw-pref-row__label',
  quietTimes: 'dbw-row',
  quietHint: 'dbw-muted',
  privacy: 'dbw-muted',
  crossLinks: 'dbw-cross-links',
  imLayout: 'dbw-im-layout',
  channelList: 'dbw-channel-list',
  channelGroup: 'dbw-group-label',
  channelRow: 'dbw-channel-row',
  channelLoading: 'dbw-channel-loading',
  more: 'dbw-more',
  imPanel: 'dbw-im-panel',
  imEmbed: 'dbw-im-embed',
  formGrid: 'dbw-form-grid',
  examples: 'dbw-stack dbw-stack--tight',
  exampleRow: 'dbw-row dbw-row--fill',
  agentBlock: 'dbw-agent-block',
  agentTitle: 'dbw-group-label',
  preview: 'dbw-stack dbw-stack--tight',
  previewLabel: 'dbw-pref-row__label',
  previewText: 'dbw-preview',
  saveBar: 'dbw-row dbw-save-bar',
  md: 'dbw-md',
  mdTable: 'dbw-md__table',
  mdCode: 'dbw-md__code',
  attach: 'dbw-attach',
  attachDragging: 'dbw-attach--dragging',
  attachBar: 'dbw-row dbw-attach__bar',
  attachList: 'dbw-attach__list',
  attachChip: 'dbw-attach__chip',
  attachThumb: 'dbw-attach__thumb',
  attachKind: 'dbw-attach__kind',
  attachName: 'dbw-attach__name',
  attachSize: 'dbw-attach__size',
  attachRemove: 'dbw-attach__remove',
  attachNote: 'dbw-muted dbw-attach__note',
  attachErrors: 'dbw-attach__errors',
  checkGrid: 'dbw-check-grid',
  checkItem: 'dbw-check',
  actions: 'dbw-row dbw-row--tight',
} as const)
export type ClassKey = keyof typeof DEFAULT_CLASS_NAMES
export type ClassNames = Partial<Record<ClassKey, string>>

/** Promise state for a loader (re-runs when deps change; reload() runs it again). */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then((data) => { if (alive) setState({ data, error: null, loading: false }) }, (error) => { if (alive) setState({ data: null, error, loading: false }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { ...state, reload: () => setTick((n) => n + 1) }
}

/** Local date-time for a timestamp (ja-JP), or the dash. */
export const dateTime = (v: string | null | undefined, dash = '—'): string => (v ? new Date(v).toLocaleString('ja-JP') : dash)
