// The AI employee's "why did this reach me?" tool: the manifest skeleton (built here, from the manifest the AI plane already
// holds) + the object's neighbors from the business system (GET /bridge/v1/graph/neighbors, run as the employee who asked,
// IDs and types only, already filtered by their rights). Read-only; the plugin keeps nothing.
import { buildManifestGraph, explainReach } from '@dsh-bridge/graph/pure'

export const GRAPH_NEIGHBORS_PATH = '/bridge/v1/graph/neighbors'
const ARGS = Object.freeze(['entity', 'id'])
const NOT_ACCEPTED = Object.freeze(['role', 'userId', 'asUser', 'viewer', 'url', 'reason', 'reasons'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (lines) => [{ type: 'text', text: lines.filter((line) => typeof line === 'string' && line !== '').join('\n') }]

/** What the model sees: the reasons (each with the manifest rule it comes from) and the screen links. */
export function renderWhy(r) {
  if (!r?.found) {
    return text([
      'found=false: there is no such object for this employee (it does not exist, or they may not see it).',
      'Say you could not find it and ask for the ID shown on the card or screen. Do not guess why something reached them.',
    ])
  }
  return text([
    `Why the ${r.subject.label} ${r.subject.id} reached this employee (role ${r.viewer.role}) — from the business system's own rules.`,
    'Explain with ONLY these reasons, in the employee\'s language; name the rule in brackets, e.g. (approval.requested). Never add a reason.',
    ...r.reasons.map((x, i) => `${i + 1}. ${x.text} [rule: ${x.path.join(' → ')}]`),
    r.links.length ? `Screens (write the url exactly as below): ${r.links.map((l) => `${l.entity} ${l.url}`).join(' · ')}` : '',
  ])
}

/**
 * @param {object} o
 * @param {string} o.name                       '<namespace>_graph_why'
 * @param {(tool, path, query) => Promise<any>} o.requestJson   the delegated request of the tool runtime
 * @param {() => object|null} o.application     the bridge-tools application (manifest(), ensureManifest())
 * @param {string} [o.systemName]
 */
export function graphWhyToolSpec({ name, requestJson, application, systemName = 'the business system', path = GRAPH_NEIGHBORS_PATH }) {
  let cached = null // { manifest, graph }: rebuilt when the manifest object changes (etag refresh)
  async function graphOf() {
    const app = typeof application === 'function' ? application() : null
    try { await app?.ensureManifest?.() } catch { /* manifestInfo has the error */ }
    const manifest = app?.manifest?.() ?? null
    if (!manifest) throw new Error(`${name}: the manifest of ${systemName} is not available yet`)
    if (cached?.manifest !== manifest) cached = { manifest, graph: buildManifestGraph(manifest) }
    return cached
  }
  return {
    name,
    access: 'read',
    description:
      `Read-only: explains WHY a notification, approval card, report or task of ${systemName} reached the employee you are talking with — `
      + 'from the system\'s own rules (which event goes to which role, which AI task reports to whom) and the object\'s relations '
      + '(who made it, which role must decide). Call it for "why did I get this?", "why is this approval mine?". entity: the kind of '
      + 'object (e.g. approval, leave_request), id: its ID from the card or screen. Explain with only the reasons it returns.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'The kind of object (an entity of the business system, e.g. approval).' },
        id: { type: 'string', description: 'The object\'s ID as shown on the card or screen.' },
      },
      required: ['entity', 'id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, found: { type: 'boolean' } }, required: ['ok', 'found'] },
      render: (_args, r) => renderWhy(r),
    },
    async execute(args = {}) {
      if (!isObj(args)) throw new Error(`${name}: arguments must be an object`)
      const refused = Object.keys(args).filter((k) => NOT_ACCEPTED.includes(k))
      if (refused.length) throw new Error(`${name}: ${refused.join(', ')} not accepted — whose rights apply is decided by the business system`)
      const unknown = Object.keys(args).filter((k) => !ARGS.includes(k))
      if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
      const { graph, manifest } = await graphOf()
      if (typeof args.entity !== 'string' || !manifest.entities?.[args.entity]) {
        throw new Error(`${name}: "entity" must be one of ${Object.keys(manifest.entities ?? {}).join(', ')}`)
      }
      if (typeof args.id !== 'string' || !ID_RE.test(args.id)) throw new Error(`${name}: "id" is required (the ID on the card or screen)`)
      let r
      try {
        r = await requestJson(name, path, { entity: args.entity, id: args.id })
      } catch (error) {
        if (error?.status === 404) return { ok: true, found: false }
        throw error
      }
      const neighbors = Array.isArray(r?.neighbors) ? r.neighbors : []
      const viewer = { role: typeof r?.viewer?.role === 'string' ? r.viewer.role : null }
      const why = explainReach(graph, { ref: { entity: args.entity, id: args.id }, viewer, neighbors })
      return { ok: true, found: true, viewer, ...why }
    },
  }
}
