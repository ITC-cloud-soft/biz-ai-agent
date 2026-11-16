import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_SCHEMA, normalizeConfig } from '../lib/config-schema.js'

test('config: defaults', () => {
  const { config, warnings } = normalizeConfig(undefined)
  assert.equal(config.wakeBackendDefault, 'schedule')
  assert.equal(config.api.requireClientHeader, true)
  assert.deepEqual(warnings, [])
})

test('config: proactive default + api override', () => {
  const { config } = normalizeConfig({ wakeBackendDefault: 'proactive', api: { requireClientHeader: false } })
  assert.equal(config.wakeBackendDefault, 'proactive')
  assert.equal(config.api.requireClientHeader, false)
})

test('config: unknown keys warn', () => {
  const { warnings } = normalizeConfig({ nope: 1 })
  assert.ok(warnings.some((w) => w.includes('nope')))
})

test('config: schema shape', () => {
  // @care #16: + mail / restrictDelivery
  assert.deepEqual(Object.keys(CONFIG_SCHEMA.properties).sort(), ['api', 'mail', 'restrictDelivery', 'wakeBackendDefault'])
})
