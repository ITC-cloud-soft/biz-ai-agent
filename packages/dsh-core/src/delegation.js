// delegation.js — 委託トークン（Bridge プロトコル `POST /bridge/v1/delegations`）のキャッシュ。
//
// キーは (applicationId, 発信元)。アプリケーション A で発行したトークンは A のキーにしか入らず、
// B の照会で返ることはない（BRIDGE_STAGE2_PLAN の原則：あるアプリケーションの委託トークンは、別のアプリケーションでは決して使えない）。
// エントリ自体にも applicationId を持たせ、送信側（tools-sdk の requester）が送り先と照合する。
import { apiSource, sourceKey } from './api-client.js'

export const DELEGATION_REFRESH_MARGIN_MS = 30_000
export const DELEGATION_MAX_TTL_MS = 5 * 60_000

/** (applicationId, source) のキャッシュキー。 */
export function delegationKey(applicationId, source) {
  return `${applicationId ?? ''}\u0001${sourceKey(apiSource(source) ?? source)}`
}

/**
 * (applicationId, 事件) のキャッシュキー（事件ごとの委託）。IM の発信元のキーとは名前空間が違う（`event:` で始まる）ので混ざらない。
 */
export function eventDelegationKey(applicationId, eventId) {
  return `${applicationId ?? ''}\u0001event:${String(eventId ?? '')}`
}

/** 業務システムの事件 ID（正の整数。文字列でもよい）→ 委託の要求の body の id（number）。不正なら null。 */
export function eventIdForRequest(eventId) {
  const raw = String(eventId ?? '').trim()
  return /^[1-9][0-9]{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.refreshMarginMs]  期限のこれだけ前から取り直す
 * @param {number} [opts.maxTtlMs]         業務システムの expiresAt がこれより長くても、ここで切る
 */
export function createDelegationCache({ now = Date.now, refreshMarginMs = DELEGATION_REFRESH_MARGIN_MS, maxTtlMs = DELEGATION_MAX_TTL_MS } = {}) {
  const cache = new Map() // key -> { token, userId, platform, applicationId, expiresAt }
  const inflight = new Map()

  /**
   * 有効なトークンを返す。無ければ mint(body) で取る。
   * @param {string} applicationId
   * @param {object} source  信頼できる IM 発信元（{platform, teamId?, userId}）
   * @param {(body: {source}) => Promise<object>} mint  業務 API の応答（{ token, user, expiresAt }）を返す
   * @param {object} [opts]
   * @param {(message: string) => Error} [opts.error]  トークン無し応答のエラー
   */
  async function get(applicationId, source, mint, { error = (m) => new Error(m) } = {}) {
    const body = apiSource(source)
    if (!applicationId) throw error('no application for this delegation')
    if (!body) throw error('no trusted source for this delegation')
    return fetchEntry(applicationId, delegationKey(applicationId, body), { source: body }, String(body.platform ?? ''), mint, error)
  }

  /**
   * 事件ごとの委託（POST delegations { event: { id } }。自動タスクの playbook の委託の分類が `<class>=each`）。
   * 業務システムがその事件の本人に発行する（呼び出し側は職員を選べない）。キーは eventDelegationKey。
   * @param {string} applicationId
   * @param {string|number} eventId  業務システムの事件 ID（正の整数）
   * @param {(body: {event: {id: number}}) => Promise<object>} mint
   */
  async function getForEvent(applicationId, eventId, mint, { error = (m) => new Error(m) } = {}) {
    if (!applicationId) throw error('no application for this delegation')
    const id = eventIdForRequest(eventId)
    if (id === null) throw error('no business event for this delegation')
    return fetchEntry(applicationId, eventDelegationKey(applicationId, id), { event: { id } }, '', mint, error)
  }

  async function fetchEntry(applicationId, key, body, platform, mint, error) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt - refreshMarginMs > now()) return hit
    cache.delete(key)
    if (inflight.has(key)) return inflight.get(key)
    const task = (async () => {
      const res = await mint(body)
      if (!res || typeof res.token !== 'string' || res.token === '') throw error('returned no delegation token')
      const parsed = Date.parse(res.expiresAt ?? '')
      const ceiling = now() + maxTtlMs
      const entry = Object.freeze({
        token: res.token,
        userId: res.user?.id === undefined || res.user?.id === null ? null : String(res.user.id),
        role: typeof res.user?.role === 'string' ? res.user.role : null,
        platform,
        applicationId: String(applicationId),
        key,
        expiresAt: Number.isFinite(parsed) ? Math.min(parsed, ceiling) : ceiling,
      })
      cache.set(key, entry)
      return entry
    })()
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }

  /** 1 件捨てる（key は delegationKey、または (applicationId, source)）。 */
  function forget(keyOrApplicationId, source) {
    const key = source === undefined ? keyOrApplicationId : delegationKey(keyOrApplicationId, source)
    return cache.delete(key)
  }

  /**
   * その職員のトークンを捨てる（本人の連携解除）。applicationId 指定時はそのアプリケーションだけ
   * （職員 ID はアプリケーションごとの名前空間）。platform 指定時はそのプラットフォームだけ。
   */
  function forgetUser(userId, platform, applicationId) {
    let removed = 0
    for (const [key, entry] of [...cache.entries()]) {
      if (entry.userId !== String(userId)) continue
      if (platform && entry.platform !== String(platform)) continue
      if (applicationId && entry.applicationId !== String(applicationId)) continue
      cache.delete(key)
      removed += 1
    }
    return removed
  }

  /** そのアプリケーションのトークンを全部捨てる（設定変更・サービストークンの差し替え）。 */
  function forgetApplication(applicationId) {
    let removed = 0
    for (const [key, entry] of [...cache.entries()]) {
      if (entry.applicationId === String(applicationId)) { cache.delete(key); removed += 1 }
    }
    return removed
  }

  return {
    get,
    getForEvent,
    forget,
    forgetUser,
    forgetApplication,
    clear: () => cache.clear(),
    size: () => cache.size,
  }
}
