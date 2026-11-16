// Files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md): the pure part of the picker and of the
// administrators' settings card. No React, no DOM besides Blob (fileToBase64). The server (BFF + business system) checks
// everything again; this only tells the employee early and builds `attachments: [{ name, mediaType, data }]` for the message.

export type AttachmentType = 'image' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'markdown' | 'text'
export const ATTACHMENT_TYPE_IDS: readonly AttachmentType[] = Object.freeze(['image', 'pdf', 'docx', 'xlsx', 'csv', 'markdown', 'text'])
export type AttachmentErrorCode =
  | 'too_many_files' | 'file_too_large' | 'total_too_large' | 'unsupported_type' | 'type_mismatch' | 'no_text'
  | 'attachments_not_allowed' | 'images_not_supported' | 'invalid_attachment' | 'attachment_prepare_failed'
export const ATTACHMENT_ERROR_CODES: readonly AttachmentErrorCode[] = Object.freeze([
  'too_many_files', 'file_too_large', 'total_too_large', 'unsupported_type', 'type_mismatch', 'no_text',
  'attachments_not_allowed', 'images_not_supported', 'invalid_attachment', 'attachment_prepare_failed',
])

export interface AttachmentLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
const MB = 1024 * 1024
/** The hard limits (D6): 5 files, 10 MB each, 20 MB together. */
export const ASSISTANT_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = Object.freeze({ maxFiles: 5, maxFileBytes: 10 * MB, maxTotalBytes: 20 * MB })

/** What the business system answers on GET /bridge/v1/assistant/attachment-settings (the employee's own). */
export interface AttachmentSettings { enabled: boolean; roles: string[]; types: AttachmentType[]; limits: AttachmentLimits }

// ext -> [type, canonical media type, other media types a browser / OS reports]
const FORMATS: Record<string, [AttachmentType, string, readonly string[]]> = {
  png: ['image', 'image/png', []],
  jpg: ['image', 'image/jpeg', ['image/jpg', 'image/pjpeg']],
  jpeg: ['image', 'image/jpeg', ['image/jpg', 'image/pjpeg']],
  webp: ['image', 'image/webp', []],
  gif: ['image', 'image/gif', []],
  pdf: ['pdf', 'application/pdf', ['application/x-pdf']],
  docx: ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', []],
  xlsx: ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', []],
  csv: ['csv', 'text/csv', ['application/vnd.ms-excel', 'application/csv', 'text/x-csv', 'text/comma-separated-values', 'text/plain']],
  md: ['markdown', 'text/markdown', ['text/x-markdown', 'text/plain']],
  markdown: ['markdown', 'text/markdown', ['text/x-markdown', 'text/plain']],
  txt: ['text', 'text/plain', []],
}
const GENERIC = ['', 'application/octet-stream', 'binary/octet-stream']

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The type of a file from its name (and media type): { type, mediaType } or an error code. */
export function attachmentTypeOf(name: string, mediaType = ''): { type: AttachmentType; mediaType: string } | { error: 'unsupported_type' | 'type_mismatch' } {
  const declared = String(mediaType).split(';')[0].trim().toLowerCase()
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name)
  let f = m ? FORMATS[m[1].toLowerCase()] : undefined
  if (!m) f = Object.values(FORMATS).find((x) => x[1] === declared)
  if (!f) return { error: 'unsupported_type' }
  if (!GENERIC.includes(declared) && declared !== f[1] && !f[2].includes(declared)) return { error: 'type_mismatch' }
  return { type: f[0], mediaType: f[1] }
}

/** The leading bytes agree with the type (images, PDF, docx / xlsx = ZIP, text = no NUL byte). */
export function sniffMatches(type: AttachmentType, mediaType: string, head: Uint8Array): boolean {
  const s = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b))
  switch (type) {
    case 'image':
      if (mediaType === 'image/png') return head.length >= 8 && head[0] === 0x89 && s(1, 4) === 'PNG'
      if (mediaType === 'image/jpeg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      if (mediaType === 'image/gif') return /^GIF8[79]a$/.test(s(0, 6))
      if (mediaType === 'image/webp') return s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP'
      return false
    case 'pdf': return s(0, Math.min(head.length, 1024)).includes('%PDF-')
    case 'docx': case 'xlsx': return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
    default: {
      if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true
      return !head.subarray(0, 8192).includes(0)
    }
  }
}

/** The browser `accept` attribute for the types. */
export function acceptFor(types: readonly AttachmentType[] = ATTACHMENT_TYPE_IDS): string {
  return Object.entries(FORMATS).filter(([, f]) => types.includes(f[0])).map(([ext]) => `.${ext}`).join(',')
}

/** The extensions shown for the types (".png .jpg …"). */
export function extensionsFor(types: readonly AttachmentType[] = ATTACHMENT_TYPE_IDS): string[] {
  return Object.entries(FORMATS).filter(([ext, f]) => types.includes(f[0]) && ext !== 'jpeg' && ext !== 'markdown').map(([ext]) => `.${ext}`)
}

/** The server's settings, normalized (null when attachments are not offered at all). Limits are clamped to the hard ones. */
export function normAttachmentSettings(raw: unknown): AttachmentSettings | null {
  if (!isRec(raw)) return null
  const types = (Array.isArray(raw.types) ? raw.types : []).filter((t): t is AttachmentType => ATTACHMENT_TYPE_IDS.includes(t as AttachmentType))
  const roles = (Array.isArray(raw.roles) ? raw.roles : []).filter((r): r is string => typeof r === 'string')
  const L = isRec(raw.limits) ? raw.limits : {}
  const lim = (k: keyof AttachmentLimits) => {
    const v = Number(L[k])
    return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), ASSISTANT_ATTACHMENT_LIMITS[k]) : ASSISTANT_ATTACHMENT_LIMITS[k]
  }
  return { enabled: raw.enabled === true && types.length > 0, roles, types, limits: { maxFiles: lim('maxFiles'), maxFileBytes: lim('maxFileBytes'), maxTotalBytes: lim('maxTotalBytes') } }
}

/** One attached file in the panel. `data` = base64 (no data: prefix); `previewUrl` = an object URL of an image (the host revokes it). */
export interface PickedAttachment { id: string; name: string; mediaType: string; type: AttachmentType; size: number; data: string; previewUrl?: string | null }
export interface PickCandidate { name: string; mediaType: string; size: number }
export interface PickError { code: AttachmentErrorCode; name?: string }

/**
 * Which of the new files may be added: in order, each is checked for type (and the allowed types), the model (images: false),
 * its size, the file count and the total. Returns the indexes to accept and one error per refused file.
 */
export function planAdd(
  current: readonly { size: number }[], incoming: readonly PickCandidate[],
  { limits = ASSISTANT_ATTACHMENT_LIMITS, types = ATTACHMENT_TYPE_IDS, images = null }: { limits?: AttachmentLimits; types?: readonly AttachmentType[]; images?: boolean | null } = {},
): { accept: { index: number; type: AttachmentType; mediaType: string }[]; errors: PickError[] } {
  const accept: { index: number; type: AttachmentType; mediaType: string }[] = []
  const errors: PickError[] = []
  let count = current.length
  let total = current.reduce((n, f) => n + f.size, 0)
  incoming.forEach((f, index) => {
    const t = attachmentTypeOf(f.name, f.mediaType)
    if ('error' in t) return void errors.push({ code: t.error, name: f.name })
    if (!types.includes(t.type)) return void errors.push({ code: 'unsupported_type', name: f.name })
    if (t.type === 'image' && images === false) return void errors.push({ code: 'images_not_supported', name: f.name })
    if (!(f.size > 0)) return void errors.push({ code: 'invalid_attachment', name: f.name })
    if (f.size > limits.maxFileBytes) return void errors.push({ code: 'file_too_large', name: f.name })
    if (count + 1 > limits.maxFiles) return void errors.push({ code: 'too_many_files', name: f.name })
    if (total + f.size > limits.maxTotalBytes) return void errors.push({ code: 'total_too_large', name: f.name })
    count += 1
    total += f.size
    accept.push({ index, type: t.type, mediaType: t.mediaType })
  })
  return { accept, errors }
}

/** A name for a pasted image without one: 貼り付けた画像-1.png */
export function pastedName(mediaType: string, n: number, base = '貼り付けた画像'): string {
  const ext = Object.entries(FORMATS).find(([, f]) => f[1] === mediaType)?.[0] ?? 'png'
  return `${base}-${n}.${ext}`
}

/** Bytes → base64 (chunked, no data: prefix). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A File / Blob → { data (base64), head (the first 8 KiB, for sniffMatches) }. */
export async function fileToBase64(file: Blob): Promise<{ data: string; head: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { data: bytesToBase64(bytes), head: bytes.subarray(0, 8192) }
}

/** '512 B', '12 KB', '1.5 MB' */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < MB) return `${Math.round(n / 1024)} KB`
  return `${(Math.round((n / MB) * 10) / 10).toFixed(1).replace(/\.0$/, '')} MB`
}

/** The message body part: [{ name, mediaType, data }]. */
export function toMessageAttachments(items: readonly PickedAttachment[]): { name: string; mediaType: string; data: string }[] {
  return items.map((x) => ({ name: x.name, mediaType: x.mediaType, data: x.data }))
}

/** The server's error envelope → an attachment error code (or null when it is another error). */
export function attachmentErrorOf(body: unknown): AttachmentErrorCode | null {
  const code = isRec(body) ? body.error : null
  return typeof code === 'string' && (ATTACHMENT_ERROR_CODES as readonly string[]).includes(code) ? code as AttachmentErrorCode : null
}

// ---------------------------------------------------------------------------------------------------- administrators' settings

export interface AttachmentAdminSettings { roles: string[]; types: AttachmentType[] }
export type AttachmentSettingsFetch = (url: string, init: { method: string; credentials: 'same-origin'; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
export interface AttachmentSettingsClient {
  get(): Promise<AttachmentAdminSettings & { limits?: AttachmentLimits }>
  save(body: AttachmentAdminSettings): Promise<AttachmentAdminSettings & { limits?: AttachmentLimits }>
}
export class AttachmentSettingsError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}

function normAdmin(raw: unknown): AttachmentAdminSettings & { limits?: AttachmentLimits } {
  const s = normAttachmentSettings({ ...(isRec(raw) ? raw : {}), enabled: true })
  if (!s) throw new AttachmentSettingsError(502, 'invalid_response')
  return { roles: s.roles, types: s.types, limits: s.limits }
}

/** GET / PUT the administrators' settings (default /bridge/v1/admin/assistant/attachment-settings, same origin, cookies). */
export function createAttachmentSettingsClient({ endpoint = '/bridge/v1/admin/assistant/attachment-settings', fetch: fetchImpl, headers = {} }: { endpoint?: string; fetch?: AttachmentSettingsFetch; headers?: Record<string, string> } = {}): AttachmentSettingsClient {
  const doFetch: AttachmentSettingsFetch = fetchImpl ?? (globalThis.fetch as unknown as AttachmentSettingsFetch)
  async function call(method: string, body?: unknown) {
    let res
    try {
      res = await doFetch(endpoint, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    } catch {
      throw new AttachmentSettingsError(0, 'network')
    }
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw new AttachmentSettingsError(res.status, isRec(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`)
    return normAdmin(json)
  }
  return { get: () => call('GET'), save: (body) => call('PUT', { roles: [...body.roles], types: [...body.types] }) }
}

export const sameAdminSettings = (a: AttachmentAdminSettings, b: AttachmentAdminSettings): boolean =>
  [...a.roles].sort().join('\n') === [...b.roles].sort().join('\n') && [...a.types].sort().join('\n') === [...b.types].sort().join('\n')
