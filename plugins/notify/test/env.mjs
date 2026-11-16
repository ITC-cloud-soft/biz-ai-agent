// bridge-notify のテスト環境：設備点検（架空）の業務 API（Bridge v1）のモック・レジストリ（fixture の manifest）・dsh-im の模擬。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createApplicationRegistry, openDomain } from '@dsh-bridge/dsh-core'
import { cardText, silentLogger, startFakeApi } from './helpers.mjs'

export const EQ_MANIFEST = fileURLToPath(new URL('./fixtures/equipment-inspection.manifest.yaml', import.meta.url))
export const JST = (h, m = 0, day = 25, s = 0) => Date.UTC(2026, 9, day, h - 9, m, s) // 2026-10-<day> h:m JST
export const MIN = 60_000
export const SEC = 1000
export const QUIET = { start: '20:00', end: '08:00', timeZone: 'Asia/Tokyo' }
export const WEB = 'https://facility.example.test'
export const SIGN = '— 設備点検 AI 秘書'

/** カードを文字だけのプラットフォームで見たとき（helpers の cardText）：件名 / 本文 / リンクのボタン（ラベル: URL）/ footer の署名。 */
export const fallback = (head, lines, url, sign = SIGN) => [head, ...lines, ...(url ? [`${head.startsWith('【ご報告】') ? '業務 Web で確認' : '業務 Web を開いて対応'}: ${url}`] : []), sign].join('\n')
/** 文字だけで送るとき（deliveryMode text・文面の body）：件名 / 本文 / 「こちらから開けます：URL」/ 署名。 */
export const plain = (head, lines, url, sign = SIGN) => [head, ...lines, ...(url ? [`こちらから開けます：${url}`] : []), sign].join('\n')

export const ASK = {
  overdue: '▶ お願いしたいこと：担当の設備を点検して記録を登録するか、難しい場合は点検日の変更を提案してください。',
  failure: '▶ お願いしたいこと：現場を確認し、使用停止の表示と修理依頼の起票をお願いします。',
  repair: '▶ お願いしたいこと：業務 Web の「修理依頼」で内容を確認し、承認の判断をお願いします。',
  info: 'ご対応は不要です。ご確認だけお願いします。',
}

export function ev(id, type, extra = {}) {
  return { id, type, aggregateType: type.split('.')[0], aggregateId: `agg-${id}`, payload: {}, at: '2026-10-25T00:00:00.000Z', ...extra }
}

export function recipient(userId, { template, params = {}, link = '/equipment/eq-1', quietHours = QUIET, platform = 'slack', botId } = {}) {
  return { userId, identity: { platform, externalId: `X-${userId}`, ...(botId ? { botId } : {}) }, template, params, link, quietHours }
}

/** 偽の業務 API（Bridge v1）: eventId → {type, recipients}。deliveries の報告を記録。byEvent は関数でもよい。 */
export async function fakeApi(byEvent, { failReports = 0, token = 'svc', prefix = '/bridge/v1', extra = null } = {}) {
  const reports = []
  let reportFailures = failReports
  const re = new RegExp(`^${prefix}/notifications/for-event/(\\d+)$`)
  const server = await startFakeApi((req) => {
    if (req.headers['x-service-token'] !== token) return { status: 401, body: { error: 'invalid_service_token' } }
    const m = re.exec(req.path)
    if (m && req.method === 'GET') {
      const found = typeof byEvent === 'function' ? byEvent(Number(m[1])) : byEvent[m[1]]
      if (!found) return { status: 404, body: { error: 'event_not_found' } }
      if (found.status) return { status: found.status, body: { error: 'boom' } }
      return { body: { ok: true, eventId: Number(m[1]), type: found.type, supported: true, recipients: found.recipients } }
    }
    if (req.path === `${prefix}/notifications/deliveries` && req.method === 'POST') {
      if (reportFailures > 0) { reportFailures -= 1; return { status: 503, body: { error: 'unavailable' } } }
      reports.push(req.body)
      return { body: { ok: true, updated: req.body.eventIds.length } }
    }
    const more = extra?.(req)
    if (more) return more
    return { status: 404, body: { error: 'not_found' } }
  })
  return { ...server, reports, forEventCalls: () => server.calls.filter((c) => c.path.startsWith(`${prefix}/notifications/for-event/`)) }
}

/** 設備点検 1 件のレジストリ（fixture の manifest を読み込み済み）。 */
export async function equipmentRegistry(api, entry = {}, others = []) {
  const registry = createApplicationRegistry({
    logger: silentLogger(),
    applications: [
      { id: 'equipment-inspection', name: '設備点検', namespace: 'facility', default: true, apiUrl: api.url, serviceToken: 'svc', manifestFile: EQ_MANIFEST, ...entry },
      ...others,
    ],
  })
  await registry.ensureManifests()
  return registry
}

/**
 * dsh-im fork を真似る。
 * - send(botId, targetId, text, {idempotencyKey})：登録済みの配信先（createTarget）だけ。未登録は code 'unknown-target'。
 * - sendCard({botId, to:{userId}, card, idempotencyKey})：利用者 ID 宛てに直接。ボタン無しの通知は件名・本文・リンク・footer（署名）。
 * 冪等記録は成功後に記録。failNext 回失敗（failAfterDeliver なら届いた後に失敗＝応答だけ失われた）。
 */
export function imMock({ failNext = 0, failAfterDeliver = false, targets = [] } = {}) {
  const delivered = []
  const via = []
  const keys = new Set()
  const registered = new Set(targets) // `${botId}|${targetId}`
  const state = { failNext, calls: 0, unknownTarget: 0 }
  function deliver(kind, entry) {
    state.calls += 1
    if (entry.key && keys.has(entry.key)) return { deduped: true }
    if (state.failNext > 0) {
      state.failNext -= 1
      if (failAfterDeliver) { keys.add(entry.key); delivered.push(entry); via.push(kind) }
      throw Object.assign(new Error('provider timeout'), { code: 'timeout' })
    }
    if (entry.key) keys.add(entry.key)
    delivered.push(entry)
    via.push(kind)
    return { deduped: false }
  }
  return {
    delivered,
    via,
    state,
    dshIm: {
      listBots: async () => [{ botId: 'B-slack', channel: 'slack' }, { botId: 'B-line', channel: 'line' }],
      async createTarget(botId, target) { registered.add(`${botId}|${target.targetId}`); return { targetId: target.targetId } },
      async send(botId, targetId, text, opts = {}) {
        if (!registered.has(`${botId}|${targetId}`)) {
          state.unknownTarget += 1
          throw Object.assign(new Error('Unknown target'), { code: 'unknown-target' })
        }
        const { deduped } = deliver('send', { botId, targetId, text, key: opts.idempotencyKey })
        return { sent: true, deduped }
      },
      async sendCard({ botId, to, card, idempotencyKey, applicationId }) {
        assert.ok(to?.userId, 'notifications go to a user (DM)')
        assert.deepEqual(card.actions, [], 'notification cards have no buttons')
        assert.ok(card.title && card.body)
        const { deduped } = deliver('card', { botId, targetId: to.userId, text: cardText(card), key: idempotencyKey, ...(applicationId ? { applicationId } : {}) })
        return { messageRef: `ref-${idempotencyKey}`, delivered: true, deduped }
      },
    },
  }
}

export async function openTables(storage) {
  const domain = await openDomain({ storageDomain: storage }, { name: 'bridge_notify', tables: ['pending', 'sent', 'reports'] })
  return { domain, tables: { pending: domain.table('pending'), sent: domain.table('sent'), reports: domain.table('reports') } }
}
