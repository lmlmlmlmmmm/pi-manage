import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'

const app = createApp(App)
app.use(createPinia())
// naive-ui 不再全量注册：组件由 unplugin-vue-components 按需自动引入
app.mount('#app')
