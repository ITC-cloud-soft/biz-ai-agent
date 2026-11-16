// N1b: グループ会話（1:1 でない会話）では AI に業務を扱わせない（既定 deny ＋ 固定の案内）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUP_CHAT_GUIDE } from '@dsh-bridge/dsh-core'
import { apply, DEFAULT_MESSAGES } from '../src/index.js'
import { makeCtx, makeSource, mockDshIm, startFakeApi } from './helpers.mjs'

const EMPLOYEE = { id: 'e42', role: 'inspector', displayName: '点検員A' }
const handler = (req) => (req.path === '/bridge/v1/identity'
  ? { body: { ok: true, linked: true, orgId: 't', user: EMPLOYEE } }
  : { status: 404, body: {} })

async function setup(config = {}, { registry } = {}) {
  const api = await startFakeApi(handler)
  const im = mockDshIm()
  const ctx = makeCtx({ dshIm: im.dshIm, ...(registry ? { bridgeApps: registry(api) } : {}) })
  apply(ctx, { apiUrl: api.url, serviceToken: 'svc-token', guideIntervalSeconds: 600, ...config })
  return { api, im, ctx }
}

test('group conversation: a linked sender is denied with the fixed guide; the business system is not asked', async () => {
  const { api, im, ctx } = await setup()
  try {
    assert.equal(DEFAULT_MESSAGES.groupChat, GROUP_CHAT_GUIDE)
    assert.equal(GROUP_CHAT_GUIDE, '業務の内容は個別チャットでお尋ねください。')
    const group = makeSource({ userId: 'U100', conversationId: 'C-team', conversationKind: 'group' })
    const denied = await im.state.resolver(group)
    assert.deepEqual(denied, { deny: true, reply: GROUP_CHAT_GUIDE })
    assert.equal(api.callsTo('/bridge/v1/identity').length, 0, 'no identity lookup for a group message')
    // 同じ会話の別のメンバー・連投には案内を繰り返さない（無言の deny）
    assert.equal(await im.state.resolver({ ...group, userId: 'U200' }), 'deny')
    // 別のグループには案内する
    assert.equal((await im.state.resolver({ ...group, conversationId: 'C-other' })).reply, GROUP_CHAT_GUIDE)
    // 1:1 の会話は従来どおり（連携済みなら allow）
    assert.equal(await im.state.resolver(makeSource({ userId: 'U100' })), 'allow')
    // conversationKind の無い発信元（IM 以外）は 1:1 扱い
    const { conversationKind: _k, ...noKind } = makeSource({ userId: 'U100' })
    assert.equal(await im.state.resolver(noKind), 'allow')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('group conversation: messages.groupChat overrides the guide; groupChat: allow restores the per-sender behaviour', async () => {
  const custom = await setup({ messages: { groupChat: '個別チャットでどうぞ。' } })
  try {
    assert.equal((await custom.im.state.resolver(makeSource({ conversationKind: 'group' }))).reply, '個別チャットでどうぞ。')
  } finally {
    await custom.ctx.dispose()
    await custom.api.close()
  }
  const open = await setup({ groupChat: 'allow' })
  try {
    assert.equal(await open.im.state.resolver(makeSource({ conversationKind: 'group' })), 'allow')
    assert.equal(open.api.callsTo('/bridge/v1/identity').length, 1)
  } finally {
    await open.ctx.dispose()
    await open.api.close()
  }
})

test('group conversation: the registry application decides first (applications[].groupChat)', async () => {
  const { createApplicationRegistry, registryService } = await import('@dsh-bridge/dsh-core')
  const registry = (api) => registryService(createApplicationRegistry({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    applications: [{ id: 'open-app', name: 'Open', apiUrl: api.url, serviceToken: 'svc-token', default: true, groupChat: 'allow' }],
  }))
  const { api, im, ctx } = await setup({ groupChat: 'deny' }, { registry })
  try {
    assert.equal(await im.state.resolver(makeSource({ conversationKind: 'group' })), 'allow')
  } finally {
    await ctx.dispose()
    await api.close()
  }
})

test('group conversation: link codes still get the existing 1:1 guidance (claim before the resolver)', async () => {
  const { api, im, ctx } = await setup()
  try {
    const [reply] = await im.reply('連携 123456', makeSource({ conversationKind: 'group' }))
    assert.match(reply, /個別チャット/)
    assert.equal(api.callsTo('/bridge/v1/identities/link').length, 0)
  } finally {
    await ctx.dispose()
    await api.close()
  }
})
