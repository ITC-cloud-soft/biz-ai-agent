// runtime.js — DSH(Cordis) 上のヘルパー（各プラグインが共通で使う）。

/** schemastery は DSH ホストが持つ。解決できない環境（単体テスト等）では null。 */
export async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    return mod.default ?? mod
  } catch {
    return null
  }
}

/** 設定値を読む。Volatile<T>（.get()）にも素の値にも対応。 */
export function cfg(config, key, fallback) {
  const raw = config?.[key]
  const value = raw && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined || value === null ? fallback : value
}

/** ctx.logger(name) / ctx.logger / console のいずれか。 */
export function makeLogger(ctx, name) {
  let base = console
  try {
    if (typeof ctx?.logger === 'function') base = ctx.logger(name)
    else if (ctx?.logger) base = ctx.logger
  } catch {
    base = console
  }
  const call = (level) => (...args) => {
    const fn = base?.[level] ?? base?.info ?? console.log
    try { fn.apply(base, args) } catch { /* logger must never throw */ }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/**
 * 任意サービスの出現・消滅を追う。Cordis では ctx.inject(names, cb) の子 fiber で、
 * テスト用の素の ctx では即時に cb を呼ぶ。cb の戻り値（関数）は消滅時に呼ばれる。
 */
export function whenServices(ctx, names, callback) {
  if (typeof ctx?.inject === 'function') {
    ctx.inject(names, (sub) => {
      const dispose = callback(sub)
      if (typeof dispose === 'function') {
        if (typeof sub.effect === 'function') sub.effect(() => dispose)
        else if (typeof sub.on === 'function') sub.on('dispose', dispose)
      }
    })
    return
  }
  if (names.every((name) => ctx?.[name] != null)) callback(ctx)
}

/** プラグイン停止時の後始末を登録する。 */
export function onDispose(ctx, fn) {
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => fn)
    return
  }
  if (typeof ctx?.on === 'function') {
    try { ctx.on('dispose', fn) } catch { /* plain mocks */ }
  }
}

/** storage-domain は zod を要求するが parse/safeParse しか使わない。依存を増やさない最小スキーマ。 */
export function objectSchema(check = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)) {
  return {
    parse(value) {
      if (!check(value)) throw new TypeError('invalid record')
      return value
    },
    safeParse(value) {
      return check(value) ? { success: true, data: value } : { success: false, error: new TypeError('invalid record') }
    },
  }
}

/**
 * DSH のストレージサービス（ctx.storageDomain）で domain を開く。
 * @param ctx  storageDomain（または storage.domain）を持つ ctx
 * @param spec { name, version?, tables: string[], global?: initialValue }
 */
export async function openDomain(ctx, { name, version = 1, tables = [], global }) {
  const facility = ctx?.storageDomain ?? ctx?.storage?.domain
  if (!facility || typeof facility.open !== 'function') throw new Error('DSH storage-domain service is not available')
  const spec = { name, version, tables: {} }
  for (const table of tables) spec.tables[table] = { valueSchema: objectSchema() }
  if (global !== undefined) spec.global = { schema: objectSchema(), initial: global }
  return facility.open(spec)
}

/** 指数バックオフ（ジッタ付き）。attempt は 1 始まり。 */
export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp / 2 + random() * (exp / 2))
}

/** 全角数字・全角スペース等を正規化（IME 入力対策）。 */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}
