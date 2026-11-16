// External connectors of the AI employee (docs/AI_EMPLOYEE_PROFILE.md §3) for the administrator's page: the client of the business
// system's `/bridge/v1/admin/connectors*`, `/connector-rules*`, `/connector-runs`, `/connector-settings` (same origin, the
// administrator's own session; another base, e.g. an existing API's /api/admin), the drafts, the templates, the error texts.
// The secret is sent once and never read back (the server answers with the hint = the last 4 characters). No imports from React.

export const CONNECTOR_AUTH_TYPES = Object.freeze(['none', 'api_key', 'bearer', 'basic', 'oauth2_client'] as const)
export type ConnectorAuthType = typeof CONNECTOR_AUTH_TYPES[number]
export const CONNECTOR_PII = Object.freeze(['none', 'personal', 'financial', 'sensitive', 'health'] as const)
export const RULE_MODES = Object.freeze(['approval', 'auto', 'propose-by-ai'] as const)
export type RuleMode = typeof RULE_MODES[number]
/** The secret fields of an auth type (server-kit SECRET_FIELDS). */
export const SECRET_FIELDS: Readonly<Record<ConnectorAuthType, readonly string[]>> = Object.freeze({
  none: [], api_key: ['token'], bearer: ['token'], basic: ['password'], oauth2_client: ['clientSecret'],
})

export interface ConnectorOperation {
  id: string; name: string; description?: string; method: string; path: string
  input: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[]; additionalProperties?: false }
  responseFields: string[]; pii: string; effect: 'read' | 'write'; idempotent: boolean; roles: string[]; autoRun: { allowed: boolean; reason: string | null }
}
export interface ConnectorAuth { type: ConnectorAuthType; headerName?: string; username?: string; tokenUrl?: string; clientId?: string; scope?: string | null }
export interface Connector {
  id: string; name: string; kind: 'own' | 'third_party'; description: string; baseUrl: string; allowedHosts: string[]; auth: ConnectorAuth
  timeoutMs: number; ratePerMinute: number; maxResponseBytes: number; enabled: boolean; operations: ConnectorOperation[]
}
export interface ConnectorAdmin extends Connector { hasSecret: boolean; secretHint: string | null; updatedAt: string | null; updatedBy: string | null }
export interface ConnectorState { stopped: boolean; stoppedBy: string | null; stoppedAt: string | null }
export interface ConnectorList { connectors: ConnectorAdmin[]; state: ConnectorState; events: string[]; roles: string[]; allowLocalhost: boolean }
export interface RuleCondition { field: string; op: 'eq' | 'contains' | 'gt' | 'lt' | 'exists'; value?: string | number | boolean }
export interface ConnectorRule {
  id: string; name: string; enabled: boolean; trigger: { event?: string; cron?: string }; when: { all?: RuleCondition[]; any?: RuleCondition[] } | null
  action: { connector: string; operation: string; input: Record<string, string | number | boolean> }; mode: RuleMode; approvers: { role: string } | null
  notify: { onSuccess: string; onFailure: string }; allowPii: boolean; updatedAt?: string | null; updatedBy?: string | null
}
export interface ConnectorRun {
  id: number; ruleId: string | null; connectorId: string; operationId: string; trigger: string; triggerRef: string | null; actor: string | null
  status: string; code: string | null; httpStatus: number | null; durationMs: number | null; proposalId: string | null; at: string | null
}
export interface ConnectorTestResult { ok: boolean; code: string | null; status: number | null; durationMs: number; operationId: string; fields: string[] }
export interface ConnectorFieldError { field: string; code: string }

type Raw = Record<string, unknown>
const isRec = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A failed call: HTTP status, the server's code and the field errors (invalid_connector / invalid_rule / invalid_secret: 422). */
export class ConnectorsError extends Error {
  status: number
  code: string
  errors: ConnectorFieldError[]
  details: Raw
  constructor(status: number, code: string, errors: ConnectorFieldError[] = [], details: Raw = {}) {
    super(code)
    this.name = 'ConnectorsError'
    this.status = status
    this.code = code
    this.errors = errors
    this.details = details
  }
}
/** The server does not offer external connectors (404 / 405 / 501 / 503): the page shows 「準備中」. */
export const isConnectorsUnavailable = (e: unknown): boolean => e instanceof ConnectorsError && [404, 405, 501, 503].includes(e.status)

export type ConnectorsFetch = (url: string, init: { method: string; credentials: 'same-origin'; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
export interface ConnectorsClient {
  list(): Promise<ConnectorList>
  save(connector: Connector, reason?: string): Promise<ConnectorAdmin>
  remove(id: string): Promise<void>
  setSecret(id: string, secret: Record<string, string>): Promise<{ hasSecret: boolean; secretHint: string | null }>
  clearSecret(id: string): Promise<{ hasSecret: boolean; secretHint: string | null }>
  test(id: string, body?: { operationId?: string; input?: Record<string, unknown> }): Promise<ConnectorTestResult>
  rules(): Promise<ConnectorRule[]>
  saveRule(rule: ConnectorRule, reason?: string): Promise<ConnectorRule>
  removeRule(id: string): Promise<void>
  runs(query?: { limit?: number; connectorId?: string; ruleId?: string }): Promise<ConnectorRun[]>
  setStopped(stopped: boolean, reason?: string): Promise<ConnectorState>
}

/**
 * createConnectorsClient({ base = '/bridge/v1/admin', fetch?, headers? }): the administrator's API. Paths below `base`:
 * connectors, connectors/{id}, connectors/{id}/secret, connectors/{id}/test, connector-rules, connector-rules/{id}, connector-runs, connector-settings.
 */
export function createConnectorsClient({ base = '/bridge/v1/admin', fetch: fetchImpl, headers = {} }: { base?: string; fetch?: ConnectorsFetch; headers?: Record<string, string> } = {}): ConnectorsClient {
  const doFetch: ConnectorsFetch = fetchImpl ?? (globalThis.fetch as unknown as ConnectorsFetch)
  const root = base.replace(/\/+$/, '')
  async function call(method: string, path: string, body?: unknown): Promise<Raw> {
    let res
    try {
      res = await doFetch(`${root}${path}`, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    } catch {
      throw new ConnectorsError(0, 'network')
    }
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) {
      const code = isRec(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`
      const details = isRec(json) && isRec(json.details) ? json.details : {}
      const errors = Array.isArray(details.errors) ? details.errors.filter(isRec).map((e) => ({ field: String(e.field ?? ''), code: String(e.code ?? '') })) : []
      throw new ConnectorsError(res.status, code, errors, details)
    }
    return isRec(json) ? json : {}
  }
  const enc = encodeURIComponent
  return {
    async list() {
      const j = await call('GET', '/connectors')
      const st = isRec(j.state) ? j.state : {}
      return {
        connectors: Array.isArray(j.connectors) ? (j.connectors as ConnectorAdmin[]) : [],
        state: { stopped: st.stopped === true, stoppedBy: typeof st.stoppedBy === 'string' ? st.stoppedBy : null, stoppedAt: typeof st.stoppedAt === 'string' ? st.stoppedAt : null },
        events: Array.isArray(j.events) ? j.events.map(String) : [],
        roles: Array.isArray(j.roles) ? j.roles.map(String) : [],
        allowLocalhost: j.allowLocalhost === true,
      }
    },
    async save(connector, reason) {
      const j = await call('PUT', `/connectors/${enc(connector.id)}`, { connector: toWireConnector(connector), ...(reason ? { reason } : {}) })
      return j.connector as ConnectorAdmin
    },
    async remove(id) { await call('DELETE', `/connectors/${enc(id)}`) },
    async setSecret(id, secret) {
      const j = await call('PUT', `/connectors/${enc(id)}/secret`, { secret })
      return { hasSecret: j.hasSecret === true, secretHint: typeof j.secretHint === 'string' ? j.secretHint : null }
    },
    async clearSecret(id) {
      const j = await call('DELETE', `/connectors/${enc(id)}/secret`)
      return { hasSecret: j.hasSecret === true, secretHint: typeof j.secretHint === 'string' ? j.secretHint : null }
    },
    async test(id, body = {}) {
      const j = await call('POST', `/connectors/${enc(id)}/test`, body)
      return j.result as ConnectorTestResult
    },
    async rules() { const j = await call('GET', '/connector-rules'); return Array.isArray(j.rules) ? (j.rules as ConnectorRule[]) : [] },
    async saveRule(rule, reason) {
      const { updatedAt: _a, updatedBy: _b, ...wire } = rule
      const j = await call('PUT', `/connector-rules/${enc(rule.id)}`, { rule: wire, ...(reason ? { reason } : {}) })
      return j.rule as ConnectorRule
    },
    async removeRule(id) { await call('DELETE', `/connector-rules/${enc(id)}`) },
    async runs(query = {}) {
      const q = new URLSearchParams()
      if (query.limit) q.set('limit', String(query.limit))
      if (query.connectorId) q.set('connectorId', query.connectorId)
      if (query.ruleId) q.set('ruleId', query.ruleId)
      const j = await call('GET', `/connector-runs${q.size ? `?${q}` : ''}`)
      return Array.isArray(j.runs) ? (j.runs as ConnectorRun[]) : []
    },
    async setStopped(stopped, reason) {
      const j = await call('PUT', '/connector-settings', { stopped, ...(reason ? { reason } : {}) })
      const st = isRec(j.state) ? j.state : {}
      return { stopped: st.stopped === true, stoppedBy: typeof st.stoppedBy === 'string' ? st.stoppedBy : null, stoppedAt: typeof st.stoppedAt === 'string' ? st.stoppedAt : null }
    },
  }
}

/** The connector as the server accepts it (drops the screen-only fields). */
export function toWireConnector(c: Connector): Connector {
  const { hasSecret: _h, secretHint: _s, updatedAt: _u, updatedBy: _b, ...rest } = c as ConnectorAdmin
  return rest
}

export const emptyConnector = (): Connector => ({
  id: '', name: '', kind: 'third_party', description: '', baseUrl: 'https://', allowedHosts: [], auth: { type: 'api_key', headerName: 'x-api-key' },
  timeoutMs: 10_000, ratePerMinute: 30, maxResponseBytes: 256 * 1024, enabled: true, operations: [],
})

export const emptyRule = (): ConnectorRule => ({
  id: '', name: '', enabled: true, trigger: { event: '' }, when: null, action: { connector: '', operation: '', input: {} }, mode: 'approval',
  approvers: null, notify: { onSuccess: 'info', onFailure: 'action' }, allowPii: false,
})

/** A starting point the administrator fills in (the host, the operation's path and fields depend on the product). */
export interface ConnectorTemplate { id: string; label: string; connector: Connector }

/** The first example: a billing software, one READ operation (the import status of a month). Fictional host. */
export const BILLING_SOFTWARE_TEMPLATE: ConnectorTemplate = Object.freeze({
  id: 'billing-software-read',
  label: '請求ソフト（読み取り：月の取込状況）',
  connector: {
    ...emptyConnector(),
    id: 'billing-software', name: '請求ソフト', description: '利用中の請求ソフトの API（読み取りだけ）', baseUrl: 'https://billing-software.example/api',
    operations: [{
      id: 'import-status', name: '月の取込状況', description: 'その月の実績の取込・照合の状況（件数と状態）', method: 'GET', path: '/v1/months/{month}/import-status',
      input: { type: 'object', properties: { month: { type: 'string', description: '対象月（YYYY-MM）' } }, required: ['month'], additionalProperties: false },
      responseFields: ['status', 'counts.total', 'counts.matched', 'counts.unmatched'], pii: 'none', effect: 'read', idempotent: true, roles: ['admin', 'billing'],
      autoRun: { allowed: false, reason: null },
    }],
  },
}) as ConnectorTemplate

/** Parses a JSON text field (operations / conditions / input) → { ok, value } | { ok: false }. */
export function parseJsonField<T>(text: string): { ok: true; value: T } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) as T } } catch { return { ok: false } }
}

/** The host of a base URL ('' when it is not one). */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/** A field error → text: the code's own string when the host has one, else the generic one. */
export function connectorErrorText(e: ConnectorFieldError, text: (code: string) => string | null): string {
  return `${e.field}: ${text(e.code) ?? e.code}`
}

/** One line of a rule's trigger for the list. */
export const triggerText = (r: ConnectorRule): string => (r.trigger.event ? `event ${r.trigger.event}` : r.trigger.cron ? `cron ${r.trigger.cron}` : '')
