// api-client.js — 業務システム（Bridge v1）の API クライアント。Node 組み込み fetch のみ。
//
// 1 つの業務アプリケーションにつき 1 つ作る（registry.js）。呼び出しごとに base URL / サービストークンを評価するので、
// 設定画面・環境変数の差し替えに追随する。委託トークンは呼び出しごとに渡す（キャッシュは delegation.js）。
//
// 業務システム固有の既定値（環境変数名・既定 URL）は持たない。旧来の名前は compat/care-billing-paths（createCareApi / CareApiError）。

import { randomBytes } from 'node:crypto'

export const PROTOCOL_HEADER = 'bridge-protocol'
export const PROTOCOL_VERSION = '1'
const IDEMPOTENT = new Set(['GET', 'HEAD'])
const RETRY_STATUS = new Set([502, 503, 504])
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
/** W3C traceparent for one call: the caller's (opts.traceparent, e.g. the trace of the SNS message) or a new trace. */
export function callTraceparent(given) {
  const v = String(given ?? '').trim().toLowerCase()
  if (TRACEPARENT.test(v)) return `00-${v.slice(3, 35)}-${randomBytes(8).toString('hex')}-${v.slice(-2)}`
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

/**
 * 業務 API 呼び出しの失敗。
 *  kind: 'unreachable'（到達不能・タイムアウト、status=0）| 'http'（2xx 以外）| 'invalid_body'（2xx で非 JSON）
 *        | 'protocol'（bridge-protocol ヘッダの版が違う）| 'request'（呼び出し側の誤り）
 */
export class BridgeApiError extends Error {
  constructor(message, { status = 0, code = '', body = null, kind = 'http', applicationId = null, method = '', url = '', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BridgeApiError'
    this.status = status
    this.code = code
    this.body = body
    this.kind = kind
    this.applicationId = applicationId
    this.method = method
    this.url = url
  }
}
export class BridgeUnreachableError extends BridgeApiError {
  constructor(message, options = {}) { super(message, { ...options, kind: 'unreachable', status: 0 }); this.name = 'BridgeUnreachableError' }
}
export class BridgeHttpError extends BridgeApiError {
  constructor(message, options = {}) { super(message, { ...options, kind: 'http' }); this.name = 'BridgeHttpError' }
}
export class BridgeProtocolError extends BridgeApiError {
  constructor(message, options = {}) { super(message, { kind: 'protocol', ...options }); this.name = 'BridgeProtocolError' }
}

function pick(getter, fallback) {
  try {
    const value = typeof getter === 'function' ? getter() : getter
    return value === undefined || value === null || value === '' ? fallback : value
  } catch {
    return fallback
  }
}

function readHeader(res, name) {
  try {
    const headers = res?.headers
    if (!headers) return null
    if (typeof headers.get === 'function') return headers.get(name)
    return headers[name] ?? null
  } catch {
    return null
  }
}

async function readText(res) {
  if (typeof res?.text === 'function') return { raw: await res.text(), parsedDirectly: false, value: undefined }
  if (typeof res?.json === 'function') return { raw: null, parsedDirectly: true, value: await res.json() }
  return { raw: '', parsedDirectly: false, value: undefined }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 業務 API クライアント。
 * @param {object} options
 * @param {string} [options.applicationId]  エラーに載せるアプリケーション ID
 * @param {string} [options.label]          メッセージ用の名前（既定 'business API'。registry は `<id> API` か設定の label を渡す）
 * @param {() => string|undefined} [options.baseUrl]   呼び出しごとに評価
 * @param {() => string|undefined} [options.serviceToken]
 * @param {string|(() => string)} [options.defaultBaseUrl]  baseUrl が空のときの base URL（既定 ''：未設定なら api_url_missing）
 * @param {string|(() => string)} [options.defaultServiceToken]  serviceToken が空のとき（既定 ''）
 * @param {number} [options.timeoutMs]      0 = タイムアウトなし（既定 10 秒）
 * @param {number} [options.retries]        冪等（GET/HEAD）な呼び出しを到達不能・502/503/504 で再試行する回数（既定 0）
 * @param {number} [options.retryDelayMs]
 * @param {string|null} [options.protocol]  応答の bridge-protocol ヘッダに期待する版（ヘッダが無い応答は受け入れる。null で検査しない）
 * @param {typeof fetch} [options.fetch]    既定は呼び出し時点の globalThis.fetch
 */
export function createBusinessApi(options = {}) {
  const applicationId = options.applicationId ?? null
  const label = options.label ?? 'business API'
  const timeoutMs = options.timeoutMs ?? 10_000
  const retries = Math.max(0, Number(options.retries ?? 0) || 0)
  const retryDelayMs = options.retryDelayMs ?? 200
  const protocol = options.protocol === undefined ? PROTOCOL_VERSION : options.protocol
  const fallbackBase = () => pick(options.defaultBaseUrl, '')
  const baseUrl = () => String(pick(options.baseUrl, fallbackBase())).replace(/\/+$/, '')
  const serviceToken = () => pick(options.serviceToken, pick(options.defaultServiceToken, ''))

  function buildUrl(path, query) {
    const absolute = /^https?:\/\//i.test(path)
    const base = absolute ? '' : baseUrl()
    if (!absolute && !base) {
      throw new BridgeApiError(`${label}: the API URL is not configured`, { kind: 'request', applicationId, code: 'api_url_missing' })
    }
    const url = absolute ? new URL(path) : new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    return url
  }

  /**
   * 1 回の HTTP 往復。2xx 以外・非 JSON・到達不能・版違いは BridgeApiError 系を投げる。
   * @param {string} method
   * @param {string} path   base URL からの相対（絶対 URL も可：manifestUrl）
   * @param {object} [opts]
   * @param {object} [opts.query]
   * @param {any} [opts.body]               GET 以外は JSON（未指定なら送らない。jsonBody=true で {} を送る）
   * @param {string} [opts.delegationToken] x-delegation-token
   * @param {string} [opts.traceparent]     W3C traceparent to continue (the business system logs the call in that trace)
   * @param {object} [opts.headers]
   * @param {boolean} [opts.allowEmpty]     2xx の空ボディを {} とする（既定 true。false なら invalid_body）
   * @param {boolean} [opts.raw]            { status, headers, body } を返す（304 を扱う manifest 用。2xx/304 以外は投げる）
   * @param {number} [opts.retries]         この呼び出しだけ再試行回数を変える
   * @param {AbortSignal} [opts.signal]
   */
  async function request(method, path, opts = {}) {
    const verb = String(method || 'GET').toUpperCase()
    const url = buildUrl(path, opts.query)
    const headers = { accept: 'application/json', ...(opts.headers ?? {}) }
    const token = serviceToken()
    if (token) headers['x-service-token'] = token
    if (opts.delegationToken) headers['x-delegation-token'] = String(opts.delegationToken)
    // correlation: every call carries a traceparent (care-ai-native docs/design/LOGGING_MONITORING_RSI.md §6)
    if (!headers.traceparent) headers.traceparent = callTraceparent(opts.traceparent)
    const init = { method: verb, headers }
    if (verb !== 'GET' && verb !== 'HEAD' && (opts.body !== undefined || opts.jsonBody)) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(opts.body ?? {})
    }
    const attempts = 1 + (IDEMPOTENT.has(verb) ? Math.max(0, Number(opts.retries ?? retries) || 0) : 0)
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await once(verb, url, init, opts)
      } catch (error) {
        lastError = error
        const retryable = error instanceof BridgeApiError && (error.kind === 'unreachable' || RETRY_STATUS.has(error.status))
        if (!retryable || attempt === attempts) throw error
        await sleep(retryDelayMs * attempt)
      }
    }
    throw lastError
  }

  async function once(verb, url, init, opts) {
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null
    const signals = [opts.signal, timeout].filter(Boolean)
    if (signals.length) init.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const fetchImpl = options.fetch ?? globalThis.fetch
    const where = `${url.pathname}${url.search}`
    const meta = { applicationId, method: verb, url: where }
    let res
    try {
      res = await fetchImpl(url, init)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new BridgeUnreachableError(`could not reach ${label} at ${url.origin} (${reason})`, { ...meta, cause })
    }
    const status = Number(res?.status ?? 0)
    const version = readHeader(res, PROTOCOL_HEADER)
    if (protocol && version !== null && version !== undefined && String(version).trim() !== String(protocol)) {
      throw new BridgeProtocolError(
        `${label} speaks ${PROTOCOL_HEADER} ${String(version).trim()} (expected ${protocol}) for ${verb} ${where}`,
        { ...meta, status, code: 'protocol_mismatch' },
      )
    }
    if (opts.raw && status === 304) return { status, headers: res.headers ?? null, body: null }
    let parsed = null
    let empty = false
    try {
      const read = await readText(res)
      if (read.parsedDirectly) parsed = read.value
      else if (read.raw) parsed = JSON.parse(read.raw)
      else { empty = true; parsed = null }
    } catch {
      parsed = null
    }
    const ok = typeof res?.ok === 'boolean' ? res.ok : status >= 200 && status < 300
    if (!ok) {
      const code = parsed && typeof parsed === 'object' && typeof parsed.error === 'string' ? parsed.error : ''
      throw new BridgeHttpError(
        `${label} ${verb} ${where} failed with HTTP ${status}${code ? ` (${code})` : ''}`,
        { ...meta, status, code, body: parsed },
      )
    }
    if (empty && opts.allowEmpty !== false) parsed = {}
    if (parsed === null || typeof parsed !== 'object') {
      throw new BridgeProtocolError(`${label} returned a non-JSON body for ${verb} ${where}`, { ...meta, status, kind: 'invalid_body' })
    }
    if (opts.raw) return { status, headers: res.headers ?? null, body: parsed }
    return parsed
  }

  return {
    applicationId,
    label,
    baseUrl,
    buildUrl,
    hasServiceToken: () => Boolean(serviceToken()),
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
  }
}

/** IM 発信元を業務 API の `source` 形（{platform, teamId?, userId}）へ。botId は含めない（照会・委託のキーではない）。 */
export function apiSource(source) {
  if (!source || typeof source !== 'object') return null
  const out = { platform: String(source.platform ?? ''), userId: String(source.userId ?? '') }
  if (source.teamId) out.teamId = String(source.teamId)
  return out.platform && out.userId ? out : null
}

/** キャッシュキー（platform/teamId/userId）。アプリケーションを跨ぐキーは delegation.js / identity が applicationId を前置する。 */
export function sourceKey(source) {
  if (!source) return ''
  return `${source.platform ?? ''}\u0000${source.teamId ?? ''}\u0000${source.userId ?? ''}`
}
