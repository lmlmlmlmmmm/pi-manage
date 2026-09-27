<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { FetchedModel, PiModel, PiProvider } from '../types'
import { PI_API_OPTIONS } from '../types'
import UaSelect from './UaSelect.vue'
import ImportModelsModal from './ImportModelsModal.vue'
import { isAuthHeader, modelKeyHeaders, readModelApiKey, providerAuthNotice } from '../lib/modelAuth'

const props = defineProps<{
  show: boolean
  // null 表示新增
  providerName: string | null
  initial: PiProvider | null
  existingNames: string[]
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [payload: { originalName: string | null; name: string; provider: PiProvider }]
}>()

const message = useMessage()

interface HeaderRow {
  key: string
  value: string
}

const form = reactive({
  name: '',
  baseUrl: '',
  api: null as string | null,
  apiKey: '',
  authHeader: false,
  headers: [] as HeaderRow[],
  models: [] as PiModel[],
})

// 在线导入弹窗：用表单当前填写的 baseUrl/apiKey/api/headers 拉取模型
const imShow = ref(false)
const authNotice = computed(() => providerAuthNotice({ ...props.initial, apiKey: form.apiKey },
  form.models.some((model) => Object.keys(model.headers ?? {}).some(isAuthHeader))))
const inheritsConnection = computed(() => form.models.some((model) => !(model.api || form.api) || !(model.baseUrl || form.baseUrl.trim())))

// 传给 ImportModelsModal 的临时 provider（表单实时值）
const tempProvider = computed<PiProvider>(() => {
  const headers: Record<string, string> = {}
  for (const h of form.headers) {
    if (h.key.trim()) headers[h.key.trim()] = h.value
  }
  return {
    baseUrl: form.baseUrl,
    api: (form.api ?? undefined) as PiProvider['api'],
    apiKey: form.apiKey,
    authHeader: form.authHeader,
    headers: Object.keys(headers).length ? headers : undefined,
  }
})

// 导入的模型（含元数据）加入表单，保存时一并写入 provider
function onImported(models: FetchedModel[], connection: PiProvider) {
  let headers: Record<string, string> | undefined
  try {
    if (connection.apiKey !== form.apiKey.trim()) {
      headers = modelKeyHeaders({ ...tempProvider.value, api: connection.api }, {}, connection.apiKey ?? '')
    }
  } catch (e) {
    message.error((e as Error).message)
    return
  }
  for (const m of models) {
    if (form.models.some((x) => x.id === m.id)) continue
    const entry: PiModel = { id: m.id }
    // 获取时临时换过地址或密钥，需绑定到本次导入的模型，Provider 默认配置保持独立。
    if (headers) entry.headers = { ...headers }
    if (connection.baseUrl !== form.baseUrl.trim()) entry.baseUrl = connection.baseUrl
    if (connection.api !== form.api) entry.api = connection.api
    if (m.name) entry.name = m.name
    if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow
    if (m.maxTokens !== undefined) entry.maxTokens = m.maxTokens
    if (m.inputImage) entry.input = ['text', 'image']
    if (m.reasoning !== undefined) entry.reasoning = m.reasoning
    if (m.thinkingLevelMap) entry.thinkingLevelMap = m.thinkingLevelMap
    if (m.cost) {
      const rates = [m.cost.input, m.cost.output, m.cost.cacheRead, m.cost.cacheWrite]
      if (rates.some((v) => v !== undefined)) {
        // Pi 0.84.4 要求 cost 出现时四个基础费率全部存在；元数据缺项按 Pi 的默认费率 0 补齐。
        entry.cost = {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0,
        }
      }
    }
    form.models.push(entry)
  }
}

function removeModel(id: string) {
  form.models = form.models.filter((m) => m.id !== id)
}

const error = ref('')

// 当前 User-Agent 值传给 UaSelect，使生成时只替换版本段；回填时写入/新增行
const existingUa = () =>
  form.headers.find((h) => h.key.trim().toLowerCase() === 'user-agent')?.value ?? ''

function applyUa(ua: string) {
  const row = form.headers.find((h) => h.key.trim().toLowerCase() === 'user-agent')
  if (row) row.value = ua
  else form.headers.push({ key: 'User-Agent', value: ua })
}

// 每次打开以磁盘数据重新初始化表单，取消后不留脏状态
watch(
  () => props.show,
  (show) => {
    if (!show) return
    error.value = ''
    const p = props.initial
    form.name = props.providerName ?? ''
    form.baseUrl = p?.baseUrl ?? ''
    form.api = p?.api ?? null
    form.apiKey = p?.apiKey ?? ''
    form.authHeader = p?.authHeader ?? false
    form.headers = Object.entries(p?.headers ?? {}).map(([key, value]) => ({ key, value: String(value) }))
    form.models = (p?.models ?? []).map((m) => JSON.parse(JSON.stringify(m)) as PiModel)
    imShow.value = false
  },
)

function close() {
  emit('update:show', false)
}

function save() {
  const name = form.name.trim()
  if (!name) {
    error.value = 'provider 名称不能为空'
    return
  }
  // 重命名时排除自身，新增时校验全部
  if (props.existingNames.filter((n) => n !== props.providerName).includes(name)) {
    error.value = `已存在同名 provider：${name}`
    return
  }
  // 以原对象为底稿覆盖已知字段：未知字段（oauth、modelOverrides 等）无损保留
  const provider: PiProvider = { ...(props.initial ?? {}) }
  const record = provider as Record<string, unknown>
  const set = (k: string, v: unknown) => {
    if (v === undefined || v === '') delete record[k]
    else record[k] = v
  }
  set('baseUrl', form.baseUrl.trim() || undefined)
  set('api', form.api ?? undefined)
  set('apiKey', form.apiKey.trim() || undefined)
  set('authHeader', form.authHeader || undefined)
  const headers: Record<string, string> = {}
  for (const h of form.headers) {
    if (h.key.trim()) headers[h.key.trim()] = h.value
  }
  set('headers', Object.keys(headers).length ? headers : undefined)
  let models: PiModel[]
  try {
    // Provider 的协议或 Bearer 设置变化时，已配置的模型独立密钥继续使用新认证方式，避免混入默认密钥。
    models = form.models.map((model) => {
      const previous = props.initial?.models?.find((item) => item.id === model.id)
      const key = previous && readModelApiKey(previous.headers, { ...props.initial, api: previous.api ?? props.initial?.api })
      if (key === undefined) return model
      const customHeaders = Object.fromEntries(Object.entries(model.headers ?? {}).filter(([name]) => !isAuthHeader(name)))
      return {
        ...model,
        headers: modelKeyHeaders({ ...provider, api: model.api ?? provider.api }, customHeaders, key),
      }
    })
  } catch (e) {
    error.value = (e as Error).message
    return
  }
  // models 空则删除字段（与不定义等价，pi 用内置/默认模型）
  set('models', models.length ? models : undefined)
  emit('saved', { originalName: props.providerName, name, provider })
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="props.providerName ? '编辑 Provider' : '新增 Provider'"
    :style="{ width: '660px', maxHeight: 'calc(100vh - 48px)' }"
    :content-style="{ overflowY: 'auto', minHeight: '0' }"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="top" size="small">
      <div class="form-grid">
        <n-form-item label="名称（models.json 中的键）" required>
          <n-input v-model:value="form.name" placeholder="如 Agent Router、ollama" />
        </n-form-item>
        <n-form-item label="API 协议">
          <n-select v-model:value="form.api" :options="PI_API_OPTIONS" clearable placeholder="默认（可由模型覆盖）" />
        </n-form-item>
        <n-form-item class="span-2" label="baseUrl">
          <n-input v-model:value="form.baseUrl" class="mono" placeholder="https://example.com/v1" />
        </n-form-item>
        <n-alert v-if="inheritsConnection" class="span-2" type="info" :show-icon="false">
          部分模型未显式指定协议或地址，需由 pi 内置模型或扩展提供；自定义中转模型请在此补全，或在模型上单独设置。
        </n-alert>
        <n-form-item class="span-2" label="apiKey（支持 $ENV_VAR 与 !command 语法）">
          <n-input
            v-model:value="form.apiKey"
            type="password"
            show-password-on="click"
            placeholder="留空表示依赖 /login 或 auth.json 提供认证"
          />
        </n-form-item>
        <n-alert class="span-2" :type="authNotice.type" :show-icon="false">{{ authNotice.text }}</n-alert>
        <n-form-item label="authHeader（自动携带 Authorization: Bearer）">
          <n-switch v-model:value="form.authHeader" />
        </n-form-item>
        <n-form-item class="span-2" label="自定义 headers">
          <div class="kv-rows">
            <div class="ua-toolbar">
              <UaSelect :existing="existingUa()" @update="applyUa" />
            </div>
            <div v-for="(h, i) in form.headers" :key="i" class="kv-row">
              <n-input v-model:value="h.key" class="mono" placeholder="Header 名（如 User-Agent）" />
              <n-input v-model:value="h.value" :type="isAuthHeader(h.key) ? 'password' : 'text'" show-password-on="click" placeholder="值" />
              <n-button size="small" quaternary type="error" @click="form.headers.splice(i, 1)">移除</n-button>
            </div>
            <n-button size="small" dashed @click="form.headers.push({ key: '', value: '' })">+ 添加 header</n-button>
          </div>
        </n-form-item>
        <n-form-item class="span-2" label="模型">
          <div class="kv-rows">
            <div v-if="form.models.length" class="model-chip-row">
              <n-tag v-for="m in form.models" :key="m.id" size="small" closable :bordered="false" @close="removeModel(m.id)">
                {{ m.id }}
              </n-tag>
            </div>
            <n-empty v-else description="尚未添加模型" size="small" />
            <div class="ua-toolbar">
              <n-button size="tiny" secondary @click="imShow = true">获取模型</n-button>
            </div>
          </div>
        </n-form-item>
      </div>
    </n-form>
    <template #footer>
      <div class="form-footer">
        <n-alert v-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
        <div class="form-footer-actions">
          <n-button size="small" @click="close">取消</n-button>
          <n-button size="small" type="primary" @click="save">保存</n-button>
        </div>
      </div>
    </template>
  </n-modal>

  <!-- 在线导入模型（用表单实时值拉取） -->
  <ImportModelsModal
    v-model:show="imShow"
    :provider-name="form.name || '当前 provider'"
    :provider="tempProvider"
    :existing-ids="form.models.map((m) => m.id)"
    @imported="onImported"
  />
</template>
