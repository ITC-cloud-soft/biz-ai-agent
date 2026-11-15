// The skeleton of the semantic graph, generated from the manifest (no model, no extraction): the manifest IS the ontology.
//
//   buildManifestGraph(manifest) -> { nodes: [{ id, type, key, label, ... }], edges: [{ from, to, type, inferred? }] }
//
// Node ids: `<type>:<key>` — role:manager, entity:leave_request, event:approval.requested, tool:leave_list_requests,
// playbook:unanswered_followup, audience:requester_and_managers, report:daily_leave.
// Edges:
//   event    -about->        entity     (events.<e>.aggregate)
//   event    -notifies->     role       (audience.roles, or the roles of its audience rule)
//   event    -audience->     audience   (audience.rule)
//   audience -includes->     role       (audienceRules.<r>.roles; `includes: [author]` is kept on the node)
//   event    -triggers->     playbook   (events.<e>.playbook / playbooks.<p>.trigger.events)
//   playbook -uses->         tool       (playbooks.<p>.tools)
//   playbook -reports_to->   role       (playbooks.<p>.audience.roles)
//   tool     -available_to-> role       (tools[].roles)
//   tool     -reads|proposes-> entity   INFERRED: the tool's path and the entity's screen link share their first segment
//   report   -delivered_to-> role       (reports.<r>.audience.roles)
// Deterministic (sorted), JSON-serializable, and free of business data: it is the same for every asker.

const id = (type, key) => `${type}:${key}`
const firstSegment = (path) => String(path ?? '').split('?')[0].split('/').filter(Boolean).find((s) => !/^(api|bridge|v\d+)$/.test(s)) ?? null

export function buildManifestGraph(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('buildManifestGraph: a manifest is required')
  const nodes = new Map()
  const edges = new Map()
  const node = (type, key, extra = {}) => {
    const k = id(type, key)
    if (!nodes.has(k)) nodes.set(k, { id: k, type, key, label: extra.label ?? key, ...extra })
    return k
  }
  const edge = (from, to, type, extra = {}) => {
    if (!nodes.has(from) || !nodes.has(to)) return
    edges.set(`${from}|${type}|${to}`, { from, to, type, ...extra })
  }
  const roleKeys = Object.keys(manifest.roles ?? {})
  for (const [key, r] of Object.entries(manifest.roles ?? {})) node('role', key, { label: r?.label ?? key, scope: r?.scope ?? null })
  for (const [key, e] of Object.entries(manifest.entities ?? {})) node('entity', key, { label: e?.label ?? key, pii: e?.pii ?? null, link: e?.link ?? null })
  for (const [key, a] of Object.entries(manifest.audienceRules ?? {})) {
    const k = node('audience', key, { label: a?.description ?? key, includes: [...(a?.includes ?? [])].sort() })
    for (const r of a?.roles ?? []) edge(k, id('role', r), 'includes')
  }
  for (const [key, p] of Object.entries(manifest.playbooks ?? {})) node('playbook', key, { label: p?.label ?? key, enabled: p?.enabled !== false, approval: p?.approval ?? null })
  for (const t of manifest.tools ?? []) node('tool', t.name, { label: t.description ?? t.name, access: t.access ?? null, http: t.http ?? null })
  for (const [key, r] of Object.entries(manifest.reports ?? {})) node('report', key, { label: r?.label ?? key })

  for (const [key, e] of Object.entries(manifest.events ?? {})) {
    const k = node('event', key, { label: e?.label ?? key, description: e?.description ?? null, internal: e?.internal ?? null })
    if (e?.aggregate) edge(k, id('entity', e.aggregate), 'about')
    for (const r of e?.audience?.roles ?? []) edge(k, id('role', r), 'notifies')
    if (e?.audience?.rule) {
      edge(k, id('audience', e.audience.rule), 'audience')
      for (const r of manifest.audienceRules?.[e.audience.rule]?.roles ?? []) edge(k, id('role', r), 'notifies')
    }
    if (e?.playbook) edge(k, id('playbook', e.playbook), 'triggers')
  }
  for (const [key, p] of Object.entries(manifest.playbooks ?? {})) {
    const k = id('playbook', key)
    for (const ev of p?.trigger?.events ?? []) edge(id('event', ev), k, 'triggers')
    for (const t of p?.tools ?? []) edge(k, id('tool', t), 'uses')
    for (const r of p?.audience?.roles ?? []) edge(k, id('role', r), 'reports_to')
  }
  const entityBySegment = new Map()
  for (const [key, e] of Object.entries(manifest.entities ?? {})) {
    const seg = firstSegment(e?.link)
    if (seg) entityBySegment.set(seg, key)
  }
  for (const t of manifest.tools ?? []) {
    const k = id('tool', t.name)
    for (const r of t.roles ?? roleKeys) edge(k, id('role', r), 'available_to')
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/.exec(String(t.http ?? ''))
    const entity = m && entityBySegment.get(firstSegment(m[2]))
    if (entity) edge(k, id('entity', entity), t.access === 'propose' ? 'proposes' : 'reads', { inferred: true })
  }
  for (const [key, r] of Object.entries(manifest.reports ?? {})) for (const role of r?.audience?.roles ?? []) edge(id('report', key), id('role', role), 'delivered_to')

  const byId = (a, b) => (a.id ?? `${a.from}|${a.type}|${a.to}`).localeCompare(b.id ?? `${b.from}|${b.type}|${b.to}`)
  return Object.freeze({ nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort(byId) })
}

/** Helpers over a graph. */
export function graphIndex(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = (from, type) => graph.edges.filter((e) => e.from === from && (!type || e.type === type))
  const into = (to, type) => graph.edges.filter((e) => e.to === to && (!type || e.type === type))
  return { node: (k) => nodes.get(k) ?? null, out, into }
}
