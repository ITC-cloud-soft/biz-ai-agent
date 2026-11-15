// The settings screen: one HTML page (no external resources), Japanese / English / Chinese. It only calls the /api/agent/* routes
// and the framework's own POST /bridge/v1/me/link-codes, with the administrator's own session.

const T = {
  ja: {
    title: 'AI エージェントの設定', tabModels: 'モデル', tabKnowledge: '知識', tabSns: 'SNS',
    base: '基本モデル', baseHelp: '知識グラフの抽出に使います。AI 社員の会話のモデルは DSH 側の設定です（下の「DSH 用の設定」）。',
    embedding: 'Embedding モデル', embeddingHelp: 'RAG（ベクトル検索）に使います。使わない場合は BM25F（モデル不要）だけで検索します。',
    useEmbedding: 'Embedding モデルを使う', kind: '種類', baseUrl: 'Base URL', model: 'モデル（Azure は deployment 名）', dimensions: '次元（任意）',
    keyEnv: 'API キーの環境変数名（推奨）', keyValue: 'API キーを保存（AGENT_SETTINGS_KEY が必要）', keyNoStorage: 'キーの保存は無効です（AGENT_SETTINGS_KEY が未設定）。環境変数名を指定してください。',
    keyState: 'キー', keySet: '設定済み', keyUnset: '未設定', save: '保存', test: '接続テスト', overlay: 'DSH 用の設定（YAML）を表示',
    mode: '検索の方式', modeBm25f: 'BM25F', modeBm25fHelp: 'モデル不要。文書の語句で検索します（既定）。',
    modeRag: 'RAG（ベクトルデータベース）', modeRagHelp: 'BM25F ＋ embedding のベクトル。ベクトルはベクトルストアに保存します（v0.1 はファイル）。',
    modeGraph: '意味的知識グラフ（JSON）', modeGraphHelp: '基本モデルで文書を実体と関係のグラフにして JSON ファイルに保存し、BM25F と合わせて検索します。',
    sentNote: 'RAG・知識グラフでは、文書の本文が選んだモデルに送られます（個人情報の検査を通った部分だけ）。',
    status: '状態', rebuild: '索引を作り直す', upload: '文書のアップロード', docTitle: 'タイトル', docRoles: '読める役割', docKeywords: 'キーワード（カンマ区切り）',
    docFile: 'ファイル（.md / .txt、200 KB まで）', docText: '本文', submit: 'アップロード', documents: '文書',
    stPending: '承認待ち', stPublished: '公開中', stRejected: '却下', stPersonal: '個人情報あり（保存していません）', stWithdrawn: '取り下げ',
    approve: '承認', reject: '却下', withdraw: '取り下げ', requireApproval: '文書の公開に承認を求める（承認カードを SNS に送ります）',
    approverRoles: '承認する役割', reportRoles: '報告を受ける役割', reportOn: '報告のタイミング', reportRebuilt: '索引を作り直したとき', reportFailures: '失敗したとき',
    link: '自分の SNS 連携', linkHelp: '連携コードを発行し、ボットに「連携 123456」と送ってください。連携は本人しかできません。', linkIssue: '連携コードを発行',
    saved: '保存しました', failed: '失敗しました', none: 'なし',
  },
  en: {
    title: 'AI agent settings', tabModels: 'Models', tabKnowledge: 'Knowledge', tabSns: 'SNS',
    base: 'Base model', baseHelp: 'Used to extract the knowledge graph. The AI employee\'s conversation model is a DSH setting (see "DSH settings" below).',
    embedding: 'Embedding model', embeddingHelp: 'Used for RAG (vector search). Without it, search is BM25F only (no model).',
    useEmbedding: 'Use an embedding model', kind: 'Kind', baseUrl: 'Base URL', model: 'Model (Azure: deployment name)', dimensions: 'Dimensions (optional)',
    keyEnv: 'Environment variable with the API key (recommended)', keyValue: 'Store an API key (needs AGENT_SETTINGS_KEY)', keyNoStorage: 'Storing keys is off (AGENT_SETTINGS_KEY is not set). Give an environment variable name.',
    keyState: 'Key', keySet: 'set', keyUnset: 'not set', save: 'Save', test: 'Test connection', overlay: 'Show the DSH settings (YAML)',
    mode: 'Search method', modeBm25f: 'BM25F', modeBm25fHelp: 'No model. Searches the documents\' words (default).',
    modeRag: 'RAG (vector database)', modeRagHelp: 'BM25F + embedding vectors, kept in the vector store (v0.1: a file).',
    modeGraph: 'Semantic knowledge graph (JSON)', modeGraphHelp: 'The base model turns the documents into a graph of entities and relations, saved as a JSON file and searched together with BM25F.',
    sentNote: 'With RAG or the knowledge graph, document text is sent to the chosen model (only parts that passed the personal-data check).',
    status: 'Status', rebuild: 'Rebuild the index', upload: 'Upload a document', docTitle: 'Title', docRoles: 'Roles that may read it', docKeywords: 'Keywords (comma separated)',
    docFile: 'File (.md / .txt, up to 200 KB)', docText: 'Text', submit: 'Upload', documents: 'Documents',
    stPending: 'waiting for approval', stPublished: 'published', stRejected: 'rejected', stPersonal: 'personal data (not kept)', stWithdrawn: 'withdrawn',
    approve: 'Approve', reject: 'Reject', withdraw: 'Withdraw', requireApproval: 'Publishing a document needs an approval (approval cards go to SNS)',
    approverRoles: 'Roles that approve', reportRoles: 'Roles that get reports', reportOn: 'Report when', reportRebuilt: 'the index is rebuilt', reportFailures: 'something fails',
    link: 'My SNS link', linkHelp: 'Issue a link code and send "連携 123456" to the bot. Only you can link your own account.', linkIssue: 'Issue a link code',
    saved: 'Saved', failed: 'Failed', none: 'none',
  },
  zh: {
    title: 'AI 代理设置', tabModels: '模型', tabKnowledge: '知识', tabSns: 'SNS',
    base: '基础模型', baseHelp: '用于抽取知识图谱。AI 员工对话用的模型在 DSH 一侧设置（见下面的「DSH 设置」）。',
    embedding: 'Embedding 模型', embeddingHelp: '用于 RAG（向量检索）。不用时只用 BM25F（不需要模型）检索。',
    useEmbedding: '使用 embedding 模型', kind: '种类', baseUrl: 'Base URL', model: '模型（Azure 填 deployment 名）', dimensions: '维度（可选）',
    keyEnv: 'API key 的环境变量名（推荐）', keyValue: '保存 API key（需要 AGENT_SETTINGS_KEY）', keyNoStorage: '不能保存 key（没有设置 AGENT_SETTINGS_KEY）。请填写环境变量名。',
    keyState: 'Key', keySet: '已设置', keyUnset: '未设置', save: '保存', test: '连接测试', overlay: '显示 DSH 设置（YAML）',
    mode: '检索方式', modeBm25f: 'BM25F', modeBm25fHelp: '不需要模型，按文档的词句检索（默认）。',
    modeRag: 'RAG（向量数据库）', modeRagHelp: 'BM25F + embedding 向量，向量存在向量库里（v0.1 是文件）。',
    modeGraph: '语义知识图谱（JSON）', modeGraphHelp: '用基础模型把文档转成实体和关系的图谱，存成 JSON 文件，和 BM25F 一起检索。',
    sentNote: '使用 RAG 或知识图谱时，文档正文会发给所选的模型（只发送通过个人信息检查的部分）。',
    status: '状态', rebuild: '重建索引', upload: '上传文档', docTitle: '标题', docRoles: '可以阅读的角色', docKeywords: '关键词（逗号分隔）',
    docFile: '文件（.md / .txt，最大 200 KB）', docText: '正文', submit: '上传', documents: '文档',
    stPending: '等待审批', stPublished: '已发布', stRejected: '已驳回', stPersonal: '含个人信息（未保存）', stWithdrawn: '已撤下',
    approve: '批准', reject: '驳回', withdraw: '撤下', requireApproval: '发布文档需要审批（审批卡片发到 SNS）',
    approverRoles: '审批的角色', reportRoles: '接收报告的角色', reportOn: '报告时机', reportRebuilt: '重建索引后', reportFailures: '失败时',
    link: '我的 SNS 连携', linkHelp: '发行连携码后，向机器人发送「連携 123456」。只有本人可以连携自己的账号。', linkIssue: '发行连携码',
    saved: '已保存', failed: '失败', none: '无',
  },
}

export function pickLang(lang, acceptLanguage) {
  if (T[lang]) return lang
  for (const part of String(acceptLanguage ?? '').toLowerCase().split(',')) {
    const code = part.trim().slice(0, 2)
    if (T[code]) return code
  }
  return 'ja'
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function settingsScreen({ lang, acceptLanguage, roles = [] } = {}) {
  const l = pickLang(lang, acceptLanguage)
  const t = T[l]
  const roleBoxes = (name) => roles.map((r) => `<label class="chk"><input type="checkbox" name="${name}" value="${esc(r)}"> ${esc(r)}</label>`).join('')
  const modelCard = (key, embedding) => `
    <section class="card" data-model="${key}">
      <h2>${esc(embedding ? t.embedding : t.base)}</h2>
      <p class="help">${esc(embedding ? t.embeddingHelp : t.baseHelp)}</p>
      ${embedding ? `<label class="chk"><input type="checkbox" data-f="enabled"> ${esc(t.useEmbedding)}</label>` : ''}
      <div class="grid">
        <label>${esc(t.kind)}<select data-f="kind"><option value="openai">OpenAI compatible</option><option value="azure-openai">Azure OpenAI</option></select></label>
        <label>${esc(t.baseUrl)}<input data-f="baseUrl" placeholder="https://…" autocomplete="off"></label>
        <label>${esc(t.model)}<input data-f="model" autocomplete="off"></label>
        ${embedding ? `<label>${esc(t.dimensions)}<input data-f="dimensions" type="number" min="1" max="8192"></label>` : ''}
        <label>${esc(t.keyEnv)}<input data-f="apiKeyEnv" placeholder="AZURE_OPENAI_KEY" autocomplete="off"></label>
        <label class="keyvalue">${esc(t.keyValue)}<input data-f="apiKey" type="password" autocomplete="new-password"></label>
      </div>
      <p class="keystate"></p>
      <div class="row"><button data-act="save-model">${esc(t.save)}</button><button class="ghost" data-act="test">${esc(t.test)}</button><span class="msg"></span></div>
    </section>`
  return `<!doctype html>
<html lang="${l}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --ink:#1d2330; --muted:#5f6b7a; --line:#dfe3e8; --accent:#2457c5; --ok:#16794c; --warn:#a15c00; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1c2027; --ink:#e7eaee; --muted:#9aa5b1; --line:#2c323b; --accent:#7aa2ff; --ok:#4cc38a; --warn:#f0b35a; --bad:#ff7a70; } }
* { box-sizing: border-box } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", "Microsoft YaHei", sans-serif }
header { padding:20px 16px 0; max-width:980px; margin:0 auto } h1 { font-size:22px; margin:0 0 12px } .lang a { color:var(--muted); margin-right:10px; font-size:13px }
nav { display:flex; gap:4px; border-bottom:1px solid var(--line); max-width:980px; margin:0 auto; padding:0 16px } nav button { background:none; border:0; border-bottom:2px solid transparent; padding:10px 14px; color:var(--muted); font:inherit; cursor:pointer }
nav button[aria-selected=true] { color:var(--accent); border-color:var(--accent); font-weight:600 }
main { max-width:980px; margin:0 auto; padding:16px } .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px }
h2 { font-size:17px; margin:0 0 4px } .help, .note { color:var(--muted); font-size:13px; margin:0 0 12px } .note { border-left:3px solid var(--warn); padding-left:8px }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px } label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted) }
input, select, textarea { font:inherit; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:7px 9px; min-width:0 } textarea { min-height:140px; resize:vertical }
label.chk { flex-direction:row; align-items:center; gap:6px; color:var(--ink); margin:4px 14px 4px 0; display:inline-flex }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px } button { font:inherit; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; padding:7px 14px; cursor:pointer }
button.ghost { background:transparent; color:var(--accent) } button.danger { background:transparent; color:var(--bad); border-color:var(--bad) } .msg { font-size:13px; color:var(--muted) }
.modes { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px } .mode { border:1px solid var(--line); border-radius:8px; padding:10px; display:block; color:var(--ink) }
.mode input { margin-right:6px } .mode small { display:block; color:var(--muted); margin-top:4px } .mode:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset }
table { width:100%; border-collapse:collapse; font-size:14px } th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top } .tw { overflow-x:auto }
.badge { font-size:12px; border-radius:99px; padding:2px 8px; border:1px solid currentColor; white-space:nowrap } .published { color:var(--ok) } .pending { color:var(--warn) } .rejected, .personal_data { color:var(--bad) } .withdrawn { color:var(--muted) }
pre { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; font-size:12px } dl { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0 } dt { color:var(--muted) } .code { font-size:26px; letter-spacing:4px; font-weight:700 }
[hidden] { display:none !important }
</style></head>
<body>
<header><h1>${esc(t.title)}</h1><div class="lang"><a href="?lang=ja">日本語</a><a href="?lang=en">English</a><a href="?lang=zh">中文</a></div></header>
<nav role="tablist"><button role="tab" data-tab="models" aria-selected="true">${esc(t.tabModels)}</button><button role="tab" data-tab="knowledge" aria-selected="false">${esc(t.tabKnowledge)}</button><button role="tab" data-tab="sns" aria-selected="false">${esc(t.tabSns)}</button></nav>
<main>
<div data-panel="models">
  ${modelCard('base', false)}
  ${modelCard('embedding', true)}
  <section class="card"><div class="row" style="margin-top:0"><button class="ghost" data-act="overlay">${esc(t.overlay)}</button></div><pre id="overlay" hidden></pre></section>
</div>
<div data-panel="knowledge" hidden>
  <section class="card"><h2>${esc(t.mode)}</h2>
    <div class="modes">
      <label class="mode"><input type="radio" name="mode" value="bm25f">${esc(t.modeBm25f)}<small>${esc(t.modeBm25fHelp)}</small></label>
      <label class="mode"><input type="radio" name="mode" value="rag">${esc(t.modeRag)}<small>${esc(t.modeRagHelp)}</small></label>
      <label class="mode"><input type="radio" name="mode" value="graph">${esc(t.modeGraph)}<small>${esc(t.modeGraphHelp)}</small></label>
    </div>
    <p class="note" style="margin-top:12px">${esc(t.sentNote)}</p>
    <div class="row"><button data-act="save-mode">${esc(t.save)}</button><button class="ghost" data-act="rebuild">${esc(t.rebuild)}</button><span class="msg" id="mode-msg"></span></div>
    <h2 style="margin-top:14px">${esc(t.status)}</h2><dl id="status"></dl>
  </section>
  <section class="card"><h2>${esc(t.upload)}</h2>
    <div class="grid"><label>${esc(t.docTitle)}<input id="d-title" maxlength="120"></label><label>${esc(t.docKeywords)}<input id="d-keywords"></label><label>${esc(t.docFile)}<input id="d-file" type="file" accept=".md,.txt,text/markdown,text/plain"></label></div>
    <p class="help" style="margin:10px 0 2px">${esc(t.docRoles)}</p><div>${roleBoxes('d-roles')}</div>
    <label style="margin-top:8px">${esc(t.docText)}<textarea id="d-text"></textarea></label>
    <div class="row"><button data-act="upload">${esc(t.submit)}</button><span class="msg" id="up-msg"></span></div>
  </section>
  <section class="card"><h2>${esc(t.documents)}</h2><div class="tw"><table><thead><tr><th>${esc(t.docTitle)}</th><th>ID</th><th>${esc(t.docRoles)}</th><th>${esc(t.status)}</th><th></th></tr></thead><tbody id="docs"></tbody></table></div></section>
</div>
<div data-panel="sns" hidden>
  <section class="card">
    <label class="chk"><input type="checkbox" id="s-approval"> ${esc(t.requireApproval)}</label>
    <p class="help" style="margin:12px 0 2px">${esc(t.approverRoles)}</p><div>${roleBoxes('s-approvers')}</div>
    <p class="help" style="margin:12px 0 2px">${esc(t.reportRoles)}</p><div>${roleBoxes('s-reports')}</div>
    <p class="help" style="margin:12px 0 2px">${esc(t.reportOn)}</p><div><label class="chk"><input type="checkbox" id="s-rebuilt"> ${esc(t.reportRebuilt)}</label><label class="chk"><input type="checkbox" id="s-failures"> ${esc(t.reportFailures)}</label></div>
    <div class="row"><button data-act="save-sns">${esc(t.save)}</button><span class="msg" id="sns-msg"></span></div>
  </section>
  <section class="card"><h2>${esc(t.link)}</h2><p class="help">${esc(t.linkHelp)}</p><div class="row"><button class="ghost" data-act="link">${esc(t.linkIssue)}</button><span class="code" id="link-code"></span></div></section>
</div>
</main>
<script>
const T = ${JSON.stringify(t)};
const $ = (s, r = document) => r.querySelector(s); const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
const say = (el, text, ok = true) => { el.textContent = text; el.style.color = ok ? 'var(--ok)' : 'var(--bad)'; };
let state = null;
$$('nav button').forEach((b) => b.onclick = () => { $$('nav button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); $$('[data-panel]').forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab); });
function fill(s) {
  state = s;
  for (const card of $$('[data-model]')) {
    const m = s.settings.llm[card.dataset.model];
    for (const el of $$('[data-f]', card)) { const f = el.dataset.f; if (f === 'apiKey') el.value = ''; else if (el.type === 'checkbox') el.checked = Boolean(m[f]); else el.value = m[f] ?? ''; }
    $('.keyvalue', card).hidden = !s.settings.keyStorage;
    $('.keystate', card).textContent = T.keyState + ': ' + (m.key.set ? T.keySet + ' (' + m.key.source + (m.key.hint ? ' ' + m.key.hint : '') + ')' : T.keyUnset) + (s.settings.keyStorage ? '' : ' — ' + T.keyNoStorage);
  }
  for (const r of $$('input[name=mode]')) r.checked = r.value === s.settings.knowledge.mode;
  const sns = s.settings.sns;
  $('#s-approval').checked = sns.requireApproval; $('#s-rebuilt').checked = sns.reportOn.rebuilt; $('#s-failures').checked = sns.reportOn.failures;
  for (const c of $$('input[name=s-approvers]')) c.checked = sns.approverRoles.includes(c.value);
  for (const c of $$('input[name=s-reports]')) c.checked = sns.reportRoles.includes(c.value);
  status(s.knowledge);
}
function status(k) {
  const rows = [['mode', k.service || k.mode], ['documents', k.documents], ['chunks', k.chunks], ['rejected', k.rejected], ['problems', (k.failed || []).join(', ') || T.none], ['at', k.at]];
  if (k.stats) rows.push(['stats', Object.entries(k.stats).map(([a, b]) => a + ' ' + b).join(' · ')]);
  $('#status').replaceChildren(...rows.flatMap(([a, b]) => { const dt = document.createElement('dt'); dt.textContent = a; const dd = document.createElement('dd'); dd.textContent = b ?? '-'; return [dt, dd]; }));
}
const ST = { pending: T.stPending, published: T.stPublished, rejected: T.stRejected, personal_data: T.stPersonal, withdrawn: T.stWithdrawn };
async function loadDocs() {
  const { documents } = await api('GET', '/api/agent/documents');
  $('#docs').replaceChildren(...documents.map((d) => {
    const tr = document.createElement('tr');
    const cell = (v) => { const td = document.createElement('td'); if (v instanceof Node) td.append(v); else td.textContent = v; tr.append(td); return td; };
    const title = d.link ? Object.assign(document.createElement('a'), { href: d.link, textContent: d.title }) : d.title;
    cell(title); cell(d.id); cell(d.roles.join(', '));
    const badge = Object.assign(document.createElement('span'), { className: 'badge ' + d.status, textContent: ST[d.status] + (d.kinds ? ' (' + d.kinds.join(', ') + ')' : '') }); cell(badge);
    const actions = cell('');
    const btn = (label, cls, fn) => { const b = Object.assign(document.createElement('button'), { textContent: label, className: cls }); b.onclick = async () => { try { await fn(); await refresh(); } catch (e) { alert(T.failed + ': ' + e.message); } }; actions.append(b, ' '); };
    if (d.canDecide) { btn(T.approve, '', () => api('POST', '/api/agent/documents/' + d.id + '/decision', { action: 'approve' })); btn(T.reject, 'ghost', () => api('POST', '/api/agent/documents/' + d.id + '/decision', { action: 'reject' })); }
    if (d.status === 'published' || d.status === 'pending') btn(T.withdraw, 'danger', () => api('DELETE', '/api/agent/documents/' + d.id));
    return tr;
  }));
}
async function refresh() { fill(await api('GET', '/api/agent/settings')); await loadDocs(); }
for (const card of $$('[data-model]')) {
  const msg = $('.msg', card);
  $('[data-act=save-model]', card).onclick = async () => {
    const patch = {};
    for (const el of $$('[data-f]', card)) { const f = el.dataset.f; if (el.closest('[hidden]')) continue; if (f === 'apiKey') { if (el.value) patch.apiKey = el.value; } else if (el.type === 'checkbox') patch[f] = el.checked; else if (f === 'dimensions') patch[f] = el.value ? Number(el.value) : null; else patch[f] = el.value.trim(); }
    try { fill(await api('PUT', '/api/agent/settings', { llm: { [card.dataset.model]: patch } })); say(msg, T.saved); } catch (e) { say(msg, T.failed + ': ' + e.message, false); }
  };
  $('[data-act=test]', card).onclick = async () => { try { const { result } = await api('POST', '/api/agent/settings/test', { target: card.dataset.model }); say(msg, (result.ok ? 'OK' : T.failed + ': ' + result.error) + ' · ' + result.ms + ' ms', result.ok); } catch (e) { say(msg, T.failed + ': ' + e.message, false); } };
}
$('[data-act=overlay]').onclick = async () => { const res = await fetch('/api/agent/settings/dsh-overlay', { credentials: 'same-origin' }); const pre = $('#overlay'); pre.textContent = await res.text(); pre.hidden = false; };
$('[data-act=save-mode]').onclick = async () => { const mode = $('input[name=mode]:checked')?.value; try { fill(await api('PUT', '/api/agent/settings', { knowledge: { mode } })); say($('#mode-msg'), T.saved); } catch (e) { say($('#mode-msg'), T.failed + ': ' + e.message, false); } };
$('[data-act=rebuild]').onclick = async () => { try { const { knowledge } = await api('POST', '/api/agent/knowledge/rebuild'); status(knowledge); say($('#mode-msg'), T.saved); } catch (e) { say($('#mode-msg'), T.failed + ': ' + e.message, false); } };
$('#d-file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 200000) { say($('#up-msg'), T.failed + ': > 200 KB', false); return; } $('#d-text').value = await f.text(); if (!$('#d-title').value) $('#d-title').value = f.name.replace(/\\.[^.]+$/, ''); };
$('[data-act=upload]').onclick = async () => {
  const body = { title: $('#d-title').value.trim(), roles: $$('input[name=d-roles]:checked').map((c) => c.value), keywords: $('#d-keywords').value.split(',').map((s) => s.trim()).filter(Boolean), text: $('#d-text').value };
  try { const { document: d } = await api('POST', '/api/agent/documents', body); say($('#up-msg'), d.id + ': ' + ST[d.status], d.status !== 'personal_data'); $('#d-text').value = ''; $('#d-title').value = ''; await loadDocs(); } catch (e) { say($('#up-msg'), T.failed + ': ' + e.message, false); }
};
$('[data-act=save-sns]').onclick = async () => {
  const sns = { requireApproval: $('#s-approval').checked, approverRoles: $$('input[name=s-approvers]:checked').map((c) => c.value), reportRoles: $$('input[name=s-reports]:checked').map((c) => c.value), reportOn: { rebuilt: $('#s-rebuilt').checked, failures: $('#s-failures').checked } };
  try { fill(await api('PUT', '/api/agent/settings', { sns })); say($('#sns-msg'), T.saved); } catch (e) { say($('#sns-msg'), T.failed + ': ' + e.message, false); }
};
$('[data-act=link]').onclick = async () => { try { const r = await api('POST', '/bridge/v1/me/link-codes'); $('#link-code').textContent = r.code; } catch (e) { $('#link-code').textContent = T.failed + ': ' + e.message; } };
refresh().catch((e) => { document.querySelector('main').prepend(Object.assign(document.createElement('p'), { textContent: T.failed + ': ' + e.message })); });
</script>
</body></html>`
}
