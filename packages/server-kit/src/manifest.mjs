// The business manifest: loaded from a file (or given as an object), validated at start-up (fail fast), served with an etag.
import { loadManifestFile, validateManifest } from '@dsh-bridge/protocol'
import { sha256 } from './crypto.mjs'

/**
 * loadManifest({ file } | { manifest }) -> { manifest, json, etag, warnings }
 * Throws with every validation error when the manifest is invalid: a system never serves a broken manifest.
 */
export function loadManifest({ file, manifest } = {}) {
  if (!file && !manifest) throw new TypeError('loadManifest: { file } or { manifest } is required')
  const value = manifest ?? loadManifestFile(file)
  const result = validateManifest(value)
  if (!result.valid) {
    throw new Error(`invalid manifest ${file ?? '(object)'}:\n  ${result.errors.map((e) => `${e.path}: ${e.message}`).join('\n  ')}`)
  }
  const json = JSON.stringify(value)
  return { manifest: value, json, etag: `"${sha256(json).slice(0, 32)}"`, warnings: result.warnings ?? [] }
}

/** If-None-Match: a list of (weak or strong) etags or "*" (RFC 9110 weak comparison). */
export function etagMatches(headerValue, etag) {
  if (!headerValue || !etag) return false
  const strip = (t) => t.trim().replace(/^W\//, '')
  return String(headerValue).split(',').some((t) => strip(t) === '*' || strip(t) === strip(etag))
}

/** Event types that are notified to people (deterministic IM notifications): declared `notify`, not internal / deprecated. */
export function notifiableTypes(manifest) {
  return Object.entries(manifest.events ?? {}).filter(([, e]) => e.notify && !e.internal && !e.deprecated).map(([type]) => type)
}

/**
 * The AI allow-list derived from the manifest tools: { 'GET /api/equipment': ['admin', 'manager', 'inspector'] }.
 * Only `read` tools: a delegation never writes (proposals go through POST /bridge/v1/proposals).
 */
export function aiAllowlist(manifest) {
  const out = {}
  for (const t of manifest.tools ?? []) if (t.access === 'read' && typeof t.http === 'string') out[t.http] = [...(t.roles ?? [])]
  return out
}

/** Declared roles of the manifest (in order). */
export const manifestRoles = (manifest) => Object.keys(manifest.roles ?? {})

/** The single report kind of the manifest, or the one named. -> { kind, ...declaration } | null */
export function reportDecl(manifest, kind) {
  const entries = Object.entries(manifest.reports ?? {})
  const found = kind ? entries.find(([k]) => k === kind) : entries[0]
  return found ? { kind: found[0], ...found[1] } : null
}

/** "30 8 * * *" -> "08:30" (minute hour only; the kit's scheduler runs daily slots). */
export function cronToSlot(cron) {
  const [min, hour] = String(cron).trim().split(/\s+/)
  if (!/^\d{1,2}$/.test(min ?? '') || !/^\d{1,2}$/.test(hour ?? '')) throw new Error(`unsupported cron "${cron}" (only "M H * * *")`)
  return `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
}
