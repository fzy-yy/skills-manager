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

// ============ 一、依赖引入 ============
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

// ============ 二、应用实例与全局插件 ============
// 创建插件应用，并统一注册状态管理与页面路由。
// 创建 Vue 根实例，最终挂载到 index.html 中的 #app 容器。
const app = createApp(App);
// 创建 Pinia 实例，作为全局状态的容器。
const pinia = createPinia();

// 安装顺序约束：Pinia 必须先于 Router 安装，因为路由首屏组件在渲染时就会调用 appStore；
// 反之会出现“在 setup 中调用 useAppStore 但未安装 Pinia”的运行时错误。
// 两者用链式调用而非分开写，是为了保证安装顺序在代码上直观可读。
// 先安装 Pinia 再安装路由：保证路由首屏组件渲染时状态仓库已经可用。
app.use(pinia).use(router);
// 在组件树之外取出状态仓库实例（显式传入 pinia，避免脱离组件上下文时取不到实例）。
// 后面的全局错误处理需要直接在组件树之外使用 store，因此这里必须提前取一次实例。
const store = useAppStore(pinia);

// ============ 三、全局错误兜底 ============
// 捕获组件渲染和未处理 Promise 错误，确保意外异常也会给出可见提示。
// 设计约定：所有异常统一走 store.notify 输出到右下角提示层，
// 不使用 alert 或直接抛到控制台，以免打断用户操作而丢失当前页面状态。
// 局限说明：该处理器只接管 Vue 组件树内的同步异常，
// 定时器回调、事件监听器与原生窗口错误不会进入这里，所以下面还要单独监听 Promise 异常。
// 组件渲染、生命周期钩子、事件处理器中抛出的异常都会进入该处理器，避免界面静默失败。
app.config.errorHandler = (error) => {
  store.notify(`界面发生错误：${error?.message || "未知错误"}`, "error");
};
// event.reason 可能是 Error，也可能是字符串或任意值，
// 因此这里做了两级取值兜底，避免因为异常对象不合规而把提示层再次弄崩。
// 未被 catch 的 Promise 异常（例如 preload 服务抛出的错误）同样给出错误提示。
window.addEventListener("unhandledrejection", (event) => {
  store.notify(
    `操作发生未处理错误：${event.reason?.message || String(event.reason || "未知错误")}`,
    "error",
  );
});

// ============ 四、挂载启动 ============
// 挂载时机约束：必须先完成 Pinia 与 Router 的注册再 mount，
// 否则首屏组件访问 store 或路由信息时会直接报错，表现为插件打开后界面空白。
// 选择器 #app 必须与 index.html 中的容器 id 完全一致；挂载后该容器内容由 Vue 接管，
// 因此不要在 index.html 里写入任何占位内容（会被直接覆盖）。
// 挂载根组件；进入插件时的初始化逻辑在 App.vue 的 onMounted 中执行。
app.mount("#app");
