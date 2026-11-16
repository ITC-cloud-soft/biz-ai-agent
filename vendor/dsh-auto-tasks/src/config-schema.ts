/**
 * 插件配置 schema（TypeScript 源，构建到 lib/config-schema.js）。
 *
 * 显式契约：加载时补默认值、未知字段告警；通过 /api/config/schema 暴露。
 */

export type WakeBackend = 'schedule' | 'proactive'

export interface ConfigShape {
  wakeBackendDefault: WakeBackend
  api: { requireClientHeader: boolean; allowNonLoopback: boolean }
  /** @care #16：只按业务应用解析的收件人投递（不回退到固定投递目标；汇报只接受任务自己的会话） */
  restrictDelivery: boolean
  /** @care #16：邮件模块（auto_task_mail 工具、IMAP 轮询、邮件汇总、/api/mail/*）；false = 全部关闭 */
  mail: boolean
}

export const CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    wakeBackendDefault: { type: 'string', enum: ['schedule', 'proactive'], default: 'schedule' },
    api: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requireClientHeader: { type: 'boolean', default: true },
        // @care：容器部署（DSH 监听非回环地址、前置认证网关）时显式放开回环限制。
        allowNonLoopback: { type: 'boolean', default: false },
      },
    },
    // @care #16（N1b）
    restrictDelivery: { type: 'boolean', default: false },
    mail: { type: 'boolean', default: true },
  },
})

const DEFAULTS: ConfigShape = Object.freeze({
  wakeBackendDefault: 'schedule',
  api: Object.freeze({ requireClientHeader: true, allowNonLoopback: false }),
  restrictDelivery: false,
  mail: true,
}) as ConfigShape

export function normalizeConfig(raw: unknown): { config: ConfigShape; warnings: string[] } {
  const warnings: string[] = []
  const input: Record<string, any> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, any>
    : {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(CONFIG_SCHEMA.properties, key)) warnings.push(`unknown config key: ${key}`)
  }
  const wakeBackendDefault: WakeBackend = input.wakeBackendDefault === 'proactive'
    ? 'proactive'
    : DEFAULTS.wakeBackendDefault
  const api = {
    requireClientHeader: input?.api?.requireClientHeader !== false,
    allowNonLoopback: input?.api?.allowNonLoopback === true,
  }
  const restrictDelivery = input.restrictDelivery === true
  const mail = input.mail !== false
  return { config: { wakeBackendDefault, api, restrictDelivery, mail }, warnings }
}
