// Environment → gateway options: documented names, legacy CARE_* aliases, public hooks, launch token sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_ALIASES, gatewayOptionsFromEnv, launchTokenFromEnv, mountPathFromEnv, readEnv, splitPublicHooks } from '../src/index.mjs'

test('readEnv: the documented name first, then the legacy CARE_* alias; blank values do not count', () => {
  assert.deepEqual(ENV_ALIASES.BRIDGE_API_URL, ['CARE_API_URL'])
  assert.equal(readEnv({ BRIDGE_API_URL: 'http://new', CARE_API_URL: 'http://old' }, 'BRIDGE_API_URL'), 'http://new')
  assert.equal(readEnv({ BRIDGE_API_URL: ' ', CARE_API_URL: 'http://old' }, 'BRIDGE_API_URL'), 'http://old')
  assert.equal(readEnv({ CARE_BFF_SECRET: 's' }, 'BRIDGE_BFF_SECRET'), 's')
  assert.equal(readEnv({ CARE_DSH_WORKSPACE: '/w' }, 'BRIDGE_DSH_WORKSPACE'), '/w')
  assert.equal(readEnv({}, 'DSH_URL'), '')
})

test('splitPublicHooks: exact paths and the WeCom callback prefix only', () => {
  const r = splitPublicHooks('/dsh-hooks/line, /dsh-hooks/teams,/wecom-app-callback/*', { dshUrl: 'http://127.0.0.1:3180' })
  assert.deepEqual(r.publicPaths, ['/dsh-hooks/line', '/dsh-hooks/teams'])
  assert.deepEqual(r.publicPrefixes, [{ prefix: '/wecom-app-callback/', target: 'http://127.0.0.1:30987', methods: ['GET', 'POST'] }])
  assert.equal(splitPublicHooks(['/wecom-app-callback/*'], { dshUrl: 'http://[::1]:3180' }).publicPrefixes[0].target, 'http://[::1]:30987')
  assert.equal(splitPublicHooks(['/wecom-app-callback/*'], { wecomAppCallbackUrl: 'http://10.0.0.2:4000' }).publicPrefixes[0].target, 'http://10.0.0.2:4000')
  assert.throws(() => splitPublicHooks(['/other/*']), /unsupported public hook prefix/)
})

test('gatewayOptionsFromEnv: null when not configured; DSH_URL + hooks + mount', () => {
  assert.equal(gatewayOptionsFromEnv({}), null)
  const o = gatewayOptionsFromEnv({ DSH_URL: 'http://127.0.0.1:3181', DSH_PUBLIC_HOOK_PATHS: '/dsh-hooks/line', DSH_MOUNT_PATH: 'ai/', CARE_API_URL: 'http://api', CARE_BFF_SECRET: 'b' })
  assert.equal(o.target, 'http://127.0.0.1:3181')
  assert.equal(o.mountPath, '/ai')
  assert.deepEqual(o.publicPaths, ['/dsh-hooks/line'])
  assert.deepEqual([o.apiUrl, o.bffSecret, o.launchToken, o.launchTokenKind], ['http://api', 'b', null, null])
  assert.equal(mountPathFromEnv({}), '/dsh')
  assert.equal(mountPathFromEnv({ DSH_MOUNT_PATH: '/' }), '/dsh')
})

test('launch token sources: DSH_LAUNCH_LOG, then DSH_SUPERVISE=1, then DSH_LAUNCH_TOKEN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-config-'))
  try {
    const log = join(dir, 'dsh.log')
    writeFileSync(log, 'dsh web: http://127.0.0.1:3180/?token=abcdefghijklmnopqrstuvwx\n')
    const file = launchTokenFromEnv({ DSH_LAUNCH_LOG: log, DSH_LAUNCH_TOKEN: 'zzzzzzzzzzzzzzzzzzzzzzzz' })
    assert.equal(file.kind, 'file')
    assert.equal(await file.launchToken(), 'abcdefghijklmnopqrstuvwx')
    const env = launchTokenFromEnv({ DSH_LAUNCH_TOKEN: 'http://127.0.0.1:3180/?token=zyxwvutsrqponmlkjihgfedc' })
    assert.equal(env.kind, 'env')
    assert.equal(await env.launchToken(), 'zyxwvutsrqponmlkjihgfedc')
    assert.equal(launchTokenFromEnv({}), null)

    assert.throws(() => launchTokenFromEnv({ DSH_SUPERVISE: '1' }), /needs DSH_HOME/)
    let seen = null
    const sup = launchTokenFromEnv(
      { DSH_SUPERVISE: '1', DSH_HOME: dir, DSH_BIN: process.execPath, DSH_URL: 'http://127.0.0.1:3185', CARE_API_URL: 'http://api', PUBLIC_ORIGIN: 'https://biz.example.com' },
      { superviseImpl: (opts) => { seen = opts; return async () => 'tok' }, childEnv: { EXTRA: '1' } },
    )
    assert.equal(sup.kind, 'supervise')
    assert.deepEqual(seen.args.slice(1), ['--profile', 'bridge', '--no-open', '--host', '127.0.0.1', '--port', '3185', '--public-url', 'https://biz.example.com/dsh/'])
    assert.equal(seen.cwd, dir)
    assert.deepEqual(seen.env, { DSH_HOME: dir, DSH_AGENTS_HOME: `${dir}/agents`, BRIDGE_DSH_WORKSPACE: `${dir}/workspace`, BRIDGE_API_URL: 'http://api', EXTRA: '1' })
    const named = launchTokenFromEnv({ DSH_SUPERVISE: '1', DSH_HOME: dir, DSH_BIN: process.execPath, DSH_PROFILE: 'my-product' }, { superviseImpl: (opts) => { seen = opts; return async () => 't' } })
    assert.equal(named.args[2], 'my-product')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
