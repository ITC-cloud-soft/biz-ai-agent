// Identity: lookup, link with a code, statistics, my own links, my personal bots.
import { linkCodeHash, sixDigits } from '../crypto.mjs'
import { POLICY, userRef } from '../gate.mjs'
import { fail, HttpError, iso, parseSource, PLATFORM_RE, strictKeys, UUID_RE } from '../http.mjs'
import { StoreConflict } from '../store/errors.mjs'

export const LINK_CODE_TTL_MINUTES = 10
export const LINK_FAILURES_PER_SOURCE = 5 // per 10 minutes
export const LINK_CODES_PER_USER = 20 // issued per 10 minutes
/**
 * Channels on which an employee may connect their OWN bot (POST /me/personal-bots; createBridgeApp personalBotPlatforms default):
 * every dsh-im channel whose bots can be created per employee. Not email (notify-only), not iMessage (the DSH host's Messages).
 * Same list as ケアビリング's care-api (PERSONAL_BOT_PLATFORMS).
 */
export const PERSONAL_BOT_PLATFORMS = Object.freeze([
  'slack', 'line', 'teams', 'telegram', 'discord', 'weixin', 'whatsapp', 'wecom', 'wecom-app', 'qq', 'dingtalk', 'feishu', 'matrix',
])
// platform names that mean the same IM for a personal bot (plugin-identity / dsh-im may send either)
const PLATFORM_ALIASES = Object.freeze({ wechat: 'weixin' })
export const canonicalPlatform = (platform) => PLATFORM_ALIASES[platform] ?? platform
const sourceKey = (s) => `${s.platform}|${s.teamId}|${s.userId}`

const myIdentity = (r) => ({
  id: r.id,
  userId: r.userId,
  platform: r.platform,
  teamId: r.teamId || null,
  externalId: r.externalId,
  method: r.method,
  botId: r.botId ?? null,
  verifiedAt: iso(r.verifiedAt),
  createdAt: iso(r.createdAt),
})
const personalBot = (r) => ({ id: r.id, platform: r.platform, botId: r.botId, kind: 'personal', createdAt: iso(r.createdAt) })

/**
 * The ACTIVE employee behind a trusted IM source, or null (unknown, unlinked or deactivated). -> { identityId, id, role }
 * Owner rule (source.botId = the bot the message came through): through a registered personal bot the account resolves
 * ONLY to the bot's registrant — employee B, linked through the organisation's bot, who writes to employee A's personal bot
 * in the same workspace is "not linked" there (no lookup, no delegation, no IM decision). A retired personal bot resolves
 * nobody. Organisation bots (never registered) and sources without a botId: unchanged.
 */
export async function identityOf(kit, source, t = kit.store) {
  const identity = await t.findActiveIdentity({ platform: source.platform, teamId: source.teamId, externalId: source.userId })
  if (!identity) return null
  if (source.botId) {
    const bot = await t.getPersonalBot(canonicalPlatform(source.platform), source.botId)
    if (bot && (bot.revokedAt || bot.userId !== identity.userId)) return null
  }
  const user = await kit.employees.get(identity.userId, kit.ctx(t))
  if (!user || user.active === false) return null
  return { identityId: identity.id, id: String(user.id), role: user.role, identity }
}

export function registerIdentity(router, kit) {
  const { store, config } = kit

  router.add('GET', '/bridge/v1/identity', POLICY.SERVICE, async ({ query }) => {
    const platform = query.get('platform')
    const userId = query.get('userId')
    const teamId = query.get('teamId') ?? ''
    if (!platform || !PLATFORM_RE.test(platform)) fail(400, 'invalid_platform')
    if (!userId || userId.length > 128) fail(400, 'invalid_user_id')
    const botId = query.get('botId') || null
    if (teamId.length > 128 || (botId ?? '').length > 128) fail(400, 'invalid_source')
    const who = await identityOf(kit, { platform, teamId, userId, botId }) // botId: the personal-bot owner rule
    // not linked: linked:false and nothing else (no hint which employees exist)
    if (!who) return { status: 200, body: { ok: true, linked: false, orgId: config.orgId } }
    return { status: 200, body: { ok: true, linked: true, orgId: config.orgId, user: userRef(who) } }
  })

  router.add('POST', '/bridge/v1/identities/link', POLICY.SERVICE, async ({ body }) => {
    const b = body ?? {}
    strictKeys(b, ['code', 'source'])
    if (typeof b.code !== 'string' || !/^\d{6}$/.test(b.code)) fail(400, 'invalid_code')
    const source = parseSource(b.source)
    const key = sourceKey(source)
    if (await store.countHits('link_failure', key, 10) >= LINK_FAILURES_PER_SOURCE) fail(429, 'too_many_attempts')
    if (await store.countBucket('link_failure', 10) >= config.linkGlobalMaxFailures) fail(429, 'too_many_attempts')

    // side effects of a refusal (burning a code, counting a failure) are committed; the error is raised afterwards
    const out = await store.tx(async (t) => {
      const refuse = async (status, code, { burn = null, count = true } = {}) => {
        if (burn) await t.revokeLinkCode(burn)
        if (count) await t.addHit('link_failure', key)
        await t.audit({ actor: 'ai', action: 'identity.link_refused', target: source.platform, detail: { code } })
        return { error: new HttpError(status, code) }
      }
      const found = await t.findLiveLinkCode(linkCodeHash(kit.serverKey, b.code))
      if (!found) return refuse(404, 'link_code_invalid')
      if (new Date(found.expiresAt) <= kit.now()) return refuse(410, 'link_code_expired', { burn: found.id })
      const issuer = await kit.employees.get(found.userId, kit.ctx(t))
      if (!issuer || issuer.active === false) return refuse(404, 'link_code_invalid', { burn: found.id })
      let personal = false
      if (source.botId) {
        const bot = await t.getPersonalBot(canonicalPlatform(source.platform), source.botId)
        if (bot?.revokedAt) return refuse(403, 'personal_bot_revoked', { burn: found.id })
        // owner rule: only the registrant's own code links through a personal bot; anyone else's code is burnt
        if (bot && bot.userId !== found.userId) return refuse(403, 'personal_bot_owner_mismatch', { burn: found.id })
        personal = Boolean(bot)
      }
      if (await t.findActiveIdentity({ platform: source.platform, teamId: source.teamId, externalId: source.userId })) {
        return refuse(409, 'identity_already_linked', { count: false })
      }
      const identity = await t.insertIdentity({
        userId: found.userId, platform: source.platform, teamId: source.teamId, externalId: source.userId, botId: source.botId, method: personal ? 'personal_bot' : 'link_code',
      })
      await t.markLinkCodeUsed(found.id)
      await t.audit({ actor: found.userId, action: 'identity.linked', target: identity.id, detail: { platform: source.platform } })
      return { user: { id: issuer.id, role: issuer.role } }
    }).catch((e) => {
      if (e instanceof StoreConflict) return { error: new HttpError(409, 'identity_already_linked') } // concurrent link of the same account
      throw e
    })
    if (out.error) throw out.error
    return { status: 200, body: { ok: true, user: userRef(out.user) } }
  })

  router.add('GET', '/bridge/v1/identities/stats', POLICY.SERVICE, async () => {
    const rows = await store.listActiveIdentities()
    const users = await kit.employeesById([...new Set(rows.map((r) => r.userId))])
    const active = rows.filter((r) => users.get(r.userId)?.active !== false && users.has(r.userId))
    const byPlatform = {}
    for (const r of active) byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + 1
    return {
      status: 200,
      body: { ok: true, orgId: config.orgId, linkedCount: active.length, linkedUsers: new Set(active.map((r) => r.userId)).size, byPlatform },
    }
  })

  // ---------------------------------------------------------------- me: my own links (web session)
  router.add('POST', '/bridge/v1/me/link-codes', POLICY.USER, async ({ principal }) => {
    // the body is ignored: a userId there never changes whose code it is
    const me = principal.user
    if (await store.countHits('link_code_issue', me.id, 10) >= LINK_CODES_PER_USER) fail(429, 'too_many_requests')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = sixDigits()
      try {
        const row = await store.tx(async (t) => {
          await t.revokeLiveLinkCodes(me.id)
          const inserted = await t.insertLinkCode({ userId: me.id, codeHash: linkCodeHash(kit.serverKey, code), expiresAt: new Date(kit.now().getTime() + LINK_CODE_TTL_MINUTES * 60_000) })
          await t.addHit('link_code_issue', me.id)
          return inserted
        })
        return { status: 201, body: { ok: true, code, expiresAt: iso(row.expiresAt) } }
      } catch (e) {
        if (!(e instanceof StoreConflict)) throw e // a live code with the same digits exists: draw again
      }
    }
    fail(503, 'link_code_unavailable')
  })

  router.add('GET', '/bridge/v1/me/identities', POLICY.USER, async ({ principal }) => {
    const rows = await store.listIdentities(principal.user.id)
    return { status: 200, body: { ok: true, identities: rows.map(myIdentity) } }
  })

  router.add('DELETE', '/bridge/v1/me/identities/:identityId', POLICY.USER, async ({ principal, params }) => {
    const me = principal.user
    if (!UUID_RE.test(params.identityId)) fail(404, 'identity_not_found')
    const out = await store.tx(async (t) => {
      const row = await t.getIdentity(params.identityId)
      if (!row || row.unlinkedAt || row.userId !== me.id) fail(404, 'identity_not_found') // someone else's: not disclosed (admin included)
      await t.unlinkIdentity(row.id)
      await t.revokeDelegationsByIdentity(row.id)
      await t.revokeApprovalDeliveriesByIdentity(row.id)
      const personalBotRevoked = row.botId ? await t.revokePersonalBot({ platform: canonicalPlatform(row.platform), botId: row.botId, userId: me.id }) : false
      if (kit.manifest.events?.['sns_identity.unlinked']) {
        await kit.emitEvent(t, { type: 'sns_identity.unlinked', aggregateType: 'sns_identity', aggregateId: row.id, payload: { identityId: row.id, userId: me.id, platform: row.platform } })
      }
      await t.audit({ actor: me.id, action: 'identity.unlinked', target: row.id, detail: { personalBotRevoked } })
      return { id: row.id, personalBotRevoked }
    })
    return { status: 200, body: { ok: true, deleted: true, ...out } }
  })

  router.add('GET', '/bridge/v1/me/identities/:identityId/bot', POLICY.USER, async ({ principal, params }) => {
    if (!UUID_RE.test(params.identityId)) fail(404, 'identity_not_found')
    const row = await store.getIdentity(params.identityId)
    if (!row || row.unlinkedAt || row.userId !== principal.user.id) fail(404, 'identity_not_found')
    return { status: 200, body: { ok: true, identity: { id: row.id, platform: row.platform, botId: row.botId ?? null } } }
  })

  // ---------------------------------------------------------------- me: personal bots (registration is BFF only)
  router.add('GET', '/bridge/v1/me/personal-bots', POLICY.USER, async ({ principal }) => {
    return { status: 200, body: { ok: true, bots: (await store.listPersonalBots(principal.user.id)).map(personalBot) } }
  })

  router.add('POST', '/bridge/v1/me/personal-bots', POLICY.BFF, async ({ principal, body }) => {
    const me = principal.user
    const b = body ?? {}
    strictKeys(b, ['platform', 'botId'])
    const platform = typeof b.platform === 'string' ? canonicalPlatform(b.platform) : null
    if (!platform || !PLATFORM_RE.test(platform) || !config.personalBotPlatforms.includes(platform)) fail(400, 'invalid_platform')
    if (typeof b.botId !== 'string' || !/^[^\s]{1,128}$/.test(b.botId)) fail(400, 'invalid_bot_id')
    const out = await store.tx(async (t) => {
      const existing = await t.getPersonalBot(platform, b.botId)
      if (existing) {
        if (existing.userId !== me.id || existing.revokedAt) fail(409, 'bot_already_registered')
        return { status: 200, bot: existing, created: false }
      }
      const bot = await t.insertPersonalBot({ userId: me.id, platform, botId: b.botId })
      await t.audit({ actor: me.id, action: 'personal_bot.registered', target: bot.id, detail: { platform } })
      return { status: 201, bot, created: true }
    }).catch((e) => {
      if (e instanceof StoreConflict) fail(409, 'bot_already_registered')
      throw e
    })
    return { status: out.status, body: { ok: true, bot: personalBot(out.bot), created: out.created } }
  })
}
