import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDeliveryError } from '../src/index.js'

const wrap = (message, extra = {}) => Object.assign(new Error('delivery-failed', { cause: Object.assign(new Error(message), extra) }), { code: 'delivery-failed' })

test('classifyDeliveryError: WeChat context missing / rejection, provider code read from the diagnostic text', () => {
  assert.deepEqual(classifyDeliveryError(wrap('Weixin text delivery failed (endpoint=sendmessage contextToken=no provider=-2)')),
    { reason: 'weixin_context_missing', undeliverable: 'now' })
  assert.deepEqual(classifyDeliveryError(wrap('Weixin text delivery failed (endpoint=sendmessage contextToken=yes provider=-2)')),
    { reason: 'weixin_rejected', undeliverable: 'after-retries' })
  assert.deepEqual(classifyDeliveryError(wrap('Weixin text delivery failed (endpoint=sendmessage contextToken=yes provider=-14)')),
    { reason: 'weixin_rejected_-14', undeliverable: 'after-retries' })
})

test('classifyDeliveryError: bad target is final, bot offline and unknown errors stay retryable', () => {
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { code: 'invalid-target' }), 'slack'), { reason: 'invalid_target', undeliverable: 'now' })
  assert.deepEqual(classifyDeliveryError(wrap('gone', { code: 'unknown-target' })), { reason: 'unknown_target', undeliverable: 'now' })
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { code: 'bot-not-connected' }), 'weixin'), { reason: 'bot_offline', undeliverable: false })
  assert.equal(classifyDeliveryError(Object.assign(new Error('timeout'), { code: 'timeout' }), 'slack'), null)
  assert.equal(classifyDeliveryError(undefined), null)
})

test('classifyDeliveryError: LINE monthly push quota / HTTP 429 is retry-later with a reason, never undeliverable', () => {
  const quota = Object.assign(new Error('line POST /v2/bot/message/push failed (HTTP 429)'), { status: 429, body: { message: 'You have reached your monthly limit.' } })
  assert.deepEqual(classifyDeliveryError(wrap('delivery failed', { cause: quota }), 'line'), { reason: 'line_quota', undeliverable: false, retryLater: true })
  assert.deepEqual(classifyDeliveryError(quota, 'line'), { reason: 'line_quota', undeliverable: false, retryLater: true })
  const rate = Object.assign(new Error('line POST /v2/bot/message/push failed'), { status: 429, body: { message: 'The API rate limit has been exceeded. Try again later.' } })
  assert.deepEqual(classifyDeliveryError(rate, 'line'), { reason: 'line_rate_limited', undeliverable: false, retryLater: true })
  // other platforms: rate limit with Retry-After (seconds) / an explicit retryAfterMs
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('slack 429'), { status: 429, retryAfter: 30 }), 'slack'),
    { reason: 'rate_limited', undeliverable: false, retryLater: true, retryAfterMs: 30_000 })
  assert.deepEqual(classifyDeliveryError(wrap('too many', { code: 'rate-limited', retryAfterMs: 1500 }), 'discord'),
    { reason: 'rate_limited', undeliverable: false, retryLater: true, retryAfterMs: 1500 })
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { httpStatus: 429, body: { message: 'daily quota exceeded' } }), 'qq'),
    { reason: 'quota_exceeded', undeliverable: false, retryLater: true })
  // the existing classifications win (a 429 from WeChat stays a WeChat rejection; a bad target stays final)
  assert.deepEqual(classifyDeliveryError(wrap('Weixin text delivery failed (endpoint=sendmessage contextToken=yes provider=-2)', { status: 429 })),
    { reason: 'weixin_rejected', undeliverable: 'after-retries' })
  assert.deepEqual(classifyDeliveryError(Object.assign(new Error('x'), { code: 'invalid-target', status: 429 }), 'line'), { reason: 'invalid_target', undeliverable: 'now' })
  // other HTTP failures stay unknown (plain retry)
  assert.equal(classifyDeliveryError(Object.assign(new Error('server'), { status: 500 }), 'line'), null)
  assert.equal(classifyDeliveryError(Object.assign(new Error('forbidden'), { status: 403, code: 'line-403' }), 'line'), null)
})

test('default platform priority: every supported dsh-im platform (Feishu / Lark included) except email (notify-only)', async () => {
  const { DEFAULT_PLATFORM_PRIORITY, NOTIFY_ONLY_PLATFORMS, MAX_REQUEST_PLATFORMS } = await import('../src/index.js')
  assert.deepEqual(DEFAULT_PLATFORM_PRIORITY.slice(0, 5), ['slack', 'line', 'teams', 'weixin', 'telegram'])
  for (const p of ['wecom-app', 'wecom', 'dingtalk', 'feishu', 'qq', 'discord', 'matrix', 'whatsapp', 'imessage']) assert.ok(DEFAULT_PLATFORM_PRIORITY.includes(p), p)
  assert.equal(DEFAULT_PLATFORM_PRIORITY.indexOf('feishu'), DEFAULT_PLATFORM_PRIORITY.indexOf('dingtalk') + 1)
  assert.ok(!DEFAULT_PLATFORM_PRIORITY.includes('email'))
  assert.equal(new Set(DEFAULT_PLATFORM_PRIORITY).size, DEFAULT_PLATFORM_PRIORITY.length)
  assert.deepEqual([...NOTIFY_ONLY_PLATFORMS], ['email'])
  assert.equal(MAX_REQUEST_PLATFORMS, 10)
})
