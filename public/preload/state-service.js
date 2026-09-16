/**
 * 扫描结果、启用状态与受管链接的业务收敛层。
 */
const { createIssue, uniqueIssues } = require("./runtime");
const defaultConfigStore = require("./config-store");
const { removeOwnedLink } = require("./link-ownership");
const { normalizeDirectory } = require("./path-safety");
const { createSyncPersistence } = require("./sync-persistence");

/**
 * @param {{scanner: object, linkManager: object, configStore?: object}} dependencies
 *        configStore 可注入，便于集成测试脱离 uTools 存储直接验证编排逻辑。
 */
function createStateService({
  scanner,
  linkManager,
  configStore = defaultConfigStore,
}) {
  const {
    attachRuntime,
    clearStoredConfig,
    createDefaultConfig,
    normalizeCachedSkills,
    normalizeManagedLinks,
    writeConfig,
  } = configStore;
  const { inspectEnabledCachedSkills, scanConfiguredRepository } = scanner;
  const { syncAgent, syncAllAgents } = linkManager;
  const { persistSyncResults } = createSyncPersistence({
    writeConfig,
    removeOwnedLink,
  });

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
   * 只归属到单个 Agent 的问题：该 Agent 的定向扫描问题 + 其链接同步问题。
   * 不含配置读取等全局问题，避免前端把它们显示成某个 Agent 的链接问题。
   *
   * @param {string} agentId - Agent id
   * @param {object} targetedScan - inspectEnabledCachedSkills 的返回值
   * @param {object} syncResults - { [agentId]: syncAgent 的返回值 }
   * @returns {Array} 去重后的问题列表
   */
  function collectAgentIssues(agentId, targetedScan, syncResults) {
    return uniqueIssues([
      ...(targetedScan?.issues || []),
      ...(syncResults?.[agentId]?.issues || []),
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
   * emptyRepository 按存在性可选：只有本次结果确实包含该判定时才输出。
   * 定向同步、缓存读取等非仓库扫描操作不得覆盖前端保留的空仓库确认状态。
   *
   * @param {object} config - 当前配置
   * @param {{skills?: Array, emptyRepository?: boolean}} [scan={ skills: [] }] - 仓库扫描结果
   * @param {Array} [issues=[]] - 需要展示的问题列表
   * @returns {object} 前端可用的完整状态
   */
  function buildState(config, scan = { skills: [] }, issues = []) {
    const state = {
      repositoryPath: config.repositoryPath,
      skills: scan.skills || [],
      groups: config.groups,
      agents: config.agents.map(publicAgent),
      enabledSkills: config.enabledSkills,
      theme: config.theme === "dark" ? "dark" : "light",
      issues: uniqueIssues(issues),
    };
    if (typeof scan.emptyRepository === "boolean")
      state.emptyRepository = scan.emptyRepository;
    return state;
  }

  /**
   * 刷新状态的核心流程：扫描仓库 → 写入恢复检查点 → 同步所有 Agent → 保存结果 → 组装状态。
   *
   * 关键点：文件操作前先持久化业务目标与旧链接记录；最终写入失败时回滚本轮新建链接，
   * 删除结果则可依据检查点在下次启动时安全收敛。
   *
   * @param {object} config - 已读取（可能已修改）的配置对象
   * @param {{allowEmptyRepository?: boolean}} [options] - 用户已二次确认"仓库确实已清空"时，
   *        允许按空仓库收敛并清理失效引用与链接
   * @returns {object} 前端可用的完整状态
   * @throws {Error} 恢复检查点无法写入时抛出，且不会执行任何文件操作
   */
  async function refreshState(config, options = {}) {
    const scan = await scanConfiguredRepository(config, options);
    if (scan.complete && !scan.locked)
      config._cachedSkills = normalizeCachedSkills(scan.skills);
    const reconciledIssues = reconcileDeletedSkills(config, scan);
    if (!config._syncLocked) await writeConfig(config);
    const orphanIssues = config._syncLocked
      ? []
      : await cleanupOrphanAgents(config);
    const syncResults = await syncAllAgents(config, scan);
    const persistenceIssues = await persistSyncResults(config, syncResults);
    // 扫描不完整时回退到最近一次成功扫描的结果，避免出现
    //「提示说配置已保留、界面却清空」的矛盾状态。
    const visibleSkills = scan.complete
      ? scan.skills
      : config._cachedSkills || [];
    const fallbackIssues =
      !scan.complete && visibleSkills.length
        ? [
            createIssue(
              "info",
              "本次未完成扫描，Skills 列表显示的是上次成功扫描的结果。",
            ),
          ]
        : [];
    const scanState = { ...scan, skills: visibleSkills };
    // 只有真实仓库扫描才能给出 emptyRepository 结论：
    // 被拦下的空仓库明确为 true；成功完成的扫描明确为 false；其余情况不输出该字段。
    if (scan.emptyRepository === true) scanState.emptyRepository = true;
    else if (scan.complete === true) scanState.emptyRepository = false;
    const state = buildState(
      config,
      scanState,
      collectIssues(scan, syncResults, [
        ...(config._issues || []),
        ...reconciledIssues,
        ...orphanIssues,
        ...persistenceIssues,
        ...fallbackIssues,
      ]),
    );
    state.agentIssues = Object.fromEntries(
      config.agents.map((agent) => [
        agent.id,
        uniqueIssues(syncResults[agent.id]?.issues || []),
      ]),
    );
    return state;
  }

  /**
   * 定向同步的公共编排：写检查点 →（可选）清理孤儿 → 定向校验缓存 → 同步该 Agent → 持久化。
   *
   * @param {object} config - 当前配置
   * @param {object} agent - 目标 Agent
   * @param {{cleanupOrphans?: boolean, previousSkillIds?: string[]}} [options]
   * @returns {object} 含 agentIssues 的前端状态
   */
  async function runTargetedSync(config, agent, options = {}) {
    const { cleanupOrphans = false, previousSkillIds = [] } = options;
    await writeConfig(config);
    const orphanIssues = cleanupOrphans
      ? await cleanupOrphanAgents(config)
      : [];
    const targetedScan = await inspectEnabledCachedSkills(
      config,
      agent,
      previousSkillIds,
    );
    const syncResults = {
      [agent.id]: await syncAgent(config, agent, targetedScan),
    };
    const persistenceIssues = await persistSyncResults(config, syncResults);
    const state = buildState(
      config,
      { skills: config._cachedSkills || [] },
      collectIssues(targetedScan, syncResults, [
        ...(config._issues || []),
        ...orphanIssues,
        ...persistenceIssues,
      ]),
    );
    state.agentIssues = {
      [agent.id]: collectAgentIssues(agent.id, targetedScan, syncResults),
    };
    return state;
  }

  /**
   * 只同步一次应用配置开关涉及的 Agent。
   * 使用最近一次完整扫描缓存并逐项验证源目录，避免每次点击都递归遍历整个仓库。
   */
  async function syncAgentSkillsState(config, agent, previousSkillIds) {
    return runTargetedSync(config, agent, { previousSkillIds });
  }

  /** 返回最近一次扫描缓存，不触发仓库或 Agent 目录访问。 */
  function getCachedState(config, issues = config._issues || []) {
    return buildState(
      config,
      { skills: config._cachedSkills || [] },
      uniqueIssues(issues),
    );
  }

  /**
   * Agent 更换目录时只清理旧目录并同步当前 Agent。
   * 旧目录会先作为孤儿记录等待清理，因此必须开启 cleanupOrphans。
   */
  async function syncMovedAgentState(config, agent) {
    return runTargetedSync(config, agent, { cleanupOrphans: true });
  }

  /**
   * 首次为已存在的 Agent 绑定目录：旧目录为空，无需清理孤儿，只需把当前已启用 Skill 同步进新目录。
   * 与 syncMovedAgentState 区分开，避免“首次绑定”被当成迁移处理。
   *
   * @param {object} config - 当前配置（Agent 的 directory 已更新为新目录）
   * @param {object} agent - 目标 Agent
   * @returns {object} 含 agentIssues 的前端状态
   */
  async function bindAgentDirectoryState(config, agent) {
    return runTargetedSync(config, agent, { cleanupOrphans: false });
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
      _revision: config._revision || "",
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
    return buildState(
      createDefaultConfig(),
      { skills: [], emptyRepository: false },
      uniqueIssues(issues),
    );
  }

  /**
   * 配置无法解析时的恢复出口（对应“双损坏后仍能清除数据”）。
   *
   * 不依赖成功读取配置：直接清除本地存储并返回默认状态。
   * 由于读不到受管链接记录，只清配置、不尝试删除任何 Agent 目录中的内容。
   *
   * @returns {object} 默认状态，并附带说明问题
   */
  async function clearUnreadableDataState() {
    await clearStoredConfig();
    return buildState(
      createDefaultConfig(),
      { skills: [], emptyRepository: false },
      [
        createIssue(
          "warning",
          "本地配置无法解析，已直接清除本地配置并恢复默认状态。因无法读取受管链接记录，未删除任何 Agent 目录中的内容；如需清理链接，请重新配置目录后再处理。",
        ),
      ],
    );
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
      await normalizeDirectory(
        agent.directory,
        `Agent“${agent.name}”的 Skills 目录`,
      );
    } catch (error) {
      return [
        createIssue(
          "error",
          `${error.message}。全部受管记录已保留，目录恢复后可再次清理。`,
        ),
      ];
    }
    // 与 link-manager 一致：skillId 可能是 __proto__ 等特殊键名，必须用无原型对象承载。
    const remaining = Object.create(null);
    for (const [skillId, link] of Object.entries(
      normalizeManagedLinks(agent.managedLinks),
    )) {
      const removal = await removeOwnedLink(
        link,
        `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
        agent.directory,
      );
      issues.push(...removal.issues);
      // 未放弃管理时保留记录；若链接已被隔离，则记录隔离路径以便继续追踪。
      if (!removal.relinquished)
        remaining[skillId] = removal.remainingLink || link;
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

  return {
    bindAgentDirectoryState,
    clearDataState,
    clearUnreadableDataState,
    deleteAgentState,
    getCachedState,
    refreshState,
    syncAgentSkillsState,
    syncMovedAgentState,
  };
}

module.exports = { createStateService };
