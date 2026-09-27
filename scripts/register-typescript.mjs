// 定向测试直接加载项目 TypeScript，使用已有编译器，不生成全项目构建产物。
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 后端采用 NodeNext 的 .js 导入，源码测试时定位对应的 .ts 文件。
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !context.parentURL) throw error
      const candidate = new URL(specifier.replace(/\.js$/, '') + '.ts', context.parentURL)
      if (!existsSync(fileURLToPath(candidate))) throw error
      return nextResolve(candidate.href, context)
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf-8')
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    }
  },
})
