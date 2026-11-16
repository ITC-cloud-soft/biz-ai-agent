import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncReadme } from '../src/readme.mjs'

test('README.md generated table (check catalog) is up to date: run `bridge-validate readme --write`', async () => {
  assert.equal(await syncReadme({ write: false }), false)
})
