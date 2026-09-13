/**
 * Vite 构建配置（uTools 插件应用的打包入口）。
 *
 * 本文件的目标只有一个：把 Vue 单文件组件、TypeScript 无关的 JS 与 Tailwind 样式
 * 编译成 uTools 能直接加载的静态 html / css / js 产物。
 *
 * 关键约束（违反了会直接导致插件白屏或样式丢失）：
 *  1. 产物必须能用相对路径寻址：uTools 以 file:// 打开 dist/index.html，
 *     任何依赖绝对路径“/assets/...”或服务端路由回退的写法都会加载失败；
 *  2. Tailwind 必须通过官方 Vite 插件接入：v4 已取消 tailwind.config.js 与 postcss.config.js，
 *     样式全部由 src/main.css 里的 @import 与 @theme 声明，移除该插件会让整体样式直接失效；
 *  3. 保持“零自定义”原则：不配置 alias、devServer、手动分包等选项，
 *     因为插件体量小、无需热更新代理与代码分割，额外配置只会抬高调试成本。
 *
 * 注意：本文件只影响构建结果，运行时行为（本地文件读写、uTools 原生能力）
 * 全部由预加载脚本 public/preload/services.js 通过 window.skillsManager 提供。
 */

// ============ 一、依赖引入 ============
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// ============ 二、构建选项 ============
// Vite 构建配置：把 Vue 单文件组件与 Tailwind 样式编译成 uTools 可直接加载的 html/css/js。
// https://vitejs.dev/config/
export default defineConfig({
  // 构建插件：@vitejs/plugin-vue 负责编译 .vue 单文件组件，@tailwindcss/vite 负责生成原子化样式。
  // 注意：两个插件缺一不可且顺序保持不变，删除 tailwindcss 不会报错，
  // 但 src/main.css 中的 @theme 内联（inline）声明将不被处理，所有语义类（bg-canvas、text-ink）会全部失效。
  plugins: [vue(), tailwindcss()],
  // 构建配置说明：当前文件刻意不设置 build.outDir、assetsDir、rollupOptions 等选项，
  // 一律沿用 Vite 默认值（产物输出到 dist/、资源文件名带内容哈希），
  // 以便直接用 uTools 开发者工具选中 dist 目录发布，不需要额外的目录搬运步骤。
  // base 的取值同时对 index.html 中 script 的 src 与 CSS 内部引用的资源生效，
  // 因此这里不要改成 "/" 或其他值，也不要额外设置 build.assetsDir，
  // 否则产物中的资源引用会全部失效（页面上表现为白屏，控制台报 404 或 net::ERR_FILE_NOT_FOUND）。
  // 资源基址使用相对路径：uTools 以本地文件方式打开 dist/index.html，
  // 若使用默认的绝对路径“/assets/...”，资源会指向磁盘根目录而加载失败。
  base: "./",
});

// 补充说明：因为 uTools 插件只识别 html / css / js 三种产物，
// 所以无需配置 build.lib 或额外的资源拷贝插件，保持单页构建即可。
