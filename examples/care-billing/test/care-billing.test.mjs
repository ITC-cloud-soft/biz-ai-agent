// Keeps examples/care-billing consistent: the manifest validates, the registry entry is accepted by @dsh-bridge/dsh-core and
// names the manifest's system id / namespace, and the reference tables of extensions/README.md equal the manifest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifestFile, parseYaml, validateManifest } from '@dsh-bridge/protocol'
import { applyCompat, createApplicationRegistry } from '@dsh-bridge/dsh-core'

const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const manifest = loadManifestFile(here('manifest/care-billing.manifest.yaml'))
const registry = parseYaml(readFileSync(here('registry/bridge-apps.yaml'), 'utf8'))
const entry = registry.find((p) => p.id === 'bridge-apps')
const configOf = (id) => registry.find((p) => p.id === id)?.config ?? {}
const app = entry.config.applications.find((a) => a.id === 'care-billing')
const extensions = readFileSync(here('extensions/README.md'), 'utf8')
const rowsOf = (heading) => {
  const section = extensions.split(/^## /m).find((s) => s.startsWith(heading)) ?? ''
  return section.split('\n').filter((l) => /^\| `/.test(l)).map((l) => l.split(' | ').map((c) => c.replace(/^\| /, '').replace(/ \|$/, '').trim()))
}

test('the manifest is valid and is ケアビリング (care-billing, namespace care)', () => {
  const v = validateManifest(manifest)
  assert.deepEqual(v.errors, [])
  assert.equal(manifest.system.id, 'care-billing')
  assert.ok(manifest.tools.every((t) => t.name.startsWith('care_')))
})

test('the registry entry names the manifest and is accepted by @dsh-bridge/dsh-core (with a second application sharing a personal WeChat bot)', () => {
  assert.equal(app.id, manifest.system.id)
  assert.equal(app.namespace, 'care')
  // the product profile runs on care-api's /api/ai/* routes: paths legacy, registered by the compatibility profile
  assert.equal(app.paths, 'legacy')
  assert.deepEqual(entry.config.compat, ['care-billing-paths'])
  applyCompat(entry.config)
  assert.ok(!('serviceToken' in app), 'never a token in the yml (serviceTokenEnv only)')
  assert.match(app.manifestFile, /^pkg:@dsh-bridge\/example-care-billing\/manifest\/care-billing\.manifest\.yaml$/)
  const pkgDir = dirname(here('package.json'))
  assert.ok(existsSync(resolve(pkgDir, app.manifestFile.replace('pkg:@dsh-bridge/example-care-billing/', ''))), 'the pkg: path exists')
  const weixin = app.bots.find((b) => b.platform === 'weixin')
  assert.equal(weixin.multiApp, true)
  const second = { id: 'equipment-inspection', name: '設備点検', namespace: 'facility', apiUrl: 'http://127.0.0.1:19730', bots: [{ platform: 'wecom-app', botId: 'eq-app' }, { ...weixin }] }
  const reg = createApplicationRegistry({ applications: [app, second], strict: entry.config.strict, logger: { info() {}, warn() {}, error() {}, debug() {} } })
  assert.deepEqual(reg.applicationsForBot({ platform: 'weixin', botId: weixin.botId }).map((a) => a.id).sort(), ['care-billing', 'equipment-inspection'])
  assert.equal(reg.resolveApplication({ platform: 'wecom-app', botId: 'eq-app' })?.id, 'equipment-inspection')
  assert.throws(() => createApplicationRegistry({ applications: [app, { ...second, bots: [{ platform: 'weixin', botId: weixin.botId }] }] }), /multiApp/)
})

test('extensions/README.md: the tool table equals the manifest tools (name, access, route, roles)', () => {
  const rows = rowsOf('Tools')
  const fromDoc = rows.map(([name, access, http, roles]) => ({ name: name.replace(/`/g, ''), access, http: http.replace(/`/g, ''), roles }))
  const fromManifest = manifest.tools.map((t) => ({ name: t.name, access: t.access, http: t.http ?? '', roles: (t.roles ?? []).join(', ') }))
  assert.deepEqual(fromDoc, fromManifest)
})

test('extensions/README.md: the template intent table covers exactly the manifest templates, with the same intent', () => {
  const rows = rowsOf('Notification templates')
  const doc = Object.fromEntries(rows.map(([t, intent]) => [t.replace(/`/g, ''), intent]))
  assert.deepEqual(Object.keys(doc).sort(), Object.keys(manifest.templates).sort())
  for (const [t, def] of Object.entries(manifest.templates)) assert.equal(doc[t].split('（')[0], def.intent ?? 'info', t) // a computed intent is annotated in parentheses
})

test('every care-ai-native link of the READMEs points at an existing file (when the repository is next to this one)', () => {
  const root = fileURLToPath(new URL('../../../../care-ai-native/', import.meta.url))
  if (!existsSync(root)) return
  for (const [file, base] of [['README.md', here('.')], ['extensions/README.md', here('extensions/')]]) {
    const text = readFileSync(here(file), 'utf8')
    for (const m of text.matchAll(/\]\((\.\.\/[^)#]+)\)/g)) {
      const target = resolve(base, m[1])
      assert.ok(existsSync(target), `${file}: ${m[1]}`)
    }
  }
})

test('the plugin entries name the care modules and keep the state names of the earlier care-* plugins', () => {
  assert.deepEqual(configOf('bridge-tools').toolModules, [{ module: '@care/dsh-care-tools', application: 'care-billing' }])
  assert.deepEqual(configOf('bridge-notify').templateModules, [{ module: '@care/dsh-care-notify', application: 'care-billing' }])
  assert.equal(configOf('bridge-notify').stateDomain, 'care_notify')
  assert.equal(configOf('bridge-events').stateDomain, 'care_events')
  assert.equal(configOf('bridge-approvals').stateDomain, 'care_approvals_im')
  assert.equal(configOf('bridge-approvals').actionPrefix, 'care_approval')
  assert.equal(configOf('bridge-assistant').rpcName, 'care-assistant')
})
