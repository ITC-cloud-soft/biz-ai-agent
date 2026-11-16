// The only I/O of the package: reading a manual folder you name (for the index script and CI).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isChapterFile, parseExclusions, parseSynonyms } from './manual.mjs'

/**
 * A manual folder → { files: { 'NN-x.md': text }, synonyms, exclusions }.
 * Optional files next to the chapters: `_synonyms.yml` (one group a line, `- [word, …]`) and `_exclude.txt` (routes without a section).
 */
export function readManualDir(dir) {
  const files = {}
  for (const name of readdirSync(dir).filter(isChapterFile).sort()) files[name] = readFileSync(join(dir, name), 'utf8')
  const optional = (name) => { try { return readFileSync(join(dir, name), 'utf8') } catch { return '' } }
  return { files, synonyms: parseSynonyms(optional('_synonyms.yml')), exclusions: parseExclusions(optional('_exclude.txt')) }
}
