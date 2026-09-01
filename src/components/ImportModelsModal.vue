<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { formatTokens } from '../lib/format'
import type { FetchedModel, PiProvider } from '../types'

const props = defineProps<{
  show: boolean
  providerName: string
  provider: PiProvider | null
  existingIds: string[]
  // 单选模式：用于模型表单「在线导入」——选一个模型填充当前表单；
  // 默认多选模式：用于批量导入
  single?: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  imported: [models: FetchedModel[]]
}>()

const state = reactive({
  baseUrl: '',
  apiKey: '',
  items: null as FetchedModel[] | null,
  checked: new Set<string>(),
  loading: false,
  error: '',
})

watch(
  () => props.show,
  (show) => {
    if (!show) return
    const p = props.provider
    state.baseUrl = p?.baseUrl ?? ''
    state.apiKey = p?.apiKey ?? ''
    state.items = null
    state.checked = new Set()
    state.loading = false
    state.error = ''
  },
)

function close() {
  emit('update:show', false)
}

// 已存在 id 建 Set：列表每行都调 isExisting，数组 includes 是 O(n²)
const existingSet = computed(() => new Set(props.existingIds))

function isExisting(id: string): boolean {
  return existingSet.value.has(id)
}

function toggle(id: string, v: boolean) {
  if (props.single) {
    // 单选：勾选即清掉其他，只保留当前项
    state.checked = v ? new Set([id]) : new Set()
  } else if (v) {
    state.checked.add(id)
  } else {
    state.checked.delete(id)
  }
}

async function fetchList() {
  if (!state.baseUrl.trim()) {
    state.error = '请填写 baseUrl'
    return
  }
  state.loading = true
  state.error = ''
  try {
    // 由本机后端代发：Node 端可完整发送 provider 自定义 headers（含 User-Agent），无 CORS 限制；
    // 元数据（上下文/价格/图像/thinkingLevelMap）由后端用 models.dev 补全
    const res = await fetch('/api/models/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // API 协议随 provider 走（决定端点和认证头），弹窗不再展示该字段
        api: props.provider?.api ?? 'openai-completions',
        baseUrl: state.baseUrl.trim(),
        apiKey: state.apiKey.trim(),
        headers: props.provider?.headers ?? {},
      }),
    })
    const data = (await res.json()) as { models?: FetchedModel[]; error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    const models = data.models ?? []
    state.items = models
    // 默认全部不选，由用户自行勾选
    state.checked = new Set()
    if (models.length === 0) state.error = '接口返回了 0 个模型'
  } catch (e) {
    state.items = null
    state.error = (e as Error).message
  } finally {
    state.loading = false
  }
}

// 列表项右侧的元数据摘要：1.05M · $3/$12
function metaSummary(m: FetchedModel): string {
  const parts: string[] = []
  if (m.contextWindow) parts.push(formatTokens(m.contextWindow))
  if (m.cost?.input !== undefined || m.cost?.output !== undefined) {
    parts.push(`$${m.cost?.input ?? 0}/$${m.cost?.output ?? 0}`)
  }
  return parts.join(' · ')
}

// 全选/取消全选（仅多选模式；单选模式由用户点选）
function selectAll() {
  state.checked = new Set((state.items ?? []).filter((m) => !isExisting(m.id)).map((m) => m.id))
}

function clearAll() {
  state.checked = new Set()
}

function doImport() {
  const picked = (state.items ?? []).filter((m) => state.checked.has(m.id))
  if (!picked.length) return
  emit('imported', picked)
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="`获取模型 · ${props.providerName}`"
    :style="{ width: '620px' }"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="top" size="small">
      <n-form-item label="baseUrl">
        <n-input v-model:value="state.baseUrl" class="mono" placeholder="https://example.com/v1" :disabled="state.loading" />
      </n-form-item>
      <n-form-item label="API Key">
        <n-input
          v-model:value="state.apiKey"
          type="password"
          show-password-on="click"
          placeholder="留空则匿名请求"
          :disabled="state.loading"
        />
      </n-form-item>
    </n-form>

    <div class="im-toolbar">
      <n-button size="small" type="primary" :loading="state.loading" @click="fetchList">获取模型列表</n-button>
      <template v-if="state.items && !props.single">
        <n-button size="small" secondary @click="selectAll">全选</n-button>
        <n-button size="small" secondary @click="clearAll">取消</n-button>
      </template>
      <span v-if="state.items" class="muted" style="font-size: 12px">
        共 {{ state.items.length }} 个，已选 {{ state.checked.size }}
      </span>
    </div>

    <n-alert v-if="state.error" type="error" :show-icon="false" style="margin-top: 10px">{{ state.error }}</n-alert>

    <div v-if="state.items && state.items.length" class="im-list">
      <label v-for="m in state.items" :key="m.id" class="im-item" :class="{ exists: isExisting(m.id) }">
        <n-radio
          v-if="props.single"
          :checked="state.checked.has(m.id)"
          :disabled="isExisting(m.id)"
          @update:checked="(v: boolean) => toggle(m.id, v)"
        />
        <n-checkbox
          v-else
          :checked="state.checked.has(m.id)"
          :disabled="isExisting(m.id)"
          @update:checked="(v: boolean) => toggle(m.id, v)"
        />
        <span class="mono im-item-id">{{ m.id }}</span>
        <span v-if="m.name && m.name !== m.id" class="muted im-item-name">{{ m.name }}</span>
        <span class="muted im-item-meta">{{ metaSummary(m) }}</span>
        <n-tag v-if="m.inputImage" size="tiny" :bordered="false">图像</n-tag>
        <n-tag v-if="isExisting(m.id)" size="tiny" :bordered="false">已存在</n-tag>
      </label>
    </div>
    <n-empty v-else-if="state.items && !state.items.length" description="接口未返回模型" size="small" style="margin-top: 16px" />

    <template #footer>
      <div class="form-footer-actions">
        <n-button size="small" @click="close">取消</n-button>
        <n-button size="small" type="primary" :disabled="state.checked.size === 0" @click="doImport">
          {{ props.single ? '使用此模型' : `导入${state.checked.size ? ` ${state.checked.size} 个` : ''}` }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
