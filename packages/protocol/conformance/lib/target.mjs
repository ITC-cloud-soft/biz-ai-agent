// A conformance TARGET = one business system under test.
//
//   createTarget({ name, baseUrl, serviceToken, bffSecret, basePath, knownGaps, rewrite, normalize, start, stop, loadFixtures, loadManifest })
//
//  - baseUrl / serviceToken / bffSecret: where and how the suite talks to the system.
//  - rewrite(req, target): optional. Maps a v1 request (path under basePath) to what the system really serves
//    (an application adapter of a system that maps v1 onto older routes: v1 path -> its alias path, see aliasTable / pickAlias /
//    fillTemplate). Not used for systems that implement /bridge/v1 natively.
//  - normalize(res, req, target): optional. Response shape adapter (documented `status: shape` aliases).
//  - knownGaps: { checkId: 'why' }. A gap check MUST still fail; if it starts to pass the suite fails ("remove the gap").
//  - start / stop: lifecycle (spawn the system, close DB pools, ...). loadFixtures(target) -> Fixtures (see README).
//  - loadManifest(target) -> manifest object | null (default: GET {basePath}/manifest).
import { listOperations, loadOpenApi } from '../../src/openapi.mjs'

export function createTarget(opts) {
  const basePath = (opts.basePath ?? '/bridge/v1').replace(/\/+$/, '')
  const doc = loadOpenApi()
  const ops = listOperations(doc)
  const violations = []
  const target = {
    name: opts.name ?? 'target',
    baseUrl: String(opts.baseUrl ?? '').replace(/\/+$/, ''),
    serviceToken: opts.serviceToken ?? '',
    bffSecret: opts.bffSecret ?? '',
    basePath,
    manifestFile: opts.manifestFile ?? process.env.BRIDGE_MANIFEST_FILE ?? '',
    doc,
    ops,
    knownGaps: { ...(opts.knownGaps ?? {}) },
    /** Operations the system cannot serve yet (alias status "missing"): checks that sweep all operations skip them. */
    unmapped: new Set(opts.unmapped ?? []),
    fx: null,
    manifest: null,
    manifestSource: null,
    protocolHeaderViolations: violations,
    errorCodes: new Map(),
    gapsHit: [],
    results: [],

    async start() {
      await opts.start?.(target)
      target.fx = await opts.loadFixtures(target)
      target.fx.hooks ??= {}
      target.fx.capabilities ??= {}
      target.fx.probes ??= async () => []
      const loaded = await (opts.loadManifest ?? defaultLoadManifest)(target)
      target.manifest = loaded?.manifest ?? null
      target.manifestSource = loaded?.source ?? null
    },
    async stop() {
      try { await target.fx?.stop?.() } finally { await opts.stop?.(target) }
    },

    /** Sends one request. `path` is a v1 path (basePath + ...) or any business path (sent as is). */
    async send({ method = 'GET', path, query, headers = {}, body }) {
      const original = { method, path, query: query ?? {}, headers, body }
      let req = original
      const isV1 = path.startsWith(`${basePath}/`) || path === basePath
      if (isV1 && opts.rewrite) req = opts.rewrite(original, target)
      const url = new URL(`${target.baseUrl}${req.path}`)
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      const init = { method: req.method, headers: { ...req.headers } }
      if (req.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(req.body)
      }
      const res = await fetch(url, init)
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = null }
      let out = { status: res.status, headers: res.headers, body: json, text, request: original }
      if (isV1 && json && json.ok === false && typeof json.error === 'string') target.errorCodes.set(json.error, `${method} ${path} -> ${res.status}`)
      if (isV1 && !res.headers.get('bridge-protocol') && violations.length < 200) violations.push(`${method} ${path} -> ${res.status}`)
      if (isV1 && opts.normalize) out = opts.normalize(out, original, target) ?? out
      return out
    },
  }
  return target
}

async function defaultLoadManifest(target) {
  const res = await target.send({ method: 'GET', path: `${target.basePath}/manifest`, headers: { 'x-service-token': target.serviceToken } })
  if (res.status === 200 && res.body && typeof res.body === 'object') return { manifest: res.body, source: 'GET /manifest' }
  if (target.manifestFile) {
    const { loadManifestFile } = await import('../../src/manifest.mjs')
    return { manifest: loadManifestFile(target.manifestFile), source: target.manifestFile }
  }
  return null
}
