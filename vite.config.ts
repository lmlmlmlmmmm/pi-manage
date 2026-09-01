import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'

// base: './' 让构建产物可从任意子路径托管（本地服务同源托管）
export default defineConfig({
  plugins: [
    vue(),
    // naive-ui 按需引入：模板中的 <n-* 组件自动解析注册，
    // 替换原来的 app.use(naive) 全量打包，显著减小产物体积
    Components({
      resolvers: [NaiveUiResolver()],
      dts: false,
    }),
  ],
  base: './',
  build: {
    rollupOptions: {
      output: {
        // 常用框架拆成独立 chunk：缓存友好 + 消除单文件过大
        manualChunks: {
          'vendor-vue': ['vue', 'pinia'],
        },
      },
    },
  },
  server: {
    // 开发模式：前端(5173) 与后端服务(8787) 分离，/api 代理到后端；
    // 生产模式后端直接托管 dist，同源无需代理
    proxy: {
      // changeOrigin 把 Host 改写为 127.0.0.1:8787——后端只接受本机 Host，
      // 浏览器直发过来的 localhost:5173 会被 403
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
