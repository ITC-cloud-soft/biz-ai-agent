// 再インストールで profile の cordis.patch.yml を上書きするとき、管理画面（業務 Web の AI モデル設定・DSH の設定画面 = DSH の
// settings/mutate）が保存した項目を引き継ぐ。DSH の config-editor はこれらをトップレベルの `- id: <ns>` 項目
// （insert ではない）として書く（dsh/upstream/packages/boot/config-editor/src/index.ts）。
// 値は事業所ごと（プロバイダー・API キーの参照名・既定モデル）なので、製品の source patch には書かない。

export const USER_MANAGED_IDS = ['agent-default-model', 'llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account']

const HEADER = '# ── 管理画面（AI モデル設定）で保存した値。install.mjs が再インストール時に引き継ぐ ──'

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** YAML シーケンスのトップレベル項目（行頭の `- `）ごとに分ける。項目の前のコメント・空行は head か直前の項目に付く。 */
export function splitTopLevel(text) {
  const lines = text.split(/\r?\n/)
  const head = []
  const items = []
  for (const line of lines) {
    if (line.startsWith('- ') || line === '-') items.push({ lines: [line] })
    else if (items.length) items.at(-1).lines.push(line)
    else head.push(line)
  }
  for (const item of items) {
    const first = item.lines[0]
    const own = (key) => {
      const m = first.match(new RegExp(`^- ${key}:(.*)$`))
        ?? item.lines.slice(1).map((l) => l.match(new RegExp(`^  ${key}:(.*)$`))).find(Boolean)
      return m ? m[1] : undefined
    }
    const id = own('id')
    item.id = id === undefined ? undefined : unquote(id)
    item.insert = own('insert') !== undefined
  }
  return { head, items }
}

const isUserManaged = (item, ids) => !item.insert && item.id !== undefined && ids.includes(item.id)

/** 末尾の空行を落とした項目本文（HEADER 行は除く）。 */
function body(item) {
  const lines = item.lines.filter((l) => l !== HEADER)
  while (lines.length && lines.at(-1).trim() === '') lines.pop()
  return lines
}

// ── 自動タスクの委託（bridge-tools の unattendedPolicy / unattendedOnBehalfOf）────────────────────────────────
// 導入先ごとの値（委託する職員の IM アカウント）なので製品の source patch には書かない。install.mjs の
// --auto-task-delegate がトップレベルの `- id: bridge-tools` 項目の config に書き（製品の patch にその項目が無ければ末尾に足す）、
// 再インストール時は readDelegation で読み取って withDelegation で書き直す（carryUserManaged の対象ではない）。
// 項目の id / name は target で変えられる（profile の package.json の dshBridge.delegation。旧 care-tools の profile は
// { id: 'care-tools', name: '@care/dsh-care-tools' }）。
const DELEGATION_HEADER = '# ── 自動タスクの委託（install.mjs --auto-task-delegate で設定。導入先ごとの値。再インストール時に引き継ぐ）──'
/** 委託を書くプラグインの項目（@dsh-bridge/plugin-tools）。 */
export const DEFAULT_DELEGATION_TARGET = Object.freeze({ id: 'bridge-tools', name: '@dsh-bridge/plugin-tools' })
const PLATFORM_RE = /^[a-z][a-z0-9-]{1,31}$/

/** playbook の委託の分類（source.delegation の <class>）。`default` は既定の職員（unattendedOnBehalfOf）の名前に使う。 */
const CLASS_RE = /^[a-z][a-z0-9_]{0,39}$/
const USAGE = '--auto-task-delegate must be <platform>:<userId>[:<teamId>] (e.g. feishu:ou_xxxxxxxx), '
  + 'a list of <class>=<platform>:<userId>[:<teamId>] / <class>=each (e.g. planning=line:U1,billing=line:U2,inspector=each; '
  + 'default=<platform>:<userId> for the rest) or off'

function parseSource(raw) {
  const [platform, userId, teamId, ...rest] = String(raw ?? '').split(':')
  const bad = (s) => !s || s.length > 200 || /[\s"'\\#,=]/.test(s)
  if (rest.length || !PLATFORM_RE.test(platform ?? '') || bad(userId) || (teamId !== undefined && bad(teamId))) return null
  return { platform, userId, ...(teamId ? { teamId } : {}) }
}

/**
 * `--auto-task-delegate` の値 → 委託。`off` / `deny` → null。不正なら Error。
 *  - `<platform>:<userId>[:<teamId>]` → { platform, userId, teamId? }（全部の自動タスクをその職員の委託で。従来の形）
 *  - `<class>=<platform>:<userId>,<class>=each,default=<platform>:<userId>` → { platform?, userId?, teamId?, classes: { <class>: source | 'each' } }
 *    （playbook の委託の分類ごとの職員。each は起動事件の本人ごとの委託を許す。default は分類の職員が無いときの既定）
 */
export function parseDelegation(value) {
  const raw = String(value ?? '').trim()
  if (raw === 'off' || raw === 'deny') return null
  if (!raw.includes('=')) {
    const source = parseSource(raw)
    if (!source) throw new Error(`${USAGE} (got ${JSON.stringify(raw)})`)
    return source
  }
  const out = {}
  const classes = {}
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf('=')
    const key = part.slice(0, at)
    const val = part.slice(at + 1)
    if (at <= 0 || !CLASS_RE.test(key)) throw new Error(`${USAGE} (bad class in ${JSON.stringify(part)})`)
    if (key in classes || (key === 'default' && out.platform)) throw new Error(`${USAGE} (${key} is given twice)`)
    if (val === 'each') {
      if (key === 'default') throw new Error(`${USAGE} (default cannot be each)`)
      classes[key] = 'each'
      continue
    }
    const source = parseSource(val)
    if (!source) throw new Error(`${USAGE} (bad account in ${JSON.stringify(part)})`)
    if (key === 'default') Object.assign(out, source)
    else classes[key] = source
  }
  if (!out.platform && !Object.keys(classes).length) throw new Error(`${USAGE} (got ${JSON.stringify(raw)})`)
  return Object.keys(classes).length ? { ...out, classes } : out
}

/** ログ用の短い説明（IM ユーザー ID は先頭 6 文字だけ）。 */
export function describeDelegation(delegation) {
  if (!delegation) return 'none'
  const who = (s) => `${s.platform}:${String(s.userId).slice(0, 6)}…`
  const parts = []
  if (delegation.platform) parts.push(delegation.classes ? `default=${who(delegation)}` : who(delegation))
  for (const [k, v] of Object.entries(delegation.classes ?? {})) parts.push(v === 'each' ? `${k}=each` : `${k}=${who(v)}`)
  return parts.join(', ')
}

const DELEGATION_KEYS = ['unattendedPolicy', 'unattendedOnBehalfOf', 'unattendedDelegates']
const indentOf = (line) => line.length - line.trimStart().length
/**
 * 委託を書く項目か。target.aliases（以前の id。例：自前のプラグインで動いていた頃の項目）も読み取り・取り除きの対象にする
 * （再インストールで委託を引き継ぎ、新しい id の項目に書き直す）。書き込み先は target.id の項目だけ。
 */
const isTargetItem = (item, target) => !item.insert && item.id !== undefined
  && (item.id === target.id || (Array.isArray(target.aliases) && target.aliases.includes(item.id)))
const isPrimaryItem = (item, target) => !item.insert && item.id === target.id

/** config の直下（字下げ 4）のキー。 */
function configKeys(item) {
  return item.lines.map((l) => /^ {4}([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter(Boolean)
}

/** install.mjs が書いた委託だけの項目（config のキーが unattendedPolicy / unattendedOnBehalfOf だけ）。 */
function isDelegationOnly(item) {
  const keys = configKeys(item)
  const own = item.lines.slice(1).map((l) => /^ {2}([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter(Boolean)
  return keys.length > 0 && keys.every((k) => DELEGATION_KEYS.includes(k)) && own.every((k) => ['id', 'name', 'config'].includes(k))
}

/** 項目の config から unattendedPolicy / unattendedOnBehalfOf（とその子）を取り除いた行。 */
function withoutDelegationKeys(lines) {
  const out = []
  let skipping = false
  for (const line of lines) {
    if (skipping && line.trim() !== '' && indentOf(line) > 4) continue
    skipping = false
    const key = /^ {4}([A-Za-z_][\w-]*):/.exec(line)?.[1]
    if (key && DELEGATION_KEYS.includes(key)) { skipping = true; continue }
    out.push(line)
  }
  return out
}

/** unattendedOnBehalfOf（ブロック形式 / フロー形式 `{ platform: x, userId: y }`）の値。 */
function onBehalfOfIn(lines) {
  const at = lines.findIndex((l) => /^\s+unattendedOnBehalfOf:/.test(l))
  if (at < 0) return null
  const fields = {}
  const flow = /^\s+unattendedOnBehalfOf:\s*\{(.*)\}\s*$/.exec(lines[at])
  if (flow) {
    for (const part of flow[1].split(',')) {
      const m = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(part)
      if (m) fields[m[1]] = unquote(m[2])
    }
  } else {
    const base = indentOf(lines[at])
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === '' || indentOf(line) <= base) break
      const m = /^\s+([A-Za-z]+):\s*(.+?)\s*$/.exec(line)
      if (m) fields[m[1]] = unquote(m[2])
    }
  }
  return fields
}

/** フロー形式 `{ platform: x, userId: y }` の中身。 */
function flowFields(inner) {
  const fields = {}
  for (const part of inner.split(',')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(part)
    if (m) fields[m[1]] = unquote(m[2])
  }
  return fields
}

/** unattendedDelegates（分類ごとの職員：ブロック形式 / フロー形式、値 each）の値 { <class>: source | 'each' }。 */
function delegatesIn(lines) {
  const at = lines.findIndex((l) => /^\s+unattendedDelegates:\s*$/.test(l))
  if (at < 0) return {}
  const base = indentOf(lines[at])
  const out = {}
  let current = null
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = indentOf(line)
    if (indent <= base) break
    const m = /^\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    if (current === null || indent <= current.indent) {
      const value = m[2]
      const flow = /^\{(.*)\}$/.exec(value)
      if (unquote(value) === 'each') { out[m[1]] = 'each'; current = null; continue }
      out[m[1]] = flow ? flowFields(flow[1]) : {}
      current = flow ? null : { key: m[1], indent }
      continue
    }
    out[current.key][m[1]] = unquote(m[2])
  }
  const valid = {}
  for (const [k, v] of Object.entries(out)) {
    if (!CLASS_RE.test(k)) continue
    if (v === 'each') valid[k] = 'each'
    else if (v?.platform && v?.userId) valid[k] = { platform: v.platform, userId: v.userId, ...(v.teamId ? { teamId: v.teamId } : {}) }
  }
  return valid
}

/**
 * 現在の委託（トップレベルの target.id 項目の unattendedPolicy: delegate と unattendedOnBehalfOf・unattendedDelegates）。無ければ null。
 * 同じ id の項目が複数あれば（製品の項目と委託だけの項目など）後のものを優先する。
 * → { platform, userId, teamId? }（既定の職員）に、分類ごとの職員があれば classes: { <class>: source | 'each' }
 */
export function readDelegation(text, target = DEFAULT_DELEGATION_TARGET) {
  const items = splitTopLevel(text ?? '').items.filter((i) => isTargetItem(i, target))
  for (const item of items.reverse()) {
    if (!item.lines.some((l) => /^\s+unattendedPolicy:\s*['"]?delegate['"]?\s*$/.test(l))) continue
    const { platform, userId, teamId } = onBehalfOfIn(item.lines) ?? {}
    const classes = delegatesIn(item.lines)
    const hasClasses = Object.keys(classes).length > 0
    if ((!platform || !userId) && !hasClasses) continue
    return { ...(platform && userId ? { platform, userId, ...(teamId ? { teamId } : {}) } : {}), ...(hasClasses ? { classes } : {}) }
  }
  return null
}

/** 委託の行（config の直下、字下げ 4）。 */
function delegationLines(delegation) {
  const sourceLines = (s, indent) => [
    `${indent}platform: ${JSON.stringify(s.platform)}`,
    `${indent}userId: ${JSON.stringify(s.userId)}`,
    ...(s.teamId ? [`${indent}teamId: ${JSON.stringify(s.teamId)}`] : []),
  ]
  const classes = Object.entries(delegation.classes ?? {})
  return [
    '    unattendedPolicy: delegate',
    ...(delegation.platform && delegation.userId ? ['    unattendedOnBehalfOf:', ...sourceLines(delegation, '      ')] : []),
    ...(classes.length ? ['    unattendedDelegates:', ...classes.flatMap(([k, v]) => (v === 'each' ? [`      ${k}: each`] : [`      ${k}:`, ...sourceLines(v, '        ')]))] : []),
  ]
}

/**
 * 委託を書き換える（delegation = null なら削除＝ bridge-tools の既定 deny）。
 * - 製品の patch にトップレベルの target.id 項目（例：toolModules を持つ `- id: bridge-tools`）があれば、その項目の config に
 *   unattendedPolicy / unattendedOnBehalfOf を入れる（製品の設定は消さない。同じ id の項目を 2 つ作らない）。
 * - 無ければ patch の末尾に委託だけの項目を足す（見出しのコメント付き）。
 * 以前に書いた委託だけの項目と、製品の項目にある委託のキーは、書く前に取り除く。
 */
export function withDelegation(text, delegation, target = DEFAULT_DELEGATION_TARGET) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const { head, items } = splitTopLevel(text)
  const targets = items.filter((item) => isTargetItem(item, target))
  if (!delegation && targets.length === 0 && !text.includes(DELEGATION_HEADER)) return text
  const kept = items.filter((item) => !(isTargetItem(item, target) && isDelegationOnly(item)))
  const product = kept.filter((item) => isPrimaryItem(item, target)).at(-1) ?? null
  const blockConfig = product ? product.lines.findIndex((l) => /^ {2}config:\s*$/.test(l)) : -1
  const lines = []
  for (const item of [{ lines: head }, ...kept]) {
    const own = isTargetItem(item, target) ? withoutDelegationKeys(item.lines) : item.lines
    if (item === product && delegation) {
      const at = blockConfig >= 0 ? own.findIndex((l) => /^ {2}config:\s*$/.test(l)) : -1
      if (at >= 0) {
        lines.push(...own.slice(0, at + 1), ...delegationLines(delegation), ...own.slice(at + 1))
        continue
      }
      if (!own.some((l) => /^ {2}config:/.test(l))) {
        // config の無い項目：本文（末尾の空行・次の項目の前置きコメントより前）に config を足す
        let end = own.length
        while (end > 1 && (own[end - 1].trim() === '' || /^\s*#/.test(own[end - 1]))) end -= 1
        lines.push(...own.slice(0, end), '  config:', ...delegationLines(delegation), ...own.slice(end))
        continue
      }
    }
    lines.push(...own)
  }
  const merged = Boolean(delegation && product && (blockConfig >= 0 || !product.lines.some((l) => /^ {2}config:/.test(l))))
  const out = lines.filter((l) => l !== DELEGATION_HEADER)
  while (out.length && out.at(-1).trim() === '') out.pop()
  if (delegation && !merged) {
    out.push('', DELEGATION_HEADER, `- id: ${target.id}`, `  name: '${target.name}'`, '  config:', ...delegationLines(delegation))
  }
  out.push('')
  return out.join(eol)
}

/**
 * @param {string|null} installed  上書き前の profile patch（無ければ null）
 * @param {string} source          製品の source patch
 * @returns {{text: string, carried: string[]}}
 */
export function carryUserManaged(installed, source, ids = USER_MANAGED_IDS) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  if (!installed) return { text: source, carried: [] }
  const kept = splitTopLevel(installed).items.filter((item) => isUserManaged(item, ids))
  if (!kept.length) return { text: source, carried: [] }
  const src = splitTopLevel(source)
  const lines = [...src.head, ...src.items.filter((item) => !isUserManaged(item, ids)).flatMap((item) => item.lines)]
  while (lines.length && lines.at(-1).trim() === '') lines.pop()
  lines.push('', HEADER, ...kept.flatMap(body), '')
  return { text: lines.join(eol), carried: kept.map((item) => item.id) }
}
