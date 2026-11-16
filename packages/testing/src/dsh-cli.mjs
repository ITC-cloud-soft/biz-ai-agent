// The DSH CLI that the demo (`pnpm demo`) and the end-to-end run (`pnpm e2e`) start: a local, version-pinned copy in
// <framework>/.dsh-cli/<version>/ (git-ignored), installed with npm on first use and reused afterwards.
// The user's global DSH (npm -g / pnpm -g) is never installed, upgraded or downgraded.
//
//   DSH_BIN=<path to @deepseek-ai/dsh/lib/bin.js>  use that CLI instead (a warning when its version is not the pinned one)
//
// The pinned version is profile/template/package.json dshBridge.expectedDsh.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const BIN = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']

/** The DSH version the framework is tested with (profile/template/package.json dshBridge.expectedDsh). */
export function expectedDshVersion(framework) {
  const manifest = JSON.parse(readFileSync(join(framework, 'profile', 'template', 'package.json'), 'utf8'))
  const version = manifest.dshBridge?.expectedDsh
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`profile/template/package.json dshBridge.expectedDsh is not a version: ${JSON.stringify(version)}`)
  return version
}

/** Version of the CLI at `bin` (`.../@deepseek-ai/dsh/lib/bin.js`), read from its package.json; undefined if unreadable. */
export function dshVersionAt(bin) {
  try {
    return JSON.parse(readFileSync(join(bin, '..', '..', 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** The local copy's bin.js for `version`, or undefined when it is not installed (completely) yet. */
export function localDshBin(framework, version) {
  const bin = join(framework, '.dsh-cli', version, ...BIN)
  return existsSync(bin) && dshVersionAt(bin) === version ? bin : undefined
}

/**
 * Install `@deepseek-ai/dsh@<version>` into <framework>/.dsh-cli/<version>/ unless it is there already.
 * npm installs into a temporary folder that is renamed only after a complete install, so an interrupted
 * install is never mistaken for a finished one.
 * @returns {string} the bin.js path
 */
export function ensureLocalDsh({ framework, version, log = console.log }) {
  if (!VERSION_RE.test(version)) throw new Error(`not a DSH version: ${JSON.stringify(version)}`)
  const found = localDshBin(framework, version)
  if (found) return found
  const root = join(framework, '.dsh-cli')
  const dir = join(root, version)
  const tmp = join(root, `${version}.installing-${process.pid}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ private: true, description: `local DSH CLI ${version} for pnpm demo / pnpm e2e` }, null, 2) + '\n')
  log(`• DSH ${version}: installing a local copy into .dsh-cli/${version} (once; about 2 minutes, ~900 MB). Your global DSH is not touched.`)
  // Fixed command (the version is validated above); a shell is needed for the Windows npm.cmd shim.
  const r = spawnSync(`npm install --no-audit --no-fund --loglevel=error @deepseek-ai/dsh@${version}`, {
    cwd: tmp, shell: true, stdio: ['ignore', 2, 2], windowsHide: true, // npm's output to stderr (stdout may carry JSON)
  })
  const bin = join(tmp, ...BIN)
  if (r.status !== 0 || dshVersionAt(bin) !== version) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`npm install @deepseek-ai/dsh@${version} failed (exit ${r.status}); check the network / npm registry and run again`)
  }
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmp, dir)
  return join(dir, ...BIN)
}

/**
 * The CLI to run: $DSH_BIN when it exists (a warning when it is not the pinned version), else the local copy
 * (installed on first use). Sets process.env.DSH_BIN so child processes (profile/scripts/install.mjs) use the same CLI.
 * @returns {{ bin: string, version: string | undefined, expected: string, source: 'DSH_BIN' | 'local' }}
 */
export function pickDshBin({ framework, env = process.env, log = console.log, warn = console.warn } = {}) {
  const expected = expectedDshVersion(framework)
  if (env.DSH_BIN) {
    if (!existsSync(env.DSH_BIN)) throw new Error(`DSH_BIN does not exist: ${env.DSH_BIN}`)
    const version = dshVersionAt(env.DSH_BIN)
    if (version !== expected) warn(`! DSH_BIN is DSH ${version ?? '(version unknown)'}; this framework is tested with ${expected} (unset DSH_BIN to use a local ${expected})`)
    return { bin: env.DSH_BIN, version, expected, source: 'DSH_BIN' }
  }
  const bin = ensureLocalDsh({ framework, version: expected, log })
  env.DSH_BIN = bin
  return { bin, version: expected, expected, source: 'local' }
}
