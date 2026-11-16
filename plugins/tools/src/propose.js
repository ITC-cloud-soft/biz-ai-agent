// propose.js — 手書きの「提案」ツールを作るヘルパー（業務の書き込みは、人が業務 Web で採択する提案だけ）。
//
//   defineProposeTool(spec, { requestJson })  →  DSH の tools.register に渡せるツール（access: propose）
//
// 業務システムの提案 API（Bridge v1 の POST /bridge/v1/proposals {kind, payload}）を 1 回だけ呼ぶ。引数は parameters の
// properties にあるものだけ受け付け（未知の引数・forbidden の引数はエラー。黙って捨てない）、required を確かめ、validate で
// 業務の形を確かめてから payload を作る。結果は提案の ID・種類・状態だけ（業務の本文はモデルに返さない）。
// 誰の提案か（委託トークン）は bridge-tools の gate が呼び出しごとに決める（ここでは扱わない）。
import { defineTool } from '@dsh-bridge/dsh-core'

export const PROPOSALS_PATH = '/bridge/v1/proposals'
const KIND_RE = /^[a-z][a-z0-9_.-]{1,63}$/

const asText = (lines) => [{ type: 'text', text: lines.filter((line) => typeof line === 'string' && line !== '').join('\n') }]

/** 引数のヘルパー（ツールのエラーは `<tool>: ...`）。 */
export const args = Object.freeze({
  string(tool, field, value, { required = false, max = 500, pattern } = {}) {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      if (required) throw new Error(`${tool}: "${field}" is required`)
      return undefined
    }
    if (typeof value !== 'string') throw new Error(`${tool}: "${field}" must be a string`)
    const text = value.trim()
    if (text.length > max) throw new Error(`${tool}: "${field}" must be at most ${max} characters`)
    if (pattern && !pattern.test(text)) throw new Error(`${tool}: "${field}" has an invalid format (got ${JSON.stringify(text)})`)
    return text
  },
  /** 'YYYY-MM-DD'（実在する日付）。 */
  date(tool, field, value, { required = false } = {}) {
    const text = args.string(tool, field, value, { required, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })
    if (text === undefined) return undefined
    const d = new Date(`${text}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw new Error(`${tool}: "${field}" must be a real date YYYY-MM-DD (got ${JSON.stringify(text)})`)
    return text
  },
  integer(tool, field, value, { required = false, min = 0, max = 1e9 } = {}) {
    if (value === undefined || value === null) {
      if (required) throw new Error(`${tool}: "${field}" is required`)
      return undefined
    }
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${tool}: "${field}" must be an integer between ${min} and ${max}`)
    return value
  },
})

function defaultRender(_args, result) {
  const proposal = result?.proposal
  if (!proposal?.id) return asText(['proposal: not created'])
  return asText([
    `proposal ${proposal.id} kind=${proposal.kind ?? '?'} status=${proposal.status ?? '?'}`,
    'this is a proposal only: a person must accept it in the business web app before anything changes',
  ])
}

/**
 * 提案ツールを作る。
 * @param {object} spec
 * @param {string} spec.name          ツール名（アプリケーションの名前空間 `<namespace>_` の中。例 facility_propose_reschedule）
 * @param {string} spec.description   何を提案するか（先頭に「Propose-only (non-binding):」を付ける）
 * @param {string} spec.kind          提案の種類（業務システムが決める。例 inspection_reschedule）
 * @param {object} spec.parameters    JSON Schema（object。properties にあるものだけ受け付ける）
 * @param {string[]} [spec.forbidden] 受け付けないと明示する引数（金額など。来たらエラーで理由を返す）
 * @param {string} [spec.forbiddenReason] forbidden の理由（エラー文に入る）
 * @param {(args: object, tool: string) => object} [spec.validate]  引数 → payload（既定は宣言された引数をそのまま）。不正なら throw
 * @param {string} [spec.path]        提案 API の経路（既定 POST /bridge/v1/proposals）
 * @param {Function} [spec.render]    DSH の output.render（既定は ID・種類・状態と「人が採択する」注意）
 * @param {object} deps
 * @param {Function} deps.requestJson createToolRequester の requestJson（そのアプリケーションの API・委託トークン）
 */
export function defineProposeTool(spec, { requestJson } = {}) {
  if (!spec || typeof spec !== 'object') throw new TypeError('defineProposeTool: spec must be an object')
  if (typeof requestJson !== 'function') throw new TypeError(`defineProposeTool: ${spec.name}: requestJson is required`)
  const { name, description, kind, parameters, forbidden = [], forbiddenReason = '', validate, path = PROPOSALS_PATH, render = defaultRender } = spec
  if (!KIND_RE.test(String(kind ?? ''))) throw new TypeError(`defineProposeTool: ${name}: invalid proposal kind ${JSON.stringify(kind)}`)
  if (!parameters || parameters.type !== 'object' || typeof parameters.properties !== 'object') {
    throw new TypeError(`defineProposeTool: ${name}: parameters must be an object schema with properties`)
  }
  const declared = Object.keys(parameters.properties)
  const required = Array.isArray(parameters.required) ? parameters.required : []
  const lead = String(description ?? '').trim()
  return defineTool({
    name,
    access: 'propose',
    description: lead.startsWith('Propose-only') ? lead : `Propose-only (non-binding): ${lead} Creates a proposal (pending review) that a person accepts in the business web app; it never changes business data by itself.`,
    parameters: { ...parameters, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, proposal: { type: 'object' } }, required: ['ok'] },
      render,
    },
    async execute(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${name}: arguments must be an object`)
      const refused = Object.keys(input).filter((key) => forbidden.includes(key))
      if (refused.length) throw new Error(`${name}: ${refused.join(', ')} ${refused.length > 1 ? 'are' : 'is'} not accepted${forbiddenReason ? ` (${forbiddenReason})` : ''}`)
      const unknown = Object.keys(input).filter((key) => !declared.includes(key))
      if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
      for (const key of required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') throw new Error(`${name}: "${key}" is required`)
      }
      const payload = typeof validate === 'function'
        ? validate(input, name)
        : Object.fromEntries(declared.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]))
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${name}: the proposal payload must be an object`)
      const body = await requestJson(name, path, undefined, { method: 'POST', body: { kind, payload } })
      if (!body?.proposal || typeof body.proposal !== 'object') throw new Error(`${name}: the business API response is missing "proposal"`)
      const p = body.proposal
      return { ok: true, proposal: { id: p.id ?? null, kind: p.kind ?? kind, status: p.status ?? null } }
    },
  })
}
