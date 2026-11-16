// LINE Messaging API の mock（api.line.me の代わり。vendor/dsh-im fork の試験用上書き CARE_DSH_IM_LINE_API_BASE で向ける）。
//   GET  /v2/bot/info                 → bot の userId（U + 32 hex）
//   POST /v2/bot/message/reply        → 記録して sentMessages を返す
//   POST /v2/bot/message/push         → 記録（X-Line-Retry-Key で重複判定：同じキーは 409）
//   POST /v2/bot/chat/loading/start   → 記録のみ
// あわせて、LINE プラットフォーム側の「webhook 送信」（署名付き）を作る helper も持つ。
import http from 'node:http'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

export const randomLineUserId = () => `U${randomBytes(16).toString('hex')}`

export function signLineBody(channelSecret, rawBody) {
  return createHmac('sha256', channelSecret).update(Buffer.from(rawBody, 'utf8')).digest('base64')
}

export async function startMockLine({ port = 0, channelAccessToken, botUserId = randomLineUserId(), host = '127.0.0.1', displayName = 'bridge test bot' }) {
  const log = [] // { kind: 'reply'|'push'|'loading'|'info', to?, replyToken?, messages?, retryKey?, authorized, at }
  const retryKeys = new Set()
  let seq = 0
  const waiters = new Set()
  const notify = () => { for (const w of [...waiters]) w() }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const url = new URL(req.url, 'http://x')
    const authorized = req.headers.authorization === `Bearer ${channelAccessToken}`
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (!authorized) {
      log.push({ kind: 'unauthorized', path: url.pathname, at: Date.now() })
      return send(401, { message: 'Authentication failed' })
    }
    const sent = (messages) => ({ sentMessages: (messages ?? []).map(() => ({ id: String(++seq), quoteToken: `q${seq}` })) })
    if (req.method === 'GET' && url.pathname === '/v2/bot/info') {
      log.push({ kind: 'info', at: Date.now() })
      return send(200, { userId: botUserId, basicId: '@mock-bot', displayName, chatMode: 'bot', markAsReadMode: 'auto' })
    }
    if (req.method === 'POST' && url.pathname === '/v2/bot/message/reply') {
      log.push({ kind: 'reply', replyToken: body?.replyToken, messages: body?.messages ?? [], at: Date.now() })
      notify()
      return send(200, sent(body?.messages))
    }
    if (req.method === 'POST' && url.pathname === '/v2/bot/message/push') {
      const retryKey = req.headers['x-line-retry-key']
      if (retryKey && retryKeys.has(retryKey)) {
        log.push({ kind: 'push-duplicate', to: body?.to, retryKey, at: Date.now() })
        return send(409, { message: 'The retry key is already accepted' })
      }
      if (retryKey) retryKeys.add(retryKey)
      log.push({ kind: 'push', to: body?.to, messages: body?.messages ?? [], retryKey: retryKey ?? null, at: Date.now() })
      notify()
      return send(200, sent(body?.messages))
    }
    if (req.method === 'POST' && url.pathname === '/v2/bot/chat/loading/start') {
      log.push({ kind: 'loading', chatId: body?.chatId, at: Date.now() })
      return send(202, {})
    }
    log.push({ kind: 'unknown', method: req.method, path: url.pathname, at: Date.now() })
    return send(404, { message: 'Not found' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port

  /** 条件に合う送信（reply / push）を待つ。since 以降のものだけを見る。 */
  async function waitForMessage(predicate, { since = 0, timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = log.find((e) => (e.kind === 'reply' || e.kind === 'push') && e.at >= since && predicate(e))
      if (hit) return hit
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise((resolve) => {
        const w = () => { waiters.delete(w); clearTimeout(t); resolve() }
        const t = setTimeout(w, Math.min(left, 500))
        waiters.add(w)
      })
    }
  }

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    botUserId,
    log,
    waitForMessage,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

/** LINE プラットフォームを真似て、署名付き webhook を公開パスに POST する。 */
export function lineWebhookSender({ url, channelSecret, botUserId }) {
  async function post(events, { signature } = {}) {
    const raw = JSON.stringify({ destination: botUserId, events })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature ?? signLineBody(channelSecret, raw) },
      body: raw,
    })
    const text = await res.text()
    return { status: res.status, body: text }
  }
  const common = (userId) => ({
    webhookEventId: `01E2E${randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    mode: 'active',
    source: { type: 'user', userId },
    replyToken: randomBytes(16).toString('hex'),
  })
  return {
    post,
    text: (userId, text, options) => {
      const event = { type: 'message', ...common(userId), message: { type: 'text', id: String(Date.now()) + Math.floor(Math.random() * 1000), quoteToken: 'q', text } }
      return post([event], options).then((r) => ({ ...r, event }))
    },
    postback: (userId, data, options) => {
      const event = { type: 'postback', ...common(userId), postback: { data } }
      return post([event], options).then((r) => ({ ...r, event }))
    },
  }
}

/** Flex Message（bubble）からテキストと postback ボタンを取り出す。 */
export function flexSummary(message) {
  const texts = []
  const buttons = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text)
    if (node.type === 'button' && node.action) buttons.push({ label: node.action.label, type: node.action.type, data: node.action.data ?? null, uri: node.action.uri ?? null })
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value)
  }
  walk(message?.contents)
  return { altText: message?.altText ?? '', texts, buttons }
}
