// @dsh-bridge/agent-settings — the settings of biz-ai-agent for a Bridge v1 business system (docs/AGENT_SETTINGS.md).
//
//   const agent = createAgentSettings({ dataDir })                 BEFORE createBridgeApp
//   hooks.approvals = agent.approvals(myApprovals)                  the documents' approvals, then the system's own
//   hooks.recipientsFor = agent.recipientsFor(myRecipientsFor)      the knowledge.updated report, then the system's own
//   const bridge = await createBridgeApp({ hooks, ... })
//   await agent.register(bridge, { baseDocuments, buildIndex, webBase })   the knowledge service (by mode), the routes, the screen
//   registerKnowledge(bridge, agent.knowledge)
//
// Settings: models (base / embedding, keys as environment variable names or sealed), knowledge (documents, mode bm25f | rag | graph),
// SNS (approval of documents through the framework's approval cards, reports as the manifest event knowledge.updated).
// Everything here is for PEOPLE (admin roles) — no delegation reaches any of it.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKnowledgeService, embeddingTextOf } from '@dsh-bridge/knowledge'
import { fail, strictKeys } from '@dsh-bridge/server-kit'
import { buildKnowledgeGraph } from './graph-build.mjs'
import { createChat, createEmbedder, dshOverlay, testConnection } from './llm.mjs'
import { masterKeyFrom, resolveKey } from './secrets.mjs'
import { SettingsError, applySettingsPatch, defaultSettings, loadSettings, publicSettings, writeJson } from './settings.mjs'
import { createDocumentStore, createFileVectorStore } from './stores.mjs'
import { createPgVectorStore, digestOf } from './pgvector.mjs'
import { settingsScreen } from './screen.mjs'

export const SUBJECT_TYPE = 'knowledge_document'
export const REPORT_EVENT = 'knowledge.updated'
export const MAX_DOCUMENT_BYTES = 200_000
export const VECTOR_DB_URL_ENV = 'AGENT_VECTOR_DB_URL'
const APPROVAL_TTL_DAYS = 7

export function createAgentSettings({
  dataDir, env = process.env, adminRoles = ['admin'], linkPrefix = '/handbook/', fetch = globalThis.fetch, now = () => new Date(), log = () => {},
  vectorDb = null, vectorTable = 'agent_vectors',
} = {}) {
  if (!dataDir) throw new TypeError('createAgentSettings: dataDir is required')
  const masterKey = masterKeyFrom(env)
  const files = { settings: join(dataDir, 'agent-settings.json'), vectors: join(dataDir, 'vectors.json'), graph: join(dataDir, 'knowledge-graph.json') }
  const docs = createDocumentStore(join(dataDir, 'documents'))
  const vectors = createFileVectorStore(files.vectors)
  // pgvector: the system's own database (vectorDb: a pg Pool / Client / PGlite …) or AGENT_VECTOR_DB_URL (a pg Pool is made on
  // first use; the URL with its password stays in the environment, never in the settings file)
  const vectorDbSource = vectorDb ? 'injected' : env?.[VECTOR_DB_URL_ENV] ? 'env' : null
  let pgStore = null
  async function pgvector() {
    if (pgStore) return pgStore
    let db = vectorDb
    if (!db) {
      if (!env?.[VECTOR_DB_URL_ENV]) throw Object.assign(new Error('no vector database'), { code: 'no_vector_db' })
      let pg
      try { pg = await import('pg') } catch { throw Object.assign(new Error('pg is not installed'), { code: 'pg_not_installed' }) }
      db = new (pg.default?.Pool ?? pg.Pool)({ connectionString: env[VECTOR_DB_URL_ENV], max: 4 })
    }
    pgStore = createPgVectorStore({ db, table: vectorTable })
    await pgStore.init()
    return pgStore
  }
  let settings = loadSettings(files.settings, defaultSettings({ adminRoles, vectorStore: vectorDbSource ? 'pgvector' : 'file' }))
  let kit = null
  let ctx = null // { baseDocuments, buildIndex, webBase, knowledgeOptions }
  let current = null
  let status = { state: 'starting' }
  let chain = Promise.resolve()

  // ── the knowledge service the route uses: swapped as a whole on every rebuild (mode / documents / models changed) ───────────
  const knowledge = {
    search: (...a) => current.search(...a),
    index: () => current.index(),
    setIndex: (i) => current.setIndex(i),
    ready: () => current.ready(),
    mode: () => current.mode(),
  }
  const keyOf = (m) => resolveKey(m, { env, masterKey })
  const toKnowledgeDoc = (meta, text) => ({ id: meta.id, title: meta.title, link: `${linkPrefix}${meta.id}`, visibility: { roles: meta.roles }, keywords: meta.keywords ?? [], body: text })
  const publishedDocs = () => docs.list().filter((d) => d.status === 'published').map((d) => toKnowledgeDoc(d, docs.text(d.id) ?? '')).filter((d) => d.body)

  async function build(reason) {
    const t0 = Date.now()
    const failed = []
    const index = await ctx.buildIndex([...ctx.baseDocuments, ...publishedDocs()], { onPersonalData: 'skip' })
    const mode = settings.knowledge.mode
    const options = { webBase: ctx.webBase, ...ctx.knowledgeOptions }
    let stats = null
    if (mode === 'rag') {
      try {
        const embedder = createEmbedder(settings.llm.embedding, keyOf(settings.llm.embedding), { fetch })
        const store = settings.knowledge.vectorStore === 'pgvector' ? await pgvector() : vectors
        const keys = index.chunks.map((c) => `${embedder.id}\u0000${embeddingTextOf(c)}`)
        const cache = await store.cache(keys)
        // pgvector searches in SQL, among the asker's visible chunks only (the service hands over nothing else)
        const vectorSearch = store.kind === 'pgvector'
          ? async (query, visible, limit) => {
            const byDigest = new Map()
            for (const c of visible) {
              const d = digestOf(embeddingTextOf(c))
              byDigest.set(d, [...(byDigest.get(d) ?? []), c.id])
            }
            const hits = await store.search(embedder.id, query, [...byDigest.keys()], limit)
            return hits.flatMap((h) => (byDigest.get(h.digest) ?? []).map((chunkId) => ({ chunkId, sim: h.sim })))
          }
          : null
        const svc = createKnowledgeService(index, { ...options, embedder, vectorCache: cache, vectorSearch, onError: (e, x) => failed.push(`${x.stage}:${e?.code ?? e?.message ?? 'error'}`.slice(0, 80)) })
        await svc.ready()
        if (failed.length) throw new Error(failed[0])
        stats = { store: store.kind, vectors: await store.save(cache, keys), embedded: cache.added.size }
        current = svc
      } catch (error) {
        if (!failed.length) failed.push(`${error?.code === 'no_vector_db' || error?.code === 'pg_not_installed' ? 'vector_db' : 'embedding'}:${error?.code ?? 'failed'}`.slice(0, 80))
        current = createKnowledgeService(index, options) // BM25F until the embedder works again
      }
    } else if (mode === 'graph') {
      try {
        const chat = createChat(settings.llm.base, keyOf(settings.llm.base), { fetch })
        const previous = existsSync(files.graph) ? JSON.parse(readFileSync(files.graph, 'utf8')) : null
        const { kg, stats: s } = await buildKnowledgeGraph(index, { chat, screen: ctx.screen, previous, now })
        writeJson(files.graph, kg)
        if (s.failed) failed.push(`graph:${s.failed}_chunk(s)_failed`)
        stats = { entities: kg.entities.length, relations: kg.relations.length, extracted: s.extracted, cached: s.cached, dropped: s.dropped }
        current = createKnowledgeService(index, { ...options, graph: kg })
      } catch (error) {
        failed.push(`graph:${error?.code ?? 'failed'}`)
        current = createKnowledgeService(index, options)
      }
    } else {
      current = createKnowledgeService(index, options)
    }
    status = {
      state: 'ready', reason, mode, service: current.mode(), at: now().toISOString(), ms: Date.now() - t0,
      documents: index.documents.length, chunks: index.chunks.length, rejected: index.rejected.length, failed, ...(stats ? { stats } : {}),
    }
    log(`[agent-settings] knowledge rebuilt (${reason}): ${status.service}, ${status.documents} document(s), ${status.chunks} chunk(s)${failed.length ? `, problems: ${failed.join(' ')}` : ''}`)
    const sns = settings.sns
    if (reason !== 'start' && ((sns.reportOn.rebuilt) || (sns.reportOn.failures && failed.length))) {
      await kit.tx(async (t) => kit.emitEvent(t, {
        type: REPORT_EVENT, aggregateType: SUBJECT_TYPE, aggregateId: randomUUID(),
        payload: { buildId: randomUUID(), documents: status.documents, chunks: status.chunks, rejected: status.rejected, failed: failed.length },
      }))
    }
    return status
  }
  /** Rebuild after the current one (serialized). Never throws: the status says what happened. */
  function rebuild(reason = 'manual') {
    chain = chain.then(() => build(reason)).catch((error) => {
      status = { ...status, state: 'error', reason, error: error?.code ?? error?.message?.slice(0, 200) ?? 'error', at: now().toISOString() }
      log(`[agent-settings] rebuild failed: ${status.error}`)
      return status
    })
    return chain
  }

  // ── approvals of documents (the framework's approval cards on SNS; the same rule on the web) ──────────────────────────────
  const approvalOf = (meta) => meta?.approval && { ...meta.approval, subjectType: SUBJECT_TYPE, subjectId: meta.id, expiresAt: new Date(meta.approval.expiresAt) }
  const findByApproval = (id) => docs.list().find((d) => d.approval?.id === String(id)) ?? null
  const mayDecide = (a, user) => Boolean(user && user.active !== false && settings.sns.approverRoles.includes(user.role) && String(user.id) !== String(a.requestedBy))
  async function decide(t, a, { action, actor, channel }) {
    const meta = docs.get(a.subjectId)
    if (!meta || meta.approval.status !== 'pending') fail(409, 'already_decided')
    if (new Date(meta.approval.expiresAt) <= now()) fail(409, 'approval_expired')
    const decided = action === 'approve' ? 'approved' : 'rejected'
    await kit.emitEvent(t, {
      type: 'approval.decided', aggregateType: 'approval', aggregateId: a.id,
      payload: { approvalId: a.id, subjectType: SUBJECT_TYPE, subjectId: meta.id, decision: action, status: decided, channel, decidedByUserId: actor.id },
    })
    meta.approval = { ...meta.approval, status: decided, decidedBy: actor.id, channel }
    meta.status = action === 'approve' ? 'published' : 'rejected'
    docs.save(meta)
    if (action === 'approve') setImmediate(() => rebuild('published'))
    return { id: a.id, status: decided, subjectId: meta.id }
  }
  function approvals(own = null) {
    const mine = (a) => a?.subjectType === SUBJECT_TYPE
    return {
      get: async (id, c) => approvalOf(findByApproval(id)) ?? (own ? own.get(id, c) : null),
      approvers: async (a, c) => (mine(a)
        ? (await kit.hooks.employees.list({ roles: settings.sns.approverRoles })).filter((u) => mayDecide(a, u))
        : own.approvers(a, c)),
      card: async (a, c) => (mine(a)
        ? {
          title: 'Knowledge document',
          fields: [{ label: 'Document', value: a.subjectId }, { label: 'Decide by', value: a.expiresAt.toISOString().slice(0, 10) }],
          body: 'Approve to publish it to the AI\'s knowledge (each employee still finds only what their role may read). Details on the settings screen.',
        }
        : own.card(a, c)),
      mayDecide: async (a, user, c) => (mine(a) ? mayDecide(a, user) : own.mayDecide(a, user, c)),
      decide: (a, decision, c) => (mine(a) ? decide(c.t, a, decision) : own.decide(a, decision, c)),
    }
  }
  /** The knowledge.updated report: the report roles, numbers only. */
  function recipientsFor(own = null) {
    return async (event, c) => {
      if (event.type !== REPORT_EVENT) return own ? own(event, c) : null
      const users = await kit.hooks.employees.list({ roles: settings.sns.reportRoles })
      const p = event.payload ?? {}
      return {
        users,
        dedupeKey: `${REPORT_EVENT}:${p.buildId}`,
        link: '/agent-settings',
        paramsFor: () => ({ documents: Number(p.documents) || 0, chunks: Number(p.chunks) || 0, rejected: Number(p.rejected) || 0, failed: Number(p.failed) || 0 }),
      }
    }
  }

  // ── documents ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function upload(user, b) {
    strictKeys(b, ['title', 'roles', 'keywords', 'text'], 'invalid_document')
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120) fail(400, 'invalid_title')
    if (!Array.isArray(b.roles) || !b.roles.length || b.roles.some((r) => !kit.declaredRoles.includes(r))) fail(400, 'invalid_roles')
    if (b.keywords !== undefined && (!Array.isArray(b.keywords) || b.keywords.length > 30 || b.keywords.some((k) => typeof k !== 'string' || k.length > 60))) fail(400, 'invalid_keywords')
    if (typeof b.text !== 'string' || !b.text.trim()) fail(400, 'text_required')
    if (Buffer.byteLength(b.text, 'utf8') > MAX_DOCUMENT_BYTES) fail(413, 'document_too_large')
    const taken = new Set([...ctx.baseDocuments.map((d) => d.id)])
    const meta = {
      id: docs.newId(b.title, taken), title: b.title.trim(), roles: [...new Set(b.roles)], keywords: b.keywords ?? [], status: 'pending',
      uploadedBy: String(user.id), uploadedAt: now().toISOString(), bytes: Buffer.byteLength(b.text, 'utf8'),
    }
    // the same checks as the index: visibility, sections, links — and personal data (fail: nothing of the text is kept)
    let check
    try {
      check = await ctx.buildIndex([toKnowledgeDoc(meta, b.text)], { onPersonalData: 'skip' })
    } catch (error) {
      fail(400, 'invalid_document', String(error?.message ?? '').split('\n').slice(1, 4).join(' ').slice(0, 300))
    }
    if (check.rejected.length) {
      docs.save({ ...meta, status: 'personal_data', kinds: [...new Set(check.rejected.flatMap((r) => r.kinds))].sort() })
      return docs.get(meta.id)
    }
    if (!settings.sns.requireApproval) {
      docs.save({ ...meta, status: 'published', approval: null }, b.text)
      setImmediate(() => rebuild('published'))
      return docs.get(meta.id)
    }
    const a = { id: randomUUID(), status: 'pending', requestedBy: String(user.id), requiredRole: settings.sns.approverRoles[0], expiresAt: new Date(now().getTime() + APPROVAL_TTL_DAYS * 86_400_000).toISOString() }
    await kit.tx(async (t) => {
      await kit.emitEvent(t, {
        type: 'approval.requested', aggregateType: 'approval', aggregateId: a.id,
        payload: { approvalId: a.id, subjectType: SUBJECT_TYPE, subjectId: meta.id, requiredRole: a.requiredRole, expiresAt: a.expiresAt },
      })
      docs.save({ ...meta, approval: a }, b.text) // after the event is written (the memory store cannot roll files back)
    })
    return docs.get(meta.id)
  }
  /** A document as the list shows it to one viewer: canDecide = this viewer may approve it now (never the uploader). */
  const docJson = (d, viewer = null) => ({ ...d, link: d.status === 'published' ? `${linkPrefix}${d.id}` : null, canDecide: Boolean(viewer && d.status === 'pending' && d.approval?.status === 'pending' && mayDecide(approvalOf(d), viewer)) })

  // ── register: the knowledge service (first build), the routes, the screen ───────────────────────────────────────────────
  async function register(bridge, { baseDocuments = [], buildIndex, webBase = '', knowledgeOptions = {}, screen = null } = {}) {
    if (!bridge?.kit || !bridge?.router) throw new TypeError('agent-settings: pass the result of createBridgeApp')
    if (typeof buildIndex !== 'function') throw new TypeError('agent-settings: buildIndex(documents, options) is required (the system\'s own roles, routes and screen)')
    kit = bridge.kit
    ctx = { baseDocuments, buildIndex, webBase, knowledgeOptions, screen }
    await rebuild('start')
    const ADMIN = { allow: ['user'], roles: adminRoles }
    const PEOPLE = { allow: ['user'] }
    const { router } = bridge
    const pub = () => ({ ...publicSettings(settings, { env, masterKey }), vectorDb: { available: Boolean(vectorDbSource), source: vectorDbSource, table: vectorTable } })

    router.add('GET', '/agent-settings', ADMIN, async ({ req, res, query }) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" })
      res.end(settingsScreen({ lang: query.get('lang'), acceptLanguage: req.headers['accept-language'], roles: kit.declaredRoles }))
      return null
    })
    router.add('GET', '/api/agent/settings', ADMIN, async () => ({ status: 200, body: { ok: true, settings: pub(), roles: kit.declaredRoles, knowledge: status } }))
    router.add('PUT', '/api/agent/settings', ADMIN, async ({ body }) => {
      let next
      try {
        next = applySettingsPatch(settings, body ?? {}, { roles: kit.declaredRoles, masterKey, vectorDbAvailable: Boolean(vectorDbSource) })
      } catch (error) {
        if (error instanceof SettingsError) fail(400, error.code, error.message)
        throw error
      }
      const rebuildNeeded = JSON.stringify([next.knowledge, next.llm]) !== JSON.stringify([settings.knowledge, settings.llm])
      settings = next
      writeJson(files.settings, settings)
      if (rebuildNeeded) await rebuild('settings')
      return { status: 200, body: { ok: true, settings: pub(), knowledge: status } }
    })
    router.add('POST', '/api/agent/settings/test', ADMIN, async ({ body }) => {
      const b = body ?? {}
      strictKeys(b, ['target'])
      if (!['base', 'embedding'].includes(b.target)) fail(400, 'invalid_target')
      const cfg = settings.llm[b.target]
      return { status: 200, body: { ok: true, result: await testConnection(b.target, cfg, keyOf(cfg), { fetch }) } }
    })
    router.add('GET', '/api/agent/settings/dsh-overlay', ADMIN, async ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'cache-control': 'no-store' })
      res.end(dshOverlay(settings.llm.base))
      return null
    })
    router.add('GET', '/api/agent/documents', ADMIN, async ({ principal }) => {
      const viewer = await kit.hooks.employees.get(principal.user.id)
      return { status: 200, body: { ok: true, documents: docs.list().map((d) => docJson(d, viewer)) } }
    })
    router.add('POST', '/api/agent/documents', ADMIN, async ({ principal, body }) => ({ status: 201, body: { ok: true, document: docJson(await upload(principal.user, body ?? {}), principal.user) } }))
    router.add('POST', '/api/agent/documents/:docId/decision', PEOPLE, async ({ principal, params, body }) => {
      const b = body ?? {}
      strictKeys(b, ['action'])
      if (!['approve', 'reject'].includes(b.action)) fail(400, 'invalid_action')
      const meta = docs.get(params.docId)
      if (!meta?.approval) fail(404, 'not_found')
      const a = approvalOf(meta)
      const user = await kit.hooks.employees.get(principal.user.id)
      if (!mayDecide(a, user)) fail(403, 'role_not_permitted')
      const out = await kit.tx(async (t) => {
        const r = await decide(t, a, { action: b.action, actor: principal.user, channel: 'web' })
        await t.revokeApprovalDeliveries({ approvalId: a.id })
        return r
      })
      return { status: 200, body: { ok: true, approval: out } }
    }, { patterns: { docId: '[a-z0-9][a-z0-9-]{0,62}' } })
    router.add('DELETE', '/api/agent/documents/:docId', ADMIN, async ({ params }) => {
      const meta = docs.get(params.docId)
      if (!meta) fail(404, 'not_found')
      const was = meta.status
      docs.save({ ...meta, status: 'withdrawn', ...(meta.approval?.status === 'pending' ? { approval: { ...meta.approval, status: 'withdrawn' } } : {}) })
      docs.dropText(meta.id)
      if (was === 'published') await rebuild('withdrawn')
      return { status: 200, body: { ok: true } }
    }, { patterns: { docId: '[a-z0-9][a-z0-9-]{0,62}' } })
    router.add('POST', '/api/agent/knowledge/rebuild', ADMIN, async () => ({ status: 200, body: { ok: true, knowledge: await rebuild('manual') } }))
    router.add('GET', '/api/agent/knowledge/status', ADMIN, async () => ({ status: 200, body: { ok: true, knowledge: status } }))
    return { routes: ['/agent-settings', '/api/agent/*'] }
  }

  return {
    knowledge, approvals, recipientsFor, register, rebuild,
    /** Resolves when the queued rebuilds are done (tests, scripts). */
    idle: async () => { await new Promise((r) => setImmediate(r)); await chain },
    settings: () => structuredClone(settings),
    status: () => status,
    documents: () => docs.list(),
  }
}

export { buildKnowledgeGraph, cleanExtraction, EXTRACTION_PROMPT } from './graph-build.mjs'
export { createChat, createEmbedder, dshOverlay, testConnection, endpointOf, LlmError } from './llm.mjs'
export { MASTER_KEY_ENV, masterKeyFrom, seal, unseal, resolveKey, keyStatus } from './secrets.mjs'
export { MODES, KINDS, SettingsError, applySettingsPatch, defaultSettings, publicSettings } from './settings.mjs'
export { createFileVectorStore, createDocumentStore } from './stores.mjs'
export { createPgVectorStore, digestOf } from './pgvector.mjs'
