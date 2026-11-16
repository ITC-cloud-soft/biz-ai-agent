// The staff manual of a business system as data (Markdown chapters → sections). Pure except parseManualDir (reads the files you name).
//
// Format (one screen = one section):
//
//   # 3. Chapter title
//   ## Screen name
//   <a id="manual-xx-yy"></a>
//   | 項目 | 内容 |                      ← the section table; its row names are LABELS (overridable)
//   |---|---|
//   | URL | `/screen`（detail：`/screen/:id`） |
//   | メニュー | Workspace › Group › Screen |
//   | 使える役割 | … |
//   | 関連する画面 | [Other](#manual-xx-zz) |
//   | キーワード | word、word、… |
//   One to three sentences.
//   ### できること   ### 操作の流れ   ### 注意・決まりごと   ### よくある質問（- **Q. …** / A. …）
//
// A section of a mobile app has the row 「アプリの画面」 (screen id and tab) instead of URL. A section about a channel (SNS) may list
// 「関係する画面」. Lines marked 「（要確認）」 are open points (`unconfirmed`).

export const DEFAULT_LABELS = Object.freeze({
  rows: Object.freeze({
    URL: 'url', 'アプリの画面': 'appScreen', '関係する画面': 'screens', 'メニュー': 'menu', 'アプリでの場所': 'appLocation',
    '使える役割': 'roleText', '関連する画面': 'related', 'キーワード': 'keywords',
    // English manuals
    Screen: 'url', 'App screen': 'appScreen', 'Related screens': 'screens', Menu: 'menu', 'Where in the app': 'appLocation',
    Roles: 'roleText', 'See also': 'related', Keywords: 'keywords',
  }),
  can: Object.freeze(['できること', 'What you can do']),
  steps: Object.freeze(['操作の流れ', 'Steps']),
  notes: Object.freeze(['注意', 'Notes']),
  qa: Object.freeze(['よくある質問', 'FAQ']),
})

/** 「（要確認）」「。要確認）」「（要確認：…」 (and "(to be confirmed)"): a point the manual could not settle — not a screen's own status label. */
export const UNCONFIRMED_RE = /(?:[（(]|。)要確認[）)]|[（(]要確認[：:]|\(to be confirmed\)/i
const ANCHOR_RE = /<a id="(manual-[a-z0-9-]+)"><\/a>/

export const plainText = (s) => String(s ?? '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*([^*]*)\*\*/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const items = (lines) => lines.map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)?.[1]).filter(Boolean).map(plainText)
const tableRows = (lines) => lines.filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
const paths = (cell) => [...new Set([...String(cell ?? '').matchAll(/`(\/[^`\s]*)`/g)].map((m) => m[1]))]

function parseQa(lines) {
  const qa = []
  let cur = null
  for (const line of lines) {
    const q = line.match(/^- \*\*Q\.\s*(.*?)\*\*\s*$/)
    if (q) { cur = { q: plainText(q[1]), a: '' }; qa.push(cur); continue }
    const a = line.match(/^\s+A\.\s*(.*)$/)
    if (a && cur) { cur.a = plainText(a[1]); continue }
    if (cur && cur.a && /^\s+\S/.test(line)) cur.a = `${cur.a} ${plainText(line)}`
  }
  return qa.filter((x) => x.q && x.a)
}

/**
 * One chapter → { chapter, title, sections }. chapter = the file name without `.md`.
 * A section: { id, chapter, title, menu, paths, screens, app, roleText, keywords, summary, can, steps, notes, qa, related, unconfirmed }.
 */
export function parseChapter(file, text, { labels = DEFAULT_LABELS } = {}) {
  const chapter = String(file).replace(/^.*[\\/]/, '').replace(/\.md$/, '')
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const title = plainText((lines.find((l) => l.startsWith('# ')) ?? '').slice(2))
  const sections = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) { i++; continue }
    const start = i
    i++
    while (i < lines.length && !lines[i].startsWith('## ')) i++
    const block = lines.slice(start, i)
    const id = block.join('\n').match(ANCHOR_RE)?.[1]
    if (!id) continue
    const sub = new Map([['_head', []]])
    let key = '_head'
    for (const l of block.slice(1)) {
      if (l.startsWith('### ')) { key = plainText(l.slice(4)); sub.set(key, []); continue }
      sub.get(key).push(l)
    }
    const head = sub.get('_head')
    const table = {}
    for (const row of tableRows(head)) {
      const k = labels.rows[row[0]]
      if (k) table[k] = row.slice(1).join(' | ')
    }
    const pick = (names) => [...sub.entries()].filter(([k]) => names.some((n) => k.startsWith(n))).flatMap(([, v]) => v)
    sections.push({
      id,
      chapter,
      title: plainText(block[0].slice(3)),
      menu: plainText(table.menu ?? table.appLocation ?? ''),
      paths: paths(table.url),
      screens: paths(table.screens),
      app: table.appScreen ? { screen: plainText(table.appScreen), location: plainText(table.appLocation ?? '') } : null,
      roleText: plainText(table.roleText ?? ''),
      keywords: plainText(table.keywords ?? '').split(/[、,]/).map((s) => s.trim()).filter(Boolean),
      summary: plainText(head.filter((l) => l.trim() && !/^[|<]/.test(l) && !/^-{3,}$/.test(l.trim())).join(' ')),
      can: items(pick(labels.can)),
      steps: items(pick(labels.steps)),
      notes: items(pick(labels.notes)),
      qa: parseQa(pick(labels.qa)),
      related: [...new Set([...String(table.related ?? '').matchAll(/\]\(([^)]*#(manual-[a-z0-9-]+))\)/g)].map((m) => m[2]))],
      unconfirmed: block.filter((l) => UNCONFIRMED_RE.test(l)).map((l) => plainText(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))).slice(0, 5),
    })
  }
  return { chapter, title, sections }
}

/** The chapter files of a manual folder: `NN-name.md`, in name order (README.md, _*.md are not chapters). */
export const isChapterFile = (name) => /^\d\d-[A-Za-z0-9-]+\.md$/.test(String(name))

/** { fileName: text } → chapters (chapter files only, in name order). */
export function parseManual(files, opts = {}) {
  return Object.entries(files)
    .map(([name, text]) => [String(name).replace(/^.*[\\/]/, ''), text])
    .filter(([name]) => isChapterFile(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => parseChapter(name, text, opts))
}

/** The synonyms file: one group a line, `- [word, word, …]` (the first word is the manual's own). Comments start with #. */
export function parseSynonyms(text) {
  return String(text ?? '').split('\n').map((l) => l.match(/^\s*-\s*\[(.*)\]\s*$/)?.[1]).filter(Boolean)
    .map((g) => g.split(',').map((s) => s.trim()).filter(Boolean)).filter((g) => g.length > 1)
}

/** The exclusions file: one path a line, a reason after white space. Comments start with #. */
export function parseExclusions(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0])
}
