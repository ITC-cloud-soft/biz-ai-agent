// A sign-in page in the settings screen's look (the same tokens, brand mark, light and dark), for the business system's OWN
// login: the page posts { loginId, password } to the system's endpoint and never sees a session. The plugin has no login of its
// own; a system that already has a sign-in screen keeps it. One small inline script, allowed by a per-response nonce.
import { randomBytes } from 'node:crypto'
import { pickLang } from './screen.mjs'

const S = {
  ja: {
    title: 'サインイン', heading: 'サインイン', lead: '{system} のアカウントでサインインしてください。', loginId: 'ログイン ID', password: 'パスワード',
    show: '表示', hide: '隠す', submit: 'サインイン', busy: '確認しています…',
    bad: 'ログイン ID またはパスワードが違います。', locked: '失敗が続いたため、しばらく受け付けません。10 分ほどしてからお試しください。',
    failed: 'サインインできませんでした（{status}）。時間をおいてお試しください。', offline: 'サーバーに接続できません。',
    note: 'パスワードは {system} が確認します。AI エージェントがパスワードを見ることはありません。', product: 'AI エージェント',
  },
  en: {
    title: 'Sign in', heading: 'Sign in', lead: 'Sign in with your {system} account.', loginId: 'Login ID', password: 'Password',
    show: 'Show', hide: 'Hide', submit: 'Sign in', busy: 'Checking…',
    bad: 'The login ID or password is wrong.', locked: 'Too many failed attempts. Try again in about 10 minutes.',
    failed: 'Could not sign in ({status}). Try again later.', offline: 'Cannot reach the server.',
    note: '{system} checks your password. The AI agent never sees it.', product: 'AI agent',
  },
  zh: {
    title: '登录', heading: '登录', lead: '请使用 {system} 的账号登录。', loginId: '登录 ID', password: '密码',
    show: '显示', hide: '隐藏', submit: '登录', busy: '正在确认…',
    bad: '登录 ID 或密码不正确。', locked: '失败次数过多，请约 10 分钟后再试。',
    failed: '无法登录（{status}），请稍后再试。', offline: '无法连接服务器。',
    note: '密码由 {system} 确认，AI 代理不会看到密码。', product: 'AI 代理',
  },
}
const LANG_NAMES = { ja: '日本語', en: 'English', zh: '中文' }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
/** Only a path on this site (no scheme, no //host, no backslash): never an open redirect. */
export const safeNext = (next, fallback = '/agent-settings') => (/^\/(?![/\\])[A-Za-z0-9/_?=&.#%-]*$/.test(String(next ?? '')) ? String(next) : fallback)

const STYLE = `
:root{--t:#0f172a;--t2:#475569;--t3:#64748b;--bg:#f4f6fa;--sf:#fff;--sf2:#f1f4f9;--bd:#e3e8ef;--bd2:#cbd5e1;--p:#4f46e5;--ph:#4338ca;--op:#fff;--dg:#c2410c;--dgs:#fff1ec;--ring:0 0 0 3px rgb(79 70 229/.18);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--t:#e6e9f0;--t2:#b5bdcc;--t3:#8b95a7;--bg:#0b0f17;--sf:#121826;--sf2:#182033;--bd:#222b3d;--bd2:#33405a;--p:#8b8cf8;--ph:#a5a6fb;--op:#0b0f17;--dg:#fb923c;--dgs:#2d1710;--ring:0 0 0 3px rgb(139 140 248/.28)}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg)}
body{font:14px/1.55 "Inter",system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP","Noto Sans SC","Microsoft YaHei",sans-serif;color:var(--t);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;min-height:100vh;
 background:radial-gradient(1200px 600px at 10% -10%,color-mix(in srgb,var(--p) 12%,transparent),transparent 60%),radial-gradient(900px 500px at 110% 110%,color-mix(in srgb,#ec4899 9%,transparent),transparent 60%),var(--bg)}
.top{display:flex;justify-content:flex-end;padding:16px}
.lang{display:flex;gap:2px;padding:3px;border-radius:9px;background:var(--sf2);border:1px solid var(--bd)}
.lang a{font-size:12px;padding:5px 9px;border-radius:7px;color:var(--t2);text-decoration:none;white-space:nowrap}
.lang a[aria-current=true]{background:var(--sf);color:var(--t);font-weight:600;box-shadow:0 1px 2px rgb(15 23 42/.08)}
.lang a:focus-visible{outline:none;box-shadow:var(--ring)}
main{flex:1;display:grid;place-items:center;padding:8px 16px 48px}
.card{width:100%;max-width:400px;background:var(--sf);border:1px solid var(--bd);border-radius:16px;padding:32px 28px 26px;box-shadow:0 1px 2px rgb(15 23 42/.04),0 12px 32px -12px rgb(15 23 42/.18)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:24px}
.mark{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 55%,#ec4899 120%);box-shadow:0 6px 16px -6px rgb(99 102 241/.7);flex:none}
.tx b{display:block;font-size:15px;letter-spacing:-.01em}.tx span{display:block;font-size:12px;color:var(--t3)}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.02em}.lead{margin:0 0 22px;color:var(--t2)}
form{display:flex;flex-direction:column;gap:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:12.5px;font-weight:600;color:var(--t2)}
.in{position:relative;display:flex}
input{width:100%;font:inherit;font-size:14px;color:var(--t);background:var(--sf);border:1px solid var(--bd2);border-radius:10px;padding:10px 12px;transition:border-color .12s,box-shadow .12s}
input:focus{outline:none;border-color:var(--p);box-shadow:var(--ring)}
.in input{padding-right:64px}
.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);font:inherit;font-size:12px;font-weight:600;border:0;background:transparent;color:var(--p);padding:6px 8px;border-radius:7px;cursor:pointer}
.eye:focus-visible{outline:none;box-shadow:var(--ring)}
.go{margin-top:6px;display:flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;font-size:14px;padding:11px 14px;border-radius:10px;border:1px solid var(--p);background:var(--p);color:var(--op);cursor:pointer;box-shadow:0 1px 2px rgb(79 70 229/.25);transition:background .12s}
.go:hover:not(:disabled){background:var(--ph)}.go:focus-visible{outline:none;box-shadow:var(--ring)}.go:disabled{opacity:.7;cursor:default}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:s .7s linear infinite;display:none}
.go[aria-busy=true] .spin{display:inline-block}@keyframes s{to{transform:rotate(360deg)}}
.err{display:none;align-items:flex-start;gap:9px;padding:10px 12px;border-radius:10px;background:var(--dgs);color:var(--t);border:1px solid color-mix(in srgb,var(--dg) 25%,transparent);font-size:13px}
.err.on{display:flex}.err svg{flex:none;color:var(--dg);margin-top:2px}
.note{display:flex;gap:8px;margin:22px 0 0;padding-top:16px;border-top:1px solid var(--bd);font-size:12px;color:var(--t3)}.note svg{flex:none;margin-top:2px}
@media (max-width:480px){.card{padding:26px 20px 22px;border-radius:14px}}
`

const SVG = (paths, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`
const SPARKLE = ['M12 3l1.8 4.9L19 9.7l-4.6 2.6L12 18l-2.4-5.7L5 9.7l5.2-1.8Z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z']
const ALERT = ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z']
const LOCK = ['M6 11h12v10H6Z', 'M8 11V7a4 4 0 0 1 8 0v4']

// the page's script: no data in it; the strings and the endpoint come from the JSON block
const SCRIPT = `(()=>{const c=JSON.parse(document.getElementById('sign-in-config').textContent),f=document.getElementById('f'),b=f.querySelector('.go'),l=b.querySelector('.l'),e=document.getElementById('e'),m=document.getElementById('em'),p=document.getElementById('pw'),y=document.getElementById('eye');
y.onclick=()=>{const s=p.type==='password';p.type=s?'text':'password';y.textContent=s?c.s.hide:c.s.show;y.setAttribute('aria-pressed',String(s))};
const say=(t)=>{m.textContent=t;e.classList.add('on')};
f.onsubmit=async(ev)=>{ev.preventDefault();e.classList.remove('on');b.disabled=true;b.setAttribute('aria-busy','true');l.textContent=c.s.busy;
try{const d=Object.fromEntries(new FormData(f));const r=await fetch(c.endpoint,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(d)});
if(r.ok){location.href=c.next;return}say(r.status===401||r.status===400?c.s.bad:r.status===429?c.s.locked:c.s.failed.replace('{status}',r.status));if(r.status===401)p.select()}
catch{say(c.s.offline)}b.disabled=false;b.removeAttribute('aria-busy');l.textContent=c.s.submit}})()`

/**
 * The sign-in page. Returns { html, headers } — send both (the CSP carries this response's nonce).
 * system: { name } — the business system; next: where to go after signing in (a path on this site only);
 * endpoint: the system's own login API (POST { loginId, password } → 2xx and a session cookie).
 */
export function signInPage({ lang, acceptLanguage, system = {}, next, endpoint = '/api/auth/login', path = '/login' } = {}) {
  const l = pickLang(lang, acceptLanguage)
  const name = String(system.name ?? '') || 'Business system'
  const s = Object.fromEntries(Object.entries(S[l]).map(([k, v]) => [k, v.replaceAll('{system}', name)]))
  const to = safeNext(next)
  const nonce = randomBytes(16).toString('base64')
  const langLinks = Object.keys(S).map((k) => `<a href="${esc(`${path}?lang=${k}&next=${encodeURIComponent(to)}`)}" hreflang="${k}" lang="${k}"${k === l ? ' aria-current="true"' : ''}>${LANG_NAMES[k]}</a>`).join('')
  const html = `<!doctype html>
<html lang="${l === 'zh' ? 'zh-CN' : l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)} — ${esc(name)}</title><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">
<style nonce="${nonce}">${STYLE}</style>
<script type="application/json" id="sign-in-config">${safeJson({ endpoint: safeNext(endpoint, '/api/auth/login'), next: to, s: { show: s.show, hide: s.hide, busy: s.busy, submit: s.submit, bad: s.bad, locked: s.locked, failed: s.failed, offline: s.offline } })}</script>
</head><body>
<div class="top"><nav class="lang" aria-label="Language">${langLinks}</nav></div>
<main><section class="card" aria-labelledby="h">
<div class="brand"><span class="mark">${SVG(SPARKLE, 21)}</span><span class="tx"><b>${esc(name)}</b><span>${esc(s.product)}</span></span></div>
<h1 id="h">${esc(s.heading)}</h1><p class="lead">${esc(s.lead)}</p>
<form id="f" novalidate>
<label>${esc(s.loginId)}<input name="loginId" autocomplete="username" autocapitalize="off" spellcheck="false" required autofocus maxlength="64"></label>
<label>${esc(s.password)}<span class="in"><input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="200"><button type="button" class="eye" id="eye" aria-pressed="false" aria-controls="pw">${esc(s.show)}</button></span></label>
<div class="err" id="e" role="alert">${SVG(ALERT, 16)}<span id="em"></span></div>
<button class="go" type="submit"><span class="spin" aria-hidden="true"></span><span class="l">${esc(s.submit)}</span></button>
</form>
<p class="note">${SVG(LOCK, 14)}<span>${esc(s.note)}</span></p>
</section></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`
  const headers = {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  }
  return { html, headers }
}

/**
 * A browser that opens a screen (GET, HTML wanted) without a session goes to the sign-in page and comes back afterwards,
 * instead of reading a JSON 401. Returns true when it answered. authenticate(req) → principal or null (the system's own hook).
 * paths: exact paths (strings) and/or RegExps for the screens, e.g. /^\/handbook\// for the pages knowledge sources link to.
 */
export async function redirectToSignIn(req, res, { authenticate, paths = ['/agent-settings', '/me/sns'], login = '/login' } = {}) {
  if (req.method !== 'GET' || !/text\/html/.test(String(req.headers.accept ?? ''))) return false
  const url = new URL(req.url, 'http://x')
  if (!paths.some((p) => (p instanceof RegExp ? p.test(url.pathname) : p === url.pathname))) return false
  if (await authenticate(req)) return false
  const lang = url.searchParams.get('lang')
  res.writeHead(302, { location: `${login}?${lang ? `lang=${encodeURIComponent(lang)}&` : ''}next=${encodeURIComponent(safeNext(url.pathname + url.search))}`, 'cache-control': 'no-store' })
  res.end()
  return true
}
