import type { PiApi, PiProvider } from '../types.js'

export function isAuthHeader(name: string): boolean {
  return ['authorization', 'x-api-key', 'x-goog-api-key'].includes(name.trim().toLowerCase())
}

// 表单只能说明配置来源，不能据此断言 pi 登录状态；模型认证头也不能让 Provider 自动可用。
export function providerAuthNotice(provider: PiProvider | null | undefined, hasModelAuth = false): { type: 'info' | 'warning'; text: string } {
  const key = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : ''
  if (!key) {
    return {
      type: hasModelAuth ? 'warning' : 'info',
      text: `${provider?.oauth ? 'Provider 依赖 pi 的 OAuth 登录。' : 'Provider 未填写 API Key，需由 pi 登录或环境认证提供。'}${hasModelAuth ? '模型独立认证仅覆盖请求，不能单独使模型出现在 /model 中。' : ''}本工具未验证这些外部认证。`,
    }
  }
  return {
    type: 'info',
    text: `${key.startsWith('!') || /\$(?:\{|[A-Za-z_])/.test(key) ? 'Provider Key 使用动态取值，需在启动 pi 的环境中可解析。' : 'Provider Key 已填写。'}pi 已保存的登录凭据优先于此 Key；接口测试通过不代表 /model 可用性已验证。`,
  }
}

// HTTP 头名不区分大小写，模型覆盖不能留下另一种大小写的旧密钥。
export function mergeHeaders(...sources: (Record<string, string> | undefined)[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
      }
      Object.defineProperty(headers, name, { value, writable: true, enumerable: true, configurable: true })
    }
  }
  return headers
}

export function apiKeyHeaders(api: PiApi | undefined, key: string, authHeader = false): Record<string, string> {
  switch (api) {
    case 'openai-completions':
    case 'openai-responses':
      return { Authorization: `Bearer ${key}` }
    case 'anthropic-messages':
      // pi 的 Anthropic 客户端仍会附加 x-api-key；启用 Bearer 时两种头必须使用同一把模型密钥。
      return { 'x-api-key': key, ...(authHeader ? { Authorization: `Bearer ${key}` } : {}) }
    case 'google-generative-ai':
      return { 'x-goog-api-key': key, ...(authHeader ? { Authorization: `Bearer ${key}` } : {}) }
    default:
      throw new Error('请先选择支持的 API 协议，再配置独立 API Key')
  }
}

// 只接管能无损还原为独立 Key 的认证头；!command、非 Bearer 和混合认证仍交给高级 headers 编辑。
export function readModelApiKey(headers: Record<string, string> | undefined, provider: PiProvider): string | undefined {
  const auth = Object.entries(headers ?? {}).filter(([name]) => isAuthHeader(name))
  if (!auth.length || !provider.api) return undefined
  const primary = provider.api === 'anthropic-messages' ? 'x-api-key'
    : provider.api === 'google-generative-ai' ? 'x-goog-api-key' : 'authorization'
  const value = auth.find(([name]) => name.toLowerCase() === primary)?.[1]
  if (typeof value !== 'string') return undefined
  const key = primary === 'authorization' ? /^Bearer (.+)$/i.exec(value)?.[1] : value
  if (!key || key.startsWith('!')) return undefined
  let expected: Record<string, string>
  try {
    expected = apiKeyHeaders(provider.api, key, provider.authHeader)
  } catch {
    return undefined
  }
  const normalized = Object.fromEntries(Object.entries(expected).map(([name, v]) => [name.toLowerCase(), v]))
  return auth.length === Object.keys(expected).length && auth.every(([name, v]) => normalized[name.toLowerCase()] === v)
    ? key : undefined
}

export function modelKeyHeaders(provider: PiProvider, headers: Record<string, string>, key: string): Record<string, string> {
  const value = key.trim()
  if (!value) throw new Error('独立 API Key 不能为空；如需恢复默认密钥，请选择“跟随 Provider”')
  if (value.startsWith('!')) throw new Error('独立 API Key 支持直接填写或 $ENV_VAR；!command 请在自定义 headers 中配置完整认证值')
  if (/[\r\n]/.test(value)) throw new Error('API Key 不能包含换行')
  if (Object.keys(headers).some(isAuthHeader)) throw new Error('下方已有认证 Header，请先移除它，或选择“自定义 Header”')
  const auth = apiKeyHeaders(provider.api, value, provider.authHeader)
  const names = new Set(Object.keys(auth).map((name) => name.toLowerCase()))
  if (Object.keys(provider.headers ?? {}).some((name) => isAuthHeader(name) && !names.has(name.toLowerCase()))) {
    throw new Error('Provider 中存在其他认证 Header，请先处理后再设置模型独立 Key，避免混用密钥')
  }
  return mergeHeaders(headers, auth)
}

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name, isAuthHeader(name) ? '••••••••' : value]))
}
