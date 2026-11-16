// Reading a ZIP archive (docx / xlsx) and a tiny XML reader. No dependency: node:zlib inflateRawSync.
// Central directory only (no data descriptors needed), no ZIP64, no encryption; every entry is inflated with an output cap so a
// zip bomb stops at the cap. The XML reader keeps elements, attributes (as raw text) and text; it never resolves entities other
// than the five predefined ones and numeric references, and a DOCTYPE is refused (no external entities, no billion laughs).
import { inflateRawSync } from 'node:zlib'
import { AttachmentError } from './errors.mjs'

export const MAX_ZIP_ENTRIES = 10_000
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024

/** True when the bytes start like a ZIP local file header. */
export const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** Entries of a ZIP archive: Map(name -> () => Buffer). Broken archive: AttachmentError('invalid_attachment'). */
export function readZip(buf, { maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  const bad = (reason) => new AttachmentError('invalid_attachment', { reason })
  if (buf.length < 22) throw bad('zip_broken')
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw bad('zip_broken')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (offset === 0xffffffff || count === 0xffff) throw bad('zip64')
  if (count > MAX_ZIP_ENTRIES) throw bad('zip_entries')
  const entries = new Map()
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw bad('zip_broken')
    const flags = buf.readUInt16LE(offset + 8)
    const method = buf.readUInt16LE(offset + 10)
    const compressed = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const local = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw bad('encrypted')
    entries.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('zip_broken')
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      if (start + compressed > buf.length) throw bad('zip_broken')
      const data = buf.subarray(start, start + compressed)
      if (size > maxEntryBytes) throw bad('zip_entry_too_large')
      if (method === 0) return Buffer.from(data)
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: maxEntryBytes })
        } catch {
          throw bad('zip_broken')
        }
      }
      throw bad('zip_method')
    })
  }
  return entries
}

/** The text of one entry (UTF-8), or null when it is absent. */
export function zipText(entries, name) {
  return entries.has(name) ? entries.get(name)().toString('utf8') : null
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
/** XML character references -> text (the five predefined entities and numeric references only). */
export function xmlText(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITY[e]
  })
}

/** One attribute of a raw attribute text (`w:val="x" r:id="y"`), entity-decoded; null when absent. */
export function attr(attrs, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\s)${esc}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs ?? '')
  return m ? xmlText(m[1] ?? m[2]) : null
}

/**
 * A small XML tree: { n: name, a: rawAttrs, c: children } elements and { t: text } text nodes. Comments / PIs are skipped,
 * CDATA is text. A DOCTYPE makes it AttachmentError('invalid_attachment').
 */
export function parseXml(xml) {
  const root = { n: '#root', a: '', c: [] }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!([A-Za-z]+)[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g
  for (const m of String(xml).matchAll(re)) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) { top.c.push({ t: m[1] }); continue }
    if (m[2] !== undefined) throw new AttachmentError('invalid_attachment', { reason: 'xml_doctype' })
    if (m[7] !== undefined) { top.c.push({ t: xmlText(m[7]) }); continue }
    if (m[4] === undefined) continue // comment / processing instruction
    if (m[3] === '/') {
      // close the nearest matching element (tolerant of a stray close tag)
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].n === m[4]) { stack.length = i; break }
      }
      continue
    }
    const el = { n: m[4], a: m[5] ?? '', c: [] }
    top.c.push(el)
    if (m[6] !== '/') stack.push(el)
  }
  return root
}

/** Child elements of a node (optionally of one name). */
export const kids = (node, name) => (node?.c ?? []).filter((c) => c.n !== undefined && (name === undefined || c.n === name))
/** The first child element of one name. */
export const kid = (node, name) => (node?.c ?? []).find((c) => c.n === name)
