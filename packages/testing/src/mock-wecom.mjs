// WeCom（企業微信）の「自社開発アプリ」の mock（試験専用。本物の WeCom には一切つながない）。
//   - API（dsh-im の bot.bind の apiBaseUrl でこの mock に向ける）：gettoken・message/send を記録
//   - コールバック（WeCom → dsh-im）：callback() が受信メッセージを暗号化（WXBizMsgCrypt：AES-256-CBC + PKCS7(32) + SHA1 署名）して
//     dsh-im のコールバック URL（/wecom-app-callback/<botId>/<secret>）へ POST する
// 1 つの企業（corpId）に 2 つの自社開発アプリ（agentId）＝ 2 つの窓口。各アプリの secret / token / EncodingAESKey は毎回生成。
import http from 'node:http'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

/** 43 文字の EncodingAESKey（base64 の 32 バイトから末尾 = を除いたもの）。 */
export function randomEncodingAesKey() {
  for (;;) {
    const key = randomBytes(32).toString('base64').replace(/=+$/, '')
    if (/^[A-Za-z0-9]{43}$/.test(key)) return key
  }
}

function pkcs7(buf, block = 32) {
  const pad = block - (buf.length % block)
  return Buffer.concat([buf, Buffer.alloc(pad, pad)])
}

export function wecomEncrypt({ token, encodingAESKey, corpId }, plain, timestamp, nonce) {
  const key = Buffer.from(`${encodingAESKey}=`, 'base64')
  const msg = Buffer.from(plain, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msg.length, 0)
  const raw = pkcs7(Buffer.concat([randomBytes(16), len, msg, Buffer.from(corpId, 'utf8')]))
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypt = Buffer.concat([cipher.update(raw), cipher.final()]).toString('base64')
  const signature = createHash('sha1').update([token, String(timestamp), String(nonce), encrypt].sort().join('')).digest('hex')
  return { encrypt, signature }
}

const cdata = (v) => `<![CDATA[${String(v).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

export async function startMockWecom({ port = 0, host = '127.0.0.1', corpId = `wwmock${randomBytes(6).toString('hex')}` }) {
  const sent = [] // { at, agentId, to, text }
  const log = []
  const apps = new Map() // secret -> agentId
  const tokens = new Map() // access_token -> agentId
  let msgSeq = 7_000_000
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const url = new URL(req.url, `http://${host}:${server.address().port}`)
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/cgi-bin/gettoken') {
      const agentId = url.searchParams.get('corpid') === corpId ? apps.get(url.searchParams.get('corpsecret')) : null
      log.push({ kind: 'gettoken', at: Date.now(), agentId: agentId ?? null })
      if (!agentId) return json({ errcode: 40001, errmsg: 'invalid credential' })
      const token = `mock-wecom-${randomBytes(10).toString('hex')}`
      tokens.set(token, agentId)
      return json({ errcode: 0, errmsg: 'ok', access_token: token, expires_in: 7200 })
    }
    if (url.pathname === '/cgi-bin/message/send') {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
      const tokenAgent = tokens.get(url.searchParams.get('access_token'))
      const entry = { at: Date.now(), agentId: String(body.agentid ?? ''), tokenAgent: tokenAgent ?? null, to: body.touser, text: body.text?.content ?? '' }
      sent.push(entry)
      log.push({ kind: 'send', ...entry })
      if (!tokenAgent || tokenAgent !== entry.agentId) return json({ errcode: 40014, errmsg: 'invalid access_token' })
      msgSeq += 1
      return json({ errcode: 0, errmsg: 'ok', msgid: `mock-wecom-out-${msgSeq}` })
    }
    log.push({ kind: 'other', at: Date.now(), path: url.pathname })
    json({ errcode: 0, errmsg: 'ok' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port

  /** 自社開発アプリを 1 つ作る（bot.bind に渡す資格情報。試験値）。 */
  function createApp(agentId) {
    const app = {
      corpId,
      agentId: String(agentId),
      secret: `mockSecret${randomBytes(18).toString('hex')}`,
      token: `mockToken${randomBytes(8).toString('hex')}`,
      encodingAESKey: randomEncodingAesKey(),
    }
    apps.set(app.secret, app.agentId)
    return app
  }

  /** WeCom の利用者がそのアプリに送った文字メッセージを、コールバック URL へ暗号化して POST する。 */
  async function callback(app, callbackUrl, fromUserId, text) {
    msgSeq += 1
    const msgId = String(msgSeq)
    const createTime = Math.floor(Date.now() / 1000)
    const plain = `<xml><ToUserName>${cdata(corpId)}</ToUserName><FromUserName>${cdata(fromUserId)}</FromUserName><CreateTime>${createTime}</CreateTime><MsgType>${cdata('text')}</MsgType><Content>${cdata(text)}</Content><MsgId>${msgId}</MsgId><AgentID>${app.agentId}</AgentID></xml>`
    const timestamp = String(createTime)
    const nonce = randomBytes(6).toString('hex')
    const { encrypt, signature } = wecomEncrypt(app, plain, timestamp, nonce)
    const body = `<xml><ToUserName>${cdata(corpId)}</ToUserName><Encrypt>${cdata(encrypt)}</Encrypt><AgentID>${cdata(app.agentId)}</AgentID></xml>`
    const url = new URL(callbackUrl)
    url.searchParams.set('msg_signature', signature)
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('nonce', nonce)
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml' }, body })
    log.push({ kind: 'callback', at: Date.now(), agentId: app.agentId, from: fromUserId, text, status: res.status })
    return { status: res.status, msgId }
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
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    corpId,
    sent,
    log,
    createApp,
    callback,
    waitForSent,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
