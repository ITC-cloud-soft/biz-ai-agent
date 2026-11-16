// The shipped profile template is closed by default (docs/ARCHITECTURE.md §7.2 / §7.4, docs/GUIDELINE.md d.8): the product values
// of every outbound switch are written in profile/template/cordis.patch.yml, the same values as ケアビリングの製品 profile.
// A system that wants an open setting changes the line explicitly (opt in). The rules live in check.mjs (dsh-bridge-profile-check),
// which a business system runs on its own product profile.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkProfilePatch } from './check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TEXT = readFileSync(join(here, '..', 'template', 'cordis.patch.yml'), 'utf8')

test('template: every outbound switch has the closed product value, no open value, coding presets disabled', () => {
  const r = checkProfilePatch(TEXT, { template: true })
  assert.deepEqual(r.findings, [])
})

test('check: an open value, a removed closed value, an enabled coding preset and a left placeholder are found; --allow opts in', () => {
  const open = TEXT.replace(/^( {4})groupChat: deny$/m, '$1groupChat: allow')
  const r = checkProfilePatch(open, { template: true })
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['closed_value', 'groupChat'])
  assert.deepEqual(checkProfilePatch(open, { template: true, allow: ['groupChat'] }).findings.map((f) => f.rule), ['closed_value'])
  const coding = TEXT.replace(/^(- id: preset-standard\r?\n) {2}disabled: true$/m, '$1  disabled: false')
  assert.deepEqual(checkProfilePatch(coding, { template: true }).findings.map((f) => `${f.rule}:${f.entry}`), ['coding_preset:preset-standard'])
  // a copied template that still has <placeholders> is not a product profile yet
  assert.ok(checkProfilePatch(TEXT).findings.some((f) => f.rule === 'placeholder'))
  // a commented example is not a value
  assert.deepEqual(checkProfilePatch(`${TEXT}\n#     unattendedPolicy: delegate\n`, { template: true }).findings, [])
})

test('check: every application of bridge-apps needs a link-guard URL (webUrl: the default one, webUrls.<id>: the others)', () => {
  const filled = TEXT.replace(/<application-id>/g, 'room-app').replace(/<[^>\n]+>/g, 'x')
  const missing = checkProfilePatch(filled).findings.filter((f) => f.rule === 'link_guard')
  assert.deepEqual(missing.map((f) => f.message.split(' ')[1]), ['room-app'], 'the template has no linkGuard: the copied profile must write one')
  const withGuard = filled.replace(/^( {4})groupChat: deny\n( {4}messages:)/m, '$1groupChat: deny\n    linkGuard:\n      webUrl: https://rooms.example.com\n$2')
  assert.deepEqual(checkProfilePatch(withGuard).findings, [])
  // a second application without webUrls.<id> is found; with it, fine
  const two = withGuard.replace(/^( {6}- id: room-app\b.*\n)/m, '      - id: desk-app\n        name: Desk\n$1')
  assert.notEqual(two, withGuard)
  assert.deepEqual(checkProfilePatch(two).findings.map((f) => f.rule), ['link_guard'])
  const both = two.replace('      webUrl: https://rooms.example.com\n', '      webUrl: https://rooms.example.com\n      webUrls: { desk-app: https://desk.example.com }\n')
  assert.deepEqual(checkProfilePatch(both).findings, [])
})
