// 模型列表请求的构造与解析，由本机后端调用。
// 本文件不得依赖浏览器或 Node 专属 API。

import type { FetchedModel, PiApi } from '../src/types.js'

export type { FetchedModel } from '../src/types.js'

export interface ProviderModelsRequest {
  url: string
  /** OpenAI 兼容网关常见的备用列表地址（例如 baseUrl 未包含 /v1 时） */
  fallbackUrls?: string[]
  // 协议要求的基础请求头；认证和自定义 Header 由调用方统一解析后合并。
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

// 各协议的模型列表端点与基础请求头
export function buildProviderModelsRequest(api: PiApi, baseUrl: string): ProviderModelsRequest {
  switch (api) {
    case 'anthropic-messages':
      return {
        // 每页最多 1000 条，后续由 has_more / last_id 继续翻页。
        url: joinUrl(baseUrl, '/v1/models?limit=1000'),
        headers: {
          'anthropic-version': '2023-06-01',
          // 官方 api.anthropic.com 依赖此头才放行浏览器跨域；自定义代理通常忽略它
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      }
    case 'google-generative-ai':
      return {
        // 密钥统一放请求头，避免 URL 中携带旧分组密钥或把密钥写入访问日志。
        url: joinUrl(baseUrl, '/models'),
        headers: {},
      }
    default: {
      // openai-completions / openai-responses 共用 Chat Completions 生态的模型列表格式；
      // 兼容未填写 /v1 的网关，实际请求失败时由调用方尝试备用地址
      const urls = openAiModelUrls(baseUrl)
      return {
        ...urls,
        headers: {},
      }
    }
  }
}

export function nextProviderModelsPage(api: PiApi, data: unknown, currentUrl: string): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const page = data as Record<string, unknown>
  let token: unknown
  let parameter: string
  if (api === 'anthropic-messages') {
    if (page.has_more === undefined || page.has_more === false) return undefined
    if (page.has_more !== true) throw new Error('Anthropic 分页标记 has_more 必须是布尔值')
    token = page.last_id
    parameter = 'after_id'
  } else if (api === 'google-generative-ai') {
    if (page.nextPageToken === undefined || page.nextPageToken === '') return undefined
    token = page.nextPageToken
    parameter = 'pageToken'
  } else {
    return undefined
  }
  if (typeof token !== 'string' || !token.trim()) throw new Error('模型列表声明了后续页，但分页游标无效或缺失')
  // 只把游标写入当前端点，不跟随网关给出的任意 URL，认证始终发往原供应商。
  const next = new URL(currentUrl)
  next.searchParams.set(parameter, token)
  return next.toString()
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
