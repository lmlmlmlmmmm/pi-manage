import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppConfig, PiLibrary, PiModel, PiModelsFile, PiProvider, PiSettings, ProviderDiff, SaveResult } from '../types'

// 连接阶段：
// loading   正在从本机后端拉取配置
// ready     可以管理
// error     后端不可达或配置读取失败
export type Phase = 'loading' | 'ready' | 'error'

function serialize(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

// 自动保存防抖间隔：改动后静置 800ms 再提交，避免连续操作逐次写盘
const AUTO_SAVE_DELAY = 800

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const usePiStore = defineStore('pi', () => {
  const phase = ref<Phase>('loading')
  const error = ref('')
  const piDir = ref('')

  // 本地库是唯一数据源：完整 provider 数据 + enabled 标记
  const library = ref<PiLibrary>({ providers: {} })
  const settingsData = ref<PiSettings>({})

  // models.json 是「已启用子集」的投影，由 library 派生
  const modelsData = computed<PiModelsFile>(() => {
    const providers: Record<string, PiProvider> = {}
    for (const [name, lp] of Object.entries(library.value.providers)) {
      if (lp.enabled) providers[name] = lp.config
    }
    return { providers }
  })

  // 序列化快照：保存成功后更新，用于「未保存」判脏
  const librarySnapshot = ref('')
  const modelsSnapshot = ref('')
  const settingsSnapshot = ref('')

  // settings 合并基线：本端最后一次确认的磁盘 settings（load 读取或上次保存的合并结果）。
  // 保存时随请求提交，后端与磁盘三方合并，避免覆盖 pi CLI 在页面打开期间写入的字段。
  // 必须与 settingsData 保持不同对象引用，否则用户编辑会连带改掉基线导致外部变更检测失效
  const settingsBaseline = ref<PiSettings>({})

  // 后端加载时算出的差异/警告
  const warnings = ref<string[]>([])
  const diffs = ref<ProviderDiff[]>([])

  const activeTab = ref<'providers' | 'proxy' | 'settings'>('providers')
  const selectedProvider = ref<string | null>(null)

  // ---------- 应用配置（代理等，独立于 pi 配置，即存即生效不走「保存」按钮） ----------

  const appConfig = ref<AppConfig>({})
  const proxySaving = ref(false)

  async function loadAppConfig(): Promise<void> {
    try {
      appConfig.value = await api<AppConfig>('/api/proxy')
    } catch {
      // 代理配置读取失败不阻断主流程：默认无代理
      appConfig.value = {}
    }
  }

  // 保存代理：后端写文件 + 同步进程环境变量，当前进程立即生效
  async function saveProxy(
    proxy: string,
    proxyUsername = '',
    proxyPassword = '',
  ): Promise<{ ok: boolean; error?: string }> {
    proxySaving.value = true
    try {
      appConfig.value = await api<AppConfig>('/api/proxy', {
        method: 'POST',
        body: JSON.stringify({ proxy, proxyUsername, proxyPassword }),
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      proxySaving.value = false
    }
  }

  // ---------- 连接与读取 ----------

  async function load(): Promise<void> {
    phase.value = 'loading'
    try {
      const state = await api<{
        library: PiLibrary
        settings: PiSettings
        diffs: ProviderDiff[]
        warnings: string[]
        piDir: string
      }>('/api/config')
      library.value = state.library
      settingsData.value = state.settings
      settingsBaseline.value = clone(state.settings)
      warnings.value = state.warnings
      diffs.value = state.diffs
      piDir.value = state.piDir
      librarySnapshot.value = serialize(library.value)
      modelsSnapshot.value = serialize(modelsData.value)
      settingsSnapshot.value = serialize(settingsData.value)
      if (!selectedProvider.value || !(selectedProvider.value in library.value.providers)) {
        selectedProvider.value = Object.keys(library.value.providers)[0] ?? null
      }
      error.value = ''
      phase.value = 'ready'
      void loadAppConfig()
    } catch (e) {
      phase.value = 'error'
      error.value = (e as Error).message
    }
  }

  function init(): void {
    void load()
  }

  async function reload(): Promise<void> {
    await load()
  }

  // ---------- 派生状态 ----------

  const libraryDirty = computed(() => phase.value === 'ready' && serialize(library.value) !== librarySnapshot.value)
  const modelsDirty = computed(() => phase.value === 'ready' && serialize(modelsData.value) !== modelsSnapshot.value)
  const settingsDirty = computed(
    () => phase.value === 'ready' && serialize(settingsData.value) !== settingsSnapshot.value,
  )
  const dirty = computed(() => libraryDirty.value || modelsDirty.value || settingsDirty.value)

  const providerNames = computed(() => Object.keys(library.value.providers))
  const enabledProviderCount = computed(
    () => Object.values(library.value.providers).filter((lp) => lp.enabled).length,
  )
  const totalModels = computed(() =>
    providerNames.value.reduce((n, k) => n + (library.value.providers[k].config.models?.length ?? 0), 0),
  )

  // ---------- Provider CRUD（本地编辑，保存时提交后端） ----------

  function addProvider(name: string, provider: PiProvider): void {
    library.value.providers[name] = { enabled: true, config: provider }
    selectedProvider.value = name
  }

  function updateProvider(oldName: string, newName: string, provider: PiProvider): void {
    const providers = library.value.providers
    if (oldName === newName) {
      providers[oldName].config = provider
      return
    }
    if (newName in providers) throw new Error(`已存在同名 provider：${newName}`)
    const next: PiLibrary['providers'] = {}
    for (const [k, v] of Object.entries(providers)) {
      next[k === oldName ? newName : k] = k === oldName ? { ...v, config: provider } : v
    }
    library.value.providers = next
    if (settingsData.value.defaultProvider === oldName) settingsData.value.defaultProvider = newName
    if (selectedProvider.value === oldName) selectedProvider.value = newName
  }

  function deleteProvider(name: string): void {
    delete library.value.providers[name]
    if (settingsData.value.defaultProvider === name) {
      delete settingsData.value.defaultProvider
      delete settingsData.value.defaultModel
    }
    if (selectedProvider.value === name) {
      selectedProvider.value = Object.keys(library.value.providers)[0] ?? null
    }
  }

  function duplicateProvider(name: string): string {
    const src = library.value.providers[name]
    if (!src) throw new Error(`provider 不存在：${name}`)
    const newName = uniqueName(`${name}-copy`, (n) => n in library.value.providers)
    library.value.providers[newName] = { enabled: src.enabled, config: clone(src.config) }
    return newName
  }

  function setProviderEnabled(name: string, enabled: boolean): void {
    const lp = library.value.providers[name]
    if (!lp) throw new Error(`provider 不存在：${name}`)
    lp.enabled = enabled
    if (!enabled && settingsData.value.defaultProvider === name) {
      delete settingsData.value.defaultProvider
      delete settingsData.value.defaultModel
    }
  }

  // 外部新增的 provider 导入到库
  function importExternalProvider(name: string): void {
    const diff = diffs.value.find((d) => d.kind === 'external-added' && d.name === name)
    if (!diff?.config) throw new Error(`没有可导入的外部 provider：${name}`)
    library.value.providers[name] = { enabled: true, config: diff.config }
    diffs.value = diffs.value.filter((d) => d !== diff)
    if (!selectedProvider.value) selectedProvider.value = name
  }

  // 外部移除 → 同步为未启用
  function markExternalRemoved(name: string): void {
    const lp = library.value.providers[name]
    if (!lp) throw new Error(`provider 不存在：${name}`)
    lp.enabled = false
    if (settingsData.value.defaultProvider === name) {
      delete settingsData.value.defaultProvider
      delete settingsData.value.defaultModel
    }
    // 只移除该 provider 的 external-removed 差异项，保留其余（含所有 external-added）
    diffs.value = diffs.value.filter((d) => !(d.kind === 'external-removed' && d.name === name))
  }

  // ---------- Model CRUD ----------

  function addModel(providerName: string, model: PiModel): void {
    const p = library.value.providers[providerName]?.config
    if (!p) throw new Error(`provider 不存在：${providerName}`)
    ;(p.models ??= []).push(model)
  }

  function updateModel(providerName: string, oldId: string, model: PiModel): void {
    const p = library.value.providers[providerName]?.config
    if (!p) throw new Error(`provider 不存在：${providerName}`)
    const idx = p.models?.findIndex((m) => m.id === oldId) ?? -1
    if (idx < 0) throw new Error(`模型不存在：${oldId}`)
    p.models![idx] = model
    if (settingsData.value.defaultProvider === providerName && settingsData.value.defaultModel === oldId) {
      settingsData.value.defaultModel = model.id
    }
  }

  function deleteModel(providerName: string, modelId: string): void {
    const p = library.value.providers[providerName]?.config
    if (!p) throw new Error(`provider 不存在：${providerName}`)
    p.models = (p.models ?? []).filter((m) => m.id !== modelId)
    if (settingsData.value.defaultProvider === providerName && settingsData.value.defaultModel === modelId) {
      delete settingsData.value.defaultModel
    }
  }

  function duplicateModel(providerName: string, modelId: string): string {
    const p = library.value.providers[providerName]?.config
    if (!p) throw new Error(`provider 不存在：${providerName}`)
    const src = (p.models ?? []).find((m) => m.id === modelId)
    if (!src) throw new Error(`模型不存在：${modelId}`)
    const newId = uniqueName(`${modelId}-copy`, (id) => (p.models ?? []).some((m) => m.id === id))
    // 模型 id 是对象内字段（非 provider 那样的键），克隆后必须改写 id，否则会产生同 id 副本
    const copy = clone(src)
    copy.id = newId
    ;(p.models ??= []).push(copy)
    return newId
  }

  function setDefaultModel(providerName: string, modelId: string): void {
    settingsData.value.defaultProvider = providerName
    settingsData.value.defaultModel = modelId
  }

  function uniqueName(base: string, exists: (n: string) => boolean): string {
    if (!exists(base)) return base
    for (let i = 2; ; i++) {
      const n = `${base}-${i}`
      if (!exists(n)) return n
    }
  }

  // ---------- 自动保存（改动后 debounce 提交，无需手动点保存） ----------

  const autoSaveTimer = ref<ReturnType<typeof setTimeout> | null>(null)
  const autoSaving = ref(false)
  // 自动保存失败标记：保留在界面上提醒（每次成功后清除）
  const autoSaveError = ref('')
  const lastAutoSaveAt = ref(0)

  function scheduleAutoSave(): void {
    // 未就绪/正在保存时由保存完成后的 dirty 重查触发
    if (phase.value !== 'ready') return
    if (autoSaveTimer.value) clearTimeout(autoSaveTimer.value)
    autoSaveTimer.value = setTimeout(() => void flushAutoSave(), AUTO_SAVE_DELAY)
  }

  async function flushAutoSave(): Promise<void> {
    if (phase.value !== 'ready' || autoSaving.value || !dirty.value) return
    autoSaving.value = true
    try {
      const r = await saveAll()
      if (!r.ok) {
        autoSaveError.value = r.errors.join('\n')
      } else {
        autoSaveError.value = ''
        lastAutoSaveAt.value = Date.now()
      }
      // 保存期间若又有新改动，再排一次（catch 住中途变更）
      if (dirty.value) scheduleAutoSave()
    } finally {
      autoSaving.value = false
    }
  }

  watch(dirty, (v) => {
    if (v) scheduleAutoSave()
  })

  // 保存：整包提交给后端落盘（库 + 启用投影 models.json + settings 与磁盘三方合并）
  async function saveAll(): Promise<SaveResult> {
    try {
      const result = await api<SaveResult>('/api/save', {
        method: 'POST',
        body: JSON.stringify({
          library: library.value,
          settings: settingsData.value,
          settingsBaseline: settingsBaseline.value,
        }),
      })
      if (result.ok) {
        // 后端返回合并外部变更后的最终 settings：刷新编辑状态与基线，
        // 保证下次保存的合并基准正确、判脏快照一致
        if (result.settings) {
          settingsData.value = result.settings
          settingsBaseline.value = clone(result.settings)
        }
        librarySnapshot.value = serialize(library.value)
        modelsSnapshot.value = serialize(modelsData.value)
        settingsSnapshot.value = serialize(settingsData.value)
      }
      return result
    } catch (e) {
      return { ok: false, errors: [(e as Error).message], written: [] }
    }
  }

  return {
    phase,
    error,
    piDir,
    library,
    modelsData,
    settingsData,
    warnings,
    diffs,
    activeTab,
    selectedProvider,
    appConfig,
    proxySaving,
    loadAppConfig,
    saveProxy,
    libraryDirty,
    modelsDirty,
    settingsDirty,
    dirty,
    providerNames,
    enabledProviderCount,
    totalModels,
    init,
    reload,
    addProvider,
    updateProvider,
    deleteProvider,
    duplicateProvider,
    setProviderEnabled,
    importExternalProvider,
    markExternalRemoved,
    addModel,
    updateModel,
    deleteModel,
    duplicateModel,
    setDefaultModel,
    saveAll,
    autoSaving,
    autoSaveError,
    lastAutoSaveAt,
    flushAutoSave,
  }
})
