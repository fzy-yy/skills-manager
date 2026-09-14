/**
 * 扫描结果、启用状态与受管链接的业务收敛层。
 */
const { createIssue, uniqueIssues } = require("./runtime");
const {
  attachRuntime,
  clearStoredConfig,
  createDefaultConfig,
  normalizeCachedSkills,
  normalizeManagedLinks,
  writeConfig,
} = require("./config-store");
const { normalizeDirectory } = require("./path-safety");

function createStateService({ scanner, linkManager }) {
  const { inspectEnabledCachedSkills, scanConfiguredRepository } = scanner;
  const { removeOwnedLink, syncAgent, syncAllAgents } = linkManager;

  function reconcileDeletedSkills(config, scan) {
    if (!scan.complete || scan.locked) return [];
    const validSkillIds = new Set(scan.skills.map((skill) => skill.id));
    const issues = [];
    config.groups.forEach((group) => {
      const missing = group.skillIds.filter(
        (skillId) => !validSkillIds.has(skillId),
      );
      if (!missing.length) return;
      group.skillIds = group.skillIds.filter((skillId) =>
        validSkillIds.has(skillId),
      );
      issues.push(
        createIssue(
          "warning",
          `分组“${group.name}”中有 ${missing.length} 个 Skill 已从主仓库删除，失效引用已自动清理。`,
        ),
      );
    });
    config.agents.forEach((agent) => {
      const current = config.enabledSkills[agent.id] || [];
      const missing = current.filter((skillId) => !validSkillIds.has(skillId));
      config.enabledSkills[agent.id] = current.filter((skillId) =>
        validSkillIds.has(skillId),
      );
      if (missing.length) {
        issues.push(
          createIssue(
            "warning",
            `Agent“${agent.name}”有 ${missing.length} 个已启用 Skill 不再存在，选择记录和受管链接已自动清理。`,
          ),
        );
      }
    });
    return issues;
  }

  /**
   * 汇总一次刷新过程中的全部问题：扫描问题 + 附加问题 + 各 Agent 同步问题。
   *
   * @param {object} scan - 仓库扫描结果
   * @param {object} syncResults - syncAllAgents 的返回值
   * @param {Array} [extra=[]] - 额外问题（如配置读取问题、分组清理问题）
   * @returns {Array} 去重后的问题列表
   */
  function collectIssues(scan, syncResults, extra = []) {
    return uniqueIssues([
      ...(scan?.issues || []),
      ...extra,
      ...Object.values(syncResults || {}).flatMap(
        (result) => result.issues || [],
      ),
    ]);
  }

  /**
   * 把内部 Agent 结构转换为前端需要的公开结构。
   *
   * @param {object} agent - 内部 Agent 对象
   * @returns {{id: string, name: string, directory: string}}
   */
  function publicAgent(agent) {
    return {
      id: agent.id,
      name: agent.name,
      directory: agent.directory,
    };
  }

  /**
   * 组装返回给前端的状态对象（前端 applyState 会逐字段合并）。
   *
   * @param {object} config - 当前配置
   * @param {{skills?: Array}} [scan={ skills: [] }] - 仓库扫描结果
   * @param {Array} [issues=[]] - 需要展示的问题列表
   * @returns {object} 前端可用的完整状态
   */
  function buildState(
    config,
    scan = { skills: [] },
    issues = [],
  ) {
    return {
      repositoryPath: config.repositoryPath,
      skills: scan.skills || [],
      groups: config.groups,
      agents: config.agents.map(publicAgent),
      enabledSkills: config.enabledSkills,
      theme: config.theme === "dark" ? "dark" : "light",
      issues: uniqueIssues(issues),
    };
  }

  /**
   * 保存同步后的链接状态；保存失败时安全回滚本轮新建链接，并重试记录最终状态。
   *
   * @param {object} config - 当前完整配置
   * @param {object} syncResults - 本轮参与同步的 Agent 结果
   * @returns {Promise<Array>} 持久化或回滚期间产生的问题
   */
  async function persistSyncResults(config, syncResults) {
    const persistenceIssues = [];
    if (config._syncLocked) return persistenceIssues;
    try {
      await writeConfig(config);
    } catch (error) {
      const rollbackIssues = [];
      for (const agent of config.agents) {
        const createdLinks = syncResults[agent.id]?.createdLinks || [];
        for (const link of createdLinks) {
          const removal = await removeOwnedLink(
            link,
            `保存失败后的新建链接 ${link.linkPath}`,
            agent.directory,
          );
          rollbackIssues.push(...removal.issues);
          if (removal.relinquished) {
            delete agent.managedLinks[link.skillId];
            const syncResult = syncResults[agent.id];
            syncResult.linked = syncResult.linked.filter(
              (id) => id !== link.skillId,
            );
          }
        }
      }
      try {
        await writeConfig(config);
        const detail = rollbackIssues.length
          ? `部分新建链接未能回滚，但其受管记录已保留：${rollbackIssues.map((issue) => issue.message).join("；")}`
          : "本轮新建链接已回滚，本地配置重试保存成功";
        persistenceIssues.push(
          createIssue("warning", `${error.message}；${detail}。`),
        );
      } catch (retryError) {
        const detail = rollbackIssues.length
          ? `；新建链接回滚存在问题：${rollbackIssues.map((issue) => issue.message).join("；")}`
          : "；本轮新建链接已回滚，其余状态将在下次启动时按安全检查点自动收敛";
        persistenceIssues.push(
          createIssue(
            "error",
            `${error.message}；重试保存仍失败：${retryError.message}${detail}`,
          ),
        );
      }
    }
    return persistenceIssues;
  }

  /**
   * 刷新状态的核心流程：扫描仓库 → 写入恢复检查点 → 同步所有 Agent → 保存结果 → 组装状态。
   *
   * 关键点：文件操作前先持久化业务目标与旧链接记录；最终写入失败时回滚本轮新建链接，
   * 删除结果则可依据检查点在下次启动时安全收敛。
   *
   * @param {object} config - 已读取（可能已修改）的配置对象
   * @returns {object} 前端可用的完整状态
   * @throws {Error} 恢复检查点无法写入时抛出，且不会执行任何文件操作
   */
  async function refreshState(config) {
    const scan = await scanConfiguredRepository(config);
    if (scan.complete && !scan.locked)
      config._cachedSkills = normalizeCachedSkills(scan.skills);
    const reconciledIssues = reconcileDeletedSkills(config, scan);
    if (!config._syncLocked) await writeConfig(config);
    const orphanIssues = config._syncLocked
      ? []
      : await cleanupOrphanAgents(config);
    const syncResults = await syncAllAgents(config, scan);
    const persistenceIssues = await persistSyncResults(config, syncResults);
    return buildState(
      config,
      scan,
      collectIssues(scan, syncResults, [
        ...(config._issues || []),
        ...reconciledIssues,
        ...orphanIssues,
        ...persistenceIssues,
      ]),
    );
  }

  /**
   * 只同步一次应用配置开关涉及的 Agent。
   * 使用最近一次完整扫描缓存并逐项验证源目录，避免每次点击都递归遍历整个仓库。
   */
  async function syncAgentSkillsState(config, agent, previousSkillIds) {
    const targetedScan = await inspectEnabledCachedSkills(
      config,
      agent,
      previousSkillIds,
    );
    await writeConfig(config);
    const syncResults = {
      [agent.id]: await syncAgent(config, agent, targetedScan),
    };
    const persistenceIssues = await persistSyncResults(config, syncResults);
    return buildState(
      config,
      { skills: config._cachedSkills || [] },
      collectIssues(targetedScan, syncResults, [
        ...(config._issues || []),
        ...persistenceIssues,
      ]),
    );
  }

  /** 返回最近一次扫描缓存，不触发仓库或 Agent 目录访问。 */
  function getCachedState(config, issues = config._issues || []) {
    return buildState(
      config,
      { skills: config._cachedSkills || [] },
      uniqueIssues(issues),
    );
  }

  /** Agent 更换目录时只清理旧目录并同步当前 Agent。 */
  async function syncMovedAgentState(config, agent) {
    await writeConfig(config);
    const orphanIssues = await cleanupOrphanAgents(config);
    const targetedScan = await inspectEnabledCachedSkills(config, agent, []);
    const syncResults = {
      [agent.id]: await syncAgent(config, agent, targetedScan),
    };
    const persistenceIssues = await persistSyncResults(config, syncResults);
    return getCachedState(
      config,
      collectIssues(targetedScan, syncResults, [
        ...(config._issues || []),
        ...orphanIssues,
        ...persistenceIssues,
      ]),
    );
  }

  /** 删除 Agent 后只处理其孤儿链接，不扫描仓库或同步其他 Agent。 */
  async function deleteAgentState(config) {
    await writeConfig(config);
    const issues = await cleanupOrphanAgents(config);
    await writeConfig(config);
    return getCachedState(config, [...(config._issues || []), ...issues]);
  }

  /** 清理全部受管链接并删除本地配置。 */
  async function clearDataState(config) {
    const cleared = attachRuntime(createDefaultConfig(), {
      _issues: [],
      _syncLocked: false,
      _orphanAgents: [...config.agents, ...(config._orphanAgents || [])],
      _cachedSkills: [],
    });
    await writeConfig(cleared);
    const issues = await cleanupOrphanAgents(cleared);
    if (config._syncLocked)
      issues.push(
        createIssue(
          "warning",
          "本地配置异常，仅清理了仍可识别的受管链接；其他内容均已保留。",
        ),
      );
    if (cleared._orphanAgents.length) await writeConfig(cleared);
    else await clearStoredConfig();
    return buildState(createDefaultConfig(), { skills: [] }, uniqueIssues(issues));
  }

  /**
   * 清理某个 Agent 的全部受管链接（删除 Agent、更换目录、清除数据时使用）。
   *
   * @param {object} agent - 目标 Agent（会就地更新其 managedLinks）
   * @returns {Array} 问题列表（含无法删除的错误）
   */
  async function cleanupAgentLinks(agent) {
    const issues = [];
    try {
      await normalizeDirectory(agent.directory, `Agent“${agent.name}”的 Skills 目录`);
    } catch (error) {
      return [
        createIssue(
          "error",
          `${error.message}。全部受管记录已保留，目录恢复后可再次清理。`,
        ),
      ];
    }
    const remaining = {};
    for (const [skillId, link] of Object.entries(
      normalizeManagedLinks(agent.managedLinks),
    )) {
      const removal = await removeOwnedLink(
        link,
        `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
        agent.directory,
      );
      issues.push(...removal.issues);
      if (!removal.relinquished) remaining[skillId] = link;
    }
    agent.managedLinks = remaining;
    return uniqueIssues(issues);
  }

  /** 清理已经不属于当前配置的 Agent 链接，并保留失败项供下次重试。 */
  async function cleanupOrphanAgents(config) {
    const issues = [];
    const remaining = [];
    for (const agent of config._orphanAgents || []) {
      const agentIssues = await cleanupAgentLinks(agent);
      issues.push(...agentIssues);
      if (Object.keys(agent.managedLinks || {}).length) remaining.push(agent);
    }
    config._orphanAgents = remaining;
    return uniqueIssues(issues);
  }

  /**
   * 写操作前的守卫：配置处于只读保护时，禁止任何会改动配置文件或链接的操作。
   *
   * @param {object} config - 当前配置
   * @throws {Error} 配置处于只读保护时抛出
   */
  function assertConfigWritable(config) {
    if (config._syncLocked)
      throw new Error(
        "本地配置文件关键数据异常，当前处于只读保护。请先在设置页清除数据，再重新配置。",
      );
  }


  return {
    assertConfigWritable,
    clearDataState,
    deleteAgentState,
    getCachedState,
    refreshState,
    syncAgentSkillsState,
    syncMovedAgentState,
  };
}

module.exports = { createStateService };
