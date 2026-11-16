#!/usr/bin/env node
// Copies the Biz Assistant Framework into this repository, so biz-ai-agent is a complete agent framework on its own:
//   packages/*  dsh-core, gateway, help, protocol, server-kit, telemetry, testing, web-kit
//   plugins/*   approvals, assistant, events, identity, memory, notify, persona, reader, tools
//   profile/    the DSH profile template and its install scripts
//   vendor/     the dsh-im, dsh-auto-tasks and dsh-proactive forks (own npm setup each, not workspaces)
//   examples/*  the framework's reference business systems; LICENSE and NOTICE (Apache-2.0; the vendor forks are MIT)
// next to biz-ai-agent's own packages (agent-settings, knowledge, graph …), which it never touches.
//
//   node scripts/sync-framework.mjs [--from <framework checkout>]   (default: $BIZ_AI_FRAMEWORK or ../framework)
//
// Only the framework's COMMITTED files (git ls-files at HEAD; the checkout's tree must be clean for these directories).
// pnpm's "workspace:" ranges become plain versions (npm workspaces link them). framework.sync.json records the commit and
// the copied files; a file the framework dropped since the last sync is removed here. Change these files in the framework
// and sync again — a local edit is overwritten by the next sync.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['packages', 'plugins', 'profile', 'vendor', 'examples', 'LICENSE', 'NOTICE']
const RECORD = join(REPO, 'framework.sync.json')

const args = process.argv.slice(2)
const fromArg = args.indexOf('--from') >= 0 ? args[args.indexOf('--from') + 1] : null
const FW = resolve(fromArg || process.env.BIZ_AI_FRAMEWORK || join(REPO, '..', 'framework'))
const git = (...a) => execFileSync('git', ['-C', FW, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

if (!existsSync(join(FW, 'profile', 'template', 'cordis.patch.yml'))) { console.error(`not a framework checkout: ${FW}`); process.exit(2) }
const dirty = git('status', '--porcelain', '--', ...DIRS).trim()
if (dirty) { console.error(`the framework checkout has uncommitted changes in ${DIRS.join(', ')}:\n${dirty}\ncommit them first`); process.exit(2) }

const files = git('ls-files', '-z', '--', ...DIRS).split('\0').filter(Boolean)
const own = new Set(['packages/agent-settings', 'packages/knowledge', 'packages/graph', 'plugins/knowledge', 'plugins/graph', 'examples/leave-requests-knowledge', 'examples/equipment-loans'])
const clash = files.filter((f) => [...own].some((o) => f === o || f.startsWith(o + '/')))
if (clash.length) { console.error(`the framework now has a directory biz-ai-agent owns: ${clash[0]} — rename one side first`); process.exit(2) }

// versions of the framework's workspace packages, for its "workspace:" ranges
const versions = {}
for (const f of files.filter((x) => /^(packages|plugins|examples)\/[^/]+\/package\.json$/.test(x) || x === 'profile/package.json')) {
  const p = JSON.parse(readFileSync(join(FW, f), 'utf8'))
  versions[p.name] = p.version
}
const rewrite = (text) => {
  const p = JSON.parse(text)
  let changed = false
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(p[k] ?? {})) {
      const m = /^workspace:(.*)$/.exec(range)
      if (!m) continue
      if (!versions[name]) throw new Error(`${name}: workspace range without a framework package`)
      p[k][name] = m[1] === '^' ? `^${versions[name]}` : m[1] === '~' ? `~${versions[name]}` : versions[name]
      changed = true
    }
  }
  return changed ? JSON.stringify(p, null, 2) + '\n' : text
}

const previous = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')).files ?? [] : []
const now = new Set(files)
let removed = 0
for (const f of previous) if (!now.has(f) && existsSync(join(REPO, f))) { rmSync(join(REPO, f)); removed++ }

for (const f of files) {
  const to = join(REPO, f)
  mkdirSync(dirname(to), { recursive: true })
  if (/^(packages|plugins|examples)\/[^/]+\/package\.json$/.test(f) || f === 'profile/package.json') writeFileSync(to, rewrite(readFileSync(join(FW, f), 'utf8')))
  else copyFileSync(join(FW, f), to)
}

const commit = git('rev-parse', 'HEAD').trim()
writeFileSync(RECORD, JSON.stringify({
  note: 'Copied from the Biz Assistant Framework by scripts/sync-framework.mjs. Change these files in the framework, then sync again.',
  commit, subject: git('log', '-1', '--format=%s').trim(), syncedAt: new Date().toISOString(), dirs: DIRS, files,
}, null, 2) + '\n')
console.log(`synced ${files.length} files from framework ${commit.slice(0, 7)}${removed ? `, removed ${removed}` : ''}`)
