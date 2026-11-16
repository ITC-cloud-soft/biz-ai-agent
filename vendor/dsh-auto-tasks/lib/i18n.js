/**
 * 轻量 i18n（TypeScript 源，构建到 lib/i18n.js）。
 * 目前覆盖邮件日报等对外文案；客户端 UI 文案仍为中文，后续迁移。
 */

                                

const DICT                                         = {
  zh: {
    'digest.title': '📬 今日重要邮件汇总（{n} 封）',
    'digest.empty': '今天没有重要业务邮件。',
    'digest.pending': '待你决定回复：{n} 封（草稿在【自动任务 → 反馈】）',
    'digest.from': '发件人：{value}',
  },
  en: {
    'digest.title': '📬 Important mail digest today ({n})',
    'digest.empty': 'No important business mail today.',
    'digest.pending': 'Awaiting your decision: {n} (drafts in Auto Tasks → Feedback)',
    'digest.from': 'From: {value}',
  },
}

export function t(locale                    , key        , vars                                  = {})         {
  const table = DICT[(locale === 'en' ? 'en' : 'zh')          ]
  const template = table[key] ?? DICT.zh[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_m, name        ) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name]))
}
