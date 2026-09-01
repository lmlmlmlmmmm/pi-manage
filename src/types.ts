// pi 配置文件的数据结构
// 字段语义以 pi 官方文档 models.md / settings.md 为准。
// 所有对象带索引签名：工具未识别的字段在保存时原样保留（无损写入）。

// pi 支持的四种 API 协议
export type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

export const PI_API_OPTIONS: { label: string; value: PiApi }[] = [
  { label: 'openai-completions（Chat Completions，兼容性最好）', value: 'openai-completions' },
  { label: 'openai-responses（OpenAI Responses）', value: 'openai-responses' },
  { label: 'anthropic-messages（Anthropic Messages）', value: 'anthropic-messages' },
  { label: 'google-generative-ai（Google AI Studio）', value: 'google-generative-ai' },
]

// pi 的思考档位（thinkingLevelMap 的键、settings.defaultThinkingLevel 的取值）
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface PiCost {
  // Pi 0.84.4 的模型 cost 一旦出现，四个基础费率均为 schema 必填项
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  [key: string]: unknown
}

export interface PiModel {
  id: string
  name?: string
  api?: PiApi
  // 模型级覆盖：优先级高于 provider 同名字段（源码 modelFromJson / rawModelHeaders）
  baseUrl?: string
  headers?: Record<string, string>
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: PiCost
  thinkingLevelMap?: Record<string, string | null>
  samplingParams?: Record<string, unknown>
  compat?: Record<string, unknown>
  [key: string]: unknown
}

export interface PiProvider {
  baseUrl?: string
  api?: PiApi
  apiKey?: string
  authHeader?: boolean
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  models?: PiModel[]
  modelOverrides?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

export interface PiModelsFile {
  providers: Record<string, PiProvider>
}

// 本地库条目：完整 provider 配置 + 是否同步到 pi 的 models.json（对齐 pi-switch）
export interface LibraryProvider {
  enabled: boolean
  config: PiProvider
}

// 本地库文件结构（~/.pi/agent/.pi-manage/providers.json）
export interface PiLibrary {
  providers: Record<string, LibraryProvider>
}

// 库与 models.json 的差异项：外部工具（pi-switch / cc-switch / 手动编辑）改过投影后，
// 加载时列出供用户一键处理
export interface ProviderDiff {
  kind: 'external-added' | 'external-removed'
  name: string
  modelCount: number
  /** external-added 时携带 models.json 中的原始配置快照，供「导入到库」 */
  config?: PiProvider
}

export interface SaveResult {
  ok: boolean
  errors: string[]
  written: string[]
  /** 合并外部变更后的最终 settings（保存成功时返回，前端据此刷新编辑状态与合并基线） */
  settings?: PiSettings
  /** 保存时检测到并被保留的 settings.json 外部变更字段（pi 等工具在页面打开期间写入） */
  externalSettingsKeys?: string[]
}

// 模型连接测试结果（后端按 pi 实际请求语义发送完整对话请求）
export interface TestModelResult {
  ok: boolean
  ms: number
  /** 本次实际发送的测试消息（回显） */
  prompt?: string
  reply?: string
  error?: string
  url: string
}

// models.dev 元数据（编辑表单「获取元数据」/ 在线导入补全）
export interface ModelMeta {
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  inputImage?: boolean
  reasoning?: boolean
  name?: string
  thinkingLevelMap?: Record<string, string | null>
}

// 在线导入拉取到的模型（网关自带 + models.dev 补全的元数据）
export interface FetchedModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  inputImage?: boolean
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

// pi-manage 自身应用配置（代理等，存 ~/.pi/agent/.pi-manage/config.json，与 pi settings 无关）
export interface AppConfig {
  /** HTTP/mixed 或 SOCKS5 代理地址，如 http://127.0.0.1:10808、socks5://127.0.0.1:1080 */
  proxy?: string
  /** 代理认证信息（可选，仅供 pi-manage 后端建立代理连接） */
  proxyUsername?: string
  proxyPassword?: string
  [key: string]: unknown
}

export interface PiSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  hideThinkingBlock?: boolean
  theme?: string
  skills?: string[]
  [key: string]: unknown
}
