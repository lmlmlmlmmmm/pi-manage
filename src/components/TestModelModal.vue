<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { PiModel, PiProvider, TestModelResult } from '../types'

// 模型连接测试：提示词仅随本次请求发送，不写配置；结果按连接阶段在终端区展示。

const props = defineProps<{
  show: boolean
  providerName: string
  provider: PiProvider | null
  model: PiModel | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const DEFAULT_PROMPT = '使用python写一个二分法，不要写入文件'

const prompt = ref(DEFAULT_PROMPT)
const submittedPrompt = ref('')
const testing = ref(false)
const result = ref<TestModelResult | null>(null)
const consoleEl = ref<HTMLElement | null>(null)
let requestController: AbortController | null = null
let requestVersion = 0

const effectiveApi = computed(() => props.model?.api ?? props.provider?.api ?? '未设置')
const actionLabel = computed(() => (result.value ? '重新测试' : '开始测试'))

watch(
  () => props.show,
  (show) => {
    if (!show) {
      cancelRequest()
      return
    }
    cancelRequest()
    prompt.value = DEFAULT_PROMPT
    submittedPrompt.value = ''
    result.value = null
  },
)

function cancelRequest() {
  requestVersion++
  requestController?.abort()
  requestController = null
  testing.value = false
}

async function scrollConsoleToEnd() {
  await nextTick()
  if (consoleEl.value) consoleEl.value.scrollTop = consoleEl.value.scrollHeight
}

async function run() {
  if (!props.provider || !props.model || testing.value) return

  cancelRequest()
  const version = requestVersion
  const controller = new AbortController()
  requestController = controller
  const message = prompt.value.trim() || DEFAULT_PROMPT
  prompt.value = message
  submittedPrompt.value = message
  result.value = null
  testing.value = true
  await scrollConsoleToEnd()

  try {
    const res = await fetch('/api/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: props.provider,
        model: props.model,
        prompt: message,
      }),
      signal: controller.signal,
    })
    const data = (await res.json()) as TestModelResult & { error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    if (version !== requestVersion) return
    result.value = data
  } catch (e) {
    if (controller.signal.aborted || version !== requestVersion) return
    result.value = {
      ok: false,
      ms: 0,
      prompt: message,
      error: (e as Error).message,
      url: '',
    }
  } finally {
    if (version === requestVersion) {
      requestController = null
      testing.value = false
      await scrollConsoleToEnd()
    }
  }
}

function close() {
  cancelRequest()
  emit('update:show', false)
}

function updateShow(show: boolean) {
  if (show) emit('update:show', true)
  else close()
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    title="测试模型连接"
    :style="{ width: 'min(680px, calc(100vw - 24px))' }"
    :mask-closable="false"
    @update:show="updateShow"
  >
    <div class="tm-summary">
      <div class="tm-summary-main">
        <span class="tm-status-dot" :class="{ active: testing, success: result?.ok, error: result && !result.ok }" />
        <div class="tm-summary-copy">
          <strong class="tm-provider">{{ props.providerName || '未命名 Provider' }}</strong>
          <span class="tm-model mono" :title="props.model?.id ?? ''">{{ props.model?.id ?? '未选择模型' }}</span>
        </div>
      </div>
      <n-tag size="small" :bordered="false">{{ effectiveApi }}</n-tag>
    </div>

    <label class="tm-prompt-label" for="tm-test-prompt">测试提示词</label>
    <n-input
      v-model:value="prompt"
      type="textarea"
      size="small"
      :autosize="{ minRows: 2, maxRows: 4 }"
      :maxlength="2000"
      :disabled="testing"
      :input-props="{ id: 'tm-test-prompt' }"
      placeholder="输入本次测试发送给模型的消息"
    />

    <div
      ref="consoleEl"
      class="tm-console"
      role="log"
      aria-live="polite"
      :aria-busy="testing"
      tabindex="0"
    >
      <div v-if="!submittedPrompt" class="tm-log-line tm-log-muted">等待开始测试...</div>

      <template v-else>
        <div class="tm-log-line tm-log-pending">{{ testing ? '连接 API 中...' : '测试记录' }}</div>
        <div class="tm-log-line">
          <span class="tm-log-key">Provider:</span>
          <span class="tm-log-info">{{ props.providerName }}</span>
        </div>
        <div class="tm-log-line">
          <span class="tm-log-key">API 协议:</span>
          <span class="tm-log-success">{{ effectiveApi }}</span>
        </div>
        <div class="tm-log-line">
          <span class="tm-log-key">使用模型:</span>
          <span class="tm-log-info">{{ props.model?.id }}</span>
        </div>
        <div class="tm-log-block">
          <span class="tm-log-key">发送测试消息:</span>
          <pre>{{ submittedPrompt }}</pre>
        </div>

        <template v-if="result">
          <div v-if="result.url" class="tm-log-line">
            <span class="tm-log-key">请求端点:</span>
            <span class="tm-log-value">{{ result.url }}</span>
          </div>
          <div v-if="result.ok" class="tm-log-line tm-log-success">
            连接成功，耗时 {{ result.ms }} ms
          </div>
          <div v-else class="tm-log-line tm-log-error">测试失败，耗时 {{ result.ms }} ms</div>

          <div v-if="result.ok" class="tm-response">
            <span class="tm-log-key">响应:</span>
            <pre>{{ result.reply || '(空回复)' }}</pre>
          </div>
          <div v-else class="tm-response tm-response-error">
            <span class="tm-log-key">错误:</span>
            <pre>{{ result.error || '未知错误' }}</pre>
          </div>
        </template>
      </template>
    </div>

    <template #footer>
      <div class="form-footer-actions">
        <n-button size="small" @click="close">关闭</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="testing"
          :disabled="!props.provider || !props.model"
          @click="run"
        >
          {{ testing ? '测试中...' : actionLabel }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.tm-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 64px;
  padding: 10px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
}

.tm-summary-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tm-status-dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  background: var(--muted);
}

.tm-status-dot.active {
  background: #facc15;
}

.tm-status-dot.success {
  background: var(--accent);
}

.tm-status-dot.error {
  background: var(--danger);
}

.tm-summary-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tm-provider,
.tm-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm-provider {
  font-size: 14px;
}

.tm-model {
  color: var(--muted);
  font-size: 12px;
}

.tm-prompt-label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
}

.tm-console {
  height: clamp(240px, 38vh, 360px);
  margin-top: 14px;
  padding: 14px 16px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  background: #0b1220;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  scrollbar-gutter: stable;
}

.tm-console:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
}

.tm-log-line {
  display: flex;
  gap: 8px;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tm-log-block,
.tm-response {
  margin-top: 6px;
}

.tm-log-block pre,
.tm-response pre {
  margin: 2px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  color: var(--text);
}

.tm-log-key {
  flex: none;
  color: var(--muted);
}

.tm-log-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.tm-log-muted {
  color: var(--muted);
}

.tm-log-pending {
  color: #facc15;
}

.tm-log-info {
  color: #38bdf8;
}

.tm-log-success {
  color: var(--accent);
}

.tm-log-error,
.tm-response-error pre {
  color: var(--danger);
}

.tm-response {
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

@media (max-width: 480px) {
  .tm-summary {
    align-items: flex-start;
  }

  .tm-console {
    padding: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tm-status-dot {
    transition: none;
  }
}
</style>
