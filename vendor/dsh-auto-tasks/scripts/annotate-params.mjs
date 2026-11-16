/**
 * 一次性 codemod：给未标注类型的参数补 `: any`（边界显式 any），
 * 用于把 noImplicitAny 债务转成「显式 any」并暴露剩余结构性问题。
 * 仅用于迁移期，不参与构建。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const ts = createRequire(import.meta.url)('typescript')
const files = ['src/index.ts', 'src/mail.ts', 'src/client.ts']

for (const file of files) {
  const code = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const inserts = []
  const visit = (node) => {
    if (ts.isParameter(node) && !node.type) {
      let pos = node.name.getEnd()
      if (node.questionToken) pos = node.questionToken.getEnd()
      inserts.push(pos)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  let out = code
  for (const pos of [...new Set(inserts)].sort((a, b) => b - a)) {
    out = out.slice(0, pos) + ': any' + out.slice(pos)
  }
  writeFileSync(file, out, 'utf8')
  console.log(`${file}: annotated ${inserts.length} params`)
}
