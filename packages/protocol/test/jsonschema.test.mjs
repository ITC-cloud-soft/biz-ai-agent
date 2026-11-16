import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSchema } from '../src/jsonschema.mjs'

const ok = (schema, data) => validateSchema(schema, data).valid
const keywords = (schema, data) => validateSchema(schema, data).errors.map((e) => e.keyword)

describe('json schema subset validator', () => {
  test('type, enum, const, string and number constraints', () => {
    assert.ok(ok({ type: 'string', minLength: 2, maxLength: 3, pattern: '^[a-z]+$' }, 'abc'))
    assert.deepEqual(keywords({ type: 'string', minLength: 2 }, 'a'), ['minLength'])
    assert.deepEqual(keywords({ type: 'string', pattern: '^[a-z]+$' }, 'AB'), ['pattern'])
    assert.deepEqual(keywords({ type: 'integer' }, 1.5), ['type'])
    assert.ok(ok({ type: ['string', 'null'] }, null))
    assert.deepEqual(keywords({ enum: ['a', 'b'] }, 'c'), ['enum'])
    assert.deepEqual(keywords({ const: 1 }, 2), ['const'])
    assert.deepEqual(keywords({ type: 'number', minimum: 0, maximum: 1 }, 2), ['maximum'])
    assert.deepEqual(keywords({ type: 'integer', multipleOf: 5 }, 7), ['multipleOf'])
  })

  test('objects: required, properties, additionalProperties, patternProperties, propertyNames, dependentRequired', () => {
    const schema = {
      type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer' } },
      patternProperties: { '^x_': { type: 'string' } },
    }
    assert.ok(ok(schema, { a: 1, x_y: 's' }))
    assert.deepEqual(keywords(schema, {}), ['required'])
    assert.deepEqual(keywords(schema, { a: 1, b: 2 }), ['additionalProperties'])
    assert.deepEqual(keywords(schema, { a: 1, x_y: 2 }), ['type'])
    assert.deepEqual(keywords({ propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 }), ['propertyNames'])
    assert.deepEqual(keywords({ dependentRequired: { a: ['b'] } }, { a: 1 }), ['dependentRequired'])
    assert.deepEqual(keywords({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 'x' }), ['type'])
  })

  test('arrays: items, prefixItems, minItems, maxItems, uniqueItems, contains', () => {
    assert.ok(ok({ type: 'array', items: { type: 'integer' }, uniqueItems: true }, [1, 2]))
    assert.deepEqual(keywords({ type: 'array', uniqueItems: true }, [1, 1]), ['uniqueItems'])
    assert.deepEqual(keywords({ type: 'array', minItems: 2 }, [1]), ['minItems'])
    assert.deepEqual(keywords({ type: 'array', items: { type: 'integer' } }, [1, 'a']), ['type'])
    assert.ok(ok({ prefixItems: [{ type: 'string' }, { type: 'integer' }] }, ['a', 1]))
    assert.deepEqual(keywords({ contains: { const: 3 } }, [1, 2]), ['contains'])
  })

  test('combinators and conditionals', () => {
    assert.ok(ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 1))
    assert.deepEqual(keywords({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true), ['anyOf'])
    assert.ok(ok({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'a'))
    assert.deepEqual(keywords({ oneOf: [{ type: 'integer' }, { minimum: 0 }] }, 5), ['oneOf'])
    assert.deepEqual(keywords({ allOf: [{ minimum: 1 }, { maximum: 3 }] }, 5), ['maximum'])
    assert.deepEqual(keywords({ not: { type: 'string' } }, 'a'), ['not'])
    const cond = { if: { properties: { k: { const: 'a' } }, required: ['k'] }, then: { required: ['x'] }, else: { required: ['y'] } }
    assert.ok(ok(cond, { k: 'a', x: 1 }))
    assert.deepEqual(keywords(cond, { k: 'a' }), ['required'])
    assert.ok(ok(cond, { y: 1 }))
  })

  test('$ref to $defs, formats and error paths', () => {
    const schema = { $defs: { id: { type: 'string', pattern: '^[a-z]+$' } }, type: 'object', properties: { list: { type: 'array', items: { $ref: '#/$defs/id' } }, at: { type: 'string', format: 'date-time' }, t: { type: 'string', format: 'hhmm' }, c: { type: 'string', format: 'cron5' } } }
    assert.ok(ok(schema, { list: ['a'], at: '2026-10-26T08:30:00+09:00', t: '08:30', c: '30 8,17 * * *' }))
    const r = validateSchema(schema, { list: ['a', 'B'], at: 'yesterday', t: '25:00', c: '* * *' })
    assert.deepEqual(r.errors.map((e) => `${e.path}:${e.keyword}`), ['/list/1:pattern', '/at:format', '/t:format', '/c:format'])
  })

  test('keywords that need annotation tracking are rejected, not ignored', () => {
    assert.throws(() => validateSchema({ unevaluatedProperties: false }, {}), /unsupported/)
  })
})
