// 后端核心：pi 配置的本地库 / models.json / settings.json 读写与业务逻辑。
// 前端只保留编辑状态，保存时整包提交到这里落盘；本模块拥有完整文件系统权限，
// 定位 ~/.pi/agent（或 PI_CODING_AGENT_DIR），不再受浏览器沙箱限制。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { LoadedState, PiLibrary, PiModelsFile, PiProvider, PiSettings, ProviderDiff, SaveResult } from '../src/types.js'

const MODELS_FILE = 'models.json'
const SETTINGS_FILE = 'settings.json'
const LIBRARY_DIR = '.pi-manage'
const LIBRARY_FILE = 'providers.json'

const CONFIG_FILES = [`${LIBRARY_DIR}/${LIBRARY_FILE}`, MODELS_FILE, SETTINGS_FILE]

export type { LoadedState } from '../src/types.js'

function configRevision(contents: (string | null)[]): string {
  // 只锁定完整库与启用投影；pi CLI 对 settings 的独立修改继续走三方合并。
  return createHash('sha256').update(JSON.stringify(contents.slice(0, 2))).digest('hex')
}

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.pi', 'agent')
}

function readJson<T>(file: string, label: string, allowComments = false): T | null {
  if (!existsSync(file)) return null
  return parseJson<T>(readFileSync(file, 'utf-8'), label, allowComments)
}

function parseJson<T>(content: string | null, label: string, allowComments = false): T | null {
  if (content === null) return null
  try {
    let source = content.replace(/^\uFEFF/, '')
    // pi 仅对 models.json 接受行注释和尾逗号；字符串里的 URL、// 和逗号必须原样保留。
    if (allowComments) {
      source = source
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match[0] === '"' ? match : '')
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match)
    }
    return JSON.parse(source) as T
  } catch (e) {
    throw new Error(`${label} 不是合法 JSON：${(e as Error).message}`)
  }
}

function serialize(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

const COST_RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Pi 0.84.4 的 ModelCostSchema 要求 cost 出现时四个基础费率全部存在。
// 元数据源通常不提供 cacheWrite；缺项按 Pi 在 cost 整体省略时采用的默认费率 0 补齐。
// 空 cost 与完全省略等价，直接删除，避免输出无意义对象。
function normalizeProviderCosts(providers: Record<string, PiProvider>): number {
  let repairedModels = 0
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue
    for (const model of provider.models) {
      if (!isRecord(model) || model.cost === undefined || !isRecord(model.cost)) continue
      const cost = model.cost
      let repaired = false
      if (Object.keys(cost).length === 0) {
        delete model.cost
        repaired = true
      } else {
        for (const key of COST_RATE_KEYS) {
          if (cost[key] === undefined) {
            cost[key] = 0
            repaired = true
          }
        }
      }
      if (repaired) repairedModels++
    }
  }
  return repairedModels
}

function normalizeLibraryCosts(library: PiLibrary): number {
  if (!isRecord(library) || !isRecord(library.providers)) return 0
  // null 原型避免 provider 名为「__proto__」时触发 setter；后续 validate 会给出明确保留键错误。
  const providers = Object.create(null) as Record<string, PiProvider>
  for (const [name, entry] of Object.entries(library.providers)) {
    if (isRecord(entry) && isRecord(entry.config)) providers[name] = entry.config as PiProvider
  }
  return normalizeProviderCosts(providers)
}

function validateCost(errors: string[], modelLabel: string, value: unknown, partial = false): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push(`${modelLabel}的 cost 必须是对象`)
    return
  }
  for (const key of COST_RATE_KEYS) {
    // modelOverrides 的费率按字段继承，不能套用 models 中四项同时必填的规则。
    if (partial && value[key] === undefined) continue
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      errors.push(`${modelLabel}的 cost.${key} 必须是有效数字`)
    }
  }
  if (value.tiers === undefined) return
  if (!Array.isArray(value.tiers)) {
    errors.push(`${modelLabel}的 cost.tiers 必须是数组`)
    return
  }
  for (const [index, tier] of value.tiers.entries()) {
    const tierLabel = `${modelLabel}的 cost.tiers[${index}]`
    if (!isRecord(tier)) {
      errors.push(`${tierLabel} 必须是对象`)
      continue
    }
    if (typeof tier.inputTokensAbove !== 'number' || !Number.isFinite(tier.inputTokensAbove)) {
      errors.push(`${tierLabel}.inputTokensAbove 必须是有效数字`)
    }
    for (const key of COST_RATE_KEYS) {
      if (typeof tier[key] !== 'number' || !Number.isFinite(tier[key])) {
        errors.push(`${tierLabel}.${key} 必须是有效数字`)
      }
    }
  }
}

// 原子写：先写同目录临时文件再 rename 覆盖。直接 writeFileSync 在进程被杀/磁盘满时
// 会留下截断的 JSON，导致下次读取失败并阻断一切写入
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件清理失败不影响主错误 */
    }
    throw e
  }
}

// ---------- 磁盘读写 ----------

export function loadState(): LoadedState {
  const dir = agentDir()
  // 版本必须对应本次实际解析的字节；读取结束后重新取版本会把旧页面误认为已见过外部新内容。
  const contents = CONFIG_FILES.slice(0, 2).map((name) => {
    const file = join(dir, name)
    return existsSync(file) ? readFileSync(file, 'utf-8') : null
  })
  const models = parseJson<PiModelsFile>(contents[1], MODELS_FILE, true) ?? { providers: {} }
  if (
    !isRecord(models) ||
    typeof models.providers !== 'object' ||
    models.providers === null ||
    Array.isArray(models.providers)
  ) {
    throw new Error(`${MODELS_FILE} 结构异常：缺少 providers 对象`)
  }
  // 逐条校验 provider 值：null/非对象会让下方差异检测与首次导入直接 TypeError
  for (const [name, config] of Object.entries(models.providers)) {
    if (!isRecord(config)) {
      throw new Error(`${MODELS_FILE} 中 provider「${name}」的配置不是对象`)
    }
  }
  const modelsCostRepairs = normalizeProviderCosts(models.providers)
  const settings = readJson<PiSettings>(join(dir, SETTINGS_FILE), SETTINGS_FILE) ?? {}
  if (!isRecord(settings)) throw new Error(`${SETTINGS_FILE} 结构异常：必须是对象`)

  const libFile = join(dir, LIBRARY_DIR, LIBRARY_FILE)
  let library: PiLibrary
  let libraryCostRepairs = 0
  const warnings: string[] = []
  const diffs: ProviderDiff[] = []

  if (contents[0] === null) {
    // 首次运行：把现有 models.json 全量导入库，全部启用；库文件直接落盘
    const providers: PiLibrary['providers'] = {}
    for (const [name, config] of Object.entries(models.providers)) {
      providers[name] = { enabled: true, config }
    }
    library = { providers }
    mkdirSync(join(dir, LIBRARY_DIR), { recursive: true })
    contents[0] = serialize(library)
    writeFileAtomic(libFile, contents[0])
  } else {
    library = parseJson<PiLibrary>(contents[0], `${LIBRARY_DIR}/${LIBRARY_FILE}`) ?? { providers: {} }
    // 库文件损坏时报可定位的错误（对齐 models.json 的处理），而不是后续流程里的 TypeError
    if (
      !isRecord(library) ||
      typeof library.providers !== 'object' ||
      library.providers === null ||
      Array.isArray(library.providers)
    ) {
      throw new Error(`${LIBRARY_DIR}/${LIBRARY_FILE} 结构异常：缺少 providers 对象`)
    }
    for (const [name, lp] of Object.entries(library.providers)) {
      if (!isRecord(lp) || !isRecord(lp.config)) {
        throw new Error(`${LIBRARY_DIR}/${LIBRARY_FILE} 中 provider「${name}」条目缺少 config 对象`)
      }
    }
    libraryCostRepairs = normalizeLibraryCosts(library)
    if (libraryCostRepairs > 0) {
      contents[0] = serialize(library)
      writeFileAtomic(libFile, contents[0])
    }
    // 双向差异检测（对齐 pi-switch 同步语义）
    for (const [name, config] of Object.entries(models.providers)) {
      if (!Object.hasOwn(library.providers, name)) {
        diffs.push({ kind: 'external-added', name, modelCount: config.models?.length ?? 0, config: clone(config) })
      } else if (!library.providers[name].enabled || !isDeepStrictEqual(config, library.providers[name].config)) {
        // 同名 provider 的模型、密钥等发生变化也需确认，避免任意一次自动保存覆盖外部编辑。
        diffs.push({ kind: 'external-modified', name, modelCount: config.models?.length ?? 0, config: clone(config) })
      }
    }
    for (const [name, lp] of Object.entries(library.providers)) {
      if (lp.enabled && !(name in models.providers)) {
        diffs.push({ kind: 'external-removed', name, modelCount: lp.config.models?.length ?? 0 })
      }
    }
  }

  if (modelsCostRepairs > 0) {
    contents[1] = serialize(models)
    writeFileAtomic(join(dir, MODELS_FILE), contents[1])
  }
  if (modelsCostRepairs > 0 || libraryCostRepairs > 0) {
    const repaired = [
      modelsCostRepairs > 0 ? `${MODELS_FILE} ${modelsCostRepairs} 个` : '',
      libraryCostRepairs > 0 ? `${LIBRARY_DIR}/${LIBRARY_FILE} ${libraryCostRepairs} 个` : '',
    ].filter(Boolean)
    warnings.push(
      `已修复模型 cost 缺失字段（${repaired.join('，')}）：Pi 要求 input/output/cacheRead/cacheWrite 同时存在，缺失项已补 0。`,
    )
  }

  if (settings.defaultProvider && !(settings.defaultProvider in library.providers)) {
    warnings.push(`默认 provider「${settings.defaultProvider}」不在本地库中。`)
  }

  return { library, settings, diffs, warnings, piDir: dir, revision: configRevision(contents) }
}

// 启用子集投影：models.json 只写 enabled 的 provider
function projectModels(library: PiLibrary): PiModelsFile {
  const providers: Record<string, PiProvider> = {}
  for (const [name, lp] of Object.entries(library.providers)) {
    if (lp.enabled) providers[name] = lp.config
  }
  return { providers }
}

// ---------- 校验与保存 ----------

function validateHeaders(errors: string[], label: string, value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push(`${label}.headers 必须是对象`)
    return
  }
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') errors.push(`${label}.headers[${name}] 必须是字符串`)
  }
}

function validateCompat(errors: string[], label: string, value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push(`${label}.compat 必须是对象`)
    return
  }
  for (const key of [
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
    'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'supportsStrictMode',
    'supportsOpenAIGrammarTools', 'sendSessionAffinityHeaders', 'supportsLongCacheRetention',
    'supportsMaxOutputTokens', 'supportsEagerToolInputStreaming', 'supportsCacheControlOnTools',
    'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
    'supportsMidConvoEffort',
  ]) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') errors.push(`${label}.compat.${key} 必须是布尔值`)
  }
  if (value.maxTokensField !== undefined && (typeof value.maxTokensField !== 'string' || !['max_tokens', 'max_completion_tokens'].includes(value.maxTokensField))) {
    errors.push(`${label}.compat.maxTokensField 必须为 max_tokens 或 max_completion_tokens`)
  }
  for (const key of ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs']) {
    if (value[key] !== undefined && !isRecord(value[key])) errors.push(`${label}.compat.${key} 必须是对象`)
  }
}

function validateModelFields(errors: string[], label: string, model: Record<string, unknown>, override = false): void {
  for (const key of override ? ['name'] : ['name', 'api', 'baseUrl']) {
    if (model[key] !== undefined && (typeof model[key] !== 'string' || !model[key].trim())) {
      errors.push(`${label}.${key} 必须是非空字符串`)
    }
  }
  if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') errors.push(`${label}.reasoning 必须是布尔值`)
  if (model.input !== undefined && (!Array.isArray(model.input) || model.input.some((input) => input !== 'text' && input !== 'image'))) {
    errors.push(`${label}.input 必须是仅包含 text / image 的数组`)
  }
  for (const key of ['contextWindow', 'maxTokens']) {
    const value = model[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      errors.push(`${label}.${key} 必须是大于 0 的有效数字；使用默认值请留空`)
    }
  }
  if (model.thinkingLevelMap !== undefined) {
    if (!isRecord(model.thinkingLevelMap)) errors.push(`${label}.thinkingLevelMap 必须是对象`)
    else {
      for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        const value = model.thinkingLevelMap[level]
        if (value !== undefined && value !== null && typeof value !== 'string') {
          errors.push(`${label}.thinkingLevelMap.${level} 必须是字符串或 null`)
        }
      }
    }
  }
  if (model.samplingParams !== undefined && !isRecord(model.samplingParams)) errors.push(`${label}.samplingParams 必须是对象`)
  if (model.promptCache !== undefined) {
    if (!isRecord(model.promptCache)) errors.push(`${label}.promptCache 必须是对象`)
    else for (const tier of ['short', 'long']) {
      const value = model.promptCache[tier]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
        errors.push(`${label}.promptCache.${tier} 必须是大于 0 的有效秒数`)
      }
    }
  }
  if (model.inputLimits !== undefined) {
    if (!isRecord(model.inputLimits)) errors.push(`${label}.inputLimits 必须是对象`)
    else {
      const limits = model.inputLimits
      const images = limits.images
      const resize = isRecord(images) ? images.resize : undefined
      if (images !== undefined && !isRecord(images)) errors.push(`${label}.inputLimits.images 必须是对象`)
      if (resize !== undefined && !isRecord(resize)) errors.push(`${label}.inputLimits.images.resize 必须是对象`)
      const fields: [string, unknown, number?][] = [
        ['maxRequestBytes', limits.maxRequestBytes],
        ...isRecord(images) ? [
          ['images.maxPerMessage', images.maxPerMessage] as [string, unknown],
          ['images.maxPerRequest', images.maxPerRequest] as [string, unknown],
        ] : [],
        ...isRecord(resize) ? [
          ['images.resize.maxWidth', resize.maxWidth] as [string, unknown],
          ['images.resize.maxHeight', resize.maxHeight] as [string, unknown],
          ['images.resize.maxBytes', resize.maxBytes] as [string, unknown],
          ['images.resize.jpegQuality', resize.jpegQuality, 100] as [string, unknown, number],
        ] : [],
      ]
      for (const [key, value, max] of fields) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max))) {
          errors.push(`${label}.inputLimits.${key} 必须是${max ? ` 1–${max} 范围内的` : ''}正整数`)
        }
      }
    }
  }
  validateHeaders(errors, label, model.headers)
  validateCompat(errors, label, model.compat)
  validateCost(errors, label, model.cost, override)
}

export function validate(library: PiLibrary): string[] {
  const errs: string[] = []
  if (!isRecord(library) || !isRecord(library.providers)) {
    return ['本地库结构异常：缺少 providers 对象']
  }
  for (const [name, lp] of Object.entries(library.providers)) {
    if (!name.trim()) errs.push('存在名称为空的 provider')
    // 键为「__proto__」的赋值会触发原型 setter（变成设原型而非写入），持久化前显式拒绝
    if (name === '__proto__') errs.push(`provider 名称不能为保留键「__proto__」`)
    // 残缺条目（如直接调 /api/save 提交的结构）：报校验错误而不是抛 TypeError 变 500
    if (!isRecord(lp) || !isRecord(lp.config)) {
      errs.push(`provider「${name}」条目缺少 config 对象`)
      continue
    }
    if (typeof lp.enabled !== 'boolean') errs.push(`provider「${name}」的 enabled 必须是布尔值`)
    const config = lp.config
    const label = `provider「${name}」`
    for (const key of ['name', 'api', 'baseUrl', 'apiKey']) {
      const value = config[key]
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) errs.push(`${label}.${key} 必须是非空字符串`)
    }
    if (config.authHeader !== undefined && typeof config.authHeader !== 'boolean') errs.push(`${label}.authHeader 必须是布尔值`)
    if (config.oauth !== undefined && config.oauth !== 'radius') errs.push(`${label}.oauth 仅支持 radius`)
    if (config.oauth !== undefined && !config.baseUrl) errs.push(`${label} 配置 oauth 时必须提供 baseUrl`)
    validateHeaders(errs, label, config.headers)
    validateCompat(errs, label, config.compat)
    if (config.modelOverrides !== undefined) {
      if (!isRecord(config.modelOverrides)) errs.push(`${label}.modelOverrides 必须是对象`)
      else for (const [id, override] of Object.entries(config.modelOverrides)) {
        const overrideLabel = `${label}.modelOverrides[${id}]`
        if (!isRecord(override)) errs.push(`${overrideLabel} 必须是对象`)
        else validateModelFields(errs, overrideLabel, override, true)
      }
    }
    if (config.models !== undefined && !Array.isArray(config.models)) {
      errs.push(`provider「${name}」的 models 不是数组`)
      continue
    }
    if (!config.models?.length && !config.baseUrl && !config.headers && !config.compat &&
      !Object.keys(config.modelOverrides ?? {}).length && !config.apiKey && !config.oauth && config.authHeader === undefined) {
      errs.push(`${label} 需要至少一项模型、地址、认证或覆盖配置`)
    }
    const seen = new Set<string>()
    for (const [index, m] of (config.models ?? []).entries()) {
      if (!isRecord(m)) {
        errs.push(`provider「${name}」下有模型条目不是对象`)
        continue
      }
      const modelLabel = typeof m.id === 'string' && m.id.trim()
        ? `provider「${name}」下模型「${m.id}」`
        : `provider「${name}」下第 ${index + 1} 个模型`
      if (typeof m.id !== 'string' || !m.id.trim()) {
        errs.push(`provider「${name}」下模型 id 必须是非空字符串`)
      } else if (seen.has(m.id)) {
        errs.push(`provider「${name}」下模型 id 重复：${m.id}`)
      } else {
        seen.add(m.id)
      }
      // api / baseUrl 省略时可能由 pi 的内置模型或扩展提供；不凭本地库猜测外部注册结果。
      validateModelFields(errs, modelLabel, m)
    }
  }
  return errs
}

// settings 三方合并：pi CLI 运行时会自写 settings.json（如 lastChangelogVersion、主题切换），
// 页面打开期间磁盘内容可能已变，直接用本端快照整包覆盖会静默丢字段。
// baseline = 本端上次见到的磁盘内容；规则：用户相对 baseline 改过的键（含增删）以用户为准，
// 未改过的键保留磁盘上的外部变更（外部删除同样生效）。
function mergeSettings(
  user: PiSettings,
  baseline: PiSettings | undefined,
  disk: PiSettings,
): { settings: PiSettings; externalKeys: string[] } {
  // 未提供基线（旧客户端/手工调 API）：无从判断外部变更，维持整包覆盖旧行为
  if (!baseline) return { settings: user, externalKeys: [] }
  const keys = new Set([...Object.keys(baseline), ...Object.keys(user), ...Object.keys(disk)])
  // null 原型对象构建：JSON 中出现「__proto__」键时普通赋值会触发原型 setter（原型污染）
  const out: Record<string, unknown> = Object.create(null)
  const externalKeys: string[] = []
  for (const key of keys) {
    const u = (user as Record<string, unknown>)[key]
    const b = (baseline as Record<string, unknown>)[key]
    const d = (disk as Record<string, unknown>)[key]
    if (jsonEq(u, b)) {
      // 用户未改该键：保留磁盘外部值（外部删除也生效）
      if (d !== undefined) out[key] = d
      if (!jsonEq(d, b)) externalKeys.push(key)
    } else if (u !== undefined) {
      // 用户改过（含显式删除）：以用户为准
      out[key] = u
    }
  }
  // 回到普通对象：null 原型对象直接返回会给调用方带来意外行为
  return { settings: JSON.parse(JSON.stringify(out)) as PiSettings, externalKeys }
}

function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function writeConfigFiles(
  dir: string,
  files: { name: string; before: string | null; after: string }[],
): SaveResult {
  const token = `${process.pid}-${randomUUID()}`
  const pending = files.map((file) => ({
    ...file,
    path: join(dir, file.name),
    staged: `${join(dir, file.name)}.tmp-${token}`,
    backup: `${join(dir, file.name)}.bak-${token}`,
  }))
  const written: string[] = []
  const errors: string[] = []
  try {
    // 所有新内容与原始备份准备完成后才替换正式文件；磁盘满时不会提前改动其中一个配置。
    for (const file of pending) {
      writeFileSync(file.staged, file.after, { encoding: 'utf-8', mode: 0o600 })
      if (file.before !== null) writeFileSync(file.backup, file.before, { encoding: 'utf-8', mode: 0o600 })
    }
    for (const file of pending) {
      renameSync(file.staged, file.path)
      written.push(file.name)
    }
  } catch (e) {
    errors.push(`写入失败：${(e as Error).message}`)
    // 反向恢复已经替换的文件；rename 备份不需要再次写入完整内容，适用于磁盘空间不足。
    for (const file of [...pending].reverse()) {
      if (!written.includes(file.name)) continue
      try {
        if (file.before === null) unlinkSync(file.path)
        else renameSync(file.backup, file.path)
        written.splice(written.indexOf(file.name), 1)
      } catch (rollbackError) {
        const recovery = file.before === null ? `原文件不存在：${file.path}` : `原始备份保留在 ${file.backup}`
        errors.push(`回滚 ${file.name} 失败：${(rollbackError as Error).message}；${recovery}`)
      }
    }
  }
  const cleanupErrors: string[] = []
  for (const file of pending) {
    // 回滚失败的备份必须保留，供恢复权限后人工恢复；清理错误不改变已完成的保存结果。
    const cleanup = [file.staged]
    if (!errors.length || !written.includes(file.name)) cleanup.push(file.backup)
    for (const path of cleanup) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (e) {
        cleanupErrors.push(`${path}：${(e as Error).message}`)
      }
    }
  }
  if (cleanupErrors.length) console.warn('配置临时文件清理失败：', cleanupErrors.join('；'))
  if (errors.length) console.error('配置保存失败：', errors.join('；'))
  return { ok: errors.length === 0, errors, written }
}

export function saveAll(
  library: PiLibrary,
  settings: PiSettings,
  settingsBaseline?: PiSettings,
  revision?: string,
): SaveResult {
  // 后端是最后一道防线：即使旧客户端或手工 API 提交部分 cost，也只写出 Pi 可加载的完整结构。
  const normalizedLibrary = clone(library)
  normalizeLibraryCosts(normalizedLibrary)
  const errors = validate(normalizedLibrary)
  if (errors.length) return { ok: false, errors, written: [] }
  const dir = agentDir()
  try {
    const before = CONFIG_FILES.map((name) => {
      const file = join(dir, name)
      return existsSync(file) ? readFileSync(file, 'utf-8') : null
    })
    if (!revision || revision !== configRevision(before)) {
      return { ok: false, conflict: true, errors: ['配置已被外部修改或页面版本已过期，请重新加载后再保存。'], written: [] }
    }
    // 先算 settings 合并结果再写盘：settings.json 若被外部写坏（非法 JSON），
    // 在任何文件落盘前失败，保持「解析失败阻断一切写入」的约定
    const diskSettings = parseJson<PiSettings>(before[2], SETTINGS_FILE) ?? {}
    if (!isRecord(diskSettings)) throw new Error(`${SETTINGS_FILE} 结构异常：必须是对象`)
    const merged = mergeSettings(settings, settingsBaseline, diskSettings)
    const after = [serialize(normalizedLibrary), serialize(projectModels(normalizedLibrary)), serialize(merged.settings)]
    mkdirSync(join(dir, LIBRARY_DIR), { recursive: true })
    const result = writeConfigFiles(dir, CONFIG_FILES.map((name, index) => ({ name, before: before[index], after: after[index] })))
    if (!result.ok) return result
    return {
      ...result,
      revision: configRevision(after),
      settings: merged.settings,
      externalSettingsKeys: merged.externalKeys,
    }
  } catch (e) {
    return { ok: false, errors: [`写入失败：${(e as Error).message}`], written: [] }
  }
}

// 供后端其他模块使用
export { agentDir, readJson, clone, projectModels }
