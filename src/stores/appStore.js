/**
 * 全局状态仓库（Pinia + 组合式 API 写法）。
 *
 * 本文件只做装配与编排，具体实现分别位于：
 *  - stores/operation-runner.js：忙碌标记、串行守卫、统一提示与确认框；
 *  - stores/repository.js：仓库路径、Skills、分组、Agent、启用关系与受管链接；
 *  - stores/theme.js：外观主题与 <html> 类名同步。
 *
 * 页面只需要认识这一个仓库，不必了解内部分工。
 *
 * 约定：所有会改动配置或文件系统的动作都返回 Promise 且**永不 reject**；
 * 失败时已经由 execute 统一提示并返回 null，页面用返回值判断成败即可。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { createOperationRunner } from "./operation-runner";
import { hasPreloadApi } from "./preload-api";
import { createRepositoryController } from "./repository";
import { createThemeController } from "./theme";

export const useAppStore = defineStore("app", () => {
  const {
    busy,
    confirm,
    dialog,
    dismissNotice,
    execute,
    isInFlight,
    notices,
    notify,
    reportIssues,
    resolveDialog,
    waitUntilIdle,
  } = createOperationRunner();
  const theme = createThemeController({ execute, waitUntilIdle });
  const repository = createRepositoryController({
    execute,
    isInFlight,
    notify,
    reportIssues,
    applyTheme: theme.applyFromState,
  });
  const ready = ref(false);

  /**
   * 插件启动时读取 uTools userData 下的本地配置，并同步到界面。
   * 未运行在 uTools 环境时退化为浅色主题，保证在浏览器预览时仍可用。
   */
  async function initialize() {
    try {
      if (hasPreloadApi()) {
        await repository.readStateFromPreload();
        repository.replayPendingSkillSync();
      } else theme.applyTheme("light");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      ready.value = true;
    }
  }

  /**
   * 重新进入插件时的轻量同步。
   *
   * uTools 按 Esc 只是把插件隐藏到后台、进程与页面状态都会保留，
   * 因此每次进入都重读一次配置，避免界面长期停留在上次退出时的旧数据上。
   * 只读缓存、不扫描仓库，开销可以忽略。
   */
  async function syncOnEnter() {
    if (!hasPreloadApi() || isInFlight()) return;
    try {
      await repository.readStateFromPreload();
    } catch (error) {
      notify(error.message, "error");
    }
  }

  return {
    // 仓库域状态与动作
    repositoryPath: repository.repositoryPath,
    skills: repository.skills,
    groups: repository.groups,
    agents: repository.agents,
    enabledSkills: repository.enabledSkills,
    agentSyncIssues: repository.agentSyncIssues,
    emptyRepository: repository.emptyRepository,
    chooseDirectory: repository.chooseDirectory,
    setRepository: repository.setRepository,
    refreshSkills: repository.refreshSkills,
    saveGroups: repository.saveGroups,
    upsertAgent: repository.upsertAgent,
    deleteAgent: repository.deleteAgent,
    clearData: repository.clearData,
    setAgentSkills: repository.setAgentSkills,
    flushPendingSkillSync: repository.flushPendingSkillSync,
    // 外观主题
    theme: theme.theme,
    setTheme: theme.setTheme,
    // 核心状态与全局反馈
    ready,
    busy,
    notices,
    dialog,
    notify,
    confirm,
    resolveDialog,
    dismissNotice,
    initialize,
    syncOnEnter,
  };
});
