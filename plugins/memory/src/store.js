// store.js — 記憶の保存先（ctx に依存しない純粋な部分）。
//
//   createMemoryStore   個人の記憶（scope personal：本人だけ）と組織の記憶（scope org：その組織の連携済みの職員）
//   createRecallStore   会話の振り返り（本人の過去の発言と AI の返事の要点。本人だけ）
//
// どちらも DSH のストレージ（storage-domain の KvTable 互換：get / entries / put / delete）に 1 件 1 キーで置く。
// 作用域は「アプリケーション × 組織 × （個人なら）職員」。アプリケーション ID の無い古い記録（care-memory の時代の組織の記憶）は
// 既定のアプリケーションのものとして読む（移行は不要）。scope の無い記録は org。
import { randomUUID } from 'node:crypto'
import { normalizeText } from '@dsh-bridge/dsh-core'

export const SCOPES = Object.freeze(['personal', 'org'])
const DAY = 24 * 3600_000

/** 文字の 2-gram（空白を除き小文字）。1 文字だけならその文字。 */
export function bigrams(text) {
  const s = normalizeText(text).toLowerCase().replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

/** 問い合わせの 2-gram のうち、題名 ×3・タグ ×2・本文 ×1 で当たった割合。 */
export function scoreText(query, { title = '', tags = [], body = '' }) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const t = bigrams(title)
  const g = bigrams((tags ?? []).join(' '))
  const b = bigrams(body)
  let total = 0
  for (const gram of q) {
    if (t.has(gram)) total += 3
    if (g.has(gram)) total += 2
    if (b.has(gram)) total += 1
  }
  return total / q.size
}

export const MIN_SCORE = 0.15

function newestFirst(a, b) {
  const x = a.updatedAt ?? a.createdAt
  const y = b.updatedAt ?? b.createdAt
  return x < y ? 1 : x > y ? -1 : 0
}

/**
 * 個人と組織の記憶。
 * @param {object} deps
 * @param {object} deps.table                 KvTable 互換
 * @param {object} deps.categories            { personal: [..], org: [..] }
 * @param {() => object} deps.retentionDays   { personal: {cat: days}, org: {cat: days} }
 * @param {object} deps.limits                { title, content, tags, tag, perUser, perOrg }
 * @param {string} deps.defaultApplicationId  アプリケーション ID の無い記録の持ち主
 */
export function createMemoryStore({ table, categories, retentionDays, limits, defaultApplicationId, now = Date.now, logger = console }) {
  const appOf = (entry) => String(entry.applicationId ?? defaultApplicationId)
  const scopeOf = (entry) => (entry.scope === 'personal' ? 'personal' : 'org')

  /** その職員から見えるか（期限内・同じアプリケーションと組織・個人の記憶は本人だけ）。 */
  function visible(entry, who) {
    if (!entry || !who) return false
    if (!(Date.parse(entry.expiresAt) > now())) return false
    if (appOf(entry) !== String(who.applicationId) || String(entry.orgId) !== String(who.orgId)) return false
    if (scopeOf(entry) === 'personal') return Boolean(who.userId) && entry.userId === who.userId
    return true
  }

  function all(who, { scope, category } = {}) {
    const out = []
    for (const [, entry] of table.entries()) {
      if (!visible(entry, who)) continue
      if (scope && scopeOf(entry) !== scope) continue
      if (category && entry.category !== category) continue
      out.push(entry)
    }
    return out.sort(newestFirst)
  }

  function search(who, query, { scope, category, limit = 5 } = {}) {
    return all(who, { scope, category })
      .map((entry) => ({ entry, s: scoreText(query, { title: entry.title, tags: entry.tags, body: entry.content }) }))
      .filter((x) => x.s > MIN_SCORE)
      .sort((a, b) => b.s - a.s || newestFirst(a.entry, b.entry))
      .slice(0, limit)
      .map((x) => x.entry)
  }

  /** 入力の検査（文字数・分類）。保存する形を返す。個人情報の検査は呼び出し側（index.js の screen）。 */
  function validate({ scope, category, title, content, tags = [] }) {
    if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`)
    const allowed = categories[scope] ?? []
    if (!allowed.includes(category)) throw new Error(`category for ${scope} memory must be one of ${allowed.join(', ')}`)
    const t = normalizeText(title)
    const c = String(content ?? '').trim()
    if (!t) throw new Error('title is required')
    if (!c) throw new Error('content is required')
    if (t.length > limits.title) throw new Error(`title must be at most ${limits.title} characters`)
    if (c.length > limits.content) throw new Error(`content must be at most ${limits.content} characters`)
    if (!Array.isArray(tags) || tags.length > limits.tags) throw new Error(`tags must be an array of at most ${limits.tags}`)
    const cleanTags = tags.map((tag) => normalizeText(tag)).filter(Boolean)
    if (cleanTags.some((tag) => tag.length > limits.tag)) throw new Error(`each tag must be at most ${limits.tag} characters`)
    return { scope, category, title: t, content: c, tags: cleanTags }
  }

  function retention(scope, category, ttlDays) {
    const max = Number(retentionDays()?.[scope]?.[category])
    if (!Number.isFinite(max) || max < 1) throw new Error(`no retention is configured for ${scope}/${category}`)
    if (ttlDays === undefined || ttlDays === null) return max
    const days = Math.floor(Number(ttlDays))
    if (!Number.isFinite(days)) throw new Error('ttlDays must be a number')
    return Math.min(max, Math.max(1, days))
  }

  /**
   * 保存（同じ作用域・分類・題名の記録があれば上書きして期限を延ばす：「覚えておいて」を繰り返しても増えない）。
   * @param who  { applicationId, orgId, userId, role }
   */
  async function save(who, input) {
    if (!who?.userId) throw new Error('the employee is required')
    const v = validate(input)
    const days = retention(v.scope, v.category, input.ttlDays)
    const same = all(who, { scope: v.scope, category: v.category }).find((e) => e.title === v.title && (v.scope === 'personal' || e.createdBy === who.userId))
    if (!same) {
      const count = v.scope === 'personal' ? all(who, { scope: 'personal' }).length : all(who, { scope: 'org' }).length
      const max = v.scope === 'personal' ? limits.perUser : limits.perOrg
      if (count >= max) throw new Error(`${v.scope} memory is full (${max} entries); delete old entries first`)
    }
    const at = new Date(now()).toISOString()
    const entry = {
      id: same?.id ?? `mem_${randomUUID()}`,
      scope: v.scope,
      applicationId: String(who.applicationId),
      orgId: String(who.orgId),
      userId: v.scope === 'personal' ? who.userId : null,
      category: v.category,
      title: v.title,
      content: v.content,
      tags: v.tags,
      createdBy: same?.createdBy ?? who.userId,
      createdByRole: same?.createdByRole ?? who.role ?? null,
      createdAt: same?.createdAt ?? at,
      updatedAt: at,
      expiresAt: new Date(now() + days * DAY).toISOString(),
    }
    await table.put(entry.id, entry)
    return { entry, updated: Boolean(same) }
  }

  function get(who, id) {
    const entry = table.get(id)
    return visible(entry, who) ? entry : null
  }

  async function remove(id) {
    return table.delete(id)
  }

  async function purgeExpired() {
    let removed = 0
    for (const [key, entry] of [...table.entries()]) {
      if (!(Date.parse(entry?.expiresAt ?? '') > now())) {
        await table.delete(key)
        removed += 1
      }
    }
    if (removed) logger.info?.('bridge-memory: purged %d expired memory entries', removed)
    return removed
  }

  /** 管理の画面・統計用：組織の記憶だけ（個人の記憶は本人以外に見せない）。 */
  function orgEntries({ applicationId, orgId, category } = {}) {
    const out = []
    for (const [, entry] of table.entries()) {
      if (scopeOf(entry) !== 'org' || !(Date.parse(entry.expiresAt) > now())) continue
      if (applicationId && appOf(entry) !== String(applicationId)) continue
      if (orgId && String(entry.orgId) !== String(orgId)) continue
      if (category && entry.category !== category) continue
      out.push(entry)
    }
    return out.sort(newestFirst)
  }

  function counts() {
    let personal = 0
    let org = 0
    for (const [, entry] of table.entries()) {
      if (!(Date.parse(entry?.expiresAt ?? '') > now())) continue
      if (scopeOf(entry) === 'personal') personal += 1
      else org += 1
    }
    return { personal, org }
  }

  return { all, search, save, get, remove, purgeExpired, orgEntries, counts, scopeOf, appOf }
}

/**
 * 会話の振り返り：1 ターン = 1 件（本人の発言と AI の最後の返事。それぞれ検査を通ったものだけ）。本人だけが読む。
 * @param {object} deps
 * @param {object} deps.table
 * @param {() => number} deps.retentionDays
 * @param {object} deps.limits  { perUser, userText, replyText }
 */
export function createRecallStore({ table, retentionDays, limits, now = Date.now, logger = console }) {
  const mine = (entry, who) => entry && who?.userId && entry.userId === who.userId
    && String(entry.applicationId) === String(who.applicationId) && String(entry.orgId) === String(who.orgId)
    && Date.parse(entry.expiresAt) > now()

  function list(who, { excludeSessionId, sinceDays } = {}) {
    const since = sinceDays ? now() - sinceDays * DAY : 0
    const out = []
    for (const [, entry] of table.entries()) {
      if (!mine(entry, who)) continue
      if (excludeSessionId && entry.sessionId === excludeSessionId) continue
      if (since && Date.parse(entry.at) < since) continue
      out.push(entry)
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  function search(who, query, { limit = 5, sinceDays } = {}) {
    return list(who, { sinceDays })
      .map((entry) => ({ entry, s: scoreText(query, { title: entry.userText, body: entry.replyText ?? '' }) }))
      .filter((x) => x.s > MIN_SCORE)
      .sort((a, b) => b.s - a.s || (a.entry.at < b.entry.at ? 1 : -1))
      .slice(0, limit)
      .map((x) => x.entry)
  }

  const clip = (s, max) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max)}…` : t
  }

  async function add(who, { sessionId, userText, replyText }) {
    if (!who?.userId) return null
    const u = clip(userText, limits.userText)
    if (!u) return null
    const at = new Date(now()).toISOString()
    const entry = {
      id: `rcl_${randomUUID()}`,
      applicationId: String(who.applicationId),
      orgId: String(who.orgId),
      userId: who.userId,
      sessionId: sessionId ?? null,
      at,
      userText: u,
      replyText: replyText ? clip(replyText, limits.replyText) : null,
      expiresAt: new Date(now() + Math.max(1, Number(retentionDays()) || 1) * DAY).toISOString(),
    }
    await table.put(entry.id, entry)
    // 本人の件数の上限：古いものから消す
    const own = list(who)
    for (const old of own.slice(limits.perUser)) await table.delete(old.id)
    return entry
  }

  async function forget(who, { all: everything = false, id } = {}) {
    let removed = 0
    for (const entry of list(who)) {
      if (everything || entry.id === id) {
        await table.delete(entry.id)
        removed += 1
      }
    }
    return removed
  }

  async function purgeExpired() {
    let removed = 0
    for (const [key, entry] of [...table.entries()]) {
      if (!(Date.parse(entry?.expiresAt ?? '') > now())) {
        await table.delete(key)
        removed += 1
      }
    }
    if (removed) logger.info?.('bridge-memory: purged %d expired recall entries', removed)
    return removed
  }

  function count() {
    let n = 0
    for (const [, entry] of table.entries()) if (Date.parse(entry?.expiresAt ?? '') > now()) n += 1
    return n
  }

  return { list, search, add, forget, purgeExpired, count }
}
