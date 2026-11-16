// @dsh-bridge/help — answer how-to questions on SNS from the business system's own manual (see README.md).
export { DEFAULT_LABELS, UNCONFIRMED_RE, plainText, parseChapter, parseManual, isChapterFile, parseSynonyms, parseExclusions } from './manual.mjs'
export { routePattern, routeOf, listPath } from './routes.mjs'
export { INDEX_VERSION, buildHelpIndex, serializeIndex, setManifestWebRoutes, DEFAULT_WEB_BLOCK_HEADER } from './build.mjs'
export { checkAnchors, checkSectionPaths, checkCoverage, checkRoleText, checkMenuLabels, checkLinks, checkLinksAreRoutes } from './check.mjs'
export {
  QUERY_MAX_CHARS, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_MIN_SCORE, REFERENCE_SECTIONS, DEFAULT_MIN_COVERAGE, DEFAULT_MANUAL_PAGE, DEFAULT_FILLERS,
  normalize, terms, expandQuery, createSearcher, canUse, defaultAltText, answerOf, searchManual,
} from './search.mjs'
export { readManualDir } from './files.mjs'
export { createHelpService } from './service.mjs'
