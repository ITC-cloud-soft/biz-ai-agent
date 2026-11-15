// @dsh-bridge/knowledge — permission-aware knowledge search for a Bridge v1 business system (see README.md).
export { KnowledgeBuildError, canSee, documentVisibility, sectionVisibility } from './visibility.mjs'
export { parseFrontMatter, parseAttributes, splitSections, parseKnowledgeMarkdown, readKnowledgeDir } from './markdown.mjs'
export { KNOWLEDGE_INDEX_VERSION, DEFAULT_MAX_CHUNK_CHARS, buildKnowledgeIndex, chunkText, localKinds } from './build.mjs'
export {
  QUERY_MAX_CHARS, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_MIN_COVERAGE, DEFAULT_MIN_SCORE, DEFAULT_PER_DOCUMENT, SNIPPET_MAX_CHARS, STOP_WORDS, KNOWLEDGE_FILLERS, ZH_FILLERS, contentRuns,
  wordTerms, numberTerms, scriptBigrams, termsOf, queryTerms, createKnowledgeSearcher, candidatesFor, resultsOf, searchKnowledge, snippet, sourceOf,
} from './search.mjs'
export { RERANK_POOL, createKnowledgeService } from './service.mjs'
export { RRF_K, DEFAULT_MIN_SIMILARITY, EMBED_BATCH, cosine, rrf, embeddingTextOf, embedChunks, embedQuery, httpEmbedder } from './hybrid.mjs'
export { PROSE_KINDS, bridgePiiScreen } from './pii.mjs'
export { checkSuite, runKnowledgeEvals, formatEvalReport } from './evals.mjs'
export { KNOWLEDGE_SEARCH_PATH, KNOWLEDGE_ENDPOINT, KNOWLEDGE_QUERY_MAX, registerKnowledge } from './routes.mjs'
