/** uTools 使用本地 HTML，内存路由可避免刷新时解析成文件路径。 */
import { createMemoryHistory, createRouter } from "vue-router";
import SkillsView from "../views/SkillsView.vue";
import GroupsView from "../views/GroupsView.vue";
import ApplicationsView from "../views/ApplicationsView.vue";
import AgentsView from "../views/AgentsView.vue";
import SettingsView from "../views/SettingsView.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", redirect: "/skills" },
    { path: "/skills", name: "skills", component: SkillsView },
    { path: "/groups", name: "groups", component: GroupsView },
    {
      path: "/applications",
      name: "applications",
      component: ApplicationsView,
    },
    { path: "/agents", name: "agents", component: AgentsView },
    { path: "/settings", name: "settings", component: SettingsView },
  ],
});

export default router;
