// manifest.js — 業務システムの manifest（BRIDGE_ARCHITECTURE §11）の読み込み・検証・キャッシュ・更新。
//
// 取り方：manifestUrl（`GET /bridge/v1/manifest`、サービストークン、If-None-Match / etag → 304）を優先し、
// 取れない・検証に落ちたときは同梱の manifestFile（リポジトリで CI 検証済みのもの）を使う。
// 前回の有効な manifest は、更新に失敗しても捨てない（壊れた manifest で既存の動作を止めない）。
// 検証は @dsh-bridge/protocol の validateManifest。system.id がアプリケーション ID と違う manifest は受け付けない
// （他のアプリケーションの manifest を取り違えない）。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument, validateManifest } from '@dsh-bridge/protocol'
import { BridgeApiError } from './api-client.js'

const require = createRequire(import.meta.url)

/**
 * manifestFile の指定を絶対パスへ。
 *  - 絶対パス / 相対パス（baseDir 基準、既定は cwd）
 *  - `pkg:<package>/<path>`（例 `pkg:@dsh-bridge/protocol/manifests/example.manifest.yaml`）：パッケージの位置から解決
 */
export function resolveManifestFile(spec, { baseDir = process.cwd() } = {}) {
  const value = String(spec ?? '').trim()
  if (!value) return null
  if (value.startsWith('pkg:')) {
    const rest = value.slice(4)
    const parts = rest.split('/')
    const pkgName = rest.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const inner = parts.slice(rest.startsWith('@') ? 2 : 1).join('/')
    // まずこの package の位置から（profile の node_modules）、次に baseDir / cwd から
    let pkgJson
    try {
      pkgJson = require.resolve(`${pkgName}/package.json`)
    } catch {
      pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [baseDir, process.cwd()] })
    }
    return join(dirname(pkgJson), inner)
  }
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

/** manifest を検証する。{ valid, errors, warnings }（system.id の照合を含む）。 */
export function checkManifest(manifest, { applicationId } = {}) {
  const result = validateManifest(manifest)
  const errors = [...result.errors]
  const systemId = manifest?.system?.id
  if (applicationId && systemId && systemId !== applicationId) {
    errors.push({ path: '/system/id', message: `manifest is for "${systemId}", not for application "${applicationId}"`, code: 'app.system_mismatch' })
  }
  return { valid: errors.length === 0, errors, warnings: result.warnings }
}

function summarize(errors) {
  return errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '')
}

/**
 * 1 アプリケーションの manifest の保持者。
 * @param {object} opts
 * @param {string} opts.applicationId
 * @param {object} [opts.api]          createBusinessApi（manifestUrl を取るとき）
 * @param {string} [opts.manifestUrl]  API base からの相対パス（`/bridge/v1/manifest`）か絶対 URL
 * @param {string} [opts.manifestFile] 同梱の manifest（resolveManifestFile の書式）
 * @param {string} [opts.baseDir]
 * @param {object} [opts.manifest]     直接渡す（テスト・組み込み）
 * @param {() => number} [opts.now]
 * @param {object} [opts.logger]
 */
export function createManifestHolder({ applicationId, api = null, manifestUrl = '', manifestFile = '', baseDir, manifest: inline = null, now = Date.now, logger = console }) {
  const state = {
    manifest: null,
    source: null, // 'url' | 'file' | 'inline'
    etag: null,
    loadedAt: null,
    checkedAt: null,
    warnings: [],
    lastError: null,
    fileTried: false,
  }
  let inflight = null

  function accept(doc, source, etag = null) {
    const checked = checkManifest(doc, { applicationId })
    if (!checked.valid) {
      const error = new Error(`${applicationId}: ${source} manifest is invalid: ${summarize(checked.errors)}`)
      error.errors = checked.errors
      throw error
    }
    state.manifest = Object.freeze(doc)
    state.source = source
    state.etag = etag
    state.loadedAt = new Date(now()).toISOString()
    state.warnings = checked.warnings
    return state.manifest
  }

  function loadFile() {
    state.fileTried = true
    const file = resolveManifestFile(manifestFile, { baseDir })
    if (!file) return null
    const doc = parseDocument(readFileSync(file, 'utf8'), file)
    return accept(doc, 'file')
  }

  async function fetchUrl() {
    const headers = {}
    if (state.etag && state.source === 'url') headers['if-none-match'] = state.etag
    const res = await api.request('GET', manifestUrl, { headers, raw: true })
    if (res.status === 304) return state.manifest
    const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null
    return accept(res.body, 'url', etag)
  }

  /**
   * 取り直す。manifestUrl → 失敗時は（まだ有効な manifest が無ければ）manifestFile。
   * @returns 現在の manifest（無ければ null）。例外は投げず lastError に残す。
   */
  async function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      state.checkedAt = new Date(now()).toISOString()
      if (inline && !state.manifest) {
        try { return accept(inline, 'inline') } catch (error) { state.lastError = error.message; return null }
      }
      if (manifestUrl && api) {
        try {
          const doc = await fetchUrl()
          state.lastError = null
          return doc
        } catch (error) {
          const reason = error instanceof BridgeApiError && error.status === 404 ? 'not served (404)' : error?.message ?? String(error)
          state.lastError = `manifestUrl: ${reason}`
          logger.debug?.('bridge: %s manifest from %s unavailable: %s', applicationId, manifestUrl, reason)
        }
      }
      if (manifestFile && !state.manifest) {
        try {
          const doc = loadFile()
          if (!manifestUrl) state.lastError = null
          return doc
        } catch (error) {
          state.lastError = `${state.lastError ? `${state.lastError}; ` : ''}manifestFile: ${error?.message ?? error}`
          logger.warn?.('bridge: %s bundled manifest could not be used: %s', applicationId, error?.message ?? error)
        }
      }
      return state.manifest
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return {
    get: () => state.manifest,
    refresh,
    /** 一度も読んでいなければ読む。 */
    async ensure() { return state.manifest ?? refresh() },
    info: () => ({
      applicationId,
      source: state.source,
      etag: state.etag,
      loadedAt: state.loadedAt,
      checkedAt: state.checkedAt,
      version: state.manifest?.version ?? null,
      warnings: state.warnings.length,
      lastError: state.lastError,
    }),
  }
}
