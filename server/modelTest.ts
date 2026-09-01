// 模型连接测试：按 pi 实际请求语义构造一次完整对话请求（Node 代发，可带 UA 等自定义 headers）。
// 请求构造对齐 pi 源码（pi-ai provider-composer / 各协议 client）：
// - baseUrl 取 model.baseUrl ?? provider.baseUrl，先去尾斜杠再拼端点路径
// - headers 浅合并：provider.headers ← model.headers（模型级覆盖同键）
// - 认证：apiKey 支持 $ENV / ${ENV} 模板与 !command 语法（与 pi 的 resolve-config-value 同语义）；
//   openai/google 用 Bearer / x-goog-api-key，anthropic 用 x-api-key（authHeader 时 Bearer）
// - google 端点为 {base}/v1beta/models/{id}:generateContent（SDK 默认补 v1beta 版本段）

import { execSync } from 'node:child_process'
import type { PiApi, PiModel, PiProvider } from '../src/types.js'
import { outboundFetch } from './proxyFetch.js'

export interface TestModelResult {
  ok: boolean
  /** 请求耗时（毫秒） */
  ms: number
  /** 本次实际发送的测试消息（回显给前端展示） */
  prompt?: string
  /** 成功时的完整模型回复 */
  reply?: string
  /** 失败时的错误信息（HTTP 状态 + 网关错误详情） */
  error?: string
  /** 实际请求的完整 URL（脱敏后展示给用户核对端点） */
  url: string
}

// 连接测试需要看到可读的真实回复；2048 足以覆盖常见代码回答，同时限制意外 quota 消耗。
const TEST_MAX_OUTPUT_TOKENS = 2048
const TEST_TIMEOUT_MS = 60_000

// ---------- $ENV / !command 值解析（对齐 pi resolve-config-value） ----------

// 模板语法：$VAR / ${VAR} 内插环境变量；$$ 与 $! 是字面量转义
function resolveTemplate(config: string): string | undefined {
  const parts = config.split(/(\$\$|\$!|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)/)
  let out = ''
  for (const part of parts) {
    if (!part) continue
    if (part === '$$') out += '$'
    else if (part === '$!') out += '!'
    else if (part.startsWith('${') && part.endsWith('}')) {
      const v = process.env[part.slice(2, -1)]
      if (v === undefined) return undefined
      out += v
    } else if (part.startsWith('$')) {
      const v = process.env[part.slice(1)]
      if (v === undefined) return undefined
      out += v
    } else out += part
  }
  return out
}

// !command 用系统 shell 执行取 stdout（pi 在 win 用配置 shell，这里简化为默认 shell，语义一致）
function resolveConfigValue(value: string): string | undefined {
  if (!value.startsWith('!')) return resolveTemplate(value)
  try {
    const out = execSync(value.slice(1), { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

// ---------- 请求构造 ----------

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.entries(headers).some(([k, v]) => k.toLowerCase() === lower && v && v.trim().length > 0)
}

interface TestRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function buildTestRequest(api: PiApi, provider: PiProvider, model: PiModel, prompt: string): TestRequest {
  // 合并语义与 pi 一致：模型级 baseUrl 覆盖 provider；headers 浅合并（模型级同键胜出）
  const baseUrl = trimBase(model.baseUrl || provider.baseUrl || '')
  const headers: Record<string, string> = { ...(provider.headers ?? {}), ...(model.headers ?? {}) }
  // 解析 $ENV / !command 后的 apiKey；headers 值同样支持该语法
  const rawKey = provider.apiKey ?? ''
  const apiKey = rawKey ? resolveConfigValue(rawKey) ?? '' : ''
  for (const [k, v] of Object.entries(headers)) {
    const resolved = resolveConfigValue(v)
    if (resolved !== undefined) headers[k] = resolved
    else delete headers[k]
  }
  // 认证规则（对齐 pi）：headers 已含认证头时不再自动附加；否则按协议附加
  const hasAuth = hasHeader(headers, 'authorization') || hasHeader(headers, 'x-api-key') || hasHeader(headers, 'x-goog-api-key')
  const id = model.id
  switch (api) {
    case 'anthropic-messages':
      if (!hasAuth) {
        if (provider.authHeader) {
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
        } else if (apiKey) {
          headers['x-api-key'] = apiKey
        }
        headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
      }
      return {
        url: `${baseUrl}/v1/messages`,
        headers,
        body: {
          model: id,
          max_tokens: TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        },
      }
    case 'google-generative-ai':
      if (!hasAuth && apiKey) headers['x-goog-api-key'] = apiKey
      return {
        // SDK 语义：baseUrl 去尾斜杠 + v1beta 版本段 + models/{id}:generateContent
        url: `${baseUrl}/v1beta/models/${id}:generateContent`,
        headers,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: TEST_MAX_OUTPUT_TOKENS },
        },
      }
    case 'openai-responses':
      if (!hasAuth && apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      return {
        url: `${baseUrl}/responses`,
        headers,
        body: { model: id, input: prompt, max_output_tokens: TEST_MAX_OUTPUT_TOKENS },
      }
    default:
      // openai-completions
      if (!hasAuth && apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      return {
        url: `${baseUrl}/chat/completions`,
        headers,
        body: {
          model: id,
          max_tokens: TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        },
      }
  }
}

// ---------- 响应解析 ----------

// 各协议的成功/错误响应形状不同，统一抽出回复文本与错误信息
function extractReply(api: PiApi, data: unknown): string | undefined {
  if (api === 'google-generative-ai') {
    const candidates = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates
    return candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || undefined
  }
  if (api === 'openai-responses') {
    const output = (data as { output?: { content?: { text?: string }[] }[] })?.output
    return output?.map((o) => o.content?.map((c) => c.text ?? '').join('') ?? '').join('') || undefined
  }
  if (api === 'anthropic-messages') {
    const content = (data as { content?: { text?: string }[] })?.content
    return content?.map((c) => c.text ?? '').join('') || undefined
  }
  const choices = (data as { choices?: { message?: { content?: string } }[] })?.choices
  return choices?.[0]?.message?.content || undefined
}

function extractError(data: unknown, text: string): string {
  // OpenAI/Google 风格 {error:{message}}；Anthropic {type:"error",error:{message,type}}；兜底原文
  const e = data as { error?: { message?: string; type?: string } | string; type?: string }
  if (e?.error) {
    if (typeof e.error === 'string') return e.error
    if (e.error.message) return e.error.type ? `(${e.error.type}) ${e.error.message}` : e.error.message
  }
  return text.slice(0, 300)
}

// ---------- 入口 ----------

export interface TestModelOptions {
  /** 自定义测试消息（仅本次请求生效，不落盘）；缺省用内置默认 */
  prompt?: string
}

export async function testModel(
  provider: PiProvider,
  model: PiModel,
  opts: TestModelOptions = {},
): Promise<TestModelResult> {
  const api: PiApi = (model.api ?? provider.api) as PiApi
  if (!api) {
    return { ok: false, ms: 0, error: '缺少 API 协议：请先在 provider 或模型上设置 api', url: '' }
  }
  if (!provider.baseUrl && !model.baseUrl) {
    return { ok: false, ms: 0, error: '缺少 baseUrl', url: '' }
  }
  // apiKey/headers 含 $ENV/!command 时可能解析失败：提前报可定位错误，而不是发出去 401
  if (provider.apiKey && !provider.apiKey.startsWith('!') && resolveConfigValue(provider.apiKey) === undefined) {
    return { ok: false, ms: 0, error: `apiKey 中的环境变量未定义：${provider.apiKey}`, url: '' }
  }
  // 测试消息可由调用方自定义（仅本次请求生效，不落盘）；输出上限固定为 2048 token，
  // 既能核对真实回复，又避免连接测试意外消耗过多 quota。
  const prompt = opts.prompt?.trim() || '使用python写一个二分法，不要写入文件'
  const { url, headers, body } = buildTestRequest(api, provider, model, prompt)
  const start = Date.now()
  try {
    const res = await outboundFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const ms = Date.now() - start
    const text = await res.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    if (!res.ok) {
      return { ok: false, ms, error: `HTTP ${res.status}：${data ? extractError(data, text) || text.slice(0, 200) : text.slice(0, 200) || '(空响应)'}`, url }
    }
    // HTTP 200 但网关可能返回带 error 字段的伪成功响应（one-api 常见），一并识别
    if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>) && (data as Record<string, unknown>).error) {
      return { ok: false, ms, error: `网关返回错误：${extractError(data, text)}`, url }
    }
    return { ok: true, ms, prompt, reply: extractReply(api, data), url }
  } catch (e) {
    const ms = Date.now() - start
    const err = e as Error
    const reason = err.name === 'TimeoutError' ? '请求超时（60 秒）' : err.message
    return { ok: false, ms, error: reason, url }
  }
}
