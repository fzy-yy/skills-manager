<!--
  App.vue —— 插件根组件（整体页面骨架）。

  页面结构（自上而下）：
  1. 顶部固定导航栏：五个业务页面的切换入口，使用 RouterLink 高亮当前页；
  2. 主内容区：<RouterView> 渲染当前路由对应的页面（自带滚动）；
  3. 全局提示层：右下角浮层，展示 appStore.notices 中的成功/错误/警告提示；
  4. 顶部进度条：store.busy 为真时显示，表示有耗时操作正在执行；
  5. 全局确认对话框：只挂载一次，由 appStore.dialog 驱动。

  uTools 集成：在 onMounted 中调用 store.initialize() 读取本地配置，
  并通过 utools.onPluginEnter 注册“进入插件”回调，从搜索入口进入时回到仓库首页。
-->
<script setup>
// ============ 一、依赖导入 ============
// lucide 图标：五个导航图标 + 提示卡片的关闭（X）、成功（Check）、警示（CircleAlert）图标。
import {
  Bot,
  Database,
  Layers3,
  Link2,
  Settings2,
  X,
  Check,
  CircleAlert,
} from "@lucide/vue";
// onMounted：组件挂载完成后执行初始化与 uTools 事件注册。
import { onMounted } from "vue";
// RouterLink 用于导航高亮，RouterView 用于渲染页面，useRouter 用于代码式跳转。
import { RouterLink, RouterView, useRouter } from "vue-router";
// 全局确认对话框组件。
import ConfirmDialog from "./components/ConfirmDialog.vue";
// 全局状态仓库。
import { useAppStore } from "./stores/appStore";

// ============ 二、全局状态与路由实例 ============
// App.vue 是插件唯一的根组件，全局状态与路由实例在此取得后向下共享给各业务页面。
const store = useAppStore();
// 路由实例：用于 onPluginEnter 回调中切换页面。
const router = useRouter();

// ============ 三、顶部导航配置 ============
// 约束：tab.path 必须与 src/router/index.js 中注册的 path 完全一致，
// 否则 RouterLink 匹配不到路由，会出现“点击无反应且当前页不高亮”的问题。
// 顶部导航配置：path 与 src/router/index.js 中的路由一一对应，icon 为 lucide 组件。
const tabs = [
  { path: "/skills", label: "Skills 仓库", icon: Database },
  { path: "/groups", label: "分组管理", icon: Layers3 },
  { path: "/applications", label: "应用配置", icon: Link2 },
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/settings", label: "设置", icon: Settings2 },
];

// ============ 四、初始化与 uTools 事件绑定 ============
onMounted(() => {
  // 读取 uTools 本地数据库中的配置，初始化仓库路径、分组、Agent 与主题。
  store.initialize();
  // initialize 内部已捕获异常并统一用全局提示告知用户，这里再包一层 try/catch 会造成同一错误提示两次。
  // 每次从 uTools 搜索入口进入时回到仓库首页。
  // window.utools 只在 uTools 环境中存在，浏览器预览时使用可选链跳过。
  // uTools 没有提供 onPluginEnter 的注销接口，因此该回调只在根组件注册一次，避免重复挂载造成多次跳转。
  window.utools?.onPluginEnter(() => router.push("/skills"));
});
</script>

<template>
  <!-- 整体纵向布局：头部固定，主内容区自适应并自身滚动 -->
  <div class="flex h-full flex-col bg-canvas text-ink">
    <!-- 骨架顺序即层叠顺序：固定头部、可滚动主内容区，其后依次是提示层、进度条与确认对话框 -->
    <!-- 顶部导航栏：高度固定 64px，窄窗口（<760px）自动压缩左右内边距 -->
    <header
      class="flex h-16 shrink-0 items-center justify-center border-b border-border bg-surface px-6 max-[760px]:px-4"
    >
      <nav
        class="flex h-full items-stretch justify-center gap-1"
        aria-label="主导航"
      >
        <!-- 导航项：当前路由通过 active-class 添加主色文字与底部指示条 -->
        <RouterLink
          v-for="tab in tabs"
          :key="tab.path"
          :to="tab.path"
          class="relative flex min-w-27 items-center justify-center gap-2 px-3 font-bold text-ink-secondary hover:bg-canvas hover:text-ink max-[760px]:min-w-0 max-[760px]:px-2"
          active-class="text-primary after:absolute after:right-3 after:bottom-0 after:left-3 after:h-0.5 after:bg-primary"
          ><component :is="tab.icon" :size="17" :stroke-width="1.8" /><span>{{
            tab.label
          }}</span></RouterLink
        >
      </nav>
    </header>

    <!-- 页面出口：五个业务页面（Skills 仓库、分组管理、应用配置、Agents、设置）都在此渲染 -->
    <!-- 主内容区：min-h-0 保证内部滚动生效，overflow-auto 承载各页面的长内容 -->
    <main class="min-h-0 flex-1 overflow-auto">
      <RouterView v-if="store.ready" />
      <div
        v-else
        class="grid min-h-full place-items-center p-6 text-sm font-semibold text-ink-muted"
        role="status"
      >
        正在读取本地配置…
      </div>
    </main>

    <!-- 提示层数据来源：appStore.notify() 推送的 notices，最多保留 20 条、相同内容去重、error 类型保留更久 -->
    <!-- 全局提示层：右下角浮层，可滚动；aria-live 让读屏软件播报新提示 -->
    <div
      v-if="store.notices.length"
      class="fixed right-5 bottom-5 z-40 flex max-h-[min(70vh,520px)] w-[min(480px,calc(100vw-40px))] flex-col gap-2 overflow-y-auto"
      aria-live="polite"
    >
      <!-- 单条提示卡片：error 用实心红底，warning/info 用描边浅底，success 用深色底 -->
      <div
        v-for="notice in store.notices"
        :key="notice.id"
        class="flex min-h-11 items-start gap-2.5 rounded-lg px-3 py-2.5 shadow-xl"
        :class="
          notice.type === 'error'
            ? 'bg-danger text-on-primary'
            : notice.type === 'warning'
              ? 'border border-warning bg-warning-soft text-warning'
              : notice.type === 'info'
                ? 'border border-primary-border bg-primary-soft text-primary'
                : 'bg-ink text-surface'
        "
        :role="notice.type === 'error' ? 'alert' : 'status'"
      >
        <!-- 图标：错误/警告用警示图标，其余用勾选图标 -->
        <CircleAlert
          v-if="notice.type === 'error' || notice.type === 'warning'"
          class="mt-0.5 shrink-0"
          :size="17"
        />
        <Check v-else class="mt-0.5 shrink-0" :size="17" />
        <span class="min-w-0 flex-1 wrap-break-word leading-5">{{
          notice.message
        }}</span>
        <!-- 提示文案使用换行兜底样式，长路径或长报错不会撑破卡片宽度 -->
        <!-- 关闭按钮：手动关闭提示并清理其自动关闭定时器 -->
        <button
          class="grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent text-current hover:opacity-70"
          type="button"
          aria-label="关闭提示"
          @click="store.dismissNotice(notice.id)"
        >
          <X :size="16" />
        </button>
      </div>
    </div>

    <!-- busy 由 appStore.execute 包裹的耗时操作统一维护，本组件只读该状态，不参与并发控制 -->
    <!-- 顶部进度条：耗时操作进行中显示，z-60 保证覆盖在导航与提示层之上 -->
    <div
      v-if="store.busy"
      class="fixed top-0 left-0 z-60 h-0.5 w-full bg-primary"
      aria-label="处理中"
    />
    <!-- 约束：全局只挂载一次；其他页面请调用 store.confirm(...)，不要自行实现确认弹窗 -->
    <!-- 全局确认对话框：内容与结果均由 appStore 管理 -->
    <ConfirmDialog :dialog="store.dialog" @resolve="store.resolveDialog" />
  </div>
</template>
