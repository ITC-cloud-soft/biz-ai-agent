// Unit tests of the mocks: each one is started on a free port, exercised over HTTP and closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDecipheriv, createHash } from 'node:crypto'
import {
  conversationTail, findTool, flexSummary, lineWebhookSender, signLineBody, startMockIlink, startMockLine, startMockLlm, startMockWecom,
  wecomEncrypt, randomEncodingAesKey,
} from '../src/index.mjs'

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function captureServer() {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.end('success')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('mock LLM: tool call first, then a final answer from the tool result (non-streaming and SSE)', async () => {
  const llm = await startMockLlm({
    expectKey: 'test-llm-key',
    script: ({ userText, toolResults, findTool: find }) => {
      if (toolResults.length) return { text: `answer: ${toolResults[0].content}` }
      const name = find('list_reports')
      return name ? { toolCall: { name, arguments: { status: 'all' } } } : { text: `echo ${userText}` }
    },
  })
  try {
    assert.match(llm.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const models = await (await fetch(`${llm.url}/models`)).json()
    assert.equal(models.data[0].id, 'mock-model')
    const tools = [{ type: 'function', function: { name: 'example_app_list_reports', parameters: {} } }]
    const first = await (await post(`${llm.url}/chat/completions`, { model: 'm', tools, messages: [{ role: 'user', content: '日報は？' }] }, { authorization: 'Bearer test-llm-key' })).json()
    const call = first.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'example_app_list_reports')
    assert.deepEqual(JSON.parse(call.function.arguments), { status: 'all' })
    const second = await (await post(`${llm.url}/chat/completions`, {
      model: 'm',
      tools,
      stream: true,
      messages: [{ role: 'user', content: '日報は？' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '3 件' }],
    })).text()
    assert.match(second, /"content":"answer: 3 件"/)
    assert.match(second, /data: \[DONE\]/)
    assert.equal(llm.requests.length, 2)
    assert.deepEqual(llm.requests.map((r) => r.authorized), [true, false])
    assert.equal(llm.requests[1].stream, true)
  } finally {
    await llm.close()
  }
})

test('conversationTail / findTool: only the current turn; suffix match of prefixed tool names', () => {
  const tail = conversationTail([
    { role: 'user', content: 'old' }, { role: 'assistant', content: 'done' },
    { role: 'user', content: [{ type: 'text', text: 'new' }] }, { role: 'user', content: 'ctx' },
  ])
  assert.equal(tail.userText, 'new\nctx')
  assert.equal(findTool({ tools: [{ function: { name: 'pfx__example_app_list_reports' } }] }, 'example_app_list_reports'), 'pfx__example_app_list_reports')
  assert.equal(findTool({}, 'x'), null)
})

test('mock LINE: bearer auth, reply / push with retry-key dedupe, signed webhooks, flex summary', async () => {
  const line = await startMockLine({ channelAccessToken: 'test-line-access-token' })
  const auth = { authorization: 'Bearer test-line-access-token' }
  try {
    assert.match(line.botUserId, /^U[0-9a-f]{32}$/)
    assert.equal((await fetch(`${line.url}/v2/bot/info`)).status, 401)
    assert.equal((await (await fetch(`${line.url}/v2/bot/info`, { headers: auth })).json()).userId, line.botUserId)
    const since = Date.now()
    const pushed = await post(`${line.url}/v2/bot/message/push`, { to: 'U1', messages: [{ type: 'text', text: 'hi' }] }, { ...auth, 'x-line-retry-key': 'k1' })
    assert.equal(pushed.status, 200)
    assert.equal((await post(`${line.url}/v2/bot/message/push`, { to: 'U1', messages: [] }, { ...auth, 'x-line-retry-key': 'k1' })).status, 409)
    const hit = await line.waitForMessage((e) => e.kind === 'push' && e.to === 'U1', { since, timeoutMs: 1000 })
    assert.equal(hit.messages[0].text, 'hi')
    assert.equal(await line.waitForMessage(() => false, { timeoutMs: 50 }), null)
  } finally {
    await line.close()
  }
  const hook = await captureServer()
  try {
    const sender = lineWebhookSender({ url: `${hook.base}/dsh-hooks/line`, channelSecret: 'test-secret', botUserId: 'Ubot' })
    const r = await sender.text('U2', '連携 123456')
    assert.equal(r.status, 200)
    const got = hook.seen[0]
    assert.equal(got.headers['x-line-signature'], signLineBody('test-secret', got.body))
    assert.equal(JSON.parse(got.body).events[0].message.text, '連携 123456')
  } finally {
    await hook.close()
  }
  const flex = flexSummary({ altText: 'alt', contents: { type: 'bubble', body: { contents: [{ type: 'text', text: '【承認のお願い】' }, { type: 'button', action: { type: 'postback', label: '承認', data: 'a=1' } }] } } })
  assert.deepEqual(flex, { altText: 'alt', texts: ['【承認のお願い】'], buttons: [{ label: '承認', type: 'postback', data: 'a=1', uri: null }] })
})

test('mock iLink (personal WeChat): QR confirm, long-poll delivers inbound messages, sendmessage is recorded', async () => {
  const ilink = await startMockIlink({ holdMs: 2000 })
  try {
    const qr = await (await post(`${ilink.url}/ilink/bot/get_bot_qrcode`, {})).json()
    assert.equal(qr.ret, 0)
    const status = await (await fetch(`${ilink.url}/ilink/bot/get_qrcode_status`)).json()
    assert.deepEqual([status.status, status.ilink_bot_id, status.baseurl, status.ilink_user_id], ['confirmed', ilink.accountId, ilink.url, ilink.ownerUserId])
    const auth = { authorization: `Bearer ${status.bot_token}` }
    const polling = post(`${ilink.url}/ilink/bot/getupdates`, {}, auth).then((r) => r.json())
    setTimeout(() => ilink.inbound('wxid_user', '#一覧', { quote: '【日報】未提出 1 件' }), 50)
    const updates = await polling
    assert.equal(updates.msgs[0].item_list[0].text_item.text, '#一覧')
    assert.equal(updates.msgs[0].item_list[0].ref_msg.message_item.text_item.text, '【日報】未提出 1 件')
    await post(`${ilink.url}/ilink/bot/sendmessage`, { msg: { to_user_id: 'wxid_user', context_token: 'c', item_list: [{ text_item: { text: 'ok' } }] } }, auth)
    const sent = await ilink.waitForSent((e) => e.to === 'wxid_user', { timeoutMs: 1000 })
    assert.deepEqual([sent.text, sent.authorized], ['ok', true])
  } finally {
    await ilink.close()
  }
})

test('mock WeCom: gettoken per app, message/send checks the token agent, callbacks are encrypted like WXBizMsgCrypt', async () => {
  const wecom = await startMockWecom({})
  try {
    const app = wecom.createApp(1000002)
    const bad = await (await fetch(`${wecom.url}/cgi-bin/gettoken?corpid=${wecom.corpId}&corpsecret=nope`)).json()
    assert.equal(bad.errcode, 40001)
    const { access_token: token } = await (await fetch(`${wecom.url}/cgi-bin/gettoken?corpid=${wecom.corpId}&corpsecret=${app.secret}`)).json()
    const ok = await (await post(`${wecom.url}/cgi-bin/message/send?access_token=${token}`, { touser: 'u1', agentid: 1000002, msgtype: 'text', text: { content: 'hi' } })).json()
    assert.equal(ok.errcode, 0)
    const wrong = await (await post(`${wecom.url}/cgi-bin/message/send?access_token=${token}`, { touser: 'u1', agentid: 1000003, text: { content: 'x' } })).json()
    assert.equal(wrong.errcode, 40014)
    assert.equal((await wecom.waitForSent((e) => e.text === 'hi', { timeoutMs: 500 })).to, 'u1')

    const cb = await captureServer()
    try {
      const r = await wecom.callback(app, `${cb.base}/wecom-app-callback/bot1/s`, 'u1', '連携 654321')
      assert.equal(r.status, 200)
      const got = cb.seen[0]
      const encrypt = /<Encrypt><!\[CDATA\[(.+?)\]\]><\/Encrypt>/.exec(got.body)[1]
      const sig = createHash('sha1').update([app.token, got.url.searchParams.get('timestamp'), got.url.searchParams.get('nonce'), encrypt].sort().join('')).digest('hex')
      assert.equal(got.url.searchParams.get('msg_signature'), sig)
      const key = Buffer.from(`${app.encodingAESKey}=`, 'base64')
      const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
      decipher.setAutoPadding(false)
      const plain = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()])
      const len = plain.readUInt32BE(16)
      assert.match(plain.subarray(20, 20 + len).toString('utf8'), /<Content><!\[CDATA\[連携 654321\]\]><\/Content>/)
      assert.equal(plain.subarray(20 + len, 20 + len + wecom.corpId.length).toString('utf8'), wecom.corpId)
    } finally {
      await cb.close()
    }
  } finally {
    await wecom.close()
  }
  assert.match(randomEncodingAesKey(), /^[A-Za-z0-9]{43}$/)
  assert.equal(typeof wecomEncrypt({ token: 't', encodingAESKey: randomEncodingAesKey(), corpId: 'c' }, '<xml/>', 1, 'n').signature, 'string')
})
