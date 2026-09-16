/** uTools 使用本地 HTML，内存路由可避免刷新时解析成文件路径。 */
import { Bot, Database, Layers3, Link2, Settings2 } from "@lucide/vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ApplicationsView from "../views/ApplicationsView.vue";
import AgentsView from "../views/AgentsView.vue";
import GroupsView from "../views/GroupsView.vue";
import SettingsView from "../views/SettingsView.vue";
import SkillsView from "../views/SkillsView.vue";

/**
 * 顶部导航页面的路由定义。
 * meta 中的 label / icon 同时供 App.vue 生成顶部导航栏，
 * 使路由与导航文案在同一处维护，不会出现两边 path 不一致的问题。
 */
const navigationRoutes = [
  {
    path: "/skills",
    name: "skills",
    component: SkillsView,
    meta: { label: "Skills 仓库", icon: Database },
  },
  {
    path: "/groups",
    name: "groups",
    component: GroupsView,
    meta: { label: "分组管理", icon: Layers3 },
  },
  {
    path: "/applications",
    name: "applications",
    component: ApplicationsView,
    meta: { label: "应用配置", icon: Link2 },
  },
  {
    path: "/agents",
    name: "agents",
    component: AgentsView,
    meta: { label: "Agents", icon: Bot },
  },
  {
    path: "/settings",
    name: "settings",
    component: SettingsView,
    meta: { label: "设置", icon: Settings2 },
  },
];

/** 顶部导航项（App.vue 使用）：从路由定义派生，保证与路由始终一致。 */
export const navigationTabs = navigationRoutes.map((route) => ({
  path: route.path,
  label: route.meta.label,
  icon: route.meta.icon,
}));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", redirect: "/skills" }, ...navigationRoutes],
});

export default router;
