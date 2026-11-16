// biz-ai-agent 使用手册 — the deck (pptxgenjs, structured: theme + layouts + sections).
// Rebuild (pptxgenjs installed anywhere on NODE_PATH): PPTX_SKILL=<the pptx skill's directory, for scripts/apply_theme.js> node docs/manual-deck/build.cjs docs/MANUAL.pptx
// QA: powershell -File docs/manual-deck/render.ps1 -Deck docs/MANUAL.pptx -OutDir <dir>   (PowerPoint renders every slide to PNG)
// The screenshots in img/ are of the fictional pilot (examples/leave-requests-knowledge), taken 2026-11-16.
const path = require('path')
const fs = require('fs')
const pptxgen = require('pptxgenjs')
const { applyTheme } = require(process.env.PPTX_SKILL + '/scripts/apply_theme.js')

const OUT = process.argv[2] || path.join(__dirname, '..', 'MANUAL.pptx')
const IMG = path.join(__dirname, 'img')

const THEME = {
  name: 'biz-ai-agent',
  headFontFace: 'Microsoft YaHei',
  bodyFontFace: 'Microsoft YaHei',
  colors: {
    dk1: '0F172A', lt1: 'FFFFFF', dk2: '475569', lt2: 'F4F6FA',
    accent1: '4F46E5', accent2: '8B5CF6', accent3: 'EC4899', accent4: '0EA5E9', accent5: '10B981', accent6: 'F59E0B',
    hlink: '4F46E5', folHlink: '7C3AED',
  },
}
const HEX = THEME.colors
const pres = new pptxgen()
pres.layout = 'LAYOUT_WIDE' // 13.333 × 7.5
pres.title = 'biz-ai-agent 使用手册'
pres.author = 'biz-ai-agent'
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace }
const C = pres.SchemeColor
const W = 13.333, H = 7.5, M = 0.6

// ── icons (the settings app's own line icons, 24 × 24) ──────────────────────────────────────────────────────────────
const ICONS = {
  sparkle: ['M12 3l1.8 4.9L19 9.7l-4.6 2.6L12 18l-2.4-5.7L5 9.7l5.2-1.8Z', 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z', 'M20 20l-4-4'],
  vector: ['M4 18l6-6 4 4 6-8', 'M4 6h.01', 'M4 12h.01', 'M20 18h.01'],
  graph: ['M6 7a2 2 0 1 0 0-.01', 'M18 6a2 2 0 1 0 0-.01', 'M12 18a2 2 0 1 0 0-.01', 'M7.7 7.8l3.2 8.4', 'M16.4 7.4l-3.3 8.8', 'M8 6.5h8'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  key: ['M15 7a4 4 0 1 0-3.7 5.5L4 20v-3h3v-3h3l1.3-1.3A4 4 0 0 0 15 7Z', 'M16 7.5h.01'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0Z', 'M12 17v5'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6Z', 'M9 12l2 2 4-4'],
  bell: ['M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  link: ['M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
  refresh: ['M20 11a8 8 0 0 0-14.8-3.8L3 9', 'M3 4v5h5', 'M4 13a8 8 0 0 0 14.8 3.8L21 15', 'M21 20v-5h-5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  database: ['M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z', 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  chat: ['M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.2A8 8 0 1 1 21 12Z', 'M8.5 12h.01', 'M12 12h.01', 'M15.5 12h.01'],
  book: ['M4 19.5V5a2 2 0 0 1 2-2h13v16H6.5A2.5 2.5 0 0 0 4 21.5', 'M19 17v4H6.5', 'M8 7h7', 'M8 11h5'],
  cpu: ['M9 3v2', 'M15 3v2', 'M9 19v2', 'M15 19v2', 'M3 9h2', 'M3 15h2', 'M19 9h2', 'M19 15h2', 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M9.5 9.5h5v5h-5z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21a8 8 0 0 1 16 0'],
  users: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7', 'M22 21a7 7 0 0 0-4.5-6.5'],
  layers: ['M12 3 2 8l10 5 10-5Z', 'M2 13l10 5 10-5', 'M2 17.5l10 5 10-5'],
  folder: ['M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M14 4l-4 16'],
  terminal: ['M4 17l6-5-6-5', 'M12 19h8'],
  play: ['M7 4l13 8-13 8Z'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  lock: ['M6 11h12v10H6Z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  memory: ['M12 5a3 3 0 1 0-5.9.8A3 3 0 0 0 4 9a3 3 0 0 0 .5 5.3A3 3 0 0 0 7 19a3 3 0 0 0 5 1Z', 'M12 5a3 3 0 1 1 5.9.8A3 3 0 0 1 20 9a3 3 0 0 1-.5 5.3A3 3 0 0 1 17 19a3 3 0 0 1-5 1Z', 'M12 5v15'],
  clipboard: ['M9 4h6v3H9Z', 'M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2', 'M9 13l2 2 4-4'],
  flask: ['M9 3h6', 'M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3', 'M7 15h10'],
  rocket: ['M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1Z', 'M12 15l-3-3a22 22 0 0 1 9-9c2 0 3 1 3 3a22 22 0 0 1-9 9Z', 'M9 12H4s.5-3 2-4c1.6-1.1 5 0 5 0', 'M12 15v5s3-.5 4-2c1.1-1.6 0-5 0-5'],
}
const svgIcon = (name, color) =>
  'image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${(ICONS[name] || []).map((d) => `<path d="${d}"/>`).join('')}</svg>`).toString('base64')

// ── layouts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pres.defineSlideMaster({
  title: 'TITLE_DARK',
  background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.35, w: 9.6, h: 1.5, fontSize: 44, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: M, y: 4.0, w: 9.6, h: 1.2, fontSize: 20, color: 'C7C8FF', valign: 'top', align: 'left', margin: 0 }, text: '' } },
  ],
})
pres.defineSlideMaster({
  title: 'SECTION',
  background: { color: '1E1B4B' },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M + 2.3, y: 2.7, w: 9.6, h: 1.1, fontSize: 40, bold: true, color: C.background1, valign: 'middle', align: 'left', margin: 0 }, text: '' } },
    { placeholder: { options: { name: 'body', type: 'body', x: M + 2.3, y: 3.85, w: 9.6, h: 0.9, fontSize: 18, color: 'C7C8FF', valign: 'top', align: 'left', margin: 0 }, text: '' } },
  ],
})
pres.defineSlideMaster({
  title: 'CONTENT',
  background: { color: C.background1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.42, w: W - 2 * M, h: 0.75, fontSize: 30, bold: true, color: C.text1, valign: 'middle', align: 'left', margin: 0 }, text: '' } },
    { text: { text: 'biz-ai-agent 使用手册', options: { x: M, y: H - 0.42, w: 4, h: 0.28, fontSize: 10, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: W - M - 0.6, y: H - 0.42, w: 0.6, h: 0.28, fontSize: 10, color: C.text2, align: 'right' },
})

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let n = 0
const id = (s) => `${s}-${++n}`
const shadow = () => ({ type: 'outer', color: '0F172A', opacity: 0.08, blur: 8, offset: 2, angle: 90 })
function card(s, x, y, w, h, o = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: o.r ?? 0.12, fill: { color: o.fill ?? C.background2 }, line: o.line ? { color: o.line, width: 1 } : { type: 'none' }, shadow: o.shadow ? shadow() : undefined, objectName: id('card') })
}
function tile(s, name, x, y, size = 0.56, o = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: size, h: size, rectRadius: size * 0.26, fill: { color: o.bg ?? C.accent1 }, line: { type: 'none' }, objectName: id('tile') })
  const p = size * 0.22
  s.addImage({ data: svgIcon(name, o.fg ?? 'FFFFFF'), x: x + p, y: y + p, w: size - 2 * p, h: size - 2 * p, altText: name, objectName: id('icon') })
}
function txt(s, text, x, y, w, h, o = {}) {
  s.addText(text, { x, y, w, h, fontSize: o.size ?? 14, color: o.color ?? C.text1, bold: o.bold, italic: o.italic, align: o.align ?? 'left', valign: o.valign ?? 'top', margin: o.margin ?? 0, isTextBox: true, paraSpaceAfter: o.after, lineSpacingMultiple: o.lsm ?? 1.1, fontFace: o.font, objectName: id('text'), ...(o.extra || {}) })
}
const bullets = (items, o = {}) => items.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: i < items.length - 1, paraSpaceAfter: o.after ?? 6 } }))
function code(s, lines, x, y, w, h, size = 13) {
  card(s, x, y, w, h, { fill: C.text1, r: 0.1 })
  s.addText(lines.map((l, i) => ({ text: l, options: { breakLine: i < lines.length - 1, color: l.trim().startsWith('# ') ? '94A3B8' : 'E2E8F0' } })),
    { x: x + 0.25, y: y + 0.18, w: w - 0.5, h: h - 0.36, fontFace: 'Consolas', fontSize: size, valign: 'top', margin: 0, isTextBox: true, lineSpacingMultiple: 1.15, objectName: id('code') })
}
function shot(s, file, x, y, w, ratio) {
  const h = w * ratio
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.06, y: y - 0.06, w: w + 0.12, h: h + 0.12, rectRadius: 0.1, fill: { color: 'FFFFFF' }, line: { color: 'E3E8EF', width: 1 }, shadow: shadow(), objectName: id('frame') })
  s.addImage({ path: path.join(IMG, file), x, y, w, h, altText: file, objectName: id('shot') })
  return h
}
function numDot(s, k, x, y, size = 0.42, o = {}) {
  s.addShape(pres.shapes.OVAL, { x, y, w: size, h: size, fill: { color: o.bg ?? C.accent1 }, line: { type: 'none' }, objectName: id('dot') })
  s.addText(String(k), { x, y, w: size, h: size, fontSize: o.size ?? 14, bold: true, color: o.fg ?? C.background1, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: id('dotnum') })
}
function arrow(s, x1, y1, x2, y2, color = 'A5B4FC') {
  // a line's size is never negative: draw it from the top-left corner and flip it
  s.addShape(pres.shapes.LINE, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), flipH: x2 < x1, flipV: y2 < y1, line: { color, width: 2, endArrowType: 'triangle' }, objectName: id('arrow') })
}
function content(section, title, notes) {
  const s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: section })
  s.addText(title, { placeholder: 'title' })
  if (notes) s.addNotes(notes)
  return s
}
function lead(s, text) { txt(s, text, M, 1.2, W - 2 * M, 0.45, { size: 16, color: C.text2 }) }
function sectionSlide(section, k, title, sub) {
  pres.addSection({ title: section })
  const s = pres.addSlide({ masterName: 'SECTION', sectionTitle: section })
  s.addText(title, { placeholder: 'title' })
  s.addText(sub, { placeholder: 'body' })
  s.addText(String(k).padStart(2, '0'), { x: M, y: 2.55, w: 2.0, h: 1.4, fontSize: 80, bold: true, color: '8B8CF8', margin: 0, isTextBox: true, objectName: id('secnum') })
  return s
}

// ── 1 title ──────────────────────────────────────────────────────────────────────────────────────────────────────────
pres.addSection({ title: '封面' })
{
  const s = pres.addSlide({ masterName: 'TITLE_DARK', sectionTitle: '封面' })
  s.addText('biz-ai-agent 使用手册', { placeholder: 'title' })
  s.addText('把任何 IT 系统变成 AI 员工 —— 一个完整的 AI agent 框架', { placeholder: 'body' })
  tile(s, 'sparkle', M, 1.3, 0.85, { bg: C.accent1 })
  txt(s, '2026-11-16 · framework 同步自 9a86b0f · docs/MANUAL.md 的幻灯片版', M, 6.45, 9, 0.35, { size: 12, color: '94A3B8' })
  s.addNotes('这份幻灯片是 docs/MANUAL.md 的摘要版。详细内容、命令和文件路径以 Markdown 手册为准。')
}

// ── 2 agenda ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = content('封面', '这份手册讲四件事')
  const parts = [
    ['layers', '01 认识框架', '是什么、核心原则、五层、整体结构、仓库'],
    ['play', '02 上手运行', '安装测试、本地试用、画面怎么用'],
    ['code', '03 造 agent', '决策、IT 系统、manifest、知识、图谱、评测、AI 面'],
    ['rocket', '04 部署与运维', '配置、安全规则、完成条件、同步、排查'],
  ]
  const cw = (W - 2 * M - 3 * 0.3) / 4
  parts.forEach(([ic, t, d], i) => {
    const x = M + i * (cw + 0.3)
    card(s, x, 1.7, cw, 3.9, { fill: C.background2 })
    tile(s, ic, x + 0.35, 2.05, 0.7)
    txt(s, t, x + 0.35, 3.05, cw - 0.7, 0.5, { size: 20, bold: true })
    txt(s, d, x + 0.35, 3.65, cw - 0.7, 1.8, { size: 15, color: C.text2, lsm: 1.3 })
  })
}

// ── section 1 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S1 = '认识框架'
sectionSlide(S1, 1, '认识框架', '是什么 · 核心原则 · 五层 · 整体结构 · 仓库')

{
  const s = content(S1, '两部分，全部在一个仓库里', '左边是整套拷入的 Biz Assistant Framework，右边是 biz-ai-agent 自己的 agent 层。')
  const cw = 5.55
  card(s, M, 1.45, cw, 5.25, { fill: C.background2 })
  tile(s, 'layers', M + 0.35, 1.75, 0.62)
  txt(s, 'Biz Assistant Framework', M + 1.15, 1.78, cw - 1.4, 0.4, { size: 20, bold: true })
  txt(s, '@dsh-bridge/* · 整套拷入', M + 1.15, 2.18, cw - 1.4, 0.3, { size: 13, color: C.text2 })
  txt(s, bullets(['Bridge v1 协议、server-kit（业务系统一侧）', 'DSH 核心 + 插件：身份连携、工具、事件、通知、审批、长期记忆、AI 员工资料、文档读取、Web 助手', 'dsh-im：13 种 SNS 的 IM 网关', 'web-kit 组件、DSH 网关、测试工具、profile 模板']), M + 0.4, 2.75, cw - 0.75, 3.8, { size: 15, lsm: 1.2 })
  txt(s, '+', M + cw + 0.05, 3.7, 0.5, 0.6, { size: 36, bold: true, color: C.accent1, align: 'center' })
  const x2 = M + cw + 0.6
  card(s, x2, 1.45, cw, 5.25, { fill: 'EEF2FF' })
  tile(s, 'sparkle', x2 + 0.35, 1.75, 0.62, { bg: C.accent2 })
  txt(s, 'agent 层', x2 + 1.15, 1.78, cw - 1.4, 0.4, { size: 20, bold: true })
  txt(s, 'biz-ai-agent 自己的', x2 + 1.15, 2.18, cw - 1.4, 0.3, { size: 13, color: C.text2 })
  txt(s, bullets(['knowledge：按权限检索文档，带出处', 'graph："这件事为什么发给我？"', 'agent-settings：模型、知识文档、BM25F / RAG(pgvector) / 知识图谱、SNS 审批与报告、员工的 SNS 页、登录页', 'agent-builder skill：让编码 agent 造 agent']), x2 + 0.4, 2.75, cw - 0.75, 3.8, { size: 15, lsm: 1.2 })
}

{
  const s = content(S1, '五条核心原则')
  const rules = [
    ['cpu', 'agent 首先是一个普通的 IT 系统', '业务系统是唯一的数据正本；流程是代码，不是拖拽出来的图'],
    ['eye', 'AI 只读和提案，人来决定', '以提问员工本人的权限读取；提案要人采纳才执行；金额由人决定'],
    ['bell', '业务系统决定通知谁', 'recipientsFor 决定接收人，和网页权限用同一个规则'],
    ['lock', '不带个人信息', '事件和消息里只有 ID、日期、件数、状态；内容在网页上确认权限后看'],
    ['shield', '权限优先', '每次检索、每个图谱回答都先按提问者的权限过滤，再排序'],
  ]
  rules.forEach(([ic, t, d], i) => {
    const y = 1.45 + i * 1.07
    tile(s, ic, M, y, 0.62)
    txt(s, t, M + 0.95, y - 0.02, 11, 0.4, { size: 19, bold: true })
    txt(s, d, M + 0.95, y + 0.4, 11, 0.4, { size: 15, color: C.text2 })
  })
}

{
  const s = content(S1, '对应 AI agent 的五层')
  lead(s, '每一层都有确定的位置，由测试守护')
  const rows = [
    ['Schema 语义层', 'bridge.manifest.yaml：角色、实体、事件、工具、playbook、报告；图谱骨架由它生成', C.accent1],
    ['Data 数据层', '业务系统本身（server-kit 应用，或已有系统 + Bridge v1）', C.accent2],
    ['Action 操作层', '提案（proposal）和审批（approval），由业务系统的规则决定', C.accent3],
    ['Agent 智能体层', 'DSH 上的 AI 员工；bridge-tools / knowledge / graph 给它工具', C.accent4],
    ['Memory 记忆层', 'bridge-memory（存之前做个人信息检查）、知识层的文档', C.accent5],
  ]
  rows.forEach(([k, v, col], i) => {
    const y = 1.85 + i * 0.95
    card(s, M, y, W - 2 * M, 0.8, { fill: C.background2 })
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M + 0.15, y: y + 0.15, w: 2.6, h: 0.5, rectRadius: 0.25, fill: { color: col }, line: { type: 'none' }, objectName: id('pill') })
    txt(s, k, M + 0.15, y + 0.15, 2.6, 0.5, { size: 15, bold: true, color: C.background1, align: 'center', valign: 'middle' })
    txt(s, v, M + 3.05, y, W - 2 * M - 3.3, 0.8, { size: 15, valign: 'middle' })
  })
}

{
  const s = content(S1, '整体结构', 'SNS ⇄ AI 面（DSH）⇄ 业务系统；业务网页通过 DSH 网关管理 IM 机器人（只给管理员）。')
  const col = [
    { x: M, t: '13 种 SNS', ic: 'chat', items: ['LINE · Slack · Teams', '企业微信 · 钉钉 · 飞书', 'Telegram · QQ · Discord', 'Matrix · WhatsApp · iMessage'] },
    { x: M + 3.15, t: 'AI 面（DSH）', ic: 'sparkle', items: ['dsh-im：IM 网关', 'dsh-core：应用注册・委托', '插件：identity・tools・events', 'notify・approvals・memory …', 'knowledge・graph'] },
    { x: M + 6.3, t: '业务系统', ic: 'database', items: ['server-kit：/bridge/v1/*', 'manifest（本体）', '业务数据・规则・hooks', 'knowledge・graph', 'agent-settings'] },
    { x: M + 9.45, t: '业务网页', ic: 'globe', items: ['/agent-settings（管理员）', '/me/sns（每个员工）', '审批・Web 助手', 'DSH 网关 /dsh'] },
  ]
  col.forEach((c, i) => {
    card(s, c.x, 1.55, 2.68, 4.75, { fill: i === 2 ? 'EEF2FF' : C.background2 })
    tile(s, c.ic, c.x + 0.25, 1.8, 0.56, { bg: [C.accent4, C.accent2, C.accent1, C.accent3][i] })
    txt(s, c.t, c.x + 0.95, 1.82, 1.7, 0.5, { size: 17, bold: true, valign: 'middle' })
    txt(s, bullets(c.items, { after: 8 }), c.x + 0.25, 2.65, 2.3, 3.5, { size: 14, lsm: 1.15 })
  })
  arrow(s, M + 2.72, 3.9, M + 3.11, 3.9); arrow(s, M + 3.11, 4.15, M + 2.72, 4.15)
  arrow(s, M + 5.87, 3.9, M + 6.26, 3.9); arrow(s, M + 6.26, 4.15, M + 5.87, 4.15)
  arrow(s, M + 9.41, 3.9, M + 9.02, 3.9)
  txt(s, '服务令牌 + 员工本人的委托令牌', M + 3.15, 6.45, 5.9, 0.35, { size: 13, color: C.text2, align: 'center' })
}

{
  const s = content(S1, '一次提问：员工在 LINE 上问休假规定')
  const steps = [
    ['chat', '发消息', 'dsh-im 收到；bridge-identity 查出是哪个员工（必须先连携）'],
    ['plug', '调用工具', 'leave_knowledge_search，用这个员工的委托'],
    ['shield', '按权限检索', '业务系统只返回他能看的段落和出处'],
    ['check', '守卫', '出处守卫加来源；链接守卫删掉外部链接'],
    ['sparkle', '回答', '带出处（业务网页的画面链接）发回 LINE'],
  ]
  const cw = (W - 2 * M - 4 * 0.25) / 5
  steps.forEach(([ic, t, d], i) => {
    const x = M + i * (cw + 0.25)
    card(s, x, 1.7, cw, 4.2, { fill: C.background2 })
    numDot(s, i + 1, x + 0.3, 2.0)
    tile(s, ic, x + cw - 0.9, 1.95, 0.56, { bg: 'E0E7FF', fg: HEX.accent1 })
    txt(s, t, x + 0.3, 2.85, cw - 0.6, 0.45, { size: 18, bold: true })
    txt(s, d, x + 0.3, 3.4, cw - 0.6, 2.3, { size: 14, color: C.text2, lsm: 1.25 })
    if (i < steps.length - 1) arrow(s, x + cw + 0.02, 3.8, x + cw + 0.23, 3.8, '818CF8')
  })
  txt(s, '你看不到的内容，AI 也看不到。', M, 6.2, W - 2 * M, 0.45, { size: 16, bold: true, color: C.accent1 })
}

{
  const s = content(S1, '一次审批：上传一份知识文档')
  const steps = [
    ['upload', '管理员 A 上传', '文档和事件 approval.requested 在同一个事务里写入'],
    ['bell', '卡片发给 B', 'bridge-approvals 问业务系统谁来批 → 卡片到管理员 B 的 LINE'],
    ['check', 'B 按「承認」', '业务系统用同一个 mayDecide 判断 → 发布'],
    ['file', '报告', 'knowledge.updated（只有件数）发给报告角色'],
  ]
  steps.forEach(([ic, t, d], i) => {
    const y = 1.5 + i * 1.12
    numDot(s, i + 1, M, y + 0.1, 0.5, { size: 16 })
    tile(s, ic, M + 0.75, y + 0.07, 0.56, { bg: 'E0E7FF', fg: HEX.accent1 })
    txt(s, t, M + 1.55, y, 2.4, 0.7, { size: 18, bold: true, valign: 'middle' })
    txt(s, d, M + 4.05, y, 4.2, 0.7, { size: 14, color: C.text2, valign: 'middle', lsm: 1.2 })
  })
  card(s, 9.1, 1.5, W - M - 9.1, 4.3, { fill: 'FDF2F8' })
  tile(s, 'shield', 9.4, 1.8, 0.6, { bg: C.accent3 })
  txt(s, '上传者自己收不到卡片，也不能批', 9.4, 2.6, W - M - 9.7, 0.9, { size: 18, bold: true, lsm: 1.2 })
  txt(s, '一个审批只能决定一次，别人决定后其他卡片失效。只有一个管理员时，要把经理加进审批角色', 9.4, 3.6, W - M - 9.7, 2, { size: 14, color: C.text2, lsm: 1.3 })
}

{
  const s = content(S1, '仓库里有什么', '★ 是从 Biz Assistant Framework 拷入的部分，不要在这里直接改，改 framework 后再同步。')
  const tiles = [
    ['folder', 'packages/', '★ protocol · server-kit · dsh-core · gateway · web-kit · help · testing · telemetry', 'knowledge · graph · agent-settings'],
    ['plug', 'plugins/', '★ identity · tools · events · notify · approvals · assistant · memory · persona · reader', 'knowledge · graph'],
    ['settings', 'profile/', '★ DSH 产品 profile 模板和安装脚本', ''],
    ['chat', 'vendor/', '★ dsh-im（13 种 SNS）· dsh-auto-tasks · dsh-proactive', ''],
    ['play', 'examples/', 'leave-requests-knowledge（参考实现）· equipment-loans', '★ care-billing · equipment-inspection · leave-requests'],
    ['book', 'skills/ · docs/', 'agent-builder skill · 本手册 · 设计和 API', '★ biz-assistant-integration · GUIDELINE · ARCHITECTURE'],
  ]
  const cw = (W - 2 * M - 2 * 0.3) / 3, ch = 2.4
  tiles.forEach(([ic, t, a, b], i) => {
    const x = M + (i % 3) * (cw + 0.3), y = 1.45 + Math.floor(i / 3) * (ch + 0.3)
    card(s, x, y, cw, ch, { fill: C.background2 })
    tile(s, ic, x + 0.3, y + 0.3, 0.52)
    txt(s, t, x + 1.0, y + 0.3, cw - 1.2, 0.52, { size: 18, bold: true, valign: 'middle', font: 'Consolas' })
    txt(s, [{ text: a, options: { breakLine: !!b } }, ...(b ? [{ text: b, options: { color: C.accent1 } }] : [])], x + 0.3, y + 1.0, cw - 0.6, ch - 1.15, { size: 13, color: C.text2, lsm: 1.25 })
  })
}

// ── section 2 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S2 = '上手运行'
sectionSlide(S2, 2, '上手运行', '安装测试 · 本地试用 · 画面怎么用')

{
  const s = content(S2, '第一次运行：四条命令', 'Node 22.19 以上。e2e 第一次会下载固定版本的 DSH CLI（约 900 MB，放在 .dsh-cli/）。')
  code(s, ['npm install', 'npm run vendor:install   # 第一次：vendor 的依赖', 'npm test                 # 全部包、插件、示例', 'npm run e2e              # 真实 DSH + 假模型 + 假 LINE'], M, 1.5, 7.3, 2.3, 15)
  txt(s, bullets(['期望 0 失败；少量 skip 是没给数据库 URL 的 PostgreSQL / MySQL 测试', '各示例输出 # conformance: 52 / 52 checks passed', 'node e2e/run.mjs --serve：跑完不退出，打开 http://127.0.0.1:19751/login']), M, 4.15, 7.3, 2.5, { size: 15, color: C.text2, lsm: 1.25 })
  const stats = [['899', '个测试，0 失败'], ['52 / 52', 'conformance（每个示例）'], ['15 / 15', '真实 DSH 上的 e2e']]
  stats.forEach(([v, l], i) => {
    const y = 1.5 + i * 1.75
    card(s, 8.4, y, W - M - 8.4, 1.5, { fill: i === 0 ? 'EEF2FF' : C.background2 })
    txt(s, v, 8.7, y + 0.15, 4, 0.8, { size: 40, bold: true, color: C.accent1 })
    txt(s, l, 8.7, y + 0.95, 4, 0.4, { size: 14, color: C.text2 })
  })
}

{
  const s = content(S2, '本地试用参考实现（不需要 DSH）')
  code(s, ['# 假模型（不是 AI，只让 RAG / 图谱流程能跑）', 'node examples/leave-requests-knowledge/dev/mock-model.mjs', '# 试点（端口 19750）', 'node examples/leave-requests-knowledge/src/server.mjs'], M, 1.45, 6.4, 1.95, 13)
  const steps = ['打开 /login：admin / admin2 / manager / staff1 / staff2（开发密码 leave-dev）', '模型页：Base URL 填 http://127.0.0.1:19760/v1，key 的变量名填 MOCK_MODEL_KEY', '知识页：切换检索方式，上传文档，用 admin2 批准', 'RAG 用 pgvector：Docker 镜像 pgvector/pgvector:pg17 + AGENT_VECTOR_DB_URL']
  steps.forEach((t, i) => {
    const y = 3.65 + i * 0.75
    numDot(s, i + 1, M, y + 0.02, 0.4, { size: 13 })
    txt(s, t, M + 0.6, y, 5.8, 0.7, { size: 14, lsm: 1.15 })
  })
  shot(s, 'login.jpg', 7.45, 1.55, W - M - 7.45, 475 / 800)
  txt(s, '登录页：和设置画面同一套外观，亮 / 暗、日英中', 7.45, 5.25, W - M - 7.45, 0.4, { size: 12, color: C.text2 })
}

{
  const s = content(S2, '管理员：AI agent 设置 /agent-settings', '只给管理员角色。四页：概要、模型、知识、SNS。')
  shot(s, 'overview.png', M, 1.45, 7.4, 475 / 800)
  const pages = [
    ['sparkle', '概要', '状态一览、设置进度、自己的 SNS 连携'],
    ['cpu', '模型', '基础模型、embedding 模型、连接测试'],
    ['book', '知识', '检索方式、上传文档、审批、重建索引'],
    ['chat', 'SNS', '组织的 IM 机器人（13 种）、审批与报告'],
  ]
  pages.forEach(([ic, t, d], i) => {
    const y = 1.45 + i * 1.12
    card(s, 8.35, y, W - M - 8.35, 0.98, { fill: C.background2 })
    tile(s, ic, 8.55, y + 0.21, 0.56)
    txt(s, t, 9.3, y + 0.1, 3.3, 0.38, { size: 17, bold: true })
    txt(s, d, 9.3, y + 0.5, 3.4, 0.4, { size: 13, color: C.text2 })
  })
}

{
  const s = content(S2, '模型与知识：密钥只写变量名，检索三选一')
  const w = (W - 2 * M - 0.4) / 2
  shot(s, 'models.png', M, 1.45, w, 475 / 800)
  shot(s, 'knowledge.png', M + w + 0.4, 1.45, w, 475 / 800)
  txt(s, bullets(['API key 推荐只填环境变量名', '直接填 key 要先设主密钥 AGENT_SETTINGS_KEY（加密保存，只显示末尾 4 位）', '「DSH 用的 overlay」生成 AI 面的模型配置']), M, 5.35, w, 1.5, { size: 13, color: C.text2, lsm: 1.15 })
  txt(s, bullets(['BM25F（默认，不用模型）/ RAG（pgvector）/ 知识图谱（JSON）', '上传的文档要另一个管理员批准才进索引', '用 RAG 或图谱时，文档正文会发给所选模型']), M + w + 0.4, 5.35, w, 1.5, { size: 13, color: C.text2, lsm: 1.15 })
}

{
  const s = content(S2, 'SNS：和 dsh-im 同一个画面，支持 13 种 SNS', '组件是 dsh-im 自己的设置组件，经过业务系统的 DSH 网关（只给管理员）。截图来自真实 DSH 上的 e2e：LINE 已连接。')
  shot(s, 'sns.png', M, 1.45, 7.4, 481 / 800)
  const sns = ['Slack', 'LINE', 'Teams', 'Telegram', '企业微信应用', '企业微信', '钉钉', '飞书', 'QQ', 'Discord', 'Matrix', 'WhatsApp', 'iMessage']
  txt(s, '13 种 SNS + 邮箱', 8.35, 1.45, 4.4, 0.4, { size: 17, bold: true })
  sns.forEach((t, i) => {
    const x = 8.35 + (i % 3) * 1.47, y = 2.0 + Math.floor(i / 3) * 0.55
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 1.35, h: 0.42, rectRadius: 0.21, fill: { color: 'EEF2FF' }, line: { type: 'none' }, objectName: id('chip') })
    txt(s, t, x, y, 1.35, 0.42, { size: 12, color: C.accent1, align: 'center', valign: 'middle', bold: true })
  })
  txt(s, bullets(['填凭据、扫二维码、手动设置：各自原有的接入方式都能用', '没挂 DSH 网关时，页面说明怎么接，其余功能照常']), 8.35, 5.0, W - M - 8.35, 1.6, { size: 13, color: C.text2, lsm: 1.2 })
}

{
  const s = content(S2, '员工：三步连携自己的 SNS（/me/sns）')
  shot(s, 'me-sns.png', 5.6, 1.45, W - M - 5.6, 481 / 800)
  const steps = [['点「发行连携码」', '出现 6 位数字，10 分钟内有效'], ['单独聊天发送「連携 123456」', '在 LINE / Slack / Teams 等，和组织的机器人'], ['机器人回复"已连携"', '之后就能提问、收审批卡片和通知']]
  steps.forEach(([t, d], i) => {
    const y = 1.55 + i * 1.3
    numDot(s, i + 1, M, y, 0.55, { size: 18 })
    txt(s, t, M + 0.8, y - 0.02, 4.1, 0.5, { size: 17, bold: true })
    txt(s, d, M + 0.8, y + 0.48, 4.1, 0.5, { size: 14, color: C.text2 })
  })
  card(s, M, 5.5, 4.6, 1.15, { fill: 'EEF2FF' })
  txt(s, '只显示本人的连携；管理员也看不到、改不了别人的。还能按种类开关通知、设免打扰时间。', M + 0.25, 5.6, 4.15, 0.95, { size: 13, lsm: 1.2, valign: 'middle' })
}

{
  const s = content(S2, '在 SNS 上用 AI 员工')
  const cards = [
    ['search', '提问', ['直接问："年假怎么申请？"', '"这个审批为什么发给我？"', 'AI 用你的权限查，回答附出处']],
    ['clipboard', '审批卡片', ['【承認のお願い】卡片', '按「承認」/「差戻」按钮', '或回复审批码：差戻 <code> 理由']],
    ['bell', '报告与通知', ['【ご報告】只有件数和链接', '详细内容在网页确认权限后看', '群聊里不回答业务内容']],
  ]
  const cw = (W - 2 * M - 2 * 0.35) / 3
  cards.forEach(([ic, t, items], i) => {
    const x = M + i * (cw + 0.35)
    card(s, x, 1.5, cw, 4.1, { fill: C.background2 })
    tile(s, ic, x + 0.35, 1.85, 0.7, { bg: [C.accent1, C.accent2, C.accent3][i] })
    txt(s, t, x + 0.35, 2.8, cw - 0.7, 0.5, { size: 21, bold: true })
    txt(s, bullets(items, { after: 10 }), x + 0.35, 3.5, cw - 0.7, 2.7, { size: 15, color: C.text2, lsm: 1.2 })
  })
}

// ── section 3 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S3 = '造一个 agent'
sectionSlide(S3, 3, '造一个 AI agent', '用编码 agent 时：skills/agent-builder/SKILL.md')

{
  const s = content(S3, '全流程：九步', '每一步都有参考实现可以复制：examples/leave-requests-knowledge。')
  const steps = [
    ['0', '决策', '写进计划'], ['1', 'IT 系统', 'server-kit'], ['2', 'manifest', '本体'], ['3', '知识', '文档 + 检索'], ['4', '图谱', '为什么发给我'],
    ['5', '评测', '先于调参'], ['6', '设置插件', '画面 · SNS'], ['7', 'AI 面', 'DSH profile'], ['8', '验证', '完成条件'],
  ]
  const cw = (W - 2 * M - 4 * 0.3) / 5
  steps.forEach(([k, t, d], i) => {
    const row = i < 5 ? 0 : 1, col = i < 5 ? i : i - 5
    const x = M + col * (cw + 0.3) + (row ? (cw + 0.3) / 2 : 0), y = row ? 4.15 : 1.6
    card(s, x, y, cw, 2.15, { fill: i === 0 || i === 8 ? 'EEF2FF' : C.background2 })
    numDot(s, k, x + 0.3, y + 0.3, 0.55, { size: 18, bg: i === 0 ? C.accent3 : C.accent1 })
    txt(s, t, x + 0.3, y + 1.0, cw - 0.6, 0.5, { size: 19, bold: true })
    txt(s, d, x + 0.3, y + 1.5, cw - 0.6, 0.4, { size: 14, color: C.text2 })
  })
}

{
  const s = content(S3, '0 先决定，1 再造 IT 系统')
  const w = (W - 2 * M - 0.4) / 2
  card(s, M, 1.45, w, 4.4, { fill: 'FDF2F8' })
  tile(s, 'users', M + 0.35, 1.75, 0.6, { bg: C.accent3 })
  txt(s, '人来决定，不要猜', M + 1.15, 1.78, w - 1.4, 0.55, { size: 19, bold: true, valign: 'middle' })
  txt(s, bullets(['谁用它、读什么、能提什么提案、谁批准', '文档的负责人和可见范围（默认最窄）', '评测的正确答案（文档负责人确认）', '模型：默认 BM25F，不自己选模型和端点', '用哪个 SNS、通知哪些事件'], { after: 8 }), M + 0.35, 2.6, w - 0.7, 3.9, { size: 15, lsm: 1.2 })
  const x2 = M + w + 0.4
  card(s, x2, 1.45, w, 4.4, { fill: C.background2 })
  tile(s, 'database', x2 + 0.35, 1.75, 0.6)
  txt(s, 'IT 系统（server-kit）', x2 + 1.15, 1.78, w - 1.4, 0.55, { size: 19, bold: true, valign: 'middle' })
  txt(s, bullets(['状态变化：kit.tx + kit.emitEvent 同一个事务', 'hooks：employees · authenticate · isSessionLive · recipientsFor · approvals · proposalKinds · reports · piiScan', 'AI 读：kit.readToolPolicy；写只给人', 'mayDecide 一个函数，网页和聊天都用；申请人不能批自己的'], { after: 8 }), x2 + 0.35, 2.6, w - 0.7, 3.9, { size: 15, lsm: 1.2 })
}

{
  const s = content(S3, '2 manifest：系统的自我介绍，也是本体')
  const parts = [['system · web.routes', '每个可被链接的画面'], ['roles', '委托上限 none / read / propose'], ['entities', 'pii、画面 link'], ['events', '框架的 3 个事件 + 业务事件；只有 ID、日期、件数、状态'], ['tools', '读工具 + knowledge_search + graph_neighbors + 提案'], ['playbooks · reports', 'playbook 默认关；报告只有件数']]
  const cw = (W - 2 * M - 0.3) / 2
  parts.forEach(([k, v], i) => {
    const x = M + (i % 2) * (cw + 0.3), y = 1.45 + Math.floor(i / 2) * 1.12
    card(s, x, y, cw, 0.95, { fill: C.background2 })
    txt(s, k, x + 0.3, y, 2.6, 0.95, { size: 15, bold: true, color: C.accent1, valign: 'middle', font: 'Consolas' })
    txt(s, v, x + 2.95, y, cw - 3.15, 0.95, { size: 14, valign: 'middle', lsm: 1.15 })
  })
  code(s, ['npx bridge-validate manifest bridge.manifest.yaml --strict      # 必须输出 ok'], M, 5.0, W - 2 * M, 0.7, 14)
  txt(s, '图谱的骨架（角色、实体、事件、接收规则）直接由 manifest 生成，不用模型。', M, 5.95, W - 2 * M, 0.45, { size: 15, color: C.text2 })
}

{
  const s = content(S3, '3 知识层：三种检索方式，都是权限优先')
  const cols = [
    ['search', 'BM25F', '默认', ['不需要模型', '标题、关键词、正文加权', '同义词、虚词可调']],
    ['vector', 'RAG', '需要 embedding 模型', ['BM25F + 向量（RRF 融合）', 'pgvector 只存哈希和向量，不存正文', '没改过的块不重做 embedding']],
    ['graph', '知识图谱', '需要基础模型', ['模型把文档抽成实体和关系', '存 JSON：只有名字、类型、块 ID', '检索：BM25F + 图谱']],
  ]
  const cw = (W - 2 * M - 2 * 0.35) / 3
  cols.forEach(([ic, t, need, items], i) => {
    const x = M + i * (cw + 0.35)
    card(s, x, 1.45, cw, 4.1, { fill: i === 0 ? 'EEF2FF' : C.background2 })
    tile(s, ic, x + 0.35, 1.75, 0.6, { bg: [C.accent1, C.accent2, C.accent3][i] })
    txt(s, t, x + 1.15, 1.72, cw - 1.4, 0.4, { size: 20, bold: true })
    txt(s, need, x + 1.15, 2.12, cw - 1.4, 0.3, { size: 12, color: C.text2 })
    txt(s, bullets(items, { after: 8 }), x + 0.35, 2.75, cw - 0.7, 2.6, { size: 14, lsm: 1.2 })
  })
  card(s, M, 5.8, W - 2 * M, 0.85, { fill: 'ECFDF3' })
  tile(s, 'shield', M + 0.2, 5.93, 0.6, { bg: C.accent5 })
  txt(s, '向量和图谱只在提问者能看的块里比较；模型出错时退回 BM25F，并在状态和报告里写明。', M + 1.0, 5.8, W - 2 * M - 1.2, 0.85, { size: 15, valign: 'middle' })
}

{
  const s = content(S3, '知识文档：一份 Markdown，可见范围写在里面')
  code(s, ['---', 'id: lending-rules', 'title: Lending rules', 'link: /handbook/lending-rules', 'roles: [admin, manager, staff]', 'keywords: [loan, borrow, return]', '---', '## Returning equipment {#returning}', '...', '## Approval limits {#approval-limits roles=admin,manager}'], M, 1.45, 7.2, 4.1, 14)
  txt(s, bullets(['行尾和 {…} 后面不能写注释（会被当成值）', '节只能把可见范围收窄，不能放宽', '每种服务的语言各写一份', '建索引时做个人信息检查：联系方式、长号码、名册里的姓名；查出来就拒绝，要改文档，不能关检查', '管理员也可以在设置画面上传（要另一个管理员批准）'], { after: 10 }), 8.15, 1.6, W - M - 8.15, 5, { size: 15, lsm: 1.25 })
}

{
  const s = content(S3, '4 图谱与 5 评测')
  const w = (W - 2 * M - 0.4) / 2
  card(s, M, 1.45, w, 4.4, { fill: C.background2 })
  tile(s, 'graph', M + 0.35, 1.75, 0.6, { bg: C.accent2 })
  txt(s, '"这件事为什么发给我？"', M + 1.15, 1.78, w - 1.4, 0.55, { size: 18, bold: true, valign: 'middle' })
  txt(s, bullets(['业务系统提供 canRead（和画面同一个规则）和 neighbors（直接关系）', '关系名用 requested_by · assigned_to · required_role，才能给出理由', '工具 <ns>_graph_why：你提的、分配给你、等你的角色决定、接收规则…', '看不到的对象一律"找不到"'], { after: 8 }), M + 0.35, 2.6, w - 0.7, 3.9, { size: 14, lsm: 1.2 })
  const x2 = M + w + 0.4
  card(s, x2, 1.45, w, 4.4, { fill: 'EEF2FF' })
  tile(s, 'flask', x2 + 0.35, 1.75, 0.6)
  txt(s, '评测：调参之前写', x2 + 1.15, 1.78, w - 1.4, 0.55, { size: 18, bold: true, valign: 'middle' })
  const st = [['≥ 20', '题 / 每种语言'], ['≥ 80 %', 'hit@3'], ['0', '泄漏']]
  st.forEach(([v, l], i) => {
    const x = x2 + 0.35 + i * 1.9
    txt(s, v, x, 2.65, 1.85, 0.7, { size: 30, bold: true, color: C.accent1 })
    txt(s, l, x, 3.35, 1.85, 0.4, { size: 13, color: C.text2 })
  })
  txt(s, bullets(['包括受限节被无权角色提问（forbid）和范围外的问题', '先记录第一次的数字；test/evals.test.mjs 固定下限', '同一个 knowledgeOptions 对象给应用和评测'], { after: 8 }), x2 + 0.35, 4.0, w - 0.7, 2.5, { size: 14, lsm: 1.2 })
}

{
  const s = content(S3, '6 设置插件：四步接上')
  const steps = [
    ['createAgentSettings', '在 createBridgeApp 之前创建，包住 hooks.approvals 和 hooks.recipientsFor'],
    ['agent.register', '注册画面和 API；registerKnowledge(bridge, agent.knowledge)'],
    ['manifest', '实体 knowledge_document、事件和模板 knowledge.updated、路由 /agent-settings 和 /me/sns'],
    ['DSH 网关 + 登录', 'createDshGateway（/dsh，只给管理员）；redirectToSignIn → gateway → bridge；没有登录页就用 signInPage'],
  ]
  steps.forEach(([k, v], i) => {
    const y = 1.5 + i * 1.18
    numDot(s, i + 1, M, y + 0.2, 0.55, { size: 18 })
    card(s, M + 0.85, y, W - 2 * M - 0.85, 1.0, { fill: C.background2 })
    txt(s, k, M + 1.15, y, 3.4, 1.0, { size: 16, bold: true, color: C.accent1, valign: 'middle', font: 'Consolas' })
    txt(s, v, M + 4.6, y, W - 2 * M - 4.9, 1.0, { size: 14, valign: 'middle', lsm: 1.15 })
  })
  txt(s, '数据目录（设置、上传文档、向量文件、图谱 JSON）要 git 忽略；连接串和 key 永远不写进文件。', M, 6.3, W - 2 * M, 0.4, { size: 14, color: C.text2 })
}

{
  const s = content(S3, '7 AI 面：DSH 上的插件', '模板的 bundle 里已经包含 memory、persona、reader。knowledge 和 graph 通过 bridge-tools 的 toolModules 加进来。')
  const ps = [
    ['bridge-apps', '应用注册、委托'], ['dsh-im', '13 种 SNS 的 IM 网关'], ['bridge-identity', '连携码、链接守卫'], ['bridge-tools', '业务工具、提案'],
    ['bridge-events', '拉取业务事件'], ['bridge-notify', '事件通知'], ['bridge-approvals', '审批卡片'], ['bridge-assistant', '网页的 AI 助手'],
    ['bridge-memory', '长期记忆（PII 检查）'], ['bridge-persona', 'AI 员工资料'], ['bridge-reader', '读扫描文档'], ['bridge-knowledge', '知识检索 + 出处守卫'],
    ['bridge-graph', '为什么发给我'], ['auto-tasks', '自动任务'], ['dsh-proactive', '主动投递的守卫'],
  ]
  const cw = (W - 2 * M - 4 * 0.2) / 5, ch = 1.45
  ps.forEach(([k, v], i) => {
    const x = M + (i % 5) * (cw + 0.2), y = 1.45 + Math.floor(i / 5) * (ch + 0.2)
    const agent = k === 'bridge-knowledge' || k === 'bridge-graph'
    card(s, x, y, cw, ch, { fill: agent ? 'EEF2FF' : C.background2 })
    txt(s, k, x + 0.22, y + 0.22, cw - 0.44, 0.45, { size: 14, bold: true, color: agent ? C.accent1 : C.text1, font: 'Consolas' })
    txt(s, v, x + 0.22, y + 0.72, cw - 0.44, 0.6, { size: 13, color: C.text2 })
  })
  txt(s, '浅紫色 = biz-ai-agent 的 agent 层插件', M, 6.55, 6, 0.3, { size: 12, color: C.text2 })
}

{
  const s = content(S3, '7 安装 profile：发送设置保持关闭')
  const steps = ['复制 profile/template/，填好所有 <placeholder>', '在 dsh-im 里为应用创建机器人，记下 botId', 'bridge-apps：变量名 + generateTools: false', 'toolModules 加 knowledge 和 graph；出处守卫的 bundle', '每个应用都写 linkGuard 的 URL', 'install.mjs 安装，check.mjs 检查，在隔离的 home 启动 DSH']
  steps.forEach((t, i) => {
    const y = 1.5 + i * 0.83
    numDot(s, i + 1, M, y + 0.05, 0.45, { size: 14 })
    txt(s, t, M + 0.7, y, 5.6, 0.6, { size: 15, valign: 'middle', lsm: 1.1 })
  })
  code(s, ['- id: bridge-tools', "  name: '@dsh-bridge/plugin-tools'", '  config:', '    groupChat: deny', '    toolModules:', "      - { module: '@dsh-bridge/plugin-knowledge',", '          application: <system-id> }', "      - { module: '<plugins/graph 的 file URL>',", '          application: <system-id> }'], 7.0, 1.45, W - M - 7.0, 3.75, 13)
  card(s, 7.0, 5.45, W - M - 7.0, 1.2, { fill: 'FFF7E6' })
  txt(s, 'forwardPluginSources: [] · deliveryGuard: required · restrictDelivery: true · groupChat: deny · audienceText: template —— 要打开只能显式改那一行并写理由', 7.25, 5.5, W - M - 7.5, 1.1, { size: 12, valign: 'middle', lsm: 1.2 })
}

// ── section 4 ────────────────────────────────────────────────────────────────────────────────────────────────────────
const S4 = '部署与运维'
sectionSlide(S4, 4, '部署与运维', '配置 · 安全规则 · 完成条件 · 同步 · 排查')

{
  const s = content(S4, '部署与配置：只写变量名，值放在环境里')
  const rows = [
    ['<APP>_SERVICE_TOKEN · <APP>_BFF_SECRET', '服务令牌、BFF 密钥（生产必须设）'],
    ['<APP>_WEB_URL', '业务网页的公开 URL（出处链接）'],
    ['<APP>_DATA_DIR', '设置插件的数据目录（git 忽略）'],
    ['AGENT_SETTINGS_KEY', '主密钥：允许画面直接输入 key 时加密'],
    ['AGENT_VECTOR_DB_URL', 'pgvector 连接（或传入自己的连接池）'],
    ['模型 key 的变量（名字自定）', '画面和 overlay 里只填变量名'],
    ['DSH_HOME', 'DSH 的隔离 home（不用个人的 ~/.dsh）'],
  ]
  const hdr = { bold: true, color: 'FFFFFF', fill: { color: HEX.accent1 }, fontSize: 14 }
  s.addTable([[{ text: '变量', options: hdr }, { text: '用途', options: hdr }], ...rows.map(([a, b], i) => [
    { text: a, options: { fontFace: 'Consolas', fontSize: 13, color: HEX.dk1, fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } },
    { text: b, options: { fontSize: 14, color: HEX.dk1, fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } },
  ])], { x: M, y: 1.45, w: 8.2, colW: [3.9, 4.3], rowH: 0.56, border: { type: 'solid', color: 'E3E8EF', pt: 0.75 }, margin: [0.06, 0.12, 0.06, 0.12], valign: 'middle', objectName: id('table') })
  card(s, 9.15, 1.45, W - M - 9.15, 4.5, { fill: C.background2 })
  tile(s, 'rocket', 9.45, 1.75, 0.6)
  txt(s, '部署的形', 10.25, 1.78, 2.5, 0.55, { size: 18, bold: true, valign: 'middle' })
  txt(s, bullets(['业务系统 + 业务网页 / BFF（含 DSH 网关）同源', 'DSH 单独进程，只在内网被网关访问', 'pgvector：业务的 PostgreSQL 加 vector 扩展', '.data、.env.local、.dsh-home*、.dsh-cli 不进 git'], { after: 8 }), 9.45, 2.6, W - M - 9.75, 3.3, { size: 13, lsm: 1.2 })
}

{
  const s = content(S4, '安全规则：必须遵守')
  const rules = [
    ['eye', 'AI 只读和提案', '写入 API 对委托返回 403；AI 不决定金额'],
    ['bell', '接收人由业务系统决定', '逐人确认"他在网页上能看到吗"；定不了就不发'],
    ['lock', '不带个人信息', 'payload 只有 ID、日期、件数、状态'],
    ['link', '连携只由本人完成', '在业务系统自己的登录下；管理员也不能代办'],
    ['key', '密钥不进仓库、日志、聊天', '配置里只写环境变量名'],
    ['shield', '发送设置保持关闭', '打开只能显式 opt-in 并写理由'],
    ['flask', '只用虚构数据和测试环境', 'DSH 用隔离的 home；不碰生产和演示'],
    ['layers', '不在业务系统里改 framework', '用 hooks、toolModules、设置来补'],
  ]
  const cw = (W - 2 * M - 0.4) / 2
  rules.forEach(([ic, t, d], i) => {
    const x = M + (i % 2) * (cw + 0.4), y = 1.45 + Math.floor(i / 2) * 1.3
    tile(s, ic, x, y + 0.1, 0.56, { bg: i < 2 ? C.accent3 : C.accent1 })
    txt(s, t, x + 0.85, y + 0.02, cw - 0.9, 0.42, { size: 17, bold: true })
    txt(s, d, x + 0.85, y + 0.48, cw - 0.9, 0.5, { size: 14, color: C.text2 })
  })
}

{
  const s = content(S4, '完成条件：全部用命令确认', '没跑的写"未验证"。真实 IM 和真实模型上的确认是另外一步。')
  const rows = [
    ['manifest', 'bridge-validate manifest --strict', 'ok'],
    ['conformance', 'test/conformance.test.mjs', '52 / 52，无 skip、无 known gap'],
    ['业务规则', 'test/app.test.mjs', '破坏一条规则时有测试失败'],
    ['知识的权限 · 无侧信道', 'test/knowledge.test.mjs', '结果都是提问者能看的；分数不变'],
    ['K-01…K-08 · G-01…G-07', 'runKnowledgeChecks · runGraphChecks', '全部通过'],
    ['评测', 'npm run evals', 'hit@3 ≥ 80 %，泄漏 0'],
    ['设置插件', 'test/agent-settings.test.mjs', '只给管理员；上传者不能批'],
    ['DSH profile', 'profile/scripts/check.mjs', '无错误'],
    ['端到端 · 全仓库', 'npm run e2e · npm test', '全部 PASS · 0 失败'],
  ]
  const hdr = { bold: true, color: 'FFFFFF', fill: { color: HEX.accent1 }, fontSize: 14 }
  s.addTable([[{ text: '检查', options: hdr }, { text: '命令 / 方法', options: hdr }, { text: '标准', options: hdr }], ...rows.map(([a, b, c], i) => {
    const fill = { color: i % 2 ? 'FFFFFF' : HEX.lt2 }
    return [{ text: a, options: { bold: true, fontSize: 13, color: HEX.dk1, fill } }, { text: b, options: { fontFace: 'Consolas', fontSize: 12, color: HEX.accent1, fill } }, { text: c, options: { fontSize: 13, color: HEX.dk1, fill } }]
  })], { x: M, y: 1.4, w: W - 2 * M, colW: [3.4, 4.6, W - 2 * M - 8.0], rowH: 0.5, border: { type: 'solid', color: 'E3E8EF', pt: 0.75 }, margin: [0.05, 0.12, 0.05, 0.12], valign: 'middle', objectName: id('table') })
}

{
  const s = content(S4, '维护：framework 在 framework 里改，再同步')
  const flow = [['code', '在 framework 仓库改', '提交（工作区要干净）'], ['refresh', 'npm run sync-framework', '只拷已提交的文件，记下 commit'], ['terminal', 'npm install · vendor:install', '所有 @dsh-bridge/* 链接到仓库内'], ['check', 'npm test · npm run e2e', '0 失败，15 / 15']]
  const cw = (W - 2 * M - 3 * 0.45) / 4
  flow.forEach(([ic, t, d], i) => {
    const x = M + i * (cw + 0.45)
    card(s, x, 1.55, cw, 2.6, { fill: i === 1 ? 'EEF2FF' : C.background2 })
    tile(s, ic, x + 0.3, 1.85, 0.6)
    txt(s, t, x + 0.3, 2.65, cw - 0.6, 0.6, { size: 15, bold: true, lsm: 1.1 })
    txt(s, d, x + 0.3, 3.3, cw - 0.6, 0.7, { size: 13, color: C.text2, lsm: 1.15 })
    if (i < 3) arrow(s, x + cw + 0.05, 2.85, x + cw + 0.4, 2.85, '818CF8')
  })
  txt(s, bullets(['来源 commit 记在 framework.sync.json（当前 9a86b0f）；pnpm 的 workspace: 写法换成普通版本号', '在这边直接改拷贝过来的文件，下次同步会被覆盖', 'biz-ai-agent 自己的部分（knowledge、graph、agent-settings、示例、agent-builder、本手册）同步时不碰', '改了设置画面的源码：npm run build -w @dsh-bridge/agent-settings（dist/ 提交）'], { after: 8 }), M, 4.5, W - 2 * M, 2.2, { size: 15, lsm: 1.2 })
}

{
  const s = content(S4, '故障排查：最常见的六种')
  const rows = [
    ['在 SNS 上只回"请先连携"', '在 /me/sns 发行连携码，单独聊天发「連携 123456」'],
    ['审批卡片没到', '审批人没连携；审批人就是上传者；只有一个管理员 → 把经理加进审批角色'],
    ['检索不到某个文档', '角色看不到（正常）；被个人信息检查拒绝；还没批准；看评测分数'],
    ['AI 回答里的链接不见了', '链接守卫删了：检查 linkGuard.webUrls 和 manifest 的 web.routes'],
    ['RAG 退回了 BM25F', 'embedding 连接失败或 pgvector 连不上（AGENT_VECTOR_DB_URL）'],
    ['e2e：DSH 启动超时', '残留的 DSH 进程或端口被占；内存不足时重跑'],
  ]
  rows.forEach(([a, b], i) => {
    const y = 1.45 + i * 0.86
    card(s, M, y, W - 2 * M, 0.74, { fill: i % 2 ? 'FFFFFF' : C.background2, line: i % 2 ? 'E3E8EF' : undefined })
    tile(s, 'alert', M + 0.15, y + 0.12, 0.5, { bg: 'FFF1EC', fg: 'C2410C' })
    txt(s, a, M + 0.85, y, 4.0, 0.74, { size: 15, bold: true, valign: 'middle' })
    txt(s, b, M + 4.95, y, W - 2 * M - 5.15, 0.74, { size: 14, color: C.text2, valign: 'middle' })
  })
  txt(s, '更多：docs/MANUAL.md 第 14 章 · GUIDELINE 第 g 节', M, 6.7, 8, 0.3, { size: 12, color: C.text2 })
}

// ── closing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = pres.addSlide({ masterName: 'TITLE_DARK', sectionTitle: S4 })
  s.addText('下一步：造你的第一个 agent', { placeholder: 'title' })
  s.addText('让编码 agent 读 skills/agent-builder/SKILL.md，从一项业务开始', { placeholder: 'body' })
  tile(s, 'rocket', M, 1.3, 0.85, { bg: C.accent3 })
  const refs = [['docs/MANUAL.md', '本手册的完整版'], ['skills/agent-builder', '造 agent 的步骤'], ['docs/GUIDELINE.zh-CN.md', 'framework 开发指南'], ['docs/ARCHITECTURE.md', '架构与安全承诺']]
  refs.forEach(([k, v], i) => {
    const x = M + i * 3.05
    txt(s, k, x, 5.55, 2.9, 0.4, { size: 13, bold: true, color: 'C7C8FF', font: 'Consolas' })
    txt(s, v, x, 5.95, 2.9, 0.4, { size: 12, color: '94A3B8' })
  })
}

;(async () => {
  await pres.writeFile({ fileName: OUT })
  if (!process.env.NOTHEME) await applyTheme(OUT, THEME)
  console.log('wrote', OUT, 'slides:', pres.slides.length)
})()
