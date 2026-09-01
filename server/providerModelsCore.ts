// 模型列表请求的构造与解析：浏览器直连与本地代理（vite 中间件）共用。
// 本文件不得依赖浏览器或 Node 专属 API。

import type { PiApi } from '../src/types.js'

export interface FetchedModel {
  id: string
  name?: string
  // 网关响应自带或 models.dev 补全的元数据（可选，导入时写入对应字段）
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  inputImage?: boolean
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

export interface ProviderModelsRequest {
  url: string
  /** OpenAI 兼容网关常见的备用列表地址（例如 baseUrl 未包含 /v1 时） */
  fallbackUrls?: string[]
  // 认证相关 headers；provider 自定义 headers（如 User-Agent）由调用方合并。
  // 浏览器直连时 UA 会被 Fetch 规范丢弃，Node 代理则可完整发送
  headers: Record<string, string>
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

function openAiModelUrls(baseUrl: string): { url: string; fallbackUrls: string[] } {
  const base = baseUrl.replace(/\/+$/, '')
  const url = joinUrl(base, '/models')
  // 同一网关常同时存在 /models 与 /v1/models；先尊重用户填写的地址，
  // 首个地址不是可用模型接口时再尝试另一种常见路径。
  const alternate = /\/v1$/i.test(base) ? `${base.slice(0, -3)}/models` : `${base}/v1/models`
  return { url, fallbackUrls: alternate === url ? [] : [alternate] }
}

function dedupe(list: FetchedModel[]): FetchedModel[] {
  return Array.from(new Map(list.map((m) => [m.id, m])).values())
}

// 每token 字符串价 → $/1M 数字；保留 4 位小数避免浮点噪声
function perMillion(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * 1_000_000 * 10_000) / 10_000
}

// 各协议的模型列表端点与认证头
export function buildProviderModelsRequest(api: PiApi, baseUrl: string, apiKey: string): ProviderModelsRequest {
  switch (api) {
    case 'anthropic-messages':
      return {
        // limit=1000 覆盖绝大多数模型数，超出部分不再翻页
        url: joinUrl(baseUrl, '/v1/models?limit=1000'),
        headers: {
          'anthropic-version': '2023-06-01',
          // 官方 api.anthropic.com 依赖此头才放行浏览器跨域；自定义代理通常忽略它
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
      }
    case 'google-generative-ai':
      return {
        url: joinUrl(baseUrl, `/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`),
        headers: {},
      }
    default: {
      // openai-completions / openai-responses 共用 Chat Completions 生态的模型列表格式；
      // 兼容未填写 /v1 的网关，实际请求失败时由调用方尝试备用地址
      const urls = openAiModelUrls(baseUrl)
      return {
        ...urls,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }
    }
  }
}

// 解析各协议的列表响应
export function parseProviderModelsResponse(api: PiApi, data: unknown): FetchedModel[] {
  switch (api) {
    case 'anthropic-messages': {
      // { data: [{ id, display_name }] }
      const rows = (data as { data?: { id?: string; display_name?: string }[] })?.data ?? []
      return dedupe(
        rows
          .filter((m) => typeof m?.id === 'string' && m.id)
          .map((m) => ({ id: m.id as string, name: m.display_name })),
      )
    }
    case 'google-generative-ai': {
      // { models: [{ name, displayName, supportedGenerationMethods }] }
      const rows =
        (data as { models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[] })
          ?.models ?? []
      return dedupe(
        rows
          .filter(
            (m) =>
              typeof m?.name === 'string' &&
              // 只保留支持 generateContent 的条目，过滤 embedding/tts 等专用模型
              (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')),
          )
          .map((m) => ({ id: m.name!.replace(/^models\//, ''), name: m.displayName })),
      )
    }
    default: {
      // OpenAI 风格：{ data: [{ id }] }（one-api/new-api 等同构），兼容裸数组；
      // OpenRouter 变体会额外携带 context_length 与 pricing（每 token 字符串）
      const raw = data as {
        data?: { id?: string; name?: string; context_length?: number; pricing?: Record<string, string> }[]
      } | { id?: string; name?: string; context_length?: number; pricing?: Record<string, string> }[]
      const rows = Array.isArray(raw) ? raw : (raw?.data ?? [])
      return dedupe(
        rows
          .filter((m) => typeof m?.id === 'string' && m.id)
          .map((m) => ({
            id: m.id as string,
            name: m.name,
            contextWindow: typeof m.context_length === 'number' ? m.context_length : undefined,
            // OpenRouter pricing 是每 token 美元字符串，换成 pi 的 $/1M
            cost: m.pricing
              ? {
                  input: perMillion(m.pricing.prompt),
                  output: perMillion(m.pricing.completion),
                  cacheRead: perMillion(m.pricing.cache_read ?? m.pricing.prompt),
                  cacheWrite: perMillion(m.pricing.cache_write),
                }
              : undefined,
          })),
      )
    }
  }
}
