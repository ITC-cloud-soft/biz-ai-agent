// "Why did this reach me?" — the manifest skeleton (who is told about which event) combined with one object's neighbors
// (GET /bridge/v1/graph/neighbors, already filtered by the asker's rights). Pure: no I/O.
//
//   explainReach(graph, { ref: { entity, id }, viewer: { role }, neighbors: [{ relation, entity, id, you? }] })
//     -> { subject: { entity, id, label, link }, reasons: [{ kind, text, path }], links: [{ entity, id, url }] }
//
// Every reason names the manifest nodes it comes from (path), so an answer can say which rule sent it. No reason is invented:
// when the manifest sends nothing about this object to the viewer's role, the only reason is kind "none".
import { graphIndex } from './skeleton.mjs'

const fill = (link, objId) => (link && objId ? String(link).replace('{id}', encodeURIComponent(objId)) : null)
const roleList = (g, roles) => roles.map((r) => `${g.node(`role:${r}`)?.label ?? r} (${r})`).join(', ')

function eventsAbout(g, entity) {
  return g.into(`entity:${entity}`, 'about').map((e) => g.node(e.from)).filter(Boolean)
}
function notified(g, ev) {
  return [...new Set(g.out(ev.id, 'notifies').map((e) => g.node(e.to)?.key).filter(Boolean))].sort()
}

export function explainReach(graph, { ref, viewer, neighbors = [] } = {}) {
  const g = graphIndex(graph)
  const entityNode = g.node(`entity:${ref?.entity}`)
  if (!entityNode) throw new Error(`explainReach: ${ref?.entity} is not an entity of the manifest`)
  const role = viewer?.role ?? null
  const reasons = []
  const add = (kind, text, path) => reasons.push({ kind, text, path })
  const you = (relation) => neighbors.find((n) => n.relation === relation && n.entity === 'employee' && n.you)

  // 1. the object's own relations (from the business system, filtered by the asker's rights)
  const required = neighbors.find((n) => n.relation === 'required_role' && n.entity === 'role')
  if (required && required.id === role) add('required_role', `It waits for a decision by the role ${roleList(g, [role])} — that is your role.`, [`entity:${ref.entity}`, `role:${role}`])
  if (you('requested_by') || you('author')) add('author', 'You made it.', [`entity:${ref.entity}`])
  if (you('assigned_to')) add('assignee', 'It is assigned to you.', [`entity:${ref.entity}`])

  // 2. the manifest's events about this kind of object: who they go to, and what they trigger
  const walk = (entity, via) => {
    for (const ev of eventsAbout(g, entity)) {
      const roles = notified(g, ev)
      const rule = g.out(ev.id, 'audience').map((e) => g.node(e.to)).find(Boolean)
      const where = via ? ` about its ${via.relation.replace(/_/g, ' ')} (${g.node(`entity:${entity}`)?.label ?? entity})` : ''
      if (role && roles.includes(role)) {
        add(via ? 'related_event' : 'event_audience', `The event "${ev.label}" (${ev.key})${where} is sent to ${roleList(g, roles)} — your role is one of them.`, [ev.id, `entity:${entity}`, `role:${role}`])
      }
      if (rule?.includes?.includes('author') && (you('requested_by') || you('author'))) {
        add('audience_rule', `The event "${ev.label}" (${ev.key})${where} also goes to the employee who made it (audience rule ${rule.key}) — that is you.`, [ev.id, rule.id])
      }
      for (const p of g.out(ev.id, 'triggers').map((e) => g.node(e.to)).filter(Boolean)) {
        const to = g.out(p.id, 'reports_to').map((e) => g.node(e.to)?.key).filter(Boolean)
        if (role && to.includes(role)) {
          add('playbook', `When "${ev.label}" happens, the AI task "${p.label}" (${p.key}${p.enabled ? '' : ', switched off'}) reports to ${roleList(g, to)}.`, [ev.id, p.id, `role:${role}`])
        }
      }
    }
  }
  walk(ref.entity, null)
  for (const n of neighbors) if (n.entity !== ref.entity && g.node(`entity:${n.entity}`)) walk(n.entity, n)

  if (!reasons.length) add('none', `The manifest has no rule that sends a ${entityNode.label} to the role ${role ?? '(unknown)'}.`, [`entity:${ref.entity}`])

  const links = [{ entity: ref.entity, id: ref.id, url: fill(entityNode.link, ref.id) }, ...neighbors
    .filter((n) => g.node(`entity:${n.entity}`)?.link)
    .map((n) => ({ entity: n.entity, id: n.id, url: fill(g.node(`entity:${n.entity}`).link, n.id) }))].filter((l) => l.url)
  return { subject: { entity: ref.entity, id: ref.id, label: entityNode.label, link: fill(entityNode.link, ref.id) }, reasons, links }
}
