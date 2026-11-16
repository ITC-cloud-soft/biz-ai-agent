#!/usr/bin/env node
// The closed product values of a DSH product profile (docs/ARCHITECTURE.md §7.2 / §7.4, docs/GUIDELINE.md d.8): every outbound
// switch has the product value, no open value is written, the bundled coding presets stay disabled, no template placeholder is
// left. The shipped template (profile/template) and every business system's own profile (copied from it) are checked the same way.
//
//   node profile/scripts/check.mjs <cordis.patch.yml> [--allow <rule>,...] [--template]      (bin: dsh-bridge-profile-check)
//   exit 0 ok, 1 findings, 2 usage
//
// --allow names the open values the product chose on purpose (an opt-in is an explicit, reviewed change): e.g.
// --allow groupChat for a product whose AI answers in group conversations. The rule names are those of OPEN_VALUES.
// --template: the template itself (its <placeholders> are expected).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { splitTopLevel } from './patch-preserve.mjs'

export const GROUP_CHAT_GUIDE = '業務の内容は個別チャットでお尋ねください。' // @dsh-bridge/dsh-core GROUP_CHAT_GUIDE

/** entry id -> the lines its uncommented body must have (a value of the config, or under applications.<id>: indented 4 or more). */
export const CLOSED_VALUES = Object.freeze({
  'xmanrui-dsh-im': [/^ {4,}forwardPluginSources: \[\]$/m],
  'dsh-proactive': [/^ {2}name: '@care\/dsh-proactive'$/m, /^ {4,}modelTools: reclaim$/m, /^ {4,}deliveryGuard: required$/m],
  'dsh-auto-tasks': [/^ {2}name: '@care\/dsh-auto-tasks'$/m, /^ {4,}restrictDelivery: true$/m, /^ {4,}mail: false$/m],
  'bridge-identity': [/^ {4,}groupChat: deny$/m, new RegExp(`^ {4,}messages:\\n {6,}groupChat: '${GROUP_CHAT_GUIDE}'$`, 'm')],
  'bridge-tools': [/^ {4,}groupChat: deny$/m],
  'bridge-notify': [/^ {4,}audienceFallback: none$/m, /^ {4,}audienceText: template$/m, /^ {4,}proactiveDelivery: deny$/m, /^ {4,}aiReportGuard: screen$/m],
})

/** rule -> a value that opens the product (never in a product profile unless --allow names the rule). */
export const OPEN_VALUES = Object.freeze({
  forwardPluginSources: /forwardPluginSources: \[[^\]]+\]/,
  modelTools: /modelTools: (all|own)\b/,
  deliveryGuard: /deliveryGuard: optional/,
  restrictDelivery: /restrictDelivery: false/,
  mail: /^\s*mail: true/m,
  groupChat: /groupChat: allow/,
  audienceFallback: /audienceFallback: channels/,
  audienceText: /audienceText: summary/,
  proactiveDelivery: /proactiveDelivery: allow/,
  aiReportGuard: /aiReportGuard: off/,
  // the installer writes the delegation of automatic tasks into the INSTALLED patch (--auto-task-delegate); not in the source
  unattendedPolicy: /unattendedPolicy: delegate/,
  fixedDelivery: /delivery:\s*\{?\s*channels/,
})

/** The bundled DSH coding presets: each must stay disabled (`- id: <id>` followed by `disabled: true`). */
export const DISABLED_PRESETS = Object.freeze(['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'])

const LINE_BREAK = /\r?\n/
const uncommented = (lines) => lines.filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, ''))

/** Check the text of a product profile patch. Returns { ok, findings: [{ rule, entry?, message }] }. */
export function checkProfilePatch(text, { allow = [], template = false } = {}) {
  const findings = []
  const items = splitTopLevel(text).items
  const entry = (id) => items.filter((item) => item.lines.some((l) => l === `- id: ${id}`))
  for (const [id, patterns] of Object.entries(CLOSED_VALUES)) {
    const found = entry(id)
    if (found.length !== 1) { findings.push({ rule: 'entry', entry: id, message: `exactly one top-level entry "- id: ${id}" is expected (found ${found.length})` }); continue }
    const body = uncommented(found[0].lines).join('\n')
    for (const re of patterns) {
      if (!re.test(body)) findings.push({ rule: 'closed_value', entry: id, message: `${id} must have the closed product value ${re}` })
    }
  }
  const live = uncommented(text.split(LINE_BREAK)).join('\n')
  for (const [rule, re] of Object.entries(OPEN_VALUES)) {
    if (!allow.includes(rule) && re.test(live)) findings.push({ rule, message: `open value written (${re}); an opt-in needs --allow ${rule} and a review` })
  }
  for (const id of DISABLED_PRESETS) {
    const found = entry(id)
    if (found.length && !uncommented(found[0].lines).some((l) => /^\s+disabled: true$/.test(l))) {
      findings.push({ rule: 'coding_preset', entry: id, message: `${id} (a bundled coding preset with shell / file tools) must stay disabled: true` })
    }
  }
  if (!template) {
    for (const l of uncommented(text.split(LINE_BREAK)).filter((x) => /:\s*<[^>]+>/.test(x))) {
      findings.push({ rule: 'placeholder', message: `template placeholder left: ${l.trim()}` })
    }
    // the link guard needs a business web URL for EVERY application of bridge-apps (webUrl: the default one, webUrls.<id>: the
    // others); without it that application's AI answers keep every link (fail open)
    const apps = entry('bridge-apps')
    const appLines = apps.length === 1 ? uncommented(apps[0].lines) : []
    const ids = []
    let defaultId = null
    for (let i = 0; i < appLines.length; i += 1) {
      const m = /^ {6}- id: ([a-z][a-z0-9-]*)$/.exec(appLines[i])
      if (!m) continue
      ids.push(m[1])
      for (let j = i + 1; j < appLines.length && !/^ {6}- /.test(appLines[j]) && /^ {8}/.test(appLines[j]); j += 1) {
        if (/^ {8}default: true$/.test(appLines[j])) defaultId = m[1]
      }
    }
    if (ids.length === 1 && !defaultId) defaultId = ids[0]
    const identity = entry('bridge-identity')
    const guard = identity.length === 1 ? (/^ {4}linkGuard:\n((?: {6,}.*\n?)*)/m.exec(uncommented(identity[0].lines).join('\n'))?.[1] ?? '') : ''
    for (const id of ids) {
      const ok = id === defaultId ? /^ {6}webUrl: \S/m.test(guard) || new RegExp(`(^ {8}|[{,]\\s*)${id}: \\S`, 'm').test(guard)
        : new RegExp(`(^ {8}|[{,]\\s*)${id}: \\S`, 'm').test(guard)
      if (!ok) {
        findings.push({ rule: 'link_guard', entry: 'bridge-identity', message: `application ${id} has no link-guard URL (${id === defaultId ? 'linkGuard.webUrl' : `linkGuard.webUrls.${id}`}): its AI answers would keep every link` })
      }
    }
  }
  return { ok: findings.length === 0, findings }
}

function main(argv) {
  const args = [...argv]
  const template = args.includes('--template')
  if (template) args.splice(args.indexOf('--template'), 1)
  const allowAt = args.indexOf('--allow')
  const allow = allowAt >= 0 ? String(args.splice(allowAt, 2)[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []
  const unknown = allow.filter((r) => !(r in OPEN_VALUES))
  if (args.length !== 1 || unknown.length) {
    console.error(`usage: check.mjs <cordis.patch.yml> [--allow <rule>,...] [--template]   rules: ${Object.keys(OPEN_VALUES).join(', ')}${unknown.length ? `\nunknown rule: ${unknown.join(', ')}` : ''}`)
    return 2
  }
  let text
  try { text = readFileSync(args[0], 'utf8') } catch (error) { console.error(`cannot read ${args[0]}: ${error.code ?? error.message}`); return 2 }
  const r = checkProfilePatch(text, { allow, template })
  for (const f of r.findings) console.log(`FAIL  ${f.entry ? `${f.entry}: ` : ''}${f.message} [${f.rule}]`)
  console.log(r.ok ? `ok   ${args[0]} (closed product values${allow.length ? `; allowed: ${allow.join(', ')}` : ''})` : `${r.findings.length} finding(s) in ${args[0]}`)
  return r.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
