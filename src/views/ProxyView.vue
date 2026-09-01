<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { usePiStore } from '../stores/pi'

// 代理配置独立保存到 pi-manage 私有配置；表单中的认证信息仅交给本机后端建立代理连接。
const store = usePiStore()
const message = useMessage()

const proxyInput = ref(store.appConfig.proxy ?? '')
const usernameInput = ref(store.appConfig.proxyUsername ?? '')
const passwordInput = ref(store.appConfig.proxyPassword ?? '')
const userEdited = ref(false)
const testing = ref(false)

// appConfig 异步到达时回填；用户开始编辑后不覆盖输入。
watch(
  () => [store.appConfig.proxy, store.appConfig.proxyUsername, store.appConfig.proxyPassword] as const,
  ([proxy, username, password]) => {
    if (userEdited.value) return
    proxyInput.value = proxy ?? ''
    usernameInput.value = username ?? ''
    passwordInput.value = password ?? ''
  },
)

const hasChanges = computed(
  () =>
    proxyInput.value.trim() !== (store.appConfig.proxy ?? '') ||
    usernameInput.value.trim() !== (store.appConfig.proxyUsername ?? '') ||
    passwordInput.value !== (store.appConfig.proxyPassword ?? ''),
)

function markEdited() {
  userEdited.value = true
}

function restoreSaved() {
  proxyInput.value = store.appConfig.proxy ?? ''
  usernameInput.value = store.appConfig.proxyUsername ?? ''
  passwordInput.value = store.appConfig.proxyPassword ?? ''
  userEdited.value = false
}

function clearForm() {
  proxyInput.value = ''
  usernameInput.value = ''
  passwordInput.value = ''
  markEdited()
}

async function testProxy() {
  const proxy = proxyInput.value.trim()
  if (!proxy) {
    message.warning('请先填写代理地址')
    return
  }
  testing.value = true
  try {
    const response = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy,
        proxyUsername: usernameInput.value.trim(),
        proxyPassword: passwordInput.value,
      }),
    })
    const data = (await response.json()) as { ok?: boolean; error?: string }
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
    message.success('代理连接正常')
  } catch (e) {
    message.error(`代理不可用：${(e as Error).message}`)
  } finally {
    testing.value = false
  }
}

async function save() {
  const proxy = proxyInput.value.trim()
  const result = await store.saveProxy(proxy, usernameInput.value.trim(), passwordInput.value)
  if (result.ok) {
    userEdited.value = false
    message.success(proxy ? '代理设置已保存' : '已改为直连')
  } else {
    message.error(result.error ?? '保存失败')
  }
}
</script>

<template>
  <div class="page proxy-page">
    <form class="proxy-form" @submit.prevent="save">
      <div class="proxy-primary-row">
        <n-input
          v-model:value="proxyInput"
          class="mono proxy-address"
          placeholder="http://127.0.0.1:7890 / socks5://127.0.0.1:1080"
          :disabled="store.proxySaving"
          :input-props="{ 'aria-label': '代理地址', autocomplete: 'off' }"
          @input="markEdited"
        />
        <div class="proxy-actions">
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                attr-type="button"
                circle
                secondary
                class="proxy-icon-button"
                aria-label="测试代理"
                :loading="testing"
                :disabled="store.proxySaving"
                @click="testProxy"
              >
                <span aria-hidden="true">↻</span>
              </n-button>
            </template>
            测试代理
          </n-tooltip>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                attr-type="button"
                circle
                secondary
                class="proxy-icon-button"
                aria-label="恢复已保存配置"
                :disabled="!hasChanges || store.proxySaving"
                @click="restoreSaved"
              >
                <span aria-hidden="true">↶</span>
              </n-button>
            </template>
            恢复已保存配置
          </n-tooltip>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                attr-type="button"
                circle
                secondary
                class="proxy-icon-button"
                aria-label="清空代理配置"
                :disabled="store.proxySaving"
                @click="clearForm"
              >
                <span aria-hidden="true">×</span>
              </n-button>
            </template>
            清空代理配置
          </n-tooltip>
          <n-button attr-type="submit" type="primary" :loading="store.proxySaving">保存</n-button>
        </div>
      </div>

      <div class="proxy-auth-row">
        <n-input
          v-model:value="usernameInput"
          placeholder="用户名（可选）"
          :disabled="store.proxySaving"
          :input-props="{ 'aria-label': '代理用户名', autocomplete: 'off' }"
          @input="markEdited"
        />
        <n-input
          v-model:value="passwordInput"
          type="password"
          show-password-on="click"
          placeholder="密码（可选）"
          :disabled="store.proxySaving"
          :input-props="{ 'aria-label': '代理密码', autocomplete: 'new-password' }"
          @input="markEdited"
        />
      </div>
    </form>
  </div>
</template>

<style scoped>
.proxy-page {
  width: 100%;
  max-width: none;
}

.proxy-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(100%, 820px);
}

.proxy-primary-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

.proxy-address {
  min-width: 0;
}

.proxy-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.proxy-icon-button {
  width: 34px;
  height: 34px;
  font-family: var(--sans);
  font-size: 17px;
}

.proxy-auth-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

@media (max-width: 640px) {
  .proxy-primary-row {
    grid-template-columns: 1fr;
  }

  .proxy-actions {
    justify-content: flex-end;
  }
}

@media (max-width: 520px) {
  .proxy-auth-row {
    grid-template-columns: 1fr;
  }
}
</style>
