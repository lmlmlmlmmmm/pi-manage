// 定向验证：用 vue 内置 compiler-sfc 编译单个 .vue 文件，
// 检查 <script setup> 能否正确编译、defineProps/defineEmits 宏是否被替换。
// 用法：node scripts/check-sfc.mjs <file.vue> [more.vue...]
import { readFileSync } from 'node:fs'
import { parse, compileScript } from 'vue/compiler-sfc'

let failed = false
for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf-8')
  const { descriptor, errors } = parse(source, { filename: file })
  if (errors.length) {
    console.error(`✗ ${file} 解析失败:`)
    for (const e of errors) console.error(`  ${e.message}`)
    failed = true
    continue
  }
  try {
    const out = compileScript(descriptor, { id: 'check' })
    // 宏调用残留意味着编译器没能识别（如 defineProps()() 这类非法形式）
    const macroLeft =
      /(^|[^.\w])defineProps\s*[(<]/.test(out.content) || /(^|[^.\w])defineEmits\s*[(<]/.test(out.content)
    if (macroLeft) {
      console.error(`✗ ${file} 宏未被替换（存在非法宏调用形式）`)
      failed = true
    } else {
      console.log(`✓ ${file} 编译通过，宏已替换`)
    }
  } catch (e) {
    console.error(`✗ ${file} 编译失败: ${e.message}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
