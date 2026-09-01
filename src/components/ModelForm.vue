<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { FetchedModel, ModelMeta, PiModel, PiProvider } from '../types'
import { PI_API_OPTIONS, THINKING_LEVELS } from '../types'
import UaSelect from './UaSelect.vue'
import ImportModelsModal from './ImportModelsModal.vue'

const props = defineProps<{
  show: boolean
  providerName: string
  // null 表示新增
  modelId: string | null
  initial: PiModel | null
  existingIds: string[]
  // 用于在线导入：从该 provider 拉模型列表（含 baseUrl/apiKey/headers）
  provider: PiProvider | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [payload: { originalId: string | null; model: PiModel }]
  /** 用表单当前值发起模型连接测试（未保存也能测） */
  test: [model: PiModel]
}>()

const message = useMessage()
const fetchingMeta = ref(false)
// 在线导入弹窗（单选：选一个模型填充当前表单）
const imShow = ref(false)

// 从 provider 拉取列表选中的模型，填充到当前表单（id + 元数据）；结果直接呈现在表单，不发 toast
function onImported(models: FetchedModel[]) {
  const m = models[0]
  if (!m) return
  form.id = m.id
  if (m.name) form.name = m.name
  if (m.contextWindow !== undefined) form.contextWindow = m.contextWindow
  if (m.maxTokens !== undefined) form.maxTokens = m.maxTokens
  form.inputImage = m.inputImage === true
  if (m.reasoning !== undefined) form.reasoning = m.reasoning
  if (m.thinkingLevelMap) {
    for (const level of THINKING_LEVELS) {
      const v = m.thinkingLevelMap[level]
      form.tlm[level] =
        v === null ? '@null' : v === level ? '@self' : v !== undefined ? v : ''
    }
  }
  if (m.cost) {
    const rates = [m.cost.input, m.cost.output, m.cost.cacheRead, m.cost.cacheWrite]
    if (rates.some((v) => v !== undefined)) {
      // Pi 0.84.4 要求 cost 出现时四项齐全；缺项按 Pi 默认费率 0 显式补齐。
      form.costInput = m.cost.input ?? 0
      form.costOutput = m.cost.output ?? 0
      form.costCacheRead = m.cost.cacheRead ?? 0
      form.costCacheWrite = m.cost.cacheWrite ?? 0
    }
  }
}

// 当前 User-Agent 值传给 UaSelect，生成时只替换版本段；回填时写入/新增行
const existingUa = () =>
  form.headers.find((h) => h.key.trim().toLowerCase() === 'user-agent')?.value ?? ''

function applyUa(ua: string) {
  const row = form.headers.find((h) => h.key.trim().toLowerCase() === 'user-agent')
  if (row) row.value = ua
  else form.headers.push({ key: 'User-Agent', value: ua })
}

// thinkingLevelMap 表单哨兵值：
// ''     未设置（键不存在，走 provider 默认映射）
// '@self' 该档位发送档位名本身（如 "high": "high"）
// '@null' 该档位不支持（写入 null，pi 会隐藏/跳过）
// 其他字符串按原值发送（如 off → "none"）
interface HeaderRow {
  key: string
  value: string
}

const form = reactive({
  id: '',
  name: '',
  api: null as string | null,
  baseUrl: '',
  headers: [] as HeaderRow[],
  reasoning: false,
  inputText: true,
  inputImage: false,
  contextWindow: null as number | null,
  maxTokens: null as number | null,
  costInput: null as number | null,
  costOutput: null as number | null,
  costCacheRead: null as number | null,
  costCacheWrite: null as number | null,
  tlm: {} as Record<string, string>,
})

const error = ref('')

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

// 每次打开以磁盘数据重新初始化表单，取消后不留脏状态
watch(
  () => props.show,
  (show) => {
    if (!show) return
    error.value = ''
    const m = props.initial
    form.id = typeof m?.id === 'string' ? m.id : ''
    form.name = typeof m?.name === 'string' ? m.name : ''
    form.api = typeof m?.api === 'string' ? m.api : null
    form.baseUrl = typeof m?.baseUrl === 'string' ? m.baseUrl : ''
    form.headers = Object.entries(m?.headers ?? {}).map(([key, value]) => ({ key, value: String(value) }))
    form.reasoning = m?.reasoning === true
    const input = Array.isArray(m?.input) ? (m!.input as unknown[]) : ['text']
    form.inputText = input.includes('text') || input.length === 0
    form.inputImage = input.includes('image')
    form.contextWindow = num(m?.contextWindow)
    form.maxTokens = num(m?.maxTokens)
    const cost = m?.cost
    form.costInput = num(cost?.input)
    form.costOutput = num(cost?.output)
    form.costCacheRead = num(cost?.cacheRead)
    form.costCacheWrite = num(cost?.cacheWrite)
    for (const level of THINKING_LEVELS) {
      const raw = m?.thinkingLevelMap?.[level]
      form.tlm[level] =
        raw === undefined ? '' : raw === null ? '@null' : raw === level ? '@self' : String(raw)
    }
  },
)

function close() {
  emit('update:show', false)
}

// 按当前 id 从 models.dev 拉取元数据，只填充空字段（不覆盖用户已填的值）；
// 拉取失败静默降级，给提示即可
async function fetchMeta() {
  const id = form.id.trim()
  if (!id) {
    message.warning('请先填写模型 id')
    return
  }
  fetchingMeta.value = true
  try {
    // 由本机后端查 models.dev（无 CORS）
    const res = await fetch(`/api/models-dev?id=${encodeURIComponent(id)}`)
    const data = (await res.json()) as { meta: ModelMeta | null; error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    const meta = data.meta
    if (!meta) {
      message.warning(`models.dev 未收录「${id}」，可尝试去除前缀或用网关 /models 信息`)
      return
    }
    if (!form.name && meta.name) form.name = meta.name
    if (form.contextWindow === null && meta.contextWindow) form.contextWindow = meta.contextWindow
    if (form.maxTokens === null && meta.maxTokens) form.maxTokens = meta.maxTokens
    if (meta.inputImage === true && !form.inputImage) form.inputImage = true
    if (meta.reasoning === true && !form.reasoning) form.reasoning = true
    // thinkingLevelMap：只填空档位；models.dev 值（null/档位名/其他）转成表单哨兵值
    if (meta.thinkingLevelMap) {
      for (const level of THINKING_LEVELS) {
        if (form.tlm[level]) continue
        const v = meta.thinkingLevelMap[level]
        if (v === null) form.tlm[level] = '@null'
        else if (v === level) form.tlm[level] = '@self'
        else if (v !== undefined) form.tlm[level] = v
      }
    }
    if (meta.cost) {
      if (form.costInput === null && meta.cost.input !== undefined) form.costInput = meta.cost.input
      if (form.costOutput === null && meta.cost.output !== undefined) form.costOutput = meta.cost.output
      if (form.costCacheRead === null && meta.cost.cacheRead !== undefined) form.costCacheRead = meta.cost.cacheRead
      if (form.costCacheWrite === null && meta.cost.cacheWrite !== undefined) form.costCacheWrite = meta.cost.cacheWrite
    }
    message.success('已从 models.dev 填充元数据')
  } finally {
    fetchingMeta.value = false
  }
}
// 注：填充/元数据/UA 等操作结果直接呈现在表单中，不再另发 toast

function levelOptions(level: string) {
  const options = [
    { label: '未设置', value: '' },
    { label: `发送「${level}」`, value: '@self' },
    { label: '不支持 (null)', value: '@null' },
    { label: '发送「none」', value: 'none' },
  ]
  // 非预设的自定义发送值也保留一个可选项，避免打开表单后丢失
  const cur = form.tlm[level] ?? ''
  if (cur !== '' && cur !== '@self' && cur !== '@null' && cur !== 'none') {
    options.push({ label: `发送「${cur}」`, value: cur })
  }
  return options
}

function save() {
  const model = formToModel()
  if (typeof model === 'string') {
    error.value = model
    return
  }
  emit('saved', { originalId: props.modelId, model })
}

// 表单值 → PiModel：以原对象为底稿覆盖已知字段（未知字段无损保留）。
// save 与测试共用，保证测试请求与保存后的配置一致
function formToModel(): PiModel | string {
  const id = form.id.trim()
  if (!id) return '模型 id 不能为空'
  // 重命名时排除自身，新增时校验全部
  if (props.existingIds.filter((x) => x !== props.modelId).includes(id)) {
    return `该 provider 下已存在同 id 模型：${id}`
  }
  if (form.inputImage && !form.inputText) {
    return 'input 需至少包含 text（pi 仅支持 ["text"] 或 ["text", "image"]）'
  }
  const model: PiModel = { ...(props.initial ?? {}) } as PiModel
  const record = model as Record<string, unknown>
  const set = (k: string, v: unknown) => {
    if (v === undefined) delete record[k]
    else record[k] = v
  }
  set('id', id)
  set('name', form.name.trim() || undefined)
  set('api', form.api ?? undefined)
  // 模型级覆盖：留空跟随 provider 的 baseUrl；headers 与 provider 级同键浅合并
  set('baseUrl', form.baseUrl.trim() || undefined)
  const headers: Record<string, string> = {}
  for (const h of form.headers) {
    if (h.key.trim()) headers[h.key.trim()] = h.value
  }
  set('headers', Object.keys(headers).length ? headers : undefined)
  set('reasoning', form.reasoning || undefined)
  // ["text"] 是 pi 默认值，等价时省略；勾选 image 时必然携带 text（pi 的输入类型约束）
  set('input', form.inputImage ? ['text', 'image'] : undefined)
  set('contextWindow', form.contextWindow ?? undefined)
  set('maxTokens', form.maxTokens ?? undefined)
  const hasCost =
    form.costInput !== null || form.costOutput !== null || form.costCacheRead !== null || form.costCacheWrite !== null
  if (hasCost) {
    // Pi 0.84.4 的 ModelCostSchema 要求四个基础费率全部存在；
    // cost 的未知子字段（如 tiers）仍通过展开保留，表单留空项按 Pi 默认费率 0 补齐。
    const cost = {
      ...(props.initial?.cost ?? {}),
      input: form.costInput ?? 0,
      output: form.costOutput ?? 0,
      cacheRead: form.costCacheRead ?? 0,
      cacheWrite: form.costCacheWrite ?? 0,
    }
    set('cost', cost)
  } else {
    delete record.cost
  }
  const tlm: Record<string, string | null> = {}
  for (const level of THINKING_LEVELS) {
    const v = form.tlm[level] ?? ''
    if (v === '') continue
    if (v === '@null') tlm[level] = null
    else if (v === '@self') tlm[level] = level
    else tlm[level] = v
  }
  set('thinkingLevelMap', Object.keys(tlm).length ? tlm : undefined)
  return model
}

// 用表单当前值发起测试：不要求校验全过（未填完也可能想先试 id 对不对），
// 但 id 必须有——后端要拿它发请求
function testFromForm() {
  const model = formToModel()
  if (typeof model === 'string') {
    // 只拦「缺 id」，其余校验（重复 id 等）不阻塞测试
    if (!form.id.trim()) {
      error.value = model
      return
    }
  }
  emit('test', typeof model === 'string' ? ({ id: form.id.trim() } as PiModel) : model)
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="props.modelId ? `编辑模型 · ${props.modelId}` : `新增模型 · ${props.providerName}`"
    :style="{ width: '720px' }"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="top" size="small">
      <div class="form-grid">
        <n-form-item class="span-2" label="id" required>
          <div class="id-row">
            <n-input v-model:value="form.id" class="mono" placeholder="如 glm-5.3" />
            <n-button size="small" secondary @click="imShow = true">获取模型</n-button>
            <n-button size="small" secondary :loading="fetchingMeta" @click="fetchMeta">获取元数据</n-button>
            <n-button size="small" secondary type="info" @click="testFromForm">测试</n-button>
          </div>
        </n-form-item>
        <n-form-item label="name">
          <n-input v-model:value="form.name" placeholder="如 GLM-5.3" />
        </n-form-item>
        <n-form-item label="API">
          <n-select v-model:value="form.api" :options="PI_API_OPTIONS" clearable placeholder="跟随 provider" />
        </n-form-item>
        <n-form-item label="baseUrl">
          <n-input v-model:value="form.baseUrl" class="mono" placeholder="留空跟随 provider" />
        </n-form-item>
        <n-form-item label="reasoning">
          <n-switch v-model:value="form.reasoning" />
        </n-form-item>
        <n-form-item label="input">
          <n-checkbox v-model:checked="form.inputText">text</n-checkbox>
          <n-checkbox v-model:checked="form.inputImage" style="margin-left: 12px">image</n-checkbox>
        </n-form-item>
        <n-form-item class="span-2" label="contextWindow / maxTokens">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%">
            <n-input-number
              v-model:value="form.contextWindow"
              :min="0"
              :step="1000"
              placeholder="默认 128000"
            />
            <n-input-number
              v-model:value="form.maxTokens"
              :min="0"
              :step="1000"
              placeholder="默认 16384"
            />
          </div>
        </n-form-item>
        <n-form-item class="span-2" label="成本">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; width: 100%">
            <n-input-number v-model:value="form.costInput" :min="0" placeholder="输入" />
            <n-input-number v-model:value="form.costOutput" :min="0" placeholder="输出" />
            <n-input-number v-model:value="form.costCacheRead" :min="0" placeholder="缓存读" />
            <n-input-number v-model:value="form.costCacheWrite" :min="0" placeholder="缓存写" />
          </div>
        </n-form-item>
        <n-form-item class="span-2" label="headers">
          <div class="kv-rows">
            <div class="ua-toolbar">
              <UaSelect :existing="existingUa()" @update="applyUa" />
            </div>
            <div v-for="(h, i) in form.headers" :key="i" class="kv-row">
              <n-input v-model:value="h.key" class="mono" placeholder="Header 名（如 User-Agent）" />
              <n-input v-model:value="h.value" placeholder="值" />
              <n-button size="small" quaternary type="error" @click="form.headers.splice(i, 1)">移除</n-button>
            </div>
            <n-button size="small" dashed @click="form.headers.push({ key: '', value: '' })">+ 添加 header</n-button>
          </div>
        </n-form-item>
        <n-form-item class="span-2" label="thinkingLevelMap">
          <div class="tlm-grid">
            <div v-for="level in THINKING_LEVELS" :key="level" class="tlm-item">
              <span>{{ level }}</span>
              <n-select
                size="tiny"
                :value="form.tlm[level] ?? ''"
                :options="levelOptions(level)"
                @update:value="(v: string) => (form.tlm[level] = v)"
              />
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

  <!-- 在线导入：从 provider 拉列表单选一个填充当前表单 -->
  <ImportModelsModal
    v-model:show="imShow"
    :provider-name="props.providerName"
    :provider="props.provider"
    :existing-ids="props.existingIds"
    single
    @imported="onImported"
  />
</template>
