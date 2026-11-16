#!/usr/bin/env node
// bridge-validate: validate Bridge manifests, events and the OpenAPI document; run the conformance suite.
//
//   bridge-validate manifest <file.yaml|json> [--strict] schema + cross-reference + PII checks (--strict: a warning fails too)
//   bridge-validate event <file.json> [--manifest <f>]   an event, an array of events, or a GET /events response
//   bridge-validate openapi [file]                       structural lint of the protocol document
//   bridge-validate aliases [file] [--table aliases.json] [--extension x-alias] [--label name]
//                                                        the v1 -> implementation mapping table of an annotated copy, or of
//                                                        the bundled document + a JSON alias table (linted) (markdown)
//   bridge-validate all [manifest ...]                   bundled OpenAPI + every manifest in manifests/ (+ the given ones)
//   bridge-validate readme [--write]                     check (or rewrite) the generated tables of README.md
//   bridge-validate conformance                          run the suite against BRIDGE_BASE_URL, or through BRIDGE_ADAPTER (see README)
//
// Exit code 0 = valid, 1 = invalid (with --strict: also any warning), 2 = usage error. --strict applies to manifest and all.
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  aliasTableMarkdown, applyAliasTable, lintOpenApi, loadManifestFile, loadOpenApi, parseDocument, validateEvent, validateEventPage, validateManifest,
} from '../src/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const strict = args.includes('--strict')
if (strict) args.splice(args.indexOf('--strict'), 1)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

function printIssues(label, items, kind) {
  for (const i of items) console.log(`  ${kind} ${label}${i.path ?? ''}: ${i.message}${i.code ? ` [${i.code}]` : ''}`)
}

function checkManifest(file) {
  let manifest
  try { manifest = loadManifestFile(file) } catch (e) { console.log(`FAIL ${file}: cannot parse: ${e.message}`); return false }
  const r = validateManifest(manifest)
  const s = `${Object.keys(manifest?.events ?? {}).length} events, ${(manifest?.tools ?? []).length} tools, ${Object.keys(manifest?.playbooks ?? {}).length} playbooks`
  console.log(`${r.valid ? 'ok  ' : 'FAIL'} ${file} (${s})`)
  printIssues('', r.errors, 'error')
  printIssues('', r.warnings, 'warn ')
  if (strict && r.valid && r.warnings.length) console.log(`FAIL ${file}: ${r.warnings.length} warning(s) with --strict`)
  return r.valid && !(strict && r.warnings.length)
}

function checkOpenApi(file) {
  let doc
  try { doc = loadOpenApi(file) } catch (e) { console.log(`FAIL ${file}: cannot parse: ${e.message}`); return false }
  const r = lintOpenApi(doc)
  console.log(`${r.valid ? 'ok  ' : 'FAIL'} ${file ?? 'bundled bridge-v1.yaml'} (${Object.keys(doc.paths ?? {}).length} paths)`)
  printIssues('', r.errors, 'error')
  printIssues('', r.warnings, 'warn ')
  return r.valid
}

function checkEvents(file, manifestFile) {
  const manifest = manifestFile ? loadManifestFile(manifestFile) : null
  const data = parseDocument(readFileSync(file, 'utf8'), file)
  let results
  if (data && Array.isArray(data.events)) results = [validateEventPage(data, { manifest })]
  else results = (Array.isArray(data) ? data : [data]).map((e) => validateEvent(e, { manifest }))
  let ok = true
  results.forEach((r, i) => {
    if (!r.valid) { ok = false; console.log(`FAIL ${file}#${i}`); printIssues('', r.errors, 'error') }
  })
  if (ok) console.log(`ok   ${file} (${results.length} ${results.length === 1 ? 'document' : 'documents'})`)
  return ok
}

const [cmd, ...rest] = args
let ok = true
switch (cmd) {
  case 'manifest': {
    const file = rest[0]
    if (!file) { console.error('usage: bridge-validate manifest <file>'); process.exit(2) }
    ok = checkManifest(file)
    break
  }
  case 'event': {
    const manifest = flag('manifest')
    const file = args[1]
    if (!file) { console.error('usage: bridge-validate event <file.json> [--manifest <file>]'); process.exit(2) }
    ok = checkEvents(file, manifest)
    break
  }
  case 'openapi':
    ok = checkOpenApi(rest[0])
    break
  case 'aliases': {
    const extension = flag('extension') ?? undefined
    const label = flag('label') ?? undefined
    const tableFile = flag('table')
    let doc = loadOpenApi(args[1])
    if (tableFile) {
      // a JSON alias table ([{ method, v1, operationId, aliases }]) applied to the document, then linted (every operation mapped)
      try { doc = applyAliasTable(doc, JSON.parse(readFileSync(tableFile, 'utf8')), { extension }) } catch (e) { console.error(`FAIL ${tableFile}: ${e.message}`); process.exit(1) }
      const r = lintOpenApi(doc, { aliasExtension: extension, requireAliases: true })
      for (const i of r.errors) console.error(`  error ${tableFile}${i.path ?? ''}: ${i.message}`)
      ok = r.valid
    }
    console.log(aliasTableMarkdown(doc, { extension, label }))
    break
  }
  case 'all': {
    ok = checkOpenApi()
    const dir = join(root, 'manifests')
    for (const f of readdirSync(dir).filter((x) => /\.(ya?ml|json)$/.test(x))) ok = checkManifest(join(dir, f)) && ok
    for (const f of rest) ok = checkManifest(f) && ok
    break
  }
  case 'readme': {
    const { syncReadme } = await import('../src/readme.mjs')
    const write = args.includes('--write')
    const changed = await syncReadme({ write })
    console.log(changed ? (write ? 'README.md tables updated' : 'README.md tables are out of date (run: bridge-validate readme --write)') : 'README.md tables are up to date')
    ok = !changed || write
    break
  }
  case 'conformance': {
    const file = join(root, 'conformance', 'http.test.mjs')
    const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', file], { stdio: 'inherit', env: process.env })
    process.exit(r.status ?? 1)
    break
  }
  default:
    console.error('usage: bridge-validate <manifest|event|openapi|aliases|all|readme|conformance> [args]')
    process.exit(2)
}
process.exit(ok ? 0 : 1)
