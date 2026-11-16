// Files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md; optional Bridge v1 capability):
//
//   POST /bridge/v1/assistant/attachments/prepare       employee session + BFF secret   check the files, convert the documents
//   GET  /bridge/v1/assistant/attachment-settings       employee session                may I attach? which types, which limits
//   GET  /bridge/v1/admin/assistant/attachment-settings admins                          roles / types
//   PUT  /bridge/v1/admin/assistant/attachment-settings admins                          { roles, types }
//
// The BFF sends documents with their data (base64) and images without it (only the name / type / size are checked here; the
// image bytes go from the BFF to DSH). Documents are converted in memory (@dsh-bridge/server-kit/extract) and never stored.
// The audit row `assistant.attachments` keeps the employee, the count, the count per type and the total size: never a file name
// or any content.
import { POLICY } from '../gate.mjs'
import { fail, isObject, strictKeys } from '../http.mjs'
import {
  ATTACHMENT_LIMITS, ATTACHMENT_TYPES, DEFAULT_ATTACHMENT_ROLES, attachmentSummary, prepareAttachments, resolveLimits,
} from '../extract/index.mjs'

/** The default roles within the manifest's roles (the first declared role when none of them is declared). */
export function defaultAttachmentRoles(declaredRoles, wanted = DEFAULT_ATTACHMENT_ROLES) {
  const declared = Array.isArray(declaredRoles) ? declaredRoles : []
  if (!declared.length) return [...wanted]
  const inter = wanted.filter((r) => declared.includes(r))
  return inter.length ? inter : declared.includes('admin') ? ['admin'] : declared.slice(0, 1)
}

export function registerAssistantAttachments(router, kit, options = {}) {
  const { store } = kit
  const ADMIN = { allow: ['user'], roles: kit.roles.admins }
  const limits = resolveLimits(options.limits ?? {})
  const declared = kit.declaredRoles ?? []
  const defaults = { roles: defaultAttachmentRoles(declared, options.defaultRoles ?? DEFAULT_ATTACHMENT_ROLES), types: [...ATTACHMENT_TYPES] }
  // a JSON body with every file as base64 (4/3 of the bytes) plus the names and the envelope
  const maxBodyBytes = Math.ceil((limits.maxTotalBytes * 4) / 3) + 256 * 1024
  const publicLimits = { maxFiles: limits.maxFiles, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes, maxCharsPerFile: limits.maxCharsPerFile, maxCharsTotal: limits.maxCharsTotal }

  async function current() {
    const row = await store.getAttachmentSettings()
    if (!row) return { ...defaults, updatedBy: null, updatedAt: null, saved: false }
    return {
      roles: (Array.isArray(row.roles) ? row.roles : []).filter((r) => typeof r === 'string'),
      types: (Array.isArray(row.types) ? row.types : []).filter((t) => ATTACHMENT_TYPES.includes(t)),
      updatedBy: row.updatedBy ?? null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      saved: true,
    }
  }
  const allowedFor = (s, user) => s.roles.includes(user.role) && s.types.length > 0

  router.add('GET', '/bridge/v1/assistant/attachment-settings', POLICY.USER, async ({ principal }) => {
    const s = await current()
    return { status: 200, body: { ok: true, enabled: allowedFor(s, principal.user), roles: s.roles, types: s.types, limits: publicLimits } }
  })

  router.add('POST', '/bridge/v1/assistant/attachments/prepare', POLICY.BFF, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['files'])
    if (!Array.isArray(b.files)) fail(400, 'required', undefined, { field: 'files' })
    const s = await current()
    const actor = principal.user.id
    if (!allowedFor(s, principal.user)) {
      await store.audit({ actor, action: 'assistant.attachments', detail: { ok: false, error: 'attachments_not_allowed', count: b.files.length } })
      fail(403, 'attachments_not_allowed')
    }
    for (const [index, f] of b.files.entries()) {
      if (!isObject(f)) fail(422, 'invalid_attachment', undefined, { index, reason: 'shape' })
      for (const k of Object.keys(f)) if (!['name', 'mediaType', 'size', 'data'].includes(k)) fail(422, 'invalid_attachment', undefined, { index, reason: 'unknown_field' })
    }
    const r = await prepareAttachments(b.files, {
      limits, settings: { types: s.types, ...(options.ocr === false ? { ocr: false } : {}) },
      ...(options.pdfText !== undefined ? { pdfText: options.pdfText } : {}),
      ...(typeof options.ocr === 'function' ? { ocr: options.ocr } : {}),
    })
    if (!r.ok) {
      await store.audit({ actor, action: 'assistant.attachments', detail: { ok: false, error: r.error, count: b.files.length } })
      fail(r.error === 'attachments_not_allowed' ? 403 : 422, r.error, undefined, r.details)
    }
    const summary = r.summary ?? attachmentSummary([])
    await store.audit({ actor, action: 'assistant.attachments', detail: { ok: true, count: summary.count, types: summary.types, totalBytes: summary.totalBytes } })
    return { status: 200, body: { ok: true, documents: r.documents, images: r.images } }
  }, { maxBodyBytes })

  const adminJson = (s) => ({ ok: true, roles: s.roles, types: s.types, limits: publicLimits, updatedBy: s.updatedBy, updatedAt: s.updatedAt })

  router.add('GET', '/bridge/v1/admin/assistant/attachment-settings', ADMIN, async () => ({ status: 200, body: adminJson(await current()) }))

  router.add('PUT', '/bridge/v1/admin/assistant/attachment-settings', ADMIN, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['roles', 'types'])
    if (b.roles === undefined) fail(400, 'required', undefined, { field: 'roles' })
    if (b.types === undefined) fail(400, 'required', undefined, { field: 'types' })
    const roleOk = (r) => typeof r === 'string' && r.length > 0 && r.length <= 64 && (!declared.length || declared.includes(r))
    if (!Array.isArray(b.roles) || b.roles.length > 50 || !b.roles.every(roleOk)) fail(400, 'invalid_value', undefined, { field: 'roles' })
    if (!Array.isArray(b.types) || !b.types.every((t) => ATTACHMENT_TYPES.includes(t))) fail(400, 'invalid_value', undefined, { field: 'types' })
    const roles = [...new Set(b.roles)]
    const types = ATTACHMENT_TYPES.filter((t) => b.types.includes(t))
    const actor = principal.user.id
    await store.tx(async (t) => {
      await t.putAttachmentSettings({ roles, types, updatedBy: actor })
      await t.audit({ actor, action: 'assistant.attachment_settings.updated', detail: { roles, types } })
    })
    return { status: 200, body: adminJson(await current()) }
  })
}
