// ai-profile.js — 業務システムの AI 社員のプロフィール（docs/AI_EMPLOYEE_PROFILE.md）の保持者。manifest の保持者（manifest.js）と同じ取り方。
//
//   GET <paths.aiProfile>（サービストークン、If-None-Match / etag → 304）。起動時と 60 秒ごと（bridge-apps の aiProfileRefreshSeconds）。
//   - paths.aiProfile が無いアプリケーションは取りに行かない（null）。404 = その業務システムに無い機能（null）。
//   - 取れない・形が違う・検査（@dsh-bridge/protocol の validateAiProfile）に落ちるときは前の値を捨てない（壊れた値で止めない）。
//   - get() は同期（最後に取れたプロフィール or null）。system prompt は会話ごとに固定（bridge-persona）、署名は次の文面からすぐ変わる。
import { validateAiProfile } from '@dsh-bridge/protocol'
import { BridgeApiError } from './api-client.js'

export const AI_PROFILE_REFRESH_SECONDS = 60

/**
 * 1 アプリケーションのプロフィールの保持者。
 * @param {object} opts
 * @param {string} opts.applicationId
 * @param {object} [opts.api]      createBusinessApi
 * @param {string} [opts.path]     paths.aiProfile（'' / 未設定なら取りに行かない）
 * @param {object} [opts.profile]  直接渡す（テスト・組み込み。path より優先しない：path が無いときだけ使う）
 * @param {() => number} [opts.now]
 * @param {object} [opts.logger]
 */
export function createAiProfileHolder({ applicationId, api = null, path = '', profile: inline = null, now = Date.now, logger = console }) {
  const state = {
    profile: null,
    version: null,
    updatedAt: null,
    etag: null,
    source: null, // 'url' | 'inline' | null
    loadedAt: null,
    checkedAt: null,
    served: null, // true: 業務システムが持つ / false: 404 / null: まだ分からない
    lastError: null,
  }
  let inflight = null

  if (inline && !path) {
    const r = validateAiProfile(inline)
    if (r.ok) Object.assign(state, { profile: Object.freeze(r.profile), source: 'inline', served: true, loadedAt: new Date(now()).toISOString() })
    else state.lastError = `inline profile is invalid (${r.errors.slice(0, 3).map((e) => `${e.field}:${e.code}`).join(', ')})`
  }

  function accept(body, etag) {
    if (!body || typeof body !== 'object' || body.ok !== true || !('profile' in body)) throw new Error('unexpected response shape')
    let profile = null
    if (body.profile !== null) {
      const r = validateAiProfile(body.profile)
      // 業務システムの検査を通ったはずのもの。ここで落ちたら使わない（前の値のまま）。当たった文字列は残さない
      if (!r.ok) throw new Error(`profile failed the check (${r.errors.slice(0, 3).map((e) => `${e.field}:${e.code}`).join(', ')})`)
      profile = Object.freeze(r.profile)
    }
    state.profile = profile
    state.version = Number.isSafeInteger(body.version) ? body.version : null
    state.updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : null
    state.etag = etag
    state.source = 'url'
    state.served = true
    state.loadedAt = new Date(now()).toISOString()
    return profile
  }

  /** 取り直す。例外は投げず lastError に残す。@returns 現在のプロフィール（無ければ null） */
  async function refresh() {
    if (!path || !api) return state.profile
    if (inflight) return inflight
    inflight = (async () => {
      state.checkedAt = new Date(now()).toISOString()
      try {
        const headers = state.etag ? { 'if-none-match': state.etag } : {}
        const res = await api.request('GET', path, { headers, raw: true })
        if (res.status === 304) { state.lastError = null; return state.profile }
        const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null
        const out = accept(res.body, etag)
        state.lastError = null
        return out
      } catch (error) {
        if (error instanceof BridgeApiError && error.status === 404) {
          // その業務システムに無い機能（x-optional）：プロフィールなし
          Object.assign(state, { profile: null, version: null, updatedAt: null, etag: null, source: null, served: false, lastError: null })
          return null
        }
        state.lastError = error?.message ?? String(error)
        logger.debug?.('bridge: %s ai-profile unavailable: %s', applicationId, state.lastError)
        return state.profile
      }
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return {
    get: () => state.profile,
    refresh,
    /** 一度も取っていなければ取る。 */
    async ensure() { return state.checkedAt || !path ? state.profile : refresh() },
    /** 一度は取りに行った（または取りに行く経路が無い）。bridge-persona が会話の system prompt を固定してよいか。 */
    settled: () => !path || !api || state.checkedAt !== null,
    info: () => ({
      applicationId,
      path: path || null,
      served: state.served,
      source: state.source,
      version: state.version,
      updatedAt: state.updatedAt,
      etag: state.etag,
      loadedAt: state.loadedAt,
      checkedAt: state.checkedAt,
      lastError: state.lastError,
    }),
  }
}
