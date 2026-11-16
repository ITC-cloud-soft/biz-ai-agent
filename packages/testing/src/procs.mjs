// 子プロセス・待機・ポートのヘルパー（試験専用）。自分が起動したプロセスだけを止める。
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { createWriteStream } from 'node:fs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 子プロセスに渡さない環境変数（実モデルの API キー・実トークン・DB・既存の DSH / Bridge / ケアビリングの設定）。 */
export const SECRET_ENV_RE = /(API_?KEY|ACCESS_?TOKEN|_TOKEN$|SECRET|PASSWORD|OPENAI|DEEPSEEK|ANTHROPIC|AZURE_OPENAI|GEMINI|MOONSHOT|DASHSCOPE|BEDROCK|AWS_|DATABASE_URL|^DSH_|^BRIDGE_|^CARE_)/i

/**
 * 秘密らしい環境変数を落とした env（実モデルの API キー・実トークンを子プロセスに渡さない）。extra は最後に足す（落とさない）。
 * @param {object} [extra]
 * @param {{ drop?: RegExp, source?: object }} [options]  drop：追加で落とす名前（例 /^MYAPP_/）、source：既定 process.env
 */
export function sanitizedEnv(extra = {}, { drop: extraDrop, source = process.env } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SECRET_ENV_RE.test(key) && !(extraDrop && extraDrop.test(key))) env[key] = value
  }
  return { ...env, ...extra }
}

export async function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`)
    }
    await sleep(stepMs)
  }
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }
}

/**
 * 子プロセスを起動し、stdout/stderr を（redact して）ログファイルに流す。
 * onLine は stdout の各行（redact 前）を受け取る。
 */
export function startProcess(name, command, args, { cwd, env, logFile, redact = (s) => s, onLine } = {}) {
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const tail = []
  const remember = (line) => {
    tail.push(line)
    if (tail.length > 200) tail.shift()
  }
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      onLine?.(line)
      const safe = redact(line)
      remember(safe)
      log?.write(`[${name}] ${safe}\n`)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue
      const safe = redact(line)
      remember(`! ${safe}`)
      log?.write(`[${name}!] ${safe}\n`)
    }
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  return {
    name,
    child,
    tail,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        killTree(child)
        await Promise.race([exited, sleep(8000)])
      }
      await new Promise((resolve) => (log ? log.end(resolve) : resolve()))
    },
  }
}
