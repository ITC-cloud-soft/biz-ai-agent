#!/usr/bin/env node
// 試験用 BFF：127.0.0.1:3190 で /dsh/* を隔離 DSH（127.0.0.1:3180）へ中継する。
// getSessionUser は固定の偽ユーザー admin（試験専用。本番の BFF は業務 API のログイン確認（例 GET /api/auth/me）で解決する）。
//
// 使い方（どちらか）:
//   A) 既に起動している DSH の stdout ログからトークンを読む
//      DSH_LOG=<repo>/.dsh-home/logs/dsh-3180.log node examples/trial-server.mjs
//   B) DSH を子プロセスとして起動・管理する（supervise）
//      DSH_SUPERVISE=1 node examples/trial-server.mjs
//
// 環境変数: PORT(3190) DSH_TARGET(http://127.0.0.1:3180) DSH_HOME(<repo>/.dsh-home) DSH_PROFILE(bridge)
//           BRIDGE_API_URL(http://127.0.0.1:8790。旧名 CARE_API_URL も読む)
//           TRIAL_USER_ROLE(admin) — staff 等にすると 403 を確認できる

import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshGateway, fromFile, readEnv, supervise, resolveDshBin } from '../src/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const PORT = Number(process.env.PORT || 3190)
const target = process.env.DSH_TARGET || 'http://127.0.0.1:3180'
const dshHome = process.env.DSH_HOME || join(repoRoot, '.dsh-home')
const role = process.env.TRIAL_USER_ROLE || 'admin'

let launchToken
if (process.env.DSH_SUPERVISE) {
  const bin = resolveDshBin()
  if (!bin) throw new Error('dsh CLI not found; set DSH_BIN to .../@deepseek-ai/dsh/lib/bin.js')
  const { port } = new URL(target)
  launchToken = supervise({
    command: process.execPath,
    args: [bin, '--profile', process.env.DSH_PROFILE || 'bridge', '--no-open', '--host', '127.0.0.1', '--port', port,
      '--public-url', `http://127.0.0.1:${PORT}/dsh/`],
    cwd: dshHome,
    env: {
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(dshHome, 'agents'),
      BRIDGE_DSH_WORKSPACE: join(dshHome, 'workspace'),
      BRIDGE_API_URL: readEnv(process.env, 'BRIDGE_API_URL') || 'http://127.0.0.1:8790',
    },
  })
  launchToken.start()
} else {
  launchToken = fromFile(process.env.DSH_LOG || join(dshHome, 'logs', 'dsh-3180.log'))
}

const gateway = createDshGateway({
  target,
  mountPath: '/dsh',
  getSessionUser: async () => ({ id: 'trial-admin', email: 'admin@trial.local', role }),
  launchToken,
})

const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>DSH 埋め込み試験</title>
<style>body{margin:0;font-family:system-ui,sans-serif}header{padding:8px 16px;background:#0f3b57;color:#fff}
iframe{border:0;width:100%;height:calc(100vh - 40px)}</style></head>
<body><header>業務 Web（試験）— AI・SNS 設定（DSH を iframe で表示）</header>
<iframe src="/dsh/" title="DSH 設定"></iframe></body></html>`

const server = http.createServer(async (req, res) => {
  try {
    if (await gateway.handleRequest(req, res)) return
  } catch (error) {
    console.error(error)
    if (!res.headersSent) { res.writeHead(500); res.end() }
    return
  }
  if (req.url === '/' || req.url === '/settings/ai') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' })
    return res.end(page)
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
server.on('upgrade', async (req, socket, head) => {
  if (await gateway.handleUpgrade(req, socket, head)) return
  socket.destroy()
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`trial gateway: http://127.0.0.1:${PORT}/  (iframe)  http://127.0.0.1:${PORT}/dsh/  (direct) -> ${target}`)
})

async function shutdown() {
  server.close()
  server.closeAllConnections?.()
  gateway.close()
  if (launchToken.stop) await launchToken.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
