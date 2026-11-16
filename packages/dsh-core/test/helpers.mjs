// テスト用の偽の業務 API（node:http）。handler(req) → { status?, body?, raw?, headers? }。呼び出しは calls に記録。
import http from 'node:http'

export async function startFakeApi(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    const url = new URL(req.url, 'http://x')
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body }
    calls.push(call)
    let out
    try {
      out = (await handler(call)) ?? { status: 404, body: { ok: false, error: 'not_found' } }
    } catch (error) {
      out = { status: 500, body: { ok: false, error: String(error?.message ?? error) } }
    }
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) })
    res.end(out.status === 304 ? undefined : (out.raw ?? JSON.stringify(out.body ?? {})))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method)),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

export function makeSource(overrides = {}) {
  return {
    platform: 'slack',
    botId: 'B1',
    teamId: 'T1',
    userId: 'U100',
    conversationId: 'D100',
    conversationKind: 'direct',
    messageId: 'm1',
    at: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

/** 最小の有効な manifest（system.id = id）。 */
export function miniManifest(id, { tools = [], version = '2026-10-26', schemas } = {}) {
  const doc = {
    bridge: 1,
    version,
    system: { id, name: id, locale: 'ja-JP', timezone: 'Asia/Tokyo' },
    roles: { staff: { label: '職員', scope: 'all', delegation: 'propose' } },
    events: { 'order.created': { payload: ['orderId'], severity: 'info' } },
    tools,
  }
  if (schemas) doc.schemas = schemas
  return doc
}
