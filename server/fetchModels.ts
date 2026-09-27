// 后端在线导入：Node 端代发模型列表请求，可携带 User-Agent 等自定义 headers，
// 无浏览器 CORS / forbidden header 限制；返回时用 models.dev 补全元数据。

import type { ModelMeta, PiApi } from '../src/types.js'
import { buildProviderModelsRequest, nextProviderModelsPage, parseProviderModelsResponse } from './providerModelsCore.js'
import type { FetchedModel } from './providerModelsCore.js'
import { lookupModelMeta } from './modelsDev.js'
import { outboundFetch } from './proxyFetch.js'
import { resolveRequestHeaders } from './requestAuth.js'
import { mergeHeaders } from '../src/lib/modelAuth.js'

export interface FetchModelsOptions {
  api: PiApi
  baseUrl: string
  apiKey: string
  authHeader?: boolean
  /** Provider 与模型合并后的自定义 headers（Node 端可完整发送，含 User-Agent） */
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
  const { url, fallbackUrls, headers } = buildProviderModelsRequest(opts.api, opts.baseUrl)
  const requestHeaders = mergeHeaders(headers, resolveRequestHeaders(opts.api, opts))
  const urls = [url, ...(fallbackUrls ?? [])]
  let lastError: Error = new Error('未知错误')
  let emptyModels: FetchedModel[] | undefined
  for (const requestUrl of urls) {
    const collected = new Map<string, FetchedModel>()
    const visited = new Set<string>()
    let pageUrl: string | undefined = requestUrl
    let pagesRead = 0
    try {
      while (pageUrl) {
        if (visited.has(pageUrl)) throw new Error('分页游标重复，网关未返回新的页面')
        // 异常网关可能不断生成新游标；达到保护上限时明确失败，不把截断结果当作完整列表。
        if (visited.size >= 1000) throw new Error('模型列表超过 1000 页，请检查网关分页响应')
        visited.add(pageUrl)
        const data = await fetchModelPage(pageUrl, requestHeaders)
        const models = parseProviderModelsResponse(opts.api, data)
        for (const model of models) collected.set(model.id, model)
        pagesRead++
        // 即使本页全是被过滤的 embedding 模型，也必须检查后续页。
        pageUrl = nextProviderModelsPage(opts.api, data, pageUrl)
      }
      const models = [...collected.values()]
      if (models.length === 0 && requestUrl !== urls[urls.length - 1]) {
        emptyModels = models
        continue
      }
      await enrichWithModelsDev(models, opts)
      return models
    } catch (e) {
      lastError = e as Error
      // 后续页失败时整次导入失败，用户不会误把部分列表当成全部模型。
      if (pagesRead > 0) throw new Error(`模型列表未完整获取（已获取 ${collected.size} 个模型）：${lastError.message}`)
    }
  }
  // 至少有一个地址返回了合法但为空的列表时，保留原有“0 个模型”提示，
  // 不用备用地址的解析错误覆盖真实结果。
  if (emptyModels) return emptyModels
  throw lastError
}

// 每页独立重试瞬时故障，已完成的页面不重复请求；HTTP 错误直接交给调用方提示。
async function fetchModelPage(url: string, headers: Record<string, string>): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await outboundFetch(url, { headers, signal: AbortSignal.timeout(20_000) })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON${text ? `：${text.slice(0, 200)}` : '（响应体为空）'}`)
      }
    } catch (e) {
      if (!isTransientError(e) || attempt === 4) throw e
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
}

// 用 models.dev 补全网关响应缺失的元数据；合并只填 undefined 字段，网关自带信息
// （如 OpenRouter 的 context_length）优先。过滤按字段判断：网关给了 context 但缺
// cost 的模型（OpenRouter 常见）也要补全，不能整条跳过
async function enrichWithModelsDev(models: FetchedModel[], opts: FetchModelsOptions): Promise<void> {
  const targets = models.filter(
    (m) =>
      m.contextWindow === undefined ||
      m.maxTokens === undefined ||
      m.cost === undefined ||
      m.inputImage === undefined ||
      m.reasoning === undefined,
  )
  if (!targets.length) return
  let metas: (ModelMeta | null)[]
  try {
    metas = await Promise.all(targets.map((m) => lookupModelMeta(m.id, { api: opts.api, baseUrl: opts.baseUrl })))
  } catch (e) {
    // 元数据服务不可用不丢弃已获取的网关列表；记录原因，便于重试和排查代理连接。
    console.warn('models.dev 元数据获取失败，本次仅导入网关信息：', (e as Error).message)
    return
  }
  targets.forEach((m, i) => {
    const meta = metas[i]
    if (!meta) return
    if (!m.name && meta.name) m.name = meta.name
    if (m.contextWindow === undefined) m.contextWindow = meta.contextWindow
    if (m.maxTokens === undefined) m.maxTokens = meta.maxTokens
    if (m.cost === undefined && meta.cost !== undefined) {
      m.cost = meta.cost
      m.referenceCost = true
    }
    if (m.inputImage === undefined) m.inputImage = meta.inputImage
    if (m.reasoning === undefined) m.reasoning = meta.reasoning
    if (m.thinkingLevelMap === undefined) m.thinkingLevelMap = meta.thinkingLevelMap
    m.metadataSource = meta.source
  })
}
