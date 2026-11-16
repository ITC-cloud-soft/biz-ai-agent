import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  createHttpStats, createLogger, errorFields, instrumentRequest, ipPrefix, isSensitiveKey, maskAttrs, maskMessage, maskPath, maskString,
  outgoingHeaders, parseTraceparent, storedTraceparent, traceFromHeaders, traceFromStored,
} from '../src/index.mjs'

const capture = (opts = {}) => {
  const lines = []
  const logger = createLogger({ app: 'test', service: 'svc', version: 'abc1234', env: 'test', write: (l) => lines.push(l), ...opts })
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) }
}

// fictional personal data that must never reach a line (canary)
const CANARY = {
  name: '試験 花子', email: 'hanako.test@example.jp', phone: '090-1234-5678', insured: '1234567890', myNumber: '123456789012',
  account: '7654321', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXRlc3Q', note: '朝食を半分残した',
}

test('sensitive keys are masked whatever the value; ids, counts and codes are kept', () => {
  for (const k of ['name', 'display_name', 'resident_name', 'email', 'phone', 'note', 'body', 'password', 'authorization', 'account_number', 'insured_number', 'my_number', 'Set-Cookie']) {
    assert.equal(isSensitiveKey(k), true, k)
  }
  for (const k of ['resident_id', 'name_count', 'event', 'code', 'reason', 'role', 'duration_ms', 'body_bytes', 'status']) assert.equal(isSensitiveKey(k), false, k)
  const { value, masked } = maskAttrs({ resident_id: 'r_1', name: CANARY.name, nested: { note: CANARY.note, items: 3 }, list: [{ email: 'x' }] })
  assert.equal(masked, true)
  assert.deepEqual(value, { resident_id: 'r_1', name: '[masked]', nested: { note: '[masked]', items: 3 }, list: [{ email: '[masked]' }] })
})

test('value shapes are masked under any key', () => {
  assert.equal(maskString(`mail ${CANARY.email}`).value, 'mail [email]')
  assert.equal(maskString(`tel ${CANARY.phone}`).value, 'tel [phone]')
  assert.equal(maskString(`no ${CANARY.insured}`).value, 'no [digits]')
  assert.equal(maskString(`no ${CANARY.myNumber}`).value, 'no [digits]')
  assert.equal(maskString(`acct ${CANARY.account}`).value, 'acct [digits]')
  assert.equal(maskString(CANARY.token).value, '[jwt]')
  assert.equal(maskString('Authorization: Bearer abcdefghijklmnop').value, 'Authorization: Bearer [masked]')
  assert.equal(maskString('/s/link?token=abc123&x=1').value, '/s/link?token=[masked]&x=1')
  // ids, amounts and dates stay readable
  assert.equal(maskString('invoice 9c4584e1-1111-2222-3333-444455556666 amount 139908 on 2026-11-06').value, 'invoice 9c4584e1-1111-2222-3333-444455556666 amount 139908 on 2026-11-06')
})

test('database messages lose the quoted values', () => {
  const m = maskMessage('duplicate key value violates unique constraint "resident_name_key" Key (name)=(試験 花子) already exists')
  assert.equal(m.value.includes('試験'), false)
  assert.match(m.value, /\)=\(…\)/)
  assert.equal(maskMessage('invalid input syntax for type uuid: "abc"').value, 'invalid input syntax for type uuid: "…"')
})

test('a line has the RSI §5.1 fields and pii says what happened', () => {
  const { logger, parsed } = capture()
  const trace = traceFromHeaders({})
  logger.child({ trace, tenantId: 't1', actor: { type: 'user', id: 'u1', role: 'billing' } })
    .info('invoice.finalize.done', { msg: 'finalized', attrs: { invoice_id: 'inv_1', items: 2 } })
  logger.warn('resident.import.rejected', { attrs: { name: CANARY.name } })
  const [a, b] = parsed()
  for (const k of ['ts', 'level', 'app', 'service', 'version', 'env', 'kind', 'trace_id', 'span_id', 'event', 'msg', 'pii']) assert.ok(k in a, k)
  assert.equal(a.service, 'svc'); assert.equal(a.kind, 'app'); assert.equal(a.tenant_id, 't1'); assert.equal(a.trace_id, trace.traceId)
  assert.equal(a.request_id, trace.requestId); assert.deepEqual(a.actor, { type: 'user', id: 'u1', role: 'billing' }); assert.equal(a.pii, 'none')
  assert.equal(b.pii, 'masked'); assert.equal(b.attrs.name, '[masked]')
})

test('levels filter; bad event names are replaced; the logger never throws', () => {
  const { logger, parsed } = capture({ level: 'warn' })
  logger.info('x.y', {})
  logger.error('Not An Event', {})
  const bad = {}; bad.self = bad
  logger.error('x.cycle', { attrs: bad })
  assert.deepEqual(parsed().map((l) => l.event), ['log.invalid_event', 'x.cycle'])
  const throwing = createLogger({ service: 's', write: () => { throw new Error('disk full') } })
  assert.doesNotThrow(() => throwing.error('x.y', {}))
})

test('errors: fingerprinted, no detail, the same cause gives the same fingerprint', () => {
  const pgError = () => Object.assign(new Error('new row violates check constraint "invoice_amount_check"'), {
    code: '23514', constraint: 'invoice_amount_check', table: 'invoice', detail: `Failing row contains (${CANARY.name}, ${CANARY.phone})`,
  })
  const a = errorFields(pgError(), { service: 'care-api', route: '/api/invoices/:id/finalize' })
  const b = errorFields(pgError(), { service: 'care-api', route: '/api/invoices/:id/finalize' })
  assert.equal(a.fingerprint, b.fingerprint)
  assert.equal(a.code, '23514'); assert.equal(a.constraint, 'invoice_amount_check')
  assert.equal(JSON.stringify(a).includes('Failing row'), false)
  assert.notEqual(errorFields(pgError(), { service: 'care-api', route: '/other' }).fingerprint, a.fingerprint)
  assert.ok(a.frames.length > 0 && !a.frames.some((f) => /:\d+/.test(f)))
})

test('console adapter: legacy log.error("[x] …", error) becomes a masked line', () => {
  const { logger, parsed } = capture()
  const c = logger.console()
  c.error('[care-api] unhandled error', Object.assign(new Error(`boom for ${CANARY.email}`), { detail: CANARY.name }))
  c.log('processed', { name: CANARY.name, count: 3 })
  const [e, p] = parsed()
  assert.equal(e.event, 'log.console'); assert.equal(e.msg, 'unhandled error'); assert.equal(e.err.message, 'boom for [email]')
  assert.equal(p.attrs.args[0].name, '[masked]'); assert.equal(p.attrs.args[0].count, 3)
})

test('trace: continue a traceparent, derive from a UUID request id, or start new', () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  assert.deepEqual(parseTraceparent(tp), { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId: '00f067aa0ba902b7', flags: '01' })
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null)
  const t1 = traceFromHeaders({ traceparent: tp, 'x-request-id': 'req-abcdef12' })
  assert.equal(t1.traceId, '4bf92f3577b34da6a3ce929d0e0e4736'); assert.equal(t1.parentSpanId, '00f067aa0ba902b7'); assert.equal(t1.requestId, 'req-abcdef12')
  const t2 = traceFromHeaders({ 'x-request-id': '9c4584e1-1111-2222-3333-444455556666' })
  assert.equal(t2.traceId, '9c4584e1111122223333444455556666')
  const t3 = traceFromHeaders({ 'x-request-id': 'bad id!' })
  assert.equal(t3.requestId, t3.traceId.slice(0, 16))
  const out = outgoingHeaders(t1)
  assert.equal(parseTraceparent(out.traceparent).traceId, t1.traceId)
  assert.equal(traceFromStored(storedTraceparent(t1)).traceId, t1.traceId)
  assert.equal(traceFromStored(null).traceId.length, 32)
})

test('paths and IPs keep no values', () => {
  assert.equal(maskPath('/api/residents/9c4584e1-1111-2222-3333-444455556666/records/12'), '/api/residents/:id/records/:n')
  assert.equal(maskPath('/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123'), '/s/:x')
  assert.equal(ipPrefix('203.0.113.129'), '203.0.113.0/24')
  assert.equal(ipPrefix('2001:db8:1:2::5'), '2001:db8:1::/48')
})

test('instrumentRequest: x-request-id out, one access line with the route template, security events keep the IP', async () => {
  const { logger, parsed } = capture()
  const stats = createHttpStats()
  const server = createServer((req, res) => {
    const t = instrumentRequest(req, res, { logger, stats, trustForwarded: true })
    if (req.url.startsWith('/missing')) { res.statusCode = 404; return res.end() }
    t.route = '/api/residents/:id'
    t.tenantId = 't1'
    t.actor = { type: 'user', id: 'u1', role: 'manager' }
    t.security('auth.login.failed', { attrs: { method: 'password', reason: 'invalid_credentials' } })
    res.setHeader('content-length', 2)
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const r = await fetch(`http://127.0.0.1:${port}/api/residents/9c4584e1-1111-2222-3333-444455556666?name=${encodeURIComponent(CANARY.name)}`, {
    headers: { 'x-forwarded-for': '203.0.113.129, 10.0.0.2', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
  })
  await r.text()
  await (await fetch(`http://127.0.0.1:${port}/missing`)).text()
  await new Promise((resolve) => setTimeout(resolve, 20))
  server.close()
  assert.ok(r.headers.get('x-request-id'))
  const lines = parsed()
  const sec = lines.find((l) => l.kind === 'security')
  const acc = lines.filter((l) => l.kind === 'access')
  assert.equal(acc.length, 1) // the 404 is only counted
  assert.equal(acc[0].http.route, '/api/residents/:id'); assert.equal(acc[0].http.status, 200); assert.equal(acc[0].http.ip_prefix, '203.0.113.0/24')
  assert.equal(acc[0].trace_id, '4bf92f3577b34da6a3ce929d0e0e4736'); assert.equal(acc[0].tenant_id, 't1'); assert.equal(acc[0].pii, 'none')
  assert.equal(sec.ip, '203.0.113.129'); assert.equal(sec.pii, 'restricted'); assert.equal(sec.event, 'auth.login.failed')
  assert.equal(Object.values(stats.snapshot()).reduce((a, b) => a + b, 0), 2)
  const all = lines.map((l) => JSON.stringify(l)).join('\n')
  for (const v of Object.values(CANARY)) assert.equal(all.includes(v), false, `canary leaked: ${v}`)
})

test('runWithTrace: code deep in a request reads the trace; outside a request there is none', async () => {
  const { runWithTrace, currentTrace, currentTraceparent, traceFromHeaders: fromHeaders, parseTraceparent: parse } = await import('../src/index.mjs')
  assert.equal(currentTrace(), null)
  assert.equal(currentTraceparent(), null)
  const trace = fromHeaders({})
  const seen = await runWithTrace(trace, async () => {
    await new Promise((r) => setTimeout(r, 5))
    return { id: currentTrace()?.traceId, stored: parse(currentTraceparent())?.traceId }
  })
  assert.deepEqual(seen, { id: trace.traceId, stored: trace.traceId })
})
