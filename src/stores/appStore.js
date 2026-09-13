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
 */

// Vue 响应式 API：ref 定义状态，computed 定义派生状态。
import { computed, ref } from "vue";
// Pinia 的组合式仓库定义函数。
import { defineStore } from "pinia";

// Pinia 统一管理业务数据、主题、全局提示与确认对话框。
export const useAppStore = defineStore("app", () => {
  // ---------- 业务状态 ----------
  // 统一 Skills 仓库目录的绝对路径，空字符串表示尚未配置。
  const repositoryPath = ref("");
  // 仓库扫描结果，元素形如 { id, name, relativePath, folderName, sourcePath }。
  const skills = ref([]);
  // 分组列表，元素形如 { id, name, skillIds }。
  const groups = ref([]);
  // Agent 列表；后端返回的是精简后的公开字段（含链接数量统计）。
  const agents = ref([]);
  // 每个 Agent 已启用的分组：{ [agentId]: groupId[] }。
  const enabledGroups = ref({});
  // 当前主题，取值 'light' 或 'dark'。
  const theme = ref("light");
  // 是否已完成首次初始化（读取本地配置），用于避免首屏空白闪烁。
  const ready = ref(false);
  // 是否有耗时操作正在进行，用于禁用按钮、显示顶部进度条。
  const busy = ref(false);
  // 全局提示列表，元素形如 { id, message, type }。
  const notices = ref([]);
  // 全局确认对话框的显示状态与文案。
  const dialog = ref({
    open: false,
    title: "",
    message: "",
    confirmText: "确定",
    cancelText: "取消",
    tone: "primary",
  });

  // 提示自增序号，保证每条提示都有唯一 key。
  let noticeSequence = 0;
  // 提示 id 与自动关闭定时器的映射，手动关闭时需要一并清理定时器。
  const noticeTimers = new Map();
  // 确认对话框的 resolve 函数，由 confirm() 赋值、resolveDialog() 调用。
  let dialogResolver;
  // 文件与数据库操作必须串行，避免快速重复点击产生两轮相互覆盖的链接同步。
  let operationInFlight = false;

  // ---------- 派生状态 ----------
  // 是否已经配置过统一 Skills 仓库目录。
  const hasRepository = computed(() => Boolean(repositoryPath.value));

  // ---------- 内部工具 ----------
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

  // ---------- 状态同步 ----------
  /**
   * 将后端（preload 服务）返回的状态增量合并到本地响应式状态。
   * 未出现在 next 中的字段保持原值不变。
   *
   * @param {object} next - 形如 { repositoryPath, skills, groups, agents, enabledGroups, theme, issues }
   */
  function applyState(next) {
    // 部分接口（例如主题切换）只返回变更字段，避免无关状态被意外清空。
    if (Object.hasOwn(next, "repositoryPath"))
      repositoryPath.value = next.repositoryPath || "";
    if (Object.hasOwn(next, "skills"))
      skills.value = Array.isArray(next.skills) ? next.skills : [];
    if (Object.hasOwn(next, "groups"))
      groups.value = Array.isArray(next.groups) ? next.groups : [];
    if (Object.hasOwn(next, "agents"))
      agents.value = Array.isArray(next.agents) ? next.agents : [];
    if (Object.hasOwn(next, "enabledGroups"))
      enabledGroups.value = next.enabledGroups || {};
    if (Object.hasOwn(next, "theme"))
      theme.value = next.theme === "dark" ? "dark" : "light";
    // 主题以 <html class="dark"> 为开关，与 src/main.css 中的 .dark 令牌对应。
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  // ---------- 全局提示 ----------
  /**
   * 手动关闭一条提示，并清除其自动关闭定时器。
   *
   * @param {number} id - 提示的唯一编号
   */
  function dismissNotice(id) {
    notices.value = notices.value.filter((notice) => notice.id !== id);
    clearTimeout(noticeTimers.get(id));
    noticeTimers.delete(id);
  }

  /**
   * 推送一条全局提示；多条提示会同时展示，互不覆盖。
   *
   * @param {string} message - 提示文本，为空时忽略
   * @param {'success'|'error'|'warning'|'info'} [type='success'] - 提示类型，决定配色与图标
   * @param {number} [duration=5200] - 自动关闭时间（毫秒），错误类型会被强制延长
   */
  function notify(message, type = "success", duration = 5200) {
    if (!message) return;
    const normalizedMessage = String(message);
    // 后台一致性校验可能重复发现同一问题；相同提示只保留一条，避免大量 DOM 与定时器堆积。
    if (
      notices.value.some(
        (notice) =>
          notice.message === normalizedMessage && notice.type === type,
      )
    )
      return;
    // 全局提示设置硬上限，异常链接很多时也不会拖慢渲染。
    while (notices.value.length >= 20)
      dismissNotice(notices.value[0].id);
    const id = ++noticeSequence;
    notices.value.push({ id, message: normalizedMessage, type });
    // 错误保留更久；多条问题会同时展示，避免后一个提示覆盖前一个错误。
    const timeout = type === "error" ? Math.max(duration, 9000) : duration;
    noticeTimers.set(
      id,
      setTimeout(() => dismissNotice(id), timeout),
    );
  }

  /**
   * 批量展示 preload 服务返回的问题列表（issues）。
   * 这些问题来自目录扫描、链接同步等底层操作，属于“操作成功但有异常”的场景。
   *
   * @param {Array<{type?: string, message: string}>} issues - 问题列表
   * @returns {Array} 原样返回入参，便于调用方继续判断是否包含 error
   */
  function reportIssues(issues) {
    const safeIssues = Array.isArray(issues) ? issues : [];
    safeIssues.forEach((issue) =>
      notify(issue?.message, issue?.type || "warning"),
    );
    return safeIssues;
  }

  // ---------- 统一操作封装 ----------
  /**
   * 统一执行一次“可能改动本地状态”的业务操作。
   * 负责：置忙 → 调用接口 → 合并状态 → 展示问题 → 展示成功提示 → 异常兜底。
   *
   * @param {() => Promise<object>} operation - 实际调用 preload 服务的函数
   * @param {string} [successMessage] - 成功提示文案；若存在 error 级问题则不提示成功
   * @returns {Promise<object>} preload 服务返回的最新状态
   */
  async function execute(operation, successMessage) {
    if (operationInFlight) {
      const error = new Error("已有操作正在进行，请等待完成后再试");
      notify(error.message, "warning");
      throw error;
    }
    operationInFlight = true;
    busy.value = true;
    try {
      // preload 调用前先让界面完成一次更新，即使底层偶发变慢也能看到明确的处理中状态。
      await waitForRender();
      const result = await operation();
      if (result) applyState(result);
      const issues = reportIssues(result?.issues);
      // 存在 error 级问题时不再提示成功，避免“成功”与“失败”同时出现造成误导。
      if (successMessage && !issues.some((issue) => issue?.type === "error"))
        notify(successMessage);
      return result;
    } catch (error) {
      notify(error?.message || "操作失败，请重试", "error");
      // 继续向上抛出，交给调用方决定是否中断后续流程。
      throw error;
    } finally {
      operationInFlight = false;
      busy.value = false;
    }
  }

  // ---------- 确认对话框 ----------
  /**
   * 弹出全局确认对话框，并等待用户选择结果。
   *
   * @param {{title?: string, message?: string, confirmText?: string, cancelText?: string, tone?: 'primary'|'danger'}} options
   * @returns {Promise<boolean>} true 表示用户点了确认，false 表示取消或关闭
   */
  // 返回 Promise，让业务页面可以用统一方式等待用户选择。
  function confirm(options) {
    // 若上一个对话框尚未收尾，先按“取消”处理，避免 Promise 永远挂起。
    if (dialogResolver) dialogResolver(false);
    dialog.value = {
      open: true,
      title: options.title || "请确认",
      message: options.message || "",
      confirmText: options.confirmText || "确定",
      cancelText: options.cancelText || "取消",
      tone: options.tone || "primary",
    };
    return new Promise((resolve) => {
      dialogResolver = resolve;
    });
  }

  /**
   * 结束当前确认对话框，并回传用户选择。
   * 由 App.vue 中的 ConfirmDialog 通过 resolve 事件调用。
   *
   * @param {boolean} accepted - 是否点击了确认按钮
   */
  function resolveDialog(accepted) {
    dialog.value.open = false;
    dialogResolver?.(accepted);
    dialogResolver = null;
  }

  // ---------- 初始化与主题 ----------
  /**
   * 插件启动时读取 uTools 本地数据库中的配置，并同步到界面。
   * 未运行在 uTools 环境时退化为浅色主题，保证在浏览器预览时仍可用。
   */
  async function initialize() {
    let needsReconcile = false;
    try {
      if (window.skillsManager) {
        const result = await api().getState();
        applyState(result);
        reportIssues(result?.issues);
        needsReconcile = Boolean(
          result?.repositoryPath ||
            result?.groups?.length ||
            result?.agents?.length,
        );
      }
      // 非 uTools 环境没有持久化能力，强制使用浅色主题，避免残留 class。
      else document.documentElement.classList.remove("dark");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      // 无论成功失败都标记为已初始化，避免页面一直停留在加载态。
      ready.value = true;
    }
    // 首屏缓存状态已经绘制后，再异步检查仓库和链接；失败由 execute 统一提示。
    if (needsReconcile && api().reconcile) {
      try {
        await execute(() => api().reconcile());
      } catch (_) {}
    }
  }

  /**
   * 切换主题：先乐观更新界面，再持久化到 uTools 本地数据库；失败时回滚。
   *
   * @param {'light'|'dark'} nextTheme - 目标主题
   * @returns {Promise<boolean>} 是否保存成功
   */
  async function setTheme(nextTheme) {
    if (nextTheme !== "light" && nextTheme !== "dark") return false;
    const previousTheme = theme.value;
    // 立即生效，避免等待磁盘写入造成界面迟滞。
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    theme.value = nextTheme;
    try {
      if (window.skillsManager) {
        const result = await api().setTheme(nextTheme);
        applyState(result);
        reportIssues(result?.issues);
      }
      return true;
    } catch (error) {
      // 保存失败时回滚到切换前的主题，保持界面与数据库一致。
      theme.value = previousTheme;
      document.documentElement.classList.toggle(
        "dark",
        previousTheme === "dark",
      );
      notify(error.message, "error");
      return false;
    }
  }

  /**
   * 在浅色与深色之间切换主题（供设置页或快捷键使用）。
   *
   * @returns {Promise<boolean>} 是否保存成功
   */
  function toggleTheme() {
    return setTheme(theme.value === "dark" ? "light" : "dark");
  }

  // ---------- 对外暴露 ----------
  // 状态与纯本地方法直接导出；所有会触碰文件系统或数据库的动作都包一层 execute()，
  // 以获得统一的忙碌状态、错误提示与状态回写。
  return {
    repositoryPath,
    skills,
    groups,
    agents,
    enabledGroups,
    theme,
    ready,
    busy,
    notices,
    dialog,
    hasRepository,
    initialize,
    setTheme,
    toggleTheme,
    notify,
    confirm,
    resolveDialog,
    // 关闭单条提示（App.vue 的提示卡片关闭按钮会调用）。
    dismissNotice,
    // 打开系统目录选择框，仅返回路径，不修改任何配置，因此无需 execute 包装。
    chooseDirectory: (current) => api().chooseDirectory(current),
    // 设置统一 Skills 仓库目录，成功后服务端会重新扫描并同步链接。
    setRepository: (directory) =>
      execute(() => api().setRepository(directory), "Skills 仓库已更新"),
    // 重新扫描仓库目录（不修改仓库路径）。
    refreshSkills: () =>
      execute(() => api().refreshSkills(), "已重新扫描 Skills"),
    // 保存分组列表（新增、改名、增删 Skills 均复用该接口）。
    saveGroups: (nextGroups) =>
      execute(() => api().saveGroups(nextGroups), "分组已保存"),
    // 新增或更新 Agent（携带 id 表示更新）。
    upsertAgent: (agent) =>
      execute(
        () => api().upsertAgent(agent),
        agent.id ? "Agent 已更新" : "Agent 已添加",
      ),
    // 删除 Agent，同时清理本应用在其目录创建的链接。
    deleteAgent: (id) =>
      execute(() => api().deleteAgent(id), "Agent 已删除，相关链接已清理"),
    // 清除 uTools 本地数据库配置（保留仓库中的源文件）。
    clearData: () => execute(() => api().clearData(), "本地数据已清除"),
    // 设置某个 Agent 启用的分组，服务端据此差量创建/移除链接。
    setAgentGroups: (agentId, groupIds) =>
      execute(() => api().setAgentGroups(agentId, groupIds), "链接配置已同步"),
  };
});
