import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Vite 构建配置：把 Vue 单文件组件与 Tailwind 样式编译成 uTools 可直接加载的 html/css/js。
// https://vitejs.dev/config/
export default defineConfig({
  // 构建插件：@vitejs/plugin-vue 负责编译 .vue 单文件组件，@tailwindcss/vite 负责生成原子化样式。
  plugins: [vue(), tailwindcss()],
  // 资源基址使用相对路径：uTools 以本地文件方式打开 dist/index.html，
  // 若使用默认的绝对路径“/assets/...”，资源会指向磁盘根目录而加载失败。
  base: './'
})
