// テスト用のモック：業務 API（node:http）・ctx.dshIm・ctx.storageDomain・ctx.autoTasks。
// plugins/* の test/ に同一内容でコピーしている（各 package を単体で試せるように）。データはすべて架空。
import http from 'node:http'

/**
 * 偽の業務 API。handler(req) → { status?, body?, raw? }。呼び出しは calls に記録。
 * req = { method, path, query, headers, body }
 */
export async function startFakeApi(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    const url = new URL(req.url, 'http://x')
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    }
    calls.push(call)
    let out
    try {
      out = (await handler(call)) ?? { status: 404, body: { error: 'not_found' } }
    } catch (error) {
      out = { status: 500, body: { error: String(error?.message ?? error) } }
    }
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
    res.end(out.raw ?? JSON.stringify(out.body ?? {}))
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

export function makeSource(overrides = {}) {
  return {
    platform: 'slack',
    botId: 'B1',
    teamId: 'T1',
    userId: 'U100',
    userName: 'tester',
    conversationId: 'D100',
    conversationKind: 'direct',
    messageId: 'm1',
    at: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

/** dsh-im fork（setAccessResolver / claimReplies / onAction / sendCard / updateCard / sourceForTurn）を真似た mock。 */
export function mockDshIm({ supportsDialog = true } = {}) {
  const state = {
    resolver: null,
    claims: [],
    actions: [],
    sent: [],
    updated: [],
    sessions: new Map(),
    bots: [{ id: 'B1', platform: 'slack' }, { id: 'W1', platform: 'weixin' }],
    dialogAnswer: '点検日を再確認してください',
  }
  const sentByKey = new Map()
  let ref = 0
  const dshIm = {
    sourceForTurn: (sessionId) => state.sessions.get(sessionId) ?? null,
    setAccessResolver(fn) {
      state.resolver = fn
      return () => { if (state.resolver === fn) state.resolver = null }
    },
    claimReplies(matcher, handler) {
      const entry = { matcher, handler }
      state.claims.push(entry)
      return { dispose: () => { state.claims = state.claims.filter((e) => e !== entry) } }
    },
    onAction(prefix, handler) {
      const entry = { prefix, handler }
      state.actions.push(entry)
      return () => { state.actions = state.actions.filter((e) => e !== entry) }
    },
    async sendCard(input) {
      if (sentByKey.has(input.idempotencyKey)) {
        return { messageRef: sentByKey.get(input.idempotencyKey), delivered: true, deduped: true }
      }
      ref += 1
      const messageRef = `ref-${ref}`
      sentByKey.set(input.idempotencyKey, messageRef)
      state.sent.push({ ...input, messageRef })
      return { messageRef, delivered: true, deduped: false }
    },
    async updateCard(messageRef, card) {
      state.updated.push({ messageRef, card })
    },
    listBots: async () => state.bots,
  }
  return {
    dshIm,
    state,
    /** 文字の受信を真似る。claim されたら返信の配列、されなければ null（agent 行き）。 */
    async reply(text, source) {
      const entry = state.claims.find((e) => e.matcher(text, source))
      if (!entry) return null
      const replies = []
      await entry.handler({ text, source, reply: async (t) => { replies.push(t) } })
      return replies
    },
    /** ボタン押下を真似る。 */
    async press(actionId, source, { value = '', messageRef = 'ref-1', dialogAnswer } = {}) {
      const entry = state.actions.find((e) => actionId.startsWith(e.prefix))
      if (!entry) throw new Error(`no action handler for ${actionId}`)
      const responses = []
      const event = { actionId, value, source, messageRef, respond: async (t) => { responses.push(t) } }
      if (supportsDialog) {
        event.openReasonDialog = async () => (dialogAnswer === undefined ? state.dialogAnswer : dialogAnswer)
      }
      await entry.handler(event)
      return responses
    },
  }
}

/** storage-domain の最小 mock（open(spec) → table/global/close）。 */
export function mockStorageDomain() {
  const units = new Map() // name -> { tables: Map<table, Map>, global }
  const open = new Set()
  return {
    units,
    async open(spec) {
      if (open.has(spec.name)) throw new Error(`domain '${spec.name}' is already open`)
      open.add(spec.name)
      let unit = units.get(spec.name)
      if (!unit) {
        unit = { tables: new Map(), global: null }
        units.set(spec.name, unit)
      }
      for (const table of Object.keys(spec.tables)) {
        if (!unit.tables.has(table)) unit.tables.set(table, new Map())
        for (const [, value] of unit.tables.get(table)) spec.tables[table].valueSchema.parse(value)
      }
      const tableHandle = (tableName) => {
        const map = unit.tables.get(tableName)
        if (!map) throw new Error(`unknown table ${tableName}`)
        return {
          get: (key) => map.get(key),
          has: (key) => map.has(key),
          entries: () => [...map.entries()][Symbol.iterator](),
          keys: () => [...map.keys()][Symbol.iterator](),
          values: () => [...map.values()][Symbol.iterator](),
          get size() { return map.size },
          put: async (key, value) => { map.set(key, structuredClone(value)) },
          delete: async (key) => map.delete(key),
          update: async (key, fn) => {
            if (!map.has(key)) throw new Error('missing-key')
            const next = fn(map.get(key))
            map.set(key, next)
            return next
          },
        }
      }
      return {
        name: spec.name,
        table: tableHandle,
        global: {
          get: () => unit.global ?? spec.global?.initial,
          set: async (value) => { unit.global = structuredClone(value) },
        },
        close: async () => { open.delete(spec.name) },
      }
    },
  }
}

export function mockAutoTasks() {
  const emitted = []
  return {
    emitted,
    autoTasks: {
      async emit(type, payload, dedupeKey) {
        emitted.push({ type, payload, dedupeKey })
        return { triggered: ['task-1'] }
      },
      list: async () => [],
      trigger: async () => ({ runId: 'r1', deduped: false }),
    },
  }
}

export const silentLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} })

/** 素の ctx（Cordis なし）。provide は ctx に生やす。 */
export function makeCtx(services = {}, extra = {}) {
  const disposers = []
  const listeners = new Map()
  const ctx = {
    ...services,
    logger: () => silentLogger(),
    provide(name, value) { ctx[name] = value },
    on(event, fn) {
      if (event === 'dispose') { disposers.push(fn); return () => {} }
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    ...extra,
  }
  ctx.dispose = async () => { for (const fn of disposers.splice(0).reverse()) await fn() }
  return ctx
}

export async function waitFor(predicate, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/**
 * dsh-im がボタン無しのカードを文字だけのプラットフォームで見せる順（空行なし）：
 * 件名 / 項目 / 本文 / リンク（ラベル: URL）/ textFallback / footer。
 */
export function cardText(card) {
  return [
    card.title, ...(card.fields ?? []).map((f) => `${f.label}: ${f.value}`), card.body,
    card.link ? `${card.link.label}: ${card.link.url}` : '', card.textFallback, card.footer,
  ].filter(Boolean).join('\n')
}
