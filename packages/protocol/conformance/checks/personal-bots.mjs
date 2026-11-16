// B: personal IM bots (invariant 1 / 5): registration is BFF-only, a bot belongs to exactly one employee,
// and a link code sent through a personal bot is accepted only from the bot's registrant.
import assert from 'node:assert/strict'

const REQ = { requires: ['capability:personalBots', 'fixture:personalBotPlatform'] }

export function register(s) {
  const botSource = (c, bot, extra = {}) => c.newSource({ platform: c.fx.personalBotPlatform, botId: bot, ...extra })
  const botId = (c) => `wxbot-${c.rnd()}@im.bot`
  const register = (c, emp, bot, headers = c.as.bff(emp)) => c.api.post(c.v1('/me/personal-bots'), headers, { platform: c.fx.personalBotPlatform, botId: bot })

  s.check('B1', 'registering a personal bot needs the employee session AND the BFF secret; nobody else can register one', async (c) => {
    const owner = await c.fx.newEmployee('staff')
    const bot = botId(c)
    c.err(await register(c, owner, bot, c.as.user(owner)), 403, ['bff_only'], 'employee without the BFF secret')
    c.err(await register(c, owner, bot, c.as.bff(owner, `${c.target.bffSecret}x`)), 403, ['bff_only'], 'wrong BFF secret')
    c.err(await c.api.post(c.v1('/me/personal-bots'), { 'x-bff-secret': c.target.bffSecret }, { platform: c.fx.personalBotPlatform, botId: bot }), 401, null, 'BFF secret without a session')
    c.err(await c.api.post(c.v1('/me/personal-bots'), { ...c.as.service(), 'x-bff-secret': c.target.bffSecret }, { platform: c.fx.personalBotPlatform, botId: bot }), 403, null, 'service principal with the secret')
    const d = await c.linkedDelegation('staff')
    c.err(await c.api.post(c.v1('/me/personal-bots'), { ...c.as.delegated(d.token), 'x-bff-secret': c.target.bffSecret }, { platform: c.fx.personalBotPlatform, botId: bot }), 403,
      ['delegation_not_permitted'], 'delegation with the secret')
    const none = await c.api.get(c.v1('/me/personal-bots'), c.as.user(owner))
    c.ok(none, 200)
    assert.ok(!none.body.bots.some((b) => b.botId === bot), 'no refused attempt may leave a registration behind')

    const created = await register(c, owner, bot)
    c.ok(created, 201, 'BFF registration')
    c.shape('registerMyPersonalBot', 201, created)
    assert.equal(created.body.created, true)
    const again = await register(c, owner, bot)
    c.ok(again, 200, 'idempotent for the registrant')
    assert.equal(again.body.created, false)
    assert.equal(again.body.bot.id, created.body.bot.id)
  }, REQ)

  s.check('B2', 'a bot registered by someone else is 409 (admin included); only the allowed platform; own list only', async (c) => {
    const owner = await c.fx.newEmployee('billing')
    const bot = botId(c)
    c.ok(await register(c, owner, bot), 201)
    for (const other of [c.fx.employees.admin, await c.fx.newEmployee('staff')]) {
      c.err(await register(c, other, bot), 409, ['bot_already_registered'], `registration by ${other.role}`)
    }
    c.err(await c.api.post(c.v1('/me/personal-bots'), c.as.bff(owner), { platform: 'definitely-not-personal', botId: botId(c) }), 400, null, 'platform that has no personal bots')
    c.err(await c.api.post(c.v1('/me/personal-bots'), c.as.bff(owner), { platform: c.fx.personalBotPlatform, botId: botId(c), userId: c.fx.employees.admin.id }), 400, null, 'extra key')
    c.err(await c.api.post(c.v1('/me/personal-bots'), c.as.bff(owner), { platform: c.fx.personalBotPlatform }), 400, null, 'missing botId')
    const mine = await c.api.get(c.v1('/me/personal-bots'), c.as.user(owner))
    c.ok(mine, 200)
    c.shape('listMyPersonalBots', 200, mine)
    assert.ok(mine.body.bots.some((b) => b.botId === bot))
    for (const other of [c.fx.employees.admin, c.fx.employees.staff]) {
      const theirs = await c.api.get(c.v1('/me/personal-bots'), c.as.user(other))
      assert.ok(!theirs.body.bots.some((b) => b.botId === bot), `${other.role} must not see someone else's bot`)
    }
    c.err(await c.api.get(c.v1('/me/personal-bots'), c.as.service()), 403, null, 'service principal')
    c.err(await c.api.get(c.v1('/me/personal-bots'), c.as.anon()), 401, null, 'anonymous')
  }, REQ)

  s.check('B3', 'owner rule: another employee\'s link code sent through my personal bot is refused (403) and burnt; my own code links', async (c) => {
    const owner = await c.fx.newEmployee('staff')
    const intruder = await c.fx.newEmployee('billing')
    const bot = botId(c)
    c.ok(await register(c, owner, bot), 201)
    const code = await c.issueLinkCode(intruder)
    const source = botSource(c, bot)
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source }), 403, ['personal_bot_owner_mismatch'], 'intruder code via the owner\'s bot')
    assert.equal((await c.lookup(source)).body.linked, false, 'nothing may be linked')
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: c.newSource() }), 404, ['link_code_invalid'], 'the code that reached someone else\'s bot is burnt')
    const own = await c.issueLinkCode(owner)
    const linked = await c.api.post(c.v1('/identities/link'), c.as.service(), { code: own.body.code, source })
    c.ok(linked, 200, 'owner links through their own bot')
    assert.equal(linked.body.user.id, owner.id)
  }, REQ)

  s.check('B4', 'unlinking the account linked through my personal bot retires the bot; a retired bot accepts nobody', async (c) => {
    const owner = await c.fx.newEmployee('manager')
    const bot = botId(c)
    c.ok(await register(c, owner, bot), 201)
    const source = botSource(c, bot)
    await c.linkEmployee(owner, source)
    const row = (await c.api.get(c.v1('/me/identities'), c.as.user(owner))).body.identities.find((i) => i.externalId === source.userId)
    assert.equal(row.botId, bot, 'the link records the bot it came through')
    const del = await c.api.del(c.v1(`/me/identities/${row.id}`), c.as.user(owner))
    c.ok(del, 200)
    assert.equal(del.body.personalBotRevoked, true)
    const mine = await c.api.get(c.v1('/me/personal-bots'), c.as.user(owner))
    assert.ok(!mine.body.bots.some((b) => b.botId === bot), 'the retired bot is not listed')
    for (const who of [owner, await c.fx.newEmployee('staff')]) {
      const code = await c.issueLinkCode(who)
      c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: botSource(c, bot) }), 403, ['personal_bot_revoked'], `link by ${who.role} through the retired bot`)
    }
  }, REQ)
}
