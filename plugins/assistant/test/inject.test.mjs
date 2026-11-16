// 実 DSH（Cordis）は宣言していないサービスを読ませない（"cannot get property ... without inject"）。モックの ctx ではこの誤りが出ないので、宣言そのものを確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inject } from '../src/index.js'

test('inject declares every Host service the plugin reads: connection (RPC, peer) and typertGateway (Harness: session.create / prompt)', () => {
  assert.ok(inject.includes('connection'))
  assert.ok(inject.includes('typertGateway'))
})
