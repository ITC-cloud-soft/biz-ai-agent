// 隔離した DSH home（試験専用）と、それを使う DSH 子プロセスのヘルパー。
//
// 個人の ~/.dsh（利用者自身の DSH）には絶対に触れない：assertIsolatedHome が拒否する。
// 試験の home は <repo>/.dsh-home-<名前> のように作業ツリーの中に作る（.gitignore の .dsh-home*）。
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { sanitizedEnv, startProcess, waitFor } from './procs.mjs'

/** 前回の実行時状態（会話・連携キャッシュ・bot 資格情報・自動タスク・ログ）。profiles/（依存）は残す。 */
export const RUNTIME_STATE_ENTRIES = Object.freeze([
  'sessions', 'storages', 'integrations', 'im', 'auto-tasks', 'proactive', 'logs', 'workspace', 'agents', '.credentials.yaml',
])

/** 個人の DSH home の候補（USERPROFILE / HOME / os.homedir() の .dsh）。 */
export function personalDshHomes(env = process.env) {
  const bases = [env.USERPROFILE, env.HOME, homedir()].filter(Boolean)
  return [...new Set(bases.map((b) => resolve(b, '.dsh')))]
}

/** home が個人の ~/.dsh（またはその中）なら例外。 */
export function assertIsolatedHome(home, env = process.env) {
  if (!home) throw new Error('a DSH home is required (never the personal ~/.dsh)')
  const target = resolve(home)
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  for (const personal of personalDshHomes(env)) {
    if (norm(target) === norm(personal) || norm(target).startsWith(norm(personal) + sep)) {
      throw new Error(`refusing to use the personal DSH home (${personal})`)
    }
  }
  return target
}

/**
 * 隔離 home を用意する：個人 home の拒否、作成、（reset で）前回の実行時状態の削除、workspace / agents の作成。
 * @returns {{ home, agents, workspace }}
 */
export function prepareIsolatedHome(home, { reset = true, env = process.env } = {}) {
  const target = assertIsolatedHome(home, env)
  mkdirSync(target, { recursive: true })
  if (reset) for (const name of RUNTIME_STATE_ENTRIES) rmSync(join(target, name), { recursive: true, force: true })
  const agents = join(target, 'agents')
  const workspace = join(target, 'workspace')
  mkdirSync(agents, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  return { home: target, agents, workspace }
}

/** 隔離 home 用の子プロセスの env（秘密を落とし、DSH_HOME / DSH_AGENTS_HOME / BRIDGE_DSH_WORKSPACE を付ける）。 */
export function dshEnv(home, extra = {}, options = {}) {
  const target = assertIsolatedHome(home)
  return sanitizedEnv({
    DSH_HOME: target,
    DSH_AGENTS_HOME: join(target, 'agents'),
    BRIDGE_DSH_WORKSPACE: join(target, 'workspace'),
    ...extra,
  }, options)
}

/** `dsh web: http://...?token=...` の行から launch token。 */
export function launchTokenOf(line) {
  const m = /[?&]token=([A-Za-z0-9_-]{16,})/.exec(String(line))
  return m ? m[1] : null
}

/** ログに出す前に token / Bearer / 既知の秘密を伏せる。 */
export function redactor(secrets = []) {
  const values = secrets.filter((s) => typeof s === 'string' && s.length >= 6)
  return (line) => {
    let out = String(line).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    for (const v of values) out = out.split(v).join('<redacted>')
    return out
  }
}

/**
 * DSH を隔離 home で起動し、launch token を待つ。
 * @param {object} o
 * @param {string} o.bin          @deepseek-ai/dsh/lib/bin.js（@dsh-bridge/gateway の resolveDshBin()）
 * @param {string} o.home
 * @param {string} o.profile      製品 profile 名
 * @param {number} o.port
 * @param {string} [o.publicUrl]  --public-url
 * @param {string} [o.patch]      --patch（試験 overlay の yml）
 * @param {object} [o.env]        dshEnv に足す値（業務 API の URL・mock の URL など。試験値だけ）
 * @param {string} [o.logFile]
 * @param {string[]} [o.secrets]  ログで伏せる値
 * @returns {Promise<{ proc, token }>}
 */
export async function startDsh({ bin, home, profile, port, publicUrl, patch, env = {}, logFile, secrets = [], timeoutMs = 180_000 }) {
  if (!bin || !existsSync(bin)) throw new Error('dsh CLI not found (set DSH_BIN or install @deepseek-ai/dsh globally)')
  let token = null
  const args = [bin, '--profile', profile, ...(patch ? ['--patch', patch] : []), '--no-open', '--host', '127.0.0.1', '--port', String(port)]
  if (publicUrl) args.push('--public-url', publicUrl)
  const proc = startProcess('dsh', process.execPath, args, {
    cwd: assertIsolatedHome(home),
    env: dshEnv(home, env),
    logFile,
    redact: redactor(secrets),
    onLine: (line) => { if (line.startsWith('dsh web: ')) token = launchTokenOf(line) ?? token },
  })
  try {
    await waitFor(() => {
      if (proc.child.exitCode !== null) throw new Error(`DSH exited: ${proc.tail.slice(-8).join(' | ')}`)
      return token
    }, { timeoutMs, stepMs: 500, label: 'DSH launch line' })
  } catch (error) {
    await proc.stop()
    throw error
  }
  return { proc, token }
}

/** 試験に使うポートが空いていて、触れてはいけないポート（デモ環境など）でないことを確かめる。 */
export async function assertPortsUsable(ports, { forbidden = [], portFree } = {}) {
  const check = portFree ?? (await import('./procs.mjs')).portFree
  for (const port of Object.values(ports)) {
    if (forbidden.includes(Number(port))) throw new Error(`port ${port} is reserved and must not be used by tests`)
    if (!(await check(Number(port)))) throw new Error(`port ${port} is already in use`)
  }
}
