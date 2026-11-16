// secretary.js — IM の文面を「AI 秘書」の形にそろえる共通部品（docs/GUIDELINE.md の IM 文面の節）。
//
// どの通知も 1 行目に意図のラベルを付ける：
//   【ご報告】       情報だけ（最後に「ご対応は不要です」の一言）
//   【対応のお願い】 具体的な対応をお願いする（▶ お願いしたいこと：何を・どこで・いつまでに）
//   【至急】         急ぎの対応（安否確認・未打刻など）
//   【承認のお願い】 承認のお願い（intent approval）。承認カード（@dsh-bridge/plugin-approvals）と、ボタンの無い文字の通知
//                    （承認できる人が依頼者本人しかいないので別の人に回すときなど。判断は業務 Web で）
//   【ご相談】       判断を一緒に考えてほしいこと（intent consult。期限を過ぎて片付かないもののお知らせ、判断材料の確認など）
//   【定時のご報告】 定時業務報告
//   【ご案内】       システムの使い方の質問への答え（AI 秘書がマニュアルの節から書く。intent は info。care-ai-native SNS_HELP_QA.md §5）
// 2 行目は日本時間の時刻に合わせたあいさつ（名前は使わない）、最後に短い署名「— <アプリ名> AI 秘書」（アプリ名が無ければ「— AI 秘書」）。
// ここは文面の枠だけを作る。中身（件数・月・日付）は各テンプレートが数値と日付だけで作る。氏名・金額・記録の内容は扱わない。

export const APPROVAL_LABEL = '【承認のお願い】'
export const CONSULT_LABEL = '【ご相談】'
export const REPORT_LABEL = '【定時のご報告】'
export const HELP_LABEL = '【ご案内】'
/** 意図。info 以外（action / urgent / approval / consult）は「▶ お願いしたいこと」で結ぶ。 */
export const INTENTS = Object.freeze(['info', 'action', 'urgent', 'approval', 'consult'])
export const INTENT_LABELS = Object.freeze({ info: '【ご報告】', action: '【対応のお願い】', urgent: '【至急】', approval: APPROVAL_LABEL, consult: CONSULT_LABEL })
/** 秘書のラベルで始まる文（【アプリ名】の付け忘れ判定で「既に【…】で始まる」とみなさない）。 */
export const SECRETARY_LABEL_RE = /^【(ご報告|対応のお願い|至急|承認のお願い|ご相談|定時のご報告|ご案内)】/
export const DEFAULT_INFO_NOTE = 'ご対応は不要です。ご確認だけお願いします。'
export const DEFAULT_ASK = 'リンク先の画面でご確認のうえ、ご対応をお願いします。'
/** 署名のアプリ名の既定（空：「— AI 秘書」）。各プラグインはレジストリのアプリケーション名（app.name）を signatureOf に渡す。 */
export const DEFAULT_SECRETARY_NAME = ''
export const LINK_LEAD = 'こちらから開けます：'

export const normalizeIntent = (intent) => (INTENTS.includes(intent) ? intent : 'info')

/** 1 行目のラベルから意図を引く（【承認のお願い】→ approval、【ご相談】→ consult。【定時のご報告】・ラベル無しは info）。 */
export function intentOfHead(head) {
  const text = String(head ?? '')
  return INTENTS.find((intent) => intent !== 'info' && text.startsWith(INTENT_LABELS[intent])) ?? 'info'
}

/** timeZone の壁時計の時（0〜23）。 */
export function wallHour(nowMs, timeZone = 'Asia/Tokyo') {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now()
  let hour
  try {
    hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))
  } catch {
    hour = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))
  }
  return Number(hour) % 24
}

/**
 * 送る時刻（既定は日本時間）のあいさつ。5:00〜9:59 おはようございます、10:00〜20:59 お疲れさまです、
 * 21:00〜4:59 夜分に失礼します（夜に届くのは、おやすみ時間（通知を控える時間帯）の対象外の通知か、おやすみ時間を設定していない人だけ）。名前は使わない。
 */
export function greetingAt(nowMs, { timeZone = 'Asia/Tokyo' } = {}) {
  const h = wallHour(nowMs, timeZone)
  if (h >= 5 && h < 10) return 'おはようございます。'
  if (h >= 10 && h < 21) return 'お疲れさまです。'
  return '夜分に失礼します。'
}

/**
 * 署名（1 行）：`— <アプリ名> AI 秘書`。アプリ名が無ければ `— AI 秘書`。
 * AI 社員の呼び名（プロフィール、docs/AI_EMPLOYEE_PROFILE.md）があれば `— <呼び名>（<アプリ名> AI 秘書）`（AI であることは常に示す、D8）。
 */
export const signatureOf = (appName, nickname) => {
  const name = String(appName || DEFAULT_SECRETARY_NAME || '').trim()
  const nick = String(nickname ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
  const role = name ? `${name} AI 秘書` : 'AI 秘書'
  return nick ? `— ${nick}（${role}）` : `— ${role}`
}

/** まとめ送信の一言（1 件なら ''）。 */
export const bundleLine = (count) => (Number.isInteger(count) && count > 1 ? `${count} 件まとめてお知らせします。` : '')

/** ISO 時刻 → timeZone の 'MM/DD HH:MM'（読めなければ undefined）。 */
export function monthDayTime(value, timeZone = 'Asia/Tokyo') {
  const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(t)) return undefined
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))
  } catch {
    return undefined
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.month}/${p.day} ${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`
}

/**
 * 1 通の文面を組み立てる。
 * @param input.intent   'info' | 'action' | 'urgent' | 'approval' | 'consult'（それ以外は info）
 * @param input.title    件名（ラベルの後ろ。例：訪問記録の承認待ち）
 * @param input.lead     事実の文（件数・日付だけ）
 * @param input.ask      info 以外：お願いしたいこと（何を・どこで）
 * @param input.due      目安・期限（例：本日中 / 期限 10/28 / 10/26 18:00 まで）。日付を作らない：params にあるものだけ
 * @param input.note     info の結びの一言（既定「ご対応は不要です。ご確認だけお願いします。」）
 * @param input.count    束ねた件数（2 以上なら「N 件まとめてお知らせします」）
 * @returns {{ intent, label, title, text, body, url, lines, signature }}  title = ラベル付きの件名（カードの件名）、
 *   text = あいさつ〜署名、body = 文字だけで送るときの全文（件名・リンク・署名を含む）、
 *   lines = カードの本文の行（署名なし）、signature = 署名（カードでは footer。dsh-im は文字だけのプラットフォームでも
 *   件名 / 本文 / リンク / footer の順に出すので、同じ文を textFallback に重ねない）
 */
export function frameMessage({ intent, title, lead, ask, due, note, url = null, count = 1, now = Date.now(), timeZone = 'Asia/Tokyo', signature, label } = {}) {
  const kind = normalizeIntent(intent)
  const head = `${label ?? INTENT_LABELS[kind]}${title ? String(title) : ''}`
  const hello = greetingAt(now, { timeZone })
  const bundle = bundleLine(count)
  const fact = String(lead ?? '').trim()
  const opening = bundle ? [`${hello}${bundle}`, fact] : [`${hello}${fact}`]
  const close = kind === 'info'
    ? String(note || DEFAULT_INFO_NOTE)
    : `▶ お願いしたいこと${due ? `（${due}）` : ''}：${String(ask || DEFAULT_ASK)}`
  const sign = signature ?? signatureOf()
  const lines = [...opening, close].filter(Boolean)
  return {
    intent: kind,
    label: label ?? INTENT_LABELS[kind],
    title: head,
    text: [...lines, sign].join('\n'),
    body: [head, ...lines, url ? `${LINK_LEAD}${url}` : '', sign].filter(Boolean).join('\n'),
    url: url || null,
    lines,
    signature: sign,
  }
}

/**
 * dsh-im のカード（ボタン無しの通知）：件名・本文（署名なし）・リンク（ボタン）・footer（署名）。textFallback は付けない
 * （dsh-im は Lark（飛書）と文字だけのプラットフォームで textFallback を本文の後ろに足すため、同じ文が 2 回出る）。
 * @param message  frameMessage / frameAiText の返り値（lines・signature が無い古い形は text を本文、body を textFallback に）
 */
export function noticeCard(message, { linkLabel } = {}) {
  const hasLines = Array.isArray(message?.lines)
  const label = linkLabel ?? (message?.intent && message.intent !== 'info' ? '業務 Web を開いて対応' : '業務 Web で確認')
  return {
    title: String(message?.title ?? ''),
    fields: [],
    body: hasLines ? message.lines.join('\n') : String(message?.text ?? ''),
    actions: [],
    ...(message?.url ? { link: { label, url: message.url } } : {}),
    ...(hasLines && message.signature ? { footer: message.signature } : { textFallback: String(message?.body ?? message?.text ?? '') }),
  }
}

/**
 * AI（LLM）が書いた報告を同じ形にそろえる（自動タスクの summary など）。先頭が秘書のラベルならその行を件名にし、
 * 無ければ status（needsDecision → 対応のお願い、それ以外 → ご報告）と fallbackTitle で件名を作る。
 * 本文の前にあいさつ、最後に署名（既にあれば足さない）。本文の中身は変えない。
 */
export function frameAiText(text, { status, fallbackTitle = '', now = Date.now(), timeZone = 'Asia/Tokyo', signature } = {}) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim()
  const sign = signature ?? signatureOf()
  let head
  let rest
  if (SECRETARY_LABEL_RE.test(raw)) {
    const nl = raw.indexOf('\n')
    head = (nl < 0 ? raw : raw.slice(0, nl)).trim()
    rest = nl < 0 ? '' : raw.slice(nl + 1).trim()
  } else {
    head = `${INTENT_LABELS[status === 'needsDecision' ? 'action' : 'info']}${fallbackTitle}`
    rest = raw
  }
  // AI が署名まで書いていたら外して、最後に 1 回だけ付ける
  rest = rest.split('\n').filter((line) => line.trim() !== sign).join('\n').trim()
  // AI が自分であいさつを書いていたら重ねない
  const hello = /^(おはようございます|お疲れさまです|お疲れ様です|夜分に失礼します|こんにちは|こんばんは)/.test(rest) ? '' : greetingAt(now, { timeZone })
  // 本文が「▶ お願いしたいこと」から始まるときは、あいさつを 1 行にする
  const lines = !rest ? [hello || greetingAt(now, { timeZone })] : rest.startsWith('▶') && hello ? [hello, rest] : [`${hello}${rest}`]
  const intent = intentOfHead(head)
  return { intent, title: head, text: [...lines, sign].join('\n'), body: [head, ...lines, sign].join('\n'), lines, signature: sign, url: null }
}
