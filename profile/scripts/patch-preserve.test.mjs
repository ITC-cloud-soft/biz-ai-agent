import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DELEGATION_TARGET, carryUserManaged, describeDelegation, parseDelegation, readDelegation, splitTopLevel, withDelegation } from './patch-preserve.mjs'

const SOURCE = [
  '# product patch',
  '- id: locale',
  "  name: '@deepseek-ai/dsh-client-locale'",
  '  config:',
  '    preference: ja',
  '',
  '- insert:',
  '    - id: preset-business-assistant',
  '      config:',
  '        id: business-assistant',
  '',
].join('\r\n')

// config-editor（yaml ライブラリ）が書き直した後の形：LF、トップレベルに id / name / config
const INSTALLED = [
  '# product patch',
  '- id: locale',
  "  name: '@deepseek-ai/dsh-client-locale'",
  '  config:',
  '    preference: en',
  '- insert:',
  '    - id: preset-business-assistant',
  '      config:',
  '        id: business-assistant',
  '        name: edited in the settings UI',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      azure:',
  '        apiKeyEnv: AZURE_OPENAI_API_KEY',
  '        baseURL: https://example.openai.azure.com/openai/v1',
  '        models:',
  '          - id: gpt-4.1',
  '- name: "@deepseek-ai/dsh-agent-default-model"',
  '  id: agent-default-model',
  '  config:',
  '    provider: azure',
  '    model: gpt-4.1',
  '',
].join('\n')

test('splitTopLevel finds ids on the first or a child line and marks insert blocks', () => {
  const { items } = splitTopLevel(INSTALLED)
  assert.deepEqual(items.map((i) => [i.id, i.insert]), [
    ['locale', false], [undefined, true], ['llm-pi-ai', false], ['agent-default-model', false],
  ])
})

test('carries only the model entries; product entries and insert blocks come from the source', () => {
  const { text, carried } = carryUserManaged(INSTALLED, SOURCE)
  assert.deepEqual(carried, ['llm-pi-ai', 'agent-default-model'])
  assert.match(text, /preference: ja/)
  assert.doesNotMatch(text, /preference: en/)
  assert.doesNotMatch(text, /edited in the settings UI/)
  assert.match(text, /apiKeyEnv: AZURE_OPENAI_API_KEY/)
  assert.match(text, /- id: gpt-4\.1/)
  assert.match(text, /model: gpt-4\.1/)
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'keeps the source line endings')
})

test('reinstalling twice does not duplicate the carried entries or the header', () => {
  const once = carryUserManaged(INSTALLED, SOURCE).text
  const twice = carryUserManaged(once, SOURCE).text
  assert.equal(twice, once)
  assert.equal(twice.match(/^- id: llm-pi-ai/gm).length, 1)
})

test('no installed patch or nothing to carry returns the source unchanged', () => {
  assert.equal(carryUserManaged(null, SOURCE).text, SOURCE)
  assert.equal(carryUserManaged(SOURCE, SOURCE).text, SOURCE)
})

test('a model entry in the source is replaced by the saved one', () => {
  const source = SOURCE + '- id: agent-default-model\r\n  config:\r\n    model: deepseek-flash\r\n'
  const { text } = carryUserManaged(INSTALLED, source)
  assert.doesNotMatch(text, /deepseek-flash/)
  assert.equal(text.match(/id: agent-default-model/g).length, 1)
})

// ── 自動タスクの委託（--auto-task-delegate） ──────────────────────────────────────────────

test('parseDelegation: platform:userId[:teamId], off / deny = none, anything else is refused', () => {
  assert.deepEqual(parseDelegation('feishu:ou_abc123'), { platform: 'feishu', userId: 'ou_abc123' })
  assert.deepEqual(parseDelegation('slack:U1:T1'), { platform: 'slack', userId: 'U1', teamId: 'T1' })
  assert.equal(parseDelegation('off'), null)
  assert.equal(parseDelegation('deny'), null)
  for (const bad of ['', 'feishu', 'feishu:', 'Feishu:x', 'feishu:a b', 'feishu:a"b', 'feishu:a:b:c', 'feishu:x#y']) {
    assert.throws(() => parseDelegation(bad), /--auto-task-delegate/, bad)
  }
})

test('parseDelegation: per delegation class (<class>=<platform>:<userId> / <class>=each, default=…); describeDelegation for logs', () => {
  assert.deepEqual(parseDelegation('care=line:U1,billing=slack:U2:T2,care_manager=each'), {
    classes: { care: { platform: 'line', userId: 'U1' }, billing: { platform: 'slack', userId: 'U2', teamId: 'T2' }, care_manager: 'each' },
  })
  assert.deepEqual(parseDelegation('default=feishu:ou_a, care_manager=each'), { platform: 'feishu', userId: 'ou_a', classes: { care_manager: 'each' } })
  assert.deepEqual(parseDelegation('default=feishu:ou_a'), { platform: 'feishu', userId: 'ou_a' })
  for (const bad of ['care=', '=line:U1', 'Care=line:U1', 'care=line', 'care=line:U1,care=line:U2', 'default=each', 'care=all', 'care=line:a b', 'default=x:1,default=x:2', ',']) {
    assert.throws(() => parseDelegation(bad), /--auto-task-delegate must be/, bad)
  }
  assert.equal(describeDelegation(parseDelegation('care=line:U1234567,care_manager=each')), 'care=line:U12345…, care_manager=each')
  assert.equal(describeDelegation(parseDelegation('feishu:ou_abcdefgh')), 'feishu:ou_abc…')
  assert.equal(describeDelegation(null), 'none')
})

test('withDelegation / readDelegation: per-class delegates (unattendedDelegates) round-trip, replace the single delegate and are removed by off', () => {
  const d = parseDelegation('default=feishu:ou_a,care=line:U1,billing=slack:U2:T2,care_manager=each')
  const set = withDelegation(SOURCE, d)
  assert.match(set, /    unattendedPolicy: delegate\r\n    unattendedOnBehalfOf:\r\n      platform: "feishu"\r\n      userId: "ou_a"\r\n    unattendedDelegates:\r\n      care:\r\n        platform: "line"\r\n        userId: "U1"\r\n      billing:\r\n        platform: "slack"\r\n        userId: "U2"\r\n        teamId: "T2"\r\n      care_manager: each\r\n$/)
  assert.deepEqual(readDelegation(set), d)
  const only = parseDelegation('care_manager=each')
  const replaced = withDelegation(withDelegation(SOURCE, { platform: 'feishu', userId: 'ou_x' }), only)
  assert.deepEqual(readDelegation(replaced), only, 'the class-only form replaces the single delegate (no unattendedOnBehalfOf left)')
  assert.ok(!replaced.includes('unattendedOnBehalfOf'))
  assert.equal(withDelegation(set, null), SOURCE)
  // the flow form a settings screen might write, comments and quotes
  const flow = '- id: bridge-tools\n  config:\n    unattendedPolicy: delegate\n    unattendedDelegates:\n      # per class\n      care: { platform: line, userId: "U1" }\n      care_manager: "each"\n      Bad: each\n      broken: { platform: line }\n'
  assert.deepEqual(readDelegation(flow), { classes: { care: { platform: 'line', userId: 'U1' }, care_manager: 'each' } })
  assert.equal(readDelegation(flow.replace('delegate', 'deny')), null)
  // reinstall keeps it as it is
  assert.equal(withDelegation(set, readDelegation(set)), set)
})

test('withDelegation / readDelegation: one bridge-tools entry at the end, keeps line endings, replaces and removes', () => {
  assert.deepEqual(DEFAULT_DELEGATION_TARGET, { id: 'bridge-tools', name: '@dsh-bridge/plugin-tools' })
  const set = withDelegation(SOURCE, { platform: 'feishu', userId: 'ou_abc123' })
  assert.ok(set.includes('\r\n') && !/[^\r]\n/.test(set), 'keeps the source line endings')
  assert.match(set, /- id: bridge-tools\r\n  name: '@dsh-bridge\/plugin-tools'\r\n  config:\r\n    unattendedPolicy: delegate\r\n    unattendedOnBehalfOf:\r\n      platform: "feishu"\r\n      userId: "ou_abc123"\r\n$/)
  assert.deepEqual(readDelegation(set), { platform: 'feishu', userId: 'ou_abc123' })
  const replaced = withDelegation(set, { platform: 'slack', userId: 'U9', teamId: 'T9' })
  assert.equal(replaced.match(/- id: bridge-tools/g).length, 1)
  assert.equal(replaced.match(/自動タスクの委託/g).length, 1, 'one header')
  assert.deepEqual(readDelegation(replaced), { platform: 'slack', userId: 'U9', teamId: 'T9' })
  assert.equal(withDelegation(replaced, null), SOURCE, 'off restores the source')
  assert.equal(withDelegation(SOURCE, null), SOURCE, 'nothing to remove: unchanged')
  assert.equal(readDelegation(SOURCE), null)
  // 設定画面（config-editor）が書き直した形（LF・クォート無し・キー順の違い）も読める
  const rewritten = '- name: "@dsh-bridge/plugin-tools"\n  id: bridge-tools\n  config:\n    unattendedOnBehalfOf:\n      userId: ou_x\n      platform: feishu\n    unattendedPolicy: delegate\n'
  assert.deepEqual(readDelegation(rewritten), { platform: 'feishu', userId: 'ou_x' })
  assert.equal(readDelegation(rewritten.replace('delegate', 'deny')), null)
  // 再インストール：モデル設定の引き継ぎと委託の引き継ぎが重ならない
  const installed = withDelegation(carryUserManaged(INSTALLED, SOURCE).text, { platform: 'feishu', userId: 'ou_abc123' })
  const again = withDelegation(carryUserManaged(installed, SOURCE).text, readDelegation(installed))
  assert.equal(again, installed)
  assert.equal(again.match(/- id: llm-pi-ai/gm).length, 1)
})

test('a custom delegation target (another tools plugin id / name) is written, read and removed by that id only', () => {
  const target = { id: 'care-tools', name: '@care/dsh-care-tools' }
  const set = withDelegation(SOURCE, { platform: 'line', userId: 'Utest' }, target)
  assert.match(set, /- id: care-tools\r\n  name: '@care\/dsh-care-tools'/)
  assert.deepEqual(readDelegation(set, target), { platform: 'line', userId: 'Utest' })
  assert.equal(readDelegation(set), null)
  assert.equal(withDelegation(set, null, target), SOURCE)
})

test('a product bridge-tools entry (toolModules) keeps its settings: the delegation goes into its config, one entry, idempotent, off restores it', () => {
  const product = [
    '# product patch',
    '- id: bridge-tools',
    "  name: '@dsh-bridge/plugin-tools'",
    '  config:',
    '    toolModules:',
    "      - { module: '@dsh-bridge/plugin-tools/examples/equipment-inspection', application: equipment-inspection }",
    '',
    '- id: bridge-notify',
    '  config:',
    '    digestMinutes: 30',
    '',
  ].join('\n')
  const set = withDelegation(product, { platform: 'line', userId: 'Uabc' })
  assert.equal(set.match(/^- id: bridge-tools/gm).length, 1, 'no second bridge-tools entry')
  assert.match(set, /  config:\n    unattendedPolicy: delegate\n    unattendedOnBehalfOf:\n      platform: "line"\n      userId: "Uabc"\n    toolModules:\n      - \{ module: '@dsh-bridge\/plugin-tools\/examples\/equipment-inspection'/)
  assert.match(set, /- id: bridge-notify\n  config:\n    digestMinutes: 30\n$/)
  assert.deepEqual(readDelegation(set), { platform: 'line', userId: 'Uabc' })
  assert.equal(withDelegation(set, { platform: 'line', userId: 'Uabc' }), set, 'idempotent')
  const replaced = withDelegation(set, { platform: 'slack', userId: 'U9', teamId: 'T9' })
  assert.equal(replaced.match(/unattendedPolicy/g).length, 1)
  assert.deepEqual(readDelegation(replaced), { platform: 'slack', userId: 'U9', teamId: 'T9' })
  assert.equal(withDelegation(replaced, null), product, 'off restores the product entry')
  // a delegation-only entry written by an older install (separate block) is folded into the product entry
  const legacy = withDelegation(SOURCE, { platform: 'line', userId: 'Uold' }) + product.replace('# product patch\n', '')
  const folded = withDelegation(legacy, { platform: 'line', userId: 'Unew' })
  assert.equal(folded.match(/^- id: bridge-tools/gm).length, 1)
  assert.match(folded, /toolModules:/)
  assert.deepEqual(readDelegation(folded), { platform: 'line', userId: 'Unew' })
  // flow-style unattendedOnBehalfOf (written by hand) is read too
  assert.deepEqual(readDelegation('- id: bridge-tools\n  config:\n    unattendedPolicy: delegate\n    unattendedOnBehalfOf: { platform: line, userId: Uflow }\n'), { platform: 'line', userId: 'Uflow' })
  // a product entry without a config block gets one
  const bare = "- id: bridge-tools\n  name: '@dsh-bridge/plugin-tools'\n"
  const withConfig = withDelegation(bare, { platform: 'line', userId: 'Ub' })
  assert.equal(withConfig, "- id: bridge-tools\n  name: '@dsh-bridge/plugin-tools'\n  config:\n    unattendedPolicy: delegate\n    unattendedOnBehalfOf:\n      platform: \"line\"\n      userId: \"Ub\"\n")
})

test('delegation target aliases: a delegation written under an earlier id is read, removed and rewritten into the product entry', () => {
  const target = { ...DEFAULT_DELEGATION_TARGET, aliases: ['old-tools'] }
  const old = withDelegation(SOURCE, { platform: 'line', userId: 'Uold', teamId: 'T1' }, { id: 'old-tools', name: '@example/old-tools' })
  assert.match(old, /- id: old-tools/)
  assert.deepEqual(readDelegation(old, target), { platform: 'line', userId: 'Uold', teamId: 'T1' }, 'read under the alias')
  assert.equal(readDelegation(old), null, 'not without the alias')
  const product = "- id: bridge-tools\n  name: '@dsh-bridge/plugin-tools'\n  config:\n    toolModules: []\n"
  const moved = withDelegation(product, readDelegation(old, target), target)
  assert.doesNotMatch(moved, /old-tools/)
  assert.match(moved, /- id: bridge-tools\n  name: '@dsh-bridge\/plugin-tools'\n  config:\n    unattendedPolicy: delegate\n    unattendedOnBehalfOf:\n      platform: "line"\n      userId: "Uold"\n      teamId: "T1"\n    toolModules: \[\]\n/)
  // an alias entry left in the same text is dropped when writing (no second delegation)
  const both = withDelegation(`${product}\n${old.split('\r\n').join('\n')}`, { platform: 'line', userId: 'Unew' }, target)
  assert.doesNotMatch(both, /old-tools/)
  assert.deepEqual(readDelegation(both, target), { platform: 'line', userId: 'Unew' })
  assert.equal(withDelegation(both, null, target).includes('unattendedPolicy'), false)
})
