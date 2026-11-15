// Conformance checks of the optional Bridge v1 capability `graph` (GET /bridge/v1/graph/neighbors), over HTTP.
//
//   const results = await runGraphChecks({ baseUrl, serviceToken, fixtures })
//   fixtures = {
//     probe:   { entity, id }            an object the `allowed` askers may read and the `denied` askers may not
//     missing: { entity, id }            an object of the same entity that does not exist
//     allowed: [{ label, headers }]      web sessions and delegations that may read the probe
//     denied:  [{ label, headers }]      askers that may not
//     notPermitted?: [{ label, headers }] delegations of a role the manifest's graph tool does not list (expect 403)
//   }
//   -> [{ id, title, state: 'pass' | 'fail' | 'skip', note }]
import { GRAPH_NEIGHBORS_PATH } from './routes.mjs'

export const GRAPH_CHECKS = Object.freeze([
  { id: 'G-01', title: 'no credentials → 401' },
  { id: 'G-02', title: 'the service principal alone (no employee) → 403' },
  { id: 'G-03', title: 'an entity the manifest does not declare → 400 invalid_entity; a malformed id → 400 invalid_id' },
  { id: 'G-04', title: 'an asker who may read the probe gets its neighbors (web session and delegation)' },
  { id: 'G-05', title: 'only IDs and types: body { ok, entity, id, viewer, neighbors }, a neighbor { relation, entity, id, you? }' },
  { id: 'G-06', title: 'an asker who may not read the probe gets exactly the answer for an object that does not exist (404 not_found)' },
  { id: 'G-07', title: 'a delegation of a role the manifest\'s graph tool does not list → 403 delegation_not_permitted' },
])

const sameKeys = (o, keys) => o && typeof o === 'object' && Object.keys(o).every((k) => keys.includes(k))

export async function runGraphChecks({ baseUrl, serviceToken, fixtures, path = GRAPH_NEIGHBORS_PATH, fetchImpl = fetch }) {
  const get = async (headers, params) => {
    const url = new URL(path, baseUrl)
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
    const res = await fetchImpl(url, { headers })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, body }
  }
  const out = []
  const run = async (id, fn) => {
    const title = GRAPH_CHECKS.find((c) => c.id === id)?.title ?? id
    try {
      const note = await fn()
      out.push({ id, title, state: note === 'skip' ? 'skip' : 'pass', note: note === 'skip' ? 'no fixture' : (note ?? '') })
    } catch (error) {
      out.push({ id, title, state: 'fail', note: error.message })
    }
  }
  const must = (cond, msg) => { if (!cond) throw new Error(msg) }
  const { probe, missing, allowed = [], denied = [], notPermitted = [] } = fixtures
  const answers = []

  await run('G-01', async () => must((await get({}, probe)).status === 401, 'expected 401'))
  await run('G-02', async () => must((await get({ 'x-service-token': serviceToken }, probe)).status === 403, 'expected 403'))
  await run('G-03', async () => {
    const h = allowed[0]?.headers
    if (!h) return 'skip'
    const a = await get(h, { entity: 'no_such_entity_x', id: probe.id })
    must(a.status === 400 && a.body?.error === 'invalid_entity', `entity: ${a.status} ${a.body?.error}`)
    const b = await get(h, { entity: probe.entity, id: '../etc' })
    must(b.status === 400 && b.body?.error === 'invalid_id', `id: ${b.status} ${b.body?.error}`)
  })
  await run('G-04', async () => {
    if (!allowed.length) return 'skip'
    for (const a of allowed) {
      const r = await get(a.headers, probe)
      must(r.status === 200 && r.body?.ok === true && Array.isArray(r.body.neighbors), `${a.label}: ${r.status}`)
      answers.push(r.body)
    }
    return `${allowed.length} asker(s)`
  })
  await run('G-05', async () => {
    if (!answers.length) return 'skip'
    for (const b of answers) {
      must(sameKeys(b, ['ok', 'entity', 'id', 'viewer', 'neighbors']) && sameKeys(b.viewer, ['role']), `body keys ${Object.keys(b)}`)
      for (const n of b.neighbors) must(sameKeys(n, ['relation', 'entity', 'id', 'you']) && (n.you === undefined || n.you === true), `neighbor keys ${Object.keys(n)}`)
    }
  })
  await run('G-06', async () => {
    if (!denied.length || !missing) return 'skip'
    for (const d of denied) {
      const hidden = await get(d.headers, probe)
      const none = await get(d.headers, missing)
      must(hidden.status === 404 && none.status === 404, `${d.label}: ${hidden.status} / ${none.status}`)
      must(JSON.stringify(hidden.body) === JSON.stringify(none.body), `${d.label}: the answers differ`)
    }
    return `${denied.length} asker(s)`
  })
  await run('G-07', async () => {
    if (!notPermitted.length) return 'skip'
    for (const d of notPermitted) {
      const r = await get(d.headers, probe)
      must(r.status === 403 && r.body?.error === 'delegation_not_permitted', `${d.label}: ${r.status} ${r.body?.error}`)
    }
  })
  return out
}
