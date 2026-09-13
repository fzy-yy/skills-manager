import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

// Pinia 统一管理业务数据、主题、全局提示与确认对话框。
export const useAppStore = defineStore('app', () => {
  const repositoryPath = ref('')
  const skills = ref([])
  const groups = ref([])
  const agents = ref([])
  const enabledGroups = ref({})
  const theme = ref('light')
  const ready = ref(false)
  const busy = ref(false)
  const notice = ref(null)
  const dialog = ref({ open: false, title: '', message: '', confirmText: '确定', cancelText: '取消', tone: 'primary' })

  let noticeTimer
  let dialogResolver

  const hasRepository = computed(() => Boolean(repositoryPath.value))

  function api () {
    if (!window.skillsManager) throw new Error('请在 uTools 开发环境中运行插件以使用本地目录功能')
    return window.skillsManager
  }

  function applyState (next) {
    repositoryPath.value = next.repositoryPath || ''
    skills.value = next.skills || []
    groups.value = next.groups || []
    agents.value = next.agents || []
    enabledGroups.value = next.enabledGroups || {}
    theme.value = next.theme === 'dark' ? 'dark' : 'light'
    document.documentElement.classList.toggle('dark', theme.value === 'dark')
  }

  function notify (message, type = 'success') {
    notice.value = { message, type }
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.value = null }, 3600)
  }

  async function execute (operation, successMessage) {
    busy.value = true
    try {
      const result = await operation()
      if (result) applyState(result)
      if (successMessage) notify(successMessage)
      return result
    } catch (error) {
      notify(error?.message || '操作失败，请重试', 'error')
      throw error
    } finally {
      busy.value = false
    }
  }

  // 返回 Promise，让业务页面可以用统一方式等待用户选择。
  function confirm (options) {
    if (dialogResolver) dialogResolver(false)
    dialog.value = {
      open: true,
      title: options.title || '请确认',
      message: options.message || '',
      confirmText: options.confirmText || '确定',
      cancelText: options.cancelText || '取消',
      tone: options.tone || 'primary'
    }
    return new Promise(resolve => { dialogResolver = resolve })
  }

  function resolveDialog (accepted) {
    dialog.value.open = false
    dialogResolver?.(accepted)
    dialogResolver = null
  }

  async function initialize () {
    try {
      if (window.skillsManager) applyState(await api().getState())
      else document.documentElement.classList.remove('dark')
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      ready.value = true
    }
  }

  async function setTheme (nextTheme) {
    if (nextTheme !== 'light' && nextTheme !== 'dark') return false
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    theme.value = nextTheme
    try {
      if (window.skillsManager) applyState(await api().setTheme(nextTheme))
      return true
    } catch (error) {
      notify(error.message, 'error')
      return false
    }
  }

  function toggleTheme () {
    return setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  return {
    repositoryPath, skills, groups, agents, enabledGroups, theme, ready, busy, notice, dialog, hasRepository,
    initialize, setTheme, toggleTheme, notify, confirm, resolveDialog,
    dismissNotice: () => { notice.value = null },
    chooseDirectory: current => api().chooseDirectory(current),
    setRepository: directory => execute(() => api().setRepository(directory), 'Skills 仓库已更新'),
    refreshSkills: () => execute(() => api().refreshSkills(), '已重新扫描 Skills'),
    saveGroups: nextGroups => execute(() => api().saveGroups(nextGroups), '分组已保存'),
    upsertAgent: agent => execute(() => api().upsertAgent(agent), agent.id ? 'Agent 已更新' : 'Agent 已添加'),
    deleteAgent: id => execute(() => api().deleteAgent(id), 'Agent 已删除，相关链接已清理'),
    setAgentGroups: (agentId, groupIds) => execute(() => api().setAgentGroups(agentId, groupIds))
  }
})
