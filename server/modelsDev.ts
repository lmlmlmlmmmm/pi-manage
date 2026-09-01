// models.dev 元数据补全（pi-switch 同款数据源）：
// 按 id 匹配主流模型的 context window / 定价 / 图像输入 / reasoning，
// 仅用于补全网关 /models 响应中缺失的字段，网关自带的信息优先。

// models.dev api.json 的最小结构（203 个 provider → models 表）
// 网络请求经 outboundFetch（用户配置代理时走代理，绕开 TUN 兼容性问题）
interface ModelsDevEntry {
  name?: string
  reasoning?: boolean
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  // 思考档位来源（对齐 pi-switch）：type=="effort" 的 values 列出该模型支持的档位名
  reasoning_options?: { type?: string; values?: string[] }[]
}

export interface ModelMeta {
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  inputImage?: boolean
  reasoning?: boolean
  name?: string
  thinkingLevelMap?: Record<string, string | null>
}

const API_URL = 'https://models.dev/api.json'
import { outboundFetch } from './proxyFetch.js'

// 同名模型跨多个 provider 时，优先取官方厂商条目（定价/参数权威），
// 第三方中转（如 cortecs、ai-router）仅兜底，避免把中转商的价差写入配置
const OFFICIAL_PROVIDERS = [
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
  'github-copilot',
  'openrouter',
]

// 会话内只拉取一次；失败后不缓存失败状态，下次导入可重试
let indexPromise: Promise<Map<string, ModelsDevEntry>> | null = null

function loadIndex(proxyOverride?: string): Promise<Map<string, ModelsDevEntry>> {
  // 临时代理（代理页「测试」按钮）：单独发一次不污染进程缓存；
  // 索引已缓存时直接复用（常规路径可用，测试即通过）
  if (proxyOverride) {
    if (indexPromise) return indexPromise
    return buildIndex(proxyOverride)
  }
  indexPromise ??= buildIndex()
  return indexPromise
}

async function buildIndex(proxyOverride?: string): Promise<Map<string, ModelsDevEntry>> {
  try {
    // 网络请求经 outboundFetch（用户配置/临时指定代理时走代理，绕开 TUN 兼容性问题）
    const res = await outboundFetch(API_URL, { signal: AbortSignal.timeout(15_000) }, proxyOverride)
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
    const data = (await res.json()) as Record<string, { models?: Record<string, ModelsDevEntry> }>
    const index = new Map<string, ModelsDevEntry>()
    const official = new Set(OFFICIAL_PROVIDERS)
    // 两遍遍历：先收集官方 provider 的条目（优先），再补第三方兜底
    for (const isOfficial of [true, false]) {
      for (const [providerName, provider] of Object.entries(data)) {
        if (official.has(providerName) !== isOfficial) continue
        for (const [id, entry] of Object.entries(provider.models ?? {})) {
          if (!index.has(id)) index.set(id, entry)
        }
      }
    }
    // 思考档位统一（对齐 pi-switch 的 enrich_reasoning）：同一模型跨 provider 的
    // effort 选项常不完整，取全局最详细的一份覆盖到 index 条目，
    // 使导入不依赖命中了哪家 listing
    const best = new Map<string, ModelsDevEntry['reasoning_options']>()
    for (const provider of Object.values(data)) {
      for (const [id, entry] of Object.entries(provider.models ?? {})) {
        if (effortDetail(entry.reasoning_options) > effortDetail(best.get(id))) {
          best.set(id, entry.reasoning_options)
        }
      }
    }
    for (const [id, options] of best) {
      const entry = index.get(id)
      if (entry && effortDetail(options) > effortDetail(entry.reasoning_options)) {
        entry.reasoning_options = options
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

// effort 选项的详细度：values 中属于已知思考档位的档位名数量
const GRADED_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'] as const

function effortDetail(options: ModelsDevEntry['reasoning_options']): number {
  const values = options?.find((o) => o.type === 'effort')?.values ?? []
  return values.filter((v) => (GRADED_LEVELS as readonly string[]).includes(v)).length
}

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

function toMeta(entry: ModelsDevEntry): ModelMeta {
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
    inputImage: entry.modalities?.input?.includes('image') || undefined,
    reasoning: entry.reasoning === true || undefined,
    name: entry.name,
    thinkingLevelMap: buildThinkingLevelMap(entry),
  }
}

// 精确匹配 → 失败则取 id 最后一段（openrouter/anthropic/claude-x → claude-x）
// proxyOverride：临时代理（代理页「测试」按钮用），不影响正常请求的代理选择
export async function lookupModelMeta(id: string, proxyOverride?: string): Promise<ModelMeta | null> {
  let index: Map<string, ModelsDevEntry>
  try {
    index = await loadIndex(proxyOverride)
  } catch (e) {
    // 临时代理路径（代理页「测试」按钮）：失败必须上抛——测的就是代理连通性，
    // 静默降级成 null 会让「网络不通」伪装成「未收录」
    if (proxyOverride) throw e
    // 元数据是锦上添花，网络失败静默降级为仅导入 id/name
    return null
  }
  const hit = index.get(id) ?? (id.includes('/') ? index.get(id.split('/').pop()!) : undefined)
  return hit ? toMeta(hit) : null
}
