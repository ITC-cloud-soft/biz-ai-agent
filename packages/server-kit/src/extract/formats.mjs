// Document -> Markdown text: plain text / Markdown (character set detection), CSV (delimiter + quotes), docx (paragraphs,
// headings, lists, tables), xlsx (one `## sheet` table per visible sheet, display-like values). Pure, no dependency.
import { AttachmentError } from './errors.mjs'
import { readZip, zipText, parseXml, kids, kid, attr, xmlText } from './zip.mjs'

// ---------------------------------------------------------------------------------------------------------------- text

/** True when the first 8 KiB look binary (a NUL byte without a UTF-16 byte order mark). */
export function looksBinary(b) {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return false
  const n = Math.min(b.length, 8192)
  for (let i = 0; i < n; i += 1) if (b[i] === 0) return true
  return false
}

/**
 * Bytes -> { text, encoding }: a byte order mark (UTF-8 / UTF-16LE / UTF-16BE), else strict UTF-8, else Shift_JIS (cp932),
 * else UTF-8 with replacement characters. Line ends become LF.
 */
export function decodeText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  let encoding
  let text
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { encoding = 'utf-8'; text = new TextDecoder('utf-8').decode(b.subarray(3)) }
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { encoding = 'utf-16le'; text = new TextDecoder('utf-16le').decode(b.subarray(2)) }
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { encoding = 'utf-16be'; text = new TextDecoder('utf-16be').decode(b.subarray(2)) }
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); encoding = 'utf-8' } catch {
      try { text = new TextDecoder('shift_jis', { fatal: true }).decode(b); encoding = 'shift_jis' } catch {
        text = new TextDecoder('utf-8').decode(b); encoding = 'utf-8'
      }
    }
  }
  return { text: text.replace(/\r\n?/g, '\n'), encoding }
}

// ---------------------------------------------------------------------------------------------------------------- tables

const cellText = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()

/**
 * Rows of strings -> a Markdown table. Empty rows and empty columns are left out; the first row is the header.
 * Returns '' when nothing is left.
 */
export function markdownTable(rows, { maxCols = 100 } = {}) {
  const kept = rows.map((r) => r.map(cellText)).filter((r) => r.some((c) => c !== ''))
  if (!kept.length) return ''
  const width = Math.min(maxCols, Math.max(...kept.map((r) => r.length)))
  const used = []
  for (let c = 0; c < width; c += 1) if (kept.some((r) => (r[c] ?? '') !== '')) used.push(c)
  const line = (r) => `| ${used.map((c) => r[c] ?? '').join(' | ')} |`
  return [line(kept[0]), `| ${used.map(() => '---').join(' | ')} |`, ...kept.slice(1).map(line)].join('\n')
}

// ---------------------------------------------------------------------------------------------------------------- CSV

/** The delimiter of a CSV text: the most frequent of , TAB ; on the first line (outside quotes); default comma. */
export function csvDelimiter(text) {
  const first = text.split('\n', 1)[0] ?? ''
  const counts = { ',': 0, '\t': 0, ';': 0 }
  let quoted = false
  for (const ch of first) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in counts) counts[ch] += 1
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

/** RFC 4180 rows (quotes, doubled quotes, line breaks inside quotes). Stops after maxRows non-empty rows (+1 to tell). */
export function parseCsv(text, { delimiter = csvDelimiter(text), maxRows = Infinity } = {}) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  const push = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    push()
    if (row.some((c) => c.trim() !== '')) rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
      } else field += ch
      i += 1
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) push()
    else if (ch === '\n') { endRow(); if (rows.length > maxRows) return rows }
    else field += ch
    i += 1
  }
  if (field !== '' || row.length) endRow()
  return rows
}

// ---------------------------------------------------------------------------------------------------------------- docx

function docxStyles(xml) {
  const map = new Map()
  if (!xml) return map
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], 'w:styleId')
    const name = /<w:name\b([^>]*)\/?>/.exec(m[2])
    if (id) map.set(id, String(attr(name?.[1] ?? '', 'w:val') ?? ''))
  }
  return map
}

/** numId -> ilvl -> numFmt ('bullet', 'decimal', ...). */
function docxNumbering(xml) {
  const out = new Map()
  if (!xml) return out
  const abstract = new Map()
  for (const m of xml.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map()
    for (const l of m[2].matchAll(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g)) {
      const fmt = /<w:numFmt\b([^>]*)\/?>/.exec(l[2])
      levels.set(Number(attr(l[1], 'w:ilvl') ?? 0), String(attr(fmt?.[1] ?? '', 'w:val') ?? 'bullet'))
    }
    abstract.set(attr(m[1], 'w:abstractNumId'), levels)
  }
  for (const m of xml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
    const a = /<w:abstractNumId\b([^>]*)\/?>/.exec(m[2])
    out.set(attr(m[1], 'w:numId'), abstract.get(attr(a?.[1] ?? '', 'w:val')) ?? new Map())
  }
  return out
}

/** The text of a run tree: w:t, w:tab, w:br / w:cr; deleted text, field codes and the mc:Fallback copy are skipped. */
function runsText(node) {
  let out = ''
  const walk = (n) => {
    for (const c of n.c ?? []) {
      if (c.t !== undefined) continue
      switch (c.n) {
        case 'w:t': out += c.c.map((x) => x.t ?? '').join(''); break
        case 'w:tab': out += '\t'; break
        case 'w:br': case 'w:cr': out += '\n'; break
        case 'w:delText': case 'w:instrText': case 'mc:Fallback': case 'w:pPr': case 'w:rPr': break
        case 'w:tbl': break // nested table inside a paragraph-level walk: handled as a block
        default: walk(c)
      }
    }
  }
  walk(node)
  return out
}

function headingLevel(styleId, styles) {
  if (!styleId) return 0
  const name = String(styles.get(styleId) ?? '').toLowerCase()
  if (name === 'title' || /^title$/i.test(styleId)) return 1
  const m = /^heading\s*(\d)$/.exec(name) ?? /^heading(\d)$/i.exec(styleId)
  return m ? Math.min(6, Number(m[1])) : 0
}

function docxBlocks(body, ctx, out) {
  for (const el of kids(body)) {
    if (el.n === 'w:p') {
      const ppr = kid(el, 'w:pPr')
      const styleId = attr(kid(ppr, 'w:pStyle')?.a, 'w:val')
      const numPr = kid(ppr, 'w:numPr')
      const text = runsText(el).replace(/[ \t]+$/g, '').trim()
      if (!text) continue
      const level = headingLevel(styleId, ctx.styles)
      if (level) { out.push(`${'#'.repeat(level)} ${text.replace(/\n/g, ' ')}`); continue }
      if (numPr) {
        const ilvl = Number(attr(kid(numPr, 'w:ilvl')?.a, 'w:val') ?? 0) || 0
        const numId = attr(kid(numPr, 'w:numId')?.a, 'w:val')
        const fmt = ctx.numbering.get(numId)?.get(ilvl) ?? 'bullet'
        if (numId !== '0') {
          out.push(`${'  '.repeat(Math.min(ilvl, 8))}${fmt === 'bullet' || fmt === 'none' ? '-' : '1.'} ${text.replace(/\n/g, ' ')}`)
          continue
        }
      }
      out.push(text)
    } else if (el.n === 'w:tbl') {
      const rows = kids(el, 'w:tr').map((tr) => kids(tr, 'w:tc').map((tc) => {
        const parts = []
        docxBlocks(tc, ctx, parts)
        return parts.join(' ')
      }))
      const table = markdownTable(rows)
      if (table) out.push(table)
    } else if (el.n === 'w:sdt') {
      const content = kid(el, 'w:sdtContent')
      if (content) docxBlocks(content, ctx, out)
    } else if (el.n === 'w:customXml' || el.n === 'w:smartTag') {
      docxBlocks(el, ctx, out)
    }
  }
}

/** A .docx (bytes) -> Markdown text. */
export function docxToMarkdown(bytes) {
  const entries = readZip(bytes)
  const doc = zipText(entries, 'word/document.xml')
  if (doc === null) throw new AttachmentError('type_mismatch', { reason: 'not_docx' })
  const ctx = { styles: docxStyles(zipText(entries, 'word/styles.xml')), numbering: docxNumbering(zipText(entries, 'word/numbering.xml')) }
  const root = parseXml(doc)
  const body = kid(kid(root, 'w:document'), 'w:body')
  const out = []
  if (body) docxBlocks(body, ctx, out)
  return out.join('\n\n')
}

// ---------------------------------------------------------------------------------------------------------------- xlsx

function runText(xml) {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr\b[^>]*\/>/g, '')
  let out = ''
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += m[1] === undefined ? '' : xmlText(m[1])
  return out
}

function sharedStrings(xml) {
  if (!xml) return []
  const out = []
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) out.push(m[1] === undefined ? '' : runText(m[1]))
  return out
}

// built-in number formats (ECMA-376 §18.8.30): dates, times, date-times, percents
const BUILTIN_FORMAT = new Map([
  ...[14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].map((id) => [id, 'date']),
  ...[18, 19, 20, 21, 45, 46, 47, 32, 33, 55, 56].map((id) => [id, 'time']),
  [22, 'datetime'], [9, 'percent'], [10, 'percent'],
])

function formatKind(code) {
  // quoted text, escapes, padding and [colour] / [$-411] sections removed; [h] [m] [s] (elapsed time) kept
  const c = String(code ?? '').replace(/"[^"]*"|\\.|_.|\*./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
  const time = /[hs]/i.test(c)
  const date = /[yd]/i.test(c) || (/m/i.test(c) && !time)
  if (date && time) return 'datetime'
  if (date) return 'date'
  if (time) return 'time'
  if (/%/.test(c)) return 'percent'
  return null
}

/** Per style index (cellXfs order): 'date' | 'time' | 'datetime' | 'percent' | null. */
function styleKinds(xml) {
  if (!xml) return []
  const custom = new Map()
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1], 'numFmtId')), formatKind(attr(m[1], 'formatCode')))
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
  if (!xfs) return []
  const out = []
  for (const m of xfs[1].matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attr(m[1], 'numFmtId') ?? 0)
    out.push(custom.has(id) ? custom.get(id) : (BUILTIN_FORMAT.get(id) ?? null))
  }
  return out
}

/** Decimal text of a stored number, without binary float noise (0.1+0.2 -> 0.3). */
export function numberText(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(Number(n.toPrecision(15)))
}

const pad = (n) => String(n).padStart(2, '0')
/** Excel serial (1900 date system) -> display text of the kind. */
export function serialText(serial, kind, date1904 = false) {
  const n = Number(serial)
  if (!Number.isFinite(n)) return String(serial)
  if (kind === 'percent') return `${numberText(n * 100)}%`
  const days = Math.floor(n)
  const secs = Math.round((n - days) * 86_400)
  const timeText = `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}`
  if (kind === 'time') return n < 1 ? timeText : `${numberText(n * 24)}h`
  if (n < 0 || n > 2_958_465) return numberText(n)
  const ms = (days - (date1904 ? 24_107 : 25_569)) * 86_400_000
  const d = new Date(ms).toISOString().slice(0, 10)
  return kind === 'datetime' && secs ? `${d} ${timeText}` : d
}

function colIndex(ref) {
  const m = /^([A-Z]{1,3})\d*$/.exec(String(ref || ''))
  if (!m) return -1
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function resolveTarget(target) {
  const t = String(target).replace(/\\/g, '/')
  if (t.startsWith('/')) return t.slice(1)
  const out = []
  for (const p of `xl/${t}`.split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
  return out.join('/')
}

const MAX_COLS = 100

/** Rows of one worksheet XML (display-like strings). Stops after maxRows non-empty rows and tells how many there were. */
function sheetRows(xml, { strings, kinds, date1904, maxRows }) {
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? ''
  const rows = []
  let total = 0
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = []
    let nextCol = 0
    for (const cm of String(rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r')
      const c = ref ? colIndex(ref.replace(/\d+$/, '')) : nextCol
      nextCol = c + 1
      if (c < 0 || c >= MAX_COLS) continue
      const type = attr(cm[1], 't') ?? 'n'
      const kind = kinds[Number(attr(cm[1], 's') ?? 0)] ?? null
      const inner = cm[2] ?? ''
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let value = ''
      if (type === 's') value = strings[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = runText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '')
      else if (type === 'str' || type === 'e') value = raw === undefined ? '' : xmlText(raw)
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : ''
      else if (type === 'd') value = raw === undefined ? '' : xmlText(raw).replace('T', ' ').replace(/(:\d\d)(\.\d+)?Z?$/, '$1')
      else if (raw !== undefined) value = kind ? serialText(xmlText(raw), kind, date1904) : numberText(xmlText(raw))
      cells[c] = value
    }
    const row = Array.from(cells, (x) => x ?? '')
    if (!row.some((v) => String(v).trim() !== '')) continue
    total += 1
    if (rows.length < maxRows) rows.push(row)
  }
  return { rows, total }
}

/**
 * A .xlsx (bytes) -> { text, sheets, truncated }: one `## <sheet>` + table per visible sheet (hidden sheets are left out),
 * formulas as their stored values, at most maxRows non-empty rows per sheet.
 */
export function xlsxToMarkdown(bytes, { maxRows = 2_000 } = {}) {
  const entries = readZip(bytes)
  const wb = zipText(entries, 'xl/workbook.xml')
  if (wb === null) throw new AttachmentError('type_mismatch', { reason: 'not_xlsx' })
  const rels = zipText(entries, 'xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map()
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) targets.set(attr(m[1], 'Id'), attr(m[1], 'Target'))
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb)
  const strings = sharedStrings(zipText(entries, 'xl/sharedStrings.xml'))
  const kinds = styleKinds(zipText(entries, 'xl/styles.xml'))
  const parts = []
  let sheets = 0
  let truncated = false
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const state = attr(m[1], 'state')
    if (state === 'hidden' || state === 'veryHidden') continue
    const part = resolveTarget(targets.get(attr(m[1], 'r:id')) ?? '')
    if (!entries.has(part)) continue
    const name = attr(m[1], 'name') ?? `Sheet${sheets + 1}`
    const { rows, total } = sheetRows(entries.get(part)().toString('utf8'), { strings, kinds, date1904, maxRows })
    sheets += 1
    const table = markdownTable(rows, { maxCols: MAX_COLS })
    let section = `## ${name.replace(/\n/g, ' ')}\n\n${table || '（空のシート）'}`
    if (total > rows.length) {
      truncated = true
      section += `\n\n（以下省略：このシートは ${total} 行あります）`
    }
    parts.push(section)
  }
  return { text: parts.join('\n\n'), sheets, truncated }
}
