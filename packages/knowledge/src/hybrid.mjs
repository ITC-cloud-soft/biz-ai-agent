// Optional semantic retrieval next to BM25F: an embedder of YOUR choice, fused with reciprocal rank fusion (RRF).
//
// No model is chosen here (that is the system owner's decision: Azure OpenAI, a local model, or none). Without an embedder the
// search is BM25F only, as before. An embedder is any object
//
//   { id: string, embed(texts: string[]) -> Promise<number[][]> }
//
// httpEmbedder() is one for OpenAI-compatible /embeddings endpoints (OpenAI, Azure OpenAI deployments, vLLM / Ollama / TEI
// with an OpenAI-compatible API). The chunks it embeds have ALREADY passed the personal-data screen; the endpoint still
// receives the document text, so choose one whose data rules fit the documents (see docs/STATUS.md).
//
// Permissions stay first: the vector side ranks only the asker's visible chunks (cosine is per pair, RRF ranks are taken within
// the visible list), so a hidden chunk changes neither the order nor the scores.

export const RRF_K = 60
export const DEFAULT_MIN_SIMILARITY = 0.8
export const EMBED_BATCH = 16

/** Cosine similarity (null when a vector is missing or has another length). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : null
}

/** Reciprocal rank fusion of ranked id lists: score(id) = Σ 1 / (k + rank). Returns [{ id, score }] best first. */
export function rrf(lists, k = RRF_K) {
  const scores = new Map()
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)))
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

/** The text a chunk is embedded with (title, heading, keywords, body). */
export const embeddingTextOf = (c) => [c.heading ? `${c.title} › ${c.heading}` : c.title, c.keywords?.length ? c.keywords.join(', ') : '', c.text].filter(Boolean).join('\n')

function checkVectors(vectors, n, who) {
  if (!Array.isArray(vectors) || vectors.length !== n) throw new Error(`${who}: expected ${n} vector(s)`)
  const dim = vectors[0]?.length
  for (const v of vectors) {
    if (!(Array.isArray(v) || ArrayBuffer.isView(v)) || v.length !== dim || !dim) throw new Error(`${who}: vectors must be non-empty and of one length`)
  }
  return vectors.map((v) => Float32Array.from(v))
}

/**
 * The vectors of an index's chunks (Map chunkId -> Float32Array). `cache` (a Map keyed by embedder id + text) avoids
 * embedding unchanged chunks again after a rebuild.
 */
export async function embedChunks(chunks, embedder, { cache = null, batch = EMBED_BATCH } = {}) {
  if (typeof embedder?.embed !== 'function') throw new TypeError('embedChunks: an embedder { id, embed(texts) } is required')
  const out = new Map()
  const todo = []
  for (const c of chunks) {
    const text = embeddingTextOf(c)
    const key = `${embedder.id ?? 'embedder'}\u0000${text}`
    const hit = cache?.get(key)
    if (hit) out.set(c.id, hit)
    else todo.push({ id: c.id, text, key })
  }
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch)
    const vectors = checkVectors(await embedder.embed(part.map((x) => x.text)), part.length, `embedder ${embedder.id ?? ''}`.trim())
    part.forEach((x, j) => {
      out.set(x.id, vectors[j])
      cache?.set(x.key, vectors[j])
    })
  }
  return out
}

/** The vector of a question (Float32Array). */
export async function embedQuery(embedder, question) {
  const [v] = checkVectors(await embedder.embed([String(question ?? '')]), 1, `embedder ${embedder.id ?? ''}`.trim())
  return v
}

/**
 * An embedder for an OpenAI-compatible POST /embeddings endpoint ({ input, model } → { data: [{ embedding, index }] }).
 *   httpEmbedder({ url, model?, headers?, dimensions?, fetch?, timeoutMs? })
 * Azure OpenAI: url = https://<resource>.openai.azure.com/openai/deployments/<deployment>/embeddings?api-version=<v>,
 * headers = { 'api-key': <key from the environment> }. Keys come from the environment / secret store, never from git.
 */
export function httpEmbedder({ url, model = undefined, headers = {}, dimensions = undefined, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000, id = null } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TypeError('httpEmbedder: url (http/https) is required')
  return {
    id: id ?? `http:${model ?? new URL(url).pathname}`,
    async embed(texts) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ input: texts, ...(model ? { model } : {}), ...(dimensions ? { dimensions } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`embeddings endpoint answered ${res.status}`) // never the body: it may echo the input
      const body = await res.json()
      const data = Array.isArray(body?.data) ? [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : null
      if (!data || data.length !== texts.length) throw new Error('embeddings endpoint: unexpected answer')
      return data.map((d) => d.embedding)
    },
  }
}
