// help-tool.js — the AI's tool for how-to questions, answered from the business system's manual (@dsh-bridge/help on the business side,
// GET /bridge/v1/help/search or the system's own path). Read-only; runs as the employee who asked (the delegation gate).
//
// The answer's ground truth is the manual's sections the business system returns for the asker's role. URLs come only from the
// business system (`url` only when the asker may open the screen; `manualUrl` = the manual page): the tool drops a `url` of a screen
// the asker cannot open, and refuses arguments that try to pass URLs or answers. bridge-identity's link guard checks the final text again.

const MAX_QUESTION = 200
const WRITE_HINTS = Object.freeze(['url', 'urls', 'link', 'section', 'answer', 'save', 'feedback'])

/** The persona rules for how-to questions (Japanese; add them to the AI employee's persona). */
export const HELP_RULES_JA = Object.freeze([
  'システムの使い方の質問（画面の場所・操作の手順・ことばの意味・だれが何をできるか）：',
  '- 必ず {tool} を呼び、返ったマニュアルの節（title・menu・steps・qa・notes）だけを根拠に答える。自分の知識で手順を作らない。',
  '- URL は {tool} が返した url・manualUrl だけを、そのまま書く。自分で URL を作らない・直さない・推測しない。',
  '- found=false なら「マニュアルに説明が見つかりませんでした。管理者にお問い合わせください。」と答え、手順を作らない。',
  '- canOpen=false の画面は URL を出さず、alt にある役割の人に依頼するよう伝える。',
  '- 「未確認の点」が返った節は、その点を管理者に確認するよう添える。',
  '- 業務のデータの質問は業務のツールで答える。使い方とデータの両方が要る質問は両方を呼ぶ。',
  '- 答えの形：1 行目「【ご案内】<節の題名>」、続けて要点と手順を 3〜5 行（ボタン名・画面名は「」で画面の文字のまま）、',
  '  url があれば「こちらから開けます：<url>」、最後に「くわしい手順：<manualUrl>」。',
  '- 日本語以外の質問には、その言語で答える（画面の名前・ボタン名は日本語のまま「」で示す。{tool} には日本語に言い換えて渡す）。',
].join('\n'))
export const helpRules = (toolName, rules = HELP_RULES_JA) => rules.replaceAll('{tool}', toolName)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asArray = (v) => (Array.isArray(v) ? v : [])
const strOrNull = (v) => (typeof v === 'string' && v ? v : null)
const strings = (v, n) => asArray(v).filter((x) => typeof x === 'string').slice(0, n)

/** One result of the help search: the fields an answer may use (a url only when the asker may open the screen). */
export function toHelpResult(r) {
  return {
    id: strOrNull(r?.id),
    title: strOrNull(r?.title),
    menu: strOrNull(r?.menu),
    summary: strOrNull(r?.summary),
    steps: strings(r?.steps, 6),
    qa: asArray(r?.qa).filter((x) => isObj(x) && typeof x.q === 'string' && typeof x.a === 'string').slice(0, 2).map((x) => ({ q: x.q, a: x.a })),
    notes: strings(r?.notes, 3),
    app: isObj(r?.app) ? { screen: strOrNull(r.app.screen), location: strOrNull(r.app.location) } : null,
    canOpen: Boolean(r?.canOpen),
    url: r?.canOpen ? strOrNull(r?.url) : null,
    manualUrl: strOrNull(r?.manualUrl),
    alt: strOrNull(r?.alt),
    unconfirmed: strings(r?.unconfirmed, 5),
  }
}

const text = (lines) => [{ type: 'text', text: lines.filter((line) => typeof line === 'string' && line !== '').join('\n') }]

/** What the model sees: the sections, their steps and FAQ, and the URLs exactly as the business system gave them. */
export function renderHelp(r) {
  return text([
    r?.found ? `${r.results.length} section(s) of the manual:` : 'found=false: the manual has no section for this question (say so; do not invent steps).',
    ...asArray(r?.results).map((x, i) => [
      `## ${i + 1}. ${x.title}${x.menu ? `（${x.menu}）` : ''} [${x.id}]`,
      x.summary,
      x.app?.screen ? `アプリでの場所: ${x.app.location || ''} ${x.app.screen}`.trim() : '',
      x.steps.length ? `操作の流れ:\n${x.steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}` : '',
      x.qa.length ? x.qa.map((q) => `Q. ${q.q}\nA. ${q.a}`).join('\n') : '',
      x.notes.length ? `注意: ${x.notes.join(' / ')}` : '',
      x.unconfirmed.length ? `未確認の点（管理者に確認するよう伝える）: ${x.unconfirmed.join(' / ')}` : '',
      x.canOpen && x.url ? `url: ${x.url}` : `url: none (canOpen=false) — ${x.alt ?? 'ask the administrator'}`,
      x.manualUrl ? `manualUrl: ${x.manualUrl}` : '',
    ].filter(Boolean).join('\n')),
  ])
}

/**
 * The help tool's spec (pass it to defineTool / a tool module).
 * @param {object} o
 * @param {string} o.name           e.g. '<namespace>_help_search'
 * @param {string} [o.path]         the business system's help search path (default the Bridge v1 one)
 * @param {(tool, path, query) => Promise<any>} o.requestJson   the delegated request of the tool runtime
 * @param {string} [o.systemName]   shown in the description
 */
export function helpToolSpec({ name, path = '/bridge/v1/help/search', requestJson, systemName = 'the business system' }) {
  return {
    name,
    access: 'read',
    description:
      `Read-only: searches the staff manual of ${systemName} for how to use the system — where a screen is, the steps of an operation, `
      + 'what a word means, who may do what. Call it for EVERY question about using the system and answer ONLY from the returned sections '
      + '(title, menu, steps, qa, notes). question: the question rephrased as a short sentence in the manual\'s language (translate questions '
      + 'asked in other languages). Each result has url (the screen, only when the asker can open it) and manualUrl (the manual page): write '
      + 'these URLs exactly as returned and never build or edit a URL yourself. canOpen=false: no url; tell the asker whom to ask (alt). '
      + 'found=false: say the manual has no answer and suggest asking the administrator; never invent steps. unconfirmed lines are open '
      + 'points: say so. For business data use the business tools instead.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: `The question as a short sentence (max ${MAX_QUESTION} characters).` },
        limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional: how many sections (default 3).' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, found: { type: 'boolean' }, results: { type: 'array' } }, required: ['ok', 'found'] },
      render: (_args, r) => renderHelp(r),
    },
    async execute(args = {}) {
      if (!isObj(args)) throw new Error(`${name}: arguments must be an object`)
      const writes = Object.keys(args).filter((k) => WRITE_HINTS.includes(k))
      if (writes.length) throw new Error(`${name}: ${writes.join(', ')} not accepted — read-only; URLs come from the manual's index only`)
      const unknown = Object.keys(args).filter((k) => !['question', 'limit'].includes(k))
      if (unknown.length) throw new Error(`${name}: unknown argument(s): ${unknown.join(', ')}`)
      if (typeof args.question !== 'string' || !args.question.trim()) throw new Error(`${name}: "question" is required`)
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) throw new Error(`${name}: "limit" must be an integer 1–5`)
      const question = args.question.trim().slice(0, MAX_QUESTION)
      const r = await requestJson(name, path, { q: question, ...(args.limit ? { limit: String(args.limit) } : {}) })
      const results = asArray(r?.results).map(toHelpResult).filter((x) => x.id)
      return { ok: true, found: Boolean(r?.found) && results.length > 0, results }
    },
  }
}
