// The pinned local DSH CLI of pnpm demo / pnpm e2e (src/dsh-cli.mjs). No network: the CLI is a fake bin.js + package.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshVersionAt, ensureLocalDsh, expectedDshVersion, localDshBin, pickDshBin } from '../src/index.mjs'

const FRAMEWORK = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function fakeFramework(expectedDsh) {
  const root = mkdtempSync(join(tmpdir(), 'fw-dsh-cli-'))
  mkdirSync(join(root, 'profile', 'template'), { recursive: true })
  writeFileSync(join(root, 'profile', 'template', 'package.json'), JSON.stringify({ dshBridge: { expectedDsh } }))
  return root
}
/** A fake installed CLI: <dir>/node_modules/@deepseek-ai/dsh/{package.json, lib/bin.js}. */
function fakeCli(dir, version) {
  const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(join(pkg, 'lib', 'bin.js'), '')
  return join(pkg, 'lib', 'bin.js')
}

test('expectedDshVersion: the profile template pin (and it is the version the framework is tested with)', () => {
  const pinned = JSON.parse(readFileSync(join(FRAMEWORK, 'profile', 'template', 'package.json'), 'utf8')).dshBridge.expectedDsh
  assert.equal(expectedDshVersion(FRAMEWORK), pinned)
  assert.match(pinned, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  const bad = fakeFramework('latest')
  try {
    assert.throws(() => expectedDshVersion(bad), /not a version/)
  } finally {
    rmSync(bad, { recursive: true, force: true })
  }
})

test('localDshBin: only a complete copy of exactly that version', () => {
  const root = fakeFramework('0.2.2-rc.1')
  try {
    assert.equal(localDshBin(root, '0.2.2-rc.1'), undefined)
    const bin = fakeCli(join(root, '.dsh-cli', '0.2.2-rc.1'), '0.2.2-rc.1')
    assert.equal(localDshBin(root, '0.2.2-rc.1'), bin)
    assert.equal(dshVersionAt(bin), '0.2.2-rc.1')
    // a folder named for one version holding another is not used
    fakeCli(join(root, '.dsh-cli', '0.2.2-rc.3'), '0.2.1-rc.2')
    assert.equal(localDshBin(root, '0.2.2-rc.3'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureLocalDsh: an existing local copy is reused (no install); a non-version is refused before npm runs', () => {
  const root = fakeFramework('0.2.2-rc.1')
  try {
    const bin = fakeCli(join(root, '.dsh-cli', '0.2.2-rc.1'), '0.2.2-rc.1')
    const logs = []
    assert.equal(ensureLocalDsh({ framework: root, version: '0.2.2-rc.1', log: (m) => logs.push(m) }), bin)
    assert.deepEqual(logs, [])
    assert.throws(() => ensureLocalDsh({ framework: root, version: '0.2.2 && echo x' }), /not a DSH version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pickDshBin: DSH_BIN wins (a warning when it is not the pinned version); otherwise the local copy, exported as DSH_BIN', () => {
  const root = fakeFramework('0.2.2-rc.1')
  try {
    const other = fakeCli(join(root, 'elsewhere'), '0.2.1-rc.2')
    const warnings = []
    const viaEnv = pickDshBin({ framework: root, env: { DSH_BIN: other }, warn: (m) => warnings.push(m) })
    assert.deepEqual(viaEnv, { bin: other, version: '0.2.1-rc.2', expected: '0.2.2-rc.1', source: 'DSH_BIN' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /DSH 0\.2\.1-rc\.2.*tested with 0\.2\.2-rc\.1/)

    assert.throws(() => pickDshBin({ framework: root, env: { DSH_BIN: join(root, 'missing.js') } }), /DSH_BIN does not exist/)

    const local = fakeCli(join(root, '.dsh-cli', '0.2.2-rc.1'), '0.2.2-rc.1')
    const env = {}
    const picked = pickDshBin({ framework: root, env, log: () => {} })
    assert.deepEqual(picked, { bin: local, version: '0.2.2-rc.1', expected: '0.2.2-rc.1', source: 'local' })
    assert.equal(env.DSH_BIN, local, 'child processes (install.mjs) get the same CLI')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
