// 业务页面组件：插件体量较小，统一静态引入，避免懒加载造成页面切换白屏。
import { createMemoryHistory, createRouter } from 'vue-router'
import SkillsView from '../views/SkillsView.vue'
import GroupsView from '../views/GroupsView.vue'
import ApplicationsView from '../views/ApplicationsView.vue'
import AgentsView from '../views/AgentsView.vue'
import SettingsView from '../views/SettingsView.vue'

// uTools 使用本地 HTML 入口，内存路由可以避免刷新时产生文件路径错误。
const router = createRouter({
  // createMemoryHistory：路由状态只保存在内存中，不写入地址栏，
  // 因此不会因 file:// 协议解析路径出错，也不需要服务端提供 history 回退支持。
  history: createMemoryHistory(),
  routes: [
    // 默认重定向：进入插件后直接展示 Skills 仓库页。
    { path: '/', redirect: '/skills' },
    // Skills 仓库：选择统一仓库目录并扫描其中的 SKILL.md。
    { path: '/skills', name: 'skills', component: SkillsView },
    // 分组管理：把常用 Skills 组合成可复用分组。
    { path: '/groups', name: 'groups', component: GroupsView },
    // 应用配置：为指定 Agent 开启/关闭分组，从而增删其目录下的 Skills 链接。
    { path: '/applications', name: 'applications', component: ApplicationsView },
    // Agents：维护 Agent 名称与其 Skills 目录。
    { path: '/agents', name: 'agents', component: AgentsView },
    // 设置：主题切换与本地数据清除。
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})

// 导出路由实例，供 src/main.js 注册到 Vue 应用。
export default router
