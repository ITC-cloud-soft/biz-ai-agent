// 署名の呼び名（AI 社員のプロフィール）：通知の文面・定時報告の固定の文面・既定の指示。呼び名が無ければ従来の「— <アプリ名> AI 秘書」。データは架空。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderManifestMessage, renderNotification } from '../src/index.js'
import { defaultReportPrompt, reportTemplate } from '../src/ai-report.js'

const manifest = {
  system: { name: '設備点検' },
  events: { 'inspection.overdue': { label: '点検の期限切れ' } },
  templates: { 'inspection.overdue': { description: '期限を過ぎた点検が {count} 件あります。', intent: 'action', action: '点検の予定を確認してください。' } },
}
const base = { manifest, template: 'inspection.overdue', type: 'inspection.overdue', count: 1, params: { count: 2 }, appName: '設備点検', now: Date.parse('2026-10-29T01:00:00Z') }

test('renderNotification / renderManifestMessage: nickname in the signature (optional, backward compatible)', () => {
  assert.match(renderNotification(base).body, /— 設備点検 AI 秘書$/)
  assert.match(renderNotification({ ...base, nickname: 'さくら' }).body, /— さくら（設備点検 AI 秘書）$/)
  assert.equal(renderNotification({ ...base, nickname: 'さくら' }).signature, '— さくら（設備点検 AI 秘書）')
  assert.match(renderManifestMessage(manifest, { ...base, nickname: 'さくら' }).body, /— さくら（設備点検 AI 秘書）$/)
  assert.match(renderManifestMessage(manifest, { ...base, template: 'unknown', type: 'unknown', nickname: 'さくら' }).body, /— さくら（設備点検 AI 秘書）$/)
})

test('a template module receives the signature and the nickname', () => {
  let input = null
  const mod = { render: (i) => { input = i; return { body: `x\n${i.signature}` } }, templates: null, types: [] }
  assert.equal(renderNotification({ ...base, modules: [mod], nickname: 'さくら' }).body, 'x\n— さくら（設備点検 AI 秘書）')
  assert.deepEqual([input.nickname, input.signature], ['さくら', '— さくら（設備点検 AI 秘書）'])
  renderNotification({ ...base, modules: [mod] })
  assert.deepEqual([input.nickname, input.signature], ['', '— 設備点検 AI 秘書'])
})

test('AI report: the fixed text and the default instruction sign with the nickname', () => {
  assert.match(reportTemplate({ appName: '設備点検', nickname: 'さくら' }), /— さくら（設備点検 AI 秘書）$/)
  assert.match(reportTemplate({ appName: '設備点検' }), /— 設備点検 AI 秘書$/)
  const app = { name: '設備点検', namespace: 'facility', aiProfile: () => ({ nickname: 'さくら' }) }
  assert.match(defaultReportPrompt(app), /最後の行は「— さくら（設備点検 AI 秘書）」/)
  assert.match(defaultReportPrompt({ name: '設備点検', namespace: 'facility' }), /最後の行は「— 設備点検 AI 秘書」/)
})
