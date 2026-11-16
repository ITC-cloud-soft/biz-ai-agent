// Files attached in the AI assistant panel (docs/ASSISTANT_ATTACHMENTS.md): choose files, drag and drop, paste an image from the
// clipboard, thumbnails / names / sizes with × to remove, the limits and types shown, images refused with the reason when the
// model cannot read them, the privacy line, "sending" while the message is on its way.
// State lives in useAssistantAttachments (the host also wires its text box: onPaste={h.onPaste}, and may make its whole panel a
// drop zone with {...h.dropProps}); <AssistantAttachmentPicker handle={h} /> renders it. h.message() is the body part
// `attachments: [{ name, mediaType, data }]`; call h.clear() after a successful send.
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import {
  ASSISTANT_ATTACHMENT_LIMITS, acceptFor, fileToBase64, formatBytes, planAdd, pastedName, sniffMatches, toMessageAttachments,
  type AttachmentErrorCode, type AttachmentLimits, type AttachmentSettings, type AttachmentType, type PickedAttachment,
} from '../core/assistant-attachments-core.ts'
import type { StringKey } from '../core/strings-core.ts'
import { useWebKit } from './context.tsx'

export interface UseAssistantAttachmentsOptions {
  /** The employee's settings (GET /bridge/v1/assistant/attachment-settings, normAttachmentSettings). null / undefined: not offered. */
  settings?: AttachmentSettings | null
  /** The AI employee's capabilities.images (agents.list): false refuses images, null = unknown (images are sent). */
  images?: boolean | null
}

export interface AssistantAttachmentsHandle {
  items: PickedAttachment[]
  /** Messages of the files just refused (cleared on the next add / remove). */
  errors: string[]
  reading: boolean
  dragging: boolean
  /** The settings exist and allow this employee at least one type. */
  enabled: boolean
  settings: AttachmentSettings | null
  images: boolean | null
  limits: AttachmentLimits
  /** The types that can be chosen now (images left out when the model cannot read them). */
  types: AttachmentType[]
  add: (files: FileList | readonly File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  /** Show a server refusal (the error code of the BFF's answer) next to the files. */
  showError: (code: AttachmentErrorCode, name?: string) => void
  onPaste: (e: ClipboardEvent<HTMLElement>) => void
  dropProps: { onDragOver: (e: DragEvent<HTMLElement>) => void; onDragEnter: (e: DragEvent<HTMLElement>) => void; onDragLeave: (e: DragEvent<HTMLElement>) => void; onDrop: (e: DragEvent<HTMLElement>) => void }
  /** The body part of the message: [{ name, mediaType, data }]. */
  message: () => { name: string; mediaType: string; data: string }[]
}

const TYPE_KEYS: Record<AttachmentType, StringKey> = {
  image: 'attach.typeImage', pdf: 'attach.typePdf', docx: 'attach.typeDocx', xlsx: 'attach.typeXlsx', csv: 'attach.typeCsv', markdown: 'attach.typeMarkdown', text: 'attach.typeText',
}

let seq = 0
const newId = () => `att-${Date.now().toString(36)}-${(seq += 1)}`
const canPreview = () => typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'

export function useAssistantAttachments({ settings = null, images = null }: UseAssistantAttachmentsOptions = {}): AssistantAttachmentsHandle {
  const { t } = useWebKit()
  const [items, setItems] = useState<PickedAttachment[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const itemsRef = useRef<PickedAttachment[]>([])
  itemsRef.current = items
  const depth = useRef(0)
  const pasted = useRef(0)

  const limits = settings?.limits ?? ASSISTANT_ATTACHMENT_LIMITS
  const enabled = !!settings?.enabled
  const types = (settings?.types ?? []).filter((x) => !(x === 'image' && images === false))
  const vars = useCallback((name?: string) => ({
    name: name ?? t('attach.someFile'), maxFiles: limits.maxFiles, maxFile: formatBytes(limits.maxFileBytes), maxTotal: formatBytes(limits.maxTotalBytes),
  }), [t, limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes])
  const errText = useCallback((code: AttachmentErrorCode, name?: string) => t(`attach.err.${code}` as StringKey, vars(name)), [t, vars])

  // object URLs of the thumbnails are released when a file is removed and when the panel goes away
  useEffect(() => () => { for (const x of itemsRef.current) if (x.previewUrl) URL.revokeObjectURL(x.previewUrl) }, [])

  const add = useCallback(async (list: FileList | readonly File[]) => {
    const files = Array.from(list)
    if (!files.length) return
    if (!enabled) { setErrors([t('attach.err.attachments_not_allowed')]); return }
    const named = files.map((f) => (f.name ? f : new File([f], pastedName(f.type, (pasted.current += 1)), { type: f.type })))
    const plan = planAdd(itemsRef.current, named.map((f) => ({ name: f.name, mediaType: f.type, size: f.size })), { limits, types: settings?.types ?? [], images })
    const messages = plan.errors.map((e) => errText(e.code, e.name))
    setReading(true)
    const next: PickedAttachment[] = []
    try {
      for (const a of plan.accept) {
        const f = named[a.index]
        try {
          const { data, head } = await fileToBase64(f)
          if (!sniffMatches(a.type, a.mediaType, head)) { messages.push(errText('type_mismatch', f.name)); continue }
          next.push({ id: newId(), name: f.name, mediaType: a.mediaType, type: a.type, size: f.size, data, previewUrl: a.type === 'image' && canPreview() ? URL.createObjectURL(f) : null })
        } catch {
          messages.push(errText('invalid_attachment', f.name))
        }
      }
    } finally {
      setReading(false)
    }
    setErrors(messages)
    if (next.length) setItems((cur) => [...cur, ...next])
  }, [enabled, limits, settings?.types, images, errText, t])

  const remove = useCallback((id: string) => {
    setItems((cur) => {
      const gone = cur.find((x) => x.id === id)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return cur.filter((x) => x.id !== id)
    })
    setErrors([])
  }, [])
  const clear = useCallback(() => {
    for (const x of itemsRef.current) if (x.previewUrl) URL.revokeObjectURL(x.previewUrl)
    setItems([])
    setErrors([])
  }, [])
  const showError = useCallback((code: AttachmentErrorCode, name?: string) => setErrors([errText(code, name)]), [errText])

  const onPaste = useCallback((e: ClipboardEvent<HTMLElement>) => {
    if (!enabled) return
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/') || f.name)
    if (!files.length) return
    e.preventDefault()
    void add(files)
  }, [add, enabled])

  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const dropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => { if (enabled && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } },
    onDragEnter: (e: DragEvent<HTMLElement>) => { if (enabled && hasFiles(e)) { depth.current += 1; setDragging(true) } },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (enabled && hasFiles(e)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false) } },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!enabled || !hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      void add(e.dataTransfer.files)
    },
  }

  return {
    items, errors, reading, dragging, enabled, settings, images, limits, types,
    add, remove, clear, showError, onPaste, dropProps, message: () => toMessageAttachments(itemsRef.current),
  }
}

export interface AssistantAttachmentPickerProps {
  handle: AssistantAttachmentsHandle
  /** The message is being sent: the files cannot be changed, 「送信中…」 is shown. */
  busy?: boolean
  disabled?: boolean
  /** The privacy line (default true). */
  showPrivacy?: boolean
  /** The limits line (default true). */
  showLimits?: boolean
}

export function AssistantAttachmentPicker({ handle: h, busy = false, disabled = false, showPrivacy = true, showLimits = true }: AssistantAttachmentPickerProps) {
  const { t, ui, cls } = useWebKit()
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  if (!h.settings) return null
  if (!h.enabled) return <p className={cls('attachNote')}>{t('attach.disabledRole')}</p>
  const typeNames = h.types.map((x) => t(TYPE_KEYS[x])).join('・')
  const total = h.items.reduce((n, x) => n + x.size, 0)
  const locked = busy || disabled || h.reading
  const full = h.items.length >= h.limits.maxFiles
  return (
    <div className={h.dragging ? `${cls('attach')} ${cls('attachDragging')}` : cls('attach')} {...h.dropProps} aria-describedby={`${uid}-limits`}>
      <div className={cls('attachBar')}>
        <input ref={input} type="file" multiple hidden accept={acceptFor(h.types)} tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const files = e.currentTarget.files; if (files) void h.add(Array.from(files)); e.currentTarget.value = '' }} />
        <ui.Button size="sm" variant="ghost" icon="paperclip" disabled={locked || full || !h.types.length} loading={h.reading}
          aria-label={t('attach.buttonLabel', { types: typeNames })} onClick={() => input.current?.click()}>
          {t('attach.button')}
        </ui.Button>
        {h.items.length ? <span className={cls('attachSize')}>{t('attach.count', { n: h.items.length, max: h.limits.maxFiles, total: formatBytes(total) })}</span> : null}
        {busy ? <span className={cls('attachNote')} role="status">{t('attach.sending')}</span> : h.reading ? <span className={cls('attachNote')} role="status">{t('attach.reading')}</span> : null}
      </div>
      {h.dragging ? <p className={cls('attachNote')}>{t('attach.dropHere')}</p> : null}
      {h.items.length ? (
        <ul className={cls('attachList')}>
          {h.items.map((x) => (
            <li key={x.id} className={cls('attachChip')}>
              {x.previewUrl ? <img className={cls('attachThumb')} src={x.previewUrl} alt="" /> : <span className={cls('attachKind')} aria-hidden="true">{t(TYPE_KEYS[x.type])}</span>}
              <span className={cls('attachName')} title={x.name}>{x.name}</span>
              <span className={cls('attachSize')}>{formatBytes(x.size)}</span>
              <button type="button" className={cls('attachRemove')} disabled={busy} aria-label={t('attach.remove', { name: x.name })} onClick={() => h.remove(x.id)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {h.errors.length ? <ul className={cls('attachErrors')} role="alert">{h.errors.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
      {showLimits ? (
        <p id={`${uid}-limits`} className={cls('attachNote')}>
          {t('attach.limits', { types: typeNames, maxFiles: h.limits.maxFiles, maxFile: formatBytes(h.limits.maxFileBytes), maxTotal: formatBytes(h.limits.maxTotalBytes) })}
        </p>
      ) : null}
      {h.images === false && h.settings.types.includes('image') ? <p className={cls('attachNote')}>{t('attach.imagesOff')}</p> : null}
      {h.images === null && h.settings.types.includes('image') ? <p className={cls('attachNote')}>{t('attach.imagesUnknown')}</p> : null}
      {showPrivacy ? <p className={cls('attachNote')}>{t('attach.privacy')}</p> : null}
    </div>
  )
}
