// The context handed to every check: HTTP helpers, actors, assertions and linking helpers.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { validateSchema, formatErrors } from '../../src/jsonschema.mjs'
import { responseSchema } from '../../src/openapi.mjs'

export function buildContext(target) {
  const fx = target.fx
  const V = target.basePath
  const rnd = () => randomBytes(4).toString('hex')

  // ------------------------------------------------------------ actors (header sets)
  const as = {
    anon: () => ({}),
    service: (token = target.serviceToken) => ({ 'x-service-token': token }),
    delegated: (token) => ({ 'x-service-token': target.serviceToken, 'x-delegation-token': token }),
    user: (emp) => ({ ...emp.headers }),
    /** The BFF: the employee's own session plus the shared BFF secret. */
    bff: (emp, secret = target.bffSecret) => ({ ...emp.headers, ...(secret ? { 'x-bff-secret': secret } : {}) }),
  }

  // ------------------------------------------------------------ HTTP
  const api = {
    get: (path, headers, query) => target.send({ method: 'GET', path, headers, query }),
    post: (path, headers, body = {}, query) => target.send({ method: 'POST', path, headers, body, query }),
    put: (path, headers, body = {}) => target.send({ method: 'PUT', path, headers, body }),
    del: (path, headers) => target.send({ method: 'DELETE', path, headers }),
  }
  const v1 = (p) => `${V}${p}`

  // ------------------------------------------------------------ assertions
  const describeRes = (res) => `${res.request?.method ?? ''} ${res.request?.path ?? ''} -> ${res.status} ${String(res.text).slice(0, 240)}`
  const ok = (res, status, label = '') => assert.equal(res.status, status, `${label ? `${label}: ` : ''}expected ${status}: ${describeRes(res)}`)
  /** An error response: status, envelope { ok:false, error }, and (optionally) one of the stable codes. */
  const err = (res, status, codes = null, label = '') => {
    const statuses = Array.isArray(status) ? status : [status]
    assert.ok(statuses.includes(res.status), `${label ? `${label}: ` : ''}expected ${statuses.join('/')}: ${describeRes(res)}`)
    assert.ok(res.body && res.body.ok === false && typeof res.body.error === 'string' && /^[A-Za-z0-9_.]+$/.test(res.body.error),
      `${label ? `${label}: ` : ''}error envelope { ok:false, error:<code> } expected: ${describeRes(res)} (the strict snake_case rule is checked once, by P6)`)
    if (codes) {
      const list = Array.isArray(codes) ? codes : [codes]
      assert.ok(list.includes(res.body.error) || list.some((c) => c.endsWith('*') && res.body.error.startsWith(c.slice(0, -1))),
        `${label ? `${label}: ` : ''}error code ${res.body.error} not in [${list.join(', ')}]: ${describeRes(res)}`)
    }
  }
  /** The body of a successful response matches the operation's response schema in bridge-v1.yaml. */
  const shape = (operationId, status, res) => {
    const schema = responseSchema(target.doc, operationId, status)
    assert.ok(schema, `no response schema for ${operationId} ${status}`)
    const r = validateSchema(schema, res.body, { root: target.doc })
    assert.ok(r.valid, `${operationId} ${status} body does not match the protocol schema:\n  ${formatErrors(r.errors).join('\n  ')}\n  body: ${String(res.text).slice(0, 300)}`)
  }
  const noSecrets = (res, secrets, label = '') => {
    for (const s of secrets.filter(Boolean)) assert.ok(!String(res.text).includes(s), `${label ? `${label}: ` : ''}response must not echo a secret`)
  }

  // ------------------------------------------------------------ linking helpers
  const newSource = (extra = {}) => ({ platform: fx.platform, teamId: `T${rnd()}`, userId: `U${rnd()}`, ...extra })
  const issueLinkCode = (emp, body) => api.post(v1('/me/link-codes'), as.user(emp), body ?? {})
  /** emp issues a code and links `source` with it (asserts every step). */
  async function linkEmployee(emp, source = newSource()) {
    const code = await issueLinkCode(emp)
    ok(code, 201, 'issue link code')
    const linked = await api.post(v1('/identities/link'), as.service(), { code: code.body.code, source })
    ok(linked, 200, 'link')
    assert.equal(linked.body.user.id, emp.id, 'the code links the employee who issued it')
    return { source, code: code.body.code }
  }
  const lookup = (source) => api.get(v1('/identity'), as.service(), { platform: source.platform, teamId: source.teamId, userId: source.userId })
  const delegationFor = async (source) => {
    const r = await api.post(v1('/delegations'), as.service(), { source })
    ok(r, 201, 'issue delegation')
    return r.body
  }
  /** A fresh employee of `role`, linked on a fresh source, with a fresh delegation token. */
  async function linkedDelegation(role) {
    const emp = await fx.newEmployee(role)
    const { source } = await linkEmployee(emp)
    return { emp, source, ...(await delegationFor(source)) }
  }
  const delegatedProbe = (token) => api.get(v1('/reports/latest'), as.delegated(token))
  const uuid = () => randomUUID()
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Latest event id (hook, else paging). */
  async function latestEventCursor() {
    if (fx.hooks?.latestEventCursor) return fx.hooks.latestEventCursor()
    let after = 0
    for (;;) {
      const r = await api.get(v1('/events'), as.service(), { after, limit: 500 })
      ok(r, 200, 'events')
      if (!r.body.events.length) return after
      after = r.body.nextAfter
    }
  }

  return { target, fx, api, as, v1, rnd, uuid, wait, ok, err, shape, noSecrets, newSource, issueLinkCode, linkEmployee, lookup, delegationFor, linkedDelegation, delegatedProbe, latestEventCursor, manifest: () => target.manifest }
}
