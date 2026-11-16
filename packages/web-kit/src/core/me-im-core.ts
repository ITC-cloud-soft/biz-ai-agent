// The employee's OWN IM connections, through the business system's Bridge v1 `me` endpoints (same origin, the employee's
// session): my links (list / unlink), link codes, notification preferences; and the personal WeChat QR connection through
// the business web BFF. Rule: own connections only — the server enforces it; this client never names another employee.
// No imports from React: testable with node --test.

/** The platforms the legacy WeChat-only BFF endpoints (weixinBase) unlink. */
const WEIXIN_PLATFORMS: readonly string[] = ['weixin', 'wechat']

export interface Identity {
  id: string
  platform: string
  teamId: string | null
  externalId: string
  botId: string | null
  method: string | null
  verifiedAt: string | null
  createdAt: string | null
}

type Raw = Record<string, unknown>
const isRec = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** One identity row: the v1 shape (camelCase) or an older snake_case API. */
export function normIdentity(r: unknown): Identity | null {
  if (!isRec(r) || typeof r.id !== 'string' || typeof r.platform !== 'string') return null
  return {
    id: r.id,
    platform: r.platform,
    teamId: str(r.teamId) ?? str(r.team_id),
    externalId: str(r.externalId) ?? str(r.external_id) ?? '',
    botId: str(r.botId) ?? str(r.bot_id),
    method: str(r.method),
    verifiedAt: str(r.verifiedAt) ?? str(r.verified_at),
    createdAt: str(r.createdAt) ?? str(r.created_at),
  }
}

/** A failed call: HTTP status + the server's lower_snake_case code (or 'network'). */
export class MeImError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = 'MeImError'
    this.status = status
    this.code = code
  }
}

/** The server does not offer this yet (404 / 405 / 501 / 503): screens show 「準備中」 instead of an error. */
export const isUnavailable = (e: unknown): boolean => e instanceof MeImError && [404, 405, 501, 503].includes(e.status)

/** `{ unavailable, data }`: unavailable = the endpoint is not offered (see isUnavailable). */
export interface Maybe<T> { unavailable: boolean; data: T | null }
export async function maybe<T>(p: Promise<T>): Promise<Maybe<T>> {
  try { return { unavailable: false, data: await p } } catch (e) {
    if (isUnavailable(e)) return { unavailable: true, data: null }
    throw e
  }
}

export type MeFetch = (input: string, init: { method: string; credentials: 'same-origin'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

export interface LinkCode { code: string; expiresAt: number }

/** The personal WeChat provisioning state (the fork's normalizeProvisioning result). */
export type ProvisionStatus = 'starting' | 'pending' | 'scanned' | 'needs_verification' | 'connecting' | 'connected' | 'expired' | 'failed' | 'cancelled'
export interface Provision {
  attemptId: string; status: ProvisionStatus; expiresAt: number; pollIntervalMs: number; verificationRequired: boolean
  qrCodeDataUrl?: string; verificationUrl?: string; botId?: string; alreadyConnected?: boolean
  error?: { code: string; message: string; details?: unknown }
}

export interface MeImClientOptions {
  /** Base of the business system's Bridge v1 endpoints as the browser sees them (default /bridge/v1). */
  base?: string
  /** Base of the BFF's personal WeChat endpoints (begin / poll / verify / cancel / identities/{id}); null: no WeChat QR. */
  weixinBase?: string | null
  /**
   * Base of the BFF that unlinks EVERY identity (`DELETE {unlinkBase}/identities/{id}`: it also deletes the employee's own
   * personal bot the link came through, on any channel; care-ai-native: /api/me/im). null (default): personal WeChat links
   * through weixinBase, the others through the Bridge v1 endpoint.
   */
  unlinkBase?: string | null
  fetch?: MeFetch
  headers?: Record<string, string>
}

export interface MeImClient {
  listMyIdentities(): Promise<Maybe<Identity[]>>
  issueLinkCode(): Promise<LinkCode>
  removeMyIdentity(identity: Identity): Promise<void>
  getNotifyPreferences(): Promise<Maybe<Raw>>
  putNotifyPreferences(body: Raw): Promise<Raw>
  weixinEnabled: boolean
  beginWeixin(): Promise<Maybe<unknown>>
  pollWeixin(attemptId: string): Promise<unknown>
  verifyWeixin(attemptId: string, verifyCode: string): Promise<unknown>
  cancelWeixin(attemptId: string): Promise<void>
  /** MY personal bots (platform + botId; Bridge v1 GET /me/personal-bots). Optional: the SNS link page then words unlinks generically. */
  listMyPersonalBots?(): Promise<Maybe<PersonalBot[]>>
}

/** One of the employee's own personal bots. */
export interface PersonalBot { platform: string; botId: string }

export function createMeImClient({ base = '/bridge/v1', weixinBase = '/api/me/im/weixin', unlinkBase = null, fetch: fetchImpl, headers = {} }: MeImClientOptions = {}): MeImClient {
  const doFetch: MeFetch = fetchImpl ?? (globalThis.fetch as unknown as MeFetch)
  async function call(method: string, url: string, body?: unknown): Promise<Raw> {
    let res
    try {
      res = await doFetch(url, {
        method,
        credentials: 'same-origin',
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new MeImError(0, 'network')
    }
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw new MeImError(res.status, isRec(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`, isRec(json) && typeof json.message === 'string' ? json.message : undefined)
    return isRec(json) ? json : {}
  }
  const wx = (path: string) => {
    if (!weixinBase) throw new MeImError(404, 'weixin_not_configured')
    return `${weixinBase}/${path}`
  }
  const provision = (r: Raw) => r.provision

  return {
    listMyIdentities: () => maybe(call('GET', `${base}/me/identities`).then((r) => (Array.isArray(r.identities) ? r.identities : []).map(normIdentity).filter((x): x is Identity => x !== null))),
    async issueLinkCode() {
      const r = await call('POST', `${base}/me/link-codes`)
      if (typeof r.code !== 'string') throw new MeImError(502, 'invalid_response')
      return { code: r.code, expiresAt: new Date(r.expiresAt as string).getTime() }
    },
    /** Through the BFF (unlinkBase: every link; else personal WeChat only), which also retires the employee's own bot. */
    async removeMyIdentity(i) {
      const id = encodeURIComponent(i.id)
      if (unlinkBase) { await call('DELETE', `${unlinkBase}/identities/${id}`); return }
      await call('DELETE', weixinBase && WEIXIN_PLATFORMS.includes(i.platform) ? wx(`identities/${id}`) : `${base}/me/identities/${id}`)
    },
    listMyPersonalBots: () => maybe(call('GET', `${base}/me/personal-bots`).then((r) => (Array.isArray(r.bots) ? r.bots : [])
      .filter((b): b is Raw => isRec(b) && typeof b.platform === 'string' && typeof b.botId === 'string')
      .map((b) => ({ platform: b.platform as string, botId: b.botId as string })))),
    getNotifyPreferences: () => maybe(call('GET', `${base}/me/notification-preferences`)),
    putNotifyPreferences: (body) => call('PUT', `${base}/me/notification-preferences`, body),
    weixinEnabled: Boolean(weixinBase),
    beginWeixin: () => maybe((async () => provision(await call('POST', wx('begin'), {})))()),
    pollWeixin: async (attemptId) => provision(await call('POST', wx('poll'), { attemptId })),
    verifyWeixin: async (attemptId, verifyCode) => provision(await call('POST', wx('verify'), { attemptId, verifyCode })),
    cancelWeixin: async (attemptId) => { await call('POST', wx('cancel'), { attemptId }) },
  }
}

/** New identities in `next` that `known` did not have (the page watches for the link to arrive while a code is shown). */
export const addedIdentities = (known: ReadonlySet<string>, next: readonly Identity[]): Identity[] => next.filter((i) => !known.has(i.id))
