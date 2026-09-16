/**
 * 仓库域控制器：仓库路径、Skills、分组、Agent、启用关系与受管链接的界面状态。
 *
 * 并发与一致性设计（改动本文件前请先读完以下三点）：
 *  1. 文件与配置操作全局串行（由 operation-runner 的 execute 保证）：链接同步会读写同一批目录，
 *     并发的两轮同步各自基于旧快照计算增删，最终会留下无法追踪的残留链接；
 *  2. 应用配置开关属于高频操作，采用「乐观更新 + 300ms 防抖合并 + 失败回滚」，
 *     只把每个 Agent 的最终选择提交一次，避免快速连点产生大量磁盘写入与界面卡顿；
 *  3. 服务端的只读保护（本地配置异常时禁止一切写操作）由 preload 抛错体现，
 *     本控制器不自行拦截，只把错误提示给用户并在必要时回滚界面状态。
 */
import { ref } from "vue";
import { preloadApi } from "./preload-api";
import { createSkillSyncQueue } from "./skill-sync-queue";

export function createRepositoryController({
  execute,
  isInFlight,
  notify,
  reportIssues,
  applyTheme,
}) {
  const repositoryPath = ref("");
  const skills = ref([]);
  const groups = ref([]);
  const agents = ref([]);
  const enabledSkills = ref({});
  const agentSyncIssues = ref({});
  /** 最近一次状态计算是否因「仓库为空」被拦下，用于在界面上给出确认出口。 */
  const emptyRepository = ref(false);

  /** 记录某个 Agent 最近一次链接同步问题，空结果会清除旧提示。 */
  function setAgentSyncIssues(agentId, issues) {
    const normalized = Array.isArray(issues) ? issues : [];
    agentSyncIssues.value = {
      ...agentSyncIssues.value,
      [agentId]: normalized,
    };
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
      syncCommittedSkillSelections(next.enabledSkills || {});
      enabledSkills.value = mergePendingSkillSelections(
        next.enabledSkills || {},
      );
    }
    if (Object.hasOwn(next, "agentIssues")) {
      agentSyncIssues.value = Object.fromEntries(
        Object.entries(next.agentIssues || {}).map(([agentId, issues]) => [
          agentId,
          Array.isArray(issues) ? issues : [],
        ]),
      );
    }
    if (Object.hasOwn(next, "emptyRepository"))
      emptyRepository.value = next.emptyRepository === true;
    applyTheme(next);
  }

  /** 执行一次仓库域操作：统一走 execute，并向页面保持 state/null 返回约定。 */
  async function run(operation, successMessage, options = {}) {
    const outcome = await execute(operation, {
      successMessage,
      applyResult: applyState,
      ...options,
    });
    return outcome.ok ? outcome.value : null;
  }

  const {
    cancelAll: cancelAllPendingAgentSkills,
    cancelAgent: cancelPendingAgentSkills,
    flushNow: flushPendingSkillSync,
    mergePending: mergePendingSkillSelections,
    setSkills: setAgentSkillsDebounced,
    syncCommitted: syncCommittedSkillSelections,
  } = createSkillSyncQueue({
    getEnabledSkills: (agentId) => enabledSkills.value[agentId] || [],
    setEnabledSkills: (agentId, skillIds) => {
      enabledSkills.value = {
        ...enabledSkills.value,
        [agentId]: [...skillIds],
      };
    },
    isOperationInFlight: isInFlight,
    recordPending: (agentId, skillIds, token) => {
      const result = preloadApi().recordPendingSkillSync?.(
        agentId,
        skillIds,
        token,
      );
      if (result?.issue) reportIssues([result.issue]);
      return result;
    },
    clearPending: (agentId, token) => {
      const result = preloadApi().clearPendingSkillSync?.(agentId, token);
      if (result?.issue && result.code !== "ETOKENMISMATCH")
        reportIssues([result.issue]);
      return result;
    },
    submit: async (agentId, skillIds) => {
      const outcome = await execute(
        () => preloadApi().setAgentSkills(agentId, skillIds),
        { reportResultIssues: false },
      );
      if (!outcome.ok) {
        const error =
          outcome.error ||
          new Error(
            outcome.reason === "busy"
              ? "已有操作正在进行，链接同步将在空闲后重试"
              : "链接同步失败，请重试",
          );
        if (outcome.reason === "busy") {
          error.code = "busy";
          error.retryable = true;
        }
        throw error;
      }
      const result = outcome.value;
      const ownIssues = result?.agentIssues?.[agentId] || [];
      const ownIssueKeys = new Set(
        ownIssues.map((issue) => `${issue.type}:${issue.message}`),
      );
      reportIssues(
        (result?.issues || []).filter(
          (issue) => !ownIssueKeys.has(`${issue.type}:${issue.message}`),
        ),
      );
      return result;
    },
    setIssues: setAgentSyncIssues,
  });

  /** 读取本地配置与扫描缓存（不触发仓库扫描或链接同步），并合并到界面状态。 */
  async function readStateFromPreload() {
    const result = await preloadApi().getState();
    applyState(result);
    reportIssues(result?.issues);
  }

  /** 启动后重放上次进程未完成的本机同步意图。 */
  function replayPendingSkillSync() {
    const result = preloadApi().readPendingSkillSync?.();
    if (!result) return [];
    if (result.issue) reportIssues([result.issue]);
    const validAgentIds = new Set(agents.value.map((agent) => agent.id));
    const completions = [];
    for (const record of result.records || []) {
      if (!validAgentIds.has(record.id)) {
        preloadApi().clearPendingSkillSync?.(record.id, record.token);
        continue;
      }
      const current = enabledSkills.value[record.id] || [];
      if (
        current.length === record.skillIds.length &&
        [...current].sort().every((id, index) => id === record.skillIds[index])
      ) {
        preloadApi().clearPendingSkillSync?.(record.id, record.token);
        continue;
      }
      completions.push(setAgentSkillsDebounced(record.id, record.skillIds));
    }
    return completions;
  }

  return {
    agentSyncIssues,
    agents,
    applyState,
    chooseDirectory: (current) => {
      try {
        return preloadApi().chooseDirectory(current);
      } catch (error) {
        notify(error.message, "error");
        return "";
      }
    },
    clearData: () => {
      cancelAllPendingAgentSkills({ clearIntent: false });
      return run(() => preloadApi().clearData(), "本地数据已清除");
    },
    deleteAgent: (id) => {
      cancelPendingAgentSkills(id, { clearIntent: false });
      return run(
        () => preloadApi().deleteAgent(id),
        "Agent 已删除，相关链接已清理",
      );
    },
    emptyRepository,
    enabledSkills,
    groups,
    readStateFromPreload,
    replayPendingSkillSync,
    refreshSkills: (options) =>
      run(() => preloadApi().refreshSkills(options), "已重新扫描 Skills"),
    repositoryPath,
    saveGroups: (nextGroups) =>
      run(() => preloadApi().saveGroups(nextGroups), "分组已保存"),
    setAgentSkills: setAgentSkillsDebounced,
    setRepository: (directory) =>
      run(() => preloadApi().setRepository(directory), "Skills 仓库已更新"),
    skills,
    upsertAgent: (agent) =>
      run(
        () => preloadApi().upsertAgent(agent),
        agent.id ? "Agent 已更新" : "Agent 已添加",
      ),
    flushPendingSkillSync,
  };
}
