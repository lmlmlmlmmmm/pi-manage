<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type ClientUaKind = 'codex' | 'claude'

// 最新 CLI UA 选择器：版本号/UA 由本机后端从 npm 拉取（无 CORS），
// 选中即生成并 emit；父组件负责把生成值写入各自的 User-Agent 行
const props = defineProps<{
  // 当前 User-Agent 值：已有则只替换版本段，保留 OS/其他段
  existing?: string
}>()

const emit = defineEmits<{
  update: [value: string]
}>()

const value = ref<ClientUaKind | null>(null)
const versions = ref<{ codex: string; claude: string }>({ codex: '', claude: '' })
const fetching = ref(false)

async function api(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Record<string, unknown>>
}

// 预拉取两个 CLI 的最新 UA（后端会话内缓存版本号）
async function prefetch() {
  if (fetching.value) return
  fetching.value = true
  try {
    const data = (await api('/api/ua-latest')) as { codex?: string; claude?: string }
    const version = (ua: string | undefined) => ua?.match(/^\S+\/(\S+)/)?.[1] ?? ''
    versions.value.codex = version(data.codex)
    versions.value.claude = version(data.claude)
  } catch {
    // 拉取失败：下拉仍显示「获取版本中…」，不影响表单
  } finally {
    fetching.value = false
  }
}

const options = computed(() => [
  {
    label: versions.value.codex ? `codex（最新 v${versions.value.codex}）` : 'codex（获取版本中…）',
    value: 'codex',
  },
  {
    label: versions.value.claude ? `claude-cli（最新 v${versions.value.claude}）` : 'claude-cli（获取版本中…）',
    value: 'claude',
  },
])

async function onSelect(kind: ClientUaKind | null) {
  if (!kind) return
  value.value = null // 填入后复位，避免停留选中态
  try {
    const data = (await api(`/api/ua-latest?kind=${kind}&existing=${encodeURIComponent(props.existing ?? '')}`)) as {
      ua?: string
    }
    if (data.ua) emit('update', data.ua)
  } catch {
    // 生成失败忽略：下次重试
  }
}

onMounted(() => {
  void prefetch()
})
</script>

<template>
  <n-select
    size="small"
    :value="value"
    :options="options"
    :loading="fetching"
    placeholder="填入最新 CLI UA…"
    style="width: 280px"
    @update:value="onSelect"
  />
</template>
