/**
 * dsh-auto-tasks — 客户端 bundle（手写，无构建步骤）。
 *
 * 由 DSH 的 client ModuleLoader 以 window.__ModuleLoader__.load({id, factory})
 * 的形式加载；id 必须等于 package.json 的 name。
 *
 * 会话页第 7 个 Tab【自动任务】：order 130，紧跟「Memory Evolve 设置」(120)。
 * 0.2.0：概览 / 任务 / 收件箱 / 反馈 / 渠道 / 指南，含投递测试、免打扰、审批与证据门控。
 * @care fork：ModuleLoader id = 包名 `@care/dsh-auto-tasks`；所有请求按 document.baseURI
 * 解析为相对 URL（与 DSH 自身 /api 的解析方式相同），因此挂在 `/dsh/` 子路径下也能用；
 * 任务编辑器新增「事件触发」。
 * i18n：文案走 DSH locale（namespace `dsh-auto-tasks`，本插件只注册 zh / en；
 * ja 由 @care/dsh-lang-ja 注册 —— 同一 (namespace, locale) 不能二重注册）。
 */
import type { Task, Report } from './types.js'
import zhDict from './locales/zh.json' with { type: 'json' }
import enDict from './locales/en.json' with { type: 'json' }

;(window as any).__ModuleLoader__.load({
  id: '@care/dsh-auto-tasks',
  factory: (require: any) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // 相对路径（无前导 /）：按页面的 document.baseURI 解析。DSH 直接访问时 = /auto-tasks/api，
    // 经网关挂在 /dsh/ 下时 = /dsh/auto-tasks/api。
    const API_REL = 'auto-tasks/api'
    function apiUrl(path: string): string {
      const rel = API_REL + path
      try {
        const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : undefined
        return base ? new URL(rel, base).href : rel
      } catch {
        return rel
      }
    }

    /* ------------------------------------------------------------------ css */

    const CSS = `
.at-root{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;padding:0 2px 24px;
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px}
.at-subtabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:12px 0}
.at-subtab{padding:5px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer;transition:.15s}
.at-subtab:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}
.at-subtab.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);
  color:var(--dsw-alias-label-primary);font-weight:600}
.at-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.at-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.at-btn:hover{border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}
.at-btn.primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent);
  color:var(--dsw-alias-label-primary);font-weight:600}
.at-btn.ghost{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}
.at-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.at-btn:disabled{opacity:.5;cursor:not-allowed}
.at-btn.sm{height:26px;padding:0 9px;font-size:12px}
.at-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.at-card+.at-card{margin-top:10px}
.at-muted{color:var(--dsw-alias-label-secondary)}
.at-tiny{font-size:11.5px}
.at-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.at-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
  font-size:11px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-base)}
.at-chip.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);
  color:var(--dsw-alias-state-success-primary)}
.at-chip.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);
  color:var(--dsw-alias-state-error-primary)}
.at-chip.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 45%,transparent);
  color:var(--dsw-alias-state-warning-primary)}
.at-chip.brand{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);
  color:var(--dsw-alias-state-business-primary)}
.at-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:900px){.at-stats{grid-template-columns:repeat(2,1fr)}}
.at-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:13px 15px}
.at-stat .k{font-size:12px;color:var(--dsw-alias-label-secondary)}
.at-stat .v{font-size:24px;font-weight:650;letter-spacing:-.5px;margin-top:4px}
.at-stat .s{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.at-task{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:13px 15px}
.at-task+.at-task{margin-top:9px}
.at-task-h{display:flex;align-items:flex-start;gap:10px}
.at-task-name{font-size:13px;font-weight:600}
.at-task-when{margin-left:auto;flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.at-task-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-items:center}
.at-task-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:9px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.at-fb{display:flex;gap:11px;padding:12px 14px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.at-fb+.at-fb{margin-top:8px}
.at-fb.unread{border-left:2px solid var(--dsw-alias-brand-primary)}
.at-fb-ico{width:26px;height:26px;border-radius:8px;flex:none;display:grid;place-items:center;
  font-size:13px;background:var(--dsw-alias-bg-layer-2)}
.at-fb-body{flex:1;min-width:0}
.at-fb-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.at-fb-at{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);
  font-family:ui-monospace,Menlo,Consolas,monospace}
.at-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px}
.at-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.at-field input,.at-field select,.at-field textarea{height:30px;padding:0 9px;border-radius:6px;
  font:inherit;font-size:12.5px;background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);outline:none}
.at-field textarea{height:auto;min-height:72px;padding:8px 9px;resize:vertical;line-height:1.5}
.at-field input:focus,.at-field select:focus,.at-field textarea:focus{
  border-color:var(--dsw-alias-brand-primary)}
.at-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:760px){.at-row2{grid-template-columns:1fr}}
.at-sw{position:relative;width:34px;height:19px;border-radius:999px;flex:none;
  background:var(--dsw-alias-border-l2);border:0;cursor:pointer;transition:.18s;padding:0}
.at-sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;
  border-radius:50%;background:#fff;transition:.18s}
.at-sw.on{background:var(--dsw-alias-brand-primary)}
.at-sw.on::after{left:17px}
.at-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding:9px 11px;
  border-radius:6px;background:var(--dsw-alias-bg-layer-2);
  border-left:2px solid var(--dsw-alias-border-l2);margin-top:8px;line-height:1.55}
.at-empty{padding:26px 14px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.at-embed{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-base);padding:8px;min-height:280px}
.at-err{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:6px 0}
.at-sec-h{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12.5px;font-weight:600}
.at-sec-h .at-muted{margin-left:auto;font-weight:400;font-size:11.5px}
.at-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.at-target{display:flex;align-items:center;gap:8px;padding:7px 0;
  border-top:1px dashed var(--dsw-alias-border-l1)}
.at-target:first-child{border-top:0}
.at-target-name{flex:1;min-width:0;font-size:12px}
.at-test{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.at-ok{color:var(--dsw-alias-state-success-primary)}
.at-bad{color:var(--dsw-alias-state-error-primary)}
`

    function injectCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-auto-tasks-style')) return
      const el = document.createElement('style')
      el.id = 'dsh-auto-tasks-style'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ----------------------------------------------------------------- http */

    async function api(path: any, options: any = {}) {
      const res = await fetch(apiUrl(path), {
        headers: {
          'content-type': 'application/json',
          'x-auto-tasks-client': 'web',
        },
        ...(options || {}),
        body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
      let data: any = null
      try { data = await res.json() } catch { data = null }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data
    }

    const fmtTime = (iso: any) => {
      if (!iso) return '—'
      try {
        const d = new Date(iso)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      } catch { return String(iso) }
    }
    const fmtDate = (iso: any) => {
      if (!iso) return '—'
      try {
        const d = new Date(iso)
        return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`
      } catch { return String(iso) }
    }

    function triggerText(t: any) {
      if (!t) return ui('trigger.unset')
      if (t.type === 'cron') return `cron ${t.expr}`
      if (t.type === 'every') return ui('trigger.every', { minutes: Math.round((t.everySeconds || 3600) / 60) })
      if (t.type === 'daily') return ui('trigger.daily', { time: t.dailyTime })
      if (t.type === 'after') return ui('trigger.after', { seconds: t.afterSeconds })
      if (t.type === 'event') return ui('trigger.event', { types: (t.eventTypes || []).join(', ') })
      return t.type
    }

    const STATUS_CHIP: Record<string, string> = { done: 'ok', failed: 'err', needsDecision: 'warn', silent: '' }
    const STATUS_ICON: Record<string, string> = { done: '✅', failed: '❌', needsDecision: '🙋', silent: '⏸️' }
    const CHANNEL_LABEL: Record<string, string> = {
      qq: 'QQ', slack: 'Slack', telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp',
      imessage: 'iMessage', matrix: 'Matrix',
    }
    const LOCALIZED_CHANNELS = ['weixin', 'feishu', 'dingtalk', 'wecom', 'wecom-app', 'office', 'email']
    const channelName = (id: any) => (LOCALIZED_CHANNELS.includes(id) ? ui(`channel.${id}`) : CHANNEL_LABEL[id] || id || ui('channel.fallback'))
    const DEFERRED_KEYS = ['quietHours', 'budget', 'status', 'noIm', 'noChannel']
    const deferredText = (d: string) => (DEFERRED_KEYS.includes(d) ? ui(`deferred.${d}`) : d)

    /* ----------------------------------------------------------------- i18n */
    // DSH locale namespace（与 @care/dsh-lang-ja 的 fork-resources 一致）。
    const NS = 'dsh-auto-tasks'
    const DICTS: Record<string, Record<string, string>> = { zh: zhDict as Record<string, string>, en: enDict as Record<string, string> }
    type Translate = (key: string, params?: Record<string, unknown>) => string
    let localeFace: any = null
    let translate: Translate | null = null
    /** locale 服务缺失时的兜底：navigator.language → en / zh。 */
    const fallbackLang = (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('en')) ? 'en' : 'zh'
    function format(text: string, params?: Record<string, unknown>): string {
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (m: string, k: string) => (params[k] === undefined ? m : String(params[k])))
    }
    const ui: Translate = (key, params) => {
      if (translate) return translate(key, params)
      const dict = DICTS[fallbackLang] || DICTS.zh
      return format(dict[key] ?? DICTS.zh[key] ?? key, params)
    }
    /** 订阅 locale 切换，让视图重渲染（与 dsh-proactive 的 use-locale 同一模式）。 */
    function useLocaleRevision(): unknown {
      const subscribe = useCallback((fn: () => void) => (localeFace && typeof localeFace.subscribe === 'function' ? localeFace.subscribe(fn) : () => {}), [])
      const snap = () => {
        try { return localeFace && typeof localeFace.getSnapshot === 'function' ? localeFace.getSnapshot().revision ?? localeFace.getSnapshot().active : 0 } catch { return 0 }
      }
      return React.useSyncExternalStore ? React.useSyncExternalStore(subscribe, snap, snap) : snap()
    }

    interface BotTarget { targetId: string; name?: string; kind?: string; route?: Record<string, unknown> }
    interface BotChannel { botId: string; channel: string; targets?: BotTarget[] }
    interface Health { schedule?: boolean; proactive?: boolean; im?: boolean }
    /** DOM 事件的最小形状（不引 React 类型）。 */
    interface ChangeEvt {
      target: { value: string; checked: boolean }
      key?: string
      preventDefault?: () => void
    }

    /** 视图层统一 props 契约（各子页按需取字段）。 */
    interface ViewProps {
      sessionId?: string
      workspacePath?: string
      tasks?: Task[]
      reports?: Report[]
      channels?: BotChannel[]
      health?: Health | null
      inbox?: any[]
      config?: any
      taskCount?: number
      inboxCount?: number
      unread?: number
      onRefresh?: () => void
      onCreate?: () => void
      onDone?: () => void
      onUnread?: (n: number) => void
      onReadAll?: () => void
      onApprove?: (report: Report) => void
      onToggle?: (task: Task) => void
      onDelete?: (id: string) => void
      onAdopt?: (file: string) => void
      onTest?: (bot: BotChannel, target: BotTarget) => void
      editing?: Task | null
      ctx?: any
      [key: string]: any
    }

    /* ------------------------------------------------------------- components */

    function SubTabs(props: ViewProps) {
      const items = [
        ['overview', ui('overview')],
        ['tasks', `${ui('tasks')}${props.taskCount ? ` (${props.taskCount})` : ''}`],
        ['inbox', `${ui('inbox')}${props.inboxCount ? ` (${props.inboxCount})` : ''}`],
        ['reports', `${ui('reports')}${props.unread ? ` (${props.unread})` : ''}`],
        ['channels', ui('channels')],
        ['guide', ui('guide')],
      ]
      return h('div', { className: 'at-subtabs' },
        items.map(([id, label]: any) =>
          h('button', {
            key: id,
            className: 'at-subtab' + (props.pane === id ? ' on' : ''),
            onClick: () => props.onPane(id),
          }, label)),
        h('span', { className: 'at-right' },
          h('button', { className: 'at-btn sm ghost', onClick: props.onRefresh }, ui('refresh')),
          h('button', { className: 'at-btn sm primary', onClick: props.onCreate }, ui('newTask'))))
    }

    function Overview(props: ViewProps) {
      const tasks = props.tasks || []
      const reports = props.reports || []
      const today = new Date().toDateString()
      const doneToday = reports.filter((r: any) => r.status === 'done' && new Date(r.at).toDateString() === today).length
      const failed = reports.filter((r: any) => r.status === 'failed').length
      const pending = reports.filter((r: any) => r.status === 'needsDecision' && !r.read).length
      const enabled = tasks.filter((t: any) => t.enabled).length
      const paused = tasks.filter((t: any) => !t.enabled && t.pauseReason).length

      return h('div', null,
        h('div', { className: 'at-stats' },
          h('div', { className: 'at-stat' },
            h('div', { className: 'k' }, ui('stat.doneToday')),
            h('div', { className: 'v' }, String(doneToday)),
            h('div', { className: 's' }, ui('stat.doneTodayNote'))),
          h('div', { className: 'at-stat' },
            h('div', { className: 'k' }, ui('pendingFeedback')),
            h('div', { className: 'v' }, String(props.unread || 0)),
            h('div', { className: 's' }, ui('stat.needDecision', { n: pending }))),
          h('div', { className: 'at-stat' },
            h('div', { className: 'k' }, ui('stat.failedPaused')),
            h('div', { className: 'v' }, String(failed)),
            h('div', { className: 's' }, paused ? ui('stat.pausedTasks', { n: paused }) : ui('stat.autoPauseNote'))),
          h('div', { className: 'at-stat' },
            h('div', { className: 'k' }, ui('stat.enabledTasks')),
            h('div', { className: 'v' }, String(enabled)),
            h('div', { className: 's' }, ui('stat.total', { n: tasks.length }) + (props.config && props.config.maxDeliveriesPerDay ? ui('stat.budget', { n: props.config.maxDeliveriesPerDay }) : '')))),

        h('div', { className: 'at-card', style: { marginTop: '12px' } },
          h('div', { className: 'at-sec-h' }, ui('overview.taskList'),
            h('span', { className: 'at-muted' }, props.health && props.health.im ? ui('imOk') : ui('imMissing'))),
          tasks.length === 0
            ? h('div', { className: 'at-empty' }, ui('noTasks'))
            : tasks.map((t: any) => h('div', { key: t.id, className: 'at-task' },
                h('div', { className: 'at-task-h' },
                  h('div', null,
                    h('div', { className: 'at-task-name' }, t.name),
                    h('div', { className: 'at-tiny at-muted' }, triggerText(t.trigger))),
                  h('div', { className: 'at-task-when' },
                    t.nextRunAt ? ui('task.next', { time: fmtDate(t.nextRunAt) }) : (t.enabled ? ui('task.scheduled') : ui('task.paused')))),
                h('div', { className: 'at-task-meta' },
                  h('span', { className: 'at-chip' + (t.enabled ? ' ok' : '') }, t.enabled ? ui('task.enabled') : (t.pauseReason ? ui('task.autoPaused') : ui('task.pause'))),
                  t.approval === 'require' ? h('span', { className: 'at-chip warn' }, ui('task.approvalFirst')) : null,
                  t.guard && t.guard.requireEvidence ? h('span', { className: 'at-chip warn' }, ui('task.requireEvidence')) : null,
                  h('span', { className: 'at-chip mono' }, t.sessionId ? t.sessionId.slice(0, 14) + '…' : '—'),
                  (t.delivery && t.delivery.channels || []).map((c: any, i: any) =>
                    h('span', { key: i, className: 'at-chip' }, `↗ ${c.targetId}`)),
                  !(t.delivery && t.delivery.channels && t.delivery.channels.length)
                    ? h('span', { className: 'at-chip warn' }, ui('task.noDelivery')) : null)))),
      )
    }

    function Tasks(props: ViewProps) {
      const tasks = props.tasks || []
      if (tasks.length === 0) {
        return h('div', { className: 'at-card' },
          h('div', { className: 'at-empty' }, ui('noTasks')))
      }
      return h('div', null, tasks.map((t: any) => h('div', { key: t.id, className: 'at-task' },
        h('div', { className: 'at-task-h' },
          h('div', null,
            h('div', { className: 'at-task-name' }, t.name),
            h('div', { className: 'at-tiny at-muted' }, triggerText(t.trigger))),
          h('div', { className: 'at-task-when' },
            t.nextRunAt ? ui('task.next', { time: fmtDate(t.nextRunAt) }) : (t.lastReportAt ? ui('task.last', { time: fmtDate(t.lastReportAt) }) : ui('task.notRun')))),
        h('div', { className: 'at-task-meta' },
          h('span', { className: 'at-chip' + (t.enabled ? ' ok' : '') }, t.enabled ? ui('task.enabled') : ui('task.pause')),
          h('span', { className: 'at-chip mono' }, t.id),
          (t.triggerMode === 'poll' || t.name === '邮件监控与代处理' || t.name === ui('task.mailMonitorName')) ? h('span', { className: 'at-chip brand' }, ui('task.mailTriggered')) : null,
          t.wakeBackend === 'proactive' ? h('span', { className: 'at-chip brand' }, 'proactive') : null,
          t.approval === 'require' ? h('span', { className: 'at-chip warn' }, ui('task.approvalFirst')) : null,
          t.guard && t.guard.requireEvidence ? h('span', { className: 'at-chip warn' }, ui('task.evidence')) : null,
          t.pauseReason ? h('span', { className: 'at-chip err' }, t.pauseReason) : null,
          t.lastError ? h('span', { className: 'at-chip err' }, ui('task.scheduleError')) : null,
          h('span', { className: 'at-chip' },
            ui('task.channelCount', { n: (t.delivery && t.delivery.channels || []).length }))),
        h('div', { className: 'at-task-foot' },
          h('span', { className: 'at-tiny at-muted' },
            (t.instruction || '').slice(0, 60) + ((t.instruction || '').length > 60 ? '…' : '')),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'at-btn sm ghost', onClick: () => props.onRun(t) }, ui('task.runNow')),
          h('button', { className: 'at-btn sm ghost', onClick: () => props.onEdit?.(t) }, ui('task.edit')),
          h('button', { className: 'at-btn sm ghost', onClick: () => props.onDelete?.(t) }, ui('task.delete')),
          h('button', {
            className: 'at-sw' + (t.enabled ? ' on' : ''),
            onClick: () => props.onToggle?.(t),
            'aria-label': ui('task.enabled'),
          })))))
    }

    function Inbox(props: ViewProps) {
      const items = props.items || []
      return h('div', null,
        h('div', { className: 'at-card' },
          h('div', { className: 'at-sec-h' }, ui('inboxTitle'),
            h('span', { className: 'at-muted' }, props.dir || '')),
          h('div', { className: 'at-tiny at-muted', style: { marginBottom: '10px' } },
            ui('inbox.note1') + ui('inbox.note2')),
          items.length === 0
            ? h('div', { className: 'at-empty' }, ui('inbox.empty'))
            : items.map((it: any) => h('div', { key: it.id, className: 'at-fb', style: { marginTop: '8px' } },
                h('div', { className: 'at-fb-ico' }, '📥'),
                h('div', { className: 'at-fb-body' },
                  h('div', { className: 'at-fb-h' },
                    h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, it.subject || it.fileName),
                    it.from ? h('span', { className: 'at-chip' }, it.from) : null,
                    h('span', { className: 'at-fb-at' }, fmtDate(it.mtime))),
                  h('div', { className: 'at-tiny at-muted', style: { marginTop: '4px' } }, it.preview || ''),
                  h('div', { className: 'at-inline', style: { marginTop: '7px' } },
                    h('button', { className: 'at-btn sm primary', onClick: () => props.onAdopt?.(it) }, ui('adopt')),
                    h('span', { className: 'at-tiny at-muted mono' }, it.fileName)))))))
    }

    function Reports(props: ViewProps) {
      const reports = props.reports || []
      if (reports.length === 0) {
        return h('div', { className: 'at-card' },
          h('div', { className: 'at-empty' }, ui('noReports')))
      }
      return h('div', null,
        h('div', { className: 'at-inline', style: { marginBottom: '10px' } },
          h('span', { className: 'at-tiny at-muted' }, ui('reports.total', { n: reports.length })),
          h('span', { style: { flex: 1 } }),
          (props.unread || 0) > 0
            ? h('button', { className: 'at-btn sm', onClick: props.onReadAll }, ui('readAll'))
            : null),
        reports.map((r: any) => h('div', {
          key: r.id,
          className: 'at-fb' + (r.read === false ? ' unread' : ''),
        },
          h('div', { className: 'at-fb-ico' }, STATUS_ICON[r.status] || '•'),
          h('div', { className: 'at-fb-body' },
            h('div', { className: 'at-fb-h' },
              h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, r.taskName || r.taskId),
              h('span', { className: 'at-chip ' + (STATUS_CHIP[r.status] || '') }, r.status),
              r.verifyFailed ? h('span', { className: 'at-chip err' }, ui('reports.evidenceMissing')) : null,
              r.deferred ? h('span', { className: 'at-chip warn' }, deferredText(r.deferred)) : null,
              (r.delivered || []).map((d: any, i: any) =>
                h('span', { key: i, className: 'at-chip ' + (d.ok ? 'ok' : 'err') },
                  `${d.ok ? '✓' : '✗'} ${d.targetId || d.channel}${d.attempts ? ` ×${d.attempts}` : ''}`)),
              h('span', { className: 'at-fb-at' }, fmtDate(r.at))),
            h('div', { className: 'at-tiny at-muted', style: { marginTop: '4px' } }, r.summary || ''),
            (r.artifacts && r.artifacts.length)
              ? h('div', { className: 'at-inline', style: { marginTop: '7px' } },
                  r.artifacts.map((a: any, i: any) => h('span', { key: i, className: 'at-chip mono' }, '📎 ' + a)))
              : null,
            h('div', { className: 'at-inline', style: { marginTop: '7px' } },
              r.read === false
                ? h('button', { className: 'at-btn sm ghost', onClick: () => props.onRead(r) }, ui('reports.markRead'))
                : null,
              r.status === 'needsDecision'
                ? h('button', { className: 'at-btn sm primary', onClick: () => props.onApprove?.(r) }, ui('reports.approveRun'))
                : null,
              r.approvedAt ? h('span', { className: 'at-chip ok' }, ui('reports.approvedAt', { time: fmtDate(r.approvedAt) })) : null)))))
    }

    function Channels(props: ViewProps) {
      const ctx = props.ctx
      const im = ctx && typeof ctx.get === 'function' ? ctx.get('dshImClient') : undefined
      const imClientAvailable = !!(im && im.version === 1)
      const [embedded, setEmbedded] = useState(false)
      const [tested, setTested] = useState({})
      const bots = props.channels || []

      async function test(bot: any, target: any) {
        const key = `${bot.botId}:${target.targetId}`
        setTested((prev: any) => ({ ...prev, [key]: { state: 'sending' } }))
        try {
          const r = await api('/delivery/test', {
            method: 'POST',
            body: { botId: bot.botId, targetId: target.targetId },
          })
          setTested((prev: any) => ({ ...prev, [key]: { state: r.ok ? 'ok' : 'err', detail: r.ok ? ui('reports.sent') : (r.error || ui('reports.sendFailed')) } }))
        } catch (e: any) {
          setTested((prev: any) => ({ ...prev, [key]: { state: 'err', detail: String(e && e.message || e) } }))
        }
      }

      return h('div', null,
        h('div', { className: 'at-card' },
          h('div', { className: 'at-sec-h' }, ui('channels.linkTitle'),
            h('span', { className: 'at-muted' },
              props.health && props.health.im ? ui('channels.imReady') : ui('channels.imMissing'))),
          h('div', { className: 'at-inline', style: { marginBottom: '10px' } },
            h('button', {
              className: 'at-btn sm primary',
              disabled: !imClientAvailable,
              onClick: () => setEmbedded((v: any) => !v),
            }, embedded ? ui('channels.collapse') : ui('scanChannel')),
            h('span', { className: 'at-chip' + (imClientAvailable ? ' brand' : ' warn') },
              imClientAvailable ? 'dshImClient v1' : ui('channels.noImClient'))),
          bots.length === 0
            ? h('div', { className: 'at-empty' }, ui('channels.noBots'))
            : bots.map((b: any) => h('div', {
                key: b.botId,
                style: { padding: '9px 0', borderTop: '1px dashed var(--dsw-alias-border-l1)' },
              },
                h('div', { className: 'at-inline' },
                  h('span', { style: { fontSize: '12.5px', fontWeight: 550 } }, ui('channels.botTargets', { channel: channelName(b.channel), n: (b.targets || []).length })),
                  h('span', { className: 'at-chip mono' }, b.botId)),
                (b.targets || []).length === 0
                  ? h('div', { className: 'at-tiny at-muted', style: { marginTop: '4px' } }, ui('channels.noTargets'))
                  : (b.targets || []).map((t: any) => {
                      const key = `${b.botId}:${t.targetId}`
                      const st = tested[key]
                      return h('div', { key: t.targetId, className: 'at-target' },
                        h('span', { className: 'at-target-name' },
                          `${t.name || t.targetId} `,
                          h('span', { className: 'at-tiny at-muted mono' }, t.targetId)),
                        st
                          ? h('span', { className: 'at-test ' + (st.state === 'ok' ? 'at-ok' : st.state === 'err' ? 'at-bad' : '') },
                              st.state === 'sending' ? ui('channels.sending') : (st.detail || ''))
                          : null,
                        h('button', {
                          className: 'at-btn sm',
                          disabled: st && st.state === 'sending',
                          onClick: () => test(b, t),
                        }, ui('testDelivery')))
                    }))),
          embedded && imClientAvailable
            ? h('div', { className: 'at-embed', style: { marginTop: '11px' } }, im.render({ preferredSectionId: 'weixin' }))
            : null,
          h('div', { className: 'at-note' },
            ui('channelNote1'),
            h('span', { className: 'at-mono' }, 'botId + targetId'),
            ui('channelNote2'))),
        h('div', { className: 'at-card' },
          h('div', { className: 'at-sec-h' }, ui('sendPolicy')),
          h('div', { className: 'at-note' },
            ui('sendPolicyNote'))))
    }

    function Guide(props: ViewProps) {
      const steps = [1, 2, 3, 4, 5, 6].map((n) => [String(n), ui(`guide.step${n}`), ui(`guide.step${n}Body`)])
      return h('div', null,
        h('div', { className: 'at-card' },
          h('div', { className: 'at-sec-h' }, ui('whatIs')),
          h('div', { className: 'at-tiny at-muted', style: { lineHeight: 1.7 } },
            ui('guideIntro')),
          h('div', { style: { marginTop: '14px' } },
            steps.map(([n, title, body]: any) => h('div', {
              key: n,
              style: { display: 'flex', gap: '12px', padding: '11px 0', borderTop: '1px dashed var(--dsw-alias-border-l1)' },
            },
              h('div', {
                style: {
                  width: 22, height: 22, borderRadius: '50%', flex: 'none', display: 'grid',
                  placeItems: 'center', fontSize: 11, fontWeight: 700,
                  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
                },
              }, n),
              h('div', null,
                h('div', { style: { fontWeight: 600 } }, title),
                h('div', { className: 'at-tiny at-muted' }, body)))))),
        h('div', { className: 'at-card' },
          h('div', { className: 'at-sec-h' }, ui('guide.backend')),
          h('div', { className: 'at-tiny at-muted', style: { lineHeight: 1.7 } },
            ui('guide.backend1'),
            h('span', { className: 'at-mono' }, 'storages/schedule.json'),
            ui('guide.backend2'),
            h('span', { className: 'at-mono' }, props.inboxDir || '$DSH_HOME/auto-tasks/inbox'),
            ui('guide.backend3'))))
    }

    function CreateForm(props: ViewProps) {
      const editing = props.editing
      const [name, setName] = useState(editing ? editing.name : '')
      const [instruction, setInstruction] = useState(editing ? editing.instruction : '')
      const [type, setType] = useState(editing && editing.trigger ? editing.trigger.type : 'cron')
      const [expr, setExpr] = useState(editing && editing.trigger ? (editing.trigger.expr || '0 9 * * *') : '0 9 * * *')
      const [every, setEvery] = useState(editing && editing.trigger ? String(editing.trigger.everySeconds || 3600) : '3600')
      const [dailyTime, setDailyTime] = useState(editing && editing.trigger ? (editing.trigger.dailyTime || '09:00:00') : '09:00:00')
      const [tz, setTz] = useState(editing && editing.trigger ? (editing.trigger.timeZone || localTz()) : localTz())
      const [eventTypes, setEventTypes] = useState(
        editing && editing.trigger && Array.isArray(editing.trigger.eventTypes) ? editing.trigger.eventTypes.join(', ') : '')
      const [channels, setChannels] = useState(
        editing && editing.delivery && editing.delivery.channels ? editing.delivery.channels : [])
      const [approval, setApproval] = useState(editing && editing.approval ? editing.approval : 'auto')
      const [wakeBackend, setWakeBackend] = useState(
        editing && editing.wakeBackend === 'proactive' ? 'proactive' : 'schedule')
      const [deliverOn, setDeliverOn] = useState(
        editing && editing.feedback && Array.isArray(editing.feedback.deliverOn)
          ? editing.feedback.deliverOn : ['done', 'failed', 'needsDecision'])
      const [quietOn, setQuietOn] = useState(!!(editing && editing.feedback && editing.feedback.quietHours))
      const [quietStart, setQuietStart] = useState(
        editing && editing.feedback && editing.feedback.quietHours ? editing.feedback.quietHours.start : '23:00')
      const [quietEnd, setQuietEnd] = useState(
        editing && editing.feedback && editing.feedback.quietHours ? editing.feedback.quietHours.end : '08:00')
      const [requireEvidence, setRequireEvidence] = useState(
        !!(editing && editing.guard && editing.guard.requireEvidence))
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)

      function localTz() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
      }

      function toggleChannel(bot: any, target: any) {
        const exists = channels.some((c: any) => c.botId === bot.botId && c.targetId === target.targetId)
        if (exists) {
          setChannels(channels.filter((c: any) => !(c.botId === bot.botId && c.targetId === target.targetId)))
        } else {
          setChannels(channels.concat([{ botId: bot.botId, targetId: target.targetId, format: 'markdown' }]))
        }
      }

      function toggleDeliverOn(status: any) {
        setDeliverOn((prev: any) => prev.includes(status) ? prev.filter((s: any) => s !== status) : prev.concat([status]))
      }

      async function submit() {
        setErr('')
        if (!name.trim()) return setErr(ui('form.nameRequired'))
        if (!instruction.trim()) return setErr(ui('form.instructionRequired'))
        if (quietOn && (!/^\d{1,2}:\d{2}$/.test(quietStart) || !/^\d{1,2}:\d{2}$/.test(quietEnd))) {
          return setErr(ui('form.quietFormat'))
        }
        const eventList = String(eventTypes || '').split(/[\s,，]+/).map((s: string) => s.trim()).filter(Boolean)
        if (type === 'event' && eventList.length === 0) return setErr(ui('form.eventTypesRequired'))
        setBusy(true)
        try {
          const trigger = type === 'event'
            ? { type: 'event', eventTypes: eventList }
            : type === 'cron'
            ? { type, expr, timeZone: tz }
            : type === 'every'
              ? { type, everySeconds: Number(every), timeZone: tz }
              : { type: 'daily', dailyTime, timeZone: tz }
          const payload: any = {
            name,
            instruction,
            trigger,
            approval,
            wakeBackend,
            delivery: { channels },
            feedback: {
              deliverOn: deliverOn.length ? deliverOn : ['done', 'failed', 'needsDecision'],
              respectQuietHours: quietOn,
              quietHours: quietOn ? { start: quietStart, end: quietEnd, timeZone: tz } : null,
            },
            guard: { requireEvidence },
            sessionId: props.sessionId,
          }
          if (props.workspacePath) payload.workspacePath = props.workspacePath
          if (editing) {
            await api('/tasks/update', { method: 'POST', body: { ...payload, id: editing.id } })
          } else {
            await api('/tasks', { method: 'POST', body: payload })
          }
          props.onDone?.()
        } catch (e: any) {
          setErr(String(e && e.message || e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'at-card' },
        h('div', { className: 'at-sec-h' }, editing ? ui('editTask') : ui('newTaskTitle')),
        h('div', { className: 'at-field' },
          h('label', null, ui('name')),
          h('input', { value: name, onChange: (e: ChangeEvt) => setName(e.target.value), placeholder: ui('form.namePlaceholder') })),
        h('div', { className: 'at-field' },
          h('label', null, ui('form.instruction')),
          h('textarea', {
            value: instruction,
            onChange: (e: ChangeEvt) => setInstruction(e.target.value),
            placeholder: ui('form.instructionPlaceholder'),
          })),
        h('div', { className: 'at-field' },
          h('label', null, ui('trigger')),
          h('div', { className: 'at-inline' },
            h('select', { value: type, onChange: (e: ChangeEvt) => setType(e.target.value) },
              h('option', { value: 'cron' }, ui('form.cron')),
              h('option', { value: 'every' }, ui('form.fixedCycle')),
              h('option', { value: 'daily' }, ui('form.dailyTime')),
              h('option', { value: 'event' }, ui('form.eventTrigger'))))),
        type === 'event'
          ? h('div', { className: 'at-field' },
              h('label', null, ui('form.eventTypes')),
              h('input', {
                value: eventTypes,
                onChange: (e: ChangeEvt) => setEventTypes(e.target.value),
                placeholder: 'approval.requested, record.*',
              }))
          :
        type === 'cron'
          ? h('div', { className: 'at-row2' },
              h('div', { className: 'at-field' },
                h('label', null, ui('form.cron')), h('input', { value: expr, onChange: (e: ChangeEvt) => setExpr(e.target.value) })),
              h('div', { className: 'at-field' },
                h('label', null, ui('timeZone')), h('input', { value: tz, onChange: (e: ChangeEvt) => setTz(e.target.value) })))
          : type === 'every'
            ? h('div', { className: 'at-field' },
                h('label', null, ui('form.intervalSeconds')),
                h('input', { value: every, onChange: (e: ChangeEvt) => setEvery(e.target.value) }))
            : h('div', { className: 'at-row2' },
                h('div', { className: 'at-field' },
                  h('label', null, ui('form.timeHms')), h('input', { value: dailyTime, onChange: (e: ChangeEvt) => setDailyTime(e.target.value) })),
                h('div', { className: 'at-field' },
                  h('label', null, ui('timeZone')), h('input', { value: tz, onChange: (e: ChangeEvt) => setTz(e.target.value) }))),

        (name.includes('邮件监控') || name.includes(ui('form.mailMonitor')))
          ? h('div', { className: 'at-note' },
              ui('form.mailMonitorNote'))
          : null,

        h('div', { className: 'at-field' },
          h('label', null, ui('deliverOn')),
          h('div', { className: 'at-inline' },
            [['done', ui('form.success')], ['failed', ui('form.failed')], ['needsDecision', ui('form.needsDecision')]].map(([s, label]: any) =>
              h('label', { key: s, className: 'at-inline', style: { fontSize: '12px', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: deliverOn.includes(s), onChange: () => toggleDeliverOn(s) }),
                h('span', null, label))))),

        h('div', { className: 'at-field' },
          h('label', null, ui('form.quietHours')),
          h('div', { className: 'at-inline' },
            h('input', { type: 'checkbox', checked: quietOn, onChange: (e: ChangeEvt) => setQuietOn(e.target.checked) }),
            h('span', { className: 'at-tiny' }, ui('form.on')),
            h('input', { value: quietStart, onChange: (e: ChangeEvt) => setQuietStart(e.target.value), placeholder: '23:00', style: { width: '84px' } }),
            h('span', { className: 'at-tiny' }, '→'),
            h('input', { value: quietEnd, onChange: (e: ChangeEvt) => setQuietEnd(e.target.value), placeholder: '08:00', style: { width: '84px' } }),
            h('span', { className: 'at-tiny at-muted' }, tz))),

        h('div', { className: 'at-field' },
          h('label', null, ui('guard')),
          h('div', { className: 'at-inline' },
            h('select', { value: approval, onChange: (e: ChangeEvt) => setApproval(e.target.value) },
              h('option', { value: 'auto' }, ui('form.runDirectly')),
              h('option', { value: 'require' }, ui('form.planFirst'))),
            h('label', { className: 'at-inline', style: { fontSize: '12px', cursor: 'pointer', marginLeft: '6px' } },
              h('input', { type: 'checkbox', checked: requireEvidence, onChange: (e: ChangeEvt) => setRequireEvidence(e.target.checked) }),
              h('span', null, ui('form.requireEvidenceNote'))))),

        h('div', { className: 'at-field' },
          h('label', null, ui('wakeBackend')),
          h('div', { className: 'at-inline' },
            h('select', { value: wakeBackend, onChange: (e: ChangeEvt) => setWakeBackend(e.target.value) },
              h('option', { value: 'schedule' }, ui('form.backendSchedule')),
              h('option', { value: 'proactive' }, ui('form.backendProactive'))))),
        wakeBackend === 'proactive'
          ? h('div', { className: 'at-note' },
              ui('form.backendProactiveNote'))
          : null,

        h('div', { className: 'at-field' },
          h('label', null, ui('deliveryTo')),
          (props.channels || []).length === 0
            ? h('div', { className: 'at-note' }, ui('form.noChannels'))
            : (props.channels || []).map((b: any) => h('div', { key: b.botId },
                h('div', { className: 'at-tiny at-muted', style: { marginBottom: '4px' } }, `${channelName(b.channel)} · ${b.botId}`),
                (b.targets || []).map((t: any) => {
                  const on = channels.some((c: any) => c.botId === b.botId && c.targetId === t.targetId)
                  return h('label', {
                    key: t.targetId,
                    className: 'at-inline',
                    style: { fontSize: '12px', marginRight: '12px', cursor: 'pointer' },
                  },
                    h('input', { type: 'checkbox', checked: on, onChange: () => toggleChannel(b, t) }),
                    h('span', null, `${t.name || t.targetId}`),
                    h('span', { className: 'at-chip mono' }, t.targetId))
                })))),
        err ? h('div', { className: 'at-err' }, err) : null,
        h('div', { className: 'at-inline', style: { marginTop: '6px' } },
          h('button', { className: 'at-btn primary', disabled: busy, onClick: submit },
            busy ? ui('saving') : (editing ? ui('save') : ui('createTask'))),
          h('button', { className: 'at-btn ghost', onClick: props.onCancel }, ui('cancel'))))
    }

    /* ------------------------------------------------------------------ root */

    function AutoTasksView(props: ViewProps) {
      useLocaleRevision()
      const ctx = props.ctx
      const sessionId = props.sessionId || (props.session && props.session.id) || ''
      const workspacePath = props.workspacePath || (props.workspace && (props.workspace.path || props.workspace.root)) || ''
      const [pane, setPane] = useState('overview')
      const [tasks, setTasks] = useState([])
      const [reports, setReports] = useState([])
      const [unread, setUnread] = useState(0)
      const [channels, setChannels] = useState([])
      const [health, setHealth] = useState(null)
      const [inbox, setInbox] = useState([])
      const [inboxDir, setInboxDir] = useState('')
      const [config, setConfig] = useState(null)
      const [editing, setEditing] = useState(null)
      const [creating, setCreating] = useState(false)
      const [error, setError] = useState('')

      const refresh = useCallback(async () => {
        try {
          setError('')
          const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
          const [t, r, c, hl, ib, cf] = await Promise.all([
            api('/tasks' + q),
            api('/reports?limit=120'),
            api('/channels').catch(() => ({ bots: [] })),
            api('/health').catch(() => null),
            api('/inbox').catch(() => ({ items: [] })),
            api('/config').catch(() => null),
          ]) as any[]
          setTasks(t.tasks || [])
          setReports(r.reports || [])
          setUnread(r.unread || 0)
          if (props.onUnread) props.onUnread(r.unread || 0)
          setChannels(c.bots || [])
          setHealth(hl)
          setInbox(ib.items || [])
          setInboxDir(ib.dir || '')
          setConfig(cf && cf.config ? cf.config : null)
        } catch (e: any) {
          setError(String(e && e.message || e))
        }
      }, [sessionId, props.onUnread])

      useEffect(() => { refresh() }, [refresh])

      async function action(fn: any) {
        try { await fn(); await refresh() } catch (e: any) { setError(String(e && e.message || e)) }
      }

      async function adopt(item: any) {
        await action(() => api('/inbox/adopt', { method: 'POST', body: { file: item.fileName, sessionId } }))
        setPane('tasks')
      }

      return h('div', { className: 'at-root' },
        h(SubTabs, {
          pane,
          taskCount: tasks.length,
          inboxCount: inbox.length,
          unread,
          onPane: (p: any) => { setPane(p); setCreating(false); setEditing(null) },
          onRefresh: refresh,
          onCreate: () => { setPane('tasks'); setEditing(null); setCreating(true) },
        }),
        error ? h('div', { className: 'at-err' }, error) : null,

        (creating || editing) && (pane === 'tasks')
          ? h(CreateForm, {
              ctx,
              sessionId,
              workspacePath,
              editing,
              channels,
              onCancel: () => { setCreating(false); setEditing(null) },
              onDone: () => { setCreating(false); setEditing(null); refresh() },
            })
          : null,

        pane === 'overview'
          ? h(Overview, { tasks, reports, unread, health, config })
          : pane === 'tasks'
            ? (creating || editing ? null : h(Tasks, {
                tasks,
                onRun: (t: any) => action(() => api('/tasks/run', { method: 'POST', body: { id: t.id } })),
                onToggle: (t: any) => action(() => api('/tasks/toggle', { method: 'POST', body: { id: t.id, enabled: !t.enabled } })),
                onDelete: (t: any) => {
                  if (!window.confirm(ui('task.confirmDelete', { name: t.name }))) return
                  action(() => api('/tasks/delete', { method: 'POST', body: { id: t.id } }))
                },
                onEdit: (t: any) => setEditing(t),
              }))
            : pane === 'inbox'
              ? h(Inbox, { items: inbox, dir: inboxDir, onAdopt: adopt })
              : pane === 'reports'
                ? h(Reports, {
                    reports,
                    unread,
                    onReadAll: () => action(async () => {
                      await api('/reports/read', { method: 'POST', body: { ids: reports.filter((r: any) => r.read === false).map((r: any) => r.id) } })
                    }),
                    onRead: (r: any) => action(() => api('/reports/read', { method: 'POST', body: { ids: [r.id] } })),
                    onApprove: (r: any) => action(() => api('/reports/approve', { method: 'POST', body: { id: r.id } })),
                  })
                : pane === 'channels'
                  ? h(Channels, { ctx, channels, health })
                  : h(Guide, { inboxDir }),
      )
    }

    /* ----------------------------------------------------------------- apply */

    let unreadCount = 0
    let disposeTab: any = null
    let disposeTimer: any = null

    function apply(ctx: any) {
      injectCss()

      // 词典：只注册 zh / en（ja 由 @care/dsh-lang-ja 注册到同一 namespace）。
      try {
        const locale = ctx.locale
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh: DICTS.zh, en: DICTS.en }), 'auto-tasks: dictionaries')
          localeFace = locale
          translate = locale.bind(NS)
        }
      } catch (error) {
        console.error('[dsh-auto-tasks] locale register failed (falling back to built-in zh/en)', error)
      }

      const registerTab = () => {
        if (disposeTab) disposeTab()
        disposeTab = ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'auto-tasks',
            order: 130,
            label: () => (unreadCount > 0 ? ui('tab.unread', { tab: ui('tab'), n: unreadCount }) : ui('tab')),
          }, (props: ViewProps) => h(AutoTasksView, {
            ...props,
            ctx,
            onUnread: (n: any) => {
              if (n === unreadCount) return
              unreadCount = n
              registerTab()
            },
          })))
      }

      registerTab()

      ctx.effect(() => {
        const tick = async () => {
          try {
            const r = await fetch(apiUrl('/reports?limit=1')).then((x: any) => x.json())
            const n = r && r.unread ? r.unread : 0
            if (n !== unreadCount) { unreadCount = n; registerTab() }
          } catch { /* backend not ready yet */ }
        }
        disposeTimer = setInterval(tick, 30000)
        return () => {
          if (disposeTimer) clearInterval(disposeTimer)
          if (disposeTab) disposeTab()
        }
      }, 'auto-tasks: tab + badge polling')
    }

    module.exports = { inject: ['slots', 'locale'], apply }
    return module.exports
  },
})







