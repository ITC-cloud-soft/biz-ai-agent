// The settings screen: an HTML shell for the React app in dist/ (built from web/ by build.mjs), and its assets.
// The shell carries the page's configuration as inline JSON (type="application/json": data, not script) — the language, the
// declared roles, the system's name, the administrator's id and role, and whether a DSH gateway is there for the IM bot pages.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const LANGS = ['ja', 'en', 'zh']
const TITLES = { ja: 'AI エージェントの設定', en: 'AI agent settings', zh: 'AI 代理设置' }
const ME_TITLES = { ja: 'SNS 連携', en: 'SNS link', zh: 'SNS 连携' }
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

export function pickLang(lang, acceptLanguage) {
  if (LANGS.includes(lang)) return lang
  for (const part of String(acceptLanguage ?? '').toLowerCase().split(',')) {
    const code = part.trim().slice(0, 2)
    if (LANGS.includes(code)) return code
  }
  return 'ja'
}

/** No external resource: scripts and styles from this origin only (the vendor components set inline style attributes). */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

// < > & escaped so the JSON can never close its <script> element
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

/** mode 'admin' (the settings, /agent-settings) or 'me' (the employee's own SNS link page, /me/sns). */
export function settingsShell({ lang, acceptLanguage, roles = [], system = {}, user = null, gateway = null, mode = 'admin', isAdmin = false, notifyTypes = [] } = {}) {
  const l = pickLang(lang, acceptLanguage)
  const built = existsSync(join(DIST, 'app.js'))
  const v = built ? Math.round(statSync(join(DIST, 'app.js')).mtimeMs).toString(36) : '' // a new build is never served from a cache
  const cfg = { lang: l, mode: mode === 'me' ? 'me' : 'admin', isAdmin: Boolean(isAdmin), roles, system: { name: String(system.name ?? '') }, user: user ? { id: String(user.id), role: String(user.role) } : null, gateway, notifyTypes }
  return `<!doctype html>
<html lang="${l === 'zh' ? 'zh-CN' : l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${(mode === 'me' ? ME_TITLES : TITLES)[l]}</title><meta name="color-scheme" content="light dark">
${built ? `<link rel="stylesheet" href="/agent-settings/assets/app.css?v=${v}"><script type="module" src="/agent-settings/assets/app.js?v=${v}"></script>` : ''}
<script type="application/json" id="agent-settings-config">${safeJson(cfg)}</script>
</head><body><div id="root">${built ? '' : '<p style="font:14px system-ui;padding:24px">The settings app is not built: run <code>npm run build -w @dsh-bridge/agent-settings</code>.</p>'}</div></body></html>`
}

/** A file of dist/ (app.js, app.css, chunks/…), or null. Never leaves dist/. */
export function asset(relPath) {
  const rel = String(relPath ?? '')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(rel) || rel.includes('..')) return null
  const p = resolve(DIST, rel)
  if (!p.startsWith(resolve(DIST)) || !existsSync(p)) return null
  return { body: readFileSync(p), type: TYPES[extname(p)] ?? 'application/octet-stream' }
}
