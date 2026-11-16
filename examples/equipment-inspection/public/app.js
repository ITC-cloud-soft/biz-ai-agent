// Self-service SNS linking page. Talks to the business system with the employee's own session cookie only
// (no BFF secret in the browser: BFF-only operations such as personal-bot registration are not offered here).
const $ = (id) => document.getElementById(id)
const ROLE_LABEL = { admin: '施設管理者', manager: '設備責任者', inspector: '点検員' }
const OVERDUE = 'inspection.overdue'

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

function say(text, isError = false) {
  const m = $('message')
  m.textContent = text
  m.className = isError ? 'error' : ''
}

async function refreshLinks() {
  const r = await call('GET', '/bridge/v1/me/identities')
  const tbody = $('links')
  tbody.textContent = ''
  const list = r.body.identities ?? []
  $('no-links').hidden = list.length > 0
  for (const i of list) {
    const tr = document.createElement('tr')
    for (const text of [i.platform, i.externalId, i.verifiedAt ? new Date(i.verifiedAt).toLocaleString('ja-JP') : '-']) {
      const td = document.createElement('td')
      td.textContent = text
      tr.append(td)
    }
    const td = document.createElement('td')
    const btn = document.createElement('button')
    btn.className = 'secondary'
    btn.textContent = '解除'
    btn.addEventListener('click', async () => {
      if (!confirm(`${i.platform} の連携を解除しますか？`)) return
      const d = await call('DELETE', `/bridge/v1/me/identities/${encodeURIComponent(i.id)}`)
      say(d.status === 200 ? '連携を解除しました。' : `解除できませんでした (${d.body.error ?? d.status})`, d.status !== 200)
      refreshLinks()
    })
    td.append(btn)
    tr.append(td)
    tbody.append(tr)
  }
}

async function refreshPrefs() {
  const r = await call('GET', '/bridge/v1/me/notification-preferences')
  $('pref-overdue').checked = Boolean(r.body.preferences?.types?.[OVERDUE]?.im)
}

async function showMe() {
  const r = await call('GET', '/api/me')
  if (r.status !== 200) {
    $('login').hidden = false
    $('me').hidden = true
    return
  }
  $('login').hidden = true
  $('me').hidden = false
  $('me-name').textContent = r.body.user.displayName
  $('me-role').textContent = ROLE_LABEL[r.body.user.role] ?? r.body.user.role
  await Promise.all([refreshLinks(), refreshPrefs()])
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = new FormData(ev.target)
  const r = await call('POST', '/api/auth/login', { loginId: f.get('loginId'), password: f.get('password') })
  if (r.status !== 200) return say('ログインできませんでした。', true)
  say('')
  showMe()
})

$('logout').addEventListener('click', async () => {
  await call('POST', '/api/auth/logout')
  $('code-box').hidden = true
  showMe()
})

$('reload').addEventListener('click', () => refreshLinks())

let timer = null
$('issue').addEventListener('click', async () => {
  const r = await call('POST', '/bridge/v1/me/link-codes')
  if (r.status !== 201) return say(`コードを発行できませんでした (${r.body.error ?? r.status})`, true)
  $('code').textContent = r.body.code
  $('code-box').hidden = false
  const until = Date.parse(r.body.expiresAt)
  clearInterval(timer)
  const tick = () => {
    const s = Math.max(0, Math.round((until - Date.now()) / 1000))
    $('code-expiry').textContent = s ? `あと ${Math.floor(s / 60)} 分 ${s % 60} 秒` : '期限切れ（もう一度発行してください）'
    if (!s) clearInterval(timer)
  }
  tick()
  timer = setInterval(tick, 1000)
  say(`ボットに「link ${r.body.code}」と送ってください。連携できたら「再読み込み」で一覧に表示されます。`)
})

$('pref-overdue').addEventListener('change', async (ev) => {
  const r = await call('PUT', '/bridge/v1/me/notification-preferences', { types: { [OVERDUE]: { im: ev.target.checked } } })
  say(r.status === 200 ? '通知の設定を保存しました。' : '保存できませんでした。', r.status !== 200)
})

showMe()
