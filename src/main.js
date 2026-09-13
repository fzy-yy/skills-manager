/**
 * 插件应用前端入口（运行在 uTools 渲染进程中）。
 *
 * 主要职责：
 *  1. 创建 Vue 应用实例，并安装 Pinia（状态管理）与 Vue Router（页面路由）；
 *  2. 在应用启动前准备好全局状态仓库，供组件与错误处理逻辑使用；
 *  3. 兜底捕获组件渲染异常与未处理的 Promise 异常，统一转换为界面提示。
 *
 * 注意：本地文件读写、uTools 原生 API 等能力不在这里调用，
 * 它们由预加载脚本 public/preload/services.js 通过 window.skillsManager 暴露给前端。
 */

// Vue 3 应用工厂函数。
import { createApp } from "vue";
// Pinia 状态管理库，集中管理仓库路径、Skills、分组、Agent、主题与全局提示。
import { createPinia } from "pinia";
// 根组件：承载顶部导航、页面出口、全局提示层与确认对话框。
import App from "./App.vue";
// 路由实例：管理 Skills 仓库 / 分组管理 / 应用配置 / Agents / 设置 五个页面的切换。
import router from "./router";
// 全局状态仓库，用于读取配置、推送提示、弹出确认框。
import { useAppStore } from "./stores/appStore";
// 全局样式入口（Tailwind 指令 + 浅色/深色主题令牌）。
import "./main.css";

// 创建插件应用，并统一注册状态管理与页面路由。
// 创建 Vue 根实例，最终挂载到 index.html 中的 #app 容器。
const app = createApp(App);
// 创建 Pinia 实例，作为全局状态的容器。
const pinia = createPinia();

// 先安装 Pinia 再安装路由：保证路由首屏组件渲染时状态仓库已经可用。
app.use(pinia).use(router);
// 在组件树之外取出状态仓库实例（显式传入 pinia，避免脱离组件上下文时取不到实例）。
const store = useAppStore(pinia);

// 捕获组件渲染和未处理 Promise 错误，确保意外异常也会给出可见提示。
// 组件渲染、生命周期钩子、事件处理器中抛出的异常都会进入该处理器，避免界面静默失败。
app.config.errorHandler = (error) => {
  store.notify(`界面发生错误：${error?.message || "未知错误"}`, "error");
};
// 未被 catch 的 Promise 异常（例如 preload 服务抛出的错误）同样给出错误提示。
window.addEventListener("unhandledrejection", (event) => {
  store.notify(
    `操作发生未处理错误：${event.reason?.message || String(event.reason || "未知错误")}`,
    "error",
  );
});

// 挂载根组件；进入插件时的初始化逻辑在 App.vue 的 onMounted 中执行。
app.mount("#app");
