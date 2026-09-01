// 后端在线导入：Node 端代发模型列表请求，可携带 User-Agent 等自定义 headers，
// 无浏览器 CORS / forbidden header 限制；返回时用 models.dev 补全元数据。

import type { PiApi } from '../src/types.js'
import { buildProviderModelsRequest, parseProviderModelsResponse } from './providerModelsCore.js'
import type { FetchedModel } from './providerModelsCore.js'
import { lookupModelMeta } from './modelsDev.js'
import { outboundFetch } from './proxyFetch.js'

export interface FetchModelsOptions {
  api: PiApi
  baseUrl: string
  apiKey: string
  /** provider 自定义 headers（Node 端可完整发送，含 User-Agent） */
  headers?: Record<string, string>
}

// 可重试的瞬时故障：网关连接不稳定（公益站常见）时连接超时/重置，稍后重试常能命中活节点；
// HTTP 4xx/5xx 是确定性结果，重试无意义
function isTransientError(e: unknown): boolean {
  const err = e as Error & { cause?: { code?: string } }
  // undici 连接失败抛 TypeError: fetch failed，真实原因在 cause.code；
  // AbortSignal.timeout 到期抛 TimeoutError
  const code = err?.cause?.code ?? ''
  if (
    err?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN'
  ) {
    return true
  }
  // undici 其他网络层错误统一报 "fetch failed"，无法从 code 区分时按可重试处理
  //（HTTP 错误走的是普通 Error 分支，不会进到这里）
  return err?.message === 'fetch failed'
}

export async function fetchProviderModels(opts: FetchModelsOptions): Promise<FetchedModel[]> {
  if (!opts.baseUrl) throw new Error('未配置 baseUrl')
  const { url, fallbackUrls, headers } = buildProviderModelsRequest(opts.api, opts.baseUrl, opts.apiKey)
  const urls = [url, ...(fallbackUrls ?? [])]
  // 获取模型重试：瞬时故障最多 4 次（首次 + 3 重试，间隔 500ms 递增），
  // 对半数节点不可用的网关成功率 >90%
  const maxAttempts = 4
  let lastError: Error = new Error('未知错误')
  let emptyModels: FetchedModel[] | undefined
  for (const requestUrl of urls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await outboundFetch(requestUrl, {
          headers: { ...headers, ...(opts.headers ?? {}) },
          signal: AbortSignal.timeout(20_000),
        })
        const text = await res.text()
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
        }
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error(`响应不是 JSON${text ? `：${text.slice(0, 200)}` : '（响应体为空）'}`)
        }
        const models = parseProviderModelsResponse(opts.api, data)
        if (models.length === 0 && requestUrl !== urls[urls.length - 1]) {
          // 某些网关根路径返回网页或空列表，继续尝试带 /v1 的模型端点。
          emptyModels = models
          break
        }
        await enrichWithModelsDev(models)
        return models
      } catch (e) {
        lastError = e as Error
        if (!isTransientError(e) || attempt === maxAttempts) break
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  // 至少有一个地址返回了合法但为空的列表时，保留原有“0 个模型”提示，
  // 不用备用地址的解析错误覆盖真实结果。
  if (emptyModels) return emptyModels
  throw lastError
}

// 用 models.dev 补全网关响应缺失的元数据；合并只填 undefined 字段，网关自带信息
// （如 OpenRouter 的 context_length）优先。过滤按字段判断：网关给了 context 但缺
// cost 的模型（OpenRouter 常见）也要补全，不能整条跳过
async function enrichWithModelsDev(models: FetchedModel[]): Promise<void> {
  const targets = models.filter(
    (m) =>
      m.contextWindow === undefined ||
      m.maxTokens === undefined ||
      m.cost === undefined ||
      m.inputImage === undefined ||
      m.reasoning === undefined,
  )
  if (!targets.length) return
  const metas = await Promise.all(targets.map((m) => lookupModelMeta(m.id)))
  targets.forEach((m, i) => {
    const meta = metas[i]
    if (!meta) return
    if (!m.name && meta.name) m.name = meta.name
    if (m.contextWindow === undefined) m.contextWindow = meta.contextWindow
    if (m.maxTokens === undefined) m.maxTokens = meta.maxTokens
    if (m.cost === undefined) m.cost = meta.cost
    if (m.inputImage === undefined) m.inputImage = meta.inputImage
    if (m.reasoning === undefined) m.reasoning = meta.reasoning
    if (m.thinkingLevelMap === undefined) m.thinkingLevelMap = meta.thinkingLevelMap
  })
}
