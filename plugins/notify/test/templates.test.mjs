// 文面の拡張点：アプリケーションの文面モジュール（templateModules / ctx.bridgeNotify.registerTemplates）が manifest より先、
// 定時報告の枠（frameReport）、カードの形（noticeCard：署名は footer、textFallback を重ねない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { noticeCard, registryService } from '@dsh-bridge/dsh-core'
import { apply, withoutAutoTaskHeader } from '../src/index.js'
import { frameReport, normalizeTemplateModule, renderNotification } from '../src/templates.js'
import { format } from '../src/index.js'
import { cardText, makeCtx, mockStorageDomain, waitFor } from './helpers.mjs'
import { JST, SIGN, WEB, equipmentRegistry, ev, fakeApi, imMock, recipient } from './env.mjs'

const NOON = JST(14)
const manifestOf = async () => {
  const api = await fakeApi({})
  const registry = await equipmentRegistry(api)
  await api.close()
  return registry.get('equipment-inspection').manifest()
}

test('a template module comes before the manifest; render() can take over a type, templates[] gets the AI secretary frame', async () => {
  const manifest = await manifestOf()
  const custom = normalizeTemplateModule({
    templates: {
      'inspection.completed': ({ count, items }) => ({
        title: '点検の完了（月次）',
        text: `点検が ${count} 件完了しました（うち NG ${items.filter((p) => p.ng === 1).length} 件）。`,
        intent: ({ items: all }) => (all.some((p) => p.ng === 1) ? 'action' : 'info'),
        ask: 'NG の設備について修理依頼を起票してください。',
      }),
    },
  })
  const reportModule = normalizeTemplateModule({
    render: ({ template, params, url, now, signature }) => (template === 'inspection_report.ready'
      ? frameReport('10/27 08:30', ['■ 対応が必要なこと', `・期限超過 ${format.int(params.overdue) ?? 0} 件：点検をお願いします`], { url, now, signature })
      : null),
  })
  const base = { modules: [custom, reportModule], manifest, appName: '設備点検', webUrl: WEB, now: NOON }
  const done = renderNotification({ ...base, template: 'inspection.completed', type: 'inspection.completed', count: 2, params: { ng: 1 }, items: [{ ng: 0 }, { ng: 1 }], link: '/inspections' })
  assert.equal(done.body, [
    '【対応のお願い】点検の完了（月次）',
    'お疲れさまです。2 件まとめてお知らせします。',
    '点検が 2 件完了しました（うち NG 1 件）。',
    '▶ お願いしたいこと：NG の設備について修理依頼を起票してください。',
    `こちらから開けます：${WEB}/inspections`,
    SIGN,
  ].join('\n'))
  const report = renderNotification({ ...base, template: 'inspection_report.ready', type: 'inspection_report.ready', count: 1, params: { overdue: 2, name: '氏名' }, link: '/' })
  assert.equal(report.title, '【定時のご報告】10/27 08:30')
  assert.equal(report.text, ['お疲れさまです。現在の業務状況をご報告します。', '■ 対応が必要なこと', '・期限超過 2 件：点検をお願いします', SIGN].join('\n'))
  assert.ok(report.body.endsWith(`\nこちらから開けます：${WEB}/\n${SIGN}`))
  // no module matches: the manifest template
  const overdue = renderNotification({ ...base, template: 'inspection.overdue', type: 'inspection.overdue', count: 1, params: { count: 1, daysOverdue: 2, dueOn: '2026-10-25' } })
  assert.equal(overdue.title, '【対応のお願い】点検期限の超過')
  assert.throws(() => normalizeTemplateModule({}), /render\(input\) or templates/)
})

test('intents approval / consult (manifest or module): 【承認のお願い】 / 【ご相談】 with 「▶ お願いしたいこと」', async () => {
  const manifest = await manifestOf()
  const withIntents = {
    ...manifest,
    templates: {
      ...manifest.templates,
      'repair.requested': { ...manifest.templates['repair.requested'], intent: 'approval' },
      'inspection.overdue': { ...manifest.templates['inspection.overdue'], intent: 'consult' },
    },
  }
  const base = { manifest: withIntents, appName: '設備点検', webUrl: WEB, now: NOON }
  const approval = renderNotification({ ...base, template: 'repair.requested', type: 'repair.requested', count: 1, params: { count: 1 }, link: '/repair-requests' })
  assert.equal(approval.title, '【承認のお願い】修理依頼の起票')
  assert.equal(approval.intent, 'approval')
  assert.ok(approval.text.includes('▶ お願いしたいこと：業務 Web の「修理依頼」で内容を確認し、承認の判断をお願いします。'))
  const consult = renderNotification({ ...base, template: 'inspection.overdue', type: 'inspection.overdue', count: 1, params: { count: 1, daysOverdue: 2, dueOn: '2026-10-25' } })
  assert.equal(consult.title, '【ご相談】点検期限の超過')
  assert.equal(consult.intent, 'consult')
  const module = normalizeTemplateModule({ templates: { 'inspection.overdue': () => ({ title: '期限を過ぎた点検', text: '2 件が片付いていません。', intent: 'consult', ask: '担当と相談してください。' }) } })
  const fromModule = renderNotification({ ...base, modules: [module], template: 'inspection.overdue', type: 'inspection.overdue', count: 1, params: {} })
  assert.equal(fromModule.body, ['【ご相談】期限を過ぎた点検', 'お疲れさまです。2 件が片付いていません。', '▶ お願いしたいこと：担当と相談してください。', SIGN].join('\n'))
})

test('notice card: body without the signature, the signature in the footer, no duplicated textFallback', async () => {
  const manifest = await manifestOf()
  const m = renderNotification({ manifest, template: 'repair.requested', type: 'repair.requested', count: 1, params: { count: 2 }, link: '/repair-requests', webUrl: WEB, appName: '設備点検', now: NOON })
  const card = noticeCard(m)
  assert.equal(card.title, '【対応のお願い】修理依頼の起票')
  assert.equal(card.body, ['お疲れさまです。修理依頼が 2 件届いています。', '▶ お願いしたいこと：業務 Web の「修理依頼」で内容を確認し、承認の判断をお願いします。'].join('\n'))
  assert.equal(card.footer, SIGN)
  assert.deepEqual(card.link, { label: '業務 Web を開いて対応', url: `${WEB}/repair-requests` })
  assert.equal(card.textFallback, undefined, 'dsh-im appends textFallback after the body on text channels: it would repeat the message')
  const shown = cardText(card)
  assert.equal(shown.split('修理依頼が 2 件').length, 2)
  assert.equal(shown.split(SIGN).length, 2)
  assert.equal(noticeCard(renderNotification({ manifest, template: 'inspection.completed', type: 'inspection.completed', count: 1, link: '/x', webUrl: WEB, appName: '設備点検', now: NOON })).link.label, '業務 Web で確認')
  assert.equal(withoutAutoTaskHeader('🙋 **【設備点検】点検期限超過のフォロー**\n\n期限超過 2 件。'), '期限超過 2 件。')
  assert.equal(withoutAutoTaskHeader('🙋 期限超過 2 件。'), '期限超過 2 件。')
})

test('apply(): templateModules are loaded from a path; their types are notified and subscribed; registerTemplates adds one at run time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-notify-templates-'))
  const file = join(dir, 'templates.mjs')
  writeFileSync(file, [
    'export const types = [\'repair.completed\']',
    'export const templates = {',
    '  \'repair.completed\': ({ count }) => ({ title: \'修理の完了\', text: `修理が ${count} 件完了しました。` }),',
    '}',
    '',
  ].join('\n'), 'utf8')
  const api = await fakeApi({
    1: { type: 'repair.completed', recipients: [recipient('u1', { template: 'repair.completed', quietHours: null })] },
    2: { type: 'part.arrived', recipients: [recipient('u1', { template: 'part.arrived', params: { count: 3 }, quietHours: null })] },
  })
  const registry = await equipmentRegistry(api)
  const im = imMock()
  const subscribed = []
  const bridgeEvents = { subscribe: (types, handler) => { subscribed.push({ types, handler }); return () => {} }, subscribeManifestNotify: () => () => {} }
  const ctx = makeCtx({ dshIm: im.dshIm, storageDomain: mockStorageDomain(), bridgeApps: registryService(registry), bridgeEvents })
  try {
    const service = apply(ctx, { templateModules: [{ module: pathToFileURL(file).href, application: 'equipment-inspection' }] })
    await service.ready
    await waitFor(() => subscribed.some((s) => s.types.includes('repair.completed')))
    assert.equal((await service.status()).templateModules, 1)
    await service.handleEvent(ev(1, 'repair.completed', { applicationId: 'equipment-inspection' }))
    await waitFor(() => im.delivered.length === 1)
    assert.match(im.delivered[0].text, /^【ご報告】修理の完了\n.*修理が 1 件完了しました。/)
    // a type nobody declares is ignored until a module (registered by another plugin) declares it
    assert.deepEqual(await service.handleEvent(ev(2, 'part.arrived', { applicationId: 'equipment-inspection' })), { queued: 0 })
    await service.registerTemplates(null, { types: ['part.arrived'], templates: { 'part.arrived': ({ params }) => ({ title: '部品の入荷', text: `部品が ${format.int(params.count) ?? 1} 個届きました。`, intent: 'action', ask: '交換の日程を決めてください。' }) } })
    assert.ok(subscribed.some((s) => s.types.includes('part.arrived')))
    await service.handleEvent(ev(2, 'part.arrived', { applicationId: 'equipment-inspection' }))
    await waitFor(() => im.delivered.length === 2)
    assert.match(im.delivered[1].text, /^【対応のお願い】部品の入荷\n.*部品が 3 個届きました。\n▶ お願いしたいこと：交換の日程を決めてください。/)
  } finally {
    await ctx.dispose()
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
