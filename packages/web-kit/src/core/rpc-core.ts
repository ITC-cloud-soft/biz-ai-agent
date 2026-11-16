// dsh-im management RPC client (envelope, response check, Japanese error messages). No imports: testable with node --test.
// Contract: vendor/dsh-im/plugin-src/management-rpc.mjs (registerManagementRpc / callManagementRpc).

export interface RpcErrorInfo { code: string; message: string; details?: Record<string, unknown> }
export type RpcResult = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; error: RpcErrorInfo }

export interface RpcEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { method: string; payload: unknown }
}

/** `/slack` -> `dsh-im/slack` (the same check as management-rpc.mjs rpcEndpoint). */
export function rpcEndpoint(channel: string): string {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError('Invalid IM RPC channel')
  return `dsh-im${channel}`
}

export function newRpcId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function buildEnvelope(channel: string, method: string, payload: unknown, rpcId: string = newRpcId()): RpcEnvelope {
  return { type: 'client-request', rpcId, method: rpcEndpoint(channel), payload: { method, payload } }
}

/** The RPC did not reach the management API (same code / details shape as DSH's callManagementRpc). */
export class ImRpcError extends Error {
  code: string
  status: number
  details: Record<string, unknown>
  constructor(code: string, message: string, status = 0, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ImRpcError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Error code -> Japanese. DSH may answer in Chinese, so the text is looked up from the code. */
export const IM_ERROR_JA: Readonly<Record<string, string>> = Object.freeze({
  'gateway-not-configured': 'AI・SNS 連携ゲートウェイ（DSH）が設定されていません。管理者が DSH の接続を設定すると、ここから設定できます。',
  'dsh-unavailable': '連携基盤（DSH）が応答しませんでした。起動しているかを確認して、もう一度お試しください。',
  'forbidden': 'この操作は管理者のみ行えます。管理者アカウントでログインしてください。',
  'unauthorized': 'ログインの有効期限が切れました。もう一度ログインしてください。',
  'not-found': 'このチャネルの管理機能は、連携基盤側でまだ提供されていません（準備中）。',
  'management-unreachable': '連携基盤の管理 API に接続できませんでした。DSH が起動しているか、ログインし直して再度お試しください。',
  'network': 'ネットワークに接続できません。通信環境をご確認ください。',
  'gateway/bad-request': 'リクエストの形式が正しくありません。',
  'bad-request': '入力内容が正しくありません。',
  'invalid-token': 'トークンが正しくありません。値を確認してください。',
  'invalid-bot-token': 'Bot Token が正しくありません（xoxb- で始まる値）。',
  'invalid-app-token': 'App Token が正しくありません（xapp- で始まる値）。',
  'invalid-credentials': '認証情報が正しくありません。値を確認してください。',
  'missing-scope': '必要なスコープが足りません。手順どおりに権限を付与して、アプリをインストールし直してください。',
  'socket-mode-unavailable': 'Slack の Socket Mode に接続できません。App Token（connections:write）と Socket Mode の設定を確認してください。',
  'slack-operation-failed': 'Slack の操作に失敗しました。しばらくしてからもう一度お試しください。',
  'line-network-error': 'LINE に接続できませんでした。しばらくしてからもう一度お試しください。',
  'teams-network-error': 'Teams（Bot Framework）に接続できませんでした。しばらくしてからもう一度お試しください。',
  'telegram-network-error': 'Telegram に接続できませんでした。しばらくしてからもう一度お試しください。',
  'identity-mismatch': 'この認証情報は、すでに接続されているボットと一致しません。',
  'webhook-configured': 'Webhook は設定済みです。',
  'cancelled': '操作を取り消しました。',
  'test-target-unavailable': 'テスト送信できる相手がまだいません。ボットに 1 度メッセージを送ってから、もう一度お試しください。',
  'WEIXIN_PROVISION_FAILED': 'WeChat の接続を完了できませんでした。もう一度お試しください。',
  'WEIXIN_PROVISION_EXPIRED': 'QR コードの有効期限が切れました。新しい QR コードを作成してください。',
  // the business web BFF's personal RPC (IM_PERSONAL_BOTS §3 of care-ai-native; any host with the same contract)
  'bot-exists': 'このアカウントのボットは、既に接続されています（既存のボットは変更していません）。自分のボットを作るときは、別のアカウント（トークン）を使ってください。',
  'bot-registration-failed': '接続したボットを、あなたの個人ボットとして登録できませんでした。ボットは削除しました。しばらくしてから、もう一度お試しください。',
  'bot-owned-by-other': 'このボットは、別の職員の個人ボットとして登録されています。',
  'bot-registration-ambiguous': '同時に別のボットが作られたため、あなたのボットを特定できませんでした。管理者に連絡してください。',
  'homeserver-not-allowed': 'この homeserver には接続できません。https で、インターネットに公開されているアドレスの homeserver を指定してください。',
  'too-many-requests': '操作の回数が多すぎます。しばらくしてから、もう一度お試しください。',
  'personal-forbidden': 'この操作はできません。ここで操作できるのは、あなた自身のボットだけです。',
  'personal-unavailable': '個人ボットの接続は、現在利用できません（サーバ側の設定が必要です）。管理者に連絡してください。',
})

/**
 * code -> message. `overrides` win over IM_ERROR_JA. An unknown code: the fallback when it is Japanese (contains kana —
 * text in kanji only may be Chinese), otherwise a generic message with the code.
 */
export function imErrorMessage(code: string | undefined, fallback?: string, overrides: Readonly<Record<string, string>> = {}): string {
  if (code && overrides[code]) return overrides[code]
  if (code && IM_ERROR_JA[code]) return IM_ERROR_JA[code]
  const tail = code ? `（コード：${code}）` : ''
  const hasJa = Boolean(fallback) && /[぀-ヿ]/.test(fallback as string)
  return hasJa ? (fallback as string) : `処理に失敗しました。${tail}`
}

function jsonOr<T>(text: string, fallback: T): T {
  try { return text ? (JSON.parse(text) as T) : fallback } catch { return fallback }
}

/** HTTP status of the gateway -> ImRpcError (gateway / DSH / permission states are kept apart). */
export function httpErrorFor(status: number, body: { error?: string } | null): ImRpcError {
  const code = body?.error ?? ''
  const err = (c: string) => new ImRpcError(c, imErrorMessage(c), status, { httpStatus: status })
  if (status === 503 && code === 'dsh_gateway_not_configured') return err('gateway-not-configured')
  if (status === 502 || status === 504 || code === 'dsh_unavailable') return err('dsh-unavailable')
  if (status === 401) return err('unauthorized')
  if (status === 403) return err('forbidden')
  if (status === 404) return err('not-found')
  if (status === 422 && code === 'homeserver_not_allowed') return err('homeserver-not-allowed')
  if (status === 429) return err('too-many-requests')
  if (status === 503 && code === 'bff_secret_not_configured') return err('personal-unavailable')
  return err('management-unreachable')
}

export type FetchLike = (input: string, init: { method: string; credentials: 'same-origin'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

/** One RPC call. Success: the server-response result as is (`{ ok:true, ... }` or `{ ok:false, error }`). */
export async function callRpc(base: string, channel: string, method: string, payload: unknown, signal?: AbortSignal, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<RpcResult> {
  const env = buildEnvelope(channel, method, payload)
  let res
  try {
    res = await fetchImpl(`${base}${channel}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal })
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error
    throw new ImRpcError('network', imErrorMessage('network'), 0, { operation: method, stage: 'management.request' })
  }
  const text = await res.text()
  if (!res.ok) throw httpErrorFor(res.status, jsonOr<{ error?: string } | null>(text, null))
  const body = jsonOr<{ type?: string; rpcId?: string; result?: RpcResult } | null>(text, null)
  if (!body || body.type !== 'server-response' || body.rpcId !== env.rpcId || !body.result || typeof body.result !== 'object') {
    throw new ImRpcError('management-unreachable', imErrorMessage('management-unreachable'), res.status, { operation: method, stage: 'management.response' })
  }
  return body.result
}

/** The administrator's RPC base on the same origin (the BFF's DSH gateway: @dsh-bridge/gateway). */
export const ADMIN_RPC_BASE = '/dsh/api/dsh-im'
export type AdminRpc = (channel: string, method: string, payload?: unknown, signal?: AbortSignal) => Promise<RpcResult>
export const createAdminRpc = (base: string = ADMIN_RPC_BASE, fetchImpl?: FetchLike): AdminRpc =>
  (channel, method, payload = {}, signal) => callRpc(base, channel, method, payload, signal, fetchImpl)

/**
 * The employee's own RPC on the same origin (the business web BFF's POST /api/me/im/rpc/<channel>): the same envelope as the
 * administrator's, but the BFF lets through only the employee's own bots and a per-channel allowlist (care-ai-native
 * IM_PERSONAL_BOTS §3). A successful create carries `personalBotCreated: { botId }` next to `value`.
 */
export const PERSONAL_RPC_BASE = '/api/me/im/rpc'
export const createPersonalRpc = (base: string = PERSONAL_RPC_BASE, fetchImpl?: FetchLike): AdminRpc => createAdminRpc(base, fetchImpl)

/** The bot a personal create produced (`result.personalBotCreated.botId`), or null. */
export function createdBotId(result: RpcResult): string | null {
  const c = result.ok ? (result as { personalBotCreated?: { botId?: unknown } }).personalBotCreated : undefined
  return c && typeof c.botId === 'string' ? c.botId : null
}

type Rec = Record<string, unknown>
const rec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A status-like value without the bots in `exclude` (bots[] filtered, totals / connected / configured recounted; the same
 * for nested snapshot / connection). The administrator's IM bot page hides the employees' personal bots with it.
 */
export function withoutBots(value: unknown, exclude: ReadonlySet<string>): unknown {
  if (!rec(value) || !exclude.size) return value
  const out: Rec = { ...value }
  for (const k of ['snapshot', 'connection']) if (rec(value[k])) out[k] = withoutBots(value[k], exclude)
  if (Array.isArray(value.bots)) {
    const bots = (value.bots as unknown[]).filter((b) => !(rec(b) && typeof b.botId === 'string' && exclude.has(b.botId)))
    const connected = bots.filter((b) => rec(b) && b.connected === true).length
    out.bots = bots
    out.totals = { configured: bots.length, connected }
    if ('connected' in value) out.connected = connected > 0
    if ('configured' in value) out.configured = bots.length > 0
  }
  return out
}

/** An RPC client whose answers never show the bots of `exclude()` (read on every call: the list may arrive later). */
export const excludingBots = (rpc: AdminRpc, exclude: () => ReadonlySet<string>): AdminRpc => async (channel, method, payload, signal) => {
  const result = await rpc(channel, method, payload, signal)
  const set = exclude()
  return result.ok && set.size ? { ...result, value: withoutBots(result.value, set) } : result
}

/** `connection.status` -> how many bots are configured / connected. */
export interface ChannelSummary { configured: number; connected: number }
export function summarizeStatus(result: RpcResult): ChannelSummary | { error: RpcErrorInfo } {
  if (!result.ok) return { error: result.error }
  const value = (result as { value?: { snapshot?: { bots?: unknown[] }; bots?: unknown[] } }).value
  const bots = (value?.snapshot?.bots ?? value?.bots ?? []) as { connected?: boolean }[]
  return { configured: bots.length, connected: bots.filter((b) => b && b.connected === true).length }
}

/** The status of one channel row on the IM bot page. */
export type ChannelStatus = { kind: 'ok'; configured: number; connected: number } | { kind: 'pending' } | { kind: 'error'; message: string; code: string }

/** Probes one channel with `connection.status` (not-found = the channel's management RPC is not provided yet). */
export async function probeChannel(rpc: AdminRpc, rpcChannel: string): Promise<ChannelStatus> {
  try {
    const r = summarizeStatus(await rpc(rpcChannel, 'connection.status', {}))
    if ('error' in r) return { kind: 'error', code: r.error.code, message: imErrorMessage(r.error.code, r.error.message) }
    return { kind: 'ok', ...r }
  } catch (e) {
    const err = e as ImRpcError
    if (err.code === 'not-found') return { kind: 'pending' }
    return { kind: 'error', code: err.code ?? 'error', message: err.message }
  }
}

const INFRA_CODES: readonly string[] = ['gateway-not-configured', 'dsh-unavailable', 'forbidden', 'unauthorized', 'network', 'management-unreachable']

/** Every channel failed for the same infrastructure reason: show one notice instead of one error per channel. */
export function infraFailure(statuses: Readonly<Record<string, ChannelStatus>> | null | undefined): Extract<ChannelStatus, { kind: 'error' }> | null {
  const list = Object.values(statuses ?? {})
  if (!list.length || !list.every((x) => x.kind === 'error' && INFRA_CODES.includes(x.code))) return null
  return list[0] as Extract<ChannelStatus, { kind: 'error' }>
}

/** The label of a channel status pill: tone + text key + vars (+ dot: false for 「準備中」, a state rather than a status). */
export function statusPill(st: ChannelStatus | undefined): { tone: 'neutral' | 'success' | 'warning' | 'danger'; key: 'status.checking' | 'status.pending' | 'status.error' | 'status.none' | 'status.connected'; vars?: Record<string, number>; dot?: boolean } {
  if (!st) return { tone: 'neutral', key: 'status.checking' }
  if (st.kind === 'pending') return { tone: 'neutral', key: 'status.pending', dot: false }
  if (st.kind === 'error') return { tone: 'danger', key: 'status.error' }
  if (st.configured === 0) return { tone: 'neutral', key: 'status.none' }
  return { tone: st.connected === st.configured ? 'success' : 'warning', key: 'status.connected', vars: { connected: st.connected, configured: st.configured } }
}
