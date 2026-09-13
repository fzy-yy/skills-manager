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
  const notices = ref([])
  const dialog = ref({ open: false, title: '', message: '', confirmText: '确定', cancelText: '取消', tone: 'primary' })

  let noticeSequence = 0
  const noticeTimers = new Map()
  let dialogResolver

  const hasRepository = computed(() => Boolean(repositoryPath.value))

  function api () {
    if (!window.skillsManager) throw new Error('请在 uTools 开发环境中运行插件以使用本地目录功能')
    return window.skillsManager
  }

  function applyState (next) {
    // 部分接口（例如主题切换）只返回变更字段，避免无关状态被意外清空。
    if (Object.hasOwn(next, 'repositoryPath')) repositoryPath.value = next.repositoryPath || ''
    if (Object.hasOwn(next, 'skills')) skills.value = Array.isArray(next.skills) ? next.skills : []
    if (Object.hasOwn(next, 'groups')) groups.value = Array.isArray(next.groups) ? next.groups : []
    if (Object.hasOwn(next, 'agents')) agents.value = Array.isArray(next.agents) ? next.agents : []
    if (Object.hasOwn(next, 'enabledGroups')) enabledGroups.value = next.enabledGroups || {}
    if (Object.hasOwn(next, 'theme')) theme.value = next.theme === 'dark' ? 'dark' : 'light'
    document.documentElement.classList.toggle('dark', theme.value === 'dark')
  }

  function dismissNotice (id) {
    notices.value = notices.value.filter(notice => notice.id !== id)
    clearTimeout(noticeTimers.get(id))
    noticeTimers.delete(id)
  }

  function notify (message, type = 'success', duration = 5200) {
    if (!message) return
    const id = ++noticeSequence
    notices.value.push({ id, message: String(message), type })
    // 错误保留更久；多条问题会同时展示，避免后一个提示覆盖前一个错误。
    const timeout = type === 'error' ? Math.max(duration, 9000) : duration
    noticeTimers.set(id, setTimeout(() => dismissNotice(id), timeout))
  }

  function reportIssues (issues) {
    const safeIssues = Array.isArray(issues) ? issues : []
    safeIssues.forEach(issue => notify(issue?.message, issue?.type || 'warning'))
    return safeIssues
  }

  async function execute (operation, successMessage) {
    busy.value = true
    try {
      const result = await operation()
      if (result) applyState(result)
      const issues = reportIssues(result?.issues)
      if (successMessage && !issues.some(issue => issue?.type === 'error')) notify(successMessage)
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
      if (window.skillsManager) {
        const result = await api().getState()
        applyState(result)
        reportIssues(result?.issues)
      }
      else document.documentElement.classList.remove('dark')
    } catch (error) {
      notify(error.message, 'error')
    } finally {
      ready.value = true
    }
  }

  async function setTheme (nextTheme) {
    if (nextTheme !== 'light' && nextTheme !== 'dark') return false
    const previousTheme = theme.value
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    theme.value = nextTheme
    try {
      if (window.skillsManager) {
        const result = await api().setTheme(nextTheme)
        applyState(result)
        reportIssues(result?.issues)
      }
      return true
    } catch (error) {
      theme.value = previousTheme
      document.documentElement.classList.toggle('dark', previousTheme === 'dark')
      notify(error.message, 'error')
      return false
    }
  }

  function toggleTheme () {
    return setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  return {
    repositoryPath, skills, groups, agents, enabledGroups, theme, ready, busy, notices, dialog, hasRepository,
    initialize, setTheme, toggleTheme, notify, confirm, resolveDialog,
    dismissNotice,
    chooseDirectory: current => api().chooseDirectory(current),
    setRepository: directory => execute(() => api().setRepository(directory), 'Skills 仓库已更新'),
    refreshSkills: () => execute(() => api().refreshSkills(), '已重新扫描 Skills'),
    saveGroups: nextGroups => execute(() => api().saveGroups(nextGroups), '分组已保存'),
    upsertAgent: agent => execute(() => api().upsertAgent(agent), agent.id ? 'Agent 已更新' : 'Agent 已添加'),
    deleteAgent: id => execute(() => api().deleteAgent(id), 'Agent 已删除，相关链接已清理'),
    clearData: () => execute(() => api().clearData(), '本地数据已清除'),
    setAgentGroups: (agentId, groupIds) => execute(() => api().setAgentGroups(agentId, groupIds), '链接配置已同步')
  }
})
