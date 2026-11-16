// outbound.js — AI から IM へ出ていくものの共通の決まり（N1b：宛先の保証）。
//
//  - グループ会話（1:1 でない会話）：業務の内容は扱わない。既定は拒否（GROUP_CHAT_GUIDE を返すだけ）。
//    アプリケーションごと（レジストリの applications[].groupChat）・プラグインごと（groupChat）に 'allow' にできる。
//  - AI の自由文（定時報告など）の事後の検査 screenOutboundText：金額・敬称つきの人名・連絡先・外部 URL・長すぎる文・健康情報の語
//    （HEALTH_WORDS：病名・症状・服薬・バイタル・受診などの一般語。G1）を見つけたら ok: false（呼び出し側は全文を固定の文面に置き換える。
//    部分的な伏せ字はしない）。理由はコードだけ返す（一致した文字列は返さない・ログに残さない）。語の一覧は完全ではない（固有の病名・
//    言い換えは通る）。そもそも IM に出すのは件数だけの情報源・本人の 1:1 に限るので、一覧は念のための網。

/** グループ会話の既定の案内（Bizアシスタント共通。アプリケーションの messages.groupChat で上書き）。 */
export const GROUP_CHAT_GUIDE = '業務の内容は個別チャットでお尋ねください。'
export const GROUP_CHAT_POLICIES = Object.freeze(['deny', 'allow'])

/**
 * 1:1 でない会話か。dsh-im の ImSource は conversationKind: 'direct' | 'group'（プラットフォームのイベントから作る）。
 * conversationKind の無い発信元（IM 以外・古いテスト）は 1:1 として扱う（bridge-identity の連携コードの判定と同じ）。
 */
export function isGroupConversation(source) {
  const kind = source?.conversationKind
  return typeof kind === 'string' && kind !== '' && kind !== 'direct'
}

/** 最初に有効な値（'deny' | 'allow'）。どれも無ければ 'deny'。 */
export function groupChatPolicy(...values) {
  for (const v of values) if (GROUP_CHAT_POLICIES.includes(v)) return v
  return 'deny'
}

// 敬称の前が漢字・カタカナの語（人名の書き方）。ひらがなの直後の「さん・さま」（たくさん・お疲れさま）は見ない
const HONORIFIC_RE = /([一-龯々〆ヵヶァ-ヺー]{1,12})(様(?![子式相々])|さま|さん|氏(?![名])|殿|くん|君|ちゃん)/gu
/** 敬称の前に来てよい語（役割・集団。人名ではない）。末尾一致で見る。 */
export const ROLE_WORDS = Object.freeze([
  '皆', '各位', '担当者', '担当', '利用者', '家族', '管理者', '責任者', '職員', '事業所', '施設長', '所長', '主任', '専門員',
  'ケアマネジャー', 'ケアマネージャー', 'ケアマネ', 'ヘルパー', 'スタッフ', '客', '関係者', '本人', '相手',
  '父', '母', '兄', '姉', '奥',
  // 「様」で終わる一般の語（同様・仕様・模様・多様・異様・一様）
  '同', '仕', '模', '多', '異', '一',
])
const AMOUNT_RES = [/[0-9０-９][0-9０-９,，.．]*\s*(?:万|千)?\s*円/u, /[¥￥]\s*[0-9０-９]/u, /[0-9０-９]\s*万円/u]
const CONTACT_RES = [
  /0[0-9０-９]{1,4}[-－ー‐][0-9０-９]{1,4}[-－ー‐][0-9０-９]{3,4}/u, // 電話番号
  /(?<![0-9])0[5789]0[0-9]{8}(?![0-9])/u,                           // 携帯（ハイフンなし）
  /〒|(?<![0-9])[0-9]{3}-[0-9]{4}(?![0-9])/u,                       // 郵便番号
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/u,              // メールアドレス
]
const URL_RE = /https?:\/\/[^\s<>「」『』()（）]+/giu

/**
 * 健康情報の語（一般語だけ。定時報告の本文に出てこない語）。一致したら health。部分一致で見るので、業務の語と重ならない語を選ぶ
 * （「区分変更」「ヒヤリハット」「事故」「安否確認」「要支援」「モニタリング」「居宅訪問」「認定」は業務の語なので入れない）。
 */
export const HEALTH_WORDS = Object.freeze([
  // 病名・状態
  '認知症', '糖尿病', '高血圧', '低血圧', '脳梗塞', '脳出血', '脳卒中', '心不全', '心筋梗塞', '狭心症', '不整脈', '肺炎', '誤嚥', '癌', '腫瘍',
  '骨折', '褥瘡', '床ずれ', 'パーキンソン', '統合失調症', 'うつ病', '感染症', 'インフルエンザ', 'コロナ', 'ノロウイルス', '疥癬', '結核',
  '透析', '麻痺', '難病', '持病', '既往歴', '病歴', '病名', '疾患', '疾病', '診断', '病状', '病気', '健康状態',
  // 症状
  '発熱', '微熱', '高熱', '咳', '嘔吐', '吐き気', '下痢', '便秘', '失禁', '頭痛', '腹痛', '胸痛', '腰痛', '痛み', '疼痛', 'むくみ', '浮腫',
  'めまい', '痙攣', 'けいれん', '意識障害', '呼吸困難', '息切れ', '脱水', '食欲不振', '不眠', 'せん妄', '発疹', '症状',
  // 服薬
  '服薬', '内服', '投薬', '処方', '薬剤', '頓服', '坐薬', '座薬', '点滴', '注射', 'インスリン', '睡眠薬', '眠剤', '鎮痛剤', '降圧剤', '抗生剤',
  '抗生物質', '副作用', 'お薬', '飲み薬',
  // バイタル
  'バイタル', '血圧', '体温', '脈拍', '心拍', '呼吸数', 'SpO2', 'ＳｐＯ２', '酸素飽和度', '血糖', '体重', 'mmHg',
  // 受診
  '入院', '退院', '通院', '受診', '主治医', '往診', '手術',
])
const TEMPERATURE_RE = /[0-9０-９]{2}(?:[.．][0-9０-９])?\s*(?:℃|度(?:[0-9０-９]|台|の熱))/u

/**
 * AI の自由文を IM に出してよいか（事後の検査）。
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.allowedUrlPrefixes]  出してよい URL の接頭辞（業務 Web の URL など。無ければ URL はすべて不可）
 * @param {number} [opts.maxChars]  既定 1500
 * @param {number} [opts.maxLines]  既定 40
 * @param {string[]} [opts.healthWords]  健康情報の語（既定 HEALTH_WORDS。[] で見ない）
 * @returns {{ ok: boolean, reasons: string[] }}  reasons: amount | person_name | contact | external_url | too_long | empty | health
 */
export function screenOutboundText(text, { allowedUrlPrefixes = [], maxChars = 1500, maxLines = 40, roleWords = ROLE_WORDS, healthWords = HEALTH_WORDS } = {}) {
  const raw = String(text ?? '').normalize('NFC')
  const reasons = new Set()
  if (!raw.trim()) reasons.add('empty')
  if (raw.length > maxChars || raw.split(/\r?\n/).length > maxLines) reasons.add('too_long')
  if (AMOUNT_RES.some((re) => re.test(raw))) reasons.add('amount')
  if (CONTACT_RES.some((re) => re.test(raw))) reasons.add('contact')
  for (const m of raw.matchAll(HONORIFIC_RE)) {
    if (!roleWords.some((w) => m[1].endsWith(w))) { reasons.add('person_name'); break }
  }
  const words = Array.isArray(healthWords) ? healthWords : HEALTH_WORDS
  if (words.some((w) => w && raw.includes(w)) || (words.length && TEMPERATURE_RE.test(raw))) reasons.add('health')
  const prefixes = (Array.isArray(allowedUrlPrefixes) ? allowedUrlPrefixes : []).map((p) => String(p ?? '').trim()).filter(Boolean)
  for (const m of raw.matchAll(URL_RE)) {
    if (!prefixes.some((p) => m[0].startsWith(p))) { reasons.add('external_url'); break }
  }
  return { ok: reasons.size === 0, reasons: [...reasons] }
}
