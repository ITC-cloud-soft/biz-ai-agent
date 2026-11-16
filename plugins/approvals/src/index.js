import {
  APPROVAL_LABEL, BridgeApiError, appNickname, DEFAULT_APPLICATION_ID, DEFAULT_PLATFORM_PRIORITY, INTENT_LABELS, MAX_REQUEST_PLATFORMS, NOTIFY_ONLY_PLATFORMS, apiSource, appPath,
  V1_PATHS, applicationOfEvent, cfg, classifyDeliveryError, fallbackRegistry, createBotResolver, greetingAt, loadSchemastery, makeLogger, monthDayTime,
  normalizeText, onDispose, openDomain, registryGetter, scopedKey, signatureOf, singleApplicationRegistry, watchRegistry, whenServices,
} from '@dsh-bridge/dsh-core'

/**
 * bridge-approvals — 業務システムの承認依頼を IM に届け、ボタン／文字返信で決定する（DSH Business Bridge の汎用プラグイン）。
 *
 * 流れ（経路はレジストリの paths。既定は Bridge v1）
 *   approval.requested → POST /bridge/v1/approvals/:id/deliveries（ボットのあるプラットフォームを優先順に）
 *     → ctx.dshIm.sendCard（idempotencyKey = approval:<id>:<userId>、ボタン actionId = bridge_approval:approve|reject:<deliveryId>）
 *   ボタン（onAction 'bridge_approval:'）→ POST /bridge/v1/approvals/:id/im-decision（token）
 *   返信「承認 123456」「差戻 123456 理由」（claimReplies。語は設定 replyWords）→ POST /bridge/v1/approvals/im-decisions
 *     （replyCode。承認 ID と本人照合は業務システムが行う）→ 結果を返信 → updateCard
 *   approval.decided（approved=executed / rejected / cancelled）/ approval.expired → 関連カードを全部 updateCard
 *
 * 秘密の扱い
 *   card token と replyCode はこのプラグインの内部マップ（と DSH のストレージサービスの domain bridge_approvals）にだけ置く。
 *   ボタンの value は deliveryId のみ。token はボタンにも LLM 文脈にも入れない。決定・期限切れで消去する。
 *
 * 複数アプリケーション（@dsh-bridge/dsh-core のレジストリ ctx.bridgeApps）
 *   承認イベントの applicationId（bridge-events が付ける）のアプリケーションの API で送付先を発行し、そのアプリケーションのボット
 *   （プラットフォームごと。他のアプリケーションのボットは使わない）からカードを送り、決定もそのアプリケーションの API に送る。
 *   card token / replyCode は発行したアプリケーションにしか送らない：ボタンはカードを送ったボットか同じアプリケーションの
 *   ボットからの操作だけ受け付け、返信コードは手元の記録でコードを発行したアプリケーションを確かめる（別のアプリケーションの
 *   ボットに送られたコードは送らずに断る）。既定のアプリケーションは保存キー（承認 ID）・ボタン ID・冪等キーにアプリケーション ID を
 *   含めない。他は保存キーとボタン ID（bridge_approval:approve:<applicationId>/<deliveryId>）・冪等キーに含める。
 *
 * 文面（AI 秘書）
 *   依頼カード：件名【承認のお願い】<何の承認か（種類だけ）>、本文はあいさつ・お願いしたいこと（期限は expiresAt があるときだけ）・
 *   各ボタンで何が起きるか・署名（— <アプリ名> AI 秘書）。項目（承認ID・期限など）は業務システムが決めたもの。業務システムの本文は
 *   「ご参考」として残す（showBusinessBody: false で出さない：本文が操作の説明だけのアプリケーション向け）。
 *   決定・期限切れ・取消・送り直しで更新したカード：件名【ご報告】<元の件名>（状態）、本文は結果と「ご対応は不要です」など。
 *   業務システムはカードに任意の文面 `wording`（cardWording：lead / ask / buttons / replies / statusBody）を付けられる。
 *   付いていればその承認だけ、あいさつの後の一文・お願いしたいこと・各ボタンの説明・ボタン／返信の結果の返事・更新したカードの
 *   本文をその文にする（例：ケアビリングの給与発行「この内容で給与明細を発行し、職員のみなさんにお知らせします」）。無ければ既定の文。
 */

export const name = 'bridge-approvals'
export const inject = ['dshIm', 'storageDomain']

export const SERVICE = 'bridgeApprovals'
export const ACTION_PREFIX = 'bridge_approval:'
export const ACTION_RE = /^bridge_approval:(approve|reject):(.+)$/
const ACTION_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}:$/

/**
 * ボタン ID の接頭辞（設定 actionPrefix。既定 bridge_approval:）。末尾の「:」は省略可。
 * 別の接頭辞で送ったカードが残っている導入先（移行前の自前のプラグイン）で、そのボタンを引き続き受け付けるために変える。
 */
export function actionPrefixOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ACTION_PREFIX
  const prefix = raw.endsWith(':') ? raw : `${raw}:`
  if (!ACTION_PREFIX_RE.test(prefix)) throw new TypeError(`bridge-approvals: invalid actionPrefix ${JSON.stringify(raw)}`)
  return prefix
}

/** その接頭辞のボタン ID（<prefix>approve|reject:<target>）の正規表現。 */
export function actionPattern(prefix = ACTION_PREFIX) {
  // 接頭辞は英数字・_・.・- と末尾の : だけ（actionPrefixOf が確かめる）。正規表現で意味を持つのは . だけ
  return new RegExp(`^${actionPrefixOf(prefix).replace(/\./g, '\\.')}(approve|reject):(.+)$`)
}
export const DEFAULT_REPLY_WORDS = Object.freeze({ approve: Object.freeze(['承認']), reject: Object.freeze(['差戻']) })

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordList = (list, fallback) => {
  const words = (Array.isArray(list) ? list : []).map((w) => String(w ?? '').normalize('NFKC').trim()).filter(Boolean)
  return words.length ? words : [...fallback]
}

/**
 * 文字返信「<承認語> 123456」「<差戻語> 123456 理由」の解釈（語は設定 replyWords。全角数字・全角スペースは normalizeText 後に照合）。
 * @returns {{ re: RegExp, words: {approve: string[], reject: string[]}, parse: (text: string) => ({action, code, comment}|null) }}
 */
export function replyMatcher(words = DEFAULT_REPLY_WORDS) {
  const approve = wordList(words?.approve, DEFAULT_REPLY_WORDS.approve)
  const reject = wordList(words?.reject, DEFAULT_REPLY_WORDS.reject)
  // 理由の前の空白は無くてもよい（「差戻123456金額違い」）。7 桁目以降の数字は番号の続きとみなし、照合しない
  const re = new RegExp(`^(${[...approve, ...reject].map(escapeRe).join('|')})\\s*(\\d{6})(?!\\d)(?:\\s*(.+))?$`, 'i')
  const approveSet = new Set(approve.map((w) => w.toLowerCase()))
  return {
    re,
    words: { approve, reject },
    parse(text) {
      const m = re.exec(normalizeText(text))
      if (!m) return null
      return { action: approveSet.has(m[1].toLowerCase()) ? 'approve' : 'reject', code: m[2], comment: m[3]?.trim() || undefined }
    },
  }
}
export const REPLY_RE = replyMatcher().re
const APPROVAL_TYPES = ['approval.requested', 'approval.decided', 'approval.expired']
export const DOMAIN = 'bridge_approvals'
const RETENTION_MS = 7 * 24 * 3600_000
/** 「差戻」を押した後、次の文を理由として待つ時間（B-028）。 */
const REASON_WAIT_MS = 10 * 60_000
const CANCEL_WORDS = new Set(['取消', '取り消し', '取消し', 'キャンセル', 'やめる', 'cancel'])

export const MSG = {
  approved: '承認しました。ありがとうございます。結果はカードにも反映します。',
  rejected: '差戻しました。ありがとうございます。理由とともに申請者へ戻します。',
  reasonDialogTitle: '差戻しの理由',
  reasonDialogLabel: '差戻しの理由を入力してください',
  reasonCancelled: '差戻しを取りやめました。依頼はそのまま残っています。',
  askReason: (code, w = DEFAULT_REPLY_WORDS) =>
    `差戻しの理由を、このチャットにそのまま送ってください（10 分以内）。やめるときは「取消」と送ってください。\n（「${w.reject[0]} ${code} 理由」の形で送っても差戻しできます。例：${w.reject[0]} ${code} 金額を確認してください）`,
  reasonRequired: (code, w = DEFAULT_REPLY_WORDS) =>
    `差戻しには理由が必要です。番号のあとに理由を続けて送ってください。\n例：${w.reject[0]} ${code} 金額を確認してください`,
  reasonInputLabel: '差戻しの理由',
  reasonInputPlaceholder: '例：金額を確認してください',
  notFound: 'この承認依頼は見つかりませんでした。既に処理済みか期限切れの可能性があります。業務Webをご確認ください。',
  notYours: 'この承認依頼はあなた宛てではありません。',
  unknownAction: '不明な操作です。',
  finished: {
    approved: 'この承認依頼は既に承認されています。',
    rejected: 'この承認依頼は既に差戻されています。',
    cancelled: 'この承認依頼は取り消されました。',
    expired: 'この承認依頼は期限切れです。',
    decided: 'この承認依頼は既に処理済みです。',
  },
  code: {
    token_or_reply_code_required: '入力内容に誤りがあります（ボタンまたは返信コードが必要です）。',
    comment_required: '差戻しには理由が必要です。',
    identity_not_linked: 'このアカウントは職員と連携されていません。業務Webで SNS 連携をしてください。',
    delivery_not_found: 'この承認依頼の送付先が見つかりません。業務Webをご確認ください。',
    identity_mismatch: 'この承認依頼はあなた宛てではありません。',
    invalid_reply_code: (remaining) => `返信コードが正しくありません。${Number.isInteger(remaining) ? `（あと ${remaining} 回まで）` : ''}`,
    role_not_permitted: 'この承認に必要な役割を持っていないため、決定できません。',
    self_approval_forbidden: '申請者本人は承認・差戻しできません。',
    delivery_locked: '返信コードの誤りが続いたため、この依頼は IM から操作できなくなりました。業務Webで操作してください。',
    too_many_attempts: '試行回数が多すぎます。しばらく時間をおいてから再度お試しください。',
    delivery_used: 'このボタン・返信コードは既に使用されています。',
    delivery_revoked: 'この依頼は無効になりました（他の方が決定したか、取り消されました）。',
    expired: '承認の期限が切れています。業務Webをご確認ください。',
    delegation_not_permitted: 'システム設定の問題で処理できませんでした。管理者に連絡してください。',
  },
  error: {
    unreachable: '業務システムに接続できませんでした。時間をおいて再度お試しください。',
    badRequest: '入力内容に誤りがあります。',
    commentRequired: '差戻しには理由が必要です。',
    unauthorized: 'システム設定の問題で処理できませんでした（認証エラー）。管理者に連絡してください。',
    forbidden: 'この承認を行う権限がありません（申請者本人、または必要な役割を持たない場合は決定できません）。',
    notFound: 'この承認依頼は見つかりません。',
    conflict: 'この承認依頼は既に処理済みです。',
    gone: '承認の期限が切れているか、このボタン・コードは既に使用されています。',
    server: '業務システムでエラーが発生しました。時間をおいて再度お試しください。',
  },
  footer: (code, w = DEFAULT_REPLY_WORDS) => `文字で返信する場合：「${w.approve[0]} ${code}」／「${w.reject[0]} ${code} 理由」`,
  statusFooter: {
    approved: '状態：承認済み',
    rejected: '状態：差戻し済み',
    expired: '状態：期限切れ',
    cancelled: '状態：取消',
    replaced: '状態：無効（送り直し済み）',
  },
  /** 更新したカードの件名の（状態）。 */
  statusLabel: { approved: '承認済み', rejected: '差戻し済み', expired: '期限切れ', cancelled: '取消', replaced: '無効', decided: '処理済み' },
  /** 更新したカードの本文（結果と、まだ何かすることがあるか）。 */
  statusBody: {
    approved: 'この承認依頼は承認されました。ご対応は不要です。',
    rejected: 'この承認依頼は差し戻されました。申請者に戻っていますので、ご対応は不要です。',
    expired: 'この承認依頼は期限が切れました。必要な場合は、業務Webから依頼し直してください。',
    cancelled: 'この承認依頼は取り消されました。ご対応は不要です。',
    replaced: 'この依頼は別の連絡先に送り直されました。新しいメッセージから操作してください。',
    decided: 'この承認依頼は処理済みです。ご対応は不要です。',
  },
  /** 依頼カードの本文。 */
  request: {
    lead: (what) => `${what ? `${what}の` : ''}承認をお願いします。`,
    ask: (deadline, w = DEFAULT_REPLY_WORDS) => `▶ お願いしたいこと${deadline ? `（期限 ${deadline}）` : ''}：内容を確認し、「${w.approve[0]}」か「${w.reject[0]}」を選んでください。`,
    buttons: (w = DEFAULT_REPLY_WORDS) => [`・${w.approve[0]}：この内容で確定します`, `・${w.reject[0]}：理由を添えて申請者に戻します`],
  },
  detailLink: '業務Webで詳細を見る',
  noApplication: 'このボットはどの業務システムにも割り当てられていません。管理者に連絡してください。',
}

const WORDING_MAX = 300
const wordingText = (value) => {
  const t = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return t && t.length <= WORDING_MAX ? t : undefined
}
const wordingPick = (obj, keys) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const out = Object.fromEntries(keys.map((k) => [k, wordingText(obj[k])]).filter(([, x]) => x !== undefined))
  return Object.keys(out).length ? out : undefined
}

/**
 * 業務システムのカードの任意の文面（card.wording）→ 使う項目だけの文字列（1 項目 300 字まで、それ以外・空は捨てる）。何も無ければ null。
 *   lead：あいさつの後の一文（既定「<何の>の承認をお願いします。」）／ ask：「▶ お願いしたいこと（期限）：」の後ろ
 *   buttons.approve / reject：各ボタンで何が起きるか（「・承認：」の後ろ）／ replies.approved / rejected：ボタン・文字返信の結果の返事
 *   statusBody.approved / rejected / expired / cancelled：決定などで更新したカードの本文
 */
export function cardWording(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {
    lead: wordingText(raw.lead),
    ask: wordingText(raw.ask),
    buttons: wordingPick(raw.buttons, ['approve', 'reject']),
    replies: wordingPick(raw.replies, ['approved', 'rejected']),
    statusBody: wordingPick(raw.statusBody, ['approved', 'rejected', 'expired', 'cancelled']),
  }
  const kept = Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined))
  return Object.keys(kept).length ? kept : null
}

/** 業務システムのカード件名 → 何の承認か（'修理依頼の承認依頼' / '修理依頼の承認' → '修理依頼'。種類だけ。無ければ ''）。 */
export function approvalSubject(title) {
  return String(title ?? '').trim().replace(/[【】]/g, '').replace(/の?承認(依頼)?$/, '').slice(0, 40)
}

/**
 * 既定の配信先の優先順位：dsh-im が対応するプラットフォームすべて（Lark（飛書）を含む）。email は通知専用のプラットフォーム（送信者を検証できない）なので
 * 承認依頼には使わない（設定にあっても外す）。
 */
export const DEFAULT_PLATFORMS = Object.freeze([...DEFAULT_PLATFORM_PRIORITY])

const z = await loadSchemastery()
export const Config = z
  ? z.object({
      apiUrl: z.string().description('業務 API の URL（bridge-apps のレジストリが無いときだけ使う。Bridge v1 の経路）'),
      serviceToken: z.string().role('secret').description('業務 API のサービストークン（同上）'),
      applicationName: z.string().description('レジストリが無いときのアプリケーションの表示名（署名に使う）'),
      platformPriority: z.array(z.string()).default([...DEFAULT_PLATFORMS])
        .description('承認依頼を届ける配信先の優先順位（先頭ほど優先。ボットのあるプラットフォームの上位 10 件を渡し、業務システムが各承認者の連携済み最優先のプラットフォームを 1 つ選ぶ。email は使わない）'),
      bots: z.dict(z.string()).default({}).description('プラットフォーム → botId。未指定なら dsh-im の listBots() からプラットフォームが一致する最初の bot'),
      webUrl: z.string().description('業務Web の承認画面 URL（{id} を承認 ID に置換）。例: https://app.example.test/approvals/{id}'),
      showBusinessBody: z.boolean().default(true).description('業務システムのカード本文を「ご参考」として出す（本文が操作の説明だけなら false）'),
      replyWords: z.object({
        approve: z.array(z.string()).description('承認の語（既定 承認）'),
        reject: z.array(z.string()).description('差戻の語（既定 差戻）'),
      }).description('文字返信の語（「承認 123456」「差戻 123456 理由」）とボタンの表示名'),
      messages: z.dict(z.string()).default({}).description('業務システムのエラーコード → 返事の文の上書き（identity_not_linked など。MSG.code の項目）'),
      actionPrefix: z.string().description('ボタン ID の接頭辞（既定 bridge_approval:）。以前の接頭辞で送ったカードを受け付け続けるときだけ変える（再起動が要る）'),
      stateDomain: z.string().description(`送付記録を保存する DSH のストレージサービスの domain 名（既定 ${DOMAIN}）。別の名前で動いていた導入先の記録を引き継ぐときだけ変える`),
      applications: z.dict(z.object({
        platformPriority: z.array(z.string()).description('このアプリケーションの配信先の優先順位（既定は上の platformPriority）'),
        bots: z.dict(z.string()).description('プラットフォーム → botId（このアプリケーションのボット）'),
        webUrl: z.string().description('このアプリケーションの承認画面 URL（{id} を承認 ID に置換）'),
        showBusinessBody: z.boolean().description('このアプリケーションの業務システムのカード本文を出すか'),
      })).default({}).description('既定以外のアプリケーションごとの上書き（キーはアプリケーション ID）'),
    })
  : undefined

/**
 * 業務システムのエラー → 利用者向けの日本語。
 * @param overrides  エラーコード → 文（設定 messages。MSG.code の文字列の項目を置き換える。invalid_reply_code は残り回数を後ろに付ける）
 */
export function decisionErrorMessage(error, overrides = {}) {
  const status = error instanceof BridgeApiError ? error.status : (error?.status ?? 0)
  const code = error?.code ?? ''
  const own = overrides && typeof overrides === 'object' && typeof overrides[code] === 'string' && overrides[code] ? overrides[code] : null
  if (code === 'invalid_reply_code') {
    const remaining = error?.body?.remainingAttempts
    return own ? `${own}${Number.isInteger(remaining) ? `（あと ${remaining} 回まで）` : ''}` : MSG.code.invalid_reply_code(remaining)
  }
  if (own) return own
  if (typeof MSG.code[code] === 'string') return MSG.code[code]
  if (code.startsWith('already_')) {
    const st = normalizeStatus(code.slice('already_'.length))
    return MSG.finished[st] ?? MSG.finished.decided
  }
  if (status === 0) return MSG.error.unreachable
  if (status === 429) return MSG.code.too_many_attempts
  if (status === 400 || status === 422) return code === 'comment_required' ? MSG.error.commentRequired : MSG.error.badRequest
  if (status === 401) return MSG.error.unauthorized
  if (status === 403) return MSG.error.forbidden
  if (status === 404) return MSG.error.notFound
  if (status === 409) return MSG.error.conflict
  if (status === 410) return MSG.error.gone
  return MSG.error.server
}

function sameUser(source, delivery) {
  if (!source || !delivery) return false
  if (String(source.platform) !== String(delivery.platform)) return false
  if (String(source.userId) !== String(delivery.externalId)) return false
  if (delivery.teamId && source.teamId && String(source.teamId) !== String(delivery.teamId)) return false
  return true
}

/** 業務システムの承認状態 → カード表示の状態（approve の確定は executed）。 */
export function normalizeStatus(raw) {
  const s = String(raw ?? '').toLowerCase()
  if (s.startsWith('reject')) return 'rejected'
  if (s.startsWith('cancel') || s === 'void' || s === 'voided') return 'cancelled'
  if (s.startsWith('expire')) return 'expired'
  if (s === 'executed' || s.startsWith('approv')) return 'approved'
  return 'decided'
}

// link：承認する本人として業務 Web を開くリンク（業務システムが delivery ごとに返したもの）。token と同じく秘密として扱う
function withoutSecrets({ token, replyCode, link, ...rest }) {
  return rest
}

/** 業務システムが delivery に付けた本人用のリンク（http/https の絶対 URL だけ）。無ければ null。 */
function personalLink(value) {
  if (typeof value !== 'string' || value.length > 2000) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

const APP_ID_RE = /^[a-z][a-z0-9-]{1,62}$/
/** ボタン ID の末尾（deliveryId、既定以外は <applicationId>/<deliveryId>）。 */
export function parseActionTarget(rest) {
  const text = String(rest ?? '')
  const slash = text.indexOf('/')
  if (slash > 0 && APP_ID_RE.test(text.slice(0, slash))) return { applicationId: text.slice(0, slash), deliveryId: text.slice(slash + 1) }
  return { applicationId: null, deliveryId: text }
}

function memoryTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => map.delete(key),
    persistent: false,
  }
}

/**
 * ctx に依存しない本体。
 * @param deps.registry  アプリケーションレジストリ（@dsh-bridge/dsh-core。関数なら呼び出しごとに評価）
 * @param deps.api       レジストリの代わりに API クライアント 1 つ（1 アプリケーション・Bridge v1 の経路。単体テスト・組み込み）
 * @param deps.table     { get, entries, put, delete }（storage-domain の KvTable 互換）
 * @param deps.applicationOptions  (applicationId) => { platformPriority?, bots?, webUrl?, showBusinessBody? }（既定以外のアプリケーション）
 * @param deps.replyWords  () => { approve: string[], reject: string[] }（文字返信の語とボタンの表示名）
 * @param deps.showBusinessBody  () => boolean（業務システムのカード本文を「ご参考」として出すか。既定 true）
 */
export function createApprovalsIm({
  api,
  registry = null,
  dshIm,
  table,
  logger = console,
  platformPriority = () => [...DEFAULT_PLATFORMS],
  bots = () => ({}),
  webUrl = () => '',
  applicationOptions = () => ({}),
  replyWords = () => DEFAULT_REPLY_WORDS,
  showBusinessBody = () => true,
  applicationName = 'business',
  actionPrefix = ACTION_PREFIX,
  messages = () => ({}),
  now = Date.now,
}) {
  const buttonPrefix = actionPrefixOf(actionPrefix)
  const buttonRe = actionPattern(buttonPrefix)
  const single = api ? singleApplicationRegistry(api, { id: DEFAULT_APPLICATION_ID, name: applicationName, label: 'business API', namespace: 'app', paths: V1_PATHS }) : null
  let matcherFor = null
  let matcher = null
  /** いまの設定の返信の解釈（設定の変更に追随）。 */
  const replies = () => {
    const words = replyWords() ?? DEFAULT_REPLY_WORDS
    const key = JSON.stringify(words)
    if (key !== matcherFor) { matcher = replyMatcher(words); matcherFor = key }
    return matcher
  }
  const getRegistry = single ? () => single : registryGetter(registry)
  const defaultId = () => getRegistry()?.default?.()?.id ?? DEFAULT_APPLICATION_ID
  const isDefault = (applicationId) => !applicationId || applicationId === defaultId()
  const appIdOf = (record) => record?.applicationId ?? defaultId()
  const appById = (applicationId) => (isDefault(applicationId) ? getRegistry()?.default?.() ?? null : getRegistry()?.get?.(applicationId) ?? null)
  const recordKey = (applicationId, approvalId) => scopedKey(applicationId, defaultId(), approvalId)
  const indexKey = (applicationId, deliveryId) => `${isDefault(applicationId) ? '' : applicationId}\u0001${deliveryId}`
  const byDelivery = new Map() // indexKey(app, deliveryId) -> record key
  const resolver = createBotResolver({ dshIm, registry: getRegistry, logger, label: 'bridge-approvals' })
  const stats = { sent: 0, deduped: 0, decisions: 0, updates: 0, updatesUndeliverable: 0, lastError: null, lastErrorAt: null }

  function index(record, key = recordKey(record.applicationId, record.approvalId)) {
    for (const d of record.deliveries ?? []) {
      if (!d.token && !d.replyCode) continue
      byDelivery.set(indexKey(record.applicationId, d.deliveryId), key)
    }
  }

  function unindex(record) {
    for (const d of record.deliveries ?? []) {
      byDelivery.delete(indexKey(record.applicationId, d.deliveryId))
    }
  }

  for (const [key, record] of table.entries()) index(record, key)

  function noteError(error) {
    stats.lastError = error instanceof Error ? error.message : String(error)
    stats.lastErrorAt = new Date(now()).toISOString()
  }

  /** アプリケーションごとの設定（既定のアプリケーションは従来の直下の設定）。 */
  function optionsFor(applicationId) {
    const o = applicationOptions(applicationId) ?? {}
    const body = typeof o.showBusinessBody === 'boolean' ? o.showBusinessBody : showBusinessBody() !== false
    if (isDefault(applicationId)) return { platformPriority: platformPriority(), bots: bots() ?? {}, webUrl: webUrl(), showBusinessBody: body }
    const list = Array.isArray(o.platformPriority) && o.platformPriority.length ? o.platformPriority.map(String) : platformPriority()
    return { platformPriority: list, bots: o.bots && typeof o.bots === 'object' ? o.bots : {}, webUrl: typeof o.webUrl === 'string' ? o.webUrl : '', showBusinessBody: body }
  }

  /**
   * そのアプリケーションの送信ボット（プラットフォームごと）→ { botId, shared } | null。preferred = 承認者が連携に使ったボット
   * （個人 WeChat・複数の Slack ワークスペース・QQ のボットごとの openid・LINE のプロバイダ：宛先 ID はそのボットでしか通じない）。
   */
  async function botFor(app, platform, preferred) {
    return resolver.resolve(app, platform, { preferred, configured: optionsFor(app.id).bots })
  }

  /** カードのリンク：業務システムが delivery に付けた本人用のリンク（delivery.link）、無ければ設定の webUrl。 */
  function link(applicationId, approvalId, delivery = null) {
    const own = personalLink(delivery?.link)
    if (own) return { label: MSG.detailLink, url: own }
    const template = optionsFor(applicationId).webUrl
    if (!template) return undefined
    return { label: MSG.detailLink, url: template.includes('{id}') ? template.replaceAll('{id}', encodeURIComponent(approvalId)) : template }
  }

  /** 署名（そのアプリケーションの AI 秘書。AI 社員の呼び名があれば「— <呼び名>（<アプリ名> AI 秘書）」）。 */
  const signatureFor = (applicationId) => {
    const app = appById(applicationId)
    return signatureOf(app?.name ?? applicationId, appNickname(app, undefined))
  }

  /**
   * 依頼カードの本文の行（AI 秘書。署名は除く）：あいさつと何の承認か / お願いしたいこと（期限は expiresAt があるときだけ）/
   * ボタンの説明 / 業務システムの本文を「ご参考」として（showBusinessBody）。氏名・金額は書かない（項目は業務システムが決める）。
   */
  function requestLines(applicationId, base, expiresAt) {
    const what = approvalSubject(base.title)
    const deadline = expiresAt ? monthDayTime(expiresAt) : undefined
    const words = replies().words
    const w = base.wording ?? {}
    const lines = [
      `${greetingAt(now())}${w.lead ?? MSG.request.lead(what)}`,
      w.ask ? `▶ お願いしたいこと${deadline ? `（期限 ${deadline}）` : ''}：${w.ask}` : MSG.request.ask(deadline, words),
      ...(w.buttons
        ? [w.buttons.approve ? `・${words.approve[0]}：${w.buttons.approve}` : MSG.request.buttons(words)[0], w.buttons.reject ? `・${words.reject[0]}：${w.buttons.reject}` : MSG.request.buttons(words)[1]]
        : MSG.request.buttons(words)),
    ]
    // 業務システムの本文は補足として残す（本文が操作の説明だけのアプリケーションは showBusinessBody: false。ここで言い直している）
    if (base.body && optionsFor(applicationId).showBusinessBody) lines.push(`ご参考：${String(base.body)}`)
    return lines
  }

  /**
   * 依頼カード：件名・項目・本文（あいさつ〜ボタンの説明）・ボタン・リンク・footer（返信コードの案内と署名）。
   * dsh-im はボタンの無いプラットフォームでも 件名 / 項目 / 本文 / リンク / footer を出すので、textFallback に同じ文を重ねない
   * （返信コードの案内は footer にあるので、ボタンが押せないプラットフォームでも文字で決定できる）。
   */
  function requestCard(applicationId, approvalId, base, delivery, expiresAt = null) {
    // 既定以外のアプリケーションはボタン ID にアプリケーションを含める（deliveryId はアプリケーションごとの名前空間）
    const target = isDefault(applicationId) ? delivery.deliveryId : `${applicationId}/${delivery.deliveryId}`
    const what = approvalSubject(base.title)
    const card = {
      title: `${APPROVAL_LABEL}${what || '承認依頼'}`,
      fields: Array.isArray(base.fields) ? base.fields.map((f) => ({ label: String(f.label), value: String(f.value) })) : [],
      body: requestLines(applicationId, base, expiresAt).join('\n'),
      actions: [
        { id: `${buttonPrefix}approve:${target}`, label: replies().words.approve[0], style: 'primary', value: delivery.deliveryId },
        // input：カードに理由の入力欄を持てるチャネル（Teams・Lark）は、差戻のボタンと一緒に入力欄を出す
        {
          id: `${buttonPrefix}reject:${target}`, label: replies().words.reject[0], style: 'danger', value: delivery.deliveryId,
          input: { label: MSG.reasonInputLabel, placeholder: MSG.reasonInputPlaceholder },
        },
      ],
      footer: `${MSG.footer(delivery.replyCode, replies().words)}\n${signatureFor(applicationId)}`,
    }
    const l = link(applicationId, approvalId, delivery)
    if (l) card.link = l
    return card
  }

  /**
   * 決定・期限切れ・取消・送り直しで更新するカード（【ご報告】。ボタンは消す）。delivery があればその本人用のリンク
   * （送り直しで無効にするカードは delivery を渡さない：設定の webUrl）。
   */
  function finalCard(applicationId, approvalId, base, status, delivery = null) {
    const what = approvalSubject(base?.title)
    const card = {
      title: `${INTENT_LABELS.info}${what ? `${what}の承認依頼` : '承認依頼'}（${MSG.statusLabel[status] ?? MSG.statusLabel.decided}）`,
      fields: Array.isArray(base?.fields) ? base.fields : [],
      body: base?.wording?.statusBody?.[status] ?? MSG.statusBody[status] ?? MSG.statusBody.decided,
      actions: [],
      footer: `${MSG.statusFooter[status] ?? MSG.finished.decided}\n${signatureFor(applicationId)}`,
    }
    const l = link(applicationId, approvalId, delivery)
    if (l) card.link = l
    return card
  }

  async function sendDelivery(app, approvalId, delivery, idempotencyKey, expiresAt = null) {
    const sent = await dshIm.sendCard({
      botId: delivery.botId,
      to: { userId: delivery.externalId },
      card: requestCard(app.id, approvalId, delivery.card, delivery, expiresAt),
      idempotencyKey,
      // 既定以外のアプリケーション・共用ボットの送信には applicationId を添える（dsh-im の窓口内切り替え用。上流は無視する）
      ...(!isDefault(app.id) || delivery.shared ? { applicationId: app.id } : {}),
    })
    return sent ?? {}
  }

  async function onRequested(app, approvalId, event) {
    const defaultApp = isDefault(app.id)
    const key = recordKey(app.id, approvalId)
    const existing = table.get(key)
    if (existing?.status && existing.status !== 'requested') return
    let record = existing ?? {
      approvalId,
      ...(defaultApp ? {} : { applicationId: app.id }),
      status: 'requested',
      requestedAt: event?.at ?? new Date(now()).toISOString(),
      expiresAt: event?.payload?.expiresAt ?? null,
      deliveries: [],
    }
    // bot のあるプラットフォームだけを優先順で渡す（業務システムが職員ごとに最優先の連携先のプラットフォームで 1 件だけ発行）
    const platforms = []
    for (const platform of optionsFor(app.id).platformPriority) {
      if (platforms.includes(platform) || NOTIFY_ONLY_PLATFORMS.includes(platform)) continue
      if (await botFor(app, platform)) platforms.push(platform)
      else logger.warn('bridge-approvals: no bot for platform %s; excluded', platform)
    }
    if (platforms.length === 0) {
      logger.warn('bridge-approvals: no deliverable platform for approval %s', approvalId)
      return
    }
    let res
    try {
      res = await app.api.post(appPath(app, 'approvalDeliveries', { approvalId }), { platforms: platforms.slice(0, MAX_REQUEST_PLATFORMS) })
    } catch (error) {
      if (error instanceof BridgeApiError && [404, 409, 410].includes(error.status)) {
        logger.info('bridge-approvals: approval %s no longer deliverable (%s)', approvalId, error.status)
        return
      }
      throw error
    }
    for (const d of Array.isArray(res.deliveries) ? res.deliveries : []) {
      const userId = String(d.user?.id ?? '')
      const platform = String(d.identity?.platform ?? '')
      if (!userId || !platform) continue
      let current = record.deliveries.find((x) => x.userId === userId && !x.revoked)
      if (current && current.deliveryId === String(d.deliveryId)) {
        if (current.sentAt) continue // 既に送付済み（reused）
        // 前回は記録だけ保存して送付前に失敗した：同じ delivery を送り直す
        unindex({ deliveries: [current] })
        record = { ...record, deliveries: record.deliveries.filter((x) => x !== current) }
        current = undefined
      }
      const chosen = await botFor(app, platform, d.identity?.botId)
      if (!chosen?.botId) {
        logger.warn('bridge-approvals: %s chose platform %s but no bot is available', app.label, platform)
        continue
      }
      const delivery = {
        deliveryId: String(d.deliveryId),
        userId,
        platform,
        teamId: d.identity?.teamId || null,
        externalId: String(d.identity?.externalId ?? ''),
        botId: chosen.botId,
        ...(chosen.shared ? { shared: true } : {}),
        token: d.token,
        replyCode: String(d.replyCode ?? ''),
        ...(personalLink(d.link) ? { link: personalLink(d.link) } : {}),
        card: { title: d.card?.title, fields: d.card?.fields ?? [], body: d.card?.body, ...(cardWording(d.card?.wording) ? { wording: cardWording(d.card?.wording) } : {}) },
        messageRef: null,
        sentAt: null,
      }
      if (!delivery.externalId) continue
      // プラットフォームの変更などで以前の delivery が無効にされた（旧 token は 409 delivery_revoked）
      let deliveries = record.deliveries
      if (current) {
        if (current.messageRef) {
          try {
            await dshIm.updateCard(current.messageRef, finalCard(app.id, approvalId, current.card, 'replaced'))
          } catch (error) {
            logger.warn('bridge-approvals: could not mark replaced card: %s', error?.message ?? error)
          }
        }
        unindex({ deliveries: [current] })
        deliveries = deliveries.map((x) => (x === current ? { ...withoutSecrets(x), revoked: true, updatedFor: 'replaced' } : x))
      }
      // 送付前に保存・索引する：カードが届いた直後のボタン操作・返信でも delivery を引けるように。
      record = { ...record, deliveries: [...deliveries, delivery] }
      await table.put(key, record)
      index(record, key)
      const baseKey = defaultApp ? `approval:${approvalId}:${userId}` : `approval:${app.id}:${approvalId}:${userId}`
      // 期限（カードの「お願いしたいこと」に出す）：送付先の期限、無ければ承認イベントの期限。どちらも無ければ出さない
      const expiresAt = d.expiresAt ?? record.expiresAt ?? null
      let sent = await sendDelivery(app, approvalId, delivery, current ? `${baseKey}:${delivery.deliveryId}` : baseKey, expiresAt)
      if (sent.deduped) {
        stats.deduped += 1
        // 状態を失って再処理した場合：reused なら IM 上のカードと同じ delivery なので記録だけ戻す。
        // reused でなければ IM 上のカードは古い token を持つので、delivery ごとのキーで送り直す。
        if (!d.reused && !current) sent = await sendDelivery(app, approvalId, delivery, `${baseKey}:${delivery.deliveryId}`, expiresAt)
      }
      if (!sent.deduped) stats.sent += 1
      const sentDelivery = { ...delivery, messageRef: sent.messageRef ?? null, sentAt: new Date(now()).toISOString() }
      record = { ...record, deliveries: record.deliveries.map((x) => (x.deliveryId === delivery.deliveryId && !x.revoked ? sentDelivery : x)) }
      await table.put(key, record)
      index(record, key)
      if (sentDelivery.messageRef && !sent.deduped) {
        Promise.resolve()
          .then(() => app.api.post(appPath(app, 'approvalDeliverySent', { approvalId, deliveryId: delivery.deliveryId }), { messageRef: sentDelivery.messageRef }))
          .catch((error) => logger.debug('bridge-approvals: sent receipt failed: %s', error?.message ?? error))
      }
    }
    // 今回のプラットフォームの一覧に無いプラットフォームの delivery は業務システムが無効にする（応答にも出ない）。カードを無効表示にする。
    const answered = new Set((Array.isArray(res.deliveries) ? res.deliveries : []).map((d) => String(d.user?.id ?? '')))
    const dropped = record.deliveries.filter((x) => !x.revoked && !answered.has(x.userId) && !platforms.includes(x.platform))
    if (dropped.length) {
      for (const x of dropped) {
        if (!x.messageRef) continue
        try {
          await dshIm.updateCard(x.messageRef, finalCard(app.id, approvalId, x.card, 'replaced'))
        } catch (error) {
          logger.warn('bridge-approvals: could not mark revoked card: %s', error?.message ?? error)
        }
      }
      unindex({ deliveries: dropped })
      record = {
        ...record,
        deliveries: record.deliveries.map((x) => (dropped.includes(x) ? { ...withoutSecrets(x), revoked: true, updatedFor: 'replaced' } : x)),
      }
      await table.put(key, record)
    }
    if (!existing && record.deliveries.length === 0) {
      logger.info('bridge-approvals: approval %s had no IM-linked approvers', approvalId)
    }
  }

  /**
   * 決定・期限切れ：カードを全部更新し、token / replyCode を消す。冪等。
   * カードの更新は表示だけ（決定は業務システム側で済み、token はここで消える）。届かない理由が分かるもの
   * （WeChat のコンテキスト切れ・宛先不正：classifyDeliveryError）は再試行しても変わらないので、理由を残して諦める。
   * 再試行で直りうる失敗（ボット未接続・不明）だけ投げて、イベントを再試行させる。
   */
  async function finish(applicationId, approvalId, status) {
    const key = recordKey(applicationId, approvalId)
    const record = table.get(key)
    if (!record || record.status === status) return
    const failures = []
    const deliveries = record.deliveries.map((d) => ({ ...d }))
    for (const d of deliveries) {
      if (!d.messageRef || d.revoked || d.updatedFor === status || d.updateGaveUp === status) continue
      try {
        await dshIm.updateCard(d.messageRef, finalCard(appIdOf(record), approvalId, d.card, status, d))
        d.updatedFor = status
        stats.updates += 1
      } catch (error) {
        const known = classifyDeliveryError(error, d.platform)
        if (known && known.undeliverable) {
          d.updateGaveUp = status
          d.updateError = known.reason
          stats.updatesUndeliverable += 1
          logger.warn('bridge-approvals: card for approval %s not updated (%s); giving up', approvalId, known.reason)
        } else {
          failures.push(error)
        }
      }
    }
    unindex(record)
    const next = {
      ...record,
      status: failures.length ? record.status : status,
      finishedStatus: status,
      finishedAt: new Date(now()).toISOString(),
      deliveries: deliveries.map(withoutSecrets),
    }
    await table.put(key, next)
    if (failures.length) throw new Error(`updateCard failed for ${failures.length} card(s): ${failures[0]?.message ?? failures[0]}`)
  }

  async function handleEvent(event) {
    const approvalId = String(event?.aggregateId ?? event?.payload?.approvalId ?? '')
    if (!approvalId) return
    const app = applicationOfEvent(getRegistry, event)
    if (!app) {
      logger.warn('bridge-approvals: approval %s belongs to unknown application %s; ignored', approvalId, event?.applicationId ?? '?')
      return
    }
    if (event.type === 'approval.requested') return onRequested(app, approvalId, event)
    if (event.type === 'approval.expired') return finish(app.id, approvalId, 'expired')
    if (event.type === 'approval.decided') {
      const p = event.payload ?? {}
      return finish(app.id, approvalId, normalizeStatus(p.status ?? p.decision ?? p.action))
    }
  }

  function lookup(applicationId, deliveryId) {
    const key = byDelivery.get(indexKey(applicationId, deliveryId))
    const record = key ? table.get(key) : null
    const delivery = record?.deliveries.find((d) => d.deliveryId === deliveryId)
    return record && delivery ? { record, delivery } : null
  }

  /** その操作（信頼できる発信元のボット）がこの記録のアプリケーションのものか：カードを送ったボット、または同じアプリケーションのボット。 */
  function sameApplication(source, record, delivery) {
    if (delivery?.botId && source?.botId && String(source.botId) === String(delivery.botId)) return true
    const resolved = getRegistry()?.resolveApplication?.(source) ?? null
    return Boolean(resolved) && resolved.id === appIdOf(record)
  }

  /**
   * @param app         決定を送るアプリケーション（記録・返信コードを発行したアプリケーション）
   * @param approvalId  ボタン経由なら承認 ID（/approvals/:id/im-decision）、文字返信なら null（/im-decisions）
   */
  async function decide(app, approvalId, action, credential, comment, source, channelMessageId, respond) {
    const body = { ...credential, action, source: apiSource(source) }
    if (comment) body.comment = comment
    if (channelMessageId) body.channelMessageId = channelMessageId
    let res
    try {
      const path = approvalId ? appPath(app, 'approvalDecision', { approvalId }) : appPath(app, 'approvalDecisions')
      res = await app.api.post(path, body)
    } catch (error) {
      noteError(error)
      logger.info('bridge-approvals: im-decision failed (%s %s %s)', approvalId ?? 'reply', error?.status ?? 0, error?.code ?? '')
      await respond(decisionErrorMessage(error, messages() ?? {}))
      return false
    }
    stats.decisions += 1
    const decidedId = approvalId ?? (res?.approval?.id ? String(res.approval.id) : null)
    // その承認のカードの文面（wording.replies）があれば、それで返事をする
    const wording = decidedId ? table.get(recordKey(app.id, decidedId))?.deliveries?.find((d) => d.card?.wording)?.card.wording : null
    await respond(action === 'approve' ? wording?.replies?.approved ?? MSG.approved : wording?.replies?.rejected ?? MSG.rejected)
    if (!decidedId) return true
    try {
      await finish(app.id, decidedId, action === 'approve' ? 'approved' : 'rejected')
    } catch (error) {
      noteError(error)
      logger.warn('bridge-approvals: card update after decision failed: %s', error?.message ?? error)
    }
    return true
  }

  function finishedMessage(record) {
    return MSG.finished[record.status] ?? MSG.finished.decided
  }

  // B-028：理由の入力欄もダイアログも無いチャネル（LINE など）や、入力欄を空のまま押したとき、「差戻」の後にその人が
  // 同じ会話へ送る次の文を理由として受け取る（REASON_WAIT_MS の間。番号を打たなくてよい）。DSH のメモリだけに持つ。
  const awaiting = new Map() // reasonKey(source) -> { applicationId, deliveryId, expiresAt }
  const reasonKey = (s) => [s?.platform, s?.botId, s?.teamId, s?.userId, s?.conversationId].map((v) => String(v ?? '')).join('|')
  function awaitingFor(source) {
    const key = reasonKey(source)
    const entry = awaiting.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) { awaiting.delete(key); return null }
    return { key, ...entry }
  }

  async function handleAwaitedReason({ text, source, reply }, entry) {
    awaiting.delete(entry.key)
    const reason = normalizeText(String(text ?? '')).trim()
    if (!reason || CANCEL_WORDS.has(reason.toLowerCase())) return reply(MSG.reasonCancelled)
    const found = lookup(entry.applicationId, entry.deliveryId)
    if (!found) return reply(MSG.notFound)
    if (!sameUser(source, found.delivery)) return reply(MSG.notYours)
    if (found.record.status !== 'requested') return reply(finishedMessage(found.record))
    const app = appById(appIdOf(found.record))
    if (!app) return reply(MSG.notFound)
    return decide(app, found.record.approvalId, 'reject', { token: found.delivery.token }, reason, source, source?.messageId, reply)
  }

  async function handleAction(e) {
    const match = buttonRe.exec(String(e?.actionId ?? ''))
    if (!match) return e.respond(MSG.unknownAction)
    const [, action, rest] = match
    const target = parseActionTarget(rest)
    const applicationId = target.applicationId ?? defaultId()
    const deliveryId = target.deliveryId
    const found = lookup(applicationId, deliveryId)
    if (!found) {
      const done = [...table.entries()].find(([, r]) => appIdOf(r) === applicationId && r.deliveries?.some((d) => d.deliveryId === deliveryId))
      if (!done) return e.respond(MSG.notFound)
      const old = done[1].deliveries.find((d) => d.deliveryId === deliveryId)
      if (old?.revoked && done[1].status === 'requested') return e.respond(MSG.code.delivery_revoked)
      return e.respond(finishedMessage(done[1]))
    }
    // card token は発行したアプリケーションにしか送らない：別のアプリケーションのボットからの操作は受け付けない
    if (!sameApplication(e.source, found.record, found.delivery)) return e.respond(MSG.notYours)
    if (!sameUser(e.source, found.delivery)) return e.respond(MSG.notYours)
    if (found.record.status !== 'requested') return e.respond(finishedMessage(found.record))
    let comment
    if (action === 'reject') {
      // カードの入力欄に書いた理由（Teams・Lark）→ 入力ダイアログ（Slack）→ どちらも無ければ次に送る文を理由として待つ
      const typed = typeof e.inputText === 'string' ? e.inputText.trim() : ''
      if (typed) {
        comment = typed
      } else {
        if (typeof e.openReasonDialog !== 'function') {
          awaiting.set(reasonKey(e.source), { applicationId: appIdOf(found.record), deliveryId, expiresAt: now() + REASON_WAIT_MS })
          return e.respond(MSG.askReason(found.delivery.replyCode, replies().words))
        }
        const reason = await e.openReasonDialog({ title: MSG.reasonDialogTitle, label: MSG.reasonDialogLabel })
        comment = typeof reason === 'string' ? reason.trim() : ''
        if (!comment) return e.respond(MSG.reasonCancelled)
      }
    }
    const app = appById(appIdOf(found.record))
    if (!app) return e.respond(MSG.notFound)
    return decide(app, found.record.approvalId, action, { token: found.delivery.token }, comment, e.source, e.messageRef, e.respond)
  }

  /**
   * 返信コードの送り先のアプリケーション。手元の記録（本人宛てで有効な delivery）にそのコードがあれば、それを発行した
   * アプリケーション（カードを送ったボットか同じアプリケーションのボットからの返信に限る。別のアプリケーションのボットなら
   * 'foreign' で断る）。手元に無ければ会話（ボット）のアプリケーション（照合は業務システムが行う）。
   */
  function replyTarget(source, code) {
    const resolved = getRegistry()?.resolveApplication?.(source) ?? null
    const owners = new Map()
    for (const [, r] of table.entries()) {
      if (r.status !== 'requested') continue
      for (const d of r.deliveries ?? []) {
        if (d.revoked || d.replyCode !== code || !sameUser(source, d)) continue
        owners.set(appIdOf(r), { record: r, delivery: d })
      }
    }
    if (owners.size === 0) return resolved ? { app: resolved } : { error: 'no_application' }
    if (resolved && owners.has(resolved.id)) return { app: resolved }
    for (const [applicationId, { record, delivery }] of owners) {
      if (sameApplication(source, record, delivery)) {
        const app = appById(applicationId)
        if (app) return { app }
      }
    }
    return { error: 'foreign' }
  }

  async function handleReply({ text, source, reply }) {
    const parsed = replies().parse(text)
    if (!parsed) {
      const entry = awaitingFor(source)
      return entry ? handleAwaitedReason({ text, source, reply }, entry) : undefined
    }
    // 「差戻 123456 理由」などの文字返信が来たら、待っていた理由の受け付けは終える
    awaiting.delete(reasonKey(source))
    const { action, code, comment } = parsed
    if (action === 'reject' && !comment) return reply(MSG.reasonRequired(code, replies().words))
    const target = replyTarget(source, code)
    if (target.error === 'no_application') return reply(MSG.noApplication)
    if (target.error === 'foreign') return reply(MSG.notYours)
    // 返信コード → 承認の特定と本人確認は業務システム（Bridge v1 は POST /bridge/v1/approvals/im-decisions）が行う。
    return decide(target.app, null, action, { replyCode: code }, comment, source, source?.messageId, reply)
  }

  /** 終わった記録を保持期間後に消す。 */
  async function prune() {
    const cutoff = now() - RETENTION_MS
    for (const [key, record] of [...table.entries()]) {
      const finishedAt = Date.parse(record.finishedAt ?? '')
      const expiresAt = Date.parse(record.expiresAt ?? '')
      if ((Number.isFinite(finishedAt) && finishedAt < cutoff) || (Number.isFinite(expiresAt) && expiresAt < cutoff)) {
        unindex(record)
        await table.delete(key)
      }
    }
  }

  return {
    handleEvent,
    handleAction,
    handleReply,
    /** その文が文字返信（承認・差戻のコマンド）か。 */
    matchesReply: (text) => replies().parse(text) !== null,
    /** その人の次の文を差戻しの理由として待っているか（claimReplies の matcher から同期で呼ぶ）。 */
    awaitsReason: (source) => awaitingFor(source) !== null,
    prune,
    status: () => {
      let open = 0
      let tracked = 0
      const applications = {}
      for (const [, r] of table.entries()) {
        tracked += 1
        if (r.status === 'requested') open += 1
        const id = appIdOf(r)
        applications[id] = (applications[id] ?? 0) + 1
      }
      return { ...stats, tracked, open, applications, activeDeliveries: byDelivery.size, platformPriority: platformPriority(), persistent: table.persistent !== false }
    },
  }
}

/** レジストリ（bridge-apps）が無いときの 1 件：プラグイン設定の apiUrl / serviceToken（呼び出しごとに評価）、Bridge v1 の経路。 */
export function configRegistry(config, { logger } = {}) {
  return fallbackRegistry({
    logger,
    ...(cfg(config, 'applicationName', '') ? { name: String(cfg(config, 'applicationName', '')) } : {}),
    apiUrl: () => cfg(config, 'apiUrl', ''),
    serviceToken: () => cfg(config, 'serviceToken', ''),
  })
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx, name)
  const fallback = configRegistry(config, { logger })
  const registry = watchRegistry(ctx, fallback)
  const replyWords = () => cfg(config, 'replyWords', null) ?? DEFAULT_REPLY_WORDS
  let claimMatcher = { key: null, matcher: null }
  const matchesReply = (text) => {
    const key = JSON.stringify(replyWords())
    if (claimMatcher.key !== key) claimMatcher = { key, matcher: replyMatcher(replyWords()) }
    return claimMatcher.matcher.parse(text) !== null
  }
  const applicationOptions = (id) => {
    const all = cfg(config, 'applications', {}) ?? {}
    return all && typeof all === 'object' ? all[id] ?? {} : {}
  }
  const dshIm = ctx.dshIm
  // ボタン ID の接頭辞は起動時に決める（onAction の登録と同じ。変えたら DSH の再起動が要る）
  const actionPrefix = actionPrefixOf(cfg(config, 'actionPrefix', ''))
  let domain = null
  let coreRef = null // claimReplies の matcher は同期なので、出来上がった core をここにも持つ
  const ready = (async () => {
    let table = memoryTable()
    try {
      domain = await openDomain(ctx, { name: String(cfg(config, 'stateDomain', '') || '').trim() || DOMAIN, tables: ['approvals'] })
      table = domain.table('approvals')
    } catch (error) {
      logger.error('bridge-approvals: DSH storage unavailable; delivery state is kept in memory only: %s', error?.message ?? error)
    }
    const core = createApprovalsIm({
      registry,
      applicationOptions,
      dshIm,
      table,
      logger,
      platformPriority: () => {
        const list = cfg(config, 'platformPriority', DEFAULT_PLATFORMS)
        return Array.isArray(list) && list.length ? list.map(String) : [...DEFAULT_PLATFORMS]
      },
      bots: () => cfg(config, 'bots', {}),
      webUrl: () => cfg(config, 'webUrl', ''),
      replyWords,
      showBusinessBody: () => cfg(config, 'showBusinessBody', true) !== false,
      actionPrefix,
      messages: () => cfg(config, 'messages', {}) ?? {},
    })
    core.prune().catch((error) => logger.warn('bridge-approvals: prune failed: %s', error?.message ?? error))
    coreRef = core
    return core
  })()

  const disposers = []
  const toDisposer = (h) => (typeof h === 'function' ? h : h && typeof h.dispose === 'function' ? () => h.dispose() : () => {})
  if (typeof dshIm?.onAction === 'function') {
    disposers.push(toDisposer(dshIm.onAction(actionPrefix, async (e) => (await ready).handleAction(e))))
  } else {
    logger.warn('bridge-approvals: ctx.dshIm.onAction is missing (the bridge fork of dsh-im is required)')
  }
  if (typeof dshIm?.claimReplies === 'function') {
    disposers.push(toDisposer(dshIm.claimReplies(
      // 文字返信のコマンドか、「差戻」の後で理由を待っている人の次の文（B-028）
      (text, source) => matchesReply(text) || coreRef?.awaitsReason(source) === true,
      async (e) => (await ready).handleReply(e),
    )))
  } else {
    logger.warn('bridge-approvals: ctx.dshIm.claimReplies is missing; text replies are not handled')
  }

  const handleEvent = async (event) => (await ready).handleEvent(event)
  whenServices(ctx, ['bridgeEvents'], (sub) => sub.bridgeEvents.subscribe(APPROVAL_TYPES, handleEvent))

  const service = Object.freeze({
    version: 1,
    ready,
    handleEvent,
    status: async () => (await ready).status(),
    platformPriority: () => cfg(config, 'platformPriority', [...DEFAULT_PLATFORMS]),
  })
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE, service)
  else ctx[SERVICE] = service

  onDispose(ctx, async () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* ignore */ }
    }
    if (domain) await domain.close().catch(() => {})
  })
  return service
}
