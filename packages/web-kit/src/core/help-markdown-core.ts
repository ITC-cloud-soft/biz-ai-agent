// The business system's manual (docs/manual/NN-*.md, @dsh-bridge/help) on a help page: a small Markdown reader. Pure
// (test/help-markdown.test.mjs). It never makes HTML: it returns a tree of blocks and inlines that the page turns into elements
// (the manual's text stays text; no dangerouslySetInnerHTML). It reads what the manual format uses: headings (# to ####), paragraphs,
// lists (- / 1., indented continuation lines), tables, rules, `<a id="…"></a>` (the id of the heading before it), bold, code and links.
// A chapter link (03-x.md#…) goes to <basePath>/03-x#… (basePath default '/help'); links to other documents stay text.
// The AI assistant's answers use it too (assistant-markdown-core.ts): headings to ######, *italic*, fenced code blocks, the first
// number of an ordered list, `>` quotes as plain paragraphs, line breaks inside a paragraph (option `breaks`) and the host's link
// rule (option `linkHref`).

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'br'; text: '\n' }
  | { kind: 'link'; text: string; href: string; external: boolean }

export type Block =
  | { kind: 'heading'; level: number; id: string | null; inline: Inline[] }
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][][]; start?: number }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'hr' }
  | { kind: 'code'; lang: string; text: string }

export interface ManualChapter { id: string; title: string; audience: string; blocks: Block[] }
/** basePath: where the help pages live on the web app (chapter links become `<basePath>/<chapter>#<anchor>`). */
export interface ManualOptions {
  basePath?: string
  /** Where a link goes (null: text only). Default: manualHref (chapters of the manual; http(s) as external). */
  linkHref?: (href: string) => { href: string; external: boolean } | null
  /** Keep the line breaks inside a paragraph (default false: the lines are joined with a space). */
  breaks?: boolean
}

const CHAPTER_RE = /^(\d\d-[a-z0-9-]+)\.md$/

/** A link of the manual → where it goes on the web (null: text only). */
export function manualHref(href: string, { basePath = '/help' }: ManualOptions = {}): { href: string; external: boolean } | null {
  const h = href.trim()
  if (/^https?:\/\//i.test(h)) return { href: h, external: true }
  if (h.startsWith('#')) return { href: h, external: false }
  const [file, anchor] = h.split('#')
  const m = CHAPTER_RE.exec(file)
  if (m) return { href: `${basePath}/${m[1]}${anchor ? `#${anchor}` : ''}`, external: false }
  return null
}

/** Inline text → tokens (bold **…**, italic *…*, code `…`, links […](…), line breaks). Unknown markup stays text. */
export function parseInline(src: string, opts: ManualOptions = {}): Inline[] {
  const out: Inline[] = []
  const text = (t: string) => {
    t.split('\n').forEach((p, n) => {
      if (n > 0) out.push({ kind: 'br', text: '\n' })
      if (p) out.push({ kind: 'text', text: p })
    })
  }
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)\)|(?<![\w*])\*(?![\s*])([^*\n]*?[^\s*])\*(?![\w*])/g
  const hrefOf = opts.linkHref ?? ((h: string) => manualHref(h, opts))
  let last = 0
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) text(src.slice(last, at))
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] })
    else if (m[5] !== undefined) out.push({ kind: 'italic', text: m[5] })
    else {
      const link = hrefOf(m[4])
      out.push(link ? { kind: 'link', text: m[3], href: link.href, external: link.external } : { kind: 'text', text: m[3] })
    }
    last = at + m[0].length
  }
  if (last < src.length) text(src.slice(last))
  return out
}

const cells = (line: string, opts: ManualOptions) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => parseInline(c.trim().replace(/\\\|/g, '|'), opts))
const ANCHOR_RE = /^<a id="([a-z0-9-]+)"><\/a>\s*$/
const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/
const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const BLOCK_START_RE = /^(#{1,6}\s|\||<a id=|-{3,}\s*$|```|~~~)/

/** A chapter's text → blocks. */
export function parseMarkdown(text: string, opts: ManualOptions = {}): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  const lastHeading = () => {
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k]
      if (b.kind === 'heading') return b
      if (b.kind !== 'hr') return null
    }
    return null
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const anchor = ANCHOR_RE.exec(line.trim())
    if (anchor) {
      const h = lastHeading()
      if (h && !h.id) h.id = anchor[1]
      else blocks.push({ kind: 'heading', level: 0, id: anchor[1], inline: [] })
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== fence[1]) code.push(lines[i++])
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, id: null, inline: parseInline(heading[2], opts) }); i++; continue }
    if (/^-{3,}\s*$/.test(line.trim())) { blocks.push({ kind: 'hr' }); i++; continue }
    if (line.trim().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++])
      const body = rows.filter((r, n) => !(n === 1 && /^\|?\s*:?-{2,}/.test(r.trim())))
      blocks.push({ kind: 'table', header: cells(body[0] ?? '', opts), rows: body.slice(1).map((r) => cells(r, opts)) })
      continue
    }
    const item = LIST_RE.exec(line)
    if (item && item[1].length === 0) {
      const ordered = /\d/.test(item[2])
      const items: Inline[][][] = []
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i])
        if (m && m[1].length === 0 && /\d/.test(m[2]) === ordered) { items.push([parseInline(m[3], opts)]); i++; continue }
        // a continuation (indented line, or a nested item) belongs to the current item
        if (items.length && /^\s+\S/.test(lines[i])) { items[items.length - 1].push(parseInline(lines[i].trim().replace(/^([-*]|\d+\.)\s+/, ''), opts)); i++; continue }
        break
      }
      const start = ordered ? Number(item[2].slice(0, -1)) : 1
      blocks.push(start > 1 ? { kind: 'list', ordered, items, start } : { kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i].trim()) && !(LIST_RE.exec(lines[i])?.[1] === '')) para.push(lines[i++].trim().replace(/^>\s?/, ''))
    if (para.length) blocks.push({ kind: 'para', inline: parseInline(para.join(opts.breaks ? '\n' : ' '), opts) })
    else i++
  }
  return blocks
}

const plainOf = (inline: Inline[]) => inline.map((x) => x.text).join('')

/** The chapters from the raw files ({ '<path>/03-care-manager.md': text }), in file order; other files are skipped. */
export function manualChapters(files: Record<string, string>, opts: ManualOptions = {}): ManualChapter[] {
  return Object.entries(files)
    .map(([path, text]) => ({ file: path.split('/').pop() ?? '', text }))
    .filter((f) => CHAPTER_RE.test(f.file))
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, text }) => {
      const blocks = parseMarkdown(text, opts)
      const title = blocks.find((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading' && b.level === 1)
      const audience = blocks.find((b): b is Extract<Block, { kind: 'para' }> => b.kind === 'para' && plainOf(b.inline).startsWith('この章の対象'))
      return { id: CHAPTER_RE.exec(file)![1], title: title ? plainOf(title.inline) : file, audience: audience ? plainOf(audience.inline) : '', blocks }
    })
}

/** Headings of level 2 with an id (the sections), for the chapter's table of contents. */
export function sectionsOf(chapter: ManualChapter): { id: string; title: string }[] {
  return chapter.blocks.flatMap((b) => (b.kind === 'heading' && b.level === 2 && b.id ? [{ id: b.id, title: plainOf(b.inline) }] : []))
}
