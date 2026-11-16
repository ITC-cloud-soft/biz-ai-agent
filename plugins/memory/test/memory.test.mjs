// bridge-memory：個人の記憶・組織の記憶・会話の振り返り。業務 API（Bridge v1）はモック、データはすべて架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplicationRegistry } from '@dsh-bridge/dsh-core'
import { apply, createMemoryPlugin, createMemoryStore, inject, localKinds, name, stripAssistantContext } from '../src/index.js'
import { makeCtx, makeSource, mockStorageDomain, silentLogger, startFakeApi, waitFor } from './helpers.mjs'

const NAMES = ['山田', 'ヤマダ'] // 業務システムの名簿にある架空の氏名

function fakeApi({ scan = true, scanDown = false, orgId = 'org-1' } = {}) {
  return startFakeApi((req) => {
    if (req.headers['x-service-token'] !== 'svc') return { status: 401, body: { error: 'service_token_required' } }
    if (req.path === '/bridge/v1/identities/stats') return { body: { ok: true, orgId, linkedUsers: 3 } }
    if (req.path === '/bridge/v1/pii-scan' && scan) {
      if (scanDown) return { status: 503, body: { error: 'unavailable' } }
      const hit = NAMES.some((n) => req.body.text.includes(n))
      return { body: { ok: true, containsPersonalData: hit, kinds: hit ? ['resident_name'] : [] } }
    }
    return { status: 404, body: { error: 'not_found' } }
  })
}

const src = (userId, extra = {}) => makeSource({ userId, ...extra })
const IDS = {
  's-e1': { source: src('U1'), linked: true, orgId: 'org-1', applicationId: 'app-a', user: { id: 'e1', role: 'staff' } },
  's-e1b': { source: src('U1', { conversationId: 'D101' }), linked: true, orgId: 'org-1', applicationId: 'app-a', user: { id: 'e1', role: 'staff' } },
  's-e2': { source: src('U2'), linked: true, orgId: 'org-1', applicationId: 'app-a', user: { id: 'e2', role: 'staff' } },
  's-admin': { source: src('U9'), linked: true, orgId: 'org-1', applicationId: 'app-a', user: { id: 'e9', role: 'admin' } },
  's-org2': { source: src('X1'), linked: true, orgId: 'org-2', applicationId: 'app-a', user: { id: 'x1', role: 'admin' } },
  's-appb': { source: src('U1'), linked: true, orgId: 'org-1', applicationId: 'app-b', user: { id: 'e1', role: 'staff' } },
  's-group': { source: src('U1', { conversationKind: 'group' }), linked: true, orgId: 'org-1', applicationId: 'app-a', user: { id: 'e1', role: 'staff' } },
  's-unlinked': { source: src('U5'), linked: false, orgId: 'org-1', applicationId: 'app-a' },
}

async function setup({ config = {}, api: apiOptions = {}, paths, storage = mockStorageDomain(), systemPrompt, assistant, plugin } = {}) {
  const api = await fakeApi(apiOptions)
  const registry = createApplicationRegistry({
    applications: [
      { id: 'app-a', name: 'アプリA', apiUrl: api.url, serviceToken: 'svc', default: true, ...(paths ? { paths } : {}) },
      { id: 'app-b', name: 'アプリB', apiUrl: api.url, serviceToken: 'svc', ...(paths ? { paths } : {}) },
    ],
    logger: silentLogger(),
  })
  const tools = new Map()
  const services = {
    tools: { register: (t) => tools.set(t.name, t) },
    storageDomain: storage,
    bridgeApps: registry,
    bridgeIdentity: { forSession: async (id) => IDS[id] ?? null, resolve: async () => ({ linked: true, orgId: 'org-1' }) },
  }
  if (systemPrompt) services.systemPrompt = systemPrompt
  if (assistant) services.bridgeAssistant = assistant
  const ctx = makeCtx(services)
  const service = (plugin?.apply ?? apply)(ctx, config)
  await service.ready
  const run = (tool, args, sessionId = 's-e1') => tools.get(tool).execute(args, { agent: { session: { id: sessionId } } })
  return { api, ctx, tools, service, run, storage, close: async () => { await ctx.dispose(); await api.close() } }
}

const turn = async (ctx, sessionId, userText, reply, source = IDS[sessionId]?.source) => {
  ctx.emit('dsh-im/inbound', { sessionId, text: userText, source })
  ctx.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: sessionId }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'tool-call', name: 'x' }] } } })
  ctx.emit('session/event', { id: sessionId }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: reply }] } } })
  ctx.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: 'stop' } })
}

test('metadata, tool names and prefix', async () => {
  assert.equal(name, 'bridge-memory')
  assert.deepEqual(inject, ['tools', 'storageDomain'])
  const t = await setup()
  try {
    assert.deepEqual([...t.tools.keys()], ['memory_save', 'memory_search', 'memory_list', 'memory_delete', 'memory_recall', 'memory_forget_conversations'])
  } finally { await t.close() }
  const c = await setup({ plugin: createMemoryPlugin({ name: 'x-memory', toolPrefix: 'x_memory' }) })
  try {
    assert.equal(c.tools.has('x_memory_save'), true)
  } finally { await c.close() }
})

test('personal memory: only the owner reads it (not a colleague, not an admin); same title updates', async () => {
  const t = await setup()
  try {
    const saved = await t.run('memory_save', { category: 'preference', title: '回答の書き方', content: '結論を先に、3 行以内で答えてほしい。' })
    assert.equal(saved.ok, true)
    assert.equal(saved.entry.scope, 'personal', 'default scope is personal')
    const stored = t.storage.units.get('bridge_memory').tables.get('entries').get(saved.entry.id)
    assert.equal(stored.userId, 'e1')
    assert.equal(stored.applicationId, 'app-a')
    assert.equal(stored.orgId, 'org-1')
    assert.equal(t.api.callsTo('/bridge/v1/pii-scan').length, 1)

    assert.equal((await t.run('memory_list', {}, 's-e1b')).total, 1, 'same employee, another conversation')
    assert.equal((await t.run('memory_list', {}, 's-e2')).total, 0, 'colleague')
    assert.equal((await t.run('memory_list', {}, 's-admin')).total, 0, 'admin does not see personal memory')
    assert.equal((await t.run('memory_list', {}, 's-appb')).total, 0, 'another application')
    assert.equal((await t.run('memory_search', { query: '回答' }, 's-e1')).entries[0].id, saved.entry.id)

    const again = await t.run('memory_save', { category: 'preference', title: '回答の書き方', content: '結論を先に、箇条書きで。' })
    assert.equal(again.updated, true)
    assert.equal(again.entry.id, saved.entry.id)
    assert.equal((await t.run('memory_list', {})).total, 1)

    await assert.rejects(t.run('memory_delete', { id: saved.entry.id }, 's-admin'), /not found/)
    assert.deepEqual(await t.run('memory_delete', { id: saved.entry.id }), { ok: true, deleted: true, id: saved.entry.id })
  } finally { await t.close() }
})

test('organization memory: colleagues in the same org and application read it; delete by creator or admin', async () => {
  const t = await setup()
  try {
    const sop = await t.run('memory_save', { scope: 'org', category: 'sop', title: '月末の確認手順', content: '月末の締めは翌月 5 日までに担当が確認する。' })
    assert.equal(sop.entry.scope, 'org')
    assert.equal((await t.run('memory_search', { query: '月末の確認' }, 's-e2')).entries[0].id, sop.entry.id)
    assert.equal((await t.run('memory_list', { scope: 'org' }, 's-org2')).total, 0, 'another organization')
    assert.equal((await t.run('memory_list', { scope: 'org' }, 's-appb')).total, 0, 'another application')
    await assert.rejects(t.run('memory_delete', { id: sop.entry.id }, 's-e2'), /only the employee who saved it or an admin/)
    assert.equal((await t.run('memory_delete', { id: sop.entry.id }, 's-admin')).deleted, true)
    await assert.rejects(t.run('memory_save', { scope: 'org', category: 'task', title: 'x', content: 'y' }), /category for org memory/)
  } finally { await t.close() }
})

test('personal data and health details are never saved (local check + business pii-scan, fail closed)', async () => {
  const t = await setup()
  try {
    for (const content of ['田中さんに折り返す', '連絡先は 03-1234-5678', '血圧が高いので注意', '番号 1234567890 を使う']) {
      const r = await t.run('memory_save', { category: 'note', title: 'メモ', content })
      assert.equal(r.ok, false, content)
      assert.equal(r.saved, false)
    }
    const byScan = await t.run('memory_save', { category: 'note', title: 'メモ', content: '山田の件は来週' })
    assert.deepEqual(byScan.kinds, ['resident_name'])
    assert.equal((await t.run('memory_list', {})).total, 0)
    assert.equal((await t.run('memory_save', { scope: 'org', category: 'sop', title: '承認', content: '1 万円以上は管理者が承認する' })).ok, true, 'amounts are allowed by default')
  } finally { await t.close() }

  const down = await setup({ api: { scanDown: true } })
  try {
    await assert.rejects(down.run('memory_save', { category: 'note', title: 'メモ', content: '会議は火曜' }), /personal-data check is unavailable .*nothing was saved/)
  } finally { await down.close() }

  const noScan = await setup({ paths: { base: 'v1', piiScan: '' } })
  try {
    assert.equal((await noScan.run('memory_save', { category: 'note', title: 'メモ', content: '会議は火曜' })).ok, true, 'local check only')
    assert.equal(noScan.api.callsTo('/bridge/v1/pii-scan').length, 0)
  } finally { await noScan.close() }
  assert.deepEqual(localKinds('明日 10 時に会議'), [])
  assert.deepEqual(localKinds('発熱のため欠席'), ['health'])
  assert.deepEqual(localKinds('発熱のため欠席', { health: false }), [])
})

test('group conversations and unlinked senders cannot use memory; ai-readonly reads only org memory', async () => {
  const t = await setup()
  try {
    await t.run('memory_save', { scope: 'org', category: 'sop', title: '手順', content: '朝礼は 9 時。' })
    await t.run('memory_save', { category: 'note', title: '個人', content: '私のメモ' })
    await assert.rejects(t.run('memory_list', {}, 's-group'), /group conversation/)
    await assert.rejects(t.run('memory_list', {}, 's-unlinked'), /not linked/)
    await assert.rejects(t.run('memory_recall', {}, 's-unlinked'), /not linked/)
  } finally { await t.close() }
  const ro = await setup({ config: { unlinkedPolicy: 'ai-readonly' } })
  try {
    await ro.run('memory_save', { scope: 'org', category: 'sop', title: '手順', content: '朝礼は 9 時。' })
    await ro.run('memory_save', { category: 'note', title: '個人', content: '私のメモ' })
    const list = await ro.run('memory_list', {}, 's-unlinked')
    assert.deepEqual(list.entries.map((e) => e.scope), ['org'])
    await assert.rejects(ro.run('memory_save', { scope: 'org', category: 'sop', title: 'x', content: 'y' }, 's-unlinked'), /not linked/)
  } finally { await ro.close() }
})

test('conversation recall: own turns kept across conversations; checked; group turns and other employees excluded', async () => {
  const t = await setup()
  try {
    await turn(t.ctx, 's-e1', '来週の会議の資料はどこ？', '資料は共有フォルダの「会議」にあります。')
    await waitFor(() => t.storage.units.get('bridge_memory_recall')?.tables.get('turns').size === 1)
    await turn(t.ctx, 's-e1', '山田の予定を教えて', '予定は…') // 名簿の氏名：残さない
    await turn(t.ctx, 's-e1', '明日の段取りは？', '発熱の方がいるので確認してください。') // 返事は健康の語：返事だけ残さない
    await turn(t.ctx, 's-group', 'グループでの質問', '答え')
    await turn(t.ctx, 's-e2', '別の職員の質問', '答え')
    await waitFor(() => t.storage.units.get('bridge_memory_recall').tables.get('turns').size === 3)
    const mine = await t.run('memory_recall', {}, 's-e1b')
    assert.deepEqual(mine.turns.map((x) => x.userText).sort(), ['明日の段取りは？', '来週の会議の資料はどこ？'])
    assert.equal(mine.turns.find((x) => x.userText === '明日の段取りは？').replyText, null)
    assert.equal((await t.run('memory_recall', { query: '会議 資料' })).turns[0].replyText, '資料は共有フォルダの「会議」にあります。')
    assert.equal((await t.run('memory_recall', {}, 's-e2')).turns.length, 1)
    assert.equal((await t.run('memory_forget_conversations', { confirm: true })).removed, 2)
    assert.equal((await t.run('memory_recall', {}, 's-e1')).turns.length, 0)
  } finally { await t.close() }
})

test('system prompt: own memory, org SOPs and earlier turns, fixed for the conversation', async () => {
  let provider = null
  const systemPrompt = { context: (p) => { provider = p; return () => {} } }
  const t = await setup({ systemPrompt })
  try {
    await t.run('memory_save', { category: 'preference', title: '回答の書き方', content: '結論を先に。' })
    await t.run('memory_save', { scope: 'org', category: 'sop', title: '朝の手順', content: '朝礼は 9 時。' }, 's-e2')
    await turn(t.ctx, 's-e1', '前回の質問です', '前回の答えです')
    await waitFor(() => t.storage.units.get('bridge_memory_recall').tables.get('turns').size === 1)

    const assembly = { agent: { session: { id: 's-e1b' } } }
    t.ctx.emit('dsh-im/inbound', { sessionId: 's-e1b', text: '今日の予定', source: IDS['s-e1b'].source })
    const first = provider.text(assembly) // まだ誰か分からない：組織の手順だけ（固定しない）
    assert.match(first, /朝礼は 9 時/)
    assert.doesNotMatch(first, /結論を先に/)
    await waitFor(() => /結論を先に/.test(provider.text(assembly)))
    const fixed = provider.text(assembly)
    assert.match(fixed, /この職員について覚えていること/)
    assert.match(fixed, /前回の質問です/)
    assert.match(fixed, /memory_save/)
    await t.run('memory_save', { category: 'note', title: '新しいメモ', content: '後から足したこと' })
    assert.equal(provider.text(assembly), fixed, 'fixed during the conversation (prompt cache)')
    assert.doesNotMatch(provider.text({ agent: { session: { id: 's-e2' } } }), /結論を先に/, 'another employee')
  } finally { await t.close() }
})

test('business web assistant panel: the employee of the panel conversation', async () => {
  const assistantSessions = new Map([['p-1', { userId: 'e1', applicationId: 'app-a', role: 'staff' }]])
  const assistant = {
    isAssistantSession: (id) => assistantSessions.has(id),
    delegationForSession: async (id) => ({ token: 't', userId: assistantSessions.get(id).userId }),
    applicationIdForSession: (id) => assistantSessions.get(id)?.applicationId ?? null,
    userForSession: (id) => assistantSessions.get(id) ?? null,
  }
  const t = await setup({ assistant })
  try {
    await t.run('memory_save', { category: 'note', title: 'パネルから', content: '月曜に確認する' }, 'p-1')
    assert.equal((await t.run('memory_list', {}, 's-e1')).total, 1, 'same employee from IM')
    t.ctx.emit('session/event', { id: 'p-1' }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '今月の締めは？\n\n[業務画面の AI アシスタントから]\n画面: 請求' }] } } })
    t.ctx.emit('session/event', { id: 'p-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '月末です。' }] } } })
    t.ctx.emit('session/event', { id: 'p-1' }, { type: 'turn/end', data: { reason: 'stop' } })
    await waitFor(() => t.storage.units.get('bridge_memory_recall').tables.get('turns').size === 1)
    assert.equal((await t.run('memory_recall', {}, 's-e1')).turns[0].userText, '今月の締めは？')
  } finally { await t.close() }
  assert.equal(stripAssistantContext('質問\n\n[業務画面の AI アシスタントから]\n画面: x'), '質問')
})

test('older organization entries (no scope, no application) are read as org memory of the default application', async () => {
  const storage = mockStorageDomain()
  const unit = { tables: new Map([['entries', new Map([['mem_old', {
    id: 'mem_old', orgId: 'org-1', category: 'sop', title: '古い手順', content: '以前からの手順。', tags: [], createdBy: 'e1',
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  }]])]]), global: null }
  storage.units.set('bridge_memory', unit)
  const t = await setup({ storage })
  try {
    const list = await t.run('memory_list', { scope: 'org' }, 's-e2')
    assert.deepEqual(list.entries.map((e) => [e.id, e.scope]), [['mem_old', 'org']])
    assert.equal((await t.run('memory_list', { scope: 'org' }, 's-appb')).total, 0)
    assert.deepEqual((await t.service.list()).map((e) => e.id), ['mem_old'])
    const stats = await t.service.stats()
    assert.equal(stats.total, 1)
    assert.equal(stats.persistent, true)
  } finally { await t.close() }
})

test('store: expiry, retention cap and per-user limit', async () => {
  let now = Date.UTC(2026, 9, 1)
  const map = new Map()
  const table = { get: (k) => map.get(k), entries: () => map.entries(), put: async (k, v) => { map.set(k, v) }, delete: async (k) => map.delete(k) }
  const store = createMemoryStore({
    table,
    categories: { personal: ['note'], org: ['sop'] },
    retentionDays: () => ({ personal: { note: 10 }, org: { sop: 30 } }),
    limits: { title: 80, content: 2000, tags: 10, tag: 30, perUser: 2, perOrg: 10 },
    defaultApplicationId: 'app-a',
    now: () => now,
    logger: silentLogger(),
  })
  const me = { applicationId: 'app-a', orgId: 'org-1', userId: 'e1' }
  const { entry } = await store.save(me, { scope: 'personal', category: 'note', title: 'a', content: 'x', ttlDays: 999 })
  assert.equal(entry.expiresAt, new Date(now + 10 * 86_400_000).toISOString(), 'ttlDays is capped')
  await store.save(me, { scope: 'personal', category: 'note', title: 'b', content: 'x' })
  await assert.rejects(store.save(me, { scope: 'personal', category: 'note', title: 'c', content: 'x' }), /personal memory is full/)
  now += 11 * 86_400_000
  assert.equal(store.all(me).length, 0)
  assert.equal(await store.purgeExpired(), 2)
})
