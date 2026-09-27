// 基础对话测试：对齐 pi 0.87.1 的端点、认证和兼容参数；不替代 pi 的登录、工具调用或完整会话验证。
// 请求构造参考 pi-ai provider-composer / 各协议 client：
// - baseUrl 取 model.baseUrl ?? provider.baseUrl，先去尾斜杠再拼端点路径
// - headers 忽略大小写合并：provider.headers ← model.headers（模型级覆盖同名头）
// - 认证：apiKey 支持 $ENV / ${ENV} 模板与 !command 语法（与 pi 的 resolve-config-value 同语义）；
//   openai/google 用 Bearer / x-goog-api-key，anthropic 用 x-api-key；authHeader 会同时附加 Bearer
// - google 的 baseUrl 由用户提供完整版本路径，与 pi 一样直接拼接 models 端点

import type { PiApi, PiModel, PiProvider, TestModelResult } from '../src/types.js'
import { PI_API_OPTIONS } from '../src/types.js'
import { mergeHeaders } from '../src/lib/modelAuth.js'
import { outboundFetch } from './proxyFetch.js'
import { resolveRequestHeaders } from './requestAuth.js'
import { validate } from './config.js'
import { readModelResponse, responseError } from './modelResponse.js'

export type { TestModelResult } from '../src/types.js'

// 连接测试需要看到可读的真实回复；2048 足以覆盖常见代码回答，同时限制意外 quota 消耗。
const TEST_MAX_OUTPUT_TOKENS = 2048
const TEST_TIMEOUT_MS = 60_000

// ---------- 请求构造 ----------

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

interface TestRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  compat: Record<string, unknown>
}

function buildTestRequest(api: PiApi, provider: PiProvider, model: PiModel, prompt: string, stream: boolean, providerName = ''): TestRequest {
  const baseUrl = trimBase(model.baseUrl || provider.baseUrl || '')
  const parsedUrl = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('测试地址仅支持 HTTP / HTTPS')
  const override = provider.modelOverrides?.[model.id]
  // 元数据覆盖最后生效；认证头沿用 pi 的顺序：modelOverrides → models → Provider 合并。
  const compat = { ...provider.compat, ...model.compat, ...(override?.compat as Record<string, unknown> | undefined) }
  for (const key of ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs']) {
    const layers = [provider.compat?.[key], model.compat?.[key], (override?.compat as Record<string, unknown> | undefined)?.[key]]
    if (layers.some((value) => value !== undefined)) compat[key] = Object.assign({}, ...layers)
  }
  const headers = resolveRequestHeaders(api, provider, mergeHeaders(override?.headers as Record<string, string> | undefined, model.headers))
  const maxTokens = Math.min(TEST_MAX_OUTPUT_TOKENS, (override?.maxTokens as number | undefined) ?? model.maxTokens ?? TEST_MAX_OUTPUT_TOKENS)
  // pi 0.87.1 只有 OpenAI 系列适配器读取 samplingParams；Anthropic / Google 不额外发送此字段。
  const sampling = api.startsWith('openai-') ? { ...model.samplingParams, ...(override?.samplingParams as Record<string, unknown> | undefined) } : {}
  // 测试必须使用界面选定的模型、提示词和模式，不能由扩展采样字段悄悄改测其他内容。
  for (const field of ['model', 'messages', 'input', 'contents', 'stream']) {
    if (field in sampling) throw new Error(`samplingParams.${field} 会覆盖测试目标或模式，本工具无法验证此配置`)
  }
  const id = model.id
  let url: string
  let body: Record<string, unknown>
  switch (api) {
    case 'anthropic-messages':
      // 使用模型独立认证时仍需版本头；它与密钥来源无关。
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'anthropic-version')) {
        headers['anthropic-version'] = '2023-06-01'
      }
      // pi 使用 Anthropic beta.messages 客户端；查询参数也是实际请求的一部分。
      url = `${baseUrl}/v1/messages?beta=true`
      body = { model: id, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], stream, ...sampling }
      break
    case 'google-generative-ai':
      // Pi 指定 baseUrl 后不再补版本段；流式端点通过 alt=sse 返回事件流。
      url = `${baseUrl}/models/${id}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
      body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, ...sampling },
      }
      break
    case 'openai-responses':
      url = `${baseUrl}/responses`
      body = { model: id, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream, store: false }
      if (compat.supportsMaxOutputTokens !== false) body.max_output_tokens = Math.max(16, maxTokens)
      Object.assign(body, sampling)
      break
    case 'openai-completions': {
      // 使用 pi 的常见厂商/地址检测作为默认值，显式 compat 始终优先。
      const legacyTokens = ['zai', 'zai-coding-cn', 'together', 'moonshotai', 'moonshotai-cn', 'cloudflare-ai-gateway', 'nvidia', 'ant-ling', 'deepseek'].includes(providerName) ||
        ['api.z.ai', 'open.bigmodel.cn', 'api.together.ai', 'api.together.xyz', 'api.moonshot.', 'gateway.ai.cloudflare.com', 'integrate.api.nvidia.com', 'api.ant-ling.com', 'chutes.ai'].some((host) => baseUrl.includes(host)) || baseUrl.toLowerCase().includes('deepseek.com')
      const nonStandard = legacyTokens || ['cerebras', 'xai', 'opencode', 'cloudflare-workers-ai'].includes(providerName) ||
        ['cerebras.ai', 'api.x.ai', 'opencode.ai', 'api.cloudflare.com'].some((host) => baseUrl.includes(host))
      const maxTokensField = (compat.maxTokensField as string | undefined) ?? (legacyTokens ? 'max_tokens' : 'max_completion_tokens')
      url = `${baseUrl}/chat/completions`
      body = { model: id, messages: [{ role: 'user', content: prompt }], stream, [maxTokensField]: maxTokens }
      if (stream && compat.supportsUsageInStreaming !== false) body.stream_options = { include_usage: true }
      if (compat.supportsStore ?? !nonStandard) body.store = false
      if (compat.openRouterRouting) body.provider = compat.openRouterRouting
      if (compat.vercelGatewayRouting) body.providerOptions = { gateway: compat.vercelGatewayRouting }
      Object.assign(body, sampling)
      break
    }
  }
  // 用户采样参数仍按 pi 的顺序覆盖；超出测试额度时明确拒绝，避免意外发出高额度请求。
  const tokenFields = api === 'google-generative-ai' ? body.generationConfig as Record<string, unknown> : body
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens']) {
    const value = tokenFields[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > TEST_MAX_OUTPUT_TOKENS)) {
      throw new Error(`测试请求的 ${field} 必须大于 0 且不超过 ${TEST_MAX_OUTPUT_TOKENS}`)
    }
  }
  return { url, headers, body, compat }
}

// ---------- 入口 ----------

export interface TestModelOptions {
  /** 自定义测试消息（仅本次请求生效，不落盘）；缺省用内置默认 */
  prompt?: string
  /** 默认测试 pi 使用的流式对话；可显式关闭以排查普通 JSON 响应。 */
  stream?: boolean
  /** 用于匹配 pi 的已知厂商兼容默认值，不用于读取凭据。 */
  providerName?: string
  /** 浏览器断开连接时同步中止上游，避免继续生成无人接收的回复。 */
  signal?: AbortSignal
}

export async function testModel(
  provider: PiProvider,
  model: PiModel,
  opts: TestModelOptions = {},
): Promise<TestModelResult> {
  const api = model.api ?? provider.api
  const stream = opts.stream ?? true
  if (!api || !PI_API_OPTIONS.some((item) => item.value === api)) {
    return { ok: false, ms: 0, error: api ? `本工具暂不支持测试协议：${api}` : '测试需要显式指定 API 协议；pi 内置或扩展的继承值无法在此确认', url: '', stream }
  }
  if (!provider.baseUrl && !model.baseUrl) {
    return { ok: false, ms: 0, error: '测试需要显式指定 baseUrl；pi 内置或扩展的继承值无法在此确认', url: '', stream }
  }
  const prompt = opts.prompt?.trim() || '使用python写一个二分法，不要写入文件'
  const start = Date.now()
  let url = ''
  try {
    opts.signal?.throwIfAborted()
    const errors = validate({ providers: { [opts.providerName || '当前测试']: { enabled: true, config: { ...provider, models: [model] } } } })
    if (errors.length) throw new Error(errors.join('；'))
    const request = buildTestRequest(api, provider, model, prompt, stream, opts.providerName)
    url = request.url
    const res = await outboundFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(TEST_TIMEOUT_MS)])
        : AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      try { detail = responseError(JSON.parse(text)) ?? detail }
      catch { /* HTTP 错误可能返回 HTML；保留状态码和有限原文用于排查。 */ }
      return { ok: false, ms: Date.now() - start, error: `HTTP ${res.status}：${detail || '(空响应)'}`, url, stream }
    }
    const reply = readModelResponse(api, text, stream, request.compat)
    return { ok: true, ms: Date.now() - start, prompt, reply, url, stream }
  } catch (e) {
    const err = e as Error
    const reason = opts.signal?.aborted ? '测试已取消' : err.name === 'TimeoutError' ? '请求超时（60 秒）' : err.message
    return { ok: false, ms: Date.now() - start, error: reason, url, stream }
  }
}
