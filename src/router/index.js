/**
 * 页面路由表（Vue Router 4，运行在 uTools 渲染进程）。
 *
 * 本文件只做两件事：声明“路径到页面组件”的映射关系，以及选择路由模式。
 * 数据加载、状态校验与失败提示全部由 src/stores/appStore.js 负责，
 * 因此这里不需要也不能写数据获取逻辑，否则会出现“刷新后状态不一致”的问题。
 *
 * 各路由对应的页面职责：
 *   /skills       统一 Skills 仓库：选择仓库目录、扫描其中的 SKILL.md、查看与筛选 Skill；
 *   /groups       分组管理：把多个 Skill 组合成可复用分组；
 *   /applications 应用配置：为指定 Agent 勾选分组，从而增删其目录下的 Skill 链接；
 *   /agents       Agent 管理：维护 Agent 名称与其对应的 Skills 目录；
 *   /settings     设置：主题切换与本地数据清除。
 *
 * 关键约定：
 *  1. 采用内存路由（见下方说明），没有可分享的 URL，页面跳转一律走 router.push；
 *  2. 当前未定义任何全局守卫（如 beforeEach）：主题、仓库路径等前置条件由 App.vue 启动
 *     时统一初始化，若后续新增权限或未初始化拦截，应在此文件集中添加而不要散到各页面；
 *  3. 新增页面时必须同步补充 App.vue 顶部导航项，否则页面只能通过代码跳转访问。
 */

// ============ 一、依赖与页面组件引入 ============
// 业务页面组件：插件体量较小，统一静态引入，避免懒加载造成页面切换白屏。
import { createMemoryHistory, createRouter } from "vue-router";
import SkillsView from "../views/SkillsView.vue";
import GroupsView from "../views/GroupsView.vue";
import ApplicationsView from "../views/ApplicationsView.vue";
import AgentsView from "../views/AgentsView.vue";
import SettingsView from "../views/SettingsView.vue";

// ============ 二、路由实例与路由表 ============
// uTools 使用本地 HTML 入口，内存路由可以避免刷新时产生文件路径错误。
// 路由表保持平铺结构（不做嵌套路由）：因为所有页面都是同级切换，
// 没有共享布局的需求（顶部导航由 App.vue 直接书写，不参与路由匹配），
// 引入嵌套反而会增加命名视图与出口的复杂度。
const router = createRouter({
  // createMemoryHistory：路由状态只保存在内存中，不写入地址栏，
  // 因此不会因 file:// 协议解析路径出错，也不需要服务端提供 history 回退支持。
  // 为何不用 createWebHashHistory：hash 虽也能在 file:// 下工作，
  // 但插件重新打开时会保留上一次的 hash，出现“启动后停在旧页面”的意外跳转，
  // 而内存路由每次启动都从 "/" 开始，与 onPluginEnter 跳转 /skills 的约定一致。
  // 副作用提醒：由于不写入地址栏，刷新页面或重新打开插件后路由会重置，
  // 需要“记住上次位置”时只能依赖 appStore 落盘的状态，不能依赖 URL。
  history: createMemoryHistory(),
  routes: [
    // 路由项的 name 供编程式跳转（router.push({ name: ... })）与调试时使用；
    // 顶部导航仍以 path 作为唯一凭证，两者的对应关系由 App.vue 维护，新增页面时两边要同步修改。
    // 默认重定向：进入插件后直接展示 Skills 仓库页。
    // 用 redirect 而不直接把 SkillsView 挂在 "/"，是为了让每个页面都有唯一路径，
    // 保证 App.vue 的导航高亮与 onPluginEnter 跳转能按统一路径匹配。
    { path: "/", redirect: "/skills" },
    // Skills 仓库：选择统一仓库目录并扫描其中的 SKILL.md。
    // 该页是插件的默认落地页：仓库目录未配置时只展示引导态，不自动扫描磁盘，
    // 避免首次打开插件就因遍历大目录而卡住界面。
    { path: "/skills", name: "skills", component: SkillsView },
    // 分组管理：把常用 Skills 组合成可复用分组。
    // 分组只保存 Skill 的 id 列表（见 appStore 的 groups），不缓存路径，
    // 因此仓库迁移或 Skill 重命名后需由应用配置页重新同步。
    { path: "/groups", name: "groups", component: GroupsView },
    // 应用配置：通过分组或单项开关维护 Agent 的 Skills 链接。
    // 高频开关采用防抖合并与失败回滚，不弹确认框；底层只会删除本应用确认归属的受管链接。
    {
      path: "/applications",
      name: "applications",
      component: ApplicationsView,
    },
    // Agents：维护 Agent 名称与其 Skills 目录。
    // Agent 名称在本地数据中充当逻辑标识，删除 Agent 前必须先确认链接清理策略，
    // 否则会残留指向已删除 Skill 的死链接。
    { path: "/agents", name: "agents", component: AgentsView },
    // 设置：主题切换与本地数据清除。
    // 该页的“清除本地数据”不可逆，必须经确认对话框后再调用 preload 服务；
    // 主题选择会同步落盘，因此下次启动插件时仍保持用户上次选定的主题。
    { path: "/settings", name: "settings", component: SettingsView },
  ],
});

// ============ 三、路由导出 ============
// 导出路由实例，供 src/main.js 注册到 Vue 应用。
export default router;
