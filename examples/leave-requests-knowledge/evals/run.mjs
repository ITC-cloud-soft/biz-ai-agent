// npm run evals — the retrieval evals of the pilot, printed as Markdown (the numbers in docs/STATUS.md come from here).
//   node evals/run.mjs [--json]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildKnowledgeIndex, createKnowledgeService, formatEvalReport, readKnowledgeDir, runKnowledgeEvals } from '@dsh-bridge/knowledge'
import { loadManifest } from '@dsh-bridge/server-kit'
import { KNOWLEDGE_DIR, MANIFEST_FILE } from '../src/app.mjs'

export const SUITE_FILE = fileURLToPath(new URL('./knowledge.evals.json', import.meta.url))

/** The pilot's documents indexed as the app indexes them (manifest roles and web.routes), and the suite. */
export async function evalSetup(options = {}) {
  const { manifest } = loadManifest({ file: MANIFEST_FILE })
  const index = await buildKnowledgeIndex(await readKnowledgeDir(KNOWLEDGE_DIR), { roles: Object.keys(manifest.roles), routes: manifest.web.routes })
  return { service: createKnowledgeService(index, options), suite: JSON.parse(readFileSync(SUITE_FILE, 'utf8')) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { service, suite } = await evalSetup()
  const report = await runKnowledgeEvals(service, suite)
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatEvalReport(report))
}
