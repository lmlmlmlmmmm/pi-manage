import { execSync } from 'node:child_process'
import type { PiApi, PiProvider } from '../src/types.js'
import { apiKeyHeaders, isAuthHeader, mergeHeaders } from '../src/lib/modelAuth.js'

// 与 pi 相同：$VAR / ${VAR} 插值，$$ / $! 转义；命令必须返回完整的配置值。
function resolveConfigValue(value: string, label: string): string {
  if (value.startsWith('!')) {
    try {
      const result = execSync(value.slice(1), { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!result) throw new Error('命令输出为空')
      return result
    } catch {
      throw new Error(`${label} 的取值命令失败或未返回内容`)
    }
  }
  return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
    if (match === '$$') return '$'
    if (match === '$!') return '!'
    const name = braced ?? plain!
    const resolved = process.env[name]
    if (resolved === undefined) throw new Error(`${label} 引用的环境变量未定义：${name}`)
    return resolved
  })
}

// 获取模型与连接测试共用认证解析；显式模型认证失败必须报错，不能退回另一分组的 Provider 密钥。
export function resolveRequestHeaders(api: PiApi, provider: Pick<PiProvider, 'apiKey' | 'authHeader' | 'headers'>, modelHeaders?: Record<string, string>): Record<string, string> {
  const raw = mergeHeaders(provider.headers, modelHeaders)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error(`Header「${name}」的值必须是字符串`)
    const resolved = resolveConfigValue(value, `Header「${name}」`)
    if (/[\r\n]/.test(resolved)) throw new Error(`Header「${name}」不能包含换行`)
    if (isAuthHeader(name) && (!resolved.trim() || /^Bearer\s*$/i.test(resolved))) {
      throw new Error(`认证 Header「${name}」不能为空`)
    }
    headers[name] = resolved
  }
  if (!Object.keys(headers).some(isAuthHeader) && provider.apiKey) {
    const key = resolveConfigValue(provider.apiKey, 'Provider API Key')
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error('Provider API Key 为空或包含换行')
    Object.assign(headers, apiKeyHeaders(api, key, provider.authHeader))
  }
  return headers
}
