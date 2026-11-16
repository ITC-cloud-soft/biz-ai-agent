// The sign-in page: the screen's look for the system's own login; no open redirect, no inline code without this response's nonce.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redirectToSignIn, safeNext, signInPage } from '../src/index.mjs'

test('the sign-in page: its language, the system name escaped, the nonce in the CSP and on its only script and style', () => {
  const { html, headers } = signInPage({ lang: 'zh', system: { name: 'A&B <x>' }, next: '/me/sns' })
  assert.match(html, /<html lang="zh-CN">[\s\S]*<title>登录 — A&amp;B &lt;x&gt;<\/title>/)
  assert.doesNotMatch(html, /<x>/)
  const nonce = headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1]
  assert.equal(html.match(/<script nonce="([^"]+)">/)[1], nonce)
  assert.equal(html.match(/<style nonce="([^"]+)">/)[1], nonce)
  assert.equal((html.match(/<script(?![^>]*type="application\/json")/g) ?? []).length, 1, 'one script, nothing external')
  assert.match(html, /"next":"\/me\/sns"/)
  assert.notEqual(signInPage().headers['content-security-policy'], headers['content-security-policy'], 'a new nonce per response')
  assert.match(signInPage({ acceptLanguage: 'en-US,en;q=0.9' }).html, /<html lang="en">[\s\S]*Sign in/)
  assert.match(signInPage({ lang: 'ja' }).html, /サインイン/)
})

test('only a path on this site is a destination', () => {
  for (const bad of ['https://evil.example', '//evil.example', '/' + String.fromCharCode(92) + 'evil.example', 'javascript:alert(1)', '/a"b', '', null]) assert.equal(safeNext(bad), '/agent-settings', String(bad))
  assert.equal(safeNext('/me/sns?lang=en'), '/me/sns?lang=en')
  assert.match(signInPage({ next: '//evil.example' }).html, /"next":"\/agent-settings"/)
})

test('a browser without a session on a screen goes to the sign-in page and back; anything else passes', async () => {
  const run = async (method, url, accept, user) => {
    const res = { status: 0, headers: {}, writeHead(s, h) { this.status = s; this.headers = h }, end() {} }
    const done = await redirectToSignIn({ method, url, headers: { accept } }, res, { authenticate: async () => user })
    return { done, ...res }
  }
  const r = await run('GET', '/me/sns?lang=en', 'text/html,*/*', null)
  assert.equal(r.done, true)
  assert.equal(r.status, 302)
  assert.equal(r.headers.location, '/login?lang=en&next=%2Fme%2Fsns%3Flang%3Den')
  assert.equal((await run('GET', '/agent-settings', 'text/html', { user: {} })).done, false, 'signed in')
  assert.equal((await run('GET', '/api/agent/settings', 'text/html', null)).done, false, 'not a screen')
  assert.equal((await run('GET', '/agent-settings', 'application/json', null)).done, false, 'an API client gets its 401')
  assert.equal((await run('POST', '/agent-settings', 'text/html', null)).done, false)
})
