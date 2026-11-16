import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-api-'))

const plugin = await import('../lib/index.js')
let handler = null
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
  inject(_deps, cb) { return cb(ctx) },
  get(name) {
    if (name !== 'dshIm') return undefined
    return { send: async () => ({ sent: true }), listBots: async () => [], listTargets: async () => [] }
  },
  tools: { register() { return () => {} } },
  schedule: { async create() { return { id: 'sch-test' } }, async delete() {}, async catalog() { return [] } },
  webServer: { register(route) { handler = route.handler; return () => { handler = null } } },
}
plugin.apply(ctx, {})

function req(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
function res() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = String(b) },
  }
}
async function call(method, url, body, headers = {}) {
  const r = res()
  await handler(req(method, url, body, headers), r)
  let json = null
  try { json = JSON.parse(r.body) } catch { /* ignore */ }
  return { status: r.statusCode, json }
}

test('auth: write without client header is rejected', async () => {
  const r = await call('POST', '/auto-tasks/api/tasks', { sessionId: 's', name: 'x', instruction: 'y' })
  assert.equal(r.status, 403)
})

test('auth: client header allowed and task created', async () => {
  const headers = { 'x-auto-tasks-client': 'cli' }
  const r = await call('POST', '/auto-tasks/api/tasks', {
    sessionId: 's', name: 'api-contract', instruction: 'y', enabled: true,
    trigger: { type: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Tokyo' },
    delivery: { channels: [] }, feedback: { deliverOn: ['done'] },
  }, headers)
  assert.equal(r.status, 200)
  assert.ok(r.json.task?.id)
  const del = await call('POST', '/auto-tasks/api/tasks/delete', { id: r.json.task.id }, headers)
  assert.equal(del.status, 200)
})

test('auth: mail send requires confirm header', async () => {
  const headers = { 'x-auto-tasks-client': 'cli' }
  const r = await call('POST', '/auto-tasks/api/mail/send', { to: 'a@b', subject: 's', text: 't' }, headers)
  assert.equal(r.status, 403)
})

test('auth: cross-origin write rejected', async () => {
  const r = await call('POST', '/auto-tasks/api/tasks', { sessionId: 's', name: 'x', instruction: 'y' }, {
    'x-auto-tasks-client': 'cli',
    host: '127.0.0.1:3080',
    origin: 'https://evil.example',
  })
  assert.equal(r.status, 403)
})

test('poll task does not create a core schedule', async () => {
  const headers = { 'x-auto-tasks-client': 'cli' }
  const create = await call('POST', '/auto-tasks/api/tasks', {
    sessionId: 's', name: 'poll-contract', instruction: 'y', enabled: true,
    triggerMode: 'poll', delivery: { channels: [] }, feedback: { deliverOn: ['done'] },
  }, headers)
  assert.equal(create.status, 200)
  assert.equal(create.json.task.triggerMode, 'poll')
  assert.equal(create.json.task.scheduleId, null)
  const del = await call('POST', '/auto-tasks/api/tasks/delete', { id: create.json.task.id }, headers)
  assert.equal(del.status, 200)
})
