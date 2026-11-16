// The AI employee's profile (docs/AI_EMPLOYEE_PROFILE.md; optional Bridge v1 capability):
//
//   GET  /bridge/v1/ai-profile                                    service      current profile, etag from the version, 304
//   GET  /bridge/v1/admin/ai-profile                              admins       profile + versions (newest first, ≤ 20)
//   PUT  /bridge/v1/admin/ai-profile                              admins       { profile, reason? } → validateAiProfile → new version
//   POST /bridge/v1/admin/ai-profile/versions/{version}/restore   admins       { reason? } → that content as a new version
//
// The profile is text only (it never changes rules, permissions or tools). Saving runs validateAiProfile of @dsh-bridge/protocol:
// wording that would lift the rules (D4) and personal data are refused (422 invalid_profile, details.errors: field / code / kinds,
// never the matched text). Each save is a new version and audited as ai_profile.updated with the version number only.
import { validateAiProfile } from '@dsh-bridge/protocol'
import { POLICY } from '../gate.mjs'
import { baseHeaders, fail, iso, isObject, strictKeys } from '../http.mjs'
import { etagMatches } from '../manifest.mjs'
import { StoreConflict } from '../store/errors.mjs'

export const AI_PROFILE_REASON_MAX = 200
export const AI_PROFILE_VERSIONS_SHOWN = 20

/** Strong etag of a version (0 = no profile yet). */
export const aiProfileEtag = (version) => `"ai-profile-${Number(version) || 0}"`

const versionJson = (v) => ({ version: v.version, updatedAt: iso(v.createdAt), updatedBy: v.updatedBy ?? null, reason: v.reason ?? null })

function readReason(b) {
  if (b.reason === undefined || b.reason === null) return null
  if (typeof b.reason !== 'string' || b.reason.length > AI_PROFILE_REASON_MAX) fail(400, 'invalid_value', undefined, { field: 'reason' })
  return b.reason.replace(/\s+/g, ' ').trim() || null
}

/** validateAiProfile → the normalised profile, or 422 invalid_profile with the errors (field / code / kinds only). */
function checked(input) {
  const r = validateAiProfile(input)
  if (!r.ok) fail(422, 'invalid_profile', undefined, { errors: r.errors.map((e) => ({ field: e.field, code: e.code, ...(e.kinds ? { kinds: e.kinds } : {}) })) })
  return r.profile
}

export function registerAiProfile(router, kit) {
  const { store } = kit
  const ADMIN = { allow: ['user'], roles: kit.roles.admins }

  /** A new version in one transaction with its audit row (a concurrent save of the same version: retried). */
  async function save(profile, { actor, reason, restoredFrom = null }) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await store.tx(async (t) => {
          const row = await t.insertAiProfileVersion({ profile, updatedBy: actor, reason })
          await t.audit({ actor, action: 'ai_profile.updated', target: String(row.version), detail: { version: row.version, ...(restoredFrom ? { restoredFrom } : {}) } })
          return row
        })
      } catch (error) {
        if (!(error instanceof StoreConflict) || attempt >= 3) throw error
      }
    }
  }

  router.add('GET', '/bridge/v1/ai-profile', POLICY.SERVICE, async ({ req, res }) => {
    const current = await store.latestAiProfile()
    const etag = aiProfileEtag(current?.version)
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, baseHeaders({ etag }))
      res.end()
      return null
    }
    return {
      status: 200,
      headers: { etag },
      body: { ok: true, profile: current?.profile ?? null, version: current?.version ?? null, updatedAt: iso(current?.createdAt) },
    }
  })

  router.add('GET', '/bridge/v1/admin/ai-profile', ADMIN, async () => {
    const current = await store.latestAiProfile()
    const versions = await store.listAiProfileVersions({ limit: AI_PROFILE_VERSIONS_SHOWN })
    return {
      status: 200,
      body: {
        ok: true,
        profile: current?.profile ?? null,
        version: current?.version ?? null,
        updatedAt: iso(current?.createdAt),
        updatedBy: current?.updatedBy ?? null,
        versions: versions.map(versionJson),
      },
    }
  })

  router.add('PUT', '/bridge/v1/admin/ai-profile', ADMIN, async ({ principal, body }) => {
    const b = body ?? {}
    strictKeys(b, ['profile', 'reason'])
    if (b.profile === undefined || b.profile === null) fail(400, 'required', undefined, { field: 'profile' })
    if (!isObject(b.profile)) fail(400, 'invalid_value', undefined, { field: 'profile' })
    const reason = readReason(b)
    const row = await save(checked(b.profile), { actor: principal.user.id, reason })
    return { status: 200, body: { ok: true, version: row.version } }
  })

  router.add('POST', '/bridge/v1/admin/ai-profile/versions/:version/restore', ADMIN, async ({ principal, params, body }) => {
    const b = body ?? {}
    strictKeys(b, ['reason'])
    const reason = readReason(b)
    if (!/^[1-9][0-9]{0,8}$/.test(params.version)) fail(404, 'version_not_found')
    const old = await store.getAiProfileVersion(Number(params.version))
    if (!old) fail(404, 'version_not_found')
    const row = await save(checked(old.profile), { actor: principal.user.id, reason, restoredFrom: old.version })
    return { status: 200, body: { ok: true, version: row.version } }
  })
}
