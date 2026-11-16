// DSH の起動トークン（launch token）の取得方法。
//
// DSH 0.2.2-rc.1 はプロセスごとにランダムなトークンを生成し、設定で固定できない
// （packages/client/connection/src/browser-auth.ts）。外部に出る唯一の経路は
// `dsh web` が stdout に出す 1 行 `dsh web: <advertised-url>?token=...` で、
// web-app は「supervisor はこの行を観測したら RPC してよい」と明記している
// （packages/bundle/web-app/src/index.ts の announceReady）。
// `DSH_WEB_URL` 環境変数は shell ツール向けで、トークンを含まない。
//
// したがって本命は supervise()（BFF が DSH を子プロセスとして管理して stdout を読む）。
// fromFile() は「DSH の stdout をファイルに流している」構成（systemd / コンテナログ / 手動起動）向け、
// fromEnv() は外部のラッパーがトークンを環境変数で渡す構成向け。
// いずれも async () => string を返し、ゲートウェイは交換に失敗したら再度呼び出す。

import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const URL_LINE = /dsh web: (\S+)/g
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/

/**
 * Extract the launch token from a `dsh web:` line, a URL, or a bare token.
 * The LAST `dsh web:` line wins (a log file may span several restarts).
 * @param {string} text
 * @returns {string | undefined}
 */
export function parseLaunchToken(text) {
  if (typeof text !== 'string') return undefined
  const lines = [...text.matchAll(URL_LINE)]
  const candidate = lines.length > 0 ? lines[lines.length - 1][1] : text.trim()
  if (!candidate) return undefined
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const token = new URL(candidate).searchParams.get('token')
      return token && TOKEN_RE.test(token) ? token : undefined
    } catch {
      return undefined
    }
  }
  return TOKEN_RE.test(candidate) ? candidate : undefined
}

/** Replace any token value in a log line before it is printed elsewhere. */
export function redactToken(text) {
  return String(text).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
}

/**
 * Launch token from an environment variable holding a token or a URL with `?token=`.
 * @param {string} [name]
 */
export function fromEnv(name = 'DSH_LAUNCH_TOKEN', env = process.env) {
  return async function launchTokenFromEnv() {
    const token = parseLaunchToken(env[name] ?? '')
    if (!token) throw new Error(`dsh-gateway: environment variable ${name} carries no DSH launch token`)
    return token
  }
}

/**
 * Launch token read (on every call) from a file: a captured DSH stdout log
 * (the last `dsh web:` line wins) or a file containing just the token / URL.
 * @param {string} path
 */
export function fromFile(path) {
  return async function launchTokenFromFile() {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (cause) {
      throw new Error(`dsh-gateway: cannot read DSH launch token file ${path} (${cause.code ?? cause.message})`)
    }
    const token = parseLaunchToken(text)
    if (!token) throw new Error(`dsh-gateway: no DSH launch token found in ${path}`)
    return token
  }
}

/** Fixed token, for tests. */
export function fromValue(token) {
  return async () => token
}

/**
 * Locate the installed dsh CLI entry (`@deepseek-ai/dsh/lib/bin.js`) so it can be
 * spawned with `process.execPath` directly. Spawning the Windows `.cmd` shim
 * would need a shell, and killing that shell orphans the real DSH process.
 * Order: $DSH_BIN, then `pnpm root -g`, then `npm root -g`.
 * @returns {string | undefined}
 */
export function resolveDshBin(env = process.env) {
  if (env.DSH_BIN && existsSync(env.DSH_BIN)) return env.DSH_BIN
  for (const pm of ['pnpm', 'npm']) {
    // Fixed command string (no user input); a shell is needed for the Windows .cmd shims.
    const r = spawnSync(`${pm} root -g`, { encoding: 'utf8', shell: true, windowsHide: true })
    const root = (r.stdout || '').trim().split(/\r?\n/).pop()
    if (root) {
      const bin = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
  }
  return undefined
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

/**
 * Run DSH as a supervised child process and read its launch token from stdout.
 *
 * Returns a launchToken function (async () => token) with extra members:
 *   .start() / .stop()  — lifecycle (start is implicit on the first call)
 *   .ready              — Promise resolving to the token of the current child
 *   .child              — current ChildProcess (or null)
 *
 * The child is restarted after an unexpected exit (restartDelayMs, doubling up to 30s).
 * Every forwarded log line is redacted; the token never reaches the logger.
 *
 * @param {object} options
 * @param {string} options.command   executable (default process.execPath)
 * @param {string[]} options.args    e.g. [resolveDshBin(), '--profile', '<profile>', '--no-open', ...]
 * @param {Record<string,string>} [options.env]   merged over process.env
 * @param {string} [options.cwd]
 * @param {number} [options.readyTimeoutMs]  default 120000
 * @param {boolean} [options.restart]        default true
 * @param {number} [options.restartDelayMs]  default 1000
 * @param {{info:Function,warn:Function,error:Function}} [options.logger]
 */
export function supervise({
  command = process.execPath,
  args = [],
  env = {},
  cwd,
  readyTimeoutMs = 120000,
  restart = true,
  restartDelayMs = 1000,
  logger = console,
} = {}) {
  let child = null
  let stopped = false
  let delay = restartDelayMs
  let current // { promise, resolve, reject, settled }

  function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    promise.catch(() => {})
    const d = { promise, settled: false }
    d.resolve = (v) => { if (!d.settled) { d.settled = true; resolve(v) } }
    d.reject = (e) => { if (!d.settled) { d.settled = true; reject(e) } }
    return d
  }

  function launch() {
    current = deferred()
    const mine = current
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = proc
    const timer = setTimeout(() => {
      mine.reject(new Error(`dsh-gateway: DSH did not print its URL line within ${readyTimeoutMs}ms`))
    }, readyTimeoutMs)
    timer.unref?.()
    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('dsh web: ')) {
          const token = parseLaunchToken(line)
          if (token) {
            clearTimeout(timer)
            delay = restartDelayMs
            // 起動が readyTimeoutMs を超えて一度失敗にした後でも、同じ子プロセスが準備できたら以降の呼び出しは成功させる
            if (mine.settled && current === mine) {
              current = deferred()
              current.resolve(token)
            } else mine.resolve(token)
          }
        }
        logger.info?.(`[dsh] ${redactToken(line)}`)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line) logger.warn?.(`[dsh] ${redactToken(line)}`)
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      mine.reject(new Error(`dsh-gateway: failed to start DSH (${error.message})`))
    })
    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (child === proc) child = null
      mine.reject(new Error(`dsh-gateway: DSH exited (code=${code}, signal=${signal}) before becoming ready`))
      if (stopped) return
      logger.warn?.(`[dsh-gateway] DSH exited (code=${code}, signal=${signal})${restart ? `; restarting in ${delay}ms` : ''}`)
      if (restart) {
        const wait = delay
        delay = Math.min(delay * 2, 30000)
        // Callers awaiting the token keep waiting for the replacement child.
        current = deferred()
        const next = current
        setTimeout(() => {
          if (stopped) return next.reject(new Error('dsh-gateway: supervisor stopped'))
          launch()
          current.promise.then(next.resolve, next.reject)
        }, wait).unref?.()
      }
    })
  }

  async function launchToken() {
    if (stopped) throw new Error('dsh-gateway: supervisor stopped')
    if (!current) launch()
    return current.promise
  }
  launchToken.start = () => { if (!current && !stopped) launch(); return launchToken.ready }
  launchToken.stop = async () => {
    stopped = true
    const proc = child
    child = null
    current?.reject(new Error('dsh-gateway: supervisor stopped'))
    if (proc && proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve))
      killTree(proc)
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    }
  }
  Object.defineProperty(launchToken, 'ready', { get: () => (current ? current.promise : launchToken()) })
  Object.defineProperty(launchToken, 'child', { get: () => child })
  return launchToken
}
