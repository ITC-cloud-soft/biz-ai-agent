/**
 * 插件配置 schema（TypeScript 源，构建到 lib/config-schema.js）。
 *
 * 显式契约：加载时补默认值、未知字段告警；通过 /api/config/schema 暴露。
 */

                                                  

                              
                                 
                                                                  
                                                          
                           
                                                                                
               
 

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

const DEFAULTS              = Object.freeze({
  wakeBackendDefault: 'schedule',
  api: Object.freeze({ requireClientHeader: true, allowNonLoopback: false }),
  restrictDelivery: false,
  mail: true,
})               

export function normalizeConfig(raw         )                                              {
  const warnings           = []
  const input                      = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw                       
    : {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(CONFIG_SCHEMA.properties, key)) warnings.push(`unknown config key: ${key}`)
  }
  const wakeBackendDefault              = input.wakeBackendDefault === 'proactive'
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
