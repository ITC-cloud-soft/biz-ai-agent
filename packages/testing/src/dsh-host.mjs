// DSH 本体（launch token で認証）への最小クライアント。試験で会話を作る・dsh-im の管理 RPC・auto-tasks の HTTP を呼ぶために使う。
//   - GET /?token=<launch token> → 303 + Set-Cookie（@dsh-bridge/gateway と同じ交換）
//   - POST /api/<method> {type:'client-request', rpcId, method, payload}（vendor/dsh-im の harness-client と同じ形）
// トークン・cookie はログに出さない。
import http from 'node:http'
import { randomUUID } from 'node:crypto'

function request({ port, method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(30_000, () => req.destroy(new Error(`DSH ${method} ${path} timed out`)))
    req.on('error', reject)
    req.end(body)
  })
}

export async function dshHostClient({ port, token }) {
  const exchanged = await request({ port, method: 'GET', path: `/?token=${encodeURIComponent(token)}`, headers: { accept: 'text/html' } })
  const cookies = [].concat(exchanged.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter(Boolean)
  if (exchanged.status !== 303 || cookies.length === 0) throw new Error(`DSH launch-token exchange failed (HTTP ${exchanged.status})`)
  const cookie = cookies.join('; ')

  /** DSH host API（session.create 等）。結果は {ok, value?, error?}。 */
  async function rpc(method, payload = {}) {
    const rpcId = `test-${randomUUID()}`
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
    const res = await request({
      port, method: 'POST', path: `/api/${method}`,
      headers: { cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), accept: 'application/json' },
      body,
    })
    let message = null
    try { message = JSON.parse(res.text) } catch { /* keep null */ }
    if (res.status !== 200 || message?.type !== 'server-response' || message.rpcId !== rpcId || !message.result) {
      return { ok: false, error: { code: `http_${res.status}`, message: res.text.slice(0, 300) } }
    }
    return message.result
  }

  /**
   * dsh-im の管理 RPC（設定画面と同じ経路：POST /api/<channel> {method: <channel>, payload: {method, payload}}）。
   * 例：imManagement('dsh-im/dsh-im-delivery', 'target.create', {botId, target}) = 「IM bots › 配信先」の登録。
   */
  async function imManagement(channel, method, payload) {
    return rpc(channel, { method, payload })
  }

  /** auto-tasks の HTTP（ループバック + x-auto-tasks-client）。 */
  async function autoTasks(method, path, body) {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const res = await request({
      port, method, path: `/auto-tasks/api${path}`,
      headers: {
        cookie, accept: 'application/json', 'x-auto-tasks-client': 'cli',
        ...(raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }),
      },
      body: raw,
    })
    let data = null
    try { data = JSON.parse(res.text) } catch { data = res.text }
    return { status: res.status, data }
  }

  return { rpc, imManagement, autoTasks }
}
