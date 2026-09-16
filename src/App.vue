<script setup>
// ============ 一、依赖导入 ============
// lucide 图标：五个导航图标 + 提示卡片的关闭（X）、成功（Check）、警示（CircleAlert）图标。
import { Bot, Database, Layers3, Link2, Settings2 } from "@lucide/vue";
// onMounted：组件挂载完成后执行初始化与 uTools 事件注册。
import { onMounted } from "vue";
// RouterLink 用于导航高亮，RouterView 用于渲染页面，useRouter 用于代码式跳转。
import { RouterLink, RouterView, useRouter } from "vue-router";
// 全局确认对话框组件。
import ConfirmDialog from "./components/ConfirmDialog.vue";
import NoticeStack from "./components/NoticeStack.vue";
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
  // 读取 uTools userData 下的本地配置，初始化仓库路径、分组、Agent 与主题。
  store.initialize();
  // initialize 内部已捕获异常并统一用全局提示告知用户，这里再包一层 try/catch 会造成同一错误提示两次。
  // uTools 没有提供 onPluginEnter / onPluginOut 的注销接口，因此这些回调只在根组件注册一次，
  // 避免重复挂载造成多次跳转与重复提交。
  // window.utools 只在 uTools 环境中存在，浏览器预览时使用可选链跳过。
  //
  // 每次从 uTools 搜索入口进入时回到仓库首页，并重读一次本地配置：
  // 插件被隐藏到后台时进程不会重启、页面状态会保留，不重读就会一直显示上次退出时的旧数据。
  window.utools?.onPluginEnter?.(() => {
    router.push("/skills");
    store.syncOnEnter();
  });
  // 隐藏到后台时异步提交可以继续完成；进程结束时 uTools 不会等待 Promise，
  // 因此这里只做 best-effort 排空，最后选择已在点击时同步写入本机意图日志供下次恢复。
  window.utools?.onPluginOut?.((isKill) => {
    void store.flushPendingSkillSync(isKill ? { timeout: 0 } : undefined);
  });
});
</script>

<template>
  <div class="flex h-full flex-col bg-canvas text-ink">
    <header
      class="flex h-16 shrink-0 items-center justify-center border-b border-border bg-surface px-6 max-[760px]:px-4"
    >
      <nav
        class="flex h-full items-stretch justify-center gap-1"
        aria-label="主导航"
      >
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

    <NoticeStack :notices="store.notices" @dismiss="store.dismissNotice" />

    <div
      v-if="store.busy"
      class="fixed top-0 left-0 z-60 h-0.5 w-full bg-primary"
      aria-label="处理中"
    />
    <ConfirmDialog
      :dialog="store.dialog"
      :disabled="store.busy"
      @resolve="store.resolveDialog"
    />
  </div>
</template>
