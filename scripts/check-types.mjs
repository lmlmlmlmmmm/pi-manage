// 只以显式指定的文件为检查入口，不展开 tsconfig 的 include 或扫描整个 src。
// 用法：node scripts/check-types.mjs <tsconfig.json> <file.ts> [more.ts...]
import { resolve } from 'node:path'
import ts from 'typescript'

const [configPath, ...files] = process.argv.slice(2)
if (!configPath || !files.length || files.some((file) => !/\.[cm]?ts$/.test(file))) {
  console.error('必须指定 tsconfig 和至少一个 TypeScript 文件；Vue 文件使用 check-sfc.mjs。')
  process.exit(1)
}
const config = ts.readConfigFile(resolve(configPath), ts.sys.readFile)
if (config.error) {
  console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  process.exit(1)
}
const parsed = ts.convertCompilerOptionsFromJson(config.config.compilerOptions ?? {}, process.cwd())
const program = ts.createProgram(files.map((file) => resolve(file)), {
  ...parsed.options,
  noEmit: true,
  incremental: false,
})
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }))
  process.exit(1)
}
console.log(`类型检查通过：${files.join(', ')}（及其必要导入）`)
