import test from 'node:test'
import assert from 'node:assert/strict'
import { t } from '../lib/i18n.js'

test('i18n: zh interpolation', () => {
  assert.equal(t('zh', 'digest.title', { n: 3 }), '📬 今日重要邮件汇总（3 封）')
  assert.equal(t(undefined, 'digest.empty'), '今天没有重要业务邮件。')
})

test('i18n: en fallback and unknown key', () => {
  assert.equal(t('en', 'digest.pending', { n: 2 }), 'Awaiting your decision: 2 (drafts in Auto Tasks → Feedback)')
  assert.equal(t('zh', 'missing.key'), 'missing.key')
})
