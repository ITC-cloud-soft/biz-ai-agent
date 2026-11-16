/**
 * @care fork：客户端 i18n 走 DSH locale（namespace `dsh-auto-tasks`，只注册 zh / en；
 * ja 由 @care/dsh-lang-ja 注册）。用与 ModuleLoader 相同的形状在 node:vm 里执行 lib/client.js。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const zh = JSON.parse(readFileSync(new URL('../src/locales/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'))

function loadClient() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const React = {
    createElement: (...args) => ({ args }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_s, get) => get(),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    document: undefined,
    navigator: { language: 'ja-JP' },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ json: async () => ({}) }),
  }
  vm.runInNewContext(code, sandbox)
  const mod = loaded.factory((name) => (name === 'react' ? React : undefined))
  return { id: loaded.id, mod }
}

function fakeCtx({ withLocale = true, active = 'ja' } = {}) {
  const registered = []
  const slots = []
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    slots: {
      inject: (_name, cb) => cb(),
      register: (meta, view) => { slots.push({ meta, view }); return () => {} },
    },
  }
  if (withLocale) {
    ctx.locale = {
      register: (...args) => { registered.push(args); return () => {} },
      bind: (ns) => (key, params) => `${ns}:${active}:${key}${params ? JSON.stringify(params) : ''}`,
      getSnapshot: () => ({ active, revision: 1 }),
      subscribe: () => () => {},
    }
  }
  return { ctx, registered, slots }
}

test('i18n: zh / en dictionaries share one key set and cover the dsh-lang-ja fork resources', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const v of [...Object.values(zh), ...Object.values(en)]) assert.equal(typeof v, 'string')
  let upstream = null
  try {
    upstream = JSON.parse(readFileSync(new URL('../../../plugins/dsh-lang-ja/fork-resources/dsh-auto-tasks/en.json', import.meta.url), 'utf8'))
  } catch { /* vendor copied elsewhere: skip the cross-check */ }
  if (upstream) for (const key of Object.keys(upstream)) assert.ok(key in en, `missing key ${key}`)
})

test('i18n: client registers only zh/en under dsh-auto-tasks and translates through locale.bind', () => {
  const { id, mod } = loadClient()
  assert.equal(id, '@care/dsh-auto-tasks')
  assert.deepEqual([...mod.inject], ['slots', 'locale'])
  const { ctx, registered, slots } = fakeCtx()
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  const [ns, dicts] = registered[0]
  assert.equal(ns, 'dsh-auto-tasks')
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'], 'ja must be left to @care/dsh-lang-ja')
  assert.equal(dicts.zh.tab, '自动任务')
  assert.equal(dicts.en.tab, 'Auto Tasks')
  assert.equal(slots[0].meta.name, 'conversation.view')
  assert.equal(slots[0].meta.label(), 'dsh-auto-tasks:ja:tab')
})

test('i18n: without a locale service the client falls back to its built-in dictionaries', () => {
  const { mod } = loadClient()
  const { ctx, slots } = fakeCtx({ withLocale: false })
  mod.apply(ctx)
  assert.equal(slots[0].meta.label(), '自动任务') // navigator ja-JP → zh fallback (upstream behaviour)
})
