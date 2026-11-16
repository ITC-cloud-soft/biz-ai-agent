import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { parseDocument, parseYaml, YamlError } from '../src/yaml.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('yaml subset parser', () => {
  test('block mappings, sequences, compact maps, flow collections, comments', () => {
    const doc = parseYaml(`
---
bridge: 1   # comment
system: { id: example-app, name: 日報 }
list:
  - a
  - name: x
    roles: [admin, manager,
            staff]
  - - nested
    - more
  -
    k: v
seq_same_indent:
- p
- q
"quoted key": 'it''s'
empty:
`)
    assert.deepEqual(doc, {
      bridge: 1,
      system: { id: 'example-app', name: '日報' },
      list: ['a', { name: 'x', roles: ['admin', 'manager', 'staff'] }, ['nested', 'more'], { k: 'v' }],
      seq_same_indent: ['p', 'q'],
      'quoted key': "it's",
      empty: null,
    })
  })

  test('scalars: only null / bool / numbers are typed, dates and times stay strings', () => {
    assert.deepEqual(parseYaml('a: ~\nb: true\nc: 12\nd: -1.5\ne: 2026-10-26\nf: 08:30\ng: "12"\nh: yes\ni: 1e3'), {
      a: null, b: true, c: 12, d: -1.5, e: '2026-10-26', f: '08:30', g: '12', h: 'yes', i: 1000,
    })
  })

  test('block scalars | > with chomping and blank lines', () => {
    const doc = parseYaml(`
keep: |
  line one
    indented # not a comment

  line three
strip: |-
  no newline
folded: >-
  a
  b

  c
clip: |
  x
next: 1
`)
    assert.equal(doc.keep, 'line one\n  indented # not a comment\n\nline three\n')
    assert.equal(doc.strip, 'no newline')
    assert.equal(doc.folded, 'a b\nc')
    assert.equal(doc.clip, 'x\n')
    assert.equal(doc.next, 1)
  })

  test('errors are loud: tabs, duplicate keys, anchors, unterminated quotes, bad indentation', () => {
    assert.throws(() => parseYaml('a:\n\tb: 1'), YamlError)
    assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/)
    assert.throws(() => parseYaml('a: &x 1'), /anchors/)
    assert.throws(() => parseYaml('a: "open'), /unterminated/)
    assert.throws(() => parseYaml('a:\n  b: 1\n c: 2'), /indentation|unexpected/)
    assert.throws(() => parseYaml('a: [1, 2'), /unterminated/)
  })

  test('parseDocument: JSON by name or first character, YAML otherwise', () => {
    assert.deepEqual(parseDocument('{"a": [1, 2]}', 'x.json'), { a: [1, 2] })
    assert.deepEqual(parseDocument('{"a": 1}', 'x.yaml'), { a: 1 })
    assert.deepEqual(parseDocument('a: 1', 'x.yaml'), { a: 1 })
  })

  // Safety net: when the reference `yaml` package is around (vendor/dsh-proactive), every YAML file of this package
  // must parse to the same value. Skipped when it is not installed.
  const ref = join(root, '..', '..', 'vendor', 'dsh-proactive', 'node_modules', 'yaml', 'dist', 'index.js')
  test('matches the reference parser on every bundled YAML file', { skip: !existsSync(ref) && 'reference yaml package not installed' }, async () => {
    const { default: YAML } = await import(pathToFileURL(ref).href)
    const files = [join(root, 'openapi', 'bridge-v1.yaml'), ...readdirSync(join(root, 'manifests')).map((f) => join(root, 'manifests', f))]
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      assert.deepEqual(parseYaml(text), YAML.parse(text, { schema: 'core' }), file)
    }
  })
})
