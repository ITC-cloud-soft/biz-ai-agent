import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-auto-tasks-http-'))

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
  schedule: {
    async create() { return { id: 'sch-http' } },
    async delete() {},
    async catalog() { return [] },
  },
  webServer: { register(route) { handler = route.handler; return () => { handler = null } } },
}
plugin.apply(ctx, {})

const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
after(() => new Promise((resolve) => server.close(resolve)))

const CLIENT = { 'x-auto-tasks-client': 'cli' }

test('http: write without client header is rejected', async () => {
  const res = await fetch(`${base}/auto-tasks/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's', name: 'x', instruction: 'y' }),
  })
  assert.equal(res.status, 403)
})

test('http: cross-origin write is rejected', async () => {
  const res = await fetch(`${base}/auto-tasks/api/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auto-tasks-client': 'cli',
      origin: 'https://evil.example',
    },
    body: JSON.stringify({ sessionId: 's', name: 'x', instruction: 'y' }),
  })
  assert.equal(res.status, 403)
})

test('http: client header creates and deletes a task', async () => {
  const create = await fetch(`${base}/auto-tasks/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT },
    body: JSON.stringify({
      sessionId: 's', name: 'http-contract', instruction: 'y', enabled: true,
      trigger: { type: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Tokyo' },
      delivery: { channels: [] }, feedback: { deliverOn: ['done'] },
    }),
  })
  assert.equal(create.status, 200)
  const { task } = await create.json()
  assert.ok(task?.id)
  const del = await fetch(`${base}/auto-tasks/api/tasks/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT },
    body: JSON.stringify({ id: task.id }),
  })
  assert.equal(del.status, 200)
})

test('http: mail send requires confirm header', async () => {
  const res = await fetch(`${base}/auto-tasks/api/mail/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT },
    body: JSON.stringify({ to: 'a@b', subject: 's', text: 't' }),
  })
  assert.equal(res.status, 403)
})

test('http: read-only health is open on loopback', async () => {
  const res = await fetch(`${base}/auto-tasks/api/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
})
