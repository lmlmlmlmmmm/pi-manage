// models.dev 元数据补全：优先匹配当前供应商，无法确认时仅引用唯一的厂商资料。
// 仅补全网关缺失的字段；资料价格不等于账户或中转站的实际费率。

import type { ModelMeta, ModelMetaSource, PiApi } from '../src/types.js'
import { outboundFetch } from './proxyFetch.js'

// models.dev api.json 的最小结构（provider → models 表）
// 网络请求经 outboundFetch（用户配置代理时走代理，绕开 TUN 兼容性问题）
interface ModelsDevEntry {
  name?: string
  reasoning?: boolean
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  // 思考档位来源（对齐 pi-switch）：type=="effort" 的 values 列出该模型支持的档位名
  reasoning_options?: { type?: string; values?: string[] }[]
  provider?: { npm?: string; api?: string; shape?: string }
}

export type { ModelMeta } from '../src/types.js'

const API_URL = 'https://models.dev/api.json'

// 中转商只在地址匹配时采用，不能作为其他中转商同名模型的默认资料。
const OFFICIAL_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'meta',
  'xai',
  'deepseek',
  'zhipuai',
  'moonshotai',
  'mistral',
  'cohere',
  'minimax',
  'stepfun',
  'alibaba',
  'amazon',
])

// models.dev 的官方 SDK 条目省略 api 地址；其余供应商使用目录中的显式地址。
const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
}
const SDK_APIS: Record<string, PiApi[]> = {
  '@ai-sdk/openai': ['openai-completions', 'openai-responses'],
  '@ai-sdk/openai-compatible': ['openai-completions'],
  '@openrouter/ai-sdk-provider': ['openai-completions'],
  '@ai-sdk/anthropic': ['anthropic-messages'],
  '@ai-sdk/google': ['google-generative-ai'],
  '@ai-sdk/xai': ['openai-completions'],
  '@ai-sdk/mistral': ['openai-completions'],
}

interface IndexedModel {
  provider: string
  id: string
  entry: ModelsDevEntry
  endpoint?: string
  apis: PiApi[]
}
type ModelIndex = Map<string, IndexedModel[]>

export interface ModelMetaLookupOptions {
  api?: string
  baseUrl?: string
  proxyOverride?: string
}

function normalizedEndpoint(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    // SDK 有的自行补 /v1；保留其余路径，避免把同域名下不同计费产品混为一谈。
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1(?:beta)?$/, '')
  } catch {
    // 目录中的区域/租户占位地址无法确认对应当前连接，不参与供应商匹配。
    return undefined
  }
}

// 会话内只拉取一次；失败后不缓存失败状态，下次导入可重试
let indexPromise: Promise<ModelIndex> | null = null

function loadIndex(proxyOverride?: string): Promise<ModelIndex> {
  // 临时代理（代理页「测试」按钮）：单独发一次不污染进程缓存；
  // 索引已缓存时直接复用（常规路径可用，测试即通过）
  if (proxyOverride) {
    if (indexPromise) return indexPromise
    return buildIndex(proxyOverride)
  }
  indexPromise ??= buildIndex()
  return indexPromise
}

async function buildIndex(proxyOverride?: string): Promise<ModelIndex> {
  try {
    // 网络请求经 outboundFetch（用户配置/临时指定代理时走代理，绕开 TUN 兼容性问题）
    const res = await outboundFetch(API_URL, { signal: AbortSignal.timeout(15_000) }, proxyOverride)
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, { api?: string; npm?: string; models?: Record<string, ModelsDevEntry> }>
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('models.dev 返回的目录格式无效')
    const index: ModelIndex = new Map()
    // 同名模型保留各供应商原始条目，绝不拼接别家价格、能力或思考档位。
    for (const [providerName, provider] of Object.entries(data)) {
      for (const [id, entry] of Object.entries(provider.models ?? {})) {
        const npm = entry.provider?.npm ?? provider.npm ?? ''
        const apis = entry.provider?.shape === 'responses' ? ['openai-responses' as const] : SDK_APIS[npm] ?? []
        const indexed: IndexedModel = {
          provider: providerName, id, entry, apis,
          endpoint: normalizedEndpoint(entry.provider?.api ?? provider.api ?? DEFAULT_ENDPOINTS[providerName]),
        }
        const entries = index.get(id) ?? []
        entries.push(indexed)
        index.set(id, entries)
      }
    }
    return index
  } catch (e) {
    // 失败即清空缓存：rejected promise 若留在缓存，进程内就永远无法重试了；
    // 临时代理路径的失败与缓存无关，不清
    if (!proxyOverride) indexPromise = null
    throw e
  }
}

const GRADED_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'] as const

// 按 pi-switch 规则生成 thinkingLevelMap：
// reasoning 模型才有；graded 档位一个都不支持则整体不生成；
// values 含 "none" → off 发送 "none"；支持的档位发档位名本身，不支持的档位写 null（pi 会隐藏/跳过）
function buildThinkingLevelMap(entry: ModelsDevEntry): Record<string, string | null> | undefined {
  if (entry.reasoning !== true) return undefined
  const effort = entry.reasoning_options?.find((o) => o.type === 'effort')?.values
  if (!effort || !effort.length) return undefined
  const contains = (name: string) => effort.includes(name)
  const graded = GRADED_LEVELS.filter((l) => l !== 'none')
  if (!graded.some(contains)) return undefined
  const map: Record<string, string | null> = {}
  if (contains('none')) map.off = 'none'
  for (const level of graded) {
    map[level] = contains(level) ? level : null
  }
  return map
}

function toMeta(entry: ModelsDevEntry, source: ModelMetaSource, includeThinking: boolean): ModelMeta {
  return {
    contextWindow: entry.limit?.context || undefined,
    maxTokens: entry.limit?.output || undefined,
    cost: entry.cost
      ? {
          input: entry.cost.input ?? undefined,
          output: entry.cost.output ?? undefined,
          cacheRead: entry.cost.cache_read ?? undefined,
          cacheWrite: entry.cost.cache_write ?? undefined,
        }
      : undefined,
    inputImage: entry.modalities?.input?.includes('image'),
    reasoning: entry.reasoning,
    name: entry.name,
    thinkingLevelMap: includeThinking ? buildThinkingLevelMap(entry) : undefined,
    source,
  }
}

export async function lookupModelMeta(id: string, opts: ModelMetaLookupOptions = {}): Promise<ModelMeta | null> {
  // 网络错误上抛，不能把服务不可用误报成“未收录”。导入流程自行保留网关数据。
  const index = await loadIndex(opts.proxyOverride)
  const exact = index.get(id) ?? []
  const parts = id.split('/')
  const vendor = parts.length > 1 ? parts[parts.length - 2]! : ''
  // 只识别明确的厂商前缀，不再任意截取末段，避免同名私有模型被错误补全。
  const aliases = OFFICIAL_PROVIDERS.has(vendor)
    ? (index.get(parts[parts.length - 1]!) ?? []).filter((entry) => entry.provider === vendor)
    : []
  const endpoint = normalizedEndpoint(opts.baseUrl)
  const matched = endpoint ? exact.filter((entry) => entry.endpoint === endpoint) : []
  const compatible = matched.filter((entry) => entry.apis.includes(opts.api as PiApi))
  const candidates = compatible.length ? compatible : matched
  let hit = candidates.length === 1 ? candidates[0] : undefined
  const match: ModelMetaSource['match'] = hit ? 'provider' : 'reference'
  if (!hit) {
    const official = aliases.length ? aliases : exact.filter((entry) => OFFICIAL_PROVIDERS.has(entry.provider))
    // 同名但厂商不唯一时不猜测；保留用户值，允许手工填写。
    if (official.length === 1) hit = official[0]
  }
  if (!hit) return null
  return toMeta(hit.entry, { provider: hit.provider, modelId: hit.id, match },
    match === 'provider' && hit.apis.includes(opts.api as PiApi))
}
