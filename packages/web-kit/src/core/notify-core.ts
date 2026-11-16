// The employee's own notification preferences (screen logic, pure). The notification TYPES are the business system's:
// the server lists the notified event types (GET /bridge/v1/me/notification-preferences -> `types`, from the manifest),
// the host app may describe them (label, help, roles, group). No imports.

export interface NotifyTypeDef { id: string; label: string; help?: string; roles?: readonly string[]; group?: string }
export interface NotifyGroupDef { id: string; label: string }
export interface QuietHours { enabled: boolean; start: string; end: string; [extra: string]: unknown }
export interface NotifyPrefs { types: Record<string, { im: boolean }>; quietHours: QuietHours }

/** The server-kit default (quiet hours off, 22:00–07:00). */
export const DEFAULT_QUIET_HOURS: QuietHours = Object.freeze({ enabled: false, start: '22:00', end: '07:00' }) as QuietHours
export const DEFAULT_PREFS: NotifyPrefs = Object.freeze({ types: {}, quietHours: DEFAULT_QUIET_HOURS }) as NotifyPrefs

type Raw = Record<string, unknown>
const isRec = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const hhmm = (v: unknown, fallback: string): string => (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v) ? v.slice(0, 5).padStart(5, '0') : fallback)

const BASE_QUIET_KEYS: readonly string[] = ['enabled', 'start', 'end']
const snakeCase = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * The server's preferences -> NotifyPrefs. Accepts `{ preferences }`, `{ prefs }` or the object itself, camelCase or
 * snake_case quiet hours. Extra quiet-hour flags (booleans) are kept so a host can show them. A host whose server has
 * more quiet-hour flags names them in `defaultQuiet` (e.g. { ..., applyToX: false }): they are then always present,
 * read from the camelCase or snake_case key, else the default.
 */
export function normPrefs(r: unknown, { defaultQuiet = DEFAULT_QUIET_HOURS }: { defaultQuiet?: QuietHours } = {}): NotifyPrefs {
  const rec = isRec(r) ? r : {}
  const src = isRec(rec.preferences) ? rec.preferences : isRec(rec.prefs) ? rec.prefs : rec
  const types: NotifyPrefs['types'] = {}
  if (isRec(src.types)) for (const [k, v] of Object.entries(src.types)) types[k] = { im: isRec(v) ? v.im !== false : v !== false }
  const q = isRec(src.quietHours) ? src.quietHours : isRec(src.quiet_hours) ? src.quiet_hours : {}
  const hostKeys = Object.keys(defaultQuiet).filter((k) => !BASE_QUIET_KEYS.includes(k))
  const aliases = new Set(hostKeys.map(snakeCase).filter((k) => !hostKeys.includes(k)))
  const extra: Record<string, unknown> = Object.fromEntries(Object.entries(q).filter(([k, v]) => !BASE_QUIET_KEYS.includes(k) && !aliases.has(k) && typeof v === 'boolean'))
  for (const k of hostKeys) {
    const d = defaultQuiet[k]
    extra[k] = typeof q[k] === typeof d ? q[k] : typeof q[snakeCase(k)] === typeof d ? q[snakeCase(k)] : d
  }
  return {
    types,
    quietHours: { ...extra, enabled: typeof q.enabled === 'boolean' ? q.enabled : defaultQuiet.enabled, start: hhmm(q.start, defaultQuiet.start), end: hhmm(q.end, defaultQuiet.end) },
  }
}

/** The notified type ids the server lists (`types: [...]` of the GET response), or null when it lists none. */
export const serverTypeIds = (r: unknown): string[] | null => (isRec(r) && Array.isArray(r.types) ? r.types.filter((x): x is string => typeof x === 'string') : null)

/** A type without a saved setting is ON, except the default-off ones. */
export const wants = (p: NotifyPrefs, type: string, defaultOff: readonly string[] = []): boolean =>
  (typeof p.types[type]?.im === 'boolean' ? p.types[type].im : !defaultOff.includes(type))

/**
 * The rows to show: the server's ids (when given) described by the host's defs (label / help / group), in the defs' order
 * then the server's order; a type the host does not describe shows its `labels[id]` or the id. Filtered by role when the
 * def names roles.
 */
export function visibleTypes(defs: readonly NotifyTypeDef[], { serverIds = null, role, labels = {} }: { serverIds?: readonly string[] | null; role?: string; labels?: Readonly<Record<string, string>> } = {}): NotifyTypeDef[] {
  const byId = new Map(defs.map((d) => [d.id, d]))
  const ids = serverIds ? [...defs.map((d) => d.id).filter((id) => serverIds.includes(id)), ...serverIds.filter((id) => !byId.has(id))] : defs.map((d) => d.id)
  return ids
    .map((id) => byId.get(id) ?? { id, label: labels[id] ?? id })
    .filter((d) => !d.roles || (role !== undefined && d.roles.includes(role)))
}

/** Rows grouped under their headings (groups in the given order; a type without a group goes to `fallback`). */
export function groupNotifyTypes<T extends { group?: string }>(types: readonly T[], groups: readonly NotifyGroupDef[] = [], fallback = ''): { group: string; label: string; types: T[] }[] {
  const order = groups.length ? groups : [{ id: fallback, label: '' }]
  const known = new Set(order.map((g) => g.id))
  const out = order.map((g) => ({ group: g.id, label: g.label, types: types.filter((t) => (t.group && known.has(t.group) ? t.group : fallback) === g.id) }))
  return out.filter((x) => x.types.length > 0)
}

/** Start = end with quiet hours on is not a period. */
export const quietInvalid = (p: NotifyPrefs): boolean => p.quietHours.enabled && p.quietHours.start === p.quietHours.end

/**
 * The PUT body: every shown type with its effective value; quiet hours limited to the keys the server accepts
 * (server-kit: enabled / start / end; a host whose server takes more passes them).
 */
export function putBody(p: NotifyPrefs, types: readonly { id: string }[], { defaultOff = [], quietKeys = ['enabled', 'start', 'end'] }: { defaultOff?: readonly string[]; quietKeys?: readonly string[] } = {}): { types: Record<string, { im: boolean }>; quietHours: Record<string, unknown> } {
  return {
    types: Object.fromEntries(types.map((t) => [t.id, { im: wants(p, t.id, defaultOff) }])),
    quietHours: Object.fromEntries(quietKeys.filter((k) => k in p.quietHours).map((k) => [k, p.quietHours[k]])),
  }
}

export const samePrefs = (a: NotifyPrefs, b: NotifyPrefs): boolean => JSON.stringify(a) === JSON.stringify(b)
