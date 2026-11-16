// The AI assistant's answers as safe Markdown (docs/ASSISTANT_ATTACHMENTS.md §4). Pure: the reader is help-markdown-core
// (blocks and inlines, never HTML); this file adds the link rule of an answer. A link is kept only when it goes to the business
// web itself (a path under one of `allowedPrefixes`, default '/', or an absolute URL on `origin`) or to one of `allowedHosts`
// (external: opened in a new tab with rel="noopener noreferrer"). Anything else (other hosts, javascript:, data:, mailto:,
// protocol-relative //host) stays text.
import { parseMarkdown, type Block } from './help-markdown-core.ts'

export interface AssistantLinkOptions {
  /** The business web's origin (e.g. location.origin): absolute URLs on it are internal links. */
  origin?: string | null
  /** Hosts an answer may link to (external links), e.g. ['www.mhlw.go.jp']. A leading '*.' allows the subdomains. */
  allowedHosts?: readonly string[]
  /** Paths of the business web an answer may link to (default ['/']: any path of the web). */
  allowedPrefixes?: readonly string[]
}

const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some((a) => {
  const h = a.trim().toLowerCase()
  if (!h) return false
  if (h.startsWith('*.')) return host.endsWith(h.slice(1)) && host.length > h.length - 1
  return host === h
})

const pathAllowed = (path: string, prefixes: readonly string[]) => prefixes.some((p) => {
  if (p === '/') return true
  const base = p.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`)
})

/** The link rule of an answer: href → { href, external } or null (text only). */
export function assistantLinkHref(href: string, { origin = null, allowedHosts = [], allowedPrefixes = ['/'] }: AssistantLinkOptions = {}): { href: string; external: boolean } | null {
  const h = href.trim()
  if (!h || /[\u0000-\u001f\s\\]/.test(h)) return null
  if (h.startsWith('#')) return { href: h, external: false }
  if (h.startsWith('/') && !h.startsWith('//')) return pathAllowed(h, allowedPrefixes) ? { href: h, external: false } : null
  if (!/^https?:\/\//i.test(h)) return null
  let url: URL
  try { url = new URL(h) } catch { return null }
  if (url.username || url.password) return null
  let own: string | null = null
  if (origin) {
    try { own = new URL(origin).origin } catch { own = null }
  }
  if (own && url.origin === own) {
    const path = `${url.pathname}${url.search}${url.hash}`
    return pathAllowed(url.pathname, allowedPrefixes) ? { href: path, external: false } : null
  }
  return hostAllowed(url.hostname.toLowerCase(), allowedHosts) ? { href: url.href, external: true } : null
}

/** An answer's text → blocks (line breaks kept, links by assistantLinkHref). */
export function parseAssistantMarkdown(text: string, opts: AssistantLinkOptions = {}): Block[] {
  return parseMarkdown(String(text ?? ''), { breaks: true, linkHref: (h) => assistantLinkHref(h, opts) })
}
