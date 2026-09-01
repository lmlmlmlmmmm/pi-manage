<script setup lang="ts">
import { darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import AppShell from './components/AppShell.vue'

// 主题：基于 ui-ux-pro-max 设计系统推荐（暗色 + 绿色主色 + 高密度）
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#22C55E',
    primaryColorHover: '#4ADE80',
    primaryColorPressed: '#16A34A',
    primaryColorSuppl: '#4ADE80',
    bodyColor: '#0F172A',
    cardColor: '#16213B',
    modalColor: '#16213B',
    popoverColor: '#1E293B',
    borderColor: '#334155',
    fontFamily: "'Fira Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
    fontFamilyMono: "'Fira Code', 'Cascadia Code', Consolas, monospace",
  },
}
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides" style="height: 100%">
    <n-message-provider>
      <n-dialog-provider>
        <!-- Shell 拆分为子组件：useMessage/useDialog 必须在 provider 内部的组件中使用 -->
        <AppShell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
