/**
 * 构建脚本：用 Node 内置的 TypeScript 类型剥离（node:module.stripTypeScriptTypes）
 * 把 src/*.ts 编译成 lib/*.js（ESM）。零外部依赖，适合 DSH 预览版环境。
 *
 * 用法：npm run build
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 宿主侧：仅类型剥离（保持零依赖、产物与手写一致）。
const STRIP = ['index', 'mail', 'backends', 'config-schema', 'i18n', 'runs']

await mkdir(join(root, 'lib'), { recursive: true })
for (const name of STRIP) {
  const code = await readFile(join(root, 'src', `${name}.ts`), 'utf8')
  const out = stripTypeScriptTypes(code, { mode: 'strip' })
  await writeFile(join(root, 'lib', `${name}.js`), out, 'utf8')
  console.log(`built lib/${name}.js`)
}

// 客户端：esbuild 打包成单文件 ModuleLoader bundle（react 由宿主注入）。
// 沙箱禁止 spawn 时回退到类型剥离，保证 CI 仍可构建（只是不打包）。
try {
  await build({
    entryPoints: [join(root, 'src', 'client.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    external: ['react'],
    outfile: join(root, 'lib', 'client.js'),
    logLevel: 'silent',
    banner: { js: '/* @care/dsh-auto-tasks client — built by esbuild */' },
  })
  console.log('built lib/client.js (esbuild)')
} catch (error) {
  console.warn(`esbuild unavailable (${error?.message ?? error}); falling back to strip-only build`)
  const code = await readFile(join(root, 'src', 'client.ts'), 'utf8')
  await writeFile(join(root, 'lib', 'client.js'), stripTypeScriptTypes(code, { mode: 'strip' }), 'utf8')
  console.log('built lib/client.js (strip fallback)')
}
