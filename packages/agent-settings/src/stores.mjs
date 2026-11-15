// File stores of the data directory (v0.1, one process): the vector store and the uploaded documents.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJson } from './settings.mjs'

/**
 * The FILE vector store (vectors.json): the cache Map of createKnowledgeService (key = embedder id + chunk text → vector), keyed on
 * disk by embedder id + SHA-256 of the text (the text itself is not written). A later version swaps this for pgvector & co. with
 * the same load() / save() shape.
 */
export function createFileVectorStore(file) {
  const digest = (key) => {
    const i = key.indexOf('\u0000')
    return `${key.slice(0, i)}\u0000${createHash('sha256').update(key.slice(i + 1)).digest('hex')}`
  }
  let disk = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, vectors: {} }
  return {
    kind: 'file',
    /** A Map for createKnowledgeService({ vectorCache }): reads come from disk by digest, writes are kept for save(). */
    cache() {
      const added = new Map()
      return {
        added,
        get: (key) => (added.get(key) ?? (disk.vectors[digest(key)] ? Float32Array.from(disk.vectors[digest(key)]) : undefined)),
        set: (key, v) => { added.set(key, v); return this },
        has: (key) => added.has(key) || Boolean(disk.vectors[digest(key)]),
      }
    },
    /** Keep only the vectors of the current chunks (keys used by this build) and write the file. */
    save(cache, usedKeys) {
      const next = { version: 1, vectors: {} }
      for (const key of usedKeys) {
        const v = cache.get(key)
        if (v) next.vectors[digest(key)] = Array.from(v, (x) => Math.round(x * 1e6) / 1e6)
      }
      writeJson(file, next)
      disk = next
      return Object.keys(next.vectors).length
    },
    size: () => Object.keys(disk.vectors).length,
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const STATUSES = Object.freeze(['pending', 'published', 'rejected', 'personal_data', 'withdrawn'])

/** Uploaded documents: documents/<id>.json (metadata, status, approval) + documents/<id>.md (text; removed when rejected for personal data). */
export function createDocumentStore(dir) {
  mkdirSync(dir, { recursive: true })
  const metaFile = (id) => join(dir, `${id}.json`)
  const textFile = (id) => join(dir, `${id}.md`)
  const read = (id) => (SLUG_RE.test(id) && existsSync(metaFile(id)) ? JSON.parse(readFileSync(metaFile(id), 'utf8')) : null)
  return {
    list: () => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(f.slice(0, -5))).filter(Boolean).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    get: read,
    text: (id) => (existsSync(textFile(id)) ? readFileSync(textFile(id), 'utf8') : null),
    /** A new id from the title (ASCII slug) or a random one; never one of `taken`. */
    newId(title, taken = new Set()) {
      const base = String(title ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      for (let i = 0; i < 20; i += 1) {
        const id = base.length >= 3 && i === 0 ? base : `${base.length >= 3 ? base : 'doc'}-${randomBytes(3).toString('hex')}`
        if (SLUG_RE.test(id) && !taken.has(id) && !read(id)) return id
      }
      throw new Error('no free document id')
    },
    save(meta, text) {
      writeJson(metaFile(meta.id), meta)
      if (text !== undefined) writeFileSync(textFile(meta.id), text, { encoding: 'utf8', mode: 0o600 })
    },
    dropText: (id) => rmSync(textFile(id), { force: true }),
  }
}
