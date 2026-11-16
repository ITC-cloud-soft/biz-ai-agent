// The conversation of an e2e run as a readable chat transcript (`pnpm demo`, or `pnpm run e2e -- --story`).
// Everything shown is what the people sent through the mock LINE webhook and what DSH sent back through the mock LINE API:
// the AI employee's answers, notifications, approval cards and their updates. Fictional data only.
import { flexSummary } from '../src/mock-line.mjs'

const WHO = {
  manager: 'manager（設備責任者）',
  inspector: 'inspector1（点検員）',
  stranger: 'stranger（未連携の人）',
  system: '業務システム',
}

const textOf = (messages) => (messages ?? []).map((m) => {
  if (m.type === 'text') return m.text
  if (m.type !== 'flex') return `[${m.type}]`
  const f = flexSummary(m)
  const buttons = f.buttons.filter((b) => b.label).map((b) => `[ ${b.label} ]`).join(' ')
  return [...f.texts, buttons].filter(Boolean).join('\n')
}).join('\n')

const indent = (text, pad) => String(text).trim().split('\n').map((l) => pad + l).join('\n')

/**
 * printStory({ said, lineLog, users }): said = [{ at, who, text, replyToken?, action? }] (what people did),
 * lineLog = the mock LINE log, users = { who: LINE user id }.
 */
export function printStory({ said, lineLog, users, out = console.log }) {
  const byUser = Object.fromEntries(Object.entries(users).map(([who, id]) => [id, who]))
  const byToken = Object.fromEntries(said.filter((s) => s.replyToken).map((s) => [s.replyToken, s.who]))
  const sent = lineLog
    .filter((e) => (e.kind === 'reply' || e.kind === 'push') && (e.messages ?? []).length)
    .map((e) => ({ at: e.at, to: e.kind === 'push' ? byUser[e.to] : byToken[e.replyToken], text: textOf(e.messages), push: e.kind === 'push' }))
    .filter((e) => e.to)
  const lines = [
    ...said.map((s) => ({ at: s.at, kind: 'person', ...s })),
    ...sent.map((e) => ({ ...e, kind: 'ai' })),
  ].sort((a, b) => a.at - b.at)

  out('\n== 会話の記録 / the conversation (LINE, mock) ==\n')
  for (const l of lines) {
    if (l.kind === 'person') {
      out(`${WHO[l.who] ?? l.who} ▶ ${l.action ? `(${l.action})` : l.text}`)
    } else {
      out(`  AI 社員 ▶ ${WHO[l.to] ?? l.to}${l.push ? '  ［自分から］' : ''}`)
      out(indent(l.text, '    │ '))
    }
    out('')
  }
}
