// config.mjs — environment → gateway options, for a BFF that embeds @dsh-bridge/gateway.
//
// createDshGateway() itself takes plain options and reads no environment. These helpers turn the documented environment
// variables into those options, so that every BFF uses the same names:
//
//   DSH_URL                       DSH listener origin (default http://127.0.0.1:3180 when the gateway is enabled)
//   DSH_MOUNT_PATH                mount path in the BFF (default /dsh)
//   DSH_SUPERVISE=1               the BFF starts DSH itself (supervise) and reads its launch token from stdout
//   DSH_HOME                      DSH home of the supervised DSH (never the personal ~/.dsh)
//   DSH_PROFILE                   product profile name passed to `dsh --profile` (default bridge)
//   DSH_PUBLIC_URL                public URL of the mount (default <PUBLIC_ORIGIN>/dsh/)
//   PUBLIC_ORIGIN                 public origin of the BFF (default http://127.0.0.1:3010)
//   DSH_LAUNCH_LOG                file with DSH's launch output (fromFile)
//   DSH_LAUNCH_TOKEN              a launch token value (fromEnv)
//   DSH_PUBLIC_HOOK_PATHS         comma separated public webhook paths ('/dsh-hooks/line,/dsh-hooks/teams,/wecom-app-callback/*')
//   DSH_WECOM_APP_CALLBACK_URL    target of '/wecom-app-callback/*' (default: DSH_URL's host, port 30987)
//   BRIDGE_API_URL                the business API the BFF fronts (passed to a supervised DSH as BRIDGE_API_URL)
//   BRIDGE_BFF_SECRET             the BFF-only secret shared with the business API (x-bff-secret)
//   BRIDGE_DSH_WORKSPACE          workspace directory of a supervised DSH (default <DSH_HOME>/workspace)
//
// Legacy aliases (ケアビリング, the first user; read only when the new name is empty, documented in README):
//   CARE_API_URL → BRIDGE_API_URL, CARE_BFF_SECRET → BRIDGE_BFF_SECRET, CARE_DSH_WORKSPACE → BRIDGE_DSH_WORKSPACE.
import { fromEnv, fromFile, resolveDshBin, supervise } from './launch-token.mjs'

export const ENV_ALIASES = Object.freeze({
  BRIDGE_API_URL: Object.freeze(['CARE_API_URL']),
  BRIDGE_BFF_SECRET: Object.freeze(['CARE_BFF_SECRET']),
  BRIDGE_DSH_WORKSPACE: Object.freeze(['CARE_DSH_WORKSPACE']),
})

export const DEFAULT_DSH_URL = 'http://127.0.0.1:3180'
export const DEFAULT_PUBLIC_ORIGIN = 'http://127.0.0.1:3010'
export const DEFAULT_PROFILE = 'bridge'

/** WeCom self-built app callback (dsh-im wecom-app): its own listener, one path per bot (/wecom-app-callback/<botId>/<secret>). */
export const WECOM_APP_CALLBACK_PREFIX = '/wecom-app-callback/'
export const WECOM_APP_CALLBACK_PORT = 30987

/** An environment value by its documented name, then by its legacy aliases. '' when none is set. */
export function readEnv(env, name) {
  const source = env ?? process.env
  for (const key of [name, ...(ENV_ALIASES[name] ?? [])]) {
    const value = source[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim()
  }
  return ''
}

/**
 * DSH_PUBLIC_HOOK_PATHS entries → { publicPaths (exact POST: LINE / Teams), publicPrefixes ('/wecom-app-callback/*') }.
 * Only the WeCom callback prefix is accepted as a prefix; it goes to dsh-im's wecom-app listener (wecomAppCallbackUrl,
 * default the host of dshUrl on port 30987) for GET (URL verification) and POST (encrypted messages). dsh-im verifies.
 */
export function splitPublicHooks(entries, { dshUrl = '', wecomAppCallbackUrl = '' } = {}) {
  const publicPaths = []
  const publicPrefixes = []
  const list = typeof entries === 'string' ? entries.split(',') : (entries ?? [])
  for (const raw of list) {
    const entry = String(raw).trim()
    if (!entry) continue
    if (!entry.endsWith('/*')) { publicPaths.push(entry); continue }
    const prefix = entry.slice(0, -1)
    if (prefix !== WECOM_APP_CALLBACK_PREFIX) throw new Error(`unsupported public hook prefix ${JSON.stringify(entry)} (only ${WECOM_APP_CALLBACK_PREFIX}*)`)
    let target = wecomAppCallbackUrl
    if (!target) {
      const base = new URL(dshUrl || DEFAULT_DSH_URL)
      target = `${base.protocol}//${base.hostname}:${WECOM_APP_CALLBACK_PORT}` // hostname keeps the [] of an IPv6 address
    }
    publicPrefixes.push({ prefix, target, methods: ['GET', 'POST'] })
  }
  return { publicPaths, publicPrefixes }
}

/**
 * The launch token source described by the environment: DSH_LAUNCH_LOG (file) → DSH_SUPERVISE=1 (start DSH) →
 * DSH_LAUNCH_TOKEN (value). null when none is configured (the BFF answers /dsh with 503).
 * @param {object} [options]
 * @param {Record<string,string>} [options.childEnv]  extra environment for a supervised DSH (merged last)
 * @param {string[]} [options.extraArgs]              extra `dsh` arguments for a supervised DSH
 * @param {Function} [options.superviseImpl]          tests
 */
export function launchTokenFromEnv(env = process.env, { childEnv = {}, extraArgs = [], superviseImpl = supervise, logger } = {}) {
  const launchLog = readEnv(env, 'DSH_LAUNCH_LOG')
  if (launchLog) return { kind: 'file', launchToken: fromFile(launchLog) }
  if (readEnv(env, 'DSH_SUPERVISE') === '1') {
    const home = readEnv(env, 'DSH_HOME')
    if (!home) throw new Error('dsh-gateway: DSH_SUPERVISE=1 needs DSH_HOME (a product home, never the personal ~/.dsh)')
    const target = readEnv(env, 'DSH_URL') || DEFAULT_DSH_URL
    const port = new URL(target).port || '3180'
    const publicUrl = readEnv(env, 'DSH_PUBLIC_URL') || `${readEnv(env, 'PUBLIC_ORIGIN') || DEFAULT_PUBLIC_ORIGIN}${mountPathFromEnv(env)}/`
    const apiUrl = readEnv(env, 'BRIDGE_API_URL')
    const bin = resolveDshBin(env)
    if (!bin) throw new Error('dsh-gateway: DSH_SUPERVISE=1 but the dsh CLI was not found (set DSH_BIN or install @deepseek-ai/dsh globally)')
    const args = [bin, '--profile', readEnv(env, 'DSH_PROFILE') || DEFAULT_PROFILE, '--no-open', '--host', '127.0.0.1', '--port', port, '--public-url', publicUrl, ...extraArgs]
    const launchToken = superviseImpl({
      command: process.execPath,
      args,
      cwd: home,
      env: {
        DSH_HOME: home,
        DSH_AGENTS_HOME: `${home}/agents`,
        BRIDGE_DSH_WORKSPACE: readEnv(env, 'BRIDGE_DSH_WORKSPACE') || `${home}/workspace`,
        ...(apiUrl ? { BRIDGE_API_URL: apiUrl } : {}),
        ...childEnv,
      },
      ...(logger ? { logger } : {}),
    })
    return { kind: 'supervise', launchToken, args }
  }
  if (readEnv(env, 'DSH_LAUNCH_TOKEN')) return { kind: 'env', launchToken: fromEnv('DSH_LAUNCH_TOKEN', env) }
  return null
}

export function mountPathFromEnv(env = process.env) {
  const raw = readEnv(env, 'DSH_MOUNT_PATH') || '/dsh'
  return ('/' + raw.replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '/dsh')
}

/**
 * Environment → the createDshGateway options that come from configuration (target, mountPath, publicPaths, publicPrefixes,
 * launchToken) plus the BFF values (apiUrl, bffSecret). getSessionUser / isAllowed / rpcAllowlist stay code.
 * Returns null when the gateway is not configured (no DSH_URL, DSH_SUPERVISE=1, DSH_LAUNCH_LOG or DSH_LAUNCH_TOKEN).
 */
export function gatewayOptionsFromEnv(env = process.env, options = {}) {
  const dshUrl = readEnv(env, 'DSH_URL')
  const source = launchTokenFromEnv(env, options)
  if (!dshUrl && !source) return null
  const hooks = splitPublicHooks(readEnv(env, 'DSH_PUBLIC_HOOK_PATHS'), { dshUrl, wecomAppCallbackUrl: readEnv(env, 'DSH_WECOM_APP_CALLBACK_URL') })
  return {
    target: dshUrl || DEFAULT_DSH_URL,
    mountPath: mountPathFromEnv(env),
    publicPaths: hooks.publicPaths,
    publicPrefixes: hooks.publicPrefixes,
    launchToken: source?.launchToken ?? null,
    launchTokenKind: source?.kind ?? null,
    apiUrl: readEnv(env, 'BRIDGE_API_URL'),
    bffSecret: readEnv(env, 'BRIDGE_BFF_SECRET'),
  }
}
