// The example's manual as the help source (@dsh-bridge/help, src/help.mjs): the CI checks a business system runs, and the answers. No DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAnchors, checkCoverage, checkLinks, checkRoleText, checkSectionPaths, parseManual, readManualDir } from '@dsh-bridge/help'
import { createHelp, helpIndex, MANUAL_DIR, ROLE_LABELS, SCREENS } from '../src/help.mjs'

test('CI: the manual is in step with the screens (paths, coverage, roles, anchors, links)', () => {
  const { files } = readManualDir(MANUAL_DIR)
  const chapters = parseManual(files)
  assert.deepEqual([
    ...checkAnchors(chapters), ...checkSectionPaths(chapters, SCREENS), ...checkCoverage(chapters, SCREENS),
    ...checkRoleText(chapters, SCREENS, { labels: ROLE_LABELS }), ...checkLinks(files, chapters),
  ], [])
  assert.equal(helpIndex().sections.length, 5)
})

test('answers: the section for the question, the page URL, the public sections for a sender that is not linked', () => {
  const help = createHelp({ webBase: 'http://127.0.0.1:19730' })
  const r = help.search('修理依頼を承認したい', { role: 'manager' })
  assert.equal(r.results[0].id, 'manual-inspections-repair-approval')
  assert.equal(r.results[0].url, 'http://127.0.0.1:19730/')
  assert.equal(r.results[0].manualUrl, null)
  const anon = help.search('SNS の連携のしかた', { role: null })
  assert.equal(anon.results[0].id, 'manual-basics-sns-link')
  assert.equal(help.search('修理依頼を承認したい', { role: null }).found, false)
})
