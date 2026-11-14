// Knowledge documents written as Markdown files. Pure (readKnowledgeDir is the only I/O).
//
//   ---
//   id: leave-policy
//   title: Leave policy
//   link: /handbook/leave-policy          the business screen that shows the document (a route of manifest web.routes)
//   roles: [admin, manager, staff]        who may read it (and / or users: [<employee id>, ...])
//   keywords: [annual leave, carry over]
//   ---
//   Text before the first heading is the document's introduction.
//
//   ## Carry-over {#carry-over}
//   ...
//   ## Approval limits {#approval-limits roles=admin,manager}     a section may narrow the visibility
//
// Headings ## and ### start sections. `{#anchor}` becomes the fragment of the source link.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*(?:\{([^}]*)\})?\s*$/

function scalar(v) {
  const s = v.trim()
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  return s.replace(/^['"]|['"]$/g, '')
}

/** `key: value` / `key: [a, b]` lines between the first two `---` lines. */
export function parseFrontMatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!src.startsWith('---\n')) return { meta: {}, body: src }
  const end = src.indexOf('\n---', 4)
  if (end < 0) return { meta: {}, body: src }
  const meta = {}
  for (const line of src.slice(4, end).split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim())
    if (m) meta[m[1]] = scalar(m[2])
  }
  return { meta, body: src.slice(end + 4).replace(/^[^\n]*\n/, '') }
}

/** `#anchor roles=a,b users=x` → { anchor, roles?, users? } */
export function parseAttributes(raw) {
  const out = {}
  for (const token of String(raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) out.anchor = token.slice(1)
    else {
      const m = /^(roles|users)=(.*)$/.exec(token)
      if (!m) throw new Error(`unknown heading attribute "${token}" (use #anchor, roles=a,b, users=x,y)`)
      out[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean)
    }
  }
  return out
}

/** Body → [{ heading, anchor, roles?, users?, text }] (the introduction has heading null). */
export function splitSections(body) {
  const sections = []
  let current = { heading: null, text: [] }
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = HEADING_RE.exec(line)
    if (m) {
      sections.push(current)
      current = { heading: m[2].trim(), ...parseAttributes(m[3]), text: [] }
    } else current.text.push(line)
  }
  sections.push(current)
  return sections
    .map((s) => ({ ...s, text: s.text.join('\n').trim() }))
    .filter((s) => s.text || s.heading)
}

/** One Markdown file → a knowledge document (see the header comment). */
export function parseKnowledgeMarkdown(text, { file = 'document' } = {}) {
  const { meta, body } = parseFrontMatter(text)
  try {
    return {
      id: meta.id,
      title: meta.title,
      link: meta.link,
      keywords: Array.isArray(meta.keywords) ? meta.keywords : meta.keywords ? [meta.keywords] : [],
      visibility: { roles: meta.roles, users: meta.users },
      sections: splitSections(body),
    }
  } catch (error) {
    throw new Error(`${file}: ${error.message}`)
  }
}

/** Every *.md file of a directory (sorted) → documents. */
export async function readKnowledgeDir(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('_')).sort()
  return Promise.all(names.map(async (n) => parseKnowledgeMarkdown(await readFile(join(dir, n), 'utf8'), { file: n })))
}
