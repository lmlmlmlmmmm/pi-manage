<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { usePiStore } from '../stores/pi'
import type { ProviderDiff } from '../types'
import ProvidersView from '../views/ProvidersView.vue'
import SettingsView from '../views/SettingsView.vue'
import ProxyView from '../views/ProxyView.vue'

const store = usePiStore()
const message = useMessage()
const dialog = useDialog()

// 导航页签：徽标展示 provider/模型统计，代理页签用状态点标识是否启用
const navTabs = computed(() => [
  { key: 'providers' as const, label: 'Providers', badge: `${store.providerNames.length}/${store.totalModels}` },
  { key: 'proxy' as const, label: '代理' },
  { key: 'settings' as const, label: '设置' },
])
const proxyActive = computed(() => !!store.appConfig.proxy)

onMounted(() => {
  store.init()
  window.addEventListener('beforeunload', onBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})

// 有未落盘更改时阻止误关页面（自动保存有 800ms 防抖窗口 + 可能失败）
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (store.dirty || store.autoSaveError) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// 自动保存失败：点标记可重试；错误详情入 message（非阻塞，不打断编辑）
function retryAutoSave() {
  if (!store.autoSaveError) return
  message.warning(store.autoSaveError.slice(0, 200), { duration: 6000 })
  void store.flushAutoSave()
}

// 处理库与 models.json 的差异：改的是库，自动保存会投影写回落盘
function handleDiffAction(d: ProviderDiff) {
  try {
    if (d.kind === 'external-added') {
      store.importExternalProvider(d.name)
      message.success(`已导入「${d.name}」到本地库，将自动写入 models.json`)
    } else {
      store.markExternalRemoved(d.name)
      message.success(`已将「${d.name}」同步为未启用（数据保留在库中）`)
    }
  } catch (e) {
    message.error((e as Error).message)
  }
}
</script>

<template>
  <div class="app">
    <!-- 加载中 / 后端不可达 -->
    <div v-if="store.phase === 'loading'" class="connect">
      <div class="connect-card">
        <div class="connect-logo">π</div>
        <h1 class="connect-title">pi-manage</h1>
        <p class="connect-sub muted">正在连接本机后端…</p>
        <n-spin size="small" style="margin: 8px auto; display: block" />
      </div>
    </div>

    <!-- 后端不可达或配置读取失败 -->
    <div v-else-if="store.phase === 'error'" class="app-error">
      <n-card class="app-error-card" title="无法加载配置">
        <n-alert type="error" :show-icon="false">{{ store.error }}</n-alert>
        <p class="muted app-error-hint">
          请确认本机后端服务已启动（<span class="mono">pi-manage</span> 命令）；若为配置文件解析错误，修复后点「重试」。
        </p>
        <div class="app-error-actions">
          <n-button size="small" type="primary" @click="store.reload()">重试</n-button>
        </div>
      </n-card>
    </div>

    <!-- 主界面 -->
    <template v-else>
      <header class="app-header">
        <div class="app-brand">
          <span class="app-logo">π</span>
          <span class="app-title">pi-manage</span>
          <span class="app-dir mono" :title="store.piDir">{{ store.piDir }}</span>
        </div>
        <nav class="app-nav">
          <button
            v-for="tab in navTabs"
            :key="tab.key"
            :class="{ active: store.activeTab === tab.key }"
            @click="store.activeTab = tab.key"
          >
            <span class="nav-label">{{ tab.label }}</span>
            <span v-if="tab.badge" class="nav-badge">{{ tab.badge }}</span>
            <span
              v-if="tab.key === 'proxy' && proxyActive"
              class="nav-dot"
              title="代理已启用"
            ></span>
          </button>
        </nav>
        <div class="app-actions">
          <!-- 保存状态：自动保存中 / 失败可点重试 / 有待写盘的变更 -->
          <transition name="dirty-fade" mode="out-in">
            <n-tag
              v-if="store.autoSaveError"
              type="error"
              size="small"
              round
              :bordered="false"
              class="save-status"
              title="点击重试"
              style="cursor: pointer"
              @click="retryAutoSave"
            >
              保存失败 · 重试
            </n-tag>
            <n-spin v-else-if="store.autoSaving" :size="14" class="save-status">
              <template #description><span class="save-status-text">保存中…</span></template>
            </n-spin>
            <n-tag v-else-if="store.dirty" type="warning" size="small" round :bordered="false" class="save-status">
              待保存…
            </n-tag>
          </transition>
        </div>
      </header>
      <main class="app-main">
        <div v-if="store.warnings.length" class="app-warnings">
          <n-alert v-for="w in store.warnings" :key="w" type="warning" :show-icon="false" closable @close="store.warnings = store.warnings.filter((x) => x !== w)">
            {{ w }}
          </n-alert>
        </div>
        <div v-if="store.diffs.length" class="app-diffs">
          <n-alert
            v-for="d in store.diffs"
            :key="d.kind + d.name"
            :type="d.kind === 'external-removed' ? 'warning' : 'info'"
            :show-icon="false"
          >
            <div class="diff-row">
              <span>
                <template v-if="d.kind === 'external-removed'">
                  「{{ d.name }}」已被外部从 models.json 移除（pi-switch / cc-switch / 手动编辑），本地库仍为启用，保存会把它写回。
                </template>
                <template v-else>
                  「{{ d.name }}」（{{ d.modelCount }} 个模型）出现在 models.json 中但不在本地库，可能由外部工具写入。
                </template>
              </span>
              <n-button size="tiny" type="primary" secondary @click="handleDiffAction(d)">
                {{ d.kind === 'external-removed' ? '同步为未启用' : '导入到库' }}
              </n-button>
            </div>
          </n-alert>
        </div>
        <ProvidersView v-if="store.activeTab === 'providers'" />
        <ProxyView v-else-if="store.activeTab === 'proxy'" />
        <SettingsView v-else />
      </main>
    </template>
  </div>
</template>
