// 個人 WeChat の iLink（ClawBot）API の mock（試験専用。本物の WeChat には一切つながない）。
// vendor/dsh-im fork の試験用上書き CARE_DSH_IM_WEIXIN_API_BASE（loopback のみ）でこの mock に向ける。
//
//   POST ilink/bot/get_bot_qrcode       → QR（QR コードの読み取りは即「確認済み」）
//   GET  ilink/bot/get_qrcode_status    → confirmed（bot_token・ilink_bot_id・baseurl = この mock・ilink_user_id = 所有者）
//   POST ilink/bot/getupdates           → ロングポーリング。inbound() で積んだメッセージを返す（無ければ最大 holdMs 待って空）
//   POST ilink/bot/sendmessage          → ボットの送信を記録（sent）
//   POST ilink/bot/getconfig / sendtyping / msg/notifystart … → { ret: 0 }
//
// 1 つのWeChat アカウント = 1 ボット（iLink の制約）。2 回目の QR コードの読み取りでも同じ ilink_bot_id を返す。
import http from 'node:http'
import { randomBytes } from 'node:crypto'

export async function startMockIlink({ port = 0, host = '127.0.0.1', accountId = `mock-bot-${randomBytes(4).toString('hex')}@im.bot`, ownerUserId = `mock-owner-${randomBytes(4).toString('hex')}@im.wechat`, botToken = `mock-ilink-${randomBytes(12).toString('hex')}`, holdMs = 15_000 }) {
  const log = [] // { kind, at, ... }
  const sent = [] // { at, to, text, contextToken, clientId }
  let queue = []
  let waiters = []
  let seq = 1_000
  let messageSeq = 0
  let origin = `http://${host}:${port}`

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const flushWaiters = () => {
    const pending = waiters
    waiters = []
    for (const w of pending) w()
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { body = {} }
    const url = new URL(req.url, origin)
    const path = url.pathname.replace(/^\/+/, '')
    const authorized = !req.headers.authorization || String(req.headers.authorization).includes(botToken)
    if (path === 'ilink/bot/get_bot_qrcode') {
      log.push({ kind: 'qrcode', at: Date.now() })
      return json(res, 200, { ret: 0, qrcode: `mock-qr-${randomBytes(6).toString('hex')}`, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/mock-ilink' })
    }
    if (path === 'ilink/bot/get_qrcode_status') {
      log.push({ kind: 'qrcode_status', at: Date.now() })
      return json(res, 200, { status: 'confirmed', bot_token: botToken, ilink_bot_id: accountId, baseurl: origin, ilink_user_id: ownerUserId })
    }
    if (path === 'ilink/bot/getupdates') {
      if (!authorized) return json(res, 200, { ret: -14, errmsg: 'token' })
      if (queue.length === 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, holdMs)
          waiters.push(() => { clearTimeout(timer); resolve() })
          req.on('close', () => { clearTimeout(timer); resolve() })
        })
      }
      const msgs = queue
      queue = []
      seq += 1
      return json(res, 200, { ret: 0, msgs, get_updates_buf: `mock-buf-${seq}` })
    }
    if (path === 'ilink/bot/sendmessage') {
      const msg = body?.msg ?? {}
      const text = (msg.item_list ?? []).map((i) => i?.text_item?.text ?? '').join('')
      const entry = { at: Date.now(), to: msg.to_user_id, text, contextToken: msg.context_token ?? null, clientId: msg.client_id ?? null, authorized }
      sent.push(entry)
      log.push({ kind: 'send', ...entry })
      return json(res, 200, { ret: 0 })
    }
    log.push({ kind: path, at: Date.now() })
    if (path === 'ilink/bot/getconfig') return json(res, 200, { ret: 0, typing_ticket: 'mock-typing' })
    return json(res, 200, { ret: 0 })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port
  origin = `http://${host}:${actualPort}`

  /** WeChat の利用者がボットに送った（quote = 引用したメッセージの本文）。iLink の message 形。 */
  function inbound(fromUserId, text, { quote } = {}) {
    messageSeq += 1
    // iLink の 64bit message_id（上位がミリ秒時刻）を真似る
    const messageId = (BigInt(Date.now()) << 22n | BigInt(messageSeq)).toString()
    const item = { type: 1, text_item: { text } }
    if (quote) item.ref_msg = { message_item: { type: 1, text_item: { text: quote } } }
    const message = {
      message_id: messageId,
      seq: messageSeq,
      message_type: 1,
      from_user_id: fromUserId,
      to_user_id: accountId,
      create_time_ms: Date.now(),
      context_token: `mock-ctx-${messageSeq}`,
      item_list: [item],
    }
    queue.push(message)
    log.push({ kind: 'inbound', at: Date.now(), from: fromUserId, text, quote: quote ?? null })
    flushWaiters()
    return message
  }

  async function waitForSent(predicate, { since = 0, timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = sent.find((e) => e.at >= since && predicate(e))
      if (hit) return hit
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  return {
    url: origin,
    port: actualPort,
    accountId,
    ownerUserId,
    log,
    sent,
    inbound,
    waitForSent,
    close: () => new Promise((resolve) => { flushWaiters(); server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
