/**
 * 全局状态仓库（Pinia + 组合式 API 写法）。
 *
 * 该仓库是前端与 uTools 预加载服务之间唯一的桥梁：
 *  - 所有本地文件操作、uTools API 调用都通过 window.skillsManager（public/preload/services.js 暴露）；
 *  - 所有页面共享同一份状态（仓库路径、Skills、分组、Agent、启用关系、主题）；
 *  - 统一承担“操作中”标记、全局提示与确认对话框，避免每个页面重复实现。
 *
 * 约定：凡是会改动配置或文件系统的动作，都返回 Promise，
 * 页面可通过 await 或 try/catch 感知执行结果（失败信息已由本仓库统一提示）。
 *
 * 并发与一致性设计（改动本文件前请先读完以下三点）：
 *  1. 文件与配置操作全局串行（operationInFlight）：链接同步会读写同一批目录，
 *     并发的两轮同步各自基于旧快照计算增删，最终会留下无法追踪的残留链接；
 *  2. 应用配置开关属于高频操作，采用「乐观更新 + 300ms 防抖合并 + 失败回滚」，
 *     只把每个 Agent 的最终选择提交一次，避免快速连点产生大量磁盘写入与界面卡顿；
 *  3. 服务端的只读保护（本地配置异常时禁止一切写操作）由 preload 抛错体现，
 *     本仓库不自行拦截，只把错误提示给用户并在必要时回滚界面状态。
 */

import { ref } from "vue";
import { defineStore } from "pinia";
import { createSkillSyncQueue } from "./skill-sync-queue";
import { createConfirmDialog, createNoticeCenter } from "./ui-feedback";

export const useAppStore = defineStore("app", () => {
  const repositoryPath = ref("");
  const skills = ref([]);
  const groups = ref([]);
  const agents = ref([]);
  const enabledSkills = ref({});
  const agentSyncIssues = ref({});
  const theme = ref("light");
  const ready = ref(false);
  const busy = ref(false);
  const { notices, dismissNotice, notify, reportIssues } = createNoticeCenter();
  const { dialog, confirm, resolveDialog } = createConfirmDialog();

  /** 记录某个 Agent 最近一次链接同步问题，空结果会清除旧提示。 */
  function setAgentSyncIssues(agentId, issues) {
    const normalized = Array.isArray(issues) ? issues : [];
    agentSyncIssues.value = {
      ...agentSyncIssues.value,
      [agentId]: normalized,
    };
  }

  let operationInFlight = false;
  /**
   * 获取 preload 暴露的本地能力对象。
   * 只有在 uTools 环境中（加载了 public/preload/services.js）才存在 window.skillsManager。
   *
   * @returns {object} window.skillsManager 实例
   * @throws {Error} 未在 uTools 环境运行时抛出可读错误，由调用方提示用户
   */
  function api() {
    if (!window.skillsManager)
      throw new Error("请在 uTools 开发环境中运行插件以使用本地目录功能");
    return window.skillsManager;
  }

  /** 让出一个宏任务，使 Vue 有机会先绘制忙碌状态和进度条。 */
  function waitForRender() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * 将后端（preload 服务）返回的状态增量合并到本地响应式状态。
   * 未出现在 next 中的字段保持原值不变。
   *
   * @param {object} next - 形如 { repositoryPath, skills, groups, agents, enabledSkills, theme, issues }
   */
  function applyState(next) {
    if (Object.hasOwn(next, "repositoryPath"))
      repositoryPath.value = next.repositoryPath || "";
    if (Object.hasOwn(next, "skills"))
      skills.value = Array.isArray(next.skills) ? next.skills : [];
    if (Object.hasOwn(next, "groups"))
      groups.value = Array.isArray(next.groups) ? next.groups : [];
    if (Object.hasOwn(next, "agents")) {
      agents.value = Array.isArray(next.agents) ? next.agents : [];
      const validAgentIds = new Set(agents.value.map((agent) => agent.id));
      agentSyncIssues.value = Object.fromEntries(
        Object.entries(agentSyncIssues.value).filter(([agentId]) =>
          validAgentIds.has(agentId),
        ),
      );
    }
    if (Object.hasOwn(next, "enabledSkills")) {
      enabledSkills.value = mergePendingSkillSelections(
        next.enabledSkills || {},
      );
    }
    if (Object.hasOwn(next, "theme"))
      theme.value = next.theme === "dark" ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  /**
   * 统一执行一次“可能改动本地状态”的业务操作。
   * 负责：置忙 → 调用接口 → 合并状态 → 展示问题 → 展示成功提示 → 异常兜底。
   *
   * @param {() => Promise<object>} operation - 实际调用 preload 服务的函数
   * @param {string} [successMessage] - 成功提示文案；若存在 error 级问题则不提示成功
   * @param {{reportResultIssues?: boolean}} [options] - 是否逐条展示服务端返回的问题
   * @returns {Promise<object>} preload 服务返回的最新状态
   */
  async function execute(
    operation,
    successMessage,
    { reportResultIssues = true } = {},
  ) {
    if (operationInFlight) {
      const error = new Error("已有操作正在进行，请等待完成后再试");
      notify(error.message, "warning");
      throw error;
    }
    operationInFlight = true;
    busy.value = true;
    try {
      await waitForRender();
      const result = await operation();
      if (result) applyState(result);
      const issues = Array.isArray(result?.issues) ? result.issues : [];
      if (reportResultIssues) reportIssues(issues);
      if (successMessage && !issues.some((issue) => issue?.type === "error"))
        notify(successMessage);
      return result;
    } catch (error) {
      notify(error?.message || "操作失败，请重试", "error");
      throw error;
    } finally {
      operationInFlight = false;
      busy.value = false;
    }
  }

  const {
    cancelAll: cancelAllPendingAgentSkills,
    cancelAgent: cancelPendingAgentSkills,
    mergePending: mergePendingSkillSelections,
    setSkills: setAgentSkillsDebounced,
  } = createSkillSyncQueue({
    getEnabledSkills: (agentId) => enabledSkills.value[agentId] || [],
    setEnabledSkills: (agentId, skillIds) => {
      enabledSkills.value = {
        ...enabledSkills.value,
        [agentId]: [...skillIds],
      };
    },
    isOperationInFlight: () => operationInFlight,
    submit: (agentId, skillIds) =>
      execute(() => api().setAgentSkills(agentId, skillIds), undefined, {
        reportResultIssues: false,
      }),
    setIssues: setAgentSyncIssues,
  });

  /**
   * 插件启动时读取 uTools userData 下的本地配置，并同步到界面。
   * 未运行在 uTools 环境时退化为浅色主题，保证在浏览器预览时仍可用。
   */
  async function initialize() {
    try {
      if (window.skillsManager) {
        const result = await api().getState();
        applyState(result);
        reportIssues(result?.issues);
      }
      else document.documentElement.classList.remove("dark");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      ready.value = true;
    }
  }

  /**
   * 切换主题：先乐观更新界面，再持久化到本地配置文件；失败时回滚。
   *
   * @param {'light'|'dark'} nextTheme - 目标主题
   * @returns {Promise<boolean>} 是否保存成功
   */
  async function setTheme(nextTheme) {
    if (nextTheme !== "light" && nextTheme !== "dark") return false;
    const previousTheme = theme.value;
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    theme.value = nextTheme;
    try {
      if (window.skillsManager) await execute(() => api().setTheme(nextTheme));
      return true;
    } catch (error) {
      theme.value = previousTheme;
      document.documentElement.classList.toggle(
        "dark",
        previousTheme === "dark",
      );
      notify(error.message, "error");
      return false;
    }
  }

  return {
    repositoryPath,
    skills,
    groups,
    agents,
    enabledSkills,
    agentSyncIssues,
    theme,
    ready,
    busy,
    notices,
    dialog,
    initialize,
    setTheme,
    notify,
    confirm,
    resolveDialog,
    dismissNotice,
    chooseDirectory: (current) => api().chooseDirectory(current),
    setRepository: (directory) =>
      execute(() => api().setRepository(directory), "Skills 仓库已更新"),
    refreshSkills: () =>
      execute(() => api().refreshSkills(), "已重新扫描 Skills"),
    saveGroups: (nextGroups) =>
      execute(() => api().saveGroups(nextGroups), "分组已保存"),
    upsertAgent: (agent) =>
      execute(
        () => api().upsertAgent(agent),
        agent.id ? "Agent 已更新" : "Agent 已添加",
      ),
    deleteAgent: (id) => {
      cancelPendingAgentSkills(id);
      return execute(
        () => api().deleteAgent(id),
        "Agent 已删除，相关链接已清理",
      );
    },
    clearData: () => {
      cancelAllPendingAgentSkills();
      return execute(() => api().clearData(), "本地数据已清除");
    },
    setAgentSkills: setAgentSkillsDebounced,
  };
});
