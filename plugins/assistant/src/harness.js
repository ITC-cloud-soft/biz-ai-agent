// DSH Host の Harness（Typert gateway）への薄いアダプタ。dsh-im（vendor/dsh-im/plugin-src/host/modern-harness-api.mjs）と同じ呼び方：
//   session.create {request: {workspaceId, agentPreset}} / session.prompt {request: {requestId, sessionId, mode:'queue', content}} /
//   session.cancel / session.rename、workspace は workspace.follow の baseline で探し、無ければ workspace.create。
// 呼び出し元は owner の peer（interactions: 'none'。アシスタントのプリセットは ask_user を持たない）。
// 画像：prompt の content に { type:'image', mediaType, data, name? }（DSH の PromptContentPart。DSH が検査・正規化・保存）。
// モデルが画像を読めるか：session.modelCatalog の default（新しい会話のモデル。preset はモデルを選ばない）を ctx.llm.resolveModelInfo で
// 調べ、inputModalities に image があるか（無い配列 = 読めない、inputModalities が無い = 分からない = null）。

function remote(namespace, method, args, peer) {
  return { namespace, method, args, ...(peer === undefined ? {} : { peer }) }
}

export function createHostHarness(ctx, { workspace = () => process.cwd(), timeZone = () => 'Asia/Tokyo', logger = console } = {}) {
  let peer
  function getPeer() {
    if (peer !== undefined) return peer ?? undefined
    const connection = ctx?.connection
    peer = typeof connection?.createPeer === 'function' ? connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' }) : null
    if (peer && typeof ctx.effect === 'function') ctx.effect(() => () => { try { peer?.dispose?.() } catch { /* noop */ } peer = undefined }, 'bridge-assistant: Harness caller')
    return peer ?? undefined
  }
  function gateway() {
    const gw = ctx?.typertGateway
    if (!gw || typeof gw.invoke !== 'function') throw Object.assign(new Error('DSH Host Typert gateway is not available'), { code: 'harness-unavailable' })
    return gw
  }
  const invoke = (namespace, method, args) => gateway().invoke(remote(namespace, method, args, getPeer()))

  async function baseline() {
    const gw = gateway()
    if (typeof gw.stream !== 'function') return null
    const controller = new AbortController()
    const source = await gw.stream({ ...remote('workspace', 'follow', {}, getPeer()), signal: controller.signal })
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      return first.done ? null : first.value?.type === 'baseline' ? first.value.value : null
    } finally {
      controller.abort()
      try { await iterator.return?.() } catch { /* closed */ }
    }
  }

  let workspaceIdCache = null
  async function workspaceId() {
    const path = String(workspace() || process.cwd())
    if (workspaceIdCache?.path === path) return workspaceIdCache.id
    const items = (await baseline())?.items ?? []
    let id = items.find((item) => item?.path === path)?.workspaceId
    if (!id) {
      const created = await invoke('workspace', 'create', { request: { path } })
      id = created?.workspace?.workspaceId
    }
    if (typeof id !== 'string' || !id) throw new Error('Harness returned no workspace id')
    workspaceIdCache = { path, id }
    return id
  }

  return {
    async createSession({ agentPreset, title } = {}) {
      const payload = { workspaceId: await workspaceId(), ...(agentPreset ? { agentPreset } : {}) }
      const created = await invoke('session', 'create', { request: payload })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Harness returned no session id')
      if (title) {
        try { await invoke('session', 'rename', { request: { sessionId, title } }) } catch (error) {
          logger.debug?.('bridge-assistant: session rename failed: %s', error?.message ?? error)
        }
      }
      return sessionId
    },
    async prompt({ sessionId, requestId, text, images = [] }) {
      const content = [{ type: 'text', text }]
      for (const image of images) content.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name ? { name: image.name } : {}) })
      await invoke('session', 'prompt', {
        request: { requestId, sessionId, mode: 'queue', content, clientTimeZone: timeZone() || 'Asia/Tokyo' },
      })
    },
    /** true / false / null (unknown): can the model of new assistant conversations read images? */
    async imageSupport() {
      const catalog = await invoke('session', 'modelCatalog', {})
      const selection = catalog?.default
      if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return null
      let llm = null
      try { llm = ctx?.llm ?? null } catch { llm = null }
      if (typeof llm?.resolveModelInfo !== 'function') return null
      const info = await llm.resolveModelInfo(selection.provider, selection.model)
      if (!Array.isArray(info?.inputModalities)) return null
      return info.inputModalities.includes('image')
    },
    async cancel(sessionId) {
      await invoke('session', 'cancel', { request: { sessionId } })
    },
  }
}
