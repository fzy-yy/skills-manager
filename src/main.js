import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './main.css'

// 创建插件应用，并统一注册状态管理与页面路由。
createApp(App)
  .use(createPinia())
  .use(router)
  .mount('#app')
