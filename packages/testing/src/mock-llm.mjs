// OpenAI Chat Completions 互換の mock（DSH の llm-pi-ai `openai-completions` 経路の相手）。@dsh-bridge/testing。
// 実モデルには一切つながない。応答は台本（script）で決める：
//   - 最後の user 発話の後に tool 結果が無い → 台本が tool call を返す（該当なしなら定型文）
//   - tool 結果がある → 台本がその結果から最終回答を作る
// stream:true（SSE、tool_calls の delta を含む）と stream:false の両方に対応。全リクエストを記録する。
import http from 'node:http'

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  return ''
}

/**
 * 現在のターン（直前の「tool call を含まない assistant 応答」より後）の user 発話と tool 結果。
 * DSH はユーザー本文の後に時刻などの文脈を別の user メッセージとして足すので、ターン内の user を全部つなぐ。
 */
export function conversationTail(messages = []) {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'assistant' && !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) { start = i + 1; break }
  }
  const turn = messages.slice(start)
  const userText = turn.filter((m) => m?.role === 'user').map((m) => textOf(m.content)).join('\n')
  const toolResults = turn.filter((m) => m?.role === 'tool').map((m) => ({ toolCallId: m.tool_call_id, content: textOf(m.content) }))
  const toolCalls = turn.filter((m) => m?.role === 'assistant').flatMap((m) => m.tool_calls ?? [])
  return { userText, toolResults, toolCalls }
}

/** 要求の tools から名前を探す（DSH が接頭辞を付けても末尾一致で拾う）。 */
export function findTool(body, name) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const names = tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean)
  return names.find((n) => n === name) ?? names.find((n) => n.endsWith(name)) ?? null
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * @param {object} options
 * @param {number} [options.port]   0 / 省略 = 空いているポート（返り値の url を使う）
 * @param {(ctx) => ({ toolCall?: {name, arguments}, text?: string })} options.script
 *   ctx = { body, userText, toolResults, toolCalls, findTool }
 * @param {string} [options.expectKey]  記録の authorized（Authorization: Bearer <expectKey> か）
 * @param {string} [options.model]      /models と応答の既定のモデル名（既定 'mock-model'）
 */
export async function startMockLlm({ port = 0, script, host = '127.0.0.1', expectKey, model: defaultModel = 'mock-model' }) {
  const requests = []
  let seq = 0
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: defaultModel, object: 'model', owned_by: 'dsh-bridge-testing' }] }))
      return
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let body = {}
    try { body = JSON.parse(raw) } catch { /* keep {} */ }
    const auth = String(req.headers.authorization ?? '')
    const tail = conversationTail(body.messages)
    let decision
    try {
      decision = script({ body, ...tail, findTool: (n) => findTool(body, n) }) ?? {}
    } catch (error) {
      decision = { text: `mock script error: ${error.message}` }
    }
    seq += 1
    const id = `chatcmpl-mock-${seq}`
    requests.push({
      at: new Date().toISOString(),
      id,
      authorized: expectKey ? auth === `Bearer ${expectKey}` : true,
      model: body.model,
      stream: body.stream === true,
      toolNames: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name),
      roles: (body.messages ?? []).map((m) => m?.role),
      userText: tail.userText,
      toolResults: tail.toolResults,
      decision,
    })
    const created = Math.floor(Date.now() / 1000)
    const model = body.model ?? defaultModel
    const toolCall = decision.toolCall
      ? { index: 0, id: `call_mock_${seq}`, type: 'function', function: { name: decision.toolCall.name, arguments: JSON.stringify(decision.toolCall.arguments ?? {}) } }
      : null
    const text = toolCall ? '' : String(decision.text ?? '')
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const base = { id, object: 'chat.completion.chunk', created, model }
      sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      if (toolCall) {
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ ...toolCall, function: { name: toolCall.function.name, arguments: '' } }] }, finish_reason: null }] })
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] }, finish_reason: null }] })
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      sseChunk(res, { ...base, choices: [], usage })
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: toolCall ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: text },
        finish_reason: toolCall ? 'tool_calls' : 'stop',
      }],
      usage,
    }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actualPort = server.address().port
  return {
    url: `http://${host}:${actualPort}/v1`,
    port: actualPort,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
