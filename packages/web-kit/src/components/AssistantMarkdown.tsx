// An AI assistant's answer as safe Markdown (docs/ASSISTANT_ATTACHMENTS.md §4): bold, italic, headings, bullet and numbered lists,
// tables, code, links. Never HTML: the text is parsed into blocks (assistant-markdown-core / help-markdown-core) and rendered as
// React elements, so any markup in the answer stays text. Links: the business web's own paths (allowedPrefixes) and absolute URLs on
// `origin`, or the hosts in `allowedHosts` (opened in a new tab, rel="noopener noreferrer"); others are shown as plain text.
import { useMemo, type MouseEvent, type ReactNode } from 'react'
import type { Block, Inline } from '../core/help-markdown-core.ts'
import { parseAssistantMarkdown } from '../core/assistant-markdown-core.ts'
import { useWebKit } from './context.tsx'

export interface AssistantMarkdownProps {
  /** The answer's text (Markdown). */
  text: string
  /** The business web's origin (default: location.origin in a browser). */
  origin?: string | null
  /** External hosts an answer may link to (e.g. ['www.mhlw.go.jp'], '*.example.jp' for subdomains). Default: none. */
  allowedHosts?: readonly string[]
  /** Paths of the business web an answer may link to (default ['/']). */
  allowedPrefixes?: readonly string[]
  /** Internal links go through the host's router (default: a normal link). Ctrl / Cmd / Shift / middle clicks are left to the browser. */
  onNavigate?: (href: string) => void
  /** A heading `#` becomes h(1 + offset) (default 2: `#` → h3, so an answer never competes with the page's own headings). */
  headingOffset?: number
  className?: string
}

const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

function InlineView({ inline, onNavigate }: { inline: readonly Inline[]; onNavigate?: (href: string) => void }): ReactNode {
  return inline.map((x, i) => {
    switch (x.kind) {
      case 'bold': return <strong key={i}>{x.text}</strong>
      case 'italic': return <em key={i}>{x.text}</em>
      case 'code': return <code key={i}>{x.text}</code>
      case 'br': return <br key={i} />
      case 'link':
        if (x.external) return <a key={i} href={x.href} target="_blank" rel="noopener noreferrer">{x.text}</a>
        return (
          <a key={i} href={x.href} onClick={onNavigate && !x.href.startsWith('#') ? (e) => { if (plain(e)) { e.preventDefault(); onNavigate(x.href) } } : undefined}>{x.text}</a>
        )
      default: return <span key={i}>{x.text}</span>
    }
  })
}

function BlockView({ block, onNavigate, headingOffset, cls }: { block: Block; onNavigate?: (href: string) => void; headingOffset: number; cls: (k: 'mdTable' | 'mdCode') => string }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      if (block.level === 0) return null
      const level = Math.min(6, Math.max(1, block.level + headingOffset))
      const Tag = `h${level}` as 'h3'
      return <Tag><InlineView inline={block.inline} onNavigate={onNavigate} /></Tag>
    }
    case 'para': return <p><InlineView inline={block.inline} onNavigate={onNavigate} /></p>
    case 'hr': return <hr />
    case 'code': return <pre className={cls('mdCode')}><code>{block.text}</code></pre>
    case 'list': {
      const items = block.items.map((parts, i) => (
        <li key={i}>{parts.map((p, k) => <span key={k}>{k > 0 ? <br /> : null}<InlineView inline={p} onNavigate={onNavigate} /></span>)}</li>
      ))
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table':
      return (
        <div className={cls('mdTable')}>
          <table>
            <thead><tr>{block.header.map((c, i) => <th key={i} scope="col"><InlineView inline={c} onNavigate={onNavigate} /></th>)}</tr></thead>
            <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}><InlineView inline={c} onNavigate={onNavigate} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    default: return null
  }
}

export function AssistantMarkdown({ text, origin, allowedHosts = [], allowedPrefixes = ['/'], onNavigate, headingOffset = 2, className }: AssistantMarkdownProps) {
  const { cls } = useWebKit()
  const own = origin === undefined ? (typeof location !== 'undefined' ? location.origin : null) : origin
  const hostsKey = allowedHosts.join('\n')
  const prefixesKey = allowedPrefixes.join('\n')
  const blocks = useMemo(() => parseAssistantMarkdown(text, { origin: own, allowedHosts, allowedPrefixes }), [text, own, hostsKey, prefixesKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={className ? `${cls('md')} ${className}` : cls('md')}>
      {blocks.map((b, i) => <BlockView key={i} block={b} onNavigate={onNavigate} headingOffset={headingOffset} cls={cls} />)}
    </div>
  )
}
