// L: invariant 1 (link yourself only) and invariant 2 (an unlinked sender gets nothing); link codes.
import assert from 'node:assert/strict'

export function register(s) {
  s.check('L1', 'an SNS account that is not linked is answered linked:false and nothing else (no user, no hint)', async (c) => {
    const source = c.newSource()
    const r = await c.lookup(source)
    c.ok(r, 200, 'identity lookup')
    c.shape('lookupIdentity', 200, r)
    assert.equal(r.body.linked, false)
    assert.ok(!('user' in r.body), 'no user object for an unlinked account')
    const keys = Object.keys(r.body).sort()
    assert.deepEqual(keys.filter((k) => !['ok', 'linked', 'orgId'].includes(k)), [], `unexpected keys for an unlinked lookup: ${keys}`)
    // and it can never obtain a delegation (so no business data): see D1
  })

  s.check('L2', 'link codes are issued only by a logged-in employee: anonymous 401, service principal 403, delegation 403', async (c) => {
    const emp = await c.fx.newEmployee('staff')
    const path = c.v1('/me/link-codes')
    c.err(await c.api.post(path, c.as.anon(), {}), 401, null, 'anonymous')
    c.err(await c.api.post(path, c.as.service(), {}), 403, null, 'service principal')
    const d = await c.linkedDelegation('staff')
    c.err(await c.api.post(path, c.as.delegated(d.token), {}), 403, ['delegation_not_permitted'], 'delegation token')
    const ok = await c.issueLinkCode(emp)
    c.ok(ok, 201, 'employee')
    c.shape('createLinkCode', 201, ok)
    const ttl = Date.parse(ok.body.expiresAt) - Date.now()
    assert.ok(ttl > 0 && ttl <= 10 * 60_000 + 5_000, `link code lifetime must be at most 10 minutes (got ${Math.round(ttl / 1000)} s)`)
  })

  s.check('L3', 'a link code binds the employee who ISSUED it; a userId in the request body changes nothing', async (c) => {
    const issuer = await c.fx.newEmployee('staff')
    const victim = c.fx.employees.admin
    const source = c.newSource()
    const code = await c.issueLinkCode(issuer, { userId: victim.id, employeeId: victim.id, user: { id: victim.id }, role: 'admin' })
    c.ok(code, 201, 'issue with a forged userId')
    const linked = await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source })
    c.ok(linked, 200, 'link')
    c.shape('linkIdentity', 200, linked)
    assert.equal(linked.body.user.id, issuer.id, 'the account must be linked to the issuer')
    assert.notEqual(linked.body.user.id, victim.id)
    const found = await c.lookup(source)
    assert.equal(found.body.linked, true)
    assert.equal(found.body.user.id, issuer.id)
    assert.equal(found.body.user.role, issuer.role, 'the role comes from the business system, not from the request')
  })

  s.check('L4', 'a link code is single use; issuing a new code revokes the previous unused one; the link body takes only code and source', async (c) => {
    const emp = await c.fx.newEmployee('manager')
    const first = await c.issueLinkCode(emp)
    c.ok(first, 201)
    const second = await c.issueLinkCode(emp)
    c.ok(second, 201)
    if (first.body.code !== second.body.code) {
      c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: first.body.code, source: c.newSource() }), 404, ['link_code_invalid'], 'revoked by the newer code')
    }
    const source = c.newSource()
    c.ok(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: second.body.code, source }), 200, 'first use')
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: second.body.code, source: c.newSource() }), 404, ['link_code_invalid'], 'second use')
    // the same account cannot be linked twice (to anyone)
    const other = await c.issueLinkCode(await c.fx.newEmployee('billing'))
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: other.body.code, source }), 409, ['identity_already_linked'], 'account already linked')
    // strict body
    const third = await c.issueLinkCode(emp)
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: third.body.code, source: c.newSource(), userId: c.fx.employees.admin.id }), 400, null, 'extra body key')
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: '12ab56', source: c.newSource() }), 400, null, 'malformed code')
  })

  s.check('L5', 'link codes expire (410) and an expired code cannot be retried', async (c) => {
    const emp = await c.fx.newEmployee('staff')
    const code = await c.issueLinkCode(emp)
    c.ok(code, 201)
    await c.fx.hooks.expireLinkCode(emp)
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: c.newSource() }), 410, ['link_code_expired'], 'expired')
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: c.newSource() }), 404, ['link_code_invalid'], 'retry after expiry')
  }, { requires: ['hook:expireLinkCode'] })

  s.check('L6', 'guessing link codes is throttled per source (429) and a locked source cannot consume a valid code', async (c) => {
    const locked = c.newSource()
    let first429 = -1
    for (let i = 0; i < 12; i += 1) {
      const guess = String(Math.floor(100000 + Math.random() * 900000))
      const r = await c.api.post(c.v1('/identities/link'), c.as.service(), { code: guess, source: locked })
      if (r.status === 429) { c.err(r, 429, ['too_many_attempts']); first429 = i; break }
      c.err(r, [404, 410], ['link_code_invalid', 'link_code_expired'], `guess ${i}`)
    }
    assert.ok(first429 >= 0, 'no 429 after 12 wrong codes from one source')
    const emp = await c.fx.newEmployee('staff')
    const code = await c.issueLinkCode(emp)
    c.err(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: locked }), 429, ['too_many_attempts'], 'locked source with a valid code')
    c.ok(await c.api.post(c.v1('/identities/link'), c.as.service(), { code: code.body.code, source: c.newSource() }), 200, 'the valid code still works from another source')
  })

  s.check('L7', 'an employee sees and unlinks only their own links; admin cannot see or unlink anyone else\'s (404)', async (c) => {
    const owner = await c.fx.newEmployee('staff')
    const { source } = await c.linkEmployee(owner)
    const mine = await c.api.get(c.v1('/me/identities'), c.as.user(owner))
    c.ok(mine, 200, 'owner list')
    c.shape('listMyIdentities', 200, mine)
    const row = mine.body.identities.find((i) => i.externalId === source.userId)
    assert.ok(row, 'the owner sees the link')
    const admin = c.fx.employees.admin
    const adminList = await c.api.get(c.v1('/me/identities'), c.as.user(admin))
    c.ok(adminList, 200)
    assert.ok(!adminList.body.identities.some((i) => i.id === row.id || i.externalId === source.userId), 'admin must not see another employee\'s link')
    c.err(await c.api.del(c.v1(`/me/identities/${row.id}`), c.as.user(admin)), 404, ['identity_not_found'], 'admin unlinking another employee')
    c.err(await c.api.get(c.v1(`/me/identities/${row.id}/bot`), c.as.user(admin)), 404, ['identity_not_found'], 'admin reading another employee\'s bot')
    c.err(await c.api.del(c.v1(`/me/identities/${row.id}`), c.as.service()), 403, null, 'service principal unlinking')
    assert.equal((await c.lookup(source)).body.linked, true, 'the link survived every refused attempt')
    const bot = await c.api.get(c.v1(`/me/identities/${row.id}/bot`), c.as.user(owner))
    c.ok(bot, 200, 'owner reads their own link\'s bot')
    c.shape('getMyIdentityBot', 200, bot)
  })

  s.check('L8', 'there is no operation that binds an SNS account on behalf of an employee (admin included)', async (c) => {
    const target = await c.fx.newEmployee('billing')
    const source = c.newSource()
    const admin = c.fx.employees.admin
    const body = { userId: target.id, platform: source.platform, teamId: source.teamId, externalId: source.userId, source }
    const r = await c.api.post(c.v1('/me/identities'), c.as.user(admin), body)
    c.err(r, [404, 405], ['not_found', 'method_not_allowed'], 'bind on behalf')
    c.err(await c.api.post(c.v1('/me/identities'), c.as.service(), body), [403, 404, 405], null, 'bind on behalf by the service principal')
    assert.equal((await c.lookup(source)).body.linked, false)
  })

  s.check('L9', 'unlinking ends the delegation tokens of that account at once and emits sns_identity.unlinked', async (c) => {
    const start = await c.latestEventCursor()
    const owner = await c.fx.newEmployee('manager')
    const { source } = await c.linkEmployee(owner)
    const d = await c.delegationFor(source)
    c.ok(await c.delegatedProbe(d.token), 200, 'token works before unlinking')
    const row = (await c.api.get(c.v1('/me/identities'), c.as.user(owner))).body.identities.find((i) => i.externalId === source.userId)
    const del = await c.api.del(c.v1(`/me/identities/${row.id}`), c.as.user(owner))
    c.ok(del, 200, 'unlink')
    c.shape('deleteMyIdentity', 200, del)
    c.err(await c.delegatedProbe(d.token), 401, ['invalid_delegation_token'], 'token after unlinking')
    assert.equal((await c.lookup(source)).body.linked, false)
    c.err(await c.api.post(c.v1('/delegations'), c.as.service(), { source }), 404, ['identity_not_linked'], 'new delegation after unlinking')
    const page = await c.api.get(c.v1('/events'), c.as.service(), { after: start, limit: 500 })
    c.ok(page, 200)
    const ev = page.body.events.find((e) => e.type === 'sns_identity.unlinked' && e.payload?.userId === owner.id)
    assert.ok(ev, 'sns_identity.unlinked event for the unlinked employee')
    assert.equal(ev.payload.platform, source.platform)
  })

  s.check('L10', 'identity statistics are counts only (no personal data)', async (c) => {
    const r = await c.api.get(c.v1('/identities/stats'), c.as.service())
    c.ok(r, 200)
    c.shape('identityStats', 200, r)
    assert.ok(Number.isInteger(r.body.linkedCount) && Number.isInteger(r.body.linkedUsers))
    assert.ok(r.body.linkedUsers <= r.body.linkedCount)
  })
}
