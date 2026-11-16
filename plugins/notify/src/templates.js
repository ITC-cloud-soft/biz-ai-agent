// templates.js — 通知の文面（AI 秘書の形）。業務の文面は持たない：
//
//   1. アプリケーションの文面モジュール（拡張点。templateModules / ctx.bridgeNotify.registerTemplates）
//        render(input) → 文面（frameMessage / frameReport の返り値）| null
//        templates[<template>]({ count, params, items }) → { title, text, intent?, ask?, due?, note? }（事実の文。枠はここで付ける）
//   2. manifest の templates.<template>（description の {param} を数値・日付・時刻だけで埋める。intent / action。件名は events.<type>.label）
//   3. どちらにも無ければ既定の文面（【ご報告】お知らせ）
//
// params は業務システムが返す時刻・件数だけ（氏名・本文・理由・金額は来ない）。ここでも数値と時刻形式以外は使わない（format.js の safe）。
// 意図（【ご報告】【対応のお願い】【至急】）・あいさつ・署名（— <アプリ名> AI 秘書。AI 社員の呼び名 nickname があれば — <呼び名>（<アプリ名> AI 秘書））・
// リンクの行は @dsh-bridge/dsh-core の frameMessage。
import { LINK_LEAD, REPORT_LABEL, frameMessage, greetingAt, normalizeIntent, signatureOf } from '@dsh-bridge/dsh-core'
import { plural, safe } from './format.js'

export const FALLBACK_FACT = Object.freeze({ title: 'お知らせ', text: '業務 Web に新しいお知らせがあります。' })

/** 絶対 URL（http/https）だけをリンクにする。相対パスは webUrl を前置。 */
export function absoluteLink(link, webUrl = '') {
  if (typeof link !== 'string' || !link) return null
  if (/^https?:\/\//i.test(link)) return link
  if (link.startsWith('/') && /^https?:\/\//i.test(webUrl)) return `${webUrl.replace(/\/+$/, '')}${link}`
  return null
}

/** manifest の文の {name} を params で埋める（数値と時刻形式以外は '—'）。 */
export const fill = (text, values) => String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
  const v = safe(values[name])
  return v === undefined ? '—' : String(v)
})

const valueOf = (v, ctx) => (typeof v === 'function' ? v(ctx) : v)

/**
 * 事実（{ title, text, intent?, ask?, due?, note? }。intent / ask / due / note は値か ({count, params, items}) => 値）を AI 秘書の文面にする。
 * 文面モジュールの templates が返すものをそのまま渡せる。
 */
export function frameFact(fact, { count = 1, params = {}, items = [], url = null, now = Date.now(), signature } = {}) {
  const ctx = { count, params: params ?? {}, items }
  return frameMessage({
    intent: normalizeIntent(valueOf(fact?.intent, ctx)),
    title: fact?.title,
    lead: fact?.text,
    ask: valueOf(fact?.ask, ctx),
    due: valueOf(fact?.due, ctx),
    note: valueOf(fact?.note, ctx),
    url, count, now, signature,
  })
}

/**
 * 定時報告の枠（文面モジュールが定時報告のイベントを自分の行で組み立てるときに使う）：
 * 【定時のご報告】<head> / あいさつ＋opening / 本文の行 / リンク / 署名。
 * @param head   件名の後ろ（'10/26 08:30（テスト送信）'）
 * @param lines  本文の行（あいさつの後ろ。「■ 対応が必要なこと」「■ ご参考」など）
 */
export function frameReport(head, lines, { url = null, now = Date.now(), signature = signatureOf(), opening = '現在の業務状況をご報告します。' } = {}) {
  const title = `${REPORT_LABEL}${head ?? ''}`
  const first = `${greetingAt(now)}${opening}`
  const body = Array.isArray(lines) ? lines.map(String) : []
  return {
    intent: 'info',
    label: REPORT_LABEL,
    title,
    text: [first, ...body, signature].join('\n'),
    body: [title, first, ...body, url ? `${LINK_LEAD}${url}` : '', signature].filter(Boolean).join('\n'),
    url: url || null,
    lines: [first, ...body],
    signature,
  }
}

/**
 * manifest の templates.<template>.description の {name} を params で埋める（params は manifest が型を宣言した数値・日付・時刻だけ。
 * ここでも数値と時刻形式以外は入れない）。件名は events.<type>.label。意図は templates.<template>.intent（info / action / urgent。
 * 既定 info）、お願いしたいことは templates.<template>.action（{name} 可）。まとめ送信（count > 1）では {count} を束の件数以上にする。
 * manifest に無い template は既定の文面（お知らせ・ご報告）。署名はアプリ名（nickname：AI 社員の呼び名。省略可）。
 * @param {object} manifest  アプリケーションの manifest（validateManifest 済み）
 */
export function renderManifestMessage(manifest, { template, type, count, params = {}, link, webUrl, appName, nickname, now = Date.now() }) {
  const def = manifest?.templates?.[template] ?? manifest?.templates?.[type]
  const label = manifest?.events?.[type]?.label ?? manifest?.events?.[template]?.label
  const url = absoluteLink(link, webUrl)
  const signature = signatureOf(appName ?? manifest?.system?.name, nickname)
  const n = plural(count)
  if (!def || typeof def.description !== 'string') {
    return frameMessage({ intent: 'info', title: label ?? appName ?? FALLBACK_FACT.title, lead: FALLBACK_FACT.text, url, count: n, now, signature })
  }
  const values = { ...(params ?? {}) }
  if (n > 1 && !(typeof values.count === 'number' && values.count >= n)) values.count = n
  return frameMessage({
    intent: normalizeIntent(def.intent),
    title: label ?? appName ?? 'お知らせ',
    lead: fill(def.description, values),
    ask: typeof def.action === 'string' && def.action ? fill(def.action, values) : undefined,
    url, count: n, now, signature,
  })
}

/** 文面モジュールの形を確かめる（render / templates / types のどれか）。 */
export function normalizeTemplateModule(mod) {
  const m = mod?.default && typeof mod.default === 'object' && !Array.isArray(mod.default) ? { ...mod.default, ...mod } : mod
  const render = typeof m?.render === 'function' ? m.render : null
  const templates = m?.templates && typeof m.templates === 'object' ? m.templates : null
  const types = Array.isArray(m?.types) ? m.types.map(String) : []
  if (!render && !templates) throw new TypeError('a template module must export render(input) or templates')
  return Object.freeze({ render, templates, types, name: typeof m?.name === 'string' ? m.name : null })
}

/**
 * 1 通分の文面。文面モジュール（先に登録したもの・アプリケーション専用のものが先）→ manifest → 既定。
 * @param {object} input
 * @param {object[]} [input.modules]  normalizeTemplateModule の結果（このアプリケーションに効くもの）
 * @param {object} [input.manifest]
 * @param {string} input.template / input.type
 * @param {number} input.count       束ねた件数
 * @param {object} input.params      最新のイベントの params / input.items 束のすべての params
 * @param {string} [input.nickname]   AI 社員の呼び名（署名。文面モジュールの render にも signature・nickname として渡す）
 * @returns {{ intent, label, title, text, body, url, lines, signature }}
 */
export function renderNotification({ modules = [], manifest = null, template, type, count, params = {}, items, link, webUrl, appName, nickname, now = Date.now() }) {
  const latest = params ?? {}
  const all = Array.isArray(items) && items.length ? items : [latest]
  const n = plural(count)
  const url = absoluteLink(link, webUrl)
  const signature = signatureOf(appName ?? manifest?.system?.name, nickname)
  for (const mod of modules) {
    if (mod.render) {
      const out = mod.render({ template, type, count: n, params: latest, items: all, link, url, webUrl, appName, nickname: nickname || '', signature, now, manifest })
      if (out) return out
    }
    const build = mod.templates?.[template] ?? (template !== type ? mod.templates?.[type] : undefined)
    if (typeof build === 'function') {
      const fact = build({ count: n, params: latest, items: all })
      if (fact) return frameFact(fact, { count: n, params: latest, items: all, url, now, signature })
    }
  }
  return renderManifestMessage(manifest, { template, type, count: n, params: latest, link, webUrl, appName, nickname, now })
}
