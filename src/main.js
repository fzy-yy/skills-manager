import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useAppStore } from './stores/appStore'
import './main.css'

// 创建插件应用，并统一注册状态管理与页面路由。
const app = createApp(App)
const pinia = createPinia()

app.use(pinia).use(router)
const store = useAppStore(pinia)

// 捕获组件渲染和未处理 Promise 错误，确保意外异常也会给出可见提示。
app.config.errorHandler = error => {
  store.notify(`界面发生错误：${error?.message || '未知错误'}`, 'error')
}
window.addEventListener('unhandledrejection', event => {
  store.notify(`操作发生未处理错误：${event.reason?.message || String(event.reason || '未知错误')}`, 'error')
})

app.mount('#app')
