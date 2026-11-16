// M: the manifest endpoint and the manifest content.
import assert from 'node:assert/strict'
import { validateManifest } from '../../src/manifest.mjs'

export function register(s) {
  s.check('M1', 'GET /manifest (service token) returns a valid manifest with an etag; If-None-Match answers 304', async (c) => {
    const path = c.v1('/manifest')
    c.err(await c.api.get(path, c.as.anon()), 401, null, 'anonymous')
    const r = await c.api.get(path, c.as.service())
    c.ok(r, 200, 'manifest')
    const etag = r.headers.get('etag')
    assert.ok(etag, 'etag header')
    const v = validateManifest(r.body)
    assert.ok(v.valid, JSON.stringify(v.errors.slice(0, 5)))
    const cond = await c.target.send({ method: 'GET', path, headers: { ...c.as.service(), 'if-none-match': etag } })
    c.ok(cond, 304, 'conditional request')
  })

  s.check('M2', 'the manifest (served or from file) is valid: schema, cross references, no personal-data payload keys', async (c) => {
    const v = validateManifest(c.manifest())
    assert.ok(v.valid, `manifest from ${c.target.manifestSource}:\n  ${v.errors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n  ')}`)
  }, { requires: ['manifest'] })

  s.check('M3', 'the fixtures cover every role the manifest declares (so every delegation ceiling is probed)', async (c) => {
    const declared = Object.keys(c.manifest().roles).sort()
    assert.deepEqual([...c.fx.roles].sort(), declared, 'fixtures.roles must equal manifest.roles')
  }, { requires: ['manifest'] })
}
