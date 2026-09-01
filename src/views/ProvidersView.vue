<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { usePiStore } from '../stores/pi'
import type { PiModel, PiProvider } from '../types'
import ProviderForm from '../components/ProviderForm.vue'
import ModelForm from '../components/ModelForm.vue'
import TestModelModal from '../components/TestModelModal.vue'
import { formatCost, formatTokens } from '../lib/format'

const store = usePiStore()
const message = useMessage()

const entries = computed(() => Object.entries(store.library.providers))
const selected = computed(() => store.selectedProvider)
// 详情与模型操作作用于当前 provider 的 config（完整数据在库中，与启用状态无关）
const detail = computed<PiProvider | null>(() => {
  if (!selected.value) return null
  return store.library.providers[selected.value]?.config ?? null
})
const selectedEnabled = computed(() => {
  if (!selected.value) return false
  return store.library.providers[selected.value]?.enabled ?? false
})
const modelsList = computed<PiModel[]>(() => detail.value?.models ?? [])
const defaultProvider = computed(() => store.settingsData.defaultProvider)
const defaultModel = computed(() => store.settingsData.defaultModel)

// 启用/禁用：只改库标记，禁用项保留完整数据、不再投影进 models.json；结果直接反映在列表，不发 toast
function onToggleEnabled(name: string, enabled: boolean) {
  store.setProviderEnabled(name, enabled)
}

// apiKey 脱敏显示；$ENV / !cmd 形式的值不是机密，直接展示
const revealKey = ref(false)
watch(selected, () => {
  revealKey.value = false
})
const maskedKey = computed(() => {
  const k = detail.value?.apiKey
  if (!k) return null
  if (/^[$!]/.test(k)) return k
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 4)}••••${k.slice(-4)}`
})

// ---------- Provider 表单 ----------

const pf = ref<{ show: boolean; name: string | null }>({ show: false, name: null })

function openProviderCreate() {
  pf.value = { show: true, name: null }
}

function openProviderEdit(name: string) {
  pf.value = { show: true, name }
}

function onProviderSaved(payload: { originalName: string | null; name: string; provider: PiProvider }) {
  try {
    if (payload.originalName) {
      store.updateProvider(payload.originalName, payload.name, payload.provider)
    } else {
      store.addProvider(payload.name, payload.provider)
    }
  } catch (e) {
    // 同名冲突等：弹窗保持打开，已填内容不丢
    message.error((e as Error).message)
    return
  }
  pf.value.show = false
}

function duplicateProvider(name: string) {
  try {
    store.duplicateProvider(name)
  } catch (e) {
    message.error((e as Error).message)
  }
}

function deleteProvider(name: string) {
  store.deleteProvider(name)
}

// ---------- 模型表单 ----------

const mf = ref<{ show: boolean; provider: string; modelId: string | null }>({
  show: false,
  provider: '',
  modelId: null,
})

function openModelCreate() {
  if (!selected.value) return
  mf.value = { show: true, provider: selected.value, modelId: null }
}

function openModelEdit(m: PiModel) {
  if (!selected.value) return
  mf.value = { show: true, provider: selected.value, modelId: m.id }
}

const currentModel = computed<PiModel | null>(
  () => (mf.value.modelId ? modelsList.value.find((m) => m.id === mf.value.modelId) ?? null : null),
)

function onModelSaved(payload: { originalId: string | null; model: PiModel }) {
  try {
    if (payload.originalId) {
      store.updateModel(mf.value.provider, payload.originalId, payload.model)
    } else {
      store.addModel(mf.value.provider, payload.model)
    }
  } catch (e) {
    message.error((e as Error).message)
    return
  }
  mf.value.show = false
}

function isDefaultModel(m: PiModel): boolean {
  return defaultProvider.value === selected.value && defaultModel.value === m.id
}

function setDefaultModel(m: PiModel) {
  if (!selected.value) return
  store.setDefaultModel(selected.value, m.id)
}

function duplicateModel(m: PiModel) {
  if (!selected.value) return
  try {
    store.duplicateModel(selected.value, m.id)
  } catch (e) {
    message.error((e as Error).message)
  }
}

function deleteModel(m: PiModel) {
  if (!selected.value) return
  store.deleteModel(selected.value, m.id)
}

// ---------- 模型连接测试 ----------

const tm = ref<{ show: boolean; model: PiModel | null }>({ show: false, model: null })

function openTest(m: PiModel) {
  tm.value = { show: true, model: m }
}

// ModelForm 内「测试」按钮：用表单当前值（未保存也能测）构造模型对象
function onModelFormTest(model: PiModel) {
  tm.value = { show: true, model }
}
</script>

<template>
  <div class="pv">
    <!-- 左侧 provider 列表 -->
    <aside class="pv-side">
      <div class="pv-side-head">
        <span>Providers · {{ entries.length }}</span>
        <n-button size="tiny" secondary type="primary" @click="openProviderCreate">+ 新增</n-button>
      </div>
      <button
        v-for="[name, lp] in entries"
        :key="name"
        class="pv-item"
        :class="{ active: name === selected, disabled: !lp.enabled }"
        :title="name"
        @click="store.selectedProvider = name"
      >
        <span class="pv-item-name">{{ name }}</span>
        <span class="pv-item-meta">
          <n-tag v-if="name === defaultProvider" size="tiny" type="success" :bordered="false">默认</n-tag>
          <span>{{ lp.config.models?.length ?? 0 }}</span>
          <n-switch
            size="small"
            :value="lp.enabled"
            @update:value="(v: boolean) => onToggleEnabled(name, v)"
            @click.stop
          />
        </span>
      </button>
      <n-empty v-if="entries.length === 0" description="还没有 provider" size="small" style="margin-top: 24px" />
    </aside>

    <!-- 右侧详情 -->
    <section class="pv-main">
      <template v-if="detail && selected">
        <div class="pv-head">
          <span class="pv-title mono">{{ selected }}</span>
          <n-tag v-if="detail.api" size="small" :bordered="false">{{ detail.api }}</n-tag>
          <n-tag v-if="!selectedEnabled" size="small" type="warning" :bordered="false">未启用 · 不在 models.json 中</n-tag>
          <div class="pv-head-actions">
            <n-button size="small" secondary @click="openProviderEdit(selected)">编辑</n-button>
            <n-button size="small" secondary @click="duplicateProvider(selected)">复制</n-button>
            <n-popconfirm @positive-click="deleteProvider(selected)">
              <template #trigger>
                <n-button size="small" secondary type="error">删除</n-button>
              </template>
              删除 provider「{{ selected }}」及其 {{ detail.models?.length ?? 0 }} 个模型？
            </n-popconfirm>
          </div>
        </div>

        <!-- provider 字段概览 -->
        <div class="pv-meta">
          <div class="pv-meta-item">
            <span class="pv-meta-label">baseUrl</span>
            <span class="pv-meta-value mono" :title="detail.baseUrl ?? ''">{{ detail.baseUrl || '—' }}</span>
          </div>
          <div class="pv-meta-item">
            <span class="pv-meta-label">apiKey</span>
            <span class="pv-meta-value mono">
              <template v-if="detail.apiKey">
                {{ revealKey ? detail.apiKey : maskedKey }}
                <n-button text type="primary" size="tiny" @click="revealKey = !revealKey">
                  {{ revealKey ? '隐藏' : '显示' }}
                </n-button>
              </template>
              <template v-else>—</template>
            </span>
          </div>
          <div class="pv-meta-item">
            <span class="pv-meta-label">authHeader</span>
            <span class="pv-meta-value">{{ detail.authHeader ? '是（Bearer）' : '—' }}</span>
          </div>
          <div class="pv-meta-item">
            <span class="pv-meta-label">headers</span>
            <span
              v-if="detail.headers && Object.keys(detail.headers).length"
              class="pv-meta-value mono"
              :title="JSON.stringify(detail.headers)"
            >
              {{ JSON.stringify(detail.headers) }}
            </span>
            <span v-else class="muted">—</span>
          </div>
        </div>

        <!-- 模型列表 -->
        <n-card size="small">
          <template #header>模型 · {{ modelsList.length }}</template>
          <template #header-extra>
            <n-button size="tiny" secondary type="primary" @click="openModelCreate">+ 新增模型</n-button>
          </template>
          <n-table v-if="modelsList.length" size="small" :single-line="false" class="pv-table">
            <thead>
              <tr>
                <th>模型 ID</th>
                <th>名称</th>
                <th>API 协议</th>
                <th>思考</th>
                <th>上下文</th>
                <th>最大输出</th>
                <th>$/1M token</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in modelsList" :key="m.id">
                <td class="mono">
                  {{ m.id }}
                  <n-tag v-if="isDefaultModel(m)" size="tiny" type="success" :bordered="false" style="margin-left: 4px">
                    默认
                  </n-tag>
                  <n-tag
                    v-if="m.baseUrl || (m.headers && Object.keys(m.headers).length)"
                    size="tiny"
                    type="warning"
                    :bordered="false"
                    style="margin-left: 4px"
                    :title="`模型级覆盖：${m.baseUrl ? 'baseUrl=' + m.baseUrl : ''}${m.headers ? ' headers=' + JSON.stringify(m.headers) : ''}`"
                  >
                    覆盖
                  </n-tag>
                </td>
                <td class="muted">{{ m.name ?? '—' }}</td>
                <td>
                  <span class="mono">{{ m.api ?? detail?.api ?? '—' }}</span>
                </td>
                <td>
                  <n-tag v-if="m.reasoning" size="tiny" :bordered="false">支持</n-tag>
                  <span v-else class="muted">—</span>
                </td>
                <td>{{ formatTokens(m.contextWindow) }}</td>
                <td>{{ formatTokens(m.maxTokens) }}</td>
                <td class="muted">{{ formatCost(m.cost) }}</td>
                <td class="pv-table-actions">
                  <n-button text size="tiny" type="primary" :disabled="isDefaultModel(m)" @click="setDefaultModel(m)">
                    设为默认
                  </n-button>
                  <n-button text size="tiny" type="info" @click="openTest(m)">测试</n-button>
                  <n-button text size="tiny" @click="openModelEdit(m)">编辑</n-button>
                  <n-button text size="tiny" @click="duplicateModel(m)">复制</n-button>
                  <n-popconfirm @positive-click="deleteModel(m)">
                    <template #trigger>
                      <n-button text size="tiny" type="error">删除</n-button>
                    </template>
                    删除模型「{{ m.id }}」？
                  </n-popconfirm>
                </td>
              </tr>
            </tbody>
          </n-table>
          <n-empty v-else description="该 provider 还没有模型" size="small" />
        </n-card>
      </template>

      <n-empty v-else description="选择左侧 provider 查看详情" size="small" style="margin-top: 80px" />
    </section>

    <!-- 表单弹窗 -->
    <ProviderForm
      v-model:show="pf.show"
      :provider-name="pf.name"
      :initial="pf.name ? store.library.providers[pf.name]?.config ?? null : null"
      :existing-names="entries.map(([name]) => name)"
      @saved="onProviderSaved"
    />
    <ModelForm
      v-model:show="mf.show"
      :provider-name="mf.provider"
      :model-id="mf.modelId"
      :initial="currentModel"
      :existing-ids="modelsList.map((m) => m.id)"
      :provider="detail"
      @saved="onModelSaved"
      @test="onModelFormTest"
    />

    <!-- 模型连接测试：用库中当前配置（provider + 模型）发送完整对话请求 -->
    <TestModelModal
      v-model:show="tm.show"
      :provider-name="selected ?? ''"
      :provider="detail"
      :model="tm.model"
    />
  </div>
</template>
