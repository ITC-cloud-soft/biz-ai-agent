// Keeps the generated table of README.md (conformance check catalog) in sync with the suite.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const README_FILE = fileURLToPath(new URL('../README.md', import.meta.url))

export async function renderTables() {
  const { collectChecks } = await import('../conformance/suite.mjs')
  const checks = collectChecks()
  const rows = ['| id | check | needs |', '|---|---|---|']
  for (const c of checks) rows.push(`| ${c.id} | ${c.title.replace(/\|/g, '/')} | ${(c.opts.requires ?? []).map((r) => `\`${r}\``).join(', ') || '-'} |`)
  return { checks: rows.join('\n') }
}

const block = (name, body) => `<!-- ${name}:start -->\n${body}\n<!-- ${name}:end -->`
const re = (name) => new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`)

/** -> { text, changed } */
export async function syncReadmeText(text) {
  const t = await renderTables()
  let out = text
  for (const [name, body] of [['check-catalog', t.checks]]) {
    if (!re(name).test(out)) throw new Error(`README.md has no <!-- ${name}:start --> marker`)
    out = out.replace(re(name), () => block(name, body))
  }
  return { text: out, changed: out !== text }
}

export async function syncReadme({ write = false } = {}) {
  const current = readFileSync(README_FILE, 'utf8')
  const { text, changed } = await syncReadmeText(current)
  if (changed && write) writeFileSync(README_FILE, text)
  return changed
}
