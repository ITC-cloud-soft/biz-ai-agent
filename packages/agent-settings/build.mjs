#!/usr/bin/env node
// Builds the settings app (web/) into dist/ (app.js + chunks + app.css), served by the plugin at /agent-settings/assets/.
//   node build.mjs                       BIZ_AI_FRAMEWORK = another framework checkout (default: this repository, where it is synced in)
//                                        DSH_IM_JA = a Japanese language pack for dsh-im (default: care-ai-native's dsh-lang-ja, if present)
// The framework is needed at BUILD time only: web-kit (packages/web-kit/src) and dsh-im's settings components
// (vendor/dsh-im/plugin-src/client) are bundled; a system that serves dist/ needs neither.
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const FRAMEWORK = resolve(process.env.BIZ_AI_FRAMEWORK || join(here, '..', '..'))
const CLIENT = join(FRAMEWORK, 'vendor', 'dsh-im', 'plugin-src', 'client')
const WEB_KIT = join(FRAMEWORK, 'packages', 'web-kit', 'src')
for (const p of [CLIENT, WEB_KIT]) if (!existsSync(p)) { console.error(`not found: ${p} (set BIZ_AI_FRAMEWORK)`); process.exit(2) }
const JA = process.env.DSH_IM_JA || join(FRAMEWORK, '..', 'care-ai-native', 'plugins', 'dsh-lang-ja', 'locales', 'ja', 'dsh-im.json')
const require = createRequire(import.meta.url)
const one = (name) => dirname(require.resolve(`${name}/package.json`)) // ONE React for the app, web-kit and the vendor components

const resolvePlugin = {
  name: 'agent-settings-resolve',
  setup(b) {
    b.onResolve({ filter: /^@dsh-im-client\// }, (a) => ({ path: join(CLIENT, a.path.slice('@dsh-im-client/'.length)) }))
    b.onResolve({ filter: /^@dsh-im-ja-dict$/ }, () => (existsSync(JA) ? { path: JA } : { path: 'empty-ja', namespace: 'empty' }))
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '{}', loader: 'json' }))
    b.onResolve({ filter: /^@dsh-bridge\/web-kit$/ }, () => ({ path: join(WEB_KIT, 'index.ts') }))
    b.onResolve({ filter: /^@dsh-bridge\/web-kit\/styles\.css$/ }, () => ({ path: join(WEB_KIT, 'styles.css') }))
    b.onResolve({ filter: /^@dsh-bridge\/web-kit\/im-theme\.css$/ }, () => ({ path: join(WEB_KIT, 'im', 'im-theme.css') }))
  },
}

const outdir = join(here, 'dist')
rmSync(outdir, { recursive: true, force: true })
const result = await esbuild.build({
  entryPoints: { app: join(here, 'web', 'main.tsx') },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome110', 'safari16', 'firefox110'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'linked',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.json': 'json' },
  alias: { react: one('react'), 'react-dom': one('react-dom'), 'react/jsx-runtime': join(one('react'), 'jsx-runtime.js') },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [resolvePlugin],
  metafile: true,
  logLevel: 'warning',
})
const outputs = Object.entries(result.metafile.outputs).map(([f, o]) => [f.replace(/\\/g, '/').split('/dist/')[1], o.bytes])
const total = outputs.reduce((a, [, n]) => a + n, 0)
console.log(`built ${outputs.length} file(s), ${(total / 1024).toFixed(0)} KB → dist/ (ja pack: ${existsSync(JA) ? 'yes' : 'no'})`)
