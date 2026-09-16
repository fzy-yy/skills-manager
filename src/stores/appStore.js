/**
 * 全局状态仓库（Pinia 组合式 API 写法）。
 *
 * 职责划分：
 *  - 本文件：界面状态（仓库路径、Skills、分组、Agent、启用关系、主题）与动作编排；
 *  - stores/feedback.js：全局提示与确认框；
 *  - stores/skill-queue.js：Agent 开关的高频提交队列；
 *  - api/backend.js：preload 能力的唯一访问入口。
 *
 * 约定：所有动作都**不会向外抛错**——失败时已经统一提示并返回 null，
 * 页面只需根据返回值判断成败。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { backend, hasBackend } from "../api/backend";
import { createConfirmDialog, createNoticeCenter } from "./feedback";
import { createSkillQueue } from "./skill-queue";

export const useAppStore = defineStore("app", () => {
  // ============ 一、响应式状态 ============
  /** 是否已完成首次配置读取（未完成时界面显示加载提示）。 */
  const ready = ref(false);
  /** 是否有目录 / 配置类操作正在执行（用于禁用按钮与顶部进度条）。 */
  const busy = ref(false);
  const repositoryPath = ref("");
  const skills = ref([]);
  const groups = ref([]);
  const agents = ref([]);
  /** agentId → 已启用的 Skill id 列表 */
  const enabledSkills = ref({});
  /** agentId → 最近一次链接同步问题（仅属于该 Agent 的问题）。 */
  const agentIssues = ref({});
  /** 最近一次扫描是否因“仓库为空”被拦下（用于给出确认出口）。 */
  const emptyRepository = ref(false);
  const theme = ref("light");

  // ============ 二、全局提示与确认框 ============
  const { notices, dismissNotice, notify, reportIssues } = createNoticeCenter();
  const { dialog, confirm, resolveDialog } = createConfirmDialog();

  /**
   * 应用主题值，并同步 <html> 上的 dark 类（所有 dark: 工具类都由它开关）。
   *
   * @param {'light'|'dark'} value - 目标主题
   */
  function applyTheme(value) {
    theme.value = value === "dark" ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  // ============ 三、Agent 开关提交队列 ============
  const queue = createSkillQueue({
    getSelection: (agentId) => enabledSkills.value[agentId] || [],
    applySelection: (agentId, skillIds) => {
      // Agent 已被删除时不再写入，避免留下无主的启用记录。
      if (!agents.value.some((agent) => agent.id === agentId)) return;
      enabledSkills.value = { ...enabledSkills.value, [agentId]: [...skillIds] };
    },
    submit: (agentId, skillIds) => backend().setAgentSkills(agentId, skillIds),
    onIssues: (agentId, issues) => {
      agentIssues.value = { ...agentIssues.value, [agentId]: issues };
    },
    onError: (error) =>
      notify(error?.message || "链接同步失败，请重试", "error"),
  });

  // ============ 四、状态合并 ============
  /**
   * 把 preload 返回的完整状态合并到界面。
   *
   * enabledSkills 特殊处理：把仍在排队、尚未提交的乐观选择保留在界面上，
   * 避免服务端返回的旧值把用户刚点选的结果覆盖掉。
   *
   * @param {object} state - preload 返回的状态对象
   */
  function applyState(state) {
    if (!state) return;
    repositoryPath.value = state.repositoryPath || "";
    skills.value = state.skills || [];
    groups.value = state.groups || [];
    agents.value = state.agents || [];

    const mergedSelections = { ...(state.enabledSkills || {}) };
    for (const [agentId, skillIds] of queue.pendingEntries())
      mergedSelections[agentId] = [...skillIds];
    enabledSkills.value = mergedSelections;

    // 问题列表按 Agent 合并；已删除 Agent 的遗留问题一并清理。
    const mergedIssues = { ...agentIssues.value, ...(state.agentIssues || {}) };
    const validIds = new Set(agents.value.map((agent) => agent.id));
    agentIssues.value = Object.fromEntries(
      Object.entries(mergedIssues).filter(([agentId]) => validIds.has(agentId)),
    );
    if (typeof state.emptyRepository === "boolean")
      emptyRepository.value = state.emptyRepository;
    if (state.theme) applyTheme(state.theme);
    reportIssues(state.issues);
  }

  // ============ 五、通用执行器 ============
  /**
   * 执行一次目录 / 配置类操作。
   *
   * @param {() => Promise<object>} operation - 实际调用 preload 的动作
   * @param {string} [successMessage] - 无错误问题时展示的成功提示
   * @returns {Promise<object|null>} 成功时返回状态对象，失败或忙时返回 null
   */
  async function run(operation, successMessage) {
    if (busy.value) {
      notify("已有操作正在进行，请稍候再试", "warning");
      return null;
    }
    busy.value = true;
    try {
      const state = await operation();
      applyState(state);
      const hasError = (state?.issues || []).some(
        (issue) => issue.type === "error",
      );
      if (successMessage && !hasError) notify(successMessage);
      return state;
    } catch (error) {
      notify(error?.message || "操作失败，请重试", "error");
      return null;
    } finally {
      busy.value = false;
    }
  }

  // ============ 六、初始化与进入插件 ============
  /** 启动时读取本地配置；未运行在 uTools 中时退化为浅色主题的空状态。 */
  async function initialize() {
    if (hasBackend()) {
      try {
        applyState(await backend().getState());
      } catch (error) {
        notify(error?.message || "读取本地配置失败", "error");
      }
    } else {
      applyTheme("light");
    }
    ready.value = true;
  }

  /**
   * 重新进入插件时的轻量同步。
   * uTools 按 Esc 只是隐藏插件、进程与页面状态都会保留，因此每次进入都重读配置，
   * 避免界面长期停留在上次退出时的旧数据上（只读缓存、不扫描仓库）。
   */
  async function syncOnEnter() {
    if (!hasBackend()) return;
    try {
      applyState(await backend().getState());
    } catch (error) {
      notify(error?.message || "读取本地配置失败", "error");
    }
  }

  // ============ 七、业务动作 ============
  /**
   * 打开系统目录选择框。
   *
   * @param {string} [current] - 作为选择器初始位置的当前路径
   * @returns {string} 选中的目录；取消或失败时返回空串
   */
  function chooseDirectory(current) {
    try {
      return backend().chooseDirectory(current);
    } catch (error) {
      notify(error?.message || "打开目录选择器失败", "error");
      return "";
    }
  }

  /**
   * 切换主题：先乐观更新界面，保存失败时回滚。
   *
   * @param {'light'|'dark'} value - 目标主题
   * @returns {Promise<boolean>} 是否保存成功
   */
  async function setTheme(value) {
    if (value !== "light" && value !== "dark") return false;
    if (value === theme.value) return true;
    const previous = theme.value;
    applyTheme(value);
    const state = await run(() => backend().setTheme(value));
    if (!state) applyTheme(previous);
    return Boolean(state);
  }

  /** 设置 Skills 仓库目录并扫描。 */
  function setRepository(directory) {
    return run(() => backend().setRepository(directory), "Skills 仓库已更新");
  }

  /**
   * 重新扫描当前仓库。
   *
   * @param {{allowEmptyRepository?: boolean}} [options] - 用户确认仓库已清空时允许清理失效记录
   */
  function refreshSkills(options) {
    return run(() => backend().refresh(options), "已重新扫描 Skills");
  }

  /** 保存分组列表。 */
  function saveGroups(nextGroups) {
    return run(() => backend().saveGroups(nextGroups), "分组已保存");
  }

  /** 新建 Agent（目录必须为空；保存后不可修改，只能删除重建）。 */
  function createAgent(input) {
    return run(() => backend().createAgent(input), "Agent 已添加");
  }

  /** 删除 Agent，并取消其尚未提交的开关选择。 */
  async function deleteAgent(agentId) {
    queue.cancel(agentId);
    return run(
      () => backend().deleteAgent(agentId),
      "Agent 已删除，相关链接已清理",
    );
  }

  /**
   * 更新一个 Agent 的启用 Skills（乐观更新 + 防抖提交）。
   *
   * @param {string} agentId - Agent id
   * @param {string[]} skillIds - 新的完整选择列表
   */
  function setAgentSkills(agentId, skillIds) {
    queue.setSkills(agentId, skillIds);
  }

  /** 清除本地数据：移除受管链接并删除本地配置。 */
  async function clearData() {
    queue.cancelAll();
    return run(() => backend().clearData(), "本地数据已清除");
  }

  /** 插件隐藏 / 退出前立即提交排队中的开关选择（尽力而为，不等待完成）。 */
  function flushPendingSkills() {
    queue.flushNow();
  }

  return {
    // 状态
    ready,
    busy,
    repositoryPath,
    skills,
    groups,
    agents,
    enabledSkills,
    agentIssues,
    emptyRepository,
    theme,
    notices,
    dialog,
    // 全局反馈
    notify,
    confirm,
    resolveDialog,
    dismissNotice,
    // 初始化
    initialize,
    syncOnEnter,
    // 业务动作
    chooseDirectory,
    setTheme,
    setRepository,
    refreshSkills,
    saveGroups,
    createAgent,
    deleteAgent,
    setAgentSkills,
    clearData,
    flushPendingSkills,
  };
});
