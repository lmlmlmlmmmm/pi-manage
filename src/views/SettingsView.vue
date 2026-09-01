<script setup lang="ts">
import { computed } from 'vue'
import { usePiStore } from '../stores/pi'
import { THINKING_LEVELS } from '../types'

const store = usePiStore()

// settings 字段直接绑定 store：改动自动保存（防抖后写盘），无需手动保存

const providerOptions = computed(() => store.providerNames.map((n) => ({ label: n, value: n })))

// 模型候选随 defaultProvider 联动；按库全量（含未启用项，但选择未启用的默认 provider 会有警告）
const modelOptions = computed(() => {
  const dp = store.settingsData.defaultProvider
  const lp = dp ? store.library.providers[dp] : undefined
  if (lp) {
    return (lp.config.models ?? []).map((m) => ({
      label: m.name ? `${m.id} · ${m.name}` : m.id,
      value: m.id,
    }))
  }
  return []
})

const thinkingLevelOptions = THINKING_LEVELS.map((l) => ({ label: l, value: l }))

function onProviderChange(v: string | null) {
  // n-select 清空时返回 null，settings 中应删除键而不是写成 null
  if (v === null) delete store.settingsData.defaultProvider
  else store.settingsData.defaultProvider = v
}

function onModelChange(v: string | null) {
  if (v === null) delete store.settingsData.defaultModel
  else store.settingsData.defaultModel = v
}

function onThinkingLevelChange(v: string | null) {
  if (v === null) delete store.settingsData.defaultThinkingLevel
  else store.settingsData.defaultThinkingLevel = v
}

// 默认模型一致性提醒：不在 models.json 中时（可能是内置模型）不阻塞保存，仅提示
const defaultWarning = computed(() => {
  const dp = store.settingsData.defaultProvider
  const dm = store.settingsData.defaultModel
  if (!dp || !dm) return ''
  const lp = store.library.providers[dp]
  if (!lp) {
    return `默认 provider「${dp}」不在本地库中（可能是 pi 内置 provider），保存时将原样保留。`
  }
  if (!lp.enabled) {
    return `默认 provider「${dp}」当前未启用，不会写入 models.json，pi 将无法使用该默认模型。`
  }
  const ids = (lp.config.models ?? []).map((m) => m.id)
  if (!ids.includes(dm)) {
    return `默认模型「${dm}」不在 provider「${dp}」的模型列表中（可能是内置模型），保存时将原样保留。`
  }
  return ''
})

// 未识别的 settings 字段（如 lastChangelogVersion）保存时原样保留
const KNOWN_SETTINGS_KEYS = new Set([
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'hideThinkingBlock',
  'theme',
  'skills',
])
const unknownCount = computed(
  () => Object.keys(store.settingsData).filter((k) => !KNOWN_SETTINGS_KEYS.has(k)).length,
)

// ---------- skills 目录列表：直接按索引读写 store，保证脏状态即时生效 ----------

function skillAt(i: number): string {
  return store.settingsData.skills?.[i] ?? ''
}

function setSkill(i: number, v: string) {
  ;(store.settingsData.skills ??= [])[i] = v
}

function removeSkill(i: number) {
  store.settingsData.skills?.splice(i, 1)
}

function addSkill() {
  ;(store.settingsData.skills ??= []).push('')
}
</script>

<template>
  <div class="page">
    <n-alert v-if="defaultWarning" type="warning" :show-icon="true">{{ defaultWarning }}</n-alert>

    <n-card title="默认模型" size="small">
      <n-form label-placement="left" label-width="170" size="small">
        <n-form-item label="defaultProvider">
          <n-select
            :value="store.settingsData.defaultProvider ?? null"
            :options="providerOptions"
            filterable
            tag
            clearable
            placeholder="选择或输入（内置 provider 可手动输入）"
            @update:value="onProviderChange"
          />
        </n-form-item>
        <n-form-item label="defaultModel">
          <n-select
            :value="store.settingsData.defaultModel ?? null"
            :options="modelOptions"
            filterable
            tag
            clearable
            placeholder="选择或输入模型 id"
            @update:value="onModelChange"
          />
        </n-form-item>
        <n-form-item label="defaultThinkingLevel">
          <n-select
            :value="store.settingsData.defaultThinkingLevel ?? null"
            :options="thinkingLevelOptions"
            clearable
            placeholder="未设置"
            @update:value="onThinkingLevelChange"
          />
        </n-form-item>
      </n-form>
    </n-card>

    <n-card title="界面与输出" size="small">
      <n-form label-placement="left" label-width="170" size="small">
        <n-form-item label="hideThinkingBlock">
          <n-switch v-model:value="store.settingsData.hideThinkingBlock" />
          <span class="muted" style="margin-left: 10px; font-size: 12px">隐藏思考过程输出</span>
        </n-form-item>
        <n-form-item label="theme">
          <n-input
            :value="store.settingsData.theme ?? ''"
            placeholder="dark / light / tokyo-night/tokyo-night"
            @update:value="(v: string) => (store.settingsData.theme = v || undefined)"
          />
        </n-form-item>
      </n-form>
    </n-card>

    <n-card title="skills 目录" size="small">
      <div v-for="i in store.settingsData.skills?.length ?? 0" :key="i" class="skill-row">
        <n-input :value="skillAt(i - 1)" class="mono" placeholder="绝对路径或相对 ~/.pi/agent 的路径" @update:value="(v: string) => setSkill(i - 1, v)" />
        <n-button size="small" quaternary type="error" @click="removeSkill(i - 1)">移除</n-button>
      </div>
      <n-button size="small" dashed style="width: 100%" @click="addSkill">+ 添加目录</n-button>
    </n-card>

    <p class="page-hint muted">另有 {{ unknownCount }} 个未识别的 settings 字段会在写入时原样保留。</p>
  </div>
</template>
