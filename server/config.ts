// 后端核心：pi 配置的本地库 / models.json / settings.json 读写与业务逻辑。
// 前端只保留编辑状态，保存时整包提交到这里落盘；本模块拥有完整文件系统权限，
// 定位 ~/.pi/agent（或 PI_CODING_AGENT_DIR），不再受浏览器沙箱限制。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PiLibrary, PiModelsFile, PiProvider, PiSettings, ProviderDiff, SaveResult } from '../src/types.js'

const MODELS_FILE = 'models.json'
const SETTINGS_FILE = 'settings.json'
const LIBRARY_DIR = '.pi-manage'
const LIBRARY_FILE = 'providers.json'

export interface LoadedState {
  library: PiLibrary
  settings: PiSettings
  diffs: ProviderDiff[]
  warnings: string[]
  piDir: string
}

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  if (env && env.trim()) return env.trim()
  return join(homedir(), '.pi', 'agent')
}

function readJson<T>(file: string, label: string): T | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
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

function validateCost(errors: string[], modelLabel: string, value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push(`${modelLabel}的 cost 必须是对象`)
    return
  }
  for (const key of COST_RATE_KEYS) {
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
  const models = readJson<PiModelsFile>(join(dir, MODELS_FILE), MODELS_FILE) ?? { providers: {} }
  if (
    typeof models !== 'object' ||
    typeof models.providers !== 'object' ||
    models.providers === null ||
    Array.isArray(models.providers)
  ) {
    throw new Error(`${MODELS_FILE} 结构异常：缺少 providers 对象`)
  }
  // 逐条校验 provider 值：null/非对象会让下方差异检测与首次导入直接 TypeError
  for (const [name, config] of Object.entries(models.providers)) {
    if (typeof config !== 'object' || config === null) {
      throw new Error(`${MODELS_FILE} 中 provider「${name}」的配置不是对象`)
    }
  }
  const modelsCostRepairs = normalizeProviderCosts(models.providers)
  const settings = readJson<PiSettings>(join(dir, SETTINGS_FILE), SETTINGS_FILE) ?? {}

  const libFile = join(dir, LIBRARY_DIR, LIBRARY_FILE)
  let library: PiLibrary
  let libraryCostRepairs = 0
  const warnings: string[] = []
  const diffs: ProviderDiff[] = []

  if (!existsSync(libFile)) {
    // 首次运行：把现有 models.json 全量导入库，全部启用；库文件直接落盘
    const providers: PiLibrary['providers'] = {}
    for (const [name, config] of Object.entries(models.providers)) {
      providers[name] = { enabled: true, config }
    }
    library = { providers }
    mkdirSync(join(dir, LIBRARY_DIR), { recursive: true })
    writeFileAtomic(libFile, serialize(library))
  } else {
    library = readJson<PiLibrary>(libFile, `${LIBRARY_DIR}/${LIBRARY_FILE}`) ?? { providers: {} }
    // 库文件损坏时报可定位的错误（对齐 models.json 的处理），而不是后续流程里的 TypeError
    if (
      typeof library !== 'object' ||
      typeof library.providers !== 'object' ||
      library.providers === null ||
      Array.isArray(library.providers)
    ) {
      throw new Error(`${LIBRARY_DIR}/${LIBRARY_FILE} 结构异常：缺少 providers 对象`)
    }
    for (const [name, lp] of Object.entries(library.providers)) {
      if (typeof lp !== 'object' || lp === null || typeof lp.config !== 'object' || lp.config === null) {
        throw new Error(`${LIBRARY_DIR}/${LIBRARY_FILE} 中 provider「${name}」条目缺少 config 对象`)
      }
    }
    libraryCostRepairs = normalizeLibraryCosts(library)
    if (libraryCostRepairs > 0) writeFileAtomic(libFile, serialize(library))
    // 双向差异检测（对齐 pi-switch 同步语义）
    for (const [name, config] of Object.entries(models.providers)) {
      if (!(name in library.providers)) {
        diffs.push({ kind: 'external-added', name, modelCount: config.models?.length ?? 0, config: clone(config) })
      }
    }
    for (const [name, lp] of Object.entries(library.providers)) {
      if (lp.enabled && !(name in models.providers)) {
        diffs.push({ kind: 'external-removed', name, modelCount: lp.config.models?.length ?? 0 })
      }
    }
  }

  if (modelsCostRepairs > 0) writeFileAtomic(join(dir, MODELS_FILE), serialize(models))
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

  return { library, settings, diffs, warnings, piDir: dir }
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
    if (typeof lp !== 'object' || lp === null || typeof lp.config !== 'object' || lp.config === null) {
      errs.push(`provider「${name}」条目缺少 config 对象`)
      continue
    }
    if (lp.config.models !== undefined && !Array.isArray(lp.config.models)) {
      errs.push(`provider「${name}」的 models 不是数组`)
      continue
    }
    const seen = new Set<string>()
    for (const [index, m] of (lp.config.models ?? []).entries()) {
      if (typeof m !== 'object' || m === null) {
        errs.push(`provider「${name}」下有模型条目不是对象`)
        continue
      }
      const modelLabel = m.id && String(m.id).trim()
        ? `provider「${name}」下模型「${String(m.id)}」`
        : `provider「${name}」下第 ${index + 1} 个模型`
      if (!m.id || !String(m.id).trim()) {
        errs.push(`provider「${name}」下有模型缺少 id`)
      } else if (seen.has(m.id)) {
        errs.push(`provider「${name}」下模型 id 重复：${m.id}`)
      } else {
        seen.add(m.id)
      }
      validateCost(errs, modelLabel, m.cost)
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
  settingsFile: string,
): { settings: PiSettings; externalKeys: string[] } {
  // 未提供基线（旧客户端/手工调 API）：无从判断外部变更，维持整包覆盖旧行为
  if (!baseline) return { settings: user, externalKeys: [] }
  const disk = readJson<PiSettings>(settingsFile, SETTINGS_FILE) ?? {}
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

export function saveAll(library: PiLibrary, settings: PiSettings, settingsBaseline?: PiSettings): SaveResult {
  // 后端是最后一道防线：即使旧客户端或手工 API 提交部分 cost，也只写出 Pi 可加载的完整结构。
  const normalizedLibrary = clone(library)
  normalizeLibraryCosts(normalizedLibrary)
  const errors = validate(normalizedLibrary)
  if (errors.length) return { ok: false, errors, written: [] }
  const dir = agentDir()
  const written: string[] = []
  try {
    // 先算 settings 合并结果再写盘：settings.json 若被外部写坏（非法 JSON），
    // 在任何文件落盘前失败，保持「解析失败阻断一切写入」的约定
    const merged = mergeSettings(settings, settingsBaseline, join(dir, SETTINGS_FILE))
    mkdirSync(join(dir, LIBRARY_DIR), { recursive: true })
    writeFileAtomic(join(dir, LIBRARY_DIR, LIBRARY_FILE), serialize(normalizedLibrary))
    written.push(`${LIBRARY_DIR}/${LIBRARY_FILE}`)
    writeFileAtomic(join(dir, MODELS_FILE), serialize(projectModels(normalizedLibrary)))
    written.push(MODELS_FILE)
    writeFileAtomic(join(dir, SETTINGS_FILE), serialize(merged.settings))
    written.push(SETTINGS_FILE)
    return {
      ok: true,
      errors: [],
      written,
      settings: merged.settings,
      externalSettingsKeys: merged.externalKeys,
    }
  } catch (e) {
    return { ok: false, errors: [`写入失败：${(e as Error).message}`], written }
  }
}

// 供后端其他模块使用
export { agentDir, readJson, clone, projectModels }
