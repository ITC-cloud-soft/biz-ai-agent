/**
 * dsh-auto-tasks — 后端适配层（TypeScript 源，构建到 lib/backends.js）。
 *
 * 集中隔离三类非本插件自有契约：
 *   1. 核心 schedule 服务（ctx.schedule）——公共宿主服务，直接使用；
 *   2. dsh-proactive——@care/dsh-proactive 提供进程内服务 `ctx.dshProactive`（优先）；
 *      上游版本没有 ctx 服务时回退到本机面板 action API（DSH_WEB_BASE / DSH_WEB_PORT）；
 *   3. dsh-im——可选服务，鸭子类型探测。
 */

                              
                 
                        
 

                            
                    
                                                                                                         
                                
                                                
 

                                 
            
                   
                
                   
                    
                
 

                                   
                   
                                              
                                                        
                                                                                        
                                                              
 

export function dshWebBase()         {
  return process.env.DSH_WEB_BASE || `http://127.0.0.1:${process.env.DSH_WEB_PORT || 3080}`
}

                                   

export function imBackend(ctx       )            {
  const svc                    = ctx.get('dshIm')
  return {
    available: typeof svc?.send === 'function',
    async send(botId, targetId, text, options) {
      if (typeof svc?.send !== 'function') throw new Error('dsh-im not installed')
      return svc.send(botId, targetId, text, options)
    },
    async listBots() {
      if (typeof svc?.listBots !== 'function') return []
      return svc.listBots()
    },
    async listTargets(botId) {
      if (typeof svc?.listTargets !== 'function') return []
      return svc.listTargets(botId)
    },
  }
}

/** @care/dsh-proactive 的进程内服务（`ctx.dshProactive`）。 */
                            
                                           
                                                                                                                                                      
 

function proactiveService(ctx       )                               {
  let svc                   
  try { svc = typeof ctx?.get === 'function' ? ctx.get('dshProactive') : undefined } catch { svc = undefined }
  return svc && typeof svc.state === 'function' && typeof svc.action === 'function' ? svc                     : undefined
}

export function proactiveBackend(ctx       )                   {
  let cacheAt = 0
  let cacheOk = false

  const call = async (sessionId                    , action                         ) => {
    const svc = proactiveService(ctx)
    if (svc) {
      const result = await svc.action(action, sessionId)
      if (!result?.ok) throw new Error(result?.error?.message || result?.error?.code || 'proactive action failed')
      return result.snapshot ?? null
    }
    const url = `${dshWebBase()}/api/dsh-proactive/action${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    let body               = null
    try { body = await res.json() } catch { body = null }
    if (!res.ok) throw new Error(body?.message || `proactive HTTP ${res.status}`)
    return body
  }

  return {
    name: 'proactive',
    async available(force = false) {
      if (proactiveService(ctx)) return true
      if (!force && Date.now() - cacheAt < 30_000) return cacheOk
      try {
        const res = await fetch(`${dshWebBase()}/api/dsh-proactive/state`, { signal: AbortSignal.timeout(2500) })
        cacheOk = res.ok
      } catch {
        cacheOk = false
      }
      cacheAt = Date.now()
      return cacheOk
    },
    async state() {
      const svc = proactiveService(ctx)
      if (svc) return svc.state()
      const res = await fetch(`${dshWebBase()}/api/dsh-proactive/state`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      return res.json()
    },
    async createAlarm(sessionId, args) {
      const snap = await call(sessionId, { kind: 'create', sessionId, args })
      const rows                   = (snap?.alarms ?? [])
        .filter((a                ) => a.sessionId === sessionId && a.prompt === args.prompt)
        .sort((a                , b                ) => String(b.createdAt).localeCompare(String(a.createdAt)))
      if (!rows[0]) throw new Error('proactive 已创建但快照中找不到对应闹钟')
      return rows[0]
    },
    async cancelAlarm(sessionId, id) {
      await call(sessionId, { kind: 'cancel', id })
      return true
    },
  }
}
