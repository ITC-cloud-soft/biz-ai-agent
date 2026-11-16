// The optional help routes (routes/help.mjs): GET /bridge/v1/help/search, /help/public, /help/sections/:sectionId on the toy business.
// The help service is a fake here (its search is @dsh-bridge/help's business); the kit's part is who may ask and as which role.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { client, createToy, SERVICE_TOKEN } from './toy.mjs'

const S = { 'x-service-token': SERVICE_TOKEN }
const calls = []
const logged = []
const help = {
  search: (q, opts) => {
    calls.push({ q, ...opts })
    const pub = { id: 'manual-login', title: 'ログイン', canOpen: true, url: 'https://toy.test/login', manualUrl: null }
    const priv = { id: 'manual-tasks', title: 'タスク', canOpen: opts.role === 'admin', url: opts.role === 'admin' ? 'https://toy.test/tasks' : null, manualUrl: null }
    const results = opts.publicOnly ? [pub] : [priv, pub]
    return { found: !/天気/.test(q), results: /天気/.test(q) ? [] : results.slice(0, opts.limit ?? 3) }
  },
  section: (id, { role }) => (id === 'manual-login' || (role && id === 'manual-tasks') ? { id, title: id, canOpen: true } : null),
  onQuestion: (entry) => { logged.push(entry) },
}

let toy
let call
before(async () => {
  toy = await (await createToy({ help })).start()
  call = client(toy.base)
})
after(async () => { await toy?.stop() })

test('search: an employee asks as their role; the service principal gets the public sections only; the log gets role and channel', async () => {
  const admin = toy.addUser('admin')
  const r = await call('GET', `/bridge/v1/help/search?q=${encodeURIComponent('タスクの作り方')}&limit=2`, { headers: admin.headers })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.headers.get('bridge-protocol'), '1')
  assert.deepEqual([r.body.ok, r.body.found, r.body.query, r.body.results.map((x) => x.id)], [true, true, 'タスクの作り方', ['manual-tasks', 'manual-login']])
  assert.deepEqual(calls.at(-1), { q: 'タスクの作り方', role: 'admin', limit: 2, publicOnly: false })
  assert.deepEqual(logged.at(-1), { question: 'タスクの作り方', role: 'admin', channel: 'web', found: true, sectionIds: ['manual-tasks', 'manual-login'] })

  const svc = await call('GET', `/bridge/v1/help/search?q=${encodeURIComponent('ログイン')}`, { headers: S })
  assert.deepEqual(svc.body.results.map((x) => x.id), ['manual-login'])
  assert.deepEqual([calls.at(-1).role, calls.at(-1).publicOnly, logged.at(-1).channel], [null, true, 'public'])

  const none = await call('GET', `/bridge/v1/help/search?q=${encodeURIComponent('天気')}`, { headers: admin.headers })
  assert.deepEqual([none.body.found, none.body.results], [false, []])
})

test('errors: no q, a bad limit, anonymous', async () => {
  const staff = toy.addUser('staff')
  assert.deepEqual([(await call('GET', '/bridge/v1/help/search', { headers: staff.headers })).body.error], ['q_required'])
  assert.equal((await call('GET', '/bridge/v1/help/search?q=x&limit=9', { headers: staff.headers })).body.error, 'invalid_limit')
  assert.equal((await call('GET', '/bridge/v1/help/search?q=x')).status, 401)
})

test('public: the service principal only (an employee is refused); sections: 404 unknown, public only without an employee', async () => {
  const admin = toy.addUser('admin')
  const pub = await call('GET', `/bridge/v1/help/public?q=${encodeURIComponent('ログイン')}`, { headers: S })
  assert.deepEqual([pub.status, pub.body.results.map((x) => x.id)], [200, ['manual-login']])
  assert.equal(calls.at(-1).publicOnly, true)
  assert.equal((await call('GET', '/bridge/v1/help/public?q=x', { headers: admin.headers })).status, 403)
  assert.equal((await call('GET', '/bridge/v1/help/sections/manual-tasks', { headers: admin.headers })).body.section.id, 'manual-tasks')
  assert.equal((await call('GET', '/bridge/v1/help/sections/manual-tasks', { headers: S })).status, 404)
  assert.equal((await call('GET', '/bridge/v1/help/sections/manual-login', { headers: S })).status, 200)
  assert.equal((await call('GET', '/bridge/v1/help/sections/NOT-AN-ID', { headers: admin.headers })).status, 404)
})

test('without the help option the routes answer 404 after the gate', async () => {
  const plain = await (await createToy()).start()
  try {
    assert.equal((await client(plain.base)('GET', '/bridge/v1/help/search?q=x', { headers: S })).status, 404)
    assert.equal((await client(plain.base)('GET', '/bridge/v1/help/public?q=x')).status, 401) // the gate first, as with the option
  } finally {
    await plain.stop()
  }
})
